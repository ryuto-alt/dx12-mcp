// フリートの統合試験(MCP サーバを別プロセスで起動し、stdio の MCP で叩く。偽エンジンを使うのでエンジン不要)。
//   [1] 1 つのセッション: core 面の tools/list(40 本・use は長尾)→ 起動 → 束縛 → 呼び出しが専用エンジンへ届く → doctor → engine 引数 → 停止
//   [2] 複数セッション(別プロセスの MCP サーバ 3〜5 つ): 別ポート・別 exe コピー・別データ領域・上限 3 台・他人のエンジンは止められない・attach 読み取り専用
//   [3] 同時 launch(5 サーバ同時): ちょうど 3 台だけ成功する
//   [4] 終了処理: stdio クローズ(正常終了)で自分のエンジンが全部止まる / 強制終了なら --owner-pid で自殺し、次のスイープで片付く
//   [5] リソースガード・アイドル自動終了(時間短縮)・自動起動(DX12_FLEET_AUTOLAUNCH)・legacy 面にはフリートが出ない
// 実行: node fleetStdio.test.ts   (使うポートは 8860〜8899 だけ。手動起動用の 8850〜8859 と 8787 には触れない)
import fs from "node:fs";
import path from "node:path";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { tmpDir, makeFakeBuild, fleetEnv, waitFor, waitDead, killTracked, track, rmTree } from "./fleetTestKit.ts";
import { pidAlive } from "./fleet/proc.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}

const dirs: string[] = [];
const clients: McpClient[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };
const build = makeFakeBuild(mk("build"));
// 束縛が無いときの従来の接続先は「閉じたポート」にする(ユーザーの実エンジン・他のエージェントのポートに触れない)
const NO_ENGINE = { DX12_MCP_PORT: "8888", DX12_MCP_PORT_FILE: path.join(mk("pf"), "none.port") };

function server(fleetDir: string, extra: Record<string, string> = {}, surface: "core" | "full" | "legacy" = "core") {
  const c = startMcp({ ...fleetEnv(fleetDir, build), ...NO_ENGINE, DX12_MCP_SURFACE: surface, ...extra });
  clients.push(c);
  return c;
}
const launch = async (c: McpClient, args: any = {}) => c.call("dx12_engine_launch", args);
// M7: dx12_engine_list は Core から長尾へ移した(dx12_call で使う)。core 面の直接呼び出しはできないので dx12_call 経由で読む。
const engineList = async (c: McpClient) => (await c.call("dx12_call", { name: "dx12_engine_list", args: {} })).result;
const engineOf = (r: any) => ({ id: r.engineId as string, pid: r.pid as number, port: r.port as number, dir: r.dir as any });

