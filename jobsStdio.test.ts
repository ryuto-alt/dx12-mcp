// ジョブ API の統合試験(MCP サーバを別プロセスで起動し、stdio の MCP で叩く。偽エンジンを使うのでエンジン不要)。
//   [1] core 面の tools/list(ジョブ 3 本が Core・list / result / logs は長尾)・instructions・doctor の jobs
//   [2] build ジョブ: start が即座に返る → status の long-poll → 進捗通知(notifications/progress)→ result / logs(dx12_call 経由)
//   [3] 引数の事前検証(打ち間違いは E_UNKNOWN_PARAM + そのまま撃ち直せる fix)・冪等キー・external の guarded(dx12_call_guarded 経由でだけ)
//   [4] キャンセル(プロセスツリー)・MCP サーバを終了 → 再起動しても status が引ける(runner は走り続ける)
//   [5] エンジン系: bench(中央値・キャンセルで cancel が飛ぶ)・screenshot_batch(マニフェスト・コンタクトシート・別倍率は専用エンジンを 1 台ずつ起動して止める)・playtest
//   [6] ui_tests: --ui-tests-skip 未対応の exe では E_UNSUPPORTED(build_game を前面起動させない)
// 実行: node jobsStdio.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { startMockEngine } from "./mockEngine.ts";
import { tmpDir, makeFakeBuild, fleetEnv, waitFor, rmTree, killTracked, track } from "./fleetTestKit.ts";
import { pidAlive, killTreeSync } from "./fleet/proc.ts";
import { exeHasWideString } from "./jobs/kinds/process.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "jobs", "fakeProc.ts");
let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirs: string[] = [];
const clients: McpClient[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };
const jdir = mk("jobs-stdio");
const repo = mk("repo");
const fleetDir = mk("fleet");
const fakeBuild = makeFakeBuild(mk("build"));
const runnerPids = new Set<number>();
process.on("exit", () => { for (const p of runnerPids) { try { killTreeSync(p); } catch { /* 無視 */ } } });

const nodeArgs = (mode: string, more: string[] = []) => ["--disable-warning=ExperimentalWarning", FAKE, "--mode", mode, ...more];

// 偽エンジン(MCP サーバの従来の接続先 = DX12_MCP_PORT)
const projectDir = mk("project");
fs.mkdirSync(path.join(projectDir, ".dx12", "playtests"), { recursive: true });
let benchRuns = 0;
const mock = await startMockEngine({
  methods: [
    { name: "ping", category: "diag", summary: "ping", effect: "read", mode: "any", timeoutMs: 5000, params: [], source: "meta",
      handler: () => ({ pong: true, mode: "Editor", sceneGeneration: 1, currentScene: "scenes/main.json", sceneDirty: false, protocolVersion: 4, virtualInput: true, background: "offscreen", baseDir: projectDir, cwd: projectDir, dpiScale: 1, manifestHash: "mock", methodCount: 40 }) } as any,
    { name: "benchmark", category: "perf", summary: "bench", effect: "runtime", mode: "any", timeoutMs: 60000, params: [], source: "meta",
      handler: (p: any) => { benchRuns++; return { fps: 100 + benchRuns * 10, frameMs: { avg: 10 - benchRuns * 0.5, p95: 12 }, fps1PercentLow: 80, frames: p.frames, uncapped: p.uncap !== false }; } } as any,
    ...["set_editor_camera", "transaction_rollback", "transaction_commit", "screenshot_final", "imgui_screenshot", "screenshot"].map((name) => ({ name, category: "test", summary: name, effect: "write_setting", mode: "any", timeoutMs: 8000, params: [], source: "meta" }) as any),
    { name: "cancel", category: "diag", summary: "cancel", effect: "runtime", mode: "any", timeoutMs: 5000, params: [], source: "meta", handler: (p: any) => ({ cancelled: [p.target ?? "all"] }) } as any,
  ],
});

