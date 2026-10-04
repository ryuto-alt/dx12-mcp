// 書き換えられない正解(sealed oracles。oracles.ts / toolset/oracles.ts / ORACLE_CHECK)のテスト。偽エンジン(mockEngine)+ 合成 PNG。
//   [1] 純ロジック: 撮影(カメラを置いて戻す)・封印の照合(正常 / 改ざん / 消失 / 追加)・読み取り専用
//   [2] ゲートの検査: 未封印 = 警告 / 改ざん = blocking / 金画像との差(許容内外)・大きさ違い / 性能予算 / シーン違いは飛ばす / Playing は照合だけ
//   [3] ツール dx12_oracle: seal は直接呼びでは E_GUARDED、dx12_call は confirm が要る / status / add_view / check / ゲートの合否
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import "./testEnv.ts";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { startMockEngine } from "./mockEngine.ts";
import { tmpDir, rmTree } from "./fleetTestKit.ts";
import {
  captureView, collectOracleItems, compareView, emptyManifest, goldenPath, ledgerPath, manifestPath, readManifest, runPerf,
  sceneMatches, validateManifest, verifyLedger, writeLedger, writeManifest, type OracleManifest, type OracleView,
} from "./oracles.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirs: string[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };
process.env.DX12_ORACLE_LEDGER_DIR = mk("ledger");   // 実ユーザーの %LOCALAPPDATA% を触らない(子プロセスにも引き継がれる)

// ── 偽エンジンの振る舞い(直接呼びと mockEngine の両方で共有) ─────────────────────
const st = {
  mode: "Editor", scene: "scenes/default.json",
  shot: { w: 64, h: 48, r: 40, g: 90, b: 160, badPixels: 0 },
  bench: { frameMs: { avg: 8, p95: 10 }, drawCalls: 500, gpuPassMs: { total: 4 } } as any,
  log: [] as string[],
};
function makePng(): Buffer {
  const png = new PNG({ width: st.shot.w, height: st.shot.h });
  for (let i = 0; i < st.shot.w * st.shot.h; i++) {
    const bad = i < st.shot.badPixels;
    png.data[i * 4] = bad ? 250 : st.shot.r; png.data[i * 4 + 1] = bad ? 20 : st.shot.g; png.data[i * 4 + 2] = bad ? 20 : st.shot.b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}
function engine(method: string, p: any): any {
  switch (method) {
    case "get_editor_camera": return { position: [1, 2, 3], target: [1, 2, 0], mode: st.mode };
    case "set_editor_camera": st.log.push(p.release ? "release" : `cam:${p.position}>${p.target}`); return { ok: true };
    case "screenshot_final": {
      st.log.push(`shot:${p.deterministic}:${p.width}x${p.height}`);
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, makePng());
      return { path: p.path, width: st.shot.w, height: st.shot.h };
    }
    case "benchmark": st.log.push(`bench:${p.frames}`); return st.bench;
    case "get_mode": return { mode: st.mode };
    case "ping": return { currentScene: st.scene };
    default: throw new Error(`fake engine: ${method}`);
  }
}
const call = async (m: string, p: Record<string, unknown>) => engine(m, p);

const CAM = { position: [0, 3, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number] };
function makeProject(label: string, extra: Partial<OracleManifest> = {}): { dir: string; view: OracleView } {
  const dir = mk(label);
  const view: OracleView = { name: "hall", scene: "scenes/default.json", camera: CAM, width: 64, height: 48 };
  writeManifest(dir, { ...emptyManifest(), views: [view], ...extra });
  return { dir, view };
}
const codes = (r: { items: { code: string }[] }) => r.items.map((i) => i.code);
const writable = (p: string) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };

