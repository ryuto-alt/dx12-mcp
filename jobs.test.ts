// ジョブ API(M6)の中核テスト。エンジン不要・偽の子プロセス(jobs/fakeProc.ts)で、実際に runner を切り離して走らせる。
//   [1] 進捗の解析(build / ctest / ui_tests / @progress プロトコル / JUnit)
//   [2] 実行・進捗の単調増加・結果・ログ・start の即応
//   [3] 失敗(終了コード・ビルドエラーの抽出)・起動できないコマンド
//   [4] 順番待ち(build は 1 本・queuePosition)・同時実行の上限
//   [5] キャンセル(プロセスツリー全部・無関係なプロセスは無傷・待ち行列の取り消し・終わったものは何もしない)・タイムアウト
//   [6] 再起動後の復元(state.json + live.json)・inproc の中断・他セッションのジョブは止められない
//   [7] 冪等キー・guarded(external の承認)・inproc ジョブ・long-poll
// 実行: node jobs.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import "./testEnv.ts";
import { BuildParser, CtestParser, ProtocolParser, UiTestsParser, parseJUnit } from "./jobs/parsers.ts";
import { loadJobsConfig } from "./jobs/config.ts";
import { JobManager, JobFailure, type KindDef } from "./jobs/manager.ts";
import { JobStore, newJobId, JOB_ID_RE } from "./jobs/store.ts";
import { pidAlive, killTreeSync } from "./fleet/proc.ts";
import { waitFor, tmpDir, rmTree, spawnSleeper, track, killTracked } from "./fleetTestKit.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "jobs", "fakeProc.ts");

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function fails(fn: () => Promise<unknown>): Promise<any> { try { await fn(); return null; } catch (e: any) { return e instanceof JobFailure ? e.body : { thrown: String(e?.message ?? e) }; } }