function server(extra: Record<string, string> = {}, surface = "core"): McpClient {
  const c = startMcp({
    ...fleetEnv(fleetDir, fakeBuild),
    DX12_MCP_SURFACE: surface, DX12_JOBS_DIR: jdir, DX12_JOBS_POLL_MS: "50", DX12_REPO_DIR: repo,
    DX12_JOBS_BUILD_CMD: JSON.stringify([process.execPath, ...nodeArgs("build", ["--steps", "12", "--delay", "120"])]),
    DX12_JOBS_CTEST_CMD: JSON.stringify([process.execPath, ...nodeArgs("ctest", ["--steps", "60", "--delay", "200"])]),
    DX12_MCP_PORT: String(mock.port), DX12_MCP_PORT_FILE: path.join(mk("pf"), "none.port"),
    ...extra,
  });
  clients.push(c);
  return c;
}
async function statusUntil(c: McpClient, id: string, pred: (s: any) => boolean, ms = 30000) {
  const t0 = Date.now();
  let s: any = null;
  while (Date.now() - t0 < ms) { s = await c.call("dx12_job_status", { id, waitSec: 2 }); if (pred(s)) return s; }
  return s;
}
const noteJob = (jobId: string) => {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(jdir, jobId, "state.json"), "utf8"));
    if (rec.runnerPid) runnerPids.add(rec.runnerPid);
    const live = JSON.parse(fs.readFileSync(path.join(jdir, jobId, "live.json"), "utf8"));
    if (live.childPid) runnerPids.add(live.childPid);
  } catch { /* まだ無い */ }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log("[1] core 面の tools/list・instructions・doctor");