console.log("[1] 純ロジック");
{
  check("sceneMatches: 未指定は常に一致 / 区切りと大文字小文字は無視 / 違えば不一致",
    sceneMatches(undefined, "a.json") && sceneMatches("Scenes\\A.json", "scenes/a.json") && !sceneMatches("a.json", "b.json") && !sceneMatches("a.json", null));
  check("validateManifest: 正常は空 / 名前や camera の不正を名指し",
    validateManifest(emptyManifest()).length === 0 && validateManifest({ version: 1, views: [{ name: "a b" }] }).length === 1 && validateManifest({ version: 1, views: [{ name: "ab", camera: {} }] }).length === 1);

  const { dir, view } = makeProject("p1");
  st.log.length = 0;
  const cap = await captureView(call, view, goldenPath(dir, "hall"));
  check("captureView: カメラを置く → 決定論で撮る → 元のカメラへ戻す(この順)",
    JSON.stringify(st.log) === JSON.stringify([`cam:${CAM.position}>${CAM.target}`, "shot:true:64x48", "cam:1,2,3>1,2,0"]), st.log);
  check("captureView: 金画像ができて大きさが返る", fs.existsSync(goldenPath(dir, "hall")) && cap.width === 64 && cap.height === 48);

  const before = verifyLedger(dir);
  check("封印前: sealed:false", before.sealed === false);
  const sealed = writeLedger(dir);
  check("writeLedger: 2 ファイル(oracles.json + 金画像)を封印", sealed.files === 2, sealed);
  const lp = ledgerPath(dir);
  const ledger = JSON.parse(fs.readFileSync(lp, "utf8"));
  check("台帳はプロジェクトの外(DX12_ORACLE_LEDGER_DIR)・キーは .dx12 からの相対パス・sha256",
    !lp.startsWith(dir) && lp.startsWith(process.env.DX12_ORACLE_LEDGER_DIR!) && Object.keys(ledger.files).sort().join() === "oracles/oracles.json,oracles/views/hall.png"
    && /^[0-9a-f]{64}$/.test(ledger.files["oracles/views/hall.png"]), ledger);
  check("封印したファイルは読み取り専用", !writable(goldenPath(dir, "hall")) && !writable(manifestPath(dir)));
  const ok = verifyLedger(dir);
  check("verify: 改ざん無しなら changed/missing/extra が空", ok.sealed && !ok.changed.length && !ok.missing.length && !ok.extra.length, ok);

  // 改ざん: 金画像を別の絵に差し替える(AI がやりそうなこと)
  fs.chmodSync(goldenPath(dir, "hall"), 0o666);
  const orig = fs.readFileSync(goldenPath(dir, "hall"));
  st.shot.r = 200; fs.writeFileSync(goldenPath(dir, "hall"), makePng()); st.shot.r = 40;
  const t1 = verifyLedger(dir);
  check("verify: 金画像を書き換えると changed に出る", t1.changed.join() === "oracles/views/hall.png", t1);
  fs.writeFileSync(goldenPath(dir, "hall"), orig);
  check("verify: 元に戻せば改ざん無し", verifyLedger(dir).changed.length === 0);
  fs.writeFileSync(path.join(path.dirname(goldenPath(dir, "hall")), "evil.png"), orig);
  check("verify: 封印後に増えた金画像は extra", verifyLedger(dir).extra.join() === "oracles/views/evil.png");
  fs.rmSync(path.join(path.dirname(goldenPath(dir, "hall")), "evil.png"));
  fs.rmSync(goldenPath(dir, "hall"));
  check("verify: 金画像を消すと missing", verifyLedger(dir).missing.join() === "oracles/views/hall.png");

  // compareView / runPerf の単体
  fs.writeFileSync(goldenPath(dir, "hall"), orig);
  st.shot.badPixels = 0; fs.mkdirSync(path.join(dir, "t"), { recursive: true });
  fs.writeFileSync(path.join(dir, "t", "cur.png"), makePng());
  const same = compareView(goldenPath(dir, "hall"), path.join(dir, "t", "cur.png"), path.join(dir, "t", "d.png"), {});
  check("compareView: 同じ絵は ok・差分画像を書かない", same.ok && same.reason === undefined && (same as any).diffPct === 0 && !fs.existsSync(path.join(dir, "t", "d.png")), same);
  st.shot.badPixels = 600;
  fs.writeFileSync(path.join(dir, "t", "cur.png"), makePng());
  const diff = compareView(goldenPath(dir, "hall"), path.join(dir, "t", "cur.png"), path.join(dir, "t", "d.png"), {});
  check("compareView: 600/3072 画素が違えば約 19.5% で不合格・並べ画像を書く", !diff.ok && Math.abs((diff as any).diffPct - 19.53) < 0.1 && fs.existsSync(path.join(dir, "t", "d.png")), diff);
  const loose = compareView(goldenPath(dir, "hall"), path.join(dir, "t", "cur.png"), path.join(dir, "t", "d2.png"), { maxDiffPct: 25 });
  check("compareView: maxDiffPct を広げれば合格", loose.ok, loose);
  st.shot.badPixels = 0;

  const perfOk = await runPerf(call, { name: "p", max: { frameMsP95: 16.6, drawCalls: 1000 }, frames: 10 });
  check("runPerf: 予算内は over 空・frames は最小 30 に切り上げ", perfOk.over.length === 0 && perfOk.actual.frameMsP95 === 10 && st.log.at(-1) === "bench:30", perfOk);
  const perfBad = await runPerf(call, { name: "p", max: { frameMsP95: 5, gpuMsTotal: 4 } });
  check("runPerf: p95 が予算超過だけを列挙", perfBad.over.length === 1 && perfBad.over[0].key === "frameMsP95" && perfBad.over[0].actual === 10, perfBad);
  st.bench = { frameMs: { avg: 8, p95: 10 } };
  const perfNone = await runPerf(call, { name: "p", max: { gpuMsTotal: 4 } });
  check("runPerf: 測れなかった予算は通ったことにしない(actual:null)", perfNone.over.length === 1 && perfNone.over[0].actual === null, perfNone);
  st.bench = { frameMs: { avg: 8, p95: 10 }, drawCalls: 500, gpuPassMs: { total: 4 } };
}

