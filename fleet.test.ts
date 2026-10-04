// フリート(複数エンジンの管理)のロジック試験。エンジン不要(偽エンジン mockEngineProc.ts を別プロセスで起動する)。
//   [1] 設定(環境変数)  [2] レジストリ(排他・古いロック・原子的置換・別プロセスの同時アクセス)
//   [3] リソースガード  [4] 起動(インスタンス分離・ポート割当・上限 3 台・visible 拒否・同一プロジェクト)
//   [5] 束縛(router)・attach 読み取り専用  [6] 停止・孤児回収・kill の安全  [7] --owner-pid / --idle-exit(エンジン側の契約)
//   [8] アイドル自動終了(MCP サーバ側。時間短縮)  [9] refresh / 古い exe コピー  [10] 終了処理  [11] doctor の診断
// 実行: node fleet.test.ts
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadFleetConfig, parsePortRange, DEFAULT_MAX, DEFAULT_IDLE_MIN, DEFAULT_MIN_FREE_VRAM_MB, DEFAULT_MIN_FREE_RAM_MB } from "./fleet/config.ts";
import { Registry, FleetLockTimeout, sleepSync, type Entry } from "./fleet/registry.ts";
import { pidAlive, isProcessOf, killTreeSync, imageOf } from "./fleet/proc.ts";
import { parseNvidiaSmi, checkResources, sampleResources } from "./fleet/resources.ts";
import { EngineRouter } from "./fleet/router.ts";
import { Fleet, FleetFailure, rawPing, portIsFree } from "./fleet/fleet.ts";
import { fleetIssues } from "./doctor.ts";
import { envelope } from "./errors.ts";
import { startMockEngine } from "./mockEngine.ts";
import {
  MOCK_ENGINE_SCRIPT, tmpDir, makeFakeBuild, fleetConfigFor, spawnSleeper, waitFor, waitDead, track, killTracked, rmTree,
} from "./fleetTestKit.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}
const dirs: string[] = [];
const fleets: Fleet[] = [];
function mkTmp(label: string) { const d = tmpDir(label); dirs.push(d); return d; }
function newFleet(extraEnv: Record<string, string> = {}, buildDir?: string) {
  const fd = mkTmp("f"); const bd = buildDir ?? makeFakeBuild(mkTmp("b"));
  const cfg = fleetConfigFor(fd, bd, extraEnv);
  const router = new EngineRouter();
  const fleet = new Fleet({ cfg, router }); fleets.push(fleet);
  return { fleet, router, cfg, fd, bd };
}
async function failure(fn: () => Promise<unknown>): Promise<FleetFailure | null> {
  try { await fn(); return null; } catch (e) { return e instanceof FleetFailure ? e : (() => { throw e; })(); }
}
const blankEntry = (id: string, port: number, over: Partial<Entry> = {}): Entry => ({
  id, name: id, state: "ready", owner: { pid: process.pid, startMs: 0, heartbeatAt: Date.now() }, pid: 0, imageName: "node.exe", port, mode: "background",
  project: { dir: "", disposable: true }, exe: { path: "", sourcePath: "", sourceMtimeMs: 0, sizeBytes: 0, copiedAt: 0 }, startedAt: Date.now(), lastActivityAt: Date.now(), idleExitMin: 0, args: [], ...over,
});

