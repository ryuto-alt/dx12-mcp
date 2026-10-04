// ジョブ管理(start / status / list / cancel / result / logs)。設計は docs/MCP_FLEET_DESIGN.md「ジョブ API(M6)」。
//
//   ・process 型(build / ctest / ui_tests / external / vg_cook / ue_import): 切り離した runner プロセス(runner.ts)が子を走らせる。
//     MCP サーバが再起動しても走り続け、再起動後の status は state.json + live.json から復元する。
//   ・inproc 型(bench / playtest / screenshot_batch): MCP サーバ内でエンジンを呼ぶ。サーバが終わると中断される(次回 reconcile が failed にする)。
//   ・同時実行: 総数の上限 + group ごとの上限(build は常に 1 = build.ps1 の排他ロックと整合)。順番待ちは queuePosition。
//   ・キャンセル: process 型は runner のプロセスツリーを taskkill /T /F(自分が記録した pid で、イメージ名が node のときだけ)。inproc 型は AbortSignal +
//     エンジン側の cancel。タイムアウトも同じ経路で終わらせる。
//   ・state.json の書き手は manager だけ(live.json の書き手は runner だけ)。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { z } from "zod";
import type { ErrorBody, Fix } from "../errors.ts";
import { nearest } from "../errors.ts";
import { isProcessOf, killTree, killTreeSync, pidAlive, sleep } from "../fleet/proc.ts";
import type { JobsConfig } from "./config.ts";
import { JobStore, newJobId, writeJsonAtomic } from "./store.ts";
import {
  isTerminal, JOB_KINDS,
  type JobArtifact, type JobError, type JobKind, type JobRecord, type JobStateName, type JobView, type LiveInfo, type ParserSpec, type Progress, type RunnerSpec,
} from "./types.ts";

/** ツールが構造化エラーとして返す失敗。 */
export class JobFailure extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) { super(body.message); this.name = "JobFailure"; this.body = body; }
}
export const jobFail = (body: ErrorBody): never => { throw new JobFailure(body); };