console.log("[2] ゲートの検査(collectOracleItems)");
{
  // 正解が無いプロジェクトは skipped
  const empty = mk("empty");
  const none = await collectOracleItems(call, empty, "Editor");
  check("oracles.json が無ければ skipped(失敗にしない)", !!none.skipped && none.items.length === 0, none);

  // 未封印
  const { dir, view } = makeProject("p2", { perf: [{ name: "perf1", scene: "scenes/default.json", max: { frameMsP95: 16.6 } }] });
  await captureView(call, view, goldenPath(dir, "hall"));
  const u = await collectOracleItems(call, dir, "Editor");
  const un = u.items.find((i) => i.code === "ORACLE_UNSEALED");
  check("未封印: ORACLE_UNSEALED は warning・blocking でない・封印の手順を fix に出す",
    !!un && un.level === "warning" && un.blocking === false && /confirm:true/.test(un.fix ?? "") && !u.items.some((i) => i.blocking), u.items);

  writeLedger(dir);
  const good = await collectOracleItems(call, dir, "Editor");
  check("封印後・絵も予算も合っていれば指摘ゼロ", good.items.length === 0 && (good.summary as any).sealed === true, good);

  // 金画像との差
  st.shot.badPixels = 6;   // 6/3072 = 0.195% < 0.5%
  const within = await collectOracleItems(call, dir, "Editor");
  check("許容内の差(0.195% <= 0.5%)は通る", within.items.length === 0, within.items);
  st.shot.badPixels = 600;
  const over = await collectOracleItems(call, dir, "Editor");
  const vd = over.items.find((i) => i.code === "ORACLE_VIEW_DIFF");
  check("許容外の差: ORACLE_VIEW_DIFF は blocking・差分 % と差分画像のパスを出す",
    !!vd && vd.blocking && vd.level === "error" && /19\.5/.test(vd.text) && /hall\.diff\.png/.test(vd.text) && fs.existsSync(path.join(dir, ".dx12", "oracles", "out", "hall.diff.png")), vd);
  st.shot.badPixels = 0;
  st.shot.w = 80;
  const sz = await collectOracleItems(call, dir, "Editor");
  check("大きさが違えば ORACLE_VIEW_SIZE(blocking)", sz.items.some((i) => i.code === "ORACLE_VIEW_SIZE" && i.blocking), sz.items);
  st.shot.w = 64;

  // 性能予算
  st.bench = { frameMs: { avg: 12, p95: 30 }, drawCalls: 500, gpuPassMs: { total: 4 } };
  const slow = await collectOracleItems(call, dir, "Editor");
  const po = slow.items.find((i) => i.code === "ORACLE_PERF_OVER");
  check("性能予算超過: ORACLE_PERF_OVER は blocking・実測と上限を出す", !!po && po.blocking && /frameMsP95 30 > 16\.6/.test(po.text), slow.items);
  st.bench = { frameMs: { avg: 8, p95: 10 }, drawCalls: 500, gpuPassMs: { total: 4 } };

  // シーン違いは飛ばす(失敗にしない)
  st.scene = "scenes/other.json";
  st.shot.badPixels = 600;
  const other = await collectOracleItems(call, dir, "Editor");
  check("開いているシーンが違う view/perf は summary.skipped に挙げて失敗にしない", other.items.length === 0 && (other.summary as any).skipped?.length === 2, other);
  st.scene = "scenes/default.json";

  // Playing 中は views/perf を飛ばすが、台帳の照合はする
  const play = await collectOracleItems(call, dir, "Playing");
  check("Playing 中は絵も予算も測らない(差があっても指摘なし)", play.items.length === 0 && Array.isArray((play.summary as any).skipped), play);
  st.shot.badPixels = 0;

  // 改ざん: 金画像を「今の絵」で上書きして差を消す(AI の不正)
  st.shot.badPixels = 600;
  fs.chmodSync(goldenPath(dir, "hall"), 0o666);
  fs.writeFileSync(goldenPath(dir, "hall"), makePng());
  const tamper = await collectOracleItems(call, dir, "Editor");
  const tm = tamper.items.find((i) => i.code === "ORACLE_TAMPERED");
  check("金画像を今の絵で上書きして差を消しても ORACLE_TAMPERED(blocking)・ファイル名と『AI が書き換えてはいけない』を出す",
    !!tm && tm.blocking && tm.level === "error" && /views\/hall\.png/.test(tm.text) && /AI が書き換えてはいけない/.test(tm.fix ?? ""), tamper.items);
  check("…差は消えているので VIEW_DIFF は出ない(改ざんだけが検出の頼り)", !tamper.items.some((i) => i.code === "ORACLE_VIEW_DIFF"));
  st.shot.badPixels = 0;
  // 予算の改ざん(manifest)
  const m = readManifest(dir)!;
  m.perf[0].max.frameMsP95 = 999;
  writeManifest(dir, m);
  const mt = await collectOracleItems(call, dir, "Editor");
  check("予算(oracles.json)を緩めても ORACLE_TAMPERED", mt.items.some((i) => i.code === "ORACLE_TAMPERED" && /oracles\.json/.test(i.text)), mt.items);
  check("writeManifest は封印済み(読み取り専用)のファイルにも書ける", readManifest(dir)!.perf[0].max.frameMsP95 === 999);
}