// ────────────────────────────────────────────────────────────────────────────
console.log("[1] 1 つのセッション(core 面)");
{
  const fd = mk("f1");
  const s = server(fd);
  const init = await s.initialize();
  check("instructions にフリートの使い方(dx12_engine_launch)が載る", /dx12_engine_launch/.test(init.instructions) && init.instructions.length <= 2048, init.instructions.length);
  const list = (await s.rpc("tools/list")).result.tools;
  const names: string[] = list.map((t: any) => t.name);
  check("core 面は 40 本(shell 5 + フリート 2 + ジョブ 3 + Core 28(エディタ操作 2 を含む)+ batch + call_guarded)", list.length === 40, list.length);
  check("フリートの 2 本とジョブの 3 本が shell の直後に並ぶ(launch / stop / job_start / job_status / job_cancel。list / attach / refresh / use は長尾)", JSON.stringify(names.slice(5, 10)) === JSON.stringify(["dx12_engine_launch", "dx12_engine_stop", "dx12_job_start", "dx12_job_status", "dx12_job_cancel"]), names.slice(5, 10));
  check("dx12_engine_use は core 面に出ない(長尾: dx12_call で使う)", !names.includes("dx12_engine_use"));
  const desc = Object.fromEntries(list.map((t: any) => [t.name, t]));
  check("フリートの説明は Core テンプレ(使う / 使わない / 副作用)・600 字以内・標準語", ["dx12_engine_launch", "dx12_engine_stop", "dx12_job_start", "dx12_job_status", "dx12_job_cancel"].every((n) => /使う/.test(desc[n].description) && /使わない/.test(desc[n].description) && /副作用/.test(desc[n].description) && desc[n].description.length <= 600));
  check("dx12_engine_list は core 面に出ない(M7 で長尾へ。dx12_call {name:'dx12_engine_list'} で使える)", !names.includes("dx12_engine_list"));
  check("annotations: stop は destructive・launch は書き込み(guarded ではない)", desc.dx12_engine_stop.annotations.destructiveHint === true && desc.dx12_engine_launch.annotations.readOnlyHint === false && !desc.dx12_engine_launch._meta?.["anthropic/requiresUserInteraction"]);

  // 束縛前: 従来の探索(閉じたポート)→ 繋がらない。fix に dx12_engine_launch が出る
  const before = await s.call("dx12_list_entities", {});
  check("エンジンが無いとき: E_ENGINE_UNREACHABLE の fix に dx12_engine_launch(専用エンジンの起動)が入る", before.error_code === "E_ENGINE_UNREACHABLE" && before.fix?.some((f: any) => f.tool === "dx12_engine_launch"), before);

  const t0 = Date.now();
  const L = await launch(s, { name: "a1" });
  const ms = Date.now() - t0;
  check("dx12_engine_launch: engineId / port / pid / dir を返し束縛済み", /^e-/.test(L.engineId) && L.name === "a1" && L.port >= 8860 && L.port <= 8899 && pidAlive(L.pid) && L.bound === true && !!L.dir?.bin && !!L.dir?.data && !!L.dir?.project, L);
  track(L.pid);
  console.log(`      launch(偽エンジン)${ms} ms`);
  const ents = await s.call("dx12_list_entities", {});
  check("束縛後は従来のツールがそのエンジンへ向く(list_entities が通る)", Array.isArray(ents.entities) && ents.count === 5, ents);
  const ping = await s.call("dx12_call", { name: "dx12_ping", args: {} });
  check("dx12_call {dx12_ping} の結果が専用エンジンのもの(instanceId・ownerPid・cwd が bin)", ping.ok && ping.result.instanceId === L.engineId && ping.result.ownerPid === s.proc.pid && path.resolve(ping.result.cwd) === path.resolve(L.dir.bin), ping);
  const lst = await engineList(s);
  check("dx12_engine_list: 自分のエンジン 1 台・束縛中・上限 3・資源つき", lst.engines.length === 1 && lst.engines[0].ownedByMe && lst.engines[0].bound && lst.fleet.max === 3 && lst.bound === L.engineId, lst);
  const doc = await s.call("dx12_doctor", {});
  check("dx12_doctor にフリート状態(台数/上限/資源/エンジン)が入る", doc.fleet?.count === 1 && doc.fleet.max === 3 && doc.fleet.resources.vramFreeMB === 6000 && doc.fleet.engines.length === 1 && doc.engine.connected === true && doc.engine.port === L.port, doc.fleet);
  check("doctor: 束縛したエンジンへ ping している(engine.port が専用エンジン)", doc.ports.target === L.port && doc.ok === true, doc.ports);

  // 2 台目 → 束縛が移る。dx12_call {engine} で 1 回だけ別のエンジンへ
  const L2 = await launch(s, { name: "a2" }); track(L2.pid);
  check("2 台目を起動すると束縛が 2 台目へ移る(ポート・exe コピーは別)", L2.port !== L.port && L2.dir.bin !== L.dir.bin && L2.dir.data !== L.dir.data);
  const def = await s.call("dx12_call", { name: "dx12_ping", args: {} });
  const ov = await s.call("dx12_call", { name: "dx12_ping", args: {}, engine: "a1" });
  const ov2 = await s.call("dx12_call", { name: "dx12_ping", args: {}, engine: L.port });
  check("dx12_call {engine} は 1 回だけ別のエンジンへ向ける(name / port)。束縛は変わらない", def.result.instanceId === L2.engineId && ov.result.instanceId === L.engineId && ov2.result.instanceId === L.engineId && (await s.call("dx12_call", { name: "dx12_ping", args: {} })).result.instanceId === L2.engineId, { def: def.result?.instanceId, ov: ov.result?.instanceId });
  const bad = await s.call("dx12_call", { name: "dx12_ping", args: {}, engine: "a3" });
  check("dx12_call {engine:'a3'}(存在しない)→ E_FLEET_NOT_FOUND + didYouMean + fix", bad.error_code === "E_FLEET_NOT_FOUND" && bad.didYouMean?.length > 0 && bad.fix?.some((f: any) => f.tool === "dx12_engine_list"), bad);
  const use = await s.call("dx12_call", { name: "dx12_engine_use", args: { engine: "a1" } });
  check("dx12_engine_use(長尾)は dx12_call から使え、既定が切り替わる", use.ok && use.result.bound === L.engineId && (await s.call("dx12_call", { name: "dx12_ping", args: {} })).result.instanceId === L.engineId, use);
  const useNone = await s.call("dx12_call", { name: "dx12_engine_use", args: { engine: "none" } });
  const afterNone = await s.call("dx12_list_entities", {});
  check("use none で束縛を外すと従来の探索に戻る(閉じたポートなので E_ENGINE_UNREACHABLE)", useNone.result.bound === null && afterNone.error_code === "E_ENGINE_UNREACHABLE", afterNone.error_code);
  await s.call("dx12_call", { name: "dx12_engine_use", args: { engine: "a2" } });

  // ツールのエラーは dx12_call 経由でも構造化されたまま
  const vis = await s.call("dx12_call", { name: "dx12_engine_launch", args: { mode: "visible" } });
  check("dx12_call 経由でも E_FLEET_VISIBLE_DENIED(fix・cause がそのまま)", vis.ok === false && vis.error_code === "E_FLEET_VISIBLE_DENIED" && vis.fix?.length > 0 && /DX12_MCP_ALLOW_VISIBLE/.test(vis.cause), vis);
  const direct = await s.raw("dx12_engine_launch", { mode: "visible" });
  check("直接呼びでも isError:true の構造化 JSON", direct.isError === true && JSON.parse(direct.content[0].text).error_code === "E_FLEET_VISIBLE_DENIED");
  const unk = await s.raw("dx12_engine_launch", { modee: "background" });
  check("知らない引数は近い名前つきで弾く(mode)", unk.isError === true && /mode/.test(unk.content[0].text), unk.content[0].text.slice(0, 200));
  const badMode = await s.raw("dx12_engine_launch", { mode: "backgroud" });
  check("mode の enum 違いも弾く", badMode.isError === true);

  const st = await s.call("dx12_engine_stop", { all: true });
  check("dx12_engine_stop {all}: 全部止まり、プロセスが残らない", st.stopped.length === 2 && !pidAlive(L.pid) && !pidAlive(L2.pid) && st.remaining === 0 && st.bound === null, st);
  const lst2 = await engineList(s);
  check("停止後の一覧は空・インスタンスフォルダも無い", lst2.engines.length === 0 && !fs.existsSync(L.dir.instance) && !fs.existsSync(L2.dir.instance));
  s.proc.stdin!.end();
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[2] 複数セッション(別プロセスの MCP サーバ)");
const shared = mk("shared");
const S: McpClient[] = [];
const E: ReturnType<typeof engineOf>[] = [];
{
  for (let i = 0; i < 4; i++) { const c = server(shared, {}, i === 3 ? "full" : "core"); S.push(c); await c.initialize(); }
  // 3 台を同時に起動
  const t0 = Date.now();
  const rs = await Promise.all([0, 1, 2].map((i) => launch(S[i], { name: `agent${i}` })));
  for (const r of rs) { E.push(engineOf(r)); track(r.pid); }
  console.log(`      3 セッション同時 launch: ${Date.now() - t0} ms`);
  check("3 つの別セッションが同時に起動して全部成功する", rs.every((r) => r.engineId && !r.error_code), rs.map((r) => r.error_code ? [r.error_code, r.error, r.details] : r.engineId));
  check("ポート・exe コピー・データ領域・作業ディレクトリ・pid が全部別", new Set(E.map((e) => e.port)).size === 3 && new Set(E.map((e) => e.dir.bin)).size === 3 && new Set(E.map((e) => e.dir.data)).size === 3 && new Set(E.map((e) => e.pid)).size === 3);
  const markers = E.map((e) => JSON.parse(fs.readFileSync(path.join(e.dir.data, "mock_marker.json"), "utf8")));
  check("各エンジンの DX12E_DATA_DIR / cwd は自分のインスタンス(他と共有しない)", markers.every((m, i) => path.resolve(m.dataDir) === path.resolve(E[i].dir.data) && path.resolve(m.cwd) === path.resolve(E[i].dir.bin)));
  // それぞれ独立に操作できる
  const pings = await Promise.all(S.slice(0, 3).map((c) => c.call("dx12_call", { name: "dx12_ping", args: {} })));
  check("各セッションは自分専用のエンジンにだけ届く(instanceId が自分の id)", pings.every((p, i) => p.result.instanceId === E[i].id && p.result.ownerPid === S[i].proc.pid), pings.map((p) => p.result?.instanceId));
  const ops = await Promise.all(S.slice(0, 3).map((c, i) => c.call("dx12_call", { name: "dx12_create_entity", args: { type: "box", name: `Box_${i}` } })));
  check("それぞれ独立に書き込み系の操作もできる", ops.every((o) => o.ok !== false && !o.error_code), ops.map((o) => o.error_code));
  // 4 台目は理由つきで断る
  const t1 = Date.now();
  const r4 = await launch(S[3], {});
  check("4 台目(別セッション)は E_FLEET_LIMIT で断られる(全セッション合計)", r4.error_code === "E_FLEET_LIMIT" && /最大 3 台/.test(r4.error), r4);
  check("理由・対処: cause に上限、details.others に他人の 3 台(owner・project・idleSec)、fix は list と『ユーザーに確認』", /DX12_FLEET_MAX=3/.test(r4.cause) && r4.details.others.length === 3 && r4.details.others.every((o: any) => o.ownerPid && o.project !== undefined) && r4.fix.some((f: any) => f.tool === "dx12_engine_list") && /ユーザーに確認/.test(r4.details.note), r4);
  console.log(`      4 台目を断るまで ${Date.now() - t1} ms`);
  // 一覧は全セッションが同じものを見る
  const l3 = await engineList(S[2]);
  check("dx12_engine_list は他のセッションのエンジンも見せる(ownedByMe は自分だけ)", l3.engines.length === 3 && l3.engines.filter((e: any) => e.ownedByMe).length === 1 && l3.engines.find((e: any) => e.ownedByMe).id === E[2].id, l3.engines.map((e: any) => [e.id, e.ownedByMe]));
  // 他人のエンジンは止められない
  const ns = await S[1].call("dx12_engine_stop", { engine: E[0].id });
  check("他のセッションのエンジンは engine_stop で止められない(E_FLEET_NOT_OWNER)・生きている", ns.error_code === "E_FLEET_NOT_OWNER" && pidAlive(E[0].pid), ns);
  // attach は読み取り専用
  const at = await S[3].call("dx12_engine_attach", { engine: E[0].id });
  check("full 面のセッションが他人のエンジンを attach(読み取り専用)", at.readOnly === true && at.fleetEngine?.id === E[0].id, at);
  const ro = await S[3].call("dx12_list_entities", {});
  const wr = await S[3].call("dx12_set_transform", { name: "Player", position: [0, 0, 0] });
  check("attach 中: 読み取りは通り、書き込みは E_FLEET_READONLY(エンジンへ届かない)", Array.isArray(ro.entities) && wr.error_code === "E_FLEET_READONLY" && wr.fix?.some((f: any) => f.tool === "dx12_engine_launch"), wr);
  const play = await S[3].call("dx12_call", { name: "dx12_play", args: {} });
  check("Play も撮影も(dx12_call 経由でも)読み取り専用では拒否される", play.error_code === "E_FLEET_READONLY");
  // 持ち主(別セッション)の接続は attach に塞がれない(貸し出し接続)
  await new Promise((r) => setTimeout(r, 2000));
  const own0 = await S[0].call("dx12_call", { name: "dx12_ping", args: {} });
  check("attach の貸し出し接続が閉じた後、持ち主のセッションは普通に使える", own0.ok && own0.result.instanceId === E[0].id, own0);
  // full 面の tools/list: 末尾にフリート 6 本
  const fullTools = (await S[3].rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("full 面の tools/list は shell 5 + 旧 220 + パストレーサー 3 + 仮想ジオメトリ 2 + lua_step 1 + フリート 6 + ジョブ 6 + エディタ操作 5 + シーン仕様 2 本(末尾)", fullTools.length === 250 && JSON.stringify(fullTools.slice(-19, -13)) === JSON.stringify(["dx12_engine_launch", "dx12_engine_list", "dx12_engine_stop", "dx12_engine_attach", "dx12_engine_refresh", "dx12_engine_use"]) && JSON.stringify(fullTools.slice(-13, -7)) === JSON.stringify(["dx12_job_start", "dx12_job_status", "dx12_job_cancel", "dx12_job_list", "dx12_job_result", "dx12_job_logs"]) && JSON.stringify(fullTools.slice(-2)) === JSON.stringify(["dx12_apply_scene_spec", "dx12_scene_spec_export"]) && JSON.stringify(fullTools.slice(-7, -2)) === JSON.stringify(["dx12_editor_command", "dx12_editor_state", "dx12_editor_notify", "dx12_editor_select", "dx12_editor_modal"]), fullTools.length);
  await S[3].call("dx12_engine_stop", { engine: `x-${E[0].port}` });
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[3] 終了処理");
{
  // 正常終了: stdio クローズで自分のエンジンだけが止まる
  const t0 = Date.now();
  S[0].proc.stdin!.end();
  const exited = await waitFor(() => S[0].proc.exitCode !== null, 8000);
  const dead0 = await waitDead(E[0].pid, 6000);
  check("MCP サーバの stdio が閉じると(正常終了)自分のエンジンが全部止まる", exited && dead0 && pidAlive(E[1].pid) && pidAlive(E[2].pid), { exited, dead0 });
  console.log(`      サーバ終了 → エンジン停止まで ${Date.now() - t0} ms`);
  const reg0 = JSON.parse(fs.readFileSync(path.join(shared, "registry.json"), "utf8"));
  check("レジストリから自分のエントリが消え、インスタンスフォルダも消える(他人のものは残る)", !reg0.engines[E[0].id] && !!reg0.engines[E[1].id] && !!reg0.engines[E[2].id] && !fs.existsSync(E[0].dir.instance));
  // 強制終了(TerminateProcess): ハンドラは走らない → エンジンが --owner-pid で自分で終わり、次のスイープで片付く
  const t1 = Date.now();
  S[1].proc.kill();
  await waitFor(() => S[1].proc.exitCode !== null || S[1].proc.killed, 3000);
  const dead1 = await waitDead(E[1].pid, 8000);
  check("MCP サーバが強制終了されても、エンジンが --owner-pid で自分で終了する", dead1 && Date.now() - t1 < 8000, Date.now() - t1);
  console.log(`      強制終了 → エンジン自殺まで ${Date.now() - t1} ms`);
  const l = await engineList(S[2]);
  check("次にどのセッションかが list すると孤児のエントリ・インスタンスが掃除される", l.engines.length === 1 && l.engines[0].id === E[2].id && !fs.existsSync(E[1].dir.instance), l.engines.map((e: any) => e.id));
  S[2].proc.stdin!.end();
  await waitDead(E[2].pid, 6000);
  S[3].proc.stdin!.end();
  await waitFor(() => S[2].proc.exitCode !== null && S[3].proc.exitCode !== null, 6000);
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[4] 同時 launch(5 つのセッションが一斉に起動)");
{
  const fd = mk("race");
  const cs = Array.from({ length: 5 }, () => server(fd));
  await Promise.all(cs.map((c) => c.initialize()));
  const t0 = Date.now();
  const rs = await Promise.all(cs.map((c) => launch(c, {})));
  const ok = rs.filter((r) => r.engineId), ng = rs.filter((r) => r.error_code);
  for (const r of ok) track(r.pid);
  console.log(`      5 セッション一斉 launch: ${Date.now() - t0} ms`);
  check("ちょうど 3 台だけ成功し、残り 2 つは E_FLEET_LIMIT(上限を超えて起動しない)", ok.length === 3 && ng.length === 2 && ng.every((r) => r.error_code === "E_FLEET_LIMIT"), rs.map((r) => r.error_code ?? r.engineId));
  check("成功した 3 台のポートは重複しない", new Set(ok.map((r) => r.port)).size === 3);
  const reg = JSON.parse(fs.readFileSync(path.join(fd, "registry.json"), "utf8"));
  check("レジストリも 3 台(壊れていない・余計な予約なし)", Object.keys(reg.engines).length === 3 && Object.values<any>(reg.engines).every((e) => e.state === "ready"));
  // 上限に達している間の停止 → すぐ空いた枠で起動できる
  const stopper = cs[rs.findIndex((r) => r.engineId)];
  await stopper.call("dx12_engine_stop", { all: true });
  const failedOne = cs[rs.findIndex((r) => r.error_code)];
  const retry = await launch(failedOne, {});
  check("枠が空けば、断られたセッションが撃ち直して起動できる", !!retry.engineId, retry); track(retry.pid);
  for (const c of cs) c.proc.stdin!.end();
  await waitFor(() => cs.every((c) => c.proc.exitCode !== null), 8000);
  check("全セッションを閉じるとエンジンが 1 台も残らない", await waitFor(() => ok.every((r) => !pidAlive(r.pid)) && !pidAlive(retry.pid), 8000));
}

// ────────────────────────────────────────────────────────────────────────────
console.log("[5] リソースガード・アイドル自動終了・自動起動・legacy 面");
{
  const s = server(mk("res"), { DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ vramFreeMB: 900, vramTotalMB: 8000, ramFreeMB: 16000 }) });
  await s.initialize();
  const r = await launch(s, {});
  check("VRAM 不足(空き 900 MB < 2048)→ E_FLEET_RESOURCE(理由・下限・環境変数・fix)", r.error_code === "E_FLEET_RESOURCE" && /900/.test(r.error) && /DX12_FLEET_MIN_FREE_VRAM_MB/.test(r.cause) && r.retryable === true && r.fix?.length > 0, r);
  s.proc.stdin!.end();
}
{
  const s = server(mk("idle"), { DX12_FLEET_IDLE_MIN: "0.03" });   // 0.03 分 = 1.8 秒
  await s.initialize();
  const L = await launch(s, { name: "idle1" }); track(L.pid);
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 900)); await s.call("dx12_list_entities", {}); }
  check("操作が続く間は止まらない", pidAlive(L.pid));
  const gone = await waitDead(L.pid, 8000);
  check("アイドルが閾値(1.8 秒に短縮した 10 分)を超えると自動で止まる", gone);
  const l = await engineList(s);
  check("止まったエンジンは一覧から消え、束縛も外れる", l.engines.length === 0 && l.bound === null, l);
  const after = await s.call("dx12_list_entities", {});
  check("止まった後の呼び出しは E_ENGINE_UNREACHABLE + fix に dx12_engine_launch(撃ち直して復帰できる)", after.error_code === "E_ENGINE_UNREACHABLE" && after.fix?.some((f: any) => f.tool === "dx12_engine_launch"), after);
  s.proc.stdin!.end();
}
{
  const s = server(mk("auto"), { DX12_FLEET_AUTOLAUNCH: "1" });
  await s.initialize();
  const ents = await s.call("dx12_list_entities", {});
  const l = await engineList(s);
  check("DX12_FLEET_AUTOLAUNCH=1: エンジンが無ければ最初の呼び出しで専用エンジンを起動して成功する", Array.isArray(ents.entities) && l.engines.length === 1 && l.engines[0].bound, { ents, l: l.engines.length });
  if (l.engines[0]) track(l.engines[0].pid);
  s.proc.stdin!.end();
  await waitFor(() => s.proc.exitCode !== null, 5000);
  check("自動起動したエンジンもサーバ終了で止まる", !l.engines[0] || await waitDead(l.engines[0].pid, 6000));
}
{
  const s = server(mk("leg"), {}, "legacy");
  await s.initialize();
  const names = (await s.rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("legacy 面にはフリートのツールを出さない(旧 220 のバイト同一を守る)", names.length === 220 && !names.some((n: string) => n.startsWith("dx12_engine_")), names.length);
  s.proc.stdin!.end();
}
{
  const s = server(mk("dis"), { DX12_FLEET_DISABLE: "1" }, "full");
  await s.initialize();
  const names = (await s.rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("DX12_FLEET_DISABLE=1 ならフリートのツールは出ない(full 面は shell 5 + 旧 220 + パストレーサー 3 + 仮想ジオメトリ 2 + lua_step 1 + ジョブ 6 + エディタ操作 5 + シーン仕様 2 のまま)", names.length === 244 && !names.some((n: string) => n.startsWith("dx12_engine_")), names.length);
  s.proc.stdin!.end();
}

// ── 後始末 ──────────────────────────────────────────────────────────────
for (const c of clients) { try { c.proc.stdin?.end(); } catch { /* 無視 */ } }
await waitFor(() => clients.every((c) => c.proc.exitCode !== null || c.proc.killed), 6000);
for (const c of clients) c.close();
killTracked();
for (const d of dirs) rmTree(d);
console.log(failed === 0 ? `OK: フリートの統合試験 ${total} 項目すべて通過` : `NG: ${failed}/${total} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