// ─────────────────────────────────────────────────────────────────────────────
console.log("[1] 進捗の解析");
{
  const b = new BuildParser();
  const u = [
    b.feed("[build] another build is running. waiting for the lock (up to 40 min)..."),
    b.feed("[build] lock acquired after 12s"),
    b.feed("[build] cmake --build build\\release -j 6 --target DX12Engine -- -l 26  (jobs=6, priority=BelowNormal)"),
    b.feed("[3/40] Building CXX object src\\core\\CMakeFiles\\core.dir\\Application.cpp.obj"),
    b.feed("[40/40] Linking CXX executable DX12Engine.exe"),
    b.feed("C:\\dx12\\src\\core\\Foo.cpp(12,5): error C2065: 'x': undeclared identifier [C:\\dx12\\build\\core.vcxproj]"),
    b.feed("C:\\dx12\\src\\core\\Foo.cpp(12,5): error C2065: 'x': undeclared identifier [C:\\dx12\\build\\core.vcxproj]"),
    b.feed("DX12Engine.exe : fatal error LNK1104: cannot open file 'DX12Engine.exe'"),
    b.feed("FAILED: DX12Engine.exe"),
    b.feed("[build] FAILED in 33.4s (exit 1)"),
  ];
  check("build: ロック待ち → waiting_lock / 取得 → starting", u[0]?.phase === "waiting_lock" && u[1]?.phase === "starting");
  check("build: [n/m] → pct / phase(compile / link)/ 短い説明", u[3]?.pct === 7.5 && u[3]?.phase === "compile" && /Application\.cpp\.obj/.test(u[3]?.message ?? "") && u[4]?.phase === "link" && u[4]?.pct === 100, u.slice(3, 5));
  const s: any = b.finish(1);
  check("build: エラー行を抽出(重複は 1 件・LNK も拾う)・FAILED ターゲット・所要秒", s.errors.length === 2 && s.errors[0].code === "C2065" && s.errors[0].line === 12 && s.errors[1].code === "LNK1104" && s.failedTargets[0] === "DX12Engine.exe" && s.buildSeconds === 33.4 && s.ok === false && s.steps.done === 40, s);
  const up = new BuildParser(); up.feed("ninja: no work to do.");
  check("build: no work to do → upToDate", (up.finish(0) as any).upToDate === true);

  const c = new CtestParser();
  c.feed("Test project C:/dx12/build/release");
  const cu = c.feed("  3/71 Test  #3: McpManifestTests ..................   Passed    0.11 sec");
  c.feed("  4/71 Test  #4: FooTests ............................***Failed    0.02 sec");
  c.feed("97% tests passed, 1 tests failed out of 71");
  c.feed("Total Test time (real) =  12.34 sec");
  c.feed("The following tests FAILED:");
  c.feed("\t  4 - FooTests (Failed)");
  const cs: any = c.finish(8);
  check("ctest: n/N の進捗と失敗テスト", cu?.pct === 4.2 && cu?.phase === "testing" && cs.total === 71 && cs.failed === 1 && cs.passed === 70 && cs.failedTests[0].name === "FooTests" && cs.totalSec === 12.34, { cu, cs });

  const ui = new UiTestsParser(100);
  ui.feed("[info] UI テストエンジンを起動しました (run-all=yes)", 1000);
  const q = ui.feed("[info] UI テスト: 55 件をキューへ投入しました (全テスト)", 2000);
  const t = ui.tick(52_000);
  ui.feed("[info] UI テスト完了: 54/55 成功", 100_000);
  const us: any = ui.finish(1);
  check("ui_tests: 投入 → running、経過時間から pct を見積もる(estimated)・完了行を拾う", q?.phase === "running" && t?.estimated === true && t?.pct === 50 && us.success === 54 && us.tested === 55 && us.queued === 55, { q, t, us });

  const pp = new ProtocolParser(true);
  const a1 = pp.feed('@progress {"pct":42,"phase":"cook","msg":"メッシュ 3/7","eta":30}');
  const a2 = pp.feed('@progress {"done":5,"total":10}');
  const a3 = pp.feed("@progress {broken");
  pp.feed('@result {"out":"a.vgeo"}');
  const a4 = pp.feed("Processing... 87.5% done");
  check("protocol: @progress の pct / phase / msg / eta・done/total・壊れた JSON は無視・%表記のフォールバック", a1?.pct === 42 && a1?.phase === "cook" && a1?.etaSec === 30 && a2?.pct === 50 && a3 === null && a4?.pct === 87.5, { a1, a2, a3, a4 });
  check("protocol: @result を summary に載せる", (pp.finish(0) as any).result?.out === "a.vgeo");

  const j = parseJUnit(`<?xml version="1.0"?><testsuites><testsuite name="x" tests="3" failures="1"><testcase name="A" classname="c1" time="0.5"/><testcase name="B &amp; C" classname="c1" time="1.5"><failure message="expected 1 &lt; 2"/></testcase><testcase name="D" classname="c2"><skipped/></testcase></testsuite></testsuites>`);
  check("JUnit: 件数・失敗の名前とメッセージ(エンティティを戻す)", j.tests === 3 && j.failures === 1 && j.skipped === 1 && j.failed[0].name === "B & C" && j.failed[0].message === "expected 1 < 2", j);
}

// ── manager の準備 ─────────────────────────────────────────────────────────
const dirs: string[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };

function cfgFor(dir: string, extra: Record<string, string> = {}) {
  return loadJobsConfig({ ...process.env, DX12_JOBS_DIR: dir, DX12_JOBS_POLL_MS: "50", DX12_REPO_DIR: mk("repo"), ...extra } as NodeJS.ProcessEnv);
}
const nodeCmd = (mode: string, more: string[] = []) => ({ cmd: process.execPath, args: ["--disable-warning=ExperimentalWarning", FAKE, "--mode", mode, ...more] });

/** 偽の process 型ジョブ種別。args.fake = fakeProc へ渡す引数。 */
function fakeProcKind(kind: any, group: string, mode: string, parser: any): KindDef {
  return {
    kind, executor: "process", describe: "fake", group: () => group, timeoutSec: 60,
    shape: { fake: z.array(z.string()).optional() },
    prepare(a: any) { const c = nodeCmd(mode, a.fake ?? []); return { cmd: c.cmd, args: c.args, cwd: os.tmpdir(), parser }; },
  };
}
function inprocKind(kind: any, run: KindDef["run"], group = "engine:test"): KindDef {
  return { kind, executor: "inproc", describe: "fake", group: () => group, timeoutSec: 60, shape: { n: z.number().optional() }, run };
}
const kindsProc = (): KindDef[] => [
  fakeProcKind("build", "build", "build", { type: "build" }),
  fakeProcKind("ctest", "ctest", "ctest", { type: "ctest" }),
  fakeProcKind("vg_cook", "external", "protocol", { type: "protocol" }),
  fakeProcKind("ue_import", "external", "hang", { type: "none" }),
];