// ── ジョブ種別の定義 ───────────────────────────────────────────────────────
export type ProcessPlan = {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  parser: ParserSpec;
  tailFile?: string;
  junit?: string;
  /** 終了後(成功・失敗どちらでも)に manager が呼ぶ後始末(exe コピーの削除など)。 */
  cleanup?: () => void | Promise<void>;
  /** 成功したときだけ呼ぶ後処理。返したオブジェクトは summary へ足される(例 build の refreshEngines)。 */
  post?: (rec: JobRecord, summary: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /** 失敗時の summary の補足(JUnit の失敗一覧を入れるなど)。result.json の内容を受け取る。 */
  enrich?: (result: any, summary: Record<string, unknown>) => Record<string, unknown> | void;
  artifacts?: JobArtifact[];
  notes?: string[];
  belowNormal?: boolean;
};

export type InprocCtx = {
  job: JobRecord;
  signal: AbortSignal;
  progress: (u: { phase?: string; pct?: number | null; message?: string; etaSec?: number | null; estimated?: boolean }) => void;
  log: (line: string) => void;
  artifactsDir: string;
  addArtifact: (a: JobArtifact) => void;
  /** このジョブが使うエンジンの id を記録する(status に出る・アイドル終了を防ぐ)。 */
  setEngine: (id: string) => void;
};
export type InprocOutcome = { summary: Record<string, unknown>; result?: unknown; ok?: boolean; error?: JobError };

export type KindDef = {
  kind: JobKind;
  executor: "process" | "inproc";
  describe: string;
  /** 同時実行の分類。build は "build"(1 本)、engine 系は "engine:<id>"。 */
  group: (args: Record<string, unknown>, ctx: KindCtx) => string;
  timeoutSec: number;
  shape: Record<string, z.ZodTypeAny>;
  /** 引数の追加検証(shape で表せない相互制約)。失敗は JobFailure を投げる。 */
  check?: (args: Record<string, unknown>, ctx: KindCtx) => void;
  prepare?: (args: Record<string, unknown>, ctx: PrepareCtx) => ProcessPlan | Promise<ProcessPlan>;
  run?: (args: Record<string, unknown>, ctx: InprocCtx) => Promise<InprocOutcome>;
  /** 引数の正規化(既定値の補完など。state.json の args に残る)。 */
  normalize?: (args: Record<string, unknown>) => Record<string, unknown>;
};

/** kinds が manager から受け取る環境(テストでは差し替える)。 */
export type KindCtx = {
  cfg: JobsConfig;
  /** raw external など「承認が要る」起動が、承認済みの経路(dx12_call_guarded / confirm)から来たか。 */
  approved: boolean;
};
export type PrepareCtx = KindCtx & { job: JobRecord; jobDir: string; /** この種類の直近の所要時間(秒)の中央値(進捗の見積もりに使う)。 */ typicalSec: number | null };

export type ManagerDeps = {
  cfg: JobsConfig;
  store?: JobStore;
  now?: () => number;
  ownerPid?: number;
  kinds: KindDef[];
  /** アイドル自動終了(フリート)を防ぐため、走っている engine 系ジョブのエンジンへ定期的に触る。 */
  touchEngine?: (engineId: string) => void;
  /** 走らせる runner の起動(テストで差し替える。既定は node runner.ts を切り離して起動)。 */
  spawnRunner?: (specFile: string) => { pid: number | undefined };
  /** MCP サーバ内の inproc ジョブの実行環境の受け渡し(kinds 側が使う)。 */
  onEvent?: (kind: string, message: string, id?: string) => void;
};

const sig = (p: Progress, state: JobStateName) => `${state}|${p.phase}|${p.pct}|${p.message}`;

type Running = {
  rec: JobRecord;
  abort?: AbortController;
  promise?: Promise<void>;
  plan?: ProcessPlan;
  dirty: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  finalizing?: boolean;
  /** launch() の準備(exe のコピーなど)中。この間は runner がまだ無いので「runner が消えた」と誤判定しない。 */
  launching?: boolean;
};

export class JobManager {
  readonly cfg: JobsConfig;
  readonly store: JobStore;
  readonly owner: { pid: number; startMs: number };
  private now: () => number;
  private kinds = new Map<JobKind, KindDef>();
  private running = new Map<string, Running>();
  private queue: { id: string; approved: boolean }[] = [];
  private seqs = new Map<string, { sig: string; seq: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastGc = 0;
  private deps: ManagerDeps;
  private shuttingDown = false;
  private pumping = false;
  /** 直近の出来事(doctor が読む)。 */
  readonly events: { at: number; kind: string; id?: string; message: string }[] = [];

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.now = deps.now ?? Date.now;
    this.store = deps.store ?? new JobStore(deps.cfg.dir);
    this.owner = { pid: deps.ownerPid ?? process.pid, startMs: this.now() - Math.round(process.uptime() * 1000) };
    for (const k of deps.kinds) this.kinds.set(k.kind, k);
    this.reconcile();
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.pollMs);
    this.timer.unref?.();
  }

  private log(kind: string, message: string, id?: string) {
    this.events.push({ at: this.now(), kind, message, ...(id ? { id } : {}) });
    if (this.events.length > 50) this.events.shift();
    this.deps.onEvent?.(kind, message, id);
  }

  kindDef(kind: string): KindDef | undefined { return this.kinds.get(kind as JobKind); }
  kindNames(): string[] { return [...this.kinds.keys()]; }

  private isMine(rec: JobRecord): boolean { return rec.owner.pid === this.owner.pid && rec.owner.startMs === this.owner.startMs; }
  private ownerAlive(rec: JobRecord): boolean { return this.isMine(rec) || pidAlive(rec.owner.pid); }

  // ── 起動時の復元 ────────────────────────────────────────────────────────────
  /** 前の MCP サーバが残したジョブを整える。process 型は live.json から状態を復元し、inproc 型は owner が死んでいれば中断扱いにする。 */
  reconcile() {
    for (const rec of this.store.all()) {
      if (isTerminal(rec.state) || this.isMine(rec)) continue;
      this.reconcileForeign(rec);
    }
  }

  /** 他のセッション(前の MCP サーバなど)のジョブ 1 件を、いまの実態に合わせる。 */
  private reconcileForeign(rec: JobRecord) {
    if (isTerminal(rec.state)) return;
    if (rec.state === "queued") {
      if (!this.ownerAlive(rec)) {
        this.finishRec(rec, "cancelled", { error: { code: "E_JOB_INTERRUPTED", message: "MCP サーバが終了したため、開始される前に中断された" } });
        this.log("reconcile", `${rec.id}(${rec.kind}): 開始前に owner が消えた`, rec.id);
      }
      return;
    }
    if (rec.executor === "process") { this.syncProcess(rec, false); return; }
    if (!this.ownerAlive(rec)) {
      this.finishRec(rec, "failed", { error: { code: "E_JOB_INTERRUPTED", message: "MCP サーバが再起動(終了)したため、実行中に中断された。同じ引数で dx12_job_start し直す" } });
      this.log("reconcile", `${rec.id}(${rec.kind}): 実行中に owner が消えた`, rec.id);
    }
  }

  // ── start ─────────────────────────────────────────────────────────────────
  async start(input: { kind: string; args?: Record<string, unknown>; engine?: string; idempotencyKey?: string; timeoutSec?: number; approved?: boolean }): Promise<JobView> {
    if (this.cfg.disabled) return jobFail({ code: "E_JOB_DISABLED", message: "ジョブ API が無効(DX12_JOBS_DISABLE=1)", retryable: false });
    const def = this.kinds.get(input.kind as JobKind);
    if (!def) {
      const names = [...this.kinds.keys()];
      return jobFail({
        code: "E_BAD_ENUM", message: `dx12_job_start: kind '${input.kind}' は無い`, validValues: names, didYouMean: nearest(String(input.kind), names, 3, { liberal: true }),
        fix: [{ tool: "dx12_job_start", args: { kind: nearest(String(input.kind), names, 1, { liberal: true })[0] ?? "build", args: {} }, why: "最も近い kind で撃ち直す" }],
        retryable: false,
      });
    }
    const ctx: KindCtx = { cfg: this.cfg, approved: !!input.approved };
    const args = def.normalize ? def.normalize({ ...(input.args ?? {}) }) : { ...(input.args ?? {}) };
    def.check?.(args, ctx);

    // 冪等キー: 同じキーの再送は前回のジョブを返す(新しいジョブを作らない)。別の kind / 引数なら衝突。
    const key = input.idempotencyKey?.trim() || undefined;
    if (key) {
      const nowMs = this.now();
      const prev = this.store.all().find((r) => r.idempotencyKey === key && nowMs - r.createdAt < 24 * 3600_000);
      if (prev) {
        if (prev.kind !== def.kind || JSON.stringify(prev.args) !== JSON.stringify(args)) {
          return jobFail({
            code: "E_IDEMPOTENCY_CONFLICT", message: `dx12_job_start: idempotencyKey '${key}' は別の要求(kind=${prev.kind})で使われている`, retryable: false,
            cause: "同じキーで kind または args が違う要求を送った。再送なら同じ要求をそのまま、別の処理なら別のキーにする",
            fix: [{ tool: "dx12_job_status", args: { id: prev.id }, why: "先に作られたジョブの状態を見る" }],
            details: { existingJob: prev.id, existingKind: prev.kind },
          });
        }
        return { ...this.viewOf(prev), idempotentReplay: true };
      }
    }

    const id = newJobId(this.now());
    const group = def.group(args, ctx);
    const timeoutSec = Math.max(1, Math.min(6 * 3600, input.timeoutSec ?? def.timeoutSec));
    const p = this.store.pathsOf(id);
    const rec: JobRecord = {
      version: 1, id, kind: def.kind, args, executor: def.executor, state: "queued", createdAt: this.now(),
      owner: { ...this.owner }, timeoutMs: timeoutSec * 1000,
      progress: { phase: "queued", pct: null, message: "順番待ち", etaSec: null, updatedAt: this.now() },
      artifacts: [], group,
      ...(input.engine ? { engine: input.engine } : {}), ...(key ? { idempotencyKey: key } : {}),
    };
    this.store.create(rec);
    fs.mkdirSync(p.dir, { recursive: true });
    this.running.set(id, { rec, dirty: false });   // queued の間も自分のジョブとして追う
    this.queue.push({ id, approved: ctx.approved });
    this.log("start", `${def.kind} を受け付けた(group=${group})`, id);
    void this.pump();
    return this.viewOf(rec);
  }

  // ── スケジューラ ────────────────────────────────────────────────────────────
  private runningCount(group?: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.rec.state === "running" && (group === undefined || r.rec.group === group)) n++;
    return n;
  }
  private capOf(group: string): number {
    if (group.startsWith("engine:")) return 1;
    return this.cfg.groupCap[group] ?? 1;
  }

  private async pump() {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    try {
      for (let guard = 0; guard < 64; guard++) {
        if (this.runningCount() >= this.cfg.maxRunning) break;
        const idx = this.queue.findIndex((q) => {
          const r = this.running.get(q.id)?.rec;
          return !!r && this.runningCount(r.group) < this.capOf(r.group);
        });
        if (idx < 0) break;
        const [q] = this.queue.splice(idx, 1);
        const entry = this.running.get(q.id);
        if (!entry || entry.rec.state !== "queued") continue;
        await this.launch(entry, q.approved);
      }
    } finally { this.pumping = false; }
  }

  private setProgress(rec: JobRecord, u: { phase?: string; pct?: number | null; message?: string; etaSec?: number | null; estimated?: boolean }) {
    const cur = rec.progress;
    const next: Progress = {
      phase: u.phase ?? cur.phase,
      pct: u.pct !== undefined ? u.pct : cur.pct,
      message: u.message ?? cur.message,
      etaSec: u.etaSec !== undefined ? u.etaSec : cur.etaSec,
      updatedAt: this.now(),
    };
    if (u.estimated || (u.estimated === undefined && cur.estimated && u.pct === undefined)) next.estimated = true;
    rec.progress = next;
  }

  private async launch(entry: Running, approved: boolean) {
    const rec = entry.rec;
    const def = this.kinds.get(rec.kind)!;
    rec.state = "running";
    rec.startedAt = this.now();
    entry.launching = true;
    this.setProgress(rec, { phase: "preparing", pct: null, message: "準備中", etaSec: null });
    this.store.save(rec);
    this.log("launch", `${rec.kind} を開始`, rec.id);
    const p = this.store.pathsOf(rec.id);
    try {
      if (def.executor === "process") {
        const plan = await def.prepare!(rec.args, { cfg: this.cfg, approved, job: rec, jobDir: p.dir, typicalSec: this.store.typicalSec(rec.kind) });
        entry.plan = plan;
        if (plan.artifacts) rec.artifacts.push(...plan.artifacts);
        if (plan.notes) rec.notes = plan.notes;
        const spec: RunnerSpec = {
          jobId: rec.id, cmd: plan.cmd, args: plan.args, cwd: plan.cwd, env: plan.env ?? {}, timeoutMs: rec.timeoutMs, parser: plan.parser,
          ...(plan.tailFile ? { tailFile: plan.tailFile } : {}), ...(plan.junit ? { junit: plan.junit } : {}),
          logFile: p.log, liveFile: p.live, resultFile: p.result, logMaxBytes: this.cfg.logMaxBytes, belowNormal: plan.belowNormal !== false,
        };
        writeJsonAtomic(p.spec, spec);
        try { fs.rmSync(p.live, { force: true }); } catch { /* 無視 */ }
        const r = (this.deps.spawnRunner ?? this.defaultSpawnRunner.bind(this))(p.spec);
        rec.runnerPid = r.pid;
        this.setProgress(rec, { phase: "starting", pct: null, message: "起動中" });
        this.store.save(rec);
        entry.launching = false;
      } else {
        const abort = new AbortController();
        entry.abort = abort;
        const ctx: InprocCtx = {
          job: rec, signal: abort.signal, artifactsDir: p.artifacts,
          progress: (u) => { this.setProgress(rec, u); entry.dirty = true; },
          log: (line) => { try { fs.appendFileSync(p.log, line + "\n"); } catch { /* 無視 */ } },
          addArtifact: (a) => { rec.artifacts.push(a); entry.dirty = true; },
          setEngine: (id) => { rec.engine = id; entry.dirty = true; },
        };
        fs.mkdirSync(p.artifacts, { recursive: true });
        this.setProgress(rec, { phase: "running", pct: 0, message: "開始" });
        entry.promise = (async () => {
          try {
            const out = await def.run!(rec.args, ctx);
            if (entry.finalizing || isTerminal(rec.state)) return;
            if (out.ok === false || out.error) this.finishRec(rec, "failed", { summary: out.summary, error: out.error ?? { code: "E_JOB_FAILED", message: "ジョブが失敗した" }, result: out.result });
            else this.finishRec(rec, "succeeded", { summary: out.summary, result: out.result });
          } catch (e: any) {
            if (entry.finalizing || isTerminal(rec.state)) return;
            if (abort.signal.aborted) { this.finishRec(rec, abort.signal.reason === "timeout" ? "timeout" : "cancelled", {}); return; }
            const body: ErrorBody | null = e instanceof JobFailure ? e.body : null;
            this.finishRec(rec, "failed", { error: body ? bodyToJobError(body) : { code: e?.errName && String(e.errName).startsWith("E_") ? String(e.errName) : "E_INTERNAL", message: String(e?.message ?? e).slice(0, 500) } });
          }
        })();
      }
      entry.launching = false;
      entry.timeoutTimer = setTimeout(() => { void this.timeoutJob(rec.id); }, rec.timeoutMs + (def.executor === "process" ? 20_000 : 0));
      entry.timeoutTimer.unref?.();
    } catch (e: any) {
      entry.launching = false;
      const body: ErrorBody | null = e instanceof JobFailure ? e.body : null;
      this.finishRec(rec, "failed", { error: body ? bodyToJobError(body) : { code: "E_INTERNAL", message: `${rec.kind}: 準備に失敗した: ${String(e?.message ?? e).slice(0, 400)}` } });
    }
  }

  private defaultSpawnRunner(specFile: string): { pid: number | undefined } {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", this.cfg.runnerScript, specFile], {
      detached: true, stdio: "ignore", windowsHide: true, cwd: path.dirname(specFile),
    });
    child.on("error", () => { /* live.json が出ない → syncProcess が runner の死亡として failed にする */ });
    child.unref();
    return { pid: child.pid };
  }

  private async timeoutJob(id: string) {
    const entry = this.running.get(id);
    if (!entry || isTerminal(entry.rec.state)) return;
    if (entry.rec.executor === "inproc") { entry.abort?.abort("timeout"); await this.waitSettled(entry, 8000); if (!isTerminal(entry.rec.state)) this.finishRec(entry.rec, "timeout", {}); return; }
    this.syncProcess(entry.rec, true);   // runner が先に timeout を書いていればそちらを採用
    if (isTerminal(entry.rec.state)) return;
    await this.killRunner(entry.rec);
    this.finishRec(entry.rec, "timeout", { error: { code: "E_JOB_TIMEOUT", message: `タイムアウト(${Math.round(entry.rec.timeoutMs / 1000)} 秒)。プロセスツリーを終了した` } });
  }

  // ── process 型の状態同期(live.json → rec) ────────────────────────────────
  /** live.json を読んで rec を更新する。終わっていれば確定する。true=状態が変わった。 */
  private syncProcess(rec: JobRecord, mine: boolean): boolean {
    if (rec.executor !== "process" || isTerminal(rec.state) || rec.state === "queued") return false;
    if (this.running.get(rec.id)?.launching) return false;
    const live = this.store.readLive(rec.id);
    let changed = false;
    if (live) {
      if (live.childPid && live.childPid !== rec.childPid) { rec.childPid = live.childPid; changed = true; }
      if (live.runnerPid && live.runnerPid !== rec.runnerPid) { rec.runnerPid = live.runnerPid; changed = true; }
      if (live.progress) {
        const cur = rec.progress;
        if (cur.phase !== live.progress.phase || cur.pct !== live.progress.pct || cur.message !== live.progress.message) {
          this.setProgress(rec, { phase: live.progress.phase, pct: live.progress.pct, message: live.progress.message, estimated: live.progress.estimated ?? false });
          rec.progress.etaSec = this.etaOf(rec, live.progress.pct);
          if (!live.progress.estimated) delete rec.progress.estimated;
          changed = true;
        }
      }
      if (live.finishedAt) { this.finishFromLive(rec, live); return true; }
    }
    // runner が死んだのに live.json に終了が無い = 異常終了。起動直後(まだ live.json が無い)は猶予を持つ。
    const started = rec.startedAt ?? rec.createdAt;
    // 生死は pidAlive(安価・失敗しない)で見る。tasklist(イメージ名の確認)は、心拍(live.json の updatedAt)が止まっているときだけ = pid の使い回しの疑いがあるときだけ。
    const hbStale = !!live && this.now() - live.updatedAt > 45_000;
    const runnerGone = rec.runnerPid ? (!pidAlive(rec.runnerPid) || (hbStale && !isProcessOf(rec.runnerPid, path.basename(process.execPath)))) : true;
    if (runnerGone && this.now() - started > (live ? 1500 : 8000)) {
      const again = this.store.readLive(rec.id);   // 死亡直後の最終書き込みを取りこぼさない
      if (again?.finishedAt) { this.finishFromLive(rec, again); return true; }
      this.finishRec(rec, "failed", { error: { code: "E_JOB_RUNNER_LOST", message: "ジョブの runner が終了結果を残さずに消えた(強制終了・異常終了)。ログを確認する", details: { runnerPid: rec.runnerPid ?? null } } });
      return true;
    }
    if (changed && mine) { const e = this.running.get(rec.id); if (e) e.dirty = true; }
    return changed;
  }

  private etaOf(rec: JobRecord, pct: number | null | undefined): number | null {
    if (pct == null || pct < 1 || pct >= 99 || !rec.startedAt) return rec.progress.etaSec ?? null;
    if (rec.progress.phase === "waiting_lock") return null;
    const el = (this.now() - rec.startedAt) / 1000;
    if (el < 3) return null;
    return Math.max(0, Math.round((el * (100 - pct)) / pct));
  }

  private finishFromLive(rec: JobRecord, live: LiveInfo) {
    const result = this.store.readResult<any>(rec.id);
    const summary: Record<string, unknown> = { ...(result?.summary ?? {}) };
    const entry = this.running.get(rec.id);
    const extra = entry?.plan?.enrich?.(result, summary);
    if (extra) Object.assign(summary, extra);
    if (result?.junit && !summary.junit) summary.junit = { tests: result.junit.tests, failures: result.junit.failures, errors: result.junit.errors, skipped: result.junit.skipped, failed: (result.junit.failed ?? []).slice(0, 30) };
    rec.exitCode = live.exitCode ?? null;
    const tail: string[] = (result?.tail ?? []).slice(-15);
    if (live.spawnError) {
      this.finishRec(rec, "failed", { summary, error: { code: "E_JOB_TOOL_MISSING", message: `プロセスを起動できない: ${live.spawnError.message}`, details: { spawnError: live.spawnError, cmd: entry?.plan?.cmd } } });
    } else if (live.timedOut) {
      this.finishRec(rec, "timeout", { summary, error: { code: "E_JOB_TIMEOUT", message: `タイムアウト(${Math.round(rec.timeoutMs / 1000)} 秒)。プロセスツリーを終了した`, details: { tail } } });
    } else if (live.exitCode === 0) {
      this.finishRec(rec, "succeeded", { summary });
    } else {
      this.finishRec(rec, "failed", { summary, error: { code: "E_JOB_FAILED", message: `終了コード ${live.exitCode}${live.signal ? `(${live.signal})` : ""} で失敗した`, details: { exitCode: live.exitCode, errors: (summary as any).errors?.slice?.(0, 5), failedTests: (summary as any).failedTests?.slice?.(0, 5), tail } } });
    }
  }

  // ── 確定 ──────────────────────────────────────────────────────────────────
  private finishRec(rec: JobRecord, state: JobStateName, o: { summary?: Record<string, unknown>; error?: JobError; result?: unknown }) {
    if (isTerminal(rec.state)) return;
    const entry = this.running.get(rec.id);
    if (entry) { entry.finalizing = true; if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer); }
    rec.state = state;
    rec.finishedAt = this.now();
    if (o.summary) rec.summary = o.summary;
    if (o.error) rec.error = o.error;
    const done = state === "succeeded";
    this.setProgress(rec, {
      phase: done ? "done" : state, pct: done ? 100 : rec.progress.pct, etaSec: null,
      message: done ? "完了" : state === "cancelled" ? "キャンセルされた" : state === "timeout" ? "タイムアウト" : (o.error?.message ?? "失敗").slice(0, 200),
    });
    delete rec.progress.estimated;
    const p = this.store.pathsOf(rec.id);
    if (o.result !== undefined) { try { writeJsonAtomic(p.result, { kind: rec.kind, jobId: rec.id, state, summary: rec.summary ?? null, result: o.result, finishedAt: rec.finishedAt }); } catch { /* 無視 */ } }
    else if (rec.executor === "inproc" && !fs.existsSync(p.result)) { try { writeJsonAtomic(p.result, { kind: rec.kind, jobId: rec.id, state, summary: rec.summary ?? null, finishedAt: rec.finishedAt }); } catch { /* 無視 */ } }
    try { this.store.save(rec); } catch { /* 保存できなくても状態はメモリに残る */ }
    if (state === "succeeded" && rec.startedAt) this.store.recordDuration(rec.kind, (rec.finishedAt - rec.startedAt) / 1000);
    this.log("finish", `${rec.kind} → ${state}`, rec.id);
    // 後始末と成功後の後処理(非同期。状態の確定は待たせない)
    const plan = entry?.plan;
    void (async () => {
      if (state === "succeeded" && plan?.post) {
        try {
          const extra = await plan.post(rec, rec.summary ?? {});
          if (extra) { rec.summary = { ...(rec.summary ?? {}), ...extra }; this.store.save(rec); }
        } catch (e: any) { rec.notes = [...(rec.notes ?? []), `後処理に失敗: ${String(e?.message ?? e).slice(0, 200)}`]; try { this.store.save(rec); } catch { /* 無視 */ } }
      }
      try { await plan?.cleanup?.(); } catch { /* 後始末の失敗でジョブの結果は変えない */ }
      this.running.delete(rec.id);
      void this.pump();
    })();
    this.running.delete(rec.id);   // 以後は disk の記録が正(後処理の間に status が引かれても terminal で読める)
    void this.pump();
  }

  // ── 取得 ──────────────────────────────────────────────────────────────────
  /** 最新の rec(自分のジョブはメモリ、他のジョブは disk + live)。 */
  current(id: string): JobRecord | null {
    const m = this.running.get(id);
    if (m) { if (m.rec.executor === "process") this.syncProcess(m.rec, true); return m.rec; }
    const rec = this.store.load(id);
    if (!rec) return null;
    if (!isTerminal(rec.state)) this.reconcileForeign(rec);
    return rec;
  }

  private queuePositionOf(rec: JobRecord): number | null {
    if (rec.state !== "queued") return null;
    const same = this.queue.filter((q) => this.running.get(q.id)?.rec.group === rec.group);
    const i = same.findIndex((q) => q.id === rec.id);
    return i < 0 ? null : i + 1;
  }

  viewOf(rec: JobRecord): JobView {
    const p = this.store.pathsOf(rec.id);
    const nowMs = this.now();
    const s = sig(rec.progress, rec.state);
    let sq = this.seqs.get(rec.id);
    if (!sq) { sq = { sig: s, seq: 1 }; this.seqs.set(rec.id, sq); }
    else if (sq.sig !== s) { sq.sig = s; sq.seq++; }
    const mine = this.isMine(rec);
    const view: JobView = {
      id: rec.id, kind: rec.kind, state: rec.state,
      progress: { ...rec.progress, ...(rec.state === "running" ? { sinceChangeSec: Math.max(0, Math.round((nowMs - rec.progress.updatedAt) / 1000)) } : {}) },
      elapsedSec: rec.startedAt ? Math.round((((rec.finishedAt ?? nowMs) - rec.startedAt) / 1000) * 10) / 10 : null,
      queuePosition: this.queuePositionOf(rec),
      createdAt: rec.createdAt,
      ...(rec.startedAt ? { startedAt: rec.startedAt } : {}), ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
      ...(rec.exitCode !== undefined ? { exitCode: rec.exitCode } : {}),
      ...(rec.summary ? { summary: rec.summary } : {}), ...(rec.error ? { error: rec.error } : {}),
      artifacts: rec.artifacts, ...(rec.engine ? { engine: rec.engine } : {}),
      dir: p.dir, logPath: p.log, resultPath: fs.existsSync(p.result) ? p.result : null,
      ownedByMe: mine,
      ...(!isTerminal(rec.state) && !mine && !this.ownerAlive(rec) ? { orphaned: true } : {}),
      ...(rec.notes?.length ? { notes: rec.notes } : {}),
      typicalSec: this.store.typicalSec(rec.kind),
      seq: sq.seq,
    };
    return view;
  }

  status(id: string): JobView {
    const rec = this.current(id);
    if (!rec) return this.notFound(id);
    return this.viewOf(rec);
  }

  private notFound(id: string): never {
    const ids = this.store.ids().slice(-20).reverse();
    return jobFail({
      code: "E_JOB_NOT_FOUND", message: `ジョブ '${id}' は無い(または保存期間を過ぎて消えた)`, retryable: false, didYouMean: nearest(id, ids, 3),
      fix: [{ tool: "dx12_job_list", args: {}, why: "ジョブの一覧から id を確認する" }],
      details: { recent: ids.slice(0, 5) },
    });
  }

  /** long-poll: 終わるか waitMs 経つまで待つ。変化のたびに onProgress を呼ぶ(MCP の notifications/progress 用)。 */
  async wait(id: string, opts: { waitMs?: number; until?: "done" | "change"; onProgress?: (v: JobView) => void; signal?: AbortSignal } = {}): Promise<JobView> {
    const t0 = Date.now();
    let v = this.status(id);
    opts.onProgress?.(v);
    const waitMs = Math.max(0, Math.min(opts.waitMs ?? 0, 10 * 60_000));
    if (!waitMs || isTerminal(v.state)) return v;
    const step = Math.max(20, Math.min(250, this.cfg.pollMs));
    for (;;) {
      await sleep(Math.min(step, Math.max(1, waitMs - (Date.now() - t0))));
      if (opts.signal?.aborted) return v;
      const v2 = this.status(id);
      const changed = v2.seq !== v.seq;
      if (changed) opts.onProgress?.(v2);
      v = v2;
      if (isTerminal(v.state)) return v;
      if (changed && opts.until === "change") return v;
      if (Date.now() - t0 >= waitMs) return v;
    }
  }

  list(opts: { state?: string; kind?: string; limit?: number; mine?: boolean } = {}): { jobs: JobView[]; counts: Record<string, number>; total: number } {
    const fresh: JobRecord[] = [];
    for (const id of this.store.ids()) { const r = this.current(id); if (r) fresh.push(r); }
    const counts: Record<string, number> = {};
    for (const r of fresh) counts[r.state] = (counts[r.state] ?? 0) + 1;
    let sel = fresh;
    if (opts.state) sel = sel.filter((r) => opts.state === "active" ? !isTerminal(r.state) : r.state === opts.state);
    if (opts.kind) sel = sel.filter((r) => r.kind === opts.kind);
    if (opts.mine) sel = sel.filter((r) => this.isMine(r));
    sel = [...sel].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(200, opts.limit ?? 30)));
    return { jobs: sel.map((r) => this.viewOf(r)), counts, total: fresh.length };
  }

  result(id: string): { view: JobView; result: unknown; truncated: boolean } {
    const rec = this.current(id);
    if (!rec) return this.notFound(id);
    if (!isTerminal(rec.state)) {
      return jobFail({
        code: "E_JOB_NOT_FINISHED", message: `ジョブ ${id} はまだ ${rec.state}(進捗 ${rec.progress.pct ?? "?"}% ${rec.progress.phase})`, retryable: true,
        fix: [{ tool: "dx12_job_status", args: { id, waitSec: 30 }, why: "終わるまで待つ(最大 30 秒ずつ)" }],
        details: { state: rec.state, progress: rec.progress },
      });
    }
    const view = this.viewOf(rec);
    const raw = this.store.readResult<any>(id);
    if (raw === null) return { view, result: { summary: rec.summary ?? null, note: "result.json が無い(準備に失敗したジョブなど)" }, truncated: false };
    const text = JSON.stringify(raw);
    if (text.length > 200_000) {
      return { view, result: { summary: raw.summary ?? rec.summary ?? null, tail: raw.tail?.slice?.(-30), note: `結果が大きい(${text.length} バイト)ので要約だけ返す。全文は ${view.resultPath}`, resultPath: view.resultPath }, truncated: true };
    }
    return { view, result: raw, truncated: false };
  }

  logs(id: string, tail = 100): { view: JobView; lines: string[]; totalBytes: number; truncatedHead: boolean } {
    const rec = this.current(id);
    if (!rec) return this.notFound(id);
    const n = Math.max(1, Math.min(500, tail));
    const t = this.store.tailLog(id, n);
    return { view: this.viewOf(rec), ...t };
  }

  // ── cancel ────────────────────────────────────────────────────────────────
  private async killRunner(rec: JobRecord) {
    const live = this.store.readLive(rec.id);
    const runnerPid = rec.runnerPid ?? live?.runnerPid;
    const nodeImage = path.basename(process.execPath);
    // 自分が記録した runner の pid で、イメージ名が node のときだけ(pid の使い回しで無関係なプロセスを殺さない)
    if (runnerPid && isProcessOf(runnerPid, nodeImage)) await killTree(runnerPid);
    // runner が先に消えていて子だけ残っている場合(runner の異常終了)。子の pid も記録があれば、それだけを落とす。
    const childPid = live?.childPid ?? rec.childPid;
    if (childPid && pidAlive(childPid) && (!runnerPid || !pidAlive(runnerPid))) {
      // 子のイメージ名は分からない(cmd)ので、runner が生きていた/自分が起動した記録(childPid が live.json に載っている)ときだけ。
      if (live?.runnerPid === runnerPid) await killTree(childPid);
    }
  }

  private async waitSettled(entry: Running, ms: number) {
    if (!entry.promise) return;
    await Promise.race([entry.promise.catch(() => {}), sleep(ms)]);
  }

  async cancel(id: string, opts: { force?: boolean } = {}): Promise<JobView> {
    const rec = this.current(id);
    if (!rec) return this.notFound(id);
    if (isTerminal(rec.state)) return { ...this.viewOf(rec), notes: [...(rec.notes ?? []), "既に終わっている(キャンセルするものは無い)"] };
    if (!this.isMine(rec) && this.ownerAlive(rec) && !opts.force) {
      return jobFail({
        code: "E_JOB_NOT_OWNER", message: `ジョブ ${id} は別のセッション(pid ${rec.owner.pid})のもの。止められない`, retryable: false,
        cause: "他のセッションが起動したジョブは、そのセッションが生きている間は止めない(owner が消えた孤児は止められる)",
        fix: [{ tool: "dx12_job_cancel", args: { id, force: true }, why: "本当に止めるなら force:true(ユーザーの承認を得てから)" }],
        details: { owner: rec.owner },
      });
    }
    const entry = this.running.get(id);
    rec.cancelRequestedAt = this.now();
    if (rec.state === "queued") {
      this.queue = this.queue.filter((q) => q.id !== id);
      this.finishRec(rec, "cancelled", {});
      return this.viewOf(rec);
    }
    if (rec.executor === "inproc") {
      entry?.abort?.abort("cancel");
      if (entry) await this.waitSettled(entry, 10_000);
      if (!isTerminal(rec.state)) this.finishRec(rec, "cancelled", {});
      return this.viewOf(this.store.load(id) ?? rec);
    }
    await this.killRunner(rec);
    this.finishRec(rec, "cancelled", { summary: rec.summary });
    return this.viewOf(this.store.load(id) ?? rec);
  }

  // ── 定期処理 ───────────────────────────────────────────────────────────────
  async tick() {
    if (this.shuttingDown) return;
    const nowMs = this.now();
    for (const [id, entry] of [...this.running]) {
      const rec = entry.rec;
      if (rec.state === "running") {
        if (rec.executor === "process") this.syncProcess(rec, true);
        if (rec.engine && this.deps.touchEngine) { try { this.deps.touchEngine(rec.engine); } catch { /* 無視 */ } }
        if (entry.dirty && !isTerminal(rec.state)) { entry.dirty = false; try { this.store.save(rec); } catch { /* 無視 */ } }
      }
      void id;
    }
    void this.pump();
    if (nowMs - this.lastGc > 10 * 60_000) {
      this.lastGc = nowMs;
      try { this.store.gc({ keepDays: this.cfg.keepDays, keepMax: this.cfg.keepMax, protect: new Set(this.running.keys()), terminal: (r) => isTerminal(r.state) }); } catch { /* 無視 */ }
    }
  }

  /** doctor / dx12_guide が読む要約。 */
  summary(): Record<string, unknown> {
    const { jobs, counts } = this.list({ state: "active", limit: 50 });
    return {
      enabled: !this.cfg.disabled, dir: this.cfg.dir, counts,
      active: jobs.map((j) => ({ id: j.id, kind: j.kind, state: j.state, phase: j.progress.phase, pct: j.progress.pct, elapsedSec: j.elapsedSec, queuePosition: j.queuePosition, ownedByMe: j.ownedByMe, ...(j.orphaned ? { orphaned: true } : {}) })),
      limits: { maxRunning: this.cfg.maxRunning, groupCap: this.cfg.groupCap },
      recentFinished: this.list({ limit: 5 }).jobs.filter((j) => isTerminal(j.state)).slice(0, 3).map((j) => ({ id: j.id, kind: j.kind, state: j.state, finishedAt: j.finishedAt, error: j.error?.code })),
      events: this.events.slice(-5),
    };
  }

  /** MCP サーバの終了時(同期)。inproc ジョブは中断として記録。process 型は killOnExit のときだけ止める。 */
  shutdownSync() {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.running.values()) {
      const rec = entry.rec;
      if (isTerminal(rec.state)) continue;
      try {
        if (rec.executor === "inproc" || rec.state === "queued") {
          entry.abort?.abort("cancel");
          rec.state = rec.state === "queued" ? "cancelled" : "failed";
          rec.finishedAt = this.now();
          rec.error = { code: "E_JOB_INTERRUPTED", message: "MCP サーバが終了したため中断された" };
          this.store.save(rec);
        } else if (this.cfg.killOnExit) {
          const live = this.store.readLive(rec.id);
          const pid = rec.runnerPid ?? live?.runnerPid;
          if (pid && isProcessOf(pid, path.basename(process.execPath))) killTreeSync(pid);
          rec.state = "cancelled"; rec.finishedAt = this.now(); rec.error = { code: "E_JOB_INTERRUPTED", message: "MCP サーバの終了に合わせて止めた(DX12_JOBS_KILL_ON_EXIT)" };
          this.store.save(rec);
        }
      } catch { /* 終了処理の失敗で落とさない */ }
    }
  }
}

export function bodyToJobError(b: ErrorBody): JobError {
  return {
    code: b.code, message: b.message,
    ...(b.details ? { details: b.details } : {}),
    ...(b.fix ? { fix: b.fix as Fix[] } : {}),
  };
}

export { JOB_KINDS };