const s1 = server();
{
  const init = await s1.initialize();
  const list = (await s1.rpc("tools/list")).result.tools;
  const names: string[] = list.map((t: any) => t.name);
  check("core 面は 40 本", list.length === 40, list.length);
  check("dx12_job_start / status / cancel が Core にある(list / result / logs は長尾)", ["dx12_job_start", "dx12_job_status", "dx12_job_cancel"].every((n) => names.includes(n)) && !["dx12_job_list", "dx12_job_result", "dx12_job_logs"].some((n) => names.includes(n)));
  const d = Object.fromEntries(list.map((t: any) => [t.name, t]));
  check("job_status は readOnly・job_cancel は destructive・job_start は guarded ではない", d.dx12_job_status.annotations.readOnlyHint === true && d.dx12_job_cancel.annotations.destructiveHint === true && !d.dx12_job_start._meta?.["anthropic/requiresUserInteraction"]);
  check("instructions にジョブの使い方が載る(2,048 字以内)", /dx12_job_start/.test(init.instructions) && /dx12_job_status/.test(init.instructions) && init.instructions.length <= 2048, init.instructions.length);
  const doc = await s1.call("dx12_doctor", {});
  check("dx12_doctor に jobs(enabled・limits)が載る", doc.jobs?.enabled === true && doc.jobs.limits?.maxRunning === 3, doc.jobs);
  const g = await s1.raw("dx12_guide", { topic: "jobs" });
  check("dx12_guide {topic:'jobs'} が本文を返す(6 KB 以内)", /^# /.test(g.content[0].text) && Buffer.byteLength(g.content[0].text) <= 6144 && /dx12_job_start/.test(g.content[0].text), Buffer.byteLength(g.content[0].text));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] build ジョブ: start → long-poll → 進捗通知 → result / logs");
{
  const t0 = Date.now();
  const started = await s1.call("dx12_job_start", { kind: "build", args: { target: "DX12Engine" } });
  const ms = Date.now() - t0;
  noteJob(started.id);
  check(`dx12_job_start は即座に返る(${ms} ms)・id・state・hint・next`, ms < 1500 && /^j-\d{8}-\d{6}-[0-9a-f]{4}$/.test(started.id) && ["queued", "running"].includes(started.state) && Array.isArray(started.next) && started.next[0].tool === "dx12_job_status", started);
  const before = s1.notifications.length;
  const t1 = Date.now();
  const raw = await s1.rpc("tools/call", { name: "dx12_job_status", arguments: { id: started.id, waitSec: 20 }, _meta: { progressToken: "tok-1" } }, 40000);
  const st = JSON.parse(raw.result.content[raw.result.content.length - 1].text);
  const prog = s1.notifications.slice(before).filter((n) => n.method === "notifications/progress" && n.params?.progressToken === "tok-1");
  check(`long-poll(waitSec)は終了まで待つ(${Date.now() - t1} ms)→ succeeded・exitCode 0・build の steps`, st.state === "succeeded" && st.exitCode === 0 && st.summary?.steps?.total === 12, st);
  const values = prog.map((n) => n.params.progress);
  check(`progressToken 付きの待ちに notifications/progress が ${prog.length} 通(≥ 3)・progress は厳密に増加・total=100・message あり`, prog.length >= 3 && values.every((v, i) => i === 0 || v > values[i - 1]) && prog.every((n) => n.params.total === 100 && typeof n.params.message === "string" && n.params.message.length > 0), { n: prog.length, values });
  check("進捗の最後は 100%", values[values.length - 1] === 100, values.slice(-3));
  // 長尾の 3 本は dx12_call 経由
  const lst = await s1.call("dx12_call", { name: "dx12_job_list", args: { kind: "build" } });
  check("dx12_call {dx12_job_list} で履歴が引ける", lst.ok === true && lst.result.jobs.some((j: any) => j.id === started.id) && lst.result.counts.succeeded >= 1, lst.result?.counts);
  const res = await s1.call("dx12_call", { name: "dx12_job_result", args: { id: started.id } });
  check("dx12_call {dx12_job_result}: 全文(summary.ok・tail)", res.ok === true && res.result.result?.summary?.ok === true && res.result.result?.tail?.length > 0, res.result?.state);
  const lg = await s1.call("dx12_call", { name: "dx12_job_logs", args: { id: started.id, tail: 3 } });
  check("dx12_call {dx12_job_logs}: 末尾 3 行", lg.ok === true && lg.result.lines.length === 3 && /\[build\] OK/.test(lg.result.lines[2]), lg.result?.lines);
  // 終わっていないジョブの result は構造化エラー
  const s2 = await s1.call("dx12_job_start", { kind: "ctest", args: {} });
  noteJob(s2.id);
  const nf = await s1.call("dx12_call", { name: "dx12_job_result", args: { id: s2.id } });
  check("動いているジョブの result は E_JOB_NOT_FINISHED + fix(dx12_job_status)", nf.ok === false && nf.error_code === "E_JOB_NOT_FINISHED" && nf.fix?.[0]?.tool === "dx12_job_status", nf);
  const doc = await s1.call("dx12_doctor", {});
  check("dx12_doctor: 動いているジョブが jobs.active と issues(JOBS_ACTIVE)に出る", doc.jobs?.active?.some((a: any) => a.id === s2.id) && doc.issues.some((i: any) => i.code === "JOBS_ACTIVE"), doc.jobs);
  const c2 = await s1.call("dx12_job_cancel", { id: s2.id });
  check("dx12_job_cancel → cancelled", c2.state === "cancelled", c2);
  const none = await s1.call("dx12_job_status", { id: "j-20200101-000000-0000" });
  check("存在しない id は E_JOB_NOT_FOUND(構造化エラー・isError)", none.error_code === "E_JOB_NOT_FOUND" && none.fix?.[0]?.tool === "dx12_job_list", none);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] 引数検証・冪等キー・external の guarded");
{
  const typo = await s1.call("dx12_job_start", { kind: "build", args: { targt: "DX12Engine" } });
  check("args の打ち間違いは E_UNKNOWN_PARAM + didYouMean + fix が {kind, args} の形で撃ち直せる", typo.error_code === "E_UNKNOWN_PARAM" && typo.didYouMean?.[0] === "target" && typo.fix?.[0]?.tool === "dx12_job_start" && typo.fix[0].args?.kind === "build" && typo.fix[0].args?.args?.target === "DX12Engine", typo);
  const multi = await s1.call("dx12_job_start", { kind: "build", args: { target: ["A", "B"] } });
  check("build に複数ターゲットは E_BAD_TYPE(別々のジョブを案内)", multi.error_code === "E_BAD_TYPE" && multi.fix?.length === 2, multi);
  const badKind = await s1.raw("dx12_job_start", { kind: "biuld", args: {} });
  check("kind の打ち間違い(SDK の enum 検証)にも構造化 JSON が付く", badKind.isError === true && badKind.content.some((c: any) => /biuld|build/.test(c.text)), badKind.content.map((c: any) => c.text.slice(0, 80)));
  const k1 = await s1.call("dx12_job_start", { kind: "ctest", args: {}, idempotencyKey: "same-key" });
  const k2 = await s1.call("dx12_job_start", { kind: "ctest", args: {}, idempotencyKey: "same-key" });
  noteJob(k1.id);
  check("同じ idempotencyKey の再送は同じジョブ(idempotentReplay:true)", k1.id === k2.id && k2.idempotentReplay === true, { a: k1.id, b: k2.id });
  await s1.call("dx12_job_cancel", { id: k1.id });
  const kc = await s1.call("dx12_job_start", { kind: "build", args: {}, idempotencyKey: "same-key" });
  check("同じキーで別の kind は E_IDEMPOTENCY_CONFLICT", kc.error_code === "E_IDEMPOTENCY_CONFLICT" && kc.details?.existingJob === k1.id, kc);

  // external: 直接呼ぶと E_GUARDED(fix は dx12_call_guarded)。dx12_call {confirm:true} も core 面では通らない。dx12_call_guarded 経由でだけ走る
  const extArgs = { kind: "external", args: { command: [process.execPath, ...nodeArgs("protocol", ["--steps", "3", "--delay", "30"])] } };
  const e1 = await s1.call("dx12_job_start", extArgs);
  check("external を直接 start すると E_GUARDED(fix = dx12_call_guarded・ジョブは作られない)", e1.error_code === "E_GUARDED" && e1.fix?.[0]?.tool === "dx12_call_guarded" && e1.fix[0].args?.name === "dx12_job_start", e1);
  const e2 = await s1.call("dx12_call", { name: "dx12_job_start", args: extArgs, confirm: true });
  check("core 面では dx12_call {confirm:true} でも external は通らない(E_GUARDED・dx12_call_guarded を案内)", e2.error_code === "E_GUARDED" && e2.fix?.some((f: any) => f.tool === "dx12_call_guarded"), e2);
  const e3 = await s1.call("dx12_call_guarded", { name: "dx12_job_start", args: extArgs });
  noteJob(e3.result?.id ?? "");
  check("dx12_call_guarded 経由なら external が走る(@progress / @result を読む)", e3.ok === true && e3.result?.kind === "external", e3);
  const e3s = await statusUntil(s1, e3.result.id, (s) => s.state === "succeeded", 15000);
  check("external の @result が summary に載る", e3s.state === "succeeded" && e3s.summary?.result?.tris === 12345, e3s);
  const listedBefore = (await s1.call("dx12_call", { name: "dx12_job_list", args: { kind: "external" } })).result.jobs.length;
  check("承認されなかった external はジョブとして残っていない(承認された 1 件だけ)", listedBefore === 1, listedBefore);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] キャンセル(プロセスツリー)と MCP サーバ再起動後の復元");
{
  const pidfile = path.join(mk("gc"), "grand.pid");
  const cmd = [process.execPath, ...nodeArgs("hang", ["--grandchild", pidfile])];
  const j = await s1.call("dx12_call_guarded", { name: "dx12_job_start", args: { kind: "external", args: { command: cmd } } });
  const id = j.result.id;
  await waitFor(() => fs.existsSync(pidfile), 10000, 50);
  const grand = Number(fs.readFileSync(pidfile, "utf8"));
  noteJob(id); track(grand);
  const rec = JSON.parse(fs.readFileSync(path.join(jdir, id, "state.json"), "utf8"));
  const runner = rec.runnerPid as number;
  check("走行中: runner と孫プロセスが生きている", pidAlive(runner) && pidAlive(grand));
  const c = await s1.call("dx12_job_cancel", { id });
  check("dx12_job_cancel: cancelled・プロセスツリー(runner・子・孫)が全部終了", c.state === "cancelled" && (await waitFor(() => !pidAlive(runner) && !pidAlive(grand), 6000, 50)), c);

  // 再起動: 走っているジョブを残して MCP サーバを終了 → 新しいサーバで status
  const pidfile2 = path.join(mk("gc2"), "grand.pid");
  const j2 = await s1.call("dx12_call_guarded", { name: "dx12_job_start", args: { kind: "external", args: { command: [process.execPath, ...nodeArgs("protocol", ["--steps", "14", "--delay", "250", "--grandchild", pidfile2])], progress: "protocol" } } });
  const id2 = j2.result.id;
  await waitFor(() => { try { return (JSON.parse(fs.readFileSync(path.join(jdir, id2, "live.json"), "utf8")).progress?.pct ?? 0) > 0; } catch { return false; } }, 10000, 50);
  noteJob(id2);
  const runner2 = JSON.parse(fs.readFileSync(path.join(jdir, id2, "state.json"), "utf8")).runnerPid as number;
  s1.proc.stdin!.end();   // 正常終了(stdio クローズ)
  await waitFor(() => s1.proc.exitCode !== null, 8000, 50);
  check("MCP サーバが終了しても runner(process 型ジョブ)は走り続ける", pidAlive(runner2));
  const s3 = server();
  await s3.initialize();
  const mid = await s3.call("dx12_job_status", { id: id2 });
  check("新しい MCP サーバの dx12_job_status で再起動前のジョブが引ける(running・進捗が復元・ownedByMe:false・orphaned なし=前の owner は既に無いので orphaned:true)", mid.state === "running" && typeof mid.progress?.pct === "number" && mid.ownedByMe === false && mid.orphaned === true, mid);
  const doc = await s3.call("dx12_doctor", {});
  check("dx12_doctor が孤児のジョブを警告(JOBS_ORPHANED)", doc.issues.some((i: any) => i.code === "JOBS_ORPHANED"), doc.issues.map((i: any) => i.code));
  const done = await statusUntil(s3, id2, (s) => s.state === "succeeded", 30000);
  check("再起動後にジョブが完了 → succeeded・結果(@result)も引ける", done.state === "succeeded" && done.summary?.result?.tris === 12345, done);
  const list = await s3.call("dx12_call", { name: "dx12_job_list", args: {} });
  check("再起動後の dx12_job_list に再起動前のジョブが全部出る", [id, id2].every((x) => list.result.jobs.some((j: any) => j.id === x)) && list.result.counts.cancelled >= 1, list.result?.counts);
  s3.proc.stdin!.end();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[5] エンジン系: bench / screenshot_batch / playtest");
const s4 = server();
await s4.initialize();
{
  const b = await s4.call("dx12_job_start", { kind: "bench", args: { frames: 60, runs: 3 } });
  const bs = await statusUntil(s4, b.id, (s) => s.state === "succeeded" || s.state === "failed", 20000);
  check("bench: 3 回の中央値・ばらつき・engine を summary に載せる", bs.state === "succeeded" && bs.summary?.fps?.median === 120 && bs.summary?.fps?.min === 110 && bs.summary?.fps?.max === 130 && bs.summary?.runs === 3, bs);
  check("bench: benchmark は frames=60・uncap=true で 3 回呼ばれた", mock.received.filter((r) => r.method === "benchmark").length === 3 && mock.received.find((r) => r.method === "benchmark")?.params.frames === 60);

  // キャンセル: benchmark を遅らせて途中で cancel → エンジンへ cancel {target:benchmark} が飛び、ジョブが 10 秒以内に cancelled
  mock.state.delayMs.benchmark = 3000;
  const before = mock.received.length;
  const b2 = await s4.call("dx12_job_start", { kind: "bench", args: { frames: 600, runs: 5 } });
  await waitFor(() => mock.received.slice(before).some((r) => r.method === "benchmark"), 8000, 30);
  const t0 = Date.now();
  const cc = await s4.call("dx12_job_cancel", { id: b2.id });
  check(`bench のキャンセル: cancelled(${Date.now() - t0} ms)・エンジンへ cancel {target:"benchmark"} が送られた`, cc.state === "cancelled" && mock.received.slice(before).some((r) => r.method === "cancel" && r.params.target === "benchmark"), { state: cc.state, recv: mock.received.slice(before).map((r) => r.method) });
  mock.state.delayMs.benchmark = 0;

  // screenshot_batch: 2 カメラ × 2 バリアント(calls は transaction で巻き戻す)
  const rcvBefore = mock.received.length;
  const sb = await s4.call("dx12_job_start", { kind: "screenshot_batch", args: {
    cameras: [{ name: "front", position: [0, 2, -8], target: [0, 1, 0] }, { name: "top", position: [0, 12, 0], target: [0, 0, 0] }],
    variants: [{ name: "day" }, { name: "night", calls: [{ method: "set_sun", params: { intensity: 0.1 } }] }], view: "final",
  } });
  const sbs = await statusUntil(s4, sb.id, (s) => s.state === "succeeded" || s.state === "failed", 30000);
  check("screenshot_batch: 4 枚(2×2)撮って succeeded・manifest・contact_sheet がある", sbs.state === "succeeded" && sbs.summary?.captured === 4 && fs.existsSync(sbs.summary.manifest) && fs.existsSync(sbs.summary.contactSheet), sbs);
  const man = JSON.parse(fs.readFileSync(sbs.summary.manifest, "utf8"));
  check("manifest: 各カット(camera / variant / dpiScale / path / 幅高さ)・PNG が実在して読める", man.shots.length === 4 && man.shots.every((s: any) => fs.existsSync(s.path) && s.width === 64 && s.camera && s.variant && s.dpiScale === 1) && PNG.sync.read(fs.readFileSync(sbs.summary.contactSheet)).width > 64, man.shots.slice(0, 2));
  const rc = mock.received.slice(rcvBefore).map((r) => r.method);
  check("variant の calls は transaction_begin → 呼び出し → 撮影 → transaction_rollback で巻き戻される(night の 2 枚だけ)", rc.filter((m) => m === "transaction_begin").length === 2 && rc.filter((m) => m === "transaction_rollback").length === 2 && rc.filter((m) => m === "set_sun").length === 2, rc);
  check("撮影の前に set_editor_camera で視点を置いている(4 回)", rc.filter((m) => m === "set_editor_camera").length === 4);
  check("artifacts に画像 4 枚 + manifest + contact_sheet", sbs.artifacts.filter((a: any) => a.kind === "screenshot").length === 4 && sbs.artifacts.some((a: any) => a.kind === "contact_sheet") && sbs.artifacts.some((a: any) => a.kind === "manifest"), sbs.artifacts.map((a: any) => a.kind));

  // 別の倍率: 基準(倍率 1)は同じエンジン、倍率 2 は専用エンジン(フリート。偽エンジンのプロセス)を起動 → 撮る → 止める
  const sb2 = await s4.call("dx12_job_start", { kind: "screenshot_batch", args: { cameras: [{ name: "a" }], dpiScales: [1, 2], view: "imgui" } });
  const sb2s = await statusUntil(s4, sb2.id, (s) => s.state === "succeeded" || s.state === "failed", 60000);
  const man2 = sb2s.summary?.manifest ? JSON.parse(fs.readFileSync(sb2s.summary.manifest, "utf8")) : null;
  check("別倍率: 倍率 1(基準エンジン)と 2(専用エンジン)の 2 枚が撮れる・dedicatedEngines は 1 台・view=imgui", sb2s.state === "succeeded" && sb2s.summary?.captured === 2 && sb2s.summary?.dedicatedEngines?.length === 1 && man2?.shots.map((s: any) => s.dpiScale).join() === "1,2", sb2s.error ?? sb2s);
  const fl = (await s4.call("dx12_call", { name: "dx12_engine_list", args: {} })).result;   // M7: dx12_engine_list は長尾(dx12_call)
  check("専用エンジンは撮影後に止まっていて、セッションの既定エンジンは束縛されないまま", fl.engines.length === 0 && fl.bound === null, { n: fl.engines.length, bound: fl.bound });
  check("engine の記録: 専用エンジンの id が manifest に残る(基準は default)", man2.shots[1].engine !== man2.shots[0].engine, man2.shots.map((s: any) => s.engine));

  // playtest: 保存済みが無いプロジェクト
  const pt = await s4.call("dx12_job_start", { kind: "playtest", args: {} });
  const pts = await statusUntil(s4, pt.id, (s) => s.state !== "queued" && s.state !== "running", 20000);
  check("playtest: 保存済みが無ければ ran:0 で succeeded(note に場所)", pts.state === "succeeded" && pts.summary?.ran === 0 && /playtests/.test(pts.summary?.note ?? ""), pts);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[6] ui_tests: --ui-tests-skip 未対応の exe では走らせない");
{
  const ui = await s4.call("dx12_job_start", { kind: "ui_tests", args: {} });
  const us = await statusUntil(s4, ui.id, (s) => s.state !== "queued" && s.state !== "running", 20000);
  check("未対応の exe(既定で build_game を除外できない)→ failed・E_UNSUPPORTED・fix は build ジョブ", us.state === "failed" && us.error?.code === "E_UNSUPPORTED" && us.error.fix?.[0]?.tool === "dx12_job_start", us);
  check("exeHasWideString: UTF-16 のフラグ名を検出する(対応 exe / 未対応 exe)", (() => {
    const f1 = path.join(mk("exe"), "a.exe"); fs.writeFileSync(f1, Buffer.concat([Buffer.alloc(100, 7), Buffer.from("--ui-tests-skip", "utf16le"), Buffer.alloc(50)]));
    const f2 = path.join(mk("exe"), "b.exe"); fs.writeFileSync(f2, Buffer.alloc(300, 7));
    return exeHasWideString(f1, "--ui-tests-skip") && !exeHasWideString(f2, "--ui-tests-skip");
  })());
  const bg = await s4.call("dx12_job_start", { kind: "ui_tests", args: { includeBuildGame: true, skip: ["build_game"] } });
  check("includeBuildGame:true と skip:[build_game] の矛盾は E_BAD_TYPE", bg.error_code === "E_BAD_TYPE", bg);
}

// ── 後始末 ─────────────────────────────────────────────────────────────────
for (const c of clients) { try { c.proc.stdin!.end(); } catch { /* 無視 */ } }
await sleep(500);
for (const c of clients) { try { c.close(); } catch { /* 無視 */ } }
await mock.close();
for (const p of runnerPids) { try { killTreeSync(p); } catch { /* 無視 */ } }
killTracked();
await sleep(300);
for (const d of dirs) rmTree(d);
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: jobs stdio テスト ${total} 項目すべて通過`);
process.exit(0);
