// エラー構造化(M2)のテスト。偽エンジンだけを使う(実エンジン不要)。
//   [1] エラー再現 47 ケース(eval/errors.cases.json): 期待コード・空でない fix・タイポ系の didYouMean[0] が正解
//   [2] 自己修復: 壊れた呼び出し 20 件に fix[0] / didYouMean[0] を機械的に適用して再送 → 80% 以上成功
//   [3] 診断(doctor): ポート閉鎖 / 応答なし / 別ポート / 古いポートファイル
//   [4] タイムアウト後の遅延結果 / 再接続 / 再接続後の警告
//   [5] 語調 lint: メッセージ・ガイド・新規ソースに方言/命令口調が無い
// 実行: node errors.test.ts

import "./testEnv.ts";   // フリートのレジストリを一時フォルダへ隔離(実ユーザーの %LOCALAPPDATA% を触らない)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startMockEngine } from "./mockEngine.ts";
import { DIALECT_PATTERN, ERROR_CODES, isErrorCodeName } from "./errors.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}
const parse = (r: any) => JSON.parse(r.content[r.content.length - 1].text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stale = (p: any) => { const e: any = new Error("stale scene: expected generation 2, current 3"); e.code = 4; e.fields = { error_name: "E_STALE_SCENE", error_hint: "list_entities を引き直して entityId を取り直す" }; throw e; };
const boom = () => { const e: any = new Error("internal: something broke"); e.code = 7; throw e; };
const nodxr = () => { const e: any = new Error("device does not support inline raytracing"); e.code = 10; e.fields = { error_name: "E_UNSUPPORTED" }; throw e; };
const mock = await startMockEngine({
  methods: [
    { name: "mock_spin", category: "test", summary: "テスト用: 回転", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [{ name: "name", type: "string", required: true }, { name: "speed", type: "number", min: 0, max: 10 }], source: "meta", handler: (p: any) => ({ spinning: p.name }) },
    { name: "mock_stale", category: "test", summary: "世代が古い", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: stale },
    { name: "mock_boom", category: "test", summary: "内部エラー", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: boom },
    { name: "mock_nodxr", category: "test", summary: "非対応", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: nodxr },
    { name: "mock_slow", category: "test", summary: "遅い", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: () => ({ slow: true }) },
    { name: "mock_gone", category: "test", summary: "消える method", effect: "write_scene", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: () => ({ here: true }) },
  ] as any,
});
process.env.DX12_MCP_PORT = String(mock.port);
process.env.DX12_MCP_CONNECT_BACKOFF_MS = "0";   // 接続失敗の再試行待ちを省く(テストを速くする)
const portFile = path.join(os.tmpdir(), `dx12_mcp_test_${process.pid}.port`);
process.env.DX12_MCP_PORT_FILE = portFile;       // 実エンジンのポートファイルは触らない
await import("./toolset/all.ts");
const { shell } = await import("./toolset/shell.ts");
const { engine } = await import("./toolset/core.ts");

type Env = "normal" | "playing" | "vinput-off" | "old" | "gone" | "gone-old" | "down";
function applyEnv(env: Env) {
  mock.state.mode = env === "playing" ? "Playing" : "Editor";
  mock.state.virtualInput = env !== "vinput-off";
  mock.state.structuredErrors = env !== "old" && env !== "gone-old";
  mock.state.oldUnknownMethod = env === "gone-old";
  mock.state.hang.delete("mock_slow");
  if (env === "normal" || env === "old") { mock.addMethod({ name: "mock_gone", category: "test", summary: "消える method", effect: "write_scene", mode: "any", params: [], source: "meta", handler: () => ({}) } as any); }
}
const cases: any = JSON.parse(fs.readFileSync(path.join(here, "eval", "errors.cases.json"), "utf8"));

const allBodies: any[] = [];

console.log("[1] エラー再現ケース");
await shell.refresh(true);
const downCases: any[] = [];
for (const c of cases.cases) {
  if (c.env === "down") { downCases.push(c); continue; }
  applyEnv(c.env);
  if (c.env === "gone" || c.env === "gone-old") {
    // TS のカタログに mock_gone が載っている状態でエンジンから消す(エンジンの未知 method 経路を通す)
    mock.addMethod({ name: "mock_gone", category: "test", summary: "消える method", effect: "write_scene", mode: "any", params: [], source: "meta", handler: () => ({}) } as any);
    await shell.refresh(true);
    mock.removeMethod("mock_gone");
  }
  if (c.call.name === "mock_slow") mock.state.hang.add("mock_slow");
  const res = await shell.call(c.call);
  const b = parse(res);
  allBodies.push(b);
  const e = c.expect;
  const problems: string[] = [];
  if (!(res as any).isError || b.ok !== false) problems.push("isError/ok:false でない");
  if (b.error_code !== e.code) problems.push(`error_code=${b.error_code} (期待 ${e.code})`);
  if (!isErrorCodeName(b.error_code)) problems.push("表に無いコード");
  if (typeof b.error !== "string" || !b.error) problems.push("error 文字列が空");
  if (!Array.isArray(b.fix) || b.fix.length === 0) problems.push("fix が空");
  if (e.didYouMean0 && b.didYouMean?.[0] !== e.didYouMean0) problems.push(`didYouMean[0]=${b.didYouMean?.[0]} (期待 ${e.didYouMean0})`);
  if (e.fixTool && !b.fix?.some((f: any) => f.tool === e.fixTool)) problems.push(`fix に ${e.fixTool} が無い: ${JSON.stringify(b.fix?.map((f: any) => f.tool))}`);
  if (e.fixCommand && !b.fix?.some((f: any) => String(f.command ?? "").includes(e.fixCommand))) problems.push(`fix に command(${e.fixCommand}) が無い`);
  if (e.fixArgs) for (const [k, v] of Object.entries(e.fixArgs)) if (JSON.stringify(b.fix?.[0]?.args?.[k]) !== JSON.stringify(v)) problems.push(`fix[0].args.${k}=${JSON.stringify(b.fix?.[0]?.args?.[k])} (期待 ${JSON.stringify(v)})`);
  if (e.validValues) for (const v of e.validValues) if (!b.validValues?.includes(v)) problems.push(`validValues に ${v} が無い`);
  if (e.retryable !== undefined && b.retryable !== e.retryable) problems.push(`retryable=${b.retryable}`);
  check(`${c.id}: ${e.code}`, problems.length === 0, problems.join(" / ") + " :: " + JSON.stringify(b).slice(0, 300));
  applyEnv("normal");
}

console.log("[2] 自己修復(fix[0] / didYouMean[0] を機械的に適用して再送)");
{
  const INFO_TOOLS = new Set(["dx12_tool_describe", "dx12_tool_search", "dx12_doctor", "dx12_ping", "dx12_get_log"]);
  let okCount = 0;
  const detail: string[] = [];
  for (const rc of cases.repair.calls) {
    applyEnv(rc.env);
    const first = await shell.call(rc.call);
    let success = !(first as any).isError;
    let how = success ? "そのまま成功" : "";
    if (!success) {
      const b = parse(first);
      const usable = (b.fix ?? []).filter((f: any) => f.tool && !INFO_TOOLS.has(f.tool));
      if (usable.length) {
        const f = usable[0];
        if (f.thenRetry) {
          const pre = await shell.call({ name: f.tool, args: f.args ?? {} });
          const again = await shell.call(rc.call);
          success = !(pre as any).isError && !(again as any).isError; how = `fix(${f.tool}) → 再送`;
        } else {
          const again = await shell.call({ name: f.tool, args: f.args ?? rc.call.args });
          success = !(again as any).isError; how = `fix[0](${f.tool})`;
        }
      } else if (b.didYouMean?.[0] && b.error_code === "E_UNKNOWN_TOOL") {
        const again = await shell.call({ name: b.didYouMean[0], args: rc.call.args });
        success = !(again as any).isError; how = `didYouMean[0](${b.didYouMean[0]})`;
      }
    }
    if (success) okCount++;
    detail.push(`${rc.id}:${success ? "OK" : "NG"}(${how || "修復手段なし"})`);
    applyEnv("normal");
  }
  const rate = okCount / cases.repair.calls.length;
  console.log(`      ${detail.join(" ")}`);
  console.log(`      自己修復率: ${okCount}/${cases.repair.calls.length} = ${(rate * 100).toFixed(0)}%`);
  check(`壊れた呼び出し ${cases.repair.calls.length} 件の自己修復率 >= 80%(${(rate * 100).toFixed(0)}%)`, rate >= 0.8, detail.filter((d) => d.includes(":NG")));
}

console.log("[3] タイムアウト後の遅延結果 / 再接続");
{
  mock.state.delayMs["mock_slow"] = 700;
  const t = await shell.call({ name: "mock_slow", args: {}, timeoutMs: 250 });
  const tb = parse(t);
  check("timeout: E_ENGINE_TIMEOUT(処理中の可能性・確認手順 fix・retryable)", tb.error_code === "E_ENGINE_TIMEOUT" && tb.retryable === true && /処理中/.test(tb.cause ?? tb.error) && tb.fix?.some((f: any) => f.tool === "dx12_ping") && typeof tb.details?.engineResponsive === "boolean", tb);
  await sleep(900);   // エンジンは処理を続けて遅れて返す
  const next = parse(await shell.call({ name: "dx12_ping", args: {} }));
  check("遅れて届いた結果は捨てずに次の dx12_call の meta.lateResults に出る", next.ok === true && next.meta?.lateResults?.[0]?.method === "mock_slow" && next.meta.lateResults[0].ok === true, next.meta);
  mock.state.delayMs["mock_slow"] = 0;
  const epoch = engine.getConnectEpoch();
  mock.dropConnections();
  await sleep(100);
  const after = parse(await shell.call({ name: "dx12_ping", args: {} }));
  check("切断後の次の呼び出しで自動的に再接続する", after.ok === true && engine.getConnectEpoch() === epoch + 1, { epoch, now: engine.getConnectEpoch() });
  check("再接続したことを meta.warnings で知らせる(entityId の失効)", (after.meta?.warnings ?? []).some((w: string) => /再接続/.test(w)), after.meta);
}

console.log("[4] 診断(doctor)");
{
  // 別ポートでエンジンが待ち受けている(接続先ポートが違う)状況を、ポート探索の差し替えで再現する
  const { runDoctor } = await import("./doctor.ts");
  const fakeDeps = (extra: any = {}) => ({
    engine, toolset: "full", tsVersion: "test", toolCounts: { legacy: 220, shell: 5, total: 225 },
    manifest: { source: "live", hash: mock.manifestHash(), snapshotHash: "aaaa", count: 10, lastError: null },
    refresh: async () => ({}), recentErrors: () => [], lateResults: () => [],
    processLister: () => ({ running: true, pids: [1234] }), logTail: () => null, ...extra,
  });
  const ok = await runDoctor(fakeDeps(), {});
  check("doctor: 正常 → ok:true・issues に error なし", ok.ok === true && !(ok.issues as any[]).some((i) => i.severity === "error"), ok.issues);
  check("doctor: マニフェストのスナップショットが古い場合は info で知らせる", (ok.issues as any[]).some((i) => i.code === "MANIFEST_SNAPSHOT_STALE"));
}

// ── エンジンを落とす(以降は接続できない状態) ──────────────────────────
await mock.close();
console.log("[5] エンジン停止時");
for (const c of downCases) {
  const res = await shell.call(c.call);
  const b = parse(res);
  allBodies.push(b);
  const e = c.expect;
  const problems: string[] = [];
  if (b.error_code !== e.code) problems.push(`error_code=${b.error_code}`);
  if (!b.fix?.length) problems.push("fix が空");
  if (e.fixCommand && !b.fix?.some((f: any) => String(f.command ?? "").includes(e.fixCommand))) problems.push(`fix に command(${e.fixCommand}) が無い: ${JSON.stringify(b.fix)}`);
  if (e.fixTool && !b.fix?.some((f: any) => f.tool === e.fixTool)) problems.push(`fix に ${e.fixTool} が無い`);
  if (e.retryable !== undefined && b.retryable !== e.retryable) problems.push("retryable");
  check(`${c.id}: ${e.code}`, problems.length === 0, problems.join(" / ") + " :: " + JSON.stringify(b).slice(0, 300));
}
{
  // 実機のエンジン(8850 など)が動いていても結果が変わらないよう、ポート走査・プロセス一覧・ログを差し替える
  (shell.deps as any).doctorHooks = { portProbe: async () => "refused", processLister: () => ({ running: false, pids: [] }), logTail: () => null };
  fs.writeFileSync(portFile, "59998");
  const d: any = parse(await shell.doctor({}));
  const codes = d.issues.map((i: any) => i.code);
  check("doctor(停止中): ok:false・E_ENGINE_UNREACHABLE・原因の要約", d.ok === false && codes.includes("E_ENGINE_UNREACHABLE") && /応答が無/.test(d.summary), d.summary);
  const un = d.issues.find((i: any) => i.code === "E_ENGINE_UNREACHABLE");
  check("doctor(停止中): fix に --background の起動コマンド(Start-Process)", un.fix.some((f: any) => /Start-Process/.test(f.command ?? "") && /--background/.test(f.command)), un.fix);
  check("doctor(停止中): 古いポートファイル(閉じたポートを指す)を STALE_PORT_FILE で知らせる", codes.includes("STALE_PORT_FILE"), codes);
  check("doctor(停止中): 実マウス/前面化を伴う起動方法を案内しない", !JSON.stringify(d).match(/SetForegroundWindow|SendInput|mouse_event|-WindowStyle\s+Normal|Maximized/), null);
  fs.rmSync(portFile, { force: true });
  (shell.deps as any).doctorHooks = { portProbe: async (p: number) => (p === 8851 ? "open" : "refused"), processLister: () => ({ running: false, pids: [] }), logTail: () => null };
  const mm2: any = parse(await shell.doctor({}));
  check("doctor(停止中): 8850 番台(--mcp-port)で待ち受けているエンジンを見つけて DX12_MCP_PORT を案内", mm2.issues.find((i: any) => i.code === "PORT_MISMATCH")?.fix?.some((f: any) => /DX12_MCP_PORT = '8851'/.test(f.command ?? "")), mm2.issues);
  (shell.deps as any).doctorHooks = { portProbe: async () => "refused", processLister: () => ({ running: true, pids: [4321] }), logTail: () => ({ path: "x.log", tail: ["last log line"] }) };
  const running: any = parse(await shell.doctor({}));
  check("doctor(停止中): プロセスはあるがポートに繋がらない場合の文言とログ末尾", /pid 4321/.test(running.summary) && running.log?.tail?.[0] === "last log line", running.summary);
  (shell.deps as any).doctorHooks = { portProbe: async () => "refused", processLister: () => ({ running: false, pids: [] }), logTail: () => null };
  const dd: any = parse(await shell.doctor({ deep: true }));
  check("doctor(deep): 候補ポートを広く走査する", dd.ports.candidates.length > d.ports.candidates.length, [dd.ports.candidates.length, d.ports.candidates.length]);
  (shell.deps as any).doctorHooks = undefined;
}

console.log("[6] 語調 lint");
{
  const texts: string[] = [];
  for (const b of allBodies) texts.push(JSON.stringify(b));
  const hits = texts.filter((t) => DIALECT_PATTERN.test(t));
  check(`全エラー本文(${allBodies.length} 件)に方言・命令口調が無い`, hits.length === 0, hits.slice(0, 2));
  const files = ["errors.ts", "structure.ts", "validate.ts", "shellRuntime.ts", "doctor.ts", "engineClient.ts", "manifest.ts", "catalog.ts", "search.ts", "instructions.ts", "paramGuard.ts", "toolset/shell.ts", "toolset/core.ts"];
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, f), "utf8").split("\n");
    src.forEach((l, i) => { if (f !== "errors.ts" && DIALECT_PATTERN.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`); });
  }
  for (const g of fs.readdirSync(path.join(here, "guides"))) {
    fs.readFileSync(path.join(here, "guides", g), "utf8").split("\n").forEach((l, i) => { if (DIALECT_PATTERN.test(l)) bad.push(`guides/${g}:${i + 1}`); });
  }
  check("新規/変更ソースとガイドに方言・命令口調が無い", bad.length === 0, bad.slice(0, 5));
  const guide = fs.readFileSync(path.join(here, "guides", "errors.md"), "utf8");
  const missing = Object.keys(ERROR_CODES).filter((c) => !guide.includes(c));
  check("guides/errors.md がコード表の全コードを載せている", missing.length === 0, missing);
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: エラー構造化テスト ${total} 項目すべて通過`);
process.exit(0);