let deadPid = 0;
{
  const c = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  deadPid = c.pid!;
  await new Promise<void>((r) => c.on("exit", () => r()));
}

const jdir = mk("jobs");
const cfg = cfgFor(jdir);
const mgr = new JobManager({ cfg, kinds: kindsProc() });
const trackJob = async (id: string) => { const v = mgr.status(id); track(v.progress ? undefined : undefined); return v; };
void trackJob;
const runnerPids = new Set<number>();
process.on("exit", () => { for (const p of runnerPids) { try { killTreeSync(p); } catch { /* 無視 */ } } });   // テストが途中で落ちても runner を残さない
const noteRunner = (id: string) => { const rec = mgr.store.load(id); if (rec?.runnerPid) runnerPids.add(rec.runnerPid); const l = mgr.store.readLive(id); if (l?.childPid) runnerPids.add(l.childPid); };

// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] 実行・進捗・結果・ログ");
{
  const t0 = Date.now();
  const v0 = await mgr.start({ kind: "vg_cook", args: { fake: ["--steps", "12", "--delay", "200"] } });
  const startMs = Date.now() - t0;
  check(`start は即座に返る(${startMs} ms < 500)・id 形式・queued/running`, startMs < 500 && JOB_ID_RE.test(v0.id) && (v0.state === "queued" || v0.state === "running"), { startMs, v0 });
  const seen: number[] = [];
  const ph = new Set<string>();
  const done = await waitFor(() => {
    const v = mgr.status(v0.id);
    noteRunner(v0.id);
    if (typeof v.progress.pct === "number") seen.push(v.progress.pct);
    ph.add(v.progress.phase);
    return v.state === "succeeded";
  }, 15000, 40);
  const v = mgr.status(v0.id);
  check("succeeded まで進む", done && v.state === "succeeded" && v.exitCode === 0, v);
  check("進捗は単調に増えて 100 で終わる・cook フェーズを経由", seen.every((x, i) => i === 0 || x >= seen[i - 1]) && seen.length >= 3 && v.progress.pct === 100 && ph.has("cook"), { seen, ph: [...ph] });
  check("summary に @result が載る・elapsedSec・resultPath・logPath がある", (v.summary as any)?.result?.tris === 12345 && (v.elapsedSec ?? 0) > 0 && !!v.resultPath && fs.existsSync(v.logPath), v);
  const r = mgr.result(v0.id);
  check("dx12_job_result: 全文(summary・tail)", (r.result as any)?.summary?.ok === true && Array.isArray((r.result as any)?.tail) && (r.result as any).tail.length > 0, r.result);
  const lg = mgr.logs(v0.id, 5);
  check("dx12_job_logs: 末尾 N 行", lg.lines.length === 5 && lg.lines.some((l) => l.startsWith("@result")), lg.lines);
  check("所要時間の履歴が残る(typicalSec)", (mgr.status(v0.id).typicalSec ?? 0) > 0, mgr.status(v0.id).typicalSec);
  check("state.json / live.json / result.json / log.txt がジョブのフォルダにある", ["state.json", "live.json", "result.json", "log.txt", "spec.json"].every((f) => fs.existsSync(path.join(mgr.store.pathsOf(v0.id).dir, f))));
  check("list に出る・counts", mgr.list({ kind: "vg_cook" }).jobs.some((j) => j.id === v0.id) && mgr.list().counts.succeeded >= 1);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] 失敗と起動できないコマンド");
{
  const v0 = await mgr.start({ kind: "build", args: { fake: ["--steps", "4", "--delay", "40", "--exit", "1"] } });
  await waitFor(() => mgr.status(v0.id).state === "failed", 15000, 40);
  const v = mgr.status(v0.id);
  check("終了コード 1 → failed・E_JOB_FAILED・ビルドエラーが summary.errors に入る", v.state === "failed" && v.error?.code === "E_JOB_FAILED" && v.exitCode === 1 && (v.summary as any)?.errors?.[0]?.code === "C2065", v);
  check("build の steps と error.details.tail(直近の出力)が返る", (v.summary as any)?.steps?.total === 4 && Array.isArray((v.error?.details as any)?.tail), v.error);

  const ct = await mgr.start({ kind: "ctest", args: { fake: ["--steps", "4", "--delay", "30", "--exit", "8"] } });
  await waitFor(() => mgr.status(ct.id).state === "failed", 15000, 40);
  const cv = mgr.status(ct.id);
  check("ctest: 失敗したテスト名が summary.failedTests に入る", cv.state === "failed" && (cv.summary as any)?.failedTests?.[0]?.name === "Test2" && (cv.summary as any)?.failed === 1, cv.summary);

  // 文字コード: cp932 の MSVC 診断も、UTF-8 の行も、行ごとに正しく読める
  const cpMgr = new JobManager({ cfg: cfgFor(mk("jobs-cp")), kinds: [fakeProcKind("build", "build", "cp932", { type: "build" })] });
  const cp0 = await cpMgr.start({ kind: "build", args: {} });
  await waitFor(() => cpMgr.status(cp0.id).state === "failed", 15000, 40);
  const cpv = cpMgr.status(cp0.id);
  check("出力の文字コード: cp932 のエラー行(不正な UTF-8)も UTF-8 の行も文字化けしない", (cpv.summary as any)?.errors?.[0]?.message?.includes("エラー tail") && cpMgr.logs(cp0.id, 5).lines.some((l) => l.includes("エラー")) && cpMgr.logs(cp0.id, 5).lines.some((l) => l === "utf8 line: 日本語"), (cpv.summary as any)?.errors);
  cpMgr.shutdownSync();

  // 起動できないコマンド
  const bad = new JobManager({ cfg: cfgFor(mk("jobs-bad")), kinds: [{ kind: "external", executor: "process", describe: "x", group: () => "external", timeoutSec: 30, shape: {}, prepare() { return { cmd: "definitely-not-a-command-xyz", args: [], cwd: os.tmpdir(), parser: { type: "none" } }; } }] });
  const b0 = await bad.start({ kind: "external", args: {} });
  await waitFor(() => bad.status(b0.id).state === "failed", 8000, 40);
  const bv = bad.status(b0.id);
  check("存在しないコマンド → failed・E_JOB_TOOL_MISSING(spawn エラー)", bv.state === "failed" && bv.error?.code === "E_JOB_TOOL_MISSING", bv.error);
  bad.shutdownSync();

  // prepare が構造化エラーを投げたら failed でその error が載る
  const bad2 = new JobManager({ cfg: cfgFor(mk("jobs-bad2")), kinds: [{ kind: "build", executor: "process", describe: "x", group: () => "build", timeoutSec: 30, shape: {}, prepare() { return jobFailLike(); } }] });
  function jobFailLike(): never { throw new JobFailure({ code: "E_JOB_TOOL_MISSING", message: "tools\\build.ps1 が見つからない", fix: [{ command: "x", why: "y" }] }); }
  const b2 = await bad2.start({ kind: "build", args: {} });
  await waitFor(() => bad2.status(b2.id).state === "failed", 5000, 30);
  check("prepare の構造化エラーは failed + error(code / fix)で残る", bad2.status(b2.id).error?.code === "E_JOB_TOOL_MISSING" && !!bad2.status(b2.id).error?.fix?.length, bad2.status(b2.id).error);
  bad2.shutdownSync();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] 順番待ちと同時実行の上限");
{
  const a = await mgr.start({ kind: "build", args: { fake: ["--steps", "8", "--delay", "150", "--lock-wait", "300"] } });
  const b = await mgr.start({ kind: "build", args: { fake: ["--steps", "3", "--delay", "30"] } });
  const c = await mgr.start({ kind: "build", args: { fake: ["--steps", "3", "--delay", "30"] } });
  const vb = mgr.status(b.id), vc = mgr.status(c.id);
  check("build は 1 本ずつ: 2 本目は queued・queuePosition 1、3 本目は 2", vb.state === "queued" && vb.queuePosition === 1 && vc.state === "queued" && vc.queuePosition === 2, { vb: vb.state, vc: vc.state, pb: vb.queuePosition, pc: vc.queuePosition });
  // ctest は別 group なので build の順番待ちに関係なく走る
  const ct = await mgr.start({ kind: "ctest", args: { fake: ["--steps", "3", "--delay", "30"] } });
  await sleep(300);
  check("別 group(ctest)は build の待ち行列に関係なく同時に走る", ["running", "succeeded"].includes(mgr.status(ct.id).state), mgr.status(ct.id).state);
  const sawLock = await waitFor(() => mgr.status(a.id).progress.phase === "waiting_lock", 3000, 30);
  check("他のビルドのロック待ちは phase=waiting_lock で見える", sawLock || mgr.status(a.id).state !== "queued", mgr.status(a.id).progress);
  await waitFor(() => mgr.status(c.id).state === "succeeded", 30000, 50);
  const order = [a, b, c].map((x) => mgr.status(x.id).startedAt ?? 0);
  check("順番どおり(a → b → c)に開始・全部 succeeded", order[0] <= order[1] && order[1] <= order[2] && [a, b, c].every((x) => mgr.status(x.id).state === "succeeded"), order);
  check("b の開始は a の終了より後(build は同時に走らない)", (mgr.status(b.id).startedAt ?? 0) >= (mgr.status(a.id).finishedAt ?? Infinity) - 5, { bStart: mgr.status(b.id).startedAt, aEnd: mgr.status(a.id).finishedAt });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[5] キャンセル・タイムアウト");
{
  const pidfile = path.join(mk("gc"), "grand.pid");
  const decoy = spawnSleeper(60_000);   // 無関係なプロセス(キャンセルで巻き込まれてはいけない)
  track(decoy.pid);
  const j = await mgr.start({ kind: "ue_import", args: { fake: ["--grandchild", pidfile] } });
  await waitFor(() => fs.existsSync(pidfile) && mgr.status(j.id).state === "running" && !!mgr.store.readLive(j.id)?.childPid, 10000, 50);
  const grand = Number(fs.readFileSync(pidfile, "utf8"));
  noteRunner(j.id);
  const rec = mgr.store.load(j.id)!;
  const live = mgr.store.readLive(j.id)!;
  check("走行中: runner・子・孫の pid が生きている", pidAlive(rec.runnerPid!) && pidAlive(live.childPid!) && pidAlive(grand), { runner: rec.runnerPid, child: live.childPid, grand });
  const t0 = Date.now();
  const cv = await mgr.cancel(j.id);
  const cancelMs = Date.now() - t0;
  check(`cancel → cancelled(${cancelMs} ms)`, cv.state === "cancelled" && !!cv.finishedAt, cv);
  const dead = await waitFor(() => !pidAlive(rec.runnerPid!) && !pidAlive(live.childPid!) && !pidAlive(grand), 6000, 50);
  check("runner・子・孫のプロセスツリー全部が終了している", dead, { runner: pidAlive(rec.runnerPid!), child: pidAlive(live.childPid!), grand: pidAlive(grand) });
  check("無関係なプロセス(decoy)は生きたまま", pidAlive(decoy.pid!));
  check("キャンセルしたジョブは再度 status を引いても cancelled のまま", mgr.status(j.id).state === "cancelled");
  const again = await mgr.cancel(j.id);
  check("終わったジョブの cancel は何もしない(notes に明記)", again.state === "cancelled" && (again.notes ?? []).some((n) => /既に終わっている/.test(n)), again.notes);

  // 待ち行列の中のジョブのキャンセル
  const h = await mgr.start({ kind: "ue_import", args: {} });      // external group cap 2: 1 本目
  const h2 = await mgr.start({ kind: "ue_import", args: {} });     // 2 本目
  const h3 = await mgr.start({ kind: "vg_cook", args: { fake: ["--steps", "2", "--delay", "10"] } });   // 3 本目 = 待ち
  await sleep(200);
  check("external の上限(2)を超えた 3 本目は queued", mgr.status(h3.id).state === "queued" && mgr.status(h3.id).queuePosition === 1, mgr.status(h3.id));
  const qc = await mgr.cancel(h3.id);
  check("queued のジョブは開始されずに cancelled", qc.state === "cancelled" && !qc.startedAt, qc);
  noteRunner(h.id); noteRunner(h2.id);
  await mgr.cancel(h.id); await mgr.cancel(h2.id);

  // タイムアウト
  const tj = await mgr.start({ kind: "ue_import", args: {}, timeoutSec: 1 });
  await waitFor(() => mgr.status(tj.id).state === "timeout", 20000, 50);
  const tv = mgr.status(tj.id);
  noteRunner(tj.id);
  check("timeoutSec を超えたら timeout・E_JOB_TIMEOUT", tv.state === "timeout" && tv.error?.code === "E_JOB_TIMEOUT", tv);
  const tRunner = mgr.store.load(tj.id)?.runnerPid;
  check("timeout でもプロセスは残らない", await waitFor(() => !tRunner || !pidAlive(tRunner), 6000, 50));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[6] 再起動後の復元・inproc の中断・他セッションのジョブ");
{
  const dir = mk("jobs-restart");
  // 前の MCP サーバ(owner = すでに死んだ pid)が起動したジョブ
  const hangInproc = inprocKind("bench", async (_a, ctx) => { ctx.progress({ phase: "benchmark", pct: 5, message: "run" }); await new Promise<void>((res) => { const t = setInterval(() => { if (ctx.signal.aborted) { clearInterval(t); res(); } }, 20); }); throw new Error("aborted"); });
  const mgrA = new JobManager({ cfg: cfgFor(dir), kinds: [...kindsProc(), hangInproc], ownerPid: deadPid });
  const pj = await mgrA.start({ kind: "vg_cook", args: { fake: ["--steps", "10", "--delay", "200"] } });
  await waitFor(() => (mgrA.store.readLive(pj.id)?.progress?.pct ?? 0) > 0, 8000, 50);
  const hj = await mgrA.start({ kind: "ue_import", args: {} });   // 止まらないジョブ
  await waitFor(() => !!mgrA.store.readLive(hj.id)?.childPid, 8000, 50);
  const ij = await mgrA.start({ kind: "bench", args: {} });
  mgrA.shutdownSync();   // A は消えた(process 型は走り続ける。inproc は中断として記録される)
  noteRunner(pj.id); noteRunner(hj.id);

  // 新しい MCP サーバ
  const mgrB = new JobManager({ cfg: cfgFor(dir), kinds: kindsProc() });
  const vb = mgrB.status(pj.id);
  check("再起動後も status が引ける(running・進捗が復元される・ownedByMe:false・orphaned)", vb.state === "running" && typeof vb.progress.pct === "number" && vb.ownedByMe === false && vb.orphaned === true, vb);
  const fin = await waitFor(() => mgrB.status(pj.id).state === "succeeded", 20000, 60);
  check("前のサーバのジョブが再起動後に完了 → succeeded・結果(summary)も引ける", fin && (mgrB.result(pj.id).result as any)?.summary?.result?.tris === 12345, mgrB.status(pj.id));
  check("mgr B の list に前のジョブが出る", mgrB.list().jobs.some((j) => j.id === pj.id));
  const ivw = mgrB.status(ij.id);
  check("inproc ジョブは owner が消えたので failed・E_JOB_INTERRUPTED", ivw.state === "failed" && ivw.error?.code === "E_JOB_INTERRUPTED", ivw);
  // 孤児(owner 死亡)のジョブは新しいサーバから止められる
  const hv = await mgrB.cancel(hj.id);
  check("孤児のジョブは別セッションから cancel できる(プロセスツリーが消える)", hv.state === "cancelled", hv);
  const hPid = mgrB.store.load(hj.id)?.runnerPid;
  check("…runner が終了している", !hPid || await waitFor(() => !pidAlive(hPid), 6000, 50));
  mgrB.shutdownSync();

  // 他の生きたセッションのジョブは止められない(force で止める)
  const sleeper = spawnSleeper(60_000); track(sleeper.pid);
  const dirC = mk("jobs-foreign");
  const mgrOther = new JobManager({ cfg: cfgFor(dirC), kinds: kindsProc(), ownerPid: sleeper.pid });
  const fj = await mgrOther.start({ kind: "ue_import", args: {} });
  await waitFor(() => !!mgrOther.store.readLive(fj.id)?.childPid, 8000, 50);
  noteRunner(fj.id);
  const mgrMe = new JobManager({ cfg: cfgFor(dirC), kinds: kindsProc() });
  const e = await fails(() => mgrMe.cancel(fj.id));
  check("生きている他のセッションのジョブは E_JOB_NOT_OWNER(force が要る)", e?.code === "E_JOB_NOT_OWNER" && e.fix?.[0]?.args?.force === true, e);
  const forced = await mgrMe.cancel(fj.id, { force: true });
  check("force:true なら止められる", forced.state === "cancelled", forced);
  mgrMe.shutdownSync(); mgrOther.shutdownSync();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[7] 冪等キー・guarded・inproc・long-poll・エラー");
{
  const dir = mk("jobs-misc");
  let released = false;
  const kinds: KindDef[] = [
    ...kindsProc(),
    inprocKind("bench", async (a, ctx) => {
      ctx.setEngine("e-test");
      for (let i = 1; i <= 5; i++) { if (ctx.signal.aborted) throw new Error("aborted"); ctx.progress({ phase: "benchmark", pct: i * 20, message: `run ${i}/5` }); ctx.log(`run ${i}`); await sleep(80); }
      const f = path.join(ctx.artifactsDir, "a.txt"); fs.writeFileSync(f, "x"); ctx.addArtifact({ path: f, kind: "file" });
      return { summary: { runs: 5, fps: 123 }, result: { detail: [1, 2, 3] } };
    }),
    inprocKind("playtest", async (a, ctx) => { ctx.progress({ phase: "playing", pct: 10, message: "start" }); await new Promise<void>((res) => { const t = setInterval(() => { if (ctx.signal.aborted || released) { clearInterval(t); res(); } }, 20); }); if (ctx.signal.aborted) throw new Error("aborted"); return { summary: { ran: 0 } }; }, "engine:test2"),
    inprocKind("screenshot_batch", async () => { throw new JobFailure({ code: "E_ENGINE_UNREACHABLE", message: "エンジンに繋がらない", retryable: true }); }, "engine:test3"),
    { kind: "external", executor: "process", describe: "x", group: () => "external", timeoutSec: 30, shape: {}, check(a, c) { if (!c.approved) throw new JobFailure({ code: "E_GUARDED", message: "承認が要る" }); }, prepare() { const c = nodeCmd("protocol", ["--steps", "2", "--delay", "10"]); return { cmd: c.cmd, args: c.args, cwd: os.tmpdir(), parser: { type: "protocol" } }; } },
  ];
  const m = new JobManager({ cfg: cfgFor(dir), kinds });

  // 冪等キー
  const k1 = await m.start({ kind: "vg_cook", args: { fake: ["--steps", "2", "--delay", "20"] }, idempotencyKey: "key-A" });
  const k2 = await m.start({ kind: "vg_cook", args: { fake: ["--steps", "2", "--delay", "20"] }, idempotencyKey: "key-A" });
  check("同じ冪等キーの再送は同じジョブ(idempotentReplay:true)・新しいジョブを作らない", k2.id === k1.id && k2.idempotentReplay === true && m.list({ kind: "vg_cook" }).jobs.length === 1, { k1: k1.id, k2: k2.id });
  const kc = await fails(() => m.start({ kind: "vg_cook", args: { fake: ["--steps", "9"] }, idempotencyKey: "key-A" }));
  check("同じキーで別の引数は E_IDEMPOTENCY_CONFLICT(既存のジョブ id つき)", kc?.code === "E_IDEMPOTENCY_CONFLICT" && kc.details?.existingJob === k1.id, kc);
  await waitFor(() => m.status(k1.id).state === "succeeded", 10000, 40);

  // guarded
  const g = await fails(() => m.start({ kind: "external", args: {} }));
  check("external は承認無しで E_GUARDED(ジョブは作られない)", g?.code === "E_GUARDED" && m.list({ kind: "external" }).jobs.length === 0, g);
  const ga = await m.start({ kind: "external", args: {}, approved: true });
  await waitFor(() => m.status(ga.id).state === "succeeded", 10000, 40);
  check("承認済みなら走る", m.status(ga.id).state === "succeeded", m.status(ga.id));

  // kind の打ち間違い
  const bk = await fails(() => m.start({ kind: "biuld", args: {} }));
  check("kind の打ち間違いは E_BAD_ENUM + didYouMean", bk?.code === "E_BAD_ENUM" && bk.didYouMean?.[0] === "build", bk);

  // inproc + long-poll
  const ib = await m.start({ kind: "bench", args: {} });
  const ticks: { pct: number | null; phase: string }[] = [];
  const t0 = Date.now();
  const wv = await m.wait(ib.id, { waitMs: 8000, onProgress: (v) => ticks.push({ pct: v.progress.pct, phase: v.progress.phase }) });
  check(`long-poll(waitMs)は終了まで待って返す(${Date.now() - t0} ms)・onProgress が複数回(進捗通知の材料)`, wv.state === "succeeded" && ticks.length >= 4 && ticks.some((t) => t.pct === 60), { state: wv.state, ticks });
  check("inproc: summary・artifacts・engine・logs・result", (wv.summary as any)?.fps === 123 && wv.artifacts.length === 1 && wv.engine === "e-test" && m.logs(ib.id, 10).lines.length === 5 && (m.result(ib.id).result as any)?.result?.detail?.length === 3, wv);
  const ic = await m.start({ kind: "bench", args: {} });
  const cv = await m.wait(ic.id, { waitMs: 60, until: "change" });
  check("waitMs が尽きたら進行中のまま返す(ジョブは続く)", cv.state === "running" || cv.state === "queued", cv.state);
  const cc = await m.cancel(ic.id);
  check("inproc のキャンセル(AbortSignal)→ cancelled", cc.state === "cancelled", cc);

  // 同じ group(engine:test2)の inproc は 1 本ずつ
  const p1 = await m.start({ kind: "playtest", args: {} });
  const p2 = await m.start({ kind: "playtest", args: {} });
  await sleep(150);
  check("engine 系は同じエンジンで 1 本ずつ(2 本目は queued)", m.status(p1.id).state === "running" && m.status(p2.id).state === "queued" && m.status(p2.id).queuePosition === 1, { a: m.status(p1.id).state, b: m.status(p2.id).state });
  released = true;
  await waitFor(() => m.status(p2.id).state === "succeeded", 5000, 30);
  check("1 本目が終われば 2 本目が走る", m.status(p1.id).state === "succeeded" && m.status(p2.id).state === "succeeded");

  // inproc の構造化エラー
  const sb = await m.start({ kind: "screenshot_batch", args: {} });
  await waitFor(() => m.status(sb.id).state === "failed", 5000, 30);
  check("inproc が JobFailure を投げたら failed + error(code)が残る", m.status(sb.id).error?.code === "E_ENGINE_UNREACHABLE", m.status(sb.id).error);

  // エラー
  const nf = await fails(() => Promise.resolve(m.status("j-20260101-000000-abcd")));
  check("存在しない id は E_JOB_NOT_FOUND + fix(dx12_job_list)", nf?.code === "E_JOB_NOT_FOUND" && nf.fix?.[0]?.tool === "dx12_job_list", nf);
  const bad = await fails(() => Promise.resolve(m.status("../../etc/passwd")));
  check("id はパス走査できない(形式外は not found)", bad?.code === "E_JOB_NOT_FOUND", bad);
  const hj = await m.start({ kind: "ue_import", args: {} });
  const nfin = await fails(() => Promise.resolve(m.result(hj.id)));
  check("終わっていないジョブの result は E_JOB_NOT_FINISHED + 待つ fix", nfin?.code === "E_JOB_NOT_FINISHED" && nfin.fix?.[0]?.tool === "dx12_job_status", nfin);
  noteRunner(hj.id);
  await m.cancel(hj.id);
  const summ = m.summary() as any;
  check("summary(doctor 用)に件数・上限・active が載る", summ.enabled === true && typeof summ.counts.succeeded === "number" && summ.limits.maxRunning === 3, summ);
  m.shutdownSync();
}

// ── 後始末 ─────────────────────────────────────────────────────────────────
for (const p of runnerPids) { try { killTreeSync(p); } catch { /* 無視 */ } }
killTracked();
mgr.shutdownSync();
await sleep(200);
for (const d of dirs) rmTree(d);
{
  const s = new JobStore(mk("gc-test"));
  const now = Date.now();
  for (let i = 0; i < 5; i++) s.create({ version: 1, id: newJobId(now + i * 1000), kind: "build", args: {}, executor: "process", state: i === 4 ? "running" : "succeeded", createdAt: now - (i === 0 ? 30 : 1) * 86400_000, finishedAt: now - (i === 0 ? 30 : 1) * 86400_000, owner: { pid: 1, startMs: 0 }, timeoutMs: 1000, progress: { phase: "done", pct: 100, message: "", etaSec: null, updatedAt: now }, artifacts: [], group: "build" });
  const removed = s.gc({ keepDays: 7, keepMax: 2, terminal: (r) => r.state !== "running" && r.state !== "queued", now });
  check("gc: 7 日超と keepMax 超の古い終了ジョブだけ消す(動いているものは残す)", removed.length === 2 && s.all().length === 3 && s.all().some((r) => r.state === "running"), removed);
  rmTree(s.dir);
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: jobs テスト ${total} 項目すべて通過`);
process.exit(0);