// ────────────────────────────────────────────────────────────────────────────
console.log("[1] 設定(環境変数)");
{
  const d = loadFleetConfig({} as NodeJS.ProcessEnv);
  check("既定: 上限 3 台・アイドル 10 分・空き VRAM 2048 MB・空き RAM 3072 MB・ポート 8860〜8899", d.max === DEFAULT_MAX && DEFAULT_MAX === 3 && d.idleMin === DEFAULT_IDLE_MIN && d.idleMin === 10 && d.minFreeVramMB === DEFAULT_MIN_FREE_VRAM_MB && d.minFreeVramMB === 2048 && d.minFreeRamMB === 3072 && d.portRange[0] === 8860 && d.portRange[1] === 8899, d);
  check("既定: visible 不許可・自動起動なし・無効化なし", !d.allowVisible && !d.autolaunch && !d.disabled);
  const o = loadFleetConfig({ DX12_FLEET_MAX: "2", DX12_FLEET_IDLE_MIN: "0.5", DX12_FLEET_MIN_FREE_VRAM_MB: "100", DX12_FLEET_MIN_FREE_RAM_MB: "200", DX12_FLEET_PORT_RANGE: "9000-9010", DX12_MCP_ALLOW_VISIBLE: "1", DX12_FLEET_AUTOLAUNCH: "true", DX12_FLEET_DISABLE: "0" } as any);
  check("環境変数で上書き(小数の分・ポート範囲・visible 許可・自動起動)", o.max === 2 && o.idleMin === 0.5 && o.minFreeVramMB === 100 && o.minFreeRamMB === 200 && o.portRange[0] === 9000 && o.portRange[1] === 9010 && o.allowVisible && o.autolaunch && !o.disabled, o);
  check("不正なポート範囲(手動用の 8850 台・逆順・文字)は既定へ戻る", parsePortRange("80-90")[0] === 8860 && parsePortRange("9000-8000")[0] === 8860 && parsePortRange("abc")[1] === 8899);
  check("不正な数値は既定へ戻る", loadFleetConfig({ DX12_FLEET_MAX: "abc", DX12_FLEET_MIN_FREE_RAM_MB: "-5" } as any).max === 3);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[2] レジストリ(排他・古いロック・原子的置換・別プロセスの同時アクセス)");
{
  const dir = mkTmp("reg");
  const reg = new Registry(dir);
  reg.transaction((d) => { d.engines.a = blankEntry("a", 8860); });
  check("transaction で書いた内容が read で読める(原子的な置換)", reg.read().engines.a?.port === 8860 && !fs.existsSync(path.join(dir, "registry.lock")));
  check("一時ファイルが残らない", fs.readdirSync(dir).every((f) => !f.endsWith(".tmp")), fs.readdirSync(dir));
  const before = fs.statSync(path.join(dir, "registry.json")).mtimeMs;
  sleepSync(20);
  reg.transaction(() => undefined);
  check("変更が無ければ書き直さない", fs.statSync(path.join(dir, "registry.json")).mtimeMs === before);
  // 例外が出てもロックが残らない
  try { reg.transaction(() => { throw new Error("boom"); }); } catch { /* 期待どおり */ }
  check("fn が例外でもロックを解放する", !fs.existsSync(path.join(dir, "registry.lock")));
  // 壊れた JSON は空として扱い、次の書き込みで直る
  fs.writeFileSync(path.join(dir, "registry.json"), "{ 壊れた");
  const t0 = Date.now();
  const empty = reg.read();
  check("壊れた registry.json は空として読める(落ちない)", Object.keys(empty.engines).length === 0 && Date.now() - t0 < 2000);
  reg.transaction((d) => { d.engines.b = blankEntry("b", 8861); });
  check("壊れた後の transaction で復旧する", reg.read().engines.b?.port === 8861);

  // 保持者が死んでいる古いロックは回収される
  const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => dead.on("exit", r));
  fs.writeFileSync(path.join(dir, "registry.lock"), JSON.stringify({ pid: dead.pid, startMs: 1, token: "dead" }));
  const t1 = Date.now();
  reg.transaction((d) => { d.engines.c = blankEntry("c", 8862); });
  check("保持者(pid)が死んでいるロックを回収して進む(待たない)", reg.read().engines.c?.port === 8862 && Date.now() - t1 < 1500, Date.now() - t1);
  // 保持者が生きていても mtime が古すぎるロックは回収される
  const sl = spawnSleeper(); track(sl.pid);
  const reg2 = new Registry(dir, { staleLockMs: 300, lockTimeoutMs: 5000 });
  fs.writeFileSync(path.join(dir, "registry.lock"), JSON.stringify({ pid: sl.pid, startMs: 1, token: "old" }));
  const old = new Date(Date.now() - 60_000); fs.utimesSync(path.join(dir, "registry.lock"), old, old);
  reg2.transaction((d) => { d.engines.d = blankEntry("d", 8863); });
  check("生きた保持者でも mtime が staleLockMs より古いロックは回収する", reg2.read().engines.d?.port === 8863);
  // 生きた保持者の新しいロックは尊重し、時間内に取れなければ FleetLockTimeout
  const reg3 = new Registry(dir, { staleLockMs: 60_000, lockTimeoutMs: 400 });
  fs.writeFileSync(path.join(dir, "registry.lock"), JSON.stringify({ pid: sl.pid, startMs: 1, token: "live" }));
  let timedOut = false; const t2 = Date.now();
  try { reg3.transaction(() => undefined); } catch (e) { timedOut = e instanceof FleetLockTimeout; }
  check("生きた保持者の新しいロックは壊さず、lockTimeoutMs 後に FleetLockTimeout", timedOut && Date.now() - t2 >= 350, Date.now() - t2);
  check("尊重したロックは消していない", JSON.parse(fs.readFileSync(path.join(dir, "registry.lock"), "utf8")).token === "live");
  fs.rmSync(path.join(dir, "registry.lock"), { force: true });
  killTreeSync(sl.pid!);

  // 別プロセス 4 つが同時に読み書きしても壊れない
  const cdir = mkTmp("regconc");
  const worker = path.join(path.dirname(MOCK_ENGINE_SCRIPT), "fleetRegistryWorker.ts");
  const N = 4, INC = 60, HOLD = 8;
  const outs: string[] = [];
  const t3 = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, [worker, cdir, `w${i}`, String(INC), String(HOLD), "8900"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let out = ""; c.stdout!.on("data", (d) => { out += d; });
    c.on("exit", (code) => { outs.push(out); code === 0 ? resolve() : reject(new Error(`worker ${i} exit ${code}`)); });
  })));
  const final = new Registry(cdir).read();
  const counter = final.engines["__counter"]?.port;
  const ports = Object.values(final.engines).filter((e) => e.id !== "__counter").map((e) => e.port);
  const reported = outs.flatMap((o) => JSON.parse(o.trim()).ports as number[]);
  check(`4 プロセス × ${INC} 回の +1 が 1 つも失われない(${counter}/${N * INC})`, counter === N * INC, counter);
  check(`4 プロセスが予約したポート ${N * HOLD} 個が全部別々(重複なし)`, new Set(ports).size === N * HOLD && ports.length === N * HOLD && new Set(reported).size === N * HOLD, { unique: new Set(ports).size, n: ports.length });
  check("ポートは 8900 から隙間なく割り当たる", Math.min(...ports) === 8900 && Math.max(...ports) === 8900 + N * HOLD - 1);
  check("並行実行の後にロック・一時ファイルが残らない", !fs.existsSync(path.join(cdir, "registry.lock")) && fs.readdirSync(cdir).every((f) => !f.endsWith(".tmp") && !f.includes(".stale.")), fs.readdirSync(cdir));
  console.log(`      4 プロセス並行: ${Date.now() - t3} ms`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[3] リソースガード(VRAM / RAM)");
{
  const g = parseNvidiaSmi("NVIDIA GeForce RTX 5060, 2126, 8151\r\nNVIDIA Foo, Bar, 1000, 4000\n\n");
  check("nvidia-smi の csv を読む(名前にカンマが入っても末尾 2 列を使う)", g.length === 2 && g[0].usedMB === 2126 && g[0].totalMB === 8151 && g[1].name === "NVIDIA Foo, Bar", g);
  const cfg = fleetConfigFor(mkTmp("r"), mkTmp("b"));
  const ok = checkResources({ vramFreeMB: 6000, vramUsedMB: 2000, vramTotalMB: 8000, vramSource: "fake", ramFreeMB: 16000, ramTotalMB: 32000 }, cfg);
  check("十分な空きは違反なし", ok.length === 0);
  const lowV = checkResources({ vramFreeMB: 2047, vramUsedMB: 0, vramTotalMB: 0, vramSource: "fake", ramFreeMB: 16000, ramTotalMB: 32000 }, cfg);
  check("空き VRAM 2047 MB(< 2048)は違反", lowV.length === 1 && lowV[0].kind === "vram" && lowV[0].minMB === 2048);
  check("空き VRAM ちょうど 2048 MB は通す(閾値は未満)", checkResources({ vramFreeMB: 2048, vramUsedMB: 0, vramTotalMB: 0, vramSource: "fake", ramFreeMB: 16000, ramTotalMB: 32000 }, cfg).length === 0);
  const lowR = checkResources({ vramFreeMB: 6000, vramUsedMB: 0, vramTotalMB: 0, vramSource: "fake", ramFreeMB: 3071, ramTotalMB: 32000 }, cfg);
  check("空き RAM 3071 MB(< 3072)は違反", lowR.length === 1 && lowR[0].kind === "ram");
  check("VRAM が観測できない(null)ときは VRAM を違反にしない", checkResources({ vramFreeMB: null, vramUsedMB: null, vramTotalMB: null, vramSource: "unknown", ramFreeMB: 16000, ramTotalMB: 32000 }, cfg).length === 0);
  const fake = sampleResources({ fakeResources: { vramFreeMB: 123, vramTotalMB: 1000, ramFreeMB: 456 } });
  check("観測値の差し替え(fake)が効く", fake.vramFreeMB === 123 && fake.ramFreeMB === 456 && fake.vramSource === "fake");
  const real = sampleResources({ fakeResources: null });
  check("実機の観測: RAM は必ず取れ、VRAM は取れるか「不明」", real.ramFreeMB > 0 && ["nvidia-smi", "powershell", "unknown"].includes(real.vramSource), real);
  console.log(`      この PC: VRAM 空き ${real.vramFreeMB ?? "?"}/${real.vramTotalMB ?? "?"} MB(${real.vramSource})、RAM 空き ${real.ramFreeMB} MB`);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[4] 起動(インスタンス分離・ポート割当・上限・visible・同一プロジェクト)");
{
  const { fleet, router, cfg, bd } = newFleet();
  const r: any = await fleet.launch({});
  const bin = r.dir.bin as string;
  check("launch が engineId / port / pid / dir を返し、そのエンジンが束縛される", /^e-[0-9a-f]{4}$/.test(r.engineId) && r.port >= 8860 && r.port <= 8899 && pidAlive(r.pid) && router.boundId() === r.engineId && r.bound === true, r);
  check("ポートは 8860〜8899 の範囲(手動用の 8850〜8859・8787 に触れない)", r.port >= 8860 && r.port <= 8899);
  const exe = path.join(bin, "DX12Engine.exe");
  const srcExe = path.join(bd, "DX12Engine.exe");
  check("exe は実コピー(元とは別ファイル。ハードリンクではない = LNK1104 を避ける)", fs.existsSync(exe) && fs.statSync(exe).nlink === 1 && fs.statSync(exe).ino !== fs.statSync(srcExe).ino, { nlink: fs.statSync(exe).nlink });
  check("通常の dll は実コピー、dxil.dll(再ビルドされない大きい DLL)と GameRuntime.exe(dx12_build_game の材料。実行されない)だけハードリンク", fs.statSync(path.join(bin, "fake.dll")).nlink === 1 && fs.statSync(path.join(bin, "dxil.dll")).nlink >= 2 && fs.statSync(path.join(bin, "GameRuntime.exe")).nlink >= 2 && r.exe.linked.includes("dxil.dll") && r.exe.linked.includes("GameRuntime.exe"), r.exe.linked);
  check("shaders / assets も実コピー・pdb は持ってこない", fs.existsSync(path.join(bin, "shaders", "a.cso")) && fs.statSync(path.join(bin, "shaders", "a.cso")).nlink === 1 && fs.existsSync(path.join(bin, "assets", "editor", "x.txt")) && !fs.existsSync(path.join(bin, "DX12Engine.pdb")));
  const marker = JSON.parse(fs.readFileSync(path.join(r.dir.data, "mock_marker.json"), "utf8"));
  check("DX12E_DATA_DIR がインスタンスの data フォルダ(ユーザーの %APPDATA% ではない)", path.resolve(marker.dataDir) === path.resolve(r.dir.data) && !marker.dataDir.toLowerCase().includes("appdata\\roaming"), marker.dataDir);
  check("作業ディレクトリ(cwd)は exe コピーのフォルダ(ログ・imgui.ini がそこに出る)", path.resolve(marker.cwd) === path.resolve(bin), marker.cwd);
  const argv: string[] = marker.argv;
  check("起動引数は --background(既定)・--project・--mcp-port・--owner-pid・--idle-exit・--instance-id", argv.includes("--background") && !argv.includes("--headless") && argv[argv.indexOf("--mcp-port") + 1] === String(r.port) && argv[argv.indexOf("--owner-pid") + 1] === String(process.pid) && Number(argv[argv.indexOf("--idle-exit") + 1]) > 10 && argv[argv.indexOf("--instance-id") + 1] === r.engineId && argv[argv.indexOf("--project") + 1] === r.dir.project, argv);
  check("visible を意味する引数(--background の欠落・--net-client 等)は無い", !argv.some((a) => a.startsWith("--net-client")));
  const pong: any = await router.call("ping", {});
  check("ping に pid / instanceId / ownerPid / idleExitMin / vram が載る(束縛したエンジンへ届いている)", pong.pid === r.pid && pong.instanceId === r.engineId && pong.ownerPid === process.pid && pong.idleExitMin > 10 && pong.vramBudgetMB > 0 && pong.cwd === bin, pong);
  check("使い捨てプロジェクトが生成される(.dx12proj + main.json)", r.project.disposable && fs.readdirSync(r.dir.project).some((f) => f.endsWith(".dx12proj")) && fs.existsSync(path.join(r.dir.project, "assets", "scenes", "main.json")));
  let prio: number | null = null; try { prio = os.getPriority(r.pid); } catch { /* 無視 */ }
  check("CPU 優先度は BelowNormal(ユーザーのビルド・ゲームを圧迫しない)", prio === os.constants.priority.PRIORITY_BELOW_NORMAL, prio);
  check("レジストリに owner(pid)つきで載る", (() => { const e = fleet.registry.read().engines[r.engineId]; return e && e.owner.pid === process.pid && e.state === "ready" && e.port === r.port && e.imageName.toLowerCase() === "node.exe"; })());

  // 同じプロジェクトを 2 台で開かせない(自動保存の衝突)
  const proj = mkTmp("proj"); fs.mkdirSync(path.join(proj, "assets"), { recursive: true });
  const rp: any = await fleet.launch({ project: proj });
  const clash = await failure(() => fleet.launch({ project: proj }));
  check("同じプロジェクトを別のエンジンが使用中 → E_FLEET_PROJECT_IN_USE(fix に既存エンジンの利用)", clash?.body.code === "E_FLEET_PROJECT_IN_USE" && clash.body.fix?.some((f) => f.tool === "dx12_engine_use" && (f.args as any)?.engine === rp.engineId), clash?.body);
  check("指定したプロジェクトは使い捨てではない(警告つき)", rp.project.disposable === false && /自動保存/.test(rp.project.note));
  const badProj = await failure(() => fleet.launch({ project: path.join(proj, "no-such") }));
  check("存在しないプロジェクト → E_INVALID_PARAM(fix に省略を案内)", badProj?.body.code === "E_INVALID_PARAM" && !!badProj.body.fix?.length, badProj?.body);

  // ポート・データ領域・exe コピーが別
  const r3: any = await fleet.launch({});
  check("3 台目まで起動できる(別ポート・別 exe コピー・別データ領域・別 cwd)", new Set([r.port, rp.port, r3.port]).size === 3 && new Set([r.dir.bin, rp.dir.bin, r3.dir.bin]).size === 3 && new Set([r.dir.data, rp.dir.data, r3.dir.data]).size === 3);
  const p2: any = await rawPing(rp.port), p3: any = await rawPing(r3.port);
  check("3 台がそれぞれ自分の instanceId・pid で応答する(独立)", p2?.instanceId === rp.engineId && p3?.instanceId === r3.engineId && new Set([r.pid, rp.pid, r3.pid]).size === 3);

  // 4 台目は理由つきで断る
  const t4 = Date.now();
  const f4 = await failure(() => fleet.launch({}));
  const b4 = f4?.body;
  check("4 台目は E_FLEET_LIMIT で断る(cause に上限・数値)", b4?.code === "E_FLEET_LIMIT" && /最大 3 台/.test(b4.message) && /DX12_FLEET_MAX=3/.test(b4.cause ?? ""), b4);
  check("止める候補: 自分のエンジンを idle が長い順に dx12_engine_stop の fix と didYouMean で返す", (b4?.fix?.filter((f) => f.tool === "dx12_engine_stop").length ?? 0) === 3 && b4?.didYouMean?.length === 3 && b4.didYouMean.every((id) => [r.engineId, rp.engineId, r3.engineId].includes(id)), b4?.fix);
  check("エラーが envelope に載って error_code / retryable / fix を持つ", (() => { const env: any = envelope(b4!); return env.ok === false && env.error_code === "E_FLEET_LIMIT" && env.retryable === true && env.fix.length >= 3; })());
  check("断った後にレジストリへ余計な予約が残らない・プロセスも増えない", Object.keys(fleet.registry.read().engines).length === 3, Object.keys(fleet.registry.read().engines));
  console.log(`      4 台目を断るまで ${Date.now() - t4} ms`);
  const listed: any = await fleet.list();
  check("list: 3 台・上限 3・自分のもの・束縛中の印", listed.fleet.count === 3 && listed.fleet.max === 3 && listed.engines.every((e: any) => e.ownedByMe) && listed.engines.filter((e: any) => e.bound).length === 1, listed.fleet);
  await fleet.stop({ all: true });
  check("stop {all} で 3 台とも止まる・プロセス・エントリ・インスタンスフォルダが残らない", !pidAlive(r.pid) && !pidAlive(rp.pid) && !pidAlive(r3.pid) && Object.keys(fleet.registry.read().engines).length === 0 && !fs.existsSync(r.dir.instance) && !fs.existsSync(rp.dir.instance), fs.readdirSync(path.join(cfg.dir, "instances")));
  check("使い捨てプロジェクトは停止後も残る(24 時間)", fs.existsSync(r.dir.project));
  check("束縛が外れる", router.boundId() === null);
}
{
  // ポートの割当: OS が使っているポートは飛ばす・停止で解放されたポートを再利用する
  const { fleet } = newFleet({ DX12_FLEET_PORT_RANGE: "8890-8894" });
  const blocker = await new Promise<net.Server>((res) => { const s = net.createServer(); s.listen(8890, "127.0.0.1", () => res(s)); });
  const a: any = await fleet.launch({});
  check("OS が別プロセスで使っているポート(8890)は飛ばして次(8891)を割り当てる", a.port === 8891, a.port);
  blocker.close();
  const b: any = await fleet.launch({});
  check("レジストリに載っている 8891 は避け、空いた最小(8890)を割り当てる", b.port === 8890, b.port);
  await fleet.stop({ all: true });
  const c: any = await fleet.launch({});
  check("停止後はポートが解放され、また最小から使う", c.port === 8890, c.port);
  await fleet.stop({ all: true });
  const { fleet: f2 } = newFleet({ DX12_FLEET_PORT_RANGE: "8890-8890", DX12_FLEET_MAX: "3" });
  await f2.launch({});
  const noPort = await failure(() => f2.launch({}));
  check("ポート範囲が尽きたら E_FLEET_LIMIT(範囲を広げる案内)", noPort?.body.code === "E_FLEET_LIMIT" && /ポート範囲/.test(noPort.body.message), noPort?.body);
  await f2.stop({ all: true });
}
{
  // 上限は「全セッション合計」: 他のセッションが 2 台持っていれば自分は 1 台しか起動できない
  const { fleet } = newFleet();
  const other = spawnSleeper(); track(other.pid);
  const otherEng = spawnSleeper(); track(otherEng.pid);
  const otherEng2 = spawnSleeper(); track(otherEng2.pid);
  fleet.registry.transaction((d) => {
    for (const [i, p] of [[1, otherEng.pid!], [2, otherEng2.pid!]] as const) {
      d.engines[`x-o${i}`] = blankEntry(`x-o${i}`, 8870 + i, { pid: p, imageName: "node.exe", owner: { pid: other.pid!, startMs: 1, heartbeatAt: Date.now() }, project: { dir: `C:/other/p${i}`, disposable: false }, startedAt: Date.now() - 3600_000, lastActivityAt: Date.now() - 1200_000 });
    }
  });
  const mine: any = await fleet.launch({});
  const f3 = await failure(() => fleet.launch({}));
  check("上限は全セッション合計(他人が 2 台 + 自分 1 台 = 3 台で次は断る)", mine.engineId && f3?.body.code === "E_FLEET_LIMIT", f3?.body);
  const det: any = f3?.body.details;
  check("他人のエンジンは止める候補にせず、details.others に owner・project・idleSec と『ユーザーに確認』を載せる", det.others.length === 2 && det.others.every((o: any) => o.ownerPid === other.pid && o.idleSec > 1000) && /ユーザーに確認/.test(det.note) && !f3!.body.fix!.some((f) => f.tool === "dx12_engine_stop" && String((f.args as any).engine).startsWith("x-o")), det);
  check("他人のエンジンは engine_stop で止められない(E_FLEET_NOT_OWNER。force と confirm の両方が要る)", (await failure(() => fleet.stop({ engine: "x-o1" })))?.body.code === "E_FLEET_NOT_OWNER" && (await failure(() => fleet.stop({ engine: "x-o1", force: true })))?.body.code === "E_FLEET_NOT_OWNER" && pidAlive(otherEng.pid!));
  const forced: any = await fleet.stop({ engine: "x-o1", force: true, confirm: true });
  check("force + confirm なら他人のエンジンも止められる(最後の手段)", forced.stopped[0].engineId === "x-o1" && !pidAlive(otherEng.pid!));
  await fleet.stop({ all: true });
  killTreeSync(other.pid!); killTreeSync(otherEng2.pid!);
}
{
  // リソースが足りなければ断る(理由と対処)
  const { fleet } = newFleet({ DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ vramFreeMB: 1500, vramTotalMB: 8000, ramFreeMB: 16000 }) });
  const keep: any = await fleet.launch({}).catch((e: any) => e);
  check("空き VRAM 1500 MB(< 2048)なら E_FLEET_RESOURCE で断る", keep instanceof FleetFailure && keep.body.code === "E_FLEET_RESOURCE" && /VRAM/.test(keep.body.message) && /1500/.test(keep.body.message), keep?.body);
  check("cause に下限と変更方法の環境変数・fix に対処が入る", /DX12_FLEET_MIN_FREE_VRAM_MB/.test(keep.body.cause) && keep.body.fix.length >= 1 && keep.body.retryable === true && keep.body.details.thresholds.minFreeVramMB === 2048, keep.body);
  check("断ったら何も起動・予約されない", Object.keys(fleet.registry.read().engines).length === 0);
  const { fleet: f2 } = newFleet({ DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ vramFreeMB: 6000, vramTotalMB: 8000, ramFreeMB: 2500 }) });
  const e2: any = await f2.launch({}).catch((e: any) => e);
  check("空き RAM 2500 MB(< 3072)なら E_FLEET_RESOURCE(RAM)", e2.body?.code === "E_FLEET_RESOURCE" && /RAM/.test(e2.body.message), e2.body);
  const { fleet: f3 } = newFleet({ DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ vramFreeMB: 1500, vramTotalMB: 8000, ramFreeMB: 16000 }), DX12_FLEET_MIN_FREE_VRAM_MB: "1000" });
  const ok3: any = await f3.launch({}).catch((e: any) => e);
  check("環境変数 DX12_FLEET_MIN_FREE_VRAM_MB で閾値を下げれば通る", ok3.engineId && !ok3.body, ok3.body);
  await f3.stop({ all: true });
  const { fleet: f4 } = newFleet({ DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ ramFreeMB: 16000 }) });
  const ok4: any = await f4.launch({});
  check("VRAM を観測できないとき(fake が vram 無し)は通し、警告を返す", ok4.engineId && ok4.warnings?.some((w: string) => /VRAM/.test(w)), ok4.warnings);
  await f4.stop({ all: true });
}
{
  // visible は既定で拒否
  const { fleet } = newFleet();
  const d1 = await failure(() => fleet.launch({ mode: "visible" }));
  check("visible は既定で拒否(E_FLEET_VISIBLE_DENIED)・環境変数と confirm の両方が要ると書く", d1?.body.code === "E_FLEET_VISIBLE_DENIED" && /DX12_MCP_ALLOW_VISIBLE=1/.test(d1.body.cause ?? "") && /confirm:true/.test(d1.body.cause ?? "") && d1.body.retryable === false, d1?.body);
  check("fix の先頭は background での起動(窓は要らない)。環境変数の設定はユーザーの作業と明記", d1?.body.fix?.[0]?.tool === "dx12_engine_launch" && (d1.body.fix[0].args as any).mode === "background" && d1.body.fix.some((f) => /ユーザーが/.test(f.why ?? "")), d1?.body.fix);
  const d2 = await failure(() => fleet.launch({ mode: "visible", confirm: true }));
  check("環境変数が無ければ confirm:true を付けても拒否", d2?.body.code === "E_FLEET_VISIBLE_DENIED", d2?.body.code);
  check("拒否したら何も起動しない", Object.keys(fleet.registry.read().engines).length === 0);
  const { fleet: fa } = newFleet({ DX12_MCP_ALLOW_VISIBLE: "1" });
  const d3 = await failure(() => fa.launch({ mode: "visible" }));
  check("環境変数があっても confirm が無ければ拒否(fix は confirm:true での撃ち直し)", d3?.body.code === "E_FLEET_VISIBLE_DENIED" && d3.body.fix?.some((f) => (f.args as any)?.confirm === true), d3?.body);
  const v: any = await fa.launch({ mode: "visible", confirm: true });
  const vm = JSON.parse(fs.readFileSync(path.join(v.dir.data, "mock_marker.json"), "utf8"));
  check("環境変数 + confirm:true で通り、フォーカスを奪い得る警告を返す", v.mode === "visible" && v.warnings?.some((w: string) => /実マウス|フォーカス/.test(w)) && !vm.argv.includes("--background") && !vm.argv.includes("--headless"), v.warnings);
  await fa.stop({ all: true });
  const h: any = await fa.launch({ mode: "headless" });
  const hm = JSON.parse(fs.readFileSync(path.join(h.dir.data, "mock_marker.json"), "utf8"));
  check("headless は --headless --virtual-input(自動更新チェックを走らせない)で、--background は付かない", hm.argv.includes("--headless") && hm.argv.includes("--virtual-input") && !hm.argv.includes("--background"), hm.argv);
  await fa.stop({ all: true });
  // args の禁止
  const { fleet: fb } = newFleet();
  for (const bad of ["--mcp-port=1", "--owner-pid", "--background", "--headless", "--project", "--net-client", "--instance-id"]) {
    const e = await failure(() => fb.launch({ args: [bad] }));
    if (e?.body.code !== "E_INVALID_PARAM") { check(`args の管理対象フラグ ${bad} を拒否`, false, e?.body); }
  }
  check("args にフリートが管理する起動引数(--mcp-port / --owner-pid / --background / --headless / --project / --net-client など)は渡せない", true);
  const okArgs: any = await fb.launch({ args: ["--foo", "bar"], dpiScale: 1.5, scene: "scenes/x.json", name: "my-agent" });
  const am = JSON.parse(fs.readFileSync(path.join(okArgs.dir.data, "mock_marker.json"), "utf8"));
  check("dpiScale / scene / 追加 args / name が起動引数・エントリに反映される", am.argv.includes("--dpi-scale") && am.argv.includes("1.5") && am.argv.includes("--scene") && am.argv.includes("--foo") && okArgs.name === "my-agent", am.argv);
  check("dpiScale の範囲外は E_OUT_OF_RANGE", (await failure(() => fb.launch({ dpiScale: 9 })))?.body.code === "E_OUT_OF_RANGE");
  check("不正な mode は E_BAD_ENUM + didYouMean", (await failure(() => fb.launch({ mode: "backgroud" as any })))?.body.didYouMean?.[0] === "background");
  check("不正な name は E_INVALID_PARAM", (await failure(() => fb.launch({ name: "a b/c" })))?.body.code === "E_INVALID_PARAM");
  await fb.stop({ all: true });
}
{
  // 起動失敗(すぐ落ちる・応答しない)は理由つきでエラーになり、何も残らない
  const { fleet } = newFleet();
  process.env.MOCK_ENGINE_FAIL_START = "1";   // 子(偽エンジン)が継承する
  const f = await failure(() => fleet.launch({}));
  delete process.env.MOCK_ENGINE_FAIL_START;
  check("起動直後に落ちるエンジン → E_FLEET_LAUNCH_FAILED(終了コードと launch ログの末尾)", f?.body.code === "E_FLEET_LAUNCH_FAILED" && /code=3/.test(f.body.message) && (f.body.details as any).logTail.some((l: string) => /異常終了/.test(l)), f?.body);
  check("失敗したら予約・インスタンスフォルダが残らない", Object.keys(fleet.registry.read().engines).length === 0 && !fs.existsSync(path.join(fleet.cfg.dir, "instances", Object.keys(fleet.registry.read().engines)[0] ?? "none")) && fs.readdirSync(path.join(fleet.cfg.dir, "instances")).length === 0, fs.readdirSync(path.join(fleet.cfg.dir, "instances")));
  const { fleet: f2 } = newFleet();
  process.env.MOCK_ENGINE_NO_PING = "1";
  const t0 = Date.now();
  const g = await failure(() => f2.launch({ waitReadyMs: 1500 }));
  delete process.env.MOCK_ENGINE_NO_PING;
  check("ping に応答しないエンジン → waitReadyMs で E_FLEET_LAUNCH_FAILED・プロセスを kill する", g?.body.code === "E_FLEET_LAUNCH_FAILED" && Date.now() - t0 < 6000 && !pidAlive((g.body.details as any).pid), g?.body);
  const { fleet: fx } = newFleet({ DX12_FLEET_ENGINE_CMD: JSON.stringify([path.join(os.tmpdir(), "no-such-dir-xyz", "no-such.exe")]) });
  const fxr = await failure(() => fx.launch({}));
  check("プロセスを起動できない(exe が実行できない)→ E_FLEET_LAUNCH_FAILED(Smart App Control の可能性と撃ち直しを案内)・後始末される", fxr?.body.code === "E_FLEET_LAUNCH_FAILED" && /Smart App Control/.test(fxr.body.cause ?? "") && fxr.body.retryable === true && Object.keys(fx.registry.read().engines).length === 0 && fs.readdirSync(path.join(fx.cfg.dir, "instances")).length === 0, fxr?.body);
  const { fleet: f3 } = newFleet({}, mkTmp("empty"));
  const h = await failure(() => f3.launch({}));
  check("コピー元の exe が無い → E_FLEET_EXE_MISSING(ビルド手順)", h?.body.code === "E_FLEET_EXE_MISSING" && h.body.fix?.some((x) => /build\.ps1/.test(x.command ?? "")), h?.body);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[5] 束縛(router)と attach(読み取り専用)");
{
  const { fleet, router } = newFleet();
  const a: any = await fleet.launch({ name: "alpha" });
  const b: any = await fleet.launch({ name: "beta" });
  check("launch のたびに新しいエンジンへ束縛が移る", router.boundId() === b.engineId);
  check("束縛先へ call が届く(既定)", (await router.call("ping", {})).instanceId === b.engineId);
  const viaOverride = await router.withEngine(a.engineId, () => router.call("ping", {}));
  check("withEngine(dx12_call {engine} の実体)は 1 回だけ別のエンジンへ向ける(id)", viaOverride.instanceId === a.engineId && router.boundId() === b.engineId);
  check("name / port でも指定できる", (await router.withEngine("alpha", () => router.call("ping", {}))).instanceId === a.engineId && (await router.withEngine(String(a.port), () => router.call("ping", {}))).instanceId === a.engineId);
  const u: any = fleet.use({ engine: "alpha" });
  check("use {engine} で既定を切り替える(name)", u.bound === a.engineId && (await router.call("ping", {})).instanceId === a.engineId);
  const none: any = fleet.use({ engine: "none" });
  check("use none で束縛を外す(従来の探索に戻る)", none.bound === null && router.boundId() === null && router.current() === null);
  const nf = (() => { try { fleet.use({ engine: "alpah" }); return null; } catch (e) { return e as FleetFailure; } })();
  check("未知の engine は E_FLEET_NOT_FOUND + didYouMean(近い名前)", nf?.body.code === "E_FLEET_NOT_FOUND" && nf.body.didYouMean?.includes("alpha") === true, nf?.body);
  check("アクティビティ: ping 以外の呼び出しで lastCallAt が進み、ping では進まない", await (async () => {
    const s = router.get(a.engineId)!; const t = s.lastCallAt; await new Promise((r) => setTimeout(r, 30));
    await router.withEngine(a.engineId, () => router.call("ping", {})); const afterPing = s.lastCallAt;
    await router.withEngine(a.engineId, () => router.call("list_entities", {})); return afterPing === t && s.lastCallAt > t;
  })());
  await fleet.stop({ all: true });
}
{
  // attach: 読み取り専用・貸し出し接続(単一クライアントの枠を塞がない)
  const { fleet, router } = newFleet();
  const target = await startMockEngine({ singleClient: true });
  const at: any = await fleet.attach({ port: target.port });
  check("attach {port}: 既定は読み取り専用で束縛される", at.readOnly === true && at.engineId === `x-${target.port}` && router.boundId() === at.engineId && at.ping.instanceId === undefined && at.notes.some((n: string) => /読み取り専用/.test(n)), at);
  const list: any = await router.call("list_entities", {});
  check("読み取り method(list_entities / get_entity / ping)は通る", Array.isArray(list.entities) && (await router.call("get_entity", { name: "Player" })).name === "Player");
  let ro: any = null;
  try { await router.call("set_transform", { name: "Player" }); } catch (e) { ro = e; }
  check("書き込み method は送信前に E_FLEET_READONLY(fix に自分専用エンジンの起動)", ro?.errName === "E_FLEET_READONLY" && ro.errFix?.some((f: any) => f.tool === "dx12_engine_launch") && !target.received.some((r) => r.method === "set_transform"), ro?.message);
  for (const m of ["play", "open_scene", "create_entity", "screenshot", "eval_lua"]) {
    let e2: any = null; try { await router.call(m, {}); } catch (e) { e2 = e; }
    if (e2?.errName !== "E_FLEET_READONLY") check(`読み取り専用で ${m} を拒否`, false, e2?.message);
  }
  check("play / open_scene / create_entity / screenshot / eval_lua も拒否(エンジンへ届かない)", !target.received.some((r) => ["play", "open_scene", "create_entity", "screenshot", "eval_lua"].includes(r.method)));
  // 貸し出し: 最後の応答の 1.5 秒後に接続を閉じ、別のクライアントが繋げる
  await new Promise((r) => setTimeout(r, 2100));
  const other = await rawPing(target.port, 1500);
  check("attach の接続は 1.5 秒で閉じ、持ち主(別クライアント)が単一クライアントのエンジンに繋げる", !!other?.pong, other);
  check("閉じた後の次の呼び出しで自動的に繋ぎ直す(再起動の警告は出ない)", (await router.call("list_entities", {})).count === 5 && router.getConnectEpoch() >= 2);
  // readOnly:false は confirm が要る
  const wr = await failure(() => fleet.attach({ port: target.port, readOnly: false }));
  check("readOnly:false は confirm:true が要る(E_GUARDED)", wr?.body.code === "E_GUARDED" && wr.body.fix?.some((f) => f.tool === "dx12_engine_launch"), wr?.body);
  const w2: any = await fleet.attach({ port: target.port, readOnly: false, confirm: true });
  check("confirm:true なら書き込み権つきで繋げる", w2.readOnly === false && (await router.call("set_transform", { name: "Player" })).applied === true);
  await fleet.stop({ engine: `x-${target.port}` });
  check("engine_stop {x-<port>} は attach を外すだけ(相手は止めない)", router.get(`x-${target.port}`) === undefined && (await rawPing(target.port, 1000))?.pong === true);
  // 持ち主が接続を握っている間(単一クライアント)は E_ENGINE_BUSY
  const holder = net.connect(target.port, "127.0.0.1"); holder.on("error", () => undefined); await new Promise((r) => holder.once("connect", r));
  holder.write(JSON.stringify({ id: 1, method: "ping", params: {} }) + "\n"); await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  const busy = await failure(() => fleet.attach({ port: target.port }));
  check("持ち主が接続を握っている単一クライアントのエンジン → E_ENGINE_BUSY(2.5 秒で諦め、cause と fix)", busy?.body.code === "E_ENGINE_BUSY" && Date.now() - t0 < 5000 && !!busy.body.cause && !!busy.body.fix?.length, busy?.body);
  check("失敗した attach はスロットを残さない", router.get(`x-${target.port}`) === undefined);
  holder.destroy();
  const closed = await failure(() => fleet.attach({ port: 8899 }));
  check("何も居ないポート → E_ENGINE_UNREACHABLE(fix に discover と launch)", closed?.body.code === "E_ENGINE_UNREACHABLE" && closed.body.fix?.some((f) => f.tool === "dx12_engine_launch"), closed?.body);
  const badPort = await failure(() => fleet.attach({}));
  check("port も engine も無い → E_MISSING_PARAM", badPort?.body.code === "E_MISSING_PARAM");
  // 他のセッションのエンジンを engine 指定で読み取り専用 attach
  const sl = spawnSleeper(); track(sl.pid);
  const eng2 = await startMockEngine({ singleClient: true });
  fleet.registry.transaction((d) => { d.engines["e-oth1"] = blankEntry("e-oth1", eng2.port, { pid: sl.pid!, owner: { pid: sl.pid!, startMs: 1, heartbeatAt: Date.now() } }); });
  const ot: any = await fleet.attach({ engine: "e-oth1" });
  check("他のセッションのフリートエンジンを engine 指定で読み取り専用 attach(fleetEngine に owner)", ot.readOnly && ot.fleetEngine?.id === "e-oth1" && ot.fleetEngine.ownerPid === sl.pid, ot);
  const use2 = (() => { try { fleet.use({ engine: "e-oth1" }); return null; } catch (e) { return e as FleetFailure; } })();
  check("use では他人のエンジンを束縛できない(E_FLEET_NOT_OWNER。attach を案内)", use2?.body.code === "E_FLEET_NOT_OWNER" && use2.body.fix?.[0].tool === "dx12_engine_attach", use2?.body);
  await fleet.stop({ engine: `x-${eng2.port}` });
  await target.close(); await eng2.close(); killTreeSync(sl.pid!);
  fleet.registry.transaction((d) => { delete d.engines["e-oth1"]; });
}
{
  // discover: connect だけで手動起動の候補を探す(ping を送らない)
  const { fleet } = newFleet();
  const manual = await startMockEngine({ port: 8889, singleClient: true }).catch(() => null);
  if (manual) {
    const l: any = await fleet.list({ discover: true });
    check("list {discover} が手動起動の候補ポートを connect だけで見つける(ping は送らない)", l.external?.some((x: any) => x.port === 8889) === true && manual.received.length === 0, l.external);
    await manual.close();
  } else console.log("  --  8889 が使用中のため discover の試験を省略");
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[6] 停止・孤児回収・kill の安全");
{
  const { fleet, router } = newFleet();
  const a: any = await fleet.launch({});
  const proj = a.dir.project;
  const s: any = await fleet.stop({ engine: a.engineId });
  check("stop: プロセスを kill・エントリ削除・インスタンス削除・束縛解除・使い捨てプロジェクトは保持", s.stopped[0].killed && !pidAlive(a.pid) && !fs.existsSync(a.dir.instance) && router.boundId() === null && fs.existsSync(proj) && s.stopped[0].project.retained === true, s);
  const none: any = await fleet.stop({ all: true });
  check("止めるものが無くても正常(stopped:[])", none.stopped.length === 0);
  const nf = await failure(() => fleet.stop({ engine: "e-zzzz" }));
  check("未知の engine → E_FLEET_NOT_FOUND", nf?.body.code === "E_FLEET_NOT_FOUND");
  const a2: any = await fleet.launch({}); const b2: any = await fleet.launch({});
  const amb = await failure(() => fleet.stop({}));
  check("engine も all も無く自分のエンジンが複数 → E_MISSING_PARAM(候補を fix に)", amb?.body.code === "E_MISSING_PARAM" && (amb.body.fix?.length ?? 0) >= 2, amb?.body);
  check("複数あるときは束縛中のものも黙って止めない(どちらも生きている)", pidAlive(a2.pid) && pidAlive(b2.pid));
  await fleet.stop({ engine: b2.engineId });
  const only: any = await fleet.stop({});
  check("engine も all も無く自分のエンジンが 1 台だけならそれを止める", only.stopped[0]?.engineId === a2.engineId && !pidAlive(a2.pid) && !pidAlive(b2.pid));
}
{
  // 孤児: owner が死んだエンジンは、次のスイープで kill・削除される
  const { fleet } = newFleet();
  const owner = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await new Promise((r) => owner.on("exit", r));
  // owner なしで動く偽エンジン(--owner-pid 無し = 自殺しない)を直接起動して、レジストリへ「死んだ owner のもの」として登録する
  const orphanDir = mkTmp("orph"); const port = 8898;
  const child = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--instance-id", "e-orph"], { cwd: orphanDir, stdio: "ignore", windowsHide: true }); track(child.pid);
  await waitFor(async () => !!(await rawPing(port, 300)), 5000);
  fs.mkdirSync(path.join(fleet.cfg.dir, "instances", "e-orph", "bin"), { recursive: true });
  fleet.registry.transaction((d) => { d.engines["e-orph"] = blankEntry("e-orph", port, { pid: child.pid!, imageName: "node.exe", owner: { pid: owner.pid!, startMs: 1, heartbeatAt: Date.now() } }); });
  const before: any = await fleet.list();
  check("owner が死んでいるエンジンは list の前に孤児として掃除される(kill・エントリ削除)", !pidAlive(child.pid!) && before.engines.length === 0, before.engines);
  check("孤児のインスタンスフォルダも消える", !fs.existsSync(path.join(fleet.cfg.dir, "instances", "e-orph")));
  // ハートビートが止まった owner(pid だけ生きている = pid の使い回し)も孤児
  const sl = spawnSleeper(); track(sl.pid);
  const child2 = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--instance-id", "e-stale"], { cwd: orphanDir, stdio: "ignore", windowsHide: true }); track(child2.pid);
  await waitFor(async () => !!(await rawPing(port, 300)), 5000);
  fleet.registry.transaction((d) => { d.engines["e-stale"] = blankEntry("e-stale", port, { pid: child2.pid!, imageName: "node.exe", owner: { pid: sl.pid!, startMs: 1, heartbeatAt: Date.now() - 10 * 60_000 } }); });
  await fleet.sweep();
  check("ハートビートが 5 分以上止まった owner(pid 使い回しの疑い)のエンジンも回収する", !pidAlive(child2.pid!) && !fleet.registry.read().engines["e-stale"]);
  killTreeSync(sl.pid!);
  // 監視が長く止まっていた直後(スリープ明け)は、他のセッションの心拍が古くても孤児と判定しない
  {
    const sl3 = spawnSleeper(); track(sl3.pid);
    const ch = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--instance-id", "e-sleepy"], { cwd: orphanDir, stdio: "ignore", windowsHide: true }); track(ch.pid);
    await waitFor(async () => !!(await rawPing(port, 300)), 5000);
    fleet.registry.transaction((d) => { d.engines["e-sleepy"] = blankEntry("e-sleepy", port, { pid: ch.pid!, imageName: "node.exe", owner: { pid: sl3.pid!, startMs: 1, heartbeatAt: Date.now() - 10 * 60_000 } }); });
    (fleet as any).lastTickAt = Date.now() - 120_000;   // 監視が 2 分止まっていた
    await fleet.tick();
    await fleet.sweep();
    check("監視が長く止まっていた直後(スリープ明け)は、心拍が古い他セッションのエンジンを孤児と判定しない(猶予 60 秒)", pidAlive(ch.pid!) && !!fleet.registry.read().engines["e-sleepy"] && fleet.events.some((e) => e.kind === "resume"));
    (fleet as any).heartbeatGraceUntil = 0;
    await fleet.sweep();
    check("猶予が切れれば(心拍が更新されないままなら)回収される", !pidAlive(ch.pid!) && !fleet.registry.read().engines["e-sleepy"]);
    killTreeSync(sl3.pid!);
  }
  // 生きている owner のエンジンは触らない
  const sl2 = spawnSleeper(); track(sl2.pid);
  const child3 = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--instance-id", "e-live"], { cwd: orphanDir, stdio: "ignore", windowsHide: true }); track(child3.pid);
  await waitFor(async () => !!(await rawPing(port, 300)), 5000);
  fleet.registry.transaction((d) => { d.engines["e-live"] = blankEntry("e-live", port, { pid: child3.pid!, imageName: "node.exe", owner: { pid: sl2.pid!, startMs: 1, heartbeatAt: Date.now() } }); });
  await fleet.sweep();
  check("owner が生きているエンジンは掃除しない(他のセッションのものを巻き込まない)", pidAlive(child3.pid!) && !!fleet.registry.read().engines["e-live"]);
  const st = fleet.registry.read().engines["e-live"];
  killTreeSync(child3.pid!); await waitDead(child3.pid!);
  await fleet.sweep();
  check("エンジン自体が死んでいるエントリは(owner が生きていても)掃除される", !fleet.registry.read().engines["e-live"] && !!st);
  killTreeSync(sl2.pid!);
}
{
  // kill の安全: イメージ名が記録と違う(pid の使い回し)なら殺さない・殺すのはレジストリの pid だけ
  const { fleet } = newFleet();
  const owner = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await new Promise((r) => owner.on("exit", r));
  const innocent = spawnSleeper(); track(innocent.pid);
  const bystander = spawnSleeper(); track(bystander.pid);
  fleet.registry.transaction((d) => { d.engines["e-img"] = blankEntry("e-img", 8897, { pid: innocent.pid!, imageName: "DX12Engine.exe", owner: { pid: owner.pid!, startMs: 1, heartbeatAt: Date.now() } }); });
  await fleet.sweep();
  check("孤児でも、pid のイメージ名が記録(DX12Engine.exe)と違えば kill しない(pid の使い回しで無関係なプロセスを殺さない)", pidAlive(innocent.pid!) && !fleet.registry.read().engines["e-img"]);
  check("レジストリに載っていない他のプロセスは絶対に触らない", pidAlive(bystander.pid!));
  check("imageOf / isProcessOf: 自分は node.exe", imageOf(process.pid)?.toLowerCase() === "node.exe" && isProcessOf(process.pid, "NODE.EXE") && !isProcessOf(process.pid, "DX12Engine.exe") && imageOf(999999) === null);
  killTreeSync(innocent.pid!); killTreeSync(bystander.pid!);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[7] エンジン側の契約: --owner-pid / --idle-exit(偽エンジン。実エンジンは C++ の FleetGuard が同じ意味で実装)");
{
  const dir = mkTmp("own");
  const owner = spawn(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { stdio: "ignore" });
  const port = 8896;
  const t0 = Date.now();
  const eng = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--owner-pid", String(owner.pid), "--instance-id", "e-own"], { cwd: dir, stdio: "ignore", windowsHide: true }); track(eng.pid);
  await waitFor(async () => !!(await rawPing(port, 300)), 5000);
  check("owner が生きている間はエンジンも生きている", pidAlive(eng.pid!));
  const died = await waitDead(eng.pid!, 8000);
  check("owner(pid)が消えたらエンジンが自分で終了する(--owner-pid)", died && Date.now() - t0 < 6000, Date.now() - t0);
  const port2 = 8895;
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" }); await new Promise((r) => gone.on("exit", r));
  const e2 = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port2), "--owner-pid", String(gone.pid)], { cwd: dir, stdio: "ignore", windowsHide: true }); track(e2.pid);
  check("起動時にすでに owner が居ないエンジンも終了する", await waitDead(e2.pid!, 6000));
}
{
  const dir = mkTmp("idle"); const port = 8894;
  const eng = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port), "--idle-exit", "0.05"], { cwd: dir, stdio: "ignore", windowsHide: true }); track(eng.pid);   // 0.05 分 = 3 秒
  await waitFor(async () => !!(await rawPing(port, 300)), 5000);
  const t0 = Date.now();
  // ping だけ撃ち続ける(活動に数えない)
  while (pidAlive(eng.pid!) && Date.now() - t0 < 9000) { await rawPing(port, 200); await new Promise((r) => setTimeout(r, 150)); }
  const dt = Date.now() - t0;
  check("--idle-exit: ping だけを撃ち続けても、活動が無ければ約 3 秒で終了する(ping は活動に数えない)", !pidAlive(eng.pid!) && dt >= 2500 && dt < 6500, dt);
  const port2 = 8893;
  const e2 = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(port2), "--idle-exit", "0.05"], { cwd: dir, stdio: "ignore", windowsHide: true }); track(e2.pid);
  await waitFor(async () => !!(await rawPing(port2, 300)), 5000);
  const s = await (async () => { const c = net.connect(port2, "127.0.0.1"); c.on("error", () => undefined); await new Promise((r) => c.once("connect", r)); return c; })();
  const t1 = Date.now();
  await new Promise((r) => setTimeout(r, 2000));
  s.write(JSON.stringify({ id: 1, method: "list_entities", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 300));
  const ping2: any = await rawPing(port2, 500);
  check("ping 以外の呼び出しで idleSec が 0 に戻る", ping2 && ping2.idleSec < 1, ping2?.idleSec);
  await waitDead(e2.pid!, 9000);
  check("リセット後、さらに約 3 秒無操作で終了する(2 秒 + 3 秒)", !pidAlive(e2.pid!) && Date.now() - t1 >= 4500, Date.now() - t1);
  s.destroy();
  const e3 = spawn(process.execPath, [MOCK_ENGINE_SCRIPT, "--mcp-port", String(8892), "--idle-exit", "0"], { cwd: dir, stdio: "ignore", windowsHide: true }); track(e3.pid);
  await waitFor(async () => !!(await rawPing(8892, 300)), 5000);
  await new Promise((r) => setTimeout(r, 1500));
  check("--idle-exit 0 は無効(自動終了しない)", pidAlive(e3.pid!));
  killTreeSync(e3.pid!);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[8] アイドル自動終了(MCP サーバ側。10 分を短い値へ時間短縮)");
{
  const { fleet, router } = newFleet({ DX12_FLEET_IDLE_MIN: "0.03" });   // 0.03 分 = 1.8 秒
  const a: any = await fleet.launch({});
  fleet.startMonitor();
  check("エンジンのアイドル終了は MCP 側の閾値より少し長い保険(--idle-exit = idleMin + 余裕)", a.idle.engineIdleExitMin > 0.03 && a.idle.idleMin === 0.03, a.idle);
  const t0 = Date.now();
  // 1 秒ごとに実操作(list_entities)を送り続ける間は止まらない
  for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 1000)); await router.call("list_entities", {}); }
  check("操作が続いている間(4 秒 > 閾値 1.8 秒)は止まらない", pidAlive(a.pid) && router.boundId() === a.engineId, Date.now() - t0);
  const t1 = Date.now();
  // ping(状態確認)だけでは延命しない
  while (pidAlive(a.pid) && Date.now() - t1 < 8000) { await router.call("ping", {}).catch(() => undefined); await new Promise((r) => setTimeout(r, 200)); }
  const dt = Date.now() - t1;
  check("操作が無く(ping だけ)閾値を超えると MCP 側が engine_stop する(約 1.8〜3 秒)", !pidAlive(a.pid) && dt >= 1000 && dt < 6000, dt);
  await new Promise((r) => setTimeout(r, 300));
  check("停止後: エントリ・インスタンス削除・束縛解除・イベントに idle が記録される", Object.keys(fleet.registry.read().engines).length === 0 && router.boundId() === null && !fs.existsSync(a.dir.instance) && fleet.events.some((e) => e.kind === "idle" && e.engine === a.engineId), fleet.events);
  fleet.stopMonitor();
}
{
  // 自分のエンジンが外から殺された/自殺したら、監視が片付けて束縛を外す
  const { fleet, router } = newFleet();
  const a: any = await fleet.launch({});
  fleet.startMonitor();
  killTreeSync(a.pid); await waitDead(a.pid);
  const ok = await waitFor(() => Object.keys(fleet.registry.read().engines).length === 0 && router.boundId() === null, 8000, 100);
  check("エンジンが死んだら監視が(自分のものでも)エントリを消し、束縛を外す", ok);
  fleet.stopMonitor();
}
{
  // ハートビート: owner のハートビートが更新される
  const { fleet } = newFleet({ DX12_FLEET_HEARTBEAT_MS: "200" });
  const a: any = await fleet.launch({});
  const h0 = fleet.registry.read().engines[a.engineId].owner.heartbeatAt;
  fleet.startMonitor();
  await new Promise((r) => setTimeout(r, 900));
  check("監視が owner のハートビートを更新する(生存の証拠)", fleet.registry.read().engines[a.engineId].owner.heartbeatAt > h0);
  fleet.stopMonitor();
  await fleet.stop({ all: true });
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[9] refresh / 古い exe コピー");
{
  const { fleet, router, bd } = newFleet();
  const a: any = await fleet.launch({});
  const l0: any = await fleet.list();
  check("コピー直後は古くない", l0.engines[0].exe.stale === false);
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(path.join(bd, "DX12Engine.exe"), Buffer.alloc(210_000, 9));   // ビルドし直した
  const l1: any = await fleet.list();
  check("元の exe が新しくなると『古い exe コピー』と分かる", l1.engines[0].exe.stale === true);
  const st: any = await fleet.status();
  check("status(doctor 用)が staleExe に載せる", st.staleExe.includes(a.engineId));
  const iss = fleetIssues(st);
  check("doctor の診断: FLEET_STALE_EXE(warn)+ fix が dx12_engine_refresh", iss.some((i) => i.code === "FLEET_STALE_EXE" && i.severity === "warn" && i.fix?.[0]?.tool === "dx12_engine_refresh" && (i.fix[0].args as any).engine === a.engineId), iss);
  // 使い捨てプロジェクトに作業内容(自動保存の代わりにマーカー)があっても、refresh は初期シーンで上書きしない
  fs.writeFileSync(path.join(a.dir.project, "assets", "scenes", "main.json"), '{"entities":[{"name":"MyWork"}]}');
  fs.writeFileSync(path.join(a.dir.project, "assets", "scenes", "marker.txt"), "keep");
  // refresh の最中に、別のセッション(孤児スイープ)・自分の監視が走り続けても、エントリを消されない(殺してから書き換える順序だと消される)
  fleet.testHooks.afterKill = () => new Promise((res) => setTimeout(res, 400));   // 殺した直後の窓を広げる(実機ではポート解放待ちで数百 ms〜3 秒空く)
  const spam = setInterval(() => { void fleet.sweep().catch(() => undefined); }, 5);
  const r: any = await fleet.refresh({}).finally(() => clearInterval(spam));
  check("refresh 中にスイープが走り続けても、エントリ・インスタンスを消されずに再起動できる", r.engineId === a.engineId && !!fleet.registry.read().engines[a.engineId] && fs.existsSync(r.dir.instance), r.error);
  check("refresh は使い捨てプロジェクトの作業内容を初期シーンで上書きしない(自動保存された作業が残る)", fs.readFileSync(path.join(a.dir.project, "assets", "scenes", "main.json"), "utf8").includes("MyWork") && fs.existsSync(path.join(a.dir.project, "assets", "scenes", "marker.txt")));
  check("refresh: 同じ id・ポートで新しい pid に再起動し、古い pid は死ぬ", r.engineId === a.engineId && r.port === a.port && r.pid !== a.pid && !pidAlive(a.pid) && pidAlive(r.pid) && r.previous.wasStale === true, r);
  check("refresh 後は exe コピーが新しい(サイズ更新)・stale が消える・束縛が保たれる", fs.statSync(r.exe.path).size === 210_000 && r.exe.stale === false && router.boundId() === a.engineId);
  check("refresh 後のエンジンへ繋がる(同じ束縛スロットが繋ぎ直す)", (await router.call("ping", {})).pid === r.pid);
  check("refresh のエントリ: state ready・pid 更新・args 保持", (() => { const e = fleet.registry.read().engines[a.engineId]; return e.state === "ready" && e.pid === r.pid && e.args.includes("--background") && e.args[e.args.indexOf("--mcp-port") + 1] === String(a.port); })());
  const nf = await failure(() => fleet.refresh({ engine: "e-nope" }));
  check("未知の engine → E_FLEET_NOT_FOUND", nf?.body.code === "E_FLEET_NOT_FOUND");
  await fleet.stop({ all: true });
  const { fleet: f2 } = newFleet({}, mkTmp("nob"));
  const m = await failure(() => f2.refresh({}));
  check("自分のエンジンが無ければ refresh は E_MISSING_PARAM 相当の案内で断る", !!m && ["E_MISSING_PARAM", "E_FLEET_EXE_MISSING"].includes(m.body.code), m?.body);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[10] 終了処理(shutdownSync)と使い捨てプロジェクトの GC");
{
  const { fleet, router } = newFleet();
  const a: any = await fleet.launch({}); const b: any = await fleet.launch({});
  const other = spawnSleeper(); track(other.pid);
  const oe = spawnSleeper(); track(oe.pid);
  fleet.registry.transaction((d) => { d.engines["e-other"] = blankEntry("e-other", 8871, { pid: oe.pid!, imageName: "node.exe", owner: { pid: other.pid!, startMs: 1, heartbeatAt: Date.now() } }); });
  const t0 = Date.now();
  fleet.shutdownSync();
  check("shutdownSync: 自分が owner のエンジンを全部止める(プロセスツリーごと)", !pidAlive(a.pid) && !pidAlive(b.pid), Date.now() - t0);
  check("shutdownSync: 自分のエントリとインスタンスを消し、他人のエントリ・プロセスには触れない", (() => { const e = fleet.registry.read().engines; return Object.keys(e).length === 1 && !!e["e-other"] && pidAlive(oe.pid!) && !fs.existsSync(a.dir.instance); })());
  console.log(`      shutdownSync(2 台)${Date.now() - t0} ms`);
  killTreeSync(oe.pid!); killTreeSync(other.pid!);
  void router;
}
{
  const { fleet } = newFleet();
  const p = path.join(fleet.cfg.dir, "projects", "old-1"); fs.mkdirSync(p, { recursive: true });
  const q = path.join(fleet.cfg.dir, "projects", "new-1"); fs.mkdirSync(q, { recursive: true });
  const old = new Date(Date.now() - 25 * 3600_000); fs.utimesSync(p, old, old);
  const i = path.join(fleet.cfg.dir, "instances", "e-leftover"); fs.mkdirSync(i, { recursive: true });
  fs.utimesSync(i, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  await fleet.sweep();
  check("24 時間より古い使い捨てプロジェクトとレジストリに無い古いインスタンスを GC する(新しいものは残す)", !fs.existsSync(p) && fs.existsSync(q) && !fs.existsSync(i));
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[11] doctor のフリート診断(純関数)");
{
  const base = { engines: [{ id: "e-1", ownedByMe: true, idleSec: 30 }, { id: "e-2", ownedByMe: false, idleSec: 5 }, { id: "e-3", ownedByMe: true, idleSec: 700 }], count: 3, max: 3, staleExe: [], orphans: [], resources: { violations: [], vramSource: "nvidia-smi" } };
  const at = fleetIssues(base);
  check("台数が上限 → FLEET_AT_LIMIT(info)+ 自分のエンジンを止める fix", at.length === 1 && at[0].code === "FLEET_AT_LIMIT" && at[0].severity === "info" && at[0].fix?.length === 2 && at[0].fix.every((f) => f.tool === "dx12_engine_stop"), at);
  const many = fleetIssues({ ...base, count: 1, staleExe: ["e-1"], orphans: ["e-9"], resources: { violations: ["空き VRAM が 1000 MB"], vramSource: "unknown" } });
  check("古い exe・孤児・資源不足・VRAM 不明を診断する", ["FLEET_STALE_EXE", "FLEET_ORPHAN", "FLEET_LOW_RESOURCES", "FLEET_VRAM_UNKNOWN"].every((c) => many.some((i) => i.code === c)), many.map((i) => i.code));
  const sw = fleetIssues({ ...base, count: 1, swept: [{ id: "e-9", reason: "orphan" }, { id: "e-8", reason: "engine-dead" }] });
  check("孤児を回収したら FLEET_ORPHAN_SWEPT(info)で知らせる(死んだエンジンの掃除だけでは出さない)", sw.some((i) => i.code === "FLEET_ORPHAN_SWEPT" && i.severity === "info" && /e-9/.test(i.message) && !/e-8/.test(i.message)), sw);
  check("何も無ければ診断項目なし", fleetIssues({ engines: [], count: 0, max: 3, staleExe: [], orphans: [], resources: { violations: [], vramSource: "nvidia-smi" } }).length === 0);
  check("fix の tool が実在する名前(dx12_engine_refresh / list / stop)", many.flatMap((i) => i.fix ?? []).every((f) => !f.tool || ["dx12_engine_refresh", "dx12_engine_list", "dx12_engine_stop"].includes(f.tool)));
}

// ── 後始末 ──────────────────────────────────────────────────────────────
for (const f of fleets) { try { f.shutdownSync(); } catch { /* 無視 */ } }
killTracked();
for (const d of dirs) rmTree(d);
console.log(failed === 0 ? `OK: フリートのロジック試験 ${total} 項目すべて通過` : `NG: ${failed}/${total} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
void portIsFree;