console.log("[3] ツール dx12_oracle とゲート(stdio)");
const project = mk("project");
const M = (name: string, effect: string) => ({ name, category: "test", summary: name, effect, mode: "any", timeoutMs: 8000, params: [], source: "meta" }) as any;
const mock = await startMockEngine({
  safety: true,
  pingExtra: () => ({ baseDir: project, currentScene: st.scene }),
  methods: ["get_editor_camera", "set_editor_camera", "screenshot_final", "benchmark", "get_mode"]
    .map((n) => ({ ...M(n, n === "get_editor_camera" || n === "get_mode" ? "read" : "runtime"), handler: (p: any) => engine(n, p ?? {}) })),
});
const clients: McpClient[] = [];
function server(surface: "full" | "core"): McpClient {
  const c = startMcp({ DX12_MCP_SURFACE: surface, DX12_MCP_PORT: String(mock.port), DX12_MCP_PORT_FILE: path.join(mk("pf"), "none.port"), DX12_JOBS_DIR: mk("jobs"), DX12_PROJECT_DIR: project });
  clients.push(c);
  return c;
}
const full = server("full");
await full.initialize();
{
  const names = (await full.rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("full 面: tools/list に dx12_oracle が出る", names.includes("dx12_oracle"));
  const s0 = await full.call("dx12_oracle", { op: "status" });
  check("status: 正解が無ければ exists:false・未封印・エンジン不要", s0.exists === false && s0.ledger?.sealed === false, s0);

  const a1 = await full.call("dx12_oracle", { op: "add_view", name: "hall", width: 64, height: 48 });
  check("add_view: camera 省略 = 今のエディタカメラ・scene = 今のシーン・金画像を撮る",
    JSON.stringify(a1.added?.camera) === JSON.stringify({ position: [1, 2, 3], target: [1, 2, 0] }) && a1.added?.scene === "scenes/default.json" && fs.existsSync(goldenPath(project, "hall")), a1);
  check("add_view: 封印が壊れる旨を note に書く", /封印/.test(a1.note ?? ""), a1.note);
  const a2 = await full.call("dx12_oracle", { op: "add_perf", name: "main", max: { frameMsP95: 16.6 } });
  check("add_perf: scene を今のシーンに・予算を記録", a2.added?.max?.frameMsP95 === 16.6 && a2.added?.scene === "scenes/default.json", a2);
  const a3 = await full.call("dx12_oracle", { op: "add_perf", name: "x" });
  check("add_perf: max が無ければエラー", a3.ok === false || !!a3.error_code || /max/.test(JSON.stringify(a3)), a3);

  const g0 = await full.call("dx12_oracle", { op: "seal" });
  check("seal を直接呼ぶと E_GUARDED(承認が無い)・fix は dx12_call {confirm:true}・封印されない",
    g0.error_code === "E_GUARDED" && /confirm/.test(JSON.stringify(g0.fix)) && /人/.test(g0.error ?? "") && !fs.existsSync(ledgerPath(project)), g0);
  const g1 = await full.call("dx12_call", { name: "dx12_oracle", args: { op: "seal" } });
  check("dx12_call で confirm 無しの seal も E_GUARDED", g1.error_code === "E_GUARDED" && !fs.existsSync(ledgerPath(project)), g1);
  const g2 = await full.call("dx12_call", { name: "dx12_oracle", args: { op: "status" } });
  check("dx12_call で status は confirm 不要", g2.ok === true && g2.result?.exists === true || g2.exists === true, g2);

  const gate0 = await full.call("dx12_quality_gate", { checks: ["scene"], judge: false });
  check("封印前のゲート: ORACLE_UNSEALED の警告だけで pass", gate0.pass === true && gate0.suggestions.some((x: any) => /ORACLE_UNSEALED/.test(x.text)) && JSON.stringify(gate0).includes("ORACLE_UNSEALED"), gate0);

  const g3 = await full.call("dx12_call", { name: "dx12_oracle", args: { op: "seal" }, confirm: true });
  const sealRes = g3.result ?? g3;
  check("dx12_call {confirm:true} なら封印される(files:2)", g3.ok === true && sealRes.files === 2 && fs.existsSync(ledgerPath(project)), g3);
  const s1 = await full.call("dx12_oracle", { op: "status" });
  check("status: 封印済み・改ざん無し", s1.ledger?.sealed === true && s1.ledger.changed.length === 0 && s1.views[0]?.golden === true, s1);

  const gate1 = await full.call("dx12_quality_gate", { checks: ["scene"], judge: false });
  check("封印後のゲートは pass", gate1.pass === true && gate1.blocking.length === 0, gate1);

  const chk = await full.call("dx12_oracle", { op: "check" });
  check("check: pass:true・items 空", chk.pass === true && chk.items.length === 0, chk);

  // 絵が崩れた
  st.shot.badPixels = 800;
  const gate2 = await full.call("dx12_quality_gate", { checks: ["scene"], judge: false });
  check("絵が崩れるとゲートが落ちる(ORACLE_VIEW_DIFF)", gate2.pass === false && gate2.blocking.some((b: any) => b.code === "ORACLE_VIEW_DIFF"), gate2);
  // AI が金画像を撮り直して通そうとする
  const cap = await full.call("dx12_oracle", { op: "capture", name: "hall" });
  check("capture は撮り直せるが、封印が壊れる旨を note に書く", Array.isArray(cap.captured) && /封印/.test(cap.note ?? ""), cap);
  const gate3 = await full.call("dx12_quality_gate", { checks: ["scene"], judge: false });
  check("撮り直して差を消しても、ゲートは ORACLE_TAMPERED で落ちる", gate3.pass === false && gate3.blocking.some((b: any) => b.code === "ORACLE_TAMPERED"), gate3);
  st.shot.badPixels = 0;

  // 封印したプレイテストは playtests を渡さなくてもゲートが走らせる
  const m = readManifest(project)!;
  m.playtests = ["pt1"];
  writeManifest(project, m);
  fs.mkdirSync(path.join(project, ".dx12", "playtests"), { recursive: true });
  fs.writeFileSync(path.join(project, ".dx12", "playtests", "pt1.json"), JSON.stringify({ broken: true }));
  const gate4 = await full.call("dx12_quality_gate", { judge: false, screenshot: false });
  check("マニフェストのプレイテストは playtests 未指定でも検査される(playtests 検査が走る)",
    gate4.checks?.some((c: any) => c.id === "playtests") && JSON.stringify(gate4).includes("PLAYTEST_INVALID"), gate4.checks?.map((c: any) => c.id));
  const gate5 = await full.call("dx12_quality_gate", { judge: false, screenshot: false, playtests: false });
  // ★封印したプレイテストは playtests:false でも外せない(外せると AI が都合の悪い正解を避けられる)。
  check("playtests:false と明示しても、封印したプレイテストは走る", gate5.checks?.some((c: any) => c.id === "playtests") && JSON.stringify(gate5).includes("PLAYTEST_INVALID"), gate5.checks?.map((c: any) => c.id));

  const core = server("core");
  await core.initialize();
  const cnames = (await core.rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("core 面: tools/list には出ない(dx12_call で使う長尾)", !cnames.includes("dx12_oracle"));
  const cg = await core.call("dx12_call", { name: "dx12_oracle", args: { op: "seal" } });
  check("core 面: dx12_call 経由の seal も承認なしでは通らない", cg.ok !== true && !!cg.error_code, cg);
}

for (const c of clients) { try { c.proc.stdin!.end(); } catch { /* 無視 */ } }
await sleep(300);
for (const c of clients) { try { c.close(); } catch { /* 無視 */ } }
await mock.close();
for (const d of dirs) { try { for (const f of fs.readdirSync(d, { recursive: true }) as string[]) { try { fs.chmodSync(path.join(d, f), 0o666); } catch { /* 無視 */ } } } catch { /* 無視 */ } rmTree(d); }
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: oracles テスト ${total} 項目すべて通過`);
process.exit(0);
