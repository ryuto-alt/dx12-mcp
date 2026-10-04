// 子プロセスの出力から進捗・最終結果を取り出す純ロジック(runner と単体テストが使う)。
//
//   build    … tools\build.ps1 の出力: ninja の "[n/m] 説明" と "[build] ..." の行、MSVC のエラー行
//   ctest    … "n/N Test #k: 名前 ..... Passed 0.11 sec" と最後の要約
//   uitests  … DX12Engine.exe --ui-tests-run-all が dx12_engine.log に書く行(途中経過は出ないので経過時間から見積もる)
//   protocol … 標準出力の 1 行 JSON: @progress {"pct":42,"phase":"cook","msg":"…","eta":30} と @result {…}
//              将来の vg_cook / ue_cook はこれを出せば、そのままジョブの進捗になる。
import type { ParserSpec } from "./types.ts";

export type ProgressUpdate = {
  phase?: string;
  pct?: number | null;
  message?: string;
  etaSec?: number | null;
  estimated?: boolean;
};

export interface LineParser {
  feed(line: string, nowMs: number): ProgressUpdate | null;
  /** 行が来なくても時間で進む見積もり(ui_tests)。無ければ何もしない。 */
  tick?(nowMs: number): ProgressUpdate | null;
  /** 終了時の要約(status の summary / result.json の summary)。 */
  finish(exitCode: number | null): Record<string, unknown>;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** "C:\a\b\c.cpp.obj" → "c.cpp.obj"。長い説明は 100 字で切る。 */
function shortDesc(s: string): string {
  const t = s.trim();
  const m = /^(Building \S+ object|Linking \S+ (?:executable|static library|shared library|shared module)|Generating|Copying|Running|Custom Command|Compiling)\s+(.+)$/.exec(t);
  const out = m ? `${m[1]} ${m[2].split(/[\\/]/).pop()}` : t;
  return out.length > 100 ? out.slice(0, 99) + "…" : out;
}

// ── build ──────────────────────────────────────────────────────────────────
export type BuildError = { file?: string; line?: number; code?: string; message: string };

const RE_NINJA_STEP = /^\[(\d+)\/(\d+)\]\s+(.*)$/;
const RE_MSVC_ERR = /^(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(?:fatal )?error\s+([A-Z]+\d+)\s*:\s*(.*)$/;
const RE_LINK_ERR = /^(.+?)\s*:\s*(?:fatal )?error\s+(LNK\d+|D\d+|RC\d+)\s*:\s*(.*)$/;
const RE_WARN = /\bwarning\s+(?:C|LNK|D)\d+/;

export class BuildParser implements LineParser {
  private done = 0;
  private total = 0;
  private upToDate = false;
  private lockWaitSec: number | null = null;
  private waitingLock = false;
  private buildSeconds: number | null = null;
  private buildOk: boolean | null = null;
  private warnings = 0;
  private errors: BuildError[] = [];
  private seenErr = new Set<string>();
  private failedTargets: string[] = [];
  private lastPhase = "starting";

  feed(rawLine: string): ProgressUpdate | null {
    const line = stripAnsi(rawLine).trimEnd();
    if (!line) return null;
    const step = RE_NINJA_STEP.exec(line);
    if (step) {
      this.done = Number(step[1]);
      this.total = Number(step[2]);
      this.waitingLock = false;
      const desc = step[3];
      const phase = /^Linking\b/.test(desc) ? "link" : /^(Building|Compiling)\b/.test(desc) ? "compile" : /^Generating\b|^Custom Command|^Running\b/.test(desc) ? "generate" : "build";
      this.lastPhase = phase;
      return { phase, pct: this.total > 0 ? clampPct((this.done * 100) / this.total) : null, message: `[${this.done}/${this.total}] ${shortDesc(desc)}` };
    }
    if (/^\[build\] another build is running/.test(line)) {
      this.waitingLock = true;
      this.lastPhase = "waiting_lock";
      return { phase: "waiting_lock", pct: null, message: "他のビルドが走っている。排他ロック(Global\\dx12-build)の解放待ち" };
    }
    let m = /^\[build\] lock acquired after (\d+)s/.exec(line);
    if (m) { this.lockWaitSec = Number(m[1]); this.waitingLock = false; return { phase: "starting", pct: null, message: `ロックを取得(${m[1]} 秒待った)` }; }
    if (/^\[build\] lock timeout/.test(line)) { this.errors.push({ message: "ビルドの排他ロックを待ち切れなかった(lock timeout)" }); return { phase: "failed", message: "ロック待ちの上限に達した" }; }
    m = /^\[build\] cmake /.exec(line);
    if (m) { this.lastPhase = "configuring"; return { phase: "configuring", pct: null, message: "cmake --build を開始" }; }
    m = /^\[build\] (OK|FAILED) in ([\d.]+)s \(exit (-?\d+)\)/.exec(line);
    if (m) { this.buildOk = m[1] === "OK"; this.buildSeconds = Number(m[2]); return { phase: this.buildOk ? "done" : "failed", pct: this.buildOk ? 100 : undefined, message: `build.ps1: ${m[1]}(${m[2]} 秒)` }; }
    if (/^ninja: no work to do/.test(line)) { this.upToDate = true; return { phase: "up_to_date", pct: 100, message: "変更なし(ninja: no work to do)" }; }
    if (/^FAILED:\s+/.test(line)) { this.failedTargets.push(line.replace(/^FAILED:\s+/, "").slice(0, 200)); return null; }
    let e = RE_MSVC_ERR.exec(line);
    if (e) { this.pushError({ file: e[1], line: Number(e[2]), code: e[3], message: e[4].slice(0, 300) }); return null; }
    e = RE_LINK_ERR.exec(line);
    if (e) { this.pushError({ file: e[1], code: e[2], message: e[3].slice(0, 300) }); return null; }
    if (/^ninja: error:/.test(line)) { this.pushError({ message: line.slice(0, 300) }); return null; }
    if (RE_WARN.test(line)) this.warnings++;
    return null;
  }

  private pushError(e: BuildError) {
    const key = `${e.file ?? ""}:${e.line ?? ""}:${e.code ?? ""}:${e.message}`;
    if (this.seenErr.has(key) || this.errors.length >= 40) return;
    this.seenErr.add(key);
    this.errors.push(e);
  }

  finish(exitCode: number | null): Record<string, unknown> {
    return {
      ok: exitCode === 0,
      exitCode,
      steps: { done: this.done, total: this.total },
      upToDate: this.upToDate,
      lockWaitSec: this.lockWaitSec,
      buildSeconds: this.buildSeconds,
      warnings: this.warnings,
      errors: this.errors,
      failedTargets: this.failedTargets.slice(0, 20),
    };
  }
}

// ── ctest ──────────────────────────────────────────────────────────────────
export type CtestCase = { name: string; status: string; timeSec?: number };

const RE_CTEST_LINE = /^\s*(\d+)\/(\d+)\s+Test\s+#(\d+):\s+(.+?)\s+\.{2,}\s*(.*?)\s+([\d.]+)\s+sec\s*$/;
const RE_CTEST_TOTALLINE = /^(\d+)% tests passed,\s+(\d+) tests failed out of\s+(\d+)/;

export class CtestParser implements LineParser {
  private total = 0;
  private done = 0;
  private cases: CtestCase[] = [];
  private summaryFailed: number | null = null;
  private summaryTotal: number | null = null;
  private totalSec: number | null = null;
  private inFailedList = false;
  private failedList: CtestCase[] = [];

  feed(rawLine: string): ProgressUpdate | null {
    const line = stripAnsi(rawLine).trimEnd();
    const m = RE_CTEST_LINE.exec(line);
    if (m) {
      this.done = Number(m[1]);
      this.total = Number(m[2]);
      const status = m[5].replace(/^\*+/, "").trim();
      const c: CtestCase = { name: m[4], status, timeSec: Number(m[6]) };
      this.cases.push(c);
      const failed = this.cases.filter((x) => !/^Passed$/i.test(x.status)).length;
      return { phase: "testing", pct: this.total ? clampPct((this.done * 100) / this.total) : null, message: `[${this.done}/${this.total}] ${m[4]}: ${status}${failed ? `(ここまで失敗 ${failed})` : ""}` };
    }
    const t = RE_CTEST_TOTALLINE.exec(line);
    if (t) { this.summaryFailed = Number(t[2]); this.summaryTotal = Number(t[3]); return null; }
    const tt = /^Total Test time \(real\)\s*=\s*([\d.]+)\s*sec/.exec(line);
    if (tt) { this.totalSec = Number(tt[1]); return null; }
    if (/^The following tests FAILED:/.test(line)) { this.inFailedList = true; return null; }
    if (this.inFailedList) {
      const f = /^\s*(\d+)\s+-\s+(.+?)\s+\((.+)\)\s*$/.exec(line);
      if (f) { this.failedList.push({ name: f[2], status: f[3] }); return null; }
      if (line.trim() !== "") this.inFailedList = false;
    }
    if (/^Test project /.test(line)) return { phase: "starting", pct: null, message: "ctest を開始" };
    return null;
  }

  finish(exitCode: number | null): Record<string, unknown> {
    const failedCases = this.cases.filter((c) => !/^Passed$/i.test(c.status));
    const merged = new Map<string, CtestCase>();
    for (const c of [...failedCases, ...this.failedList]) merged.set(c.name, { ...merged.get(c.name), ...c });
    const total = this.summaryTotal ?? (this.total || this.cases.length);
    const failed = this.summaryFailed ?? merged.size;
    return {
      ok: exitCode === 0,
      exitCode,
      total,
      passed: Math.max(0, total - failed),
      failed,
      failedTests: [...merged.values()].slice(0, 100),
      totalSec: this.totalSec,
    };
  }
}

// ── ui_tests(dx12_engine.log) ─────────────────────────────────────────────
export class UiTestsParser implements LineParser {
  private phase = "starting";
  private queued: number | null = null;
  private success: number | null = null;
  private tested: number | null = null;
  private runStartMs: number | null = null;
  private cannotRun: string | null = null;
  private expectedSec: number;
  private startMs: number | null = null;

  constructor(expectedSec = 120) { this.expectedSec = Math.max(10, expectedSec); }

  feed(rawLine: string, nowMs: number): ProgressUpdate | null {
    const line = stripAnsi(rawLine);
    if (this.startMs === null) this.startMs = nowMs;
    if (line.includes("UI テストエンジンを起動しました")) { this.phase = "starting"; return { phase: "starting", pct: null, message: "UI テストエンジンを起動した。エディタ UI の準備待ち" }; }
    let m = /UI テスト: (\d+) 件をキューへ投入/.exec(line);
    if (m) { this.queued = Number(m[1]); this.phase = "running"; this.runStartMs = nowMs; return { phase: "running", pct: 0, message: `${this.queued} 件のテストを実行中`, estimated: true }; }
    m = /UI テスト完了: (\d+)\/(\d+) 成功/.exec(line);
    if (m) { this.success = Number(m[1]); this.tested = Number(m[2]); this.phase = "finishing"; return { phase: "finishing", pct: 99, message: `完了: ${m[1]}/${m[2]} 成功。終了処理中` }; }
    if (line.includes("UI テストを実行できません")) { this.cannotRun = line.replace(/^.*UI テストを実行できません[:：]?\s*/, "").slice(0, 300) || "エディタが開いていない"; return { phase: "failed", message: `UI テストを実行できない: ${this.cannotRun}` }; }
    return null;
  }

  tick(nowMs: number): ProgressUpdate | null {
    if (this.phase !== "running" || this.runStartMs === null) return null;
    const el = (nowMs - this.runStartMs) / 1000;
    const pct = Math.min(95, (el / this.expectedSec) * 100);
    return { phase: "running", pct: clampPct(pct), message: `${this.queued ?? "?"} 件を実行中(${Math.round(el)} 秒経過。途中経過は出ないので経過時間からの見積もり)`, etaSec: Math.max(0, Math.round(this.expectedSec - el)), estimated: true };
  }

  finish(exitCode: number | null): Record<string, unknown> {
    return { ok: exitCode === 0, exitCode, queued: this.queued, success: this.success, tested: this.tested, ...(this.cannotRun ? { cannotRun: this.cannotRun } : {}) };
  }
}

// ── protocol(@progress / @result) ─────────────────────────────────────────
const RE_PROGRESS = /^@progress\s+(\{.*\})\s*$/;
const RE_RESULT = /^@result\s+(\{.*\})\s*$/;
const RE_PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*%/;

export class ProtocolParser implements LineParser {
  private result: Record<string, unknown> | null = null;
  private lastPct: number | null = null;
  private fallback: boolean;
  constructor(fallbackPercent = false) { this.fallback = fallbackPercent; }

  feed(rawLine: string): ProgressUpdate | null {
    const line = stripAnsi(rawLine).trim();
    if (!line) return null;
    let m = RE_PROGRESS.exec(line);
    if (m) {
      let o: any;
      try { o = JSON.parse(m[1]); } catch { return null; }
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const u: ProgressUpdate = {};
      if (typeof o.phase === "string") u.phase = o.phase.slice(0, 60);
      const msg = typeof o.msg === "string" ? o.msg : typeof o.message === "string" ? o.message : undefined;
      if (msg !== undefined) u.message = msg.slice(0, 300);
      let pct: number | null | undefined;
      if (typeof o.pct === "number" && Number.isFinite(o.pct)) pct = clampPct(o.pct);
      else if (typeof o.done === "number" && typeof o.total === "number" && o.total > 0) pct = clampPct((o.done * 100) / o.total);
      if (pct !== undefined) { this.lastPct = pct; u.pct = pct; }
      if (typeof o.eta === "number" && Number.isFinite(o.eta)) u.etaSec = Math.max(0, Math.round(o.eta));
      return u;
    }
    m = RE_RESULT.exec(line);
    if (m) {
      try { const o = JSON.parse(m[1]); if (o && typeof o === "object" && !Array.isArray(o) && m[1].length <= 64 * 1024) this.result = { ...(this.result ?? {}), ...o }; } catch { /* 無視 */ }
      return null;
    }
    if (this.fallback) {
      const p = RE_PERCENT.exec(line);
      if (p) {
        const pct = Number(p[1]);
        if (pct >= 0 && pct <= 100 && (this.lastPct === null || pct >= this.lastPct)) { this.lastPct = pct; return { phase: "running", pct: clampPct(pct), message: line.slice(0, 200) }; }
      }
    }
    return null;
  }

  finish(exitCode: number | null): Record<string, unknown> {
    return { ok: exitCode === 0, exitCode, ...(this.result ? { result: this.result } : {}) };
  }
}

export class NoneParser implements LineParser {
  feed(): ProgressUpdate | null { return null; }
  finish(exitCode: number | null): Record<string, unknown> { return { ok: exitCode === 0, exitCode }; }
}

export function makeParser(spec: ParserSpec): LineParser {
  switch (spec.type) {
    case "build": return new BuildParser();
    case "ctest": return new CtestParser();
    case "uitests": return new UiTestsParser(spec.expectedSec);
    case "protocol": return new ProtocolParser(spec.fallbackPercent);
    default: return new NoneParser();
  }
}

// ── JUnit XML(ctest --output-junit / ImGui Test Engine の ui_test_results.xml) ──────────────
export type JUnitCase = { name: string; classname?: string; timeSec?: number; status: "passed" | "failed" | "error" | "skipped"; message?: string };
export type JUnitSummary = { tests: number; failures: number; errors: number; skipped: number; cases: JUnitCase[]; failed: JUnitCase[] };

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&#13;/g, "").replace(/&amp;/g, "&");

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unxml(m[1]) : undefined;
}

export function parseJUnit(xml: string): JUnitSummary {
  const cases: JUnitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const body = m[3] ?? "";
    const c: JUnitCase = { name: attrOf(attrs, "name") ?? "?", status: "passed" };
    const cls = attrOf(attrs, "classname"); if (cls) c.classname = cls;
    const t = attrOf(attrs, "time"); if (t !== undefined && Number.isFinite(Number(t))) c.timeSec = Number(t);
    const st = attrOf(attrs, "status");
    const fail = /<failure\b([^>]*)>?/.exec(body);
    const err = /<error\b([^>]*)>?/.exec(body);
    const skip = /<skipped\b/.test(body);
    if (fail) { c.status = "failed"; c.message = (attrOf(fail[1], "message") ?? /<failure\b[^>]*>([\s\S]*?)<\/failure>/.exec(body)?.[1] ?? "").trim().slice(0, 500); }
    else if (err) { c.status = "error"; c.message = (attrOf(err[1], "message") ?? "").trim().slice(0, 500); }
    else if (skip || st === "notrun") c.status = "skipped";
    cases.push(c);
  }
  const failed = cases.filter((c) => c.status === "failed" || c.status === "error");
  return { tests: cases.length, failures: cases.filter((c) => c.status === "failed").length, errors: cases.filter((c) => c.status === "error").length, skipped: cases.filter((c) => c.status === "skipped").length, cases, failed };
}
