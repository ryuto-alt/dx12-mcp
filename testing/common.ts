// 自動テスト系(M9)の共通部品。純関数 + 小さな IO。エンジン呼び出しは依存注入(EngineCall)で受けるので、ツール・ジョブ・単体テストのどこからでも使える。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { ErrorBody } from "../errors.ts";

/** エンジンを 1 回呼ぶ関数(engine.call / env.callEngine の薄い包み)。 */
export type EngineCall = (method: string, params?: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }) => Promise<any>;

/** ツール実行の共通の結果。ok=false のとき error に構造化エラーが入る。 */
export type StepResult<T = any> = { ok: true; data: T } | { ok: false; error: ErrorBody; data?: any };

export type ProgressFn = (u: { phase: string; pct?: number | null; message: string }) => void;

export class Aborted extends Error { constructor() { super("aborted"); this.name = "Aborted"; } }

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** %LOCALAPPDATA%\UnoEngine(環境変数で丸ごと差し替え可)。 */
export function localAppData(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));
  return path.join(local, "UnoEngine");
}

/** 保管先(perf / ci など)。envName(例 DX12_PERF_HOME)があればそれ、無ければ %LOCALAPPDATA%\UnoEngine\<sub>。 */
export function homeDir(envName: string, sub: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[envName];
  return v && v.trim() ? path.resolve(v) : path.join(localAppData(env), sub);
}

export function safeName(s: string, max = 60): string {
  return String(s).replace(/[^A-Za-z0-9_\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "x";
}

/** プロジェクトの baseDir → 保管用のキー(プロジェクト名 + パスの短いハッシュ)。同じパスは同じキー、違うパスは別キー(大文字小文字と区切りは正規化)。 */
export function projectKeyOf(baseDir: string | null | undefined): string {
  if (!baseDir) return "_noproject";
  const norm = path.resolve(baseDir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const name = safeName(path.basename(norm) || "project", 40);
  return `${name}-${crypto.createHash("sha1").update(norm).digest("hex").slice(0, 8)}`;
}

export function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function median(a: number[]): number | null {
  const v = a.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 分位点(線形補間。0..1)。空なら null。 */
export function quantile(a: number[], q: number): number | null {
  const v = a.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const pos = Math.min(1, Math.max(0, q)) * (v.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const round = (n: number | null | undefined, d = 2): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** promise を待つ。signal が abort されたら onAbort(エンジンへの cancel など)を呼び、promise の決着を(上限つきで)待ってから Aborted を投げる。 */
export async function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Promise<void>, settleMs = 8000): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) { await onAbort().catch(() => {}); throw new Aborted(); }
  let handler: (() => void) | null = null;
  const aborted = new Promise<never>((_, rej) => { handler = () => rej(new Aborted()); signal.addEventListener("abort", handler, { once: true }); });
  try { return await Promise.race([p, aborted]); }
  catch (e) {
    if (e instanceof Aborted) { await onAbort().catch(() => {}); await Promise.race([p.catch(() => {}), sleep(settleMs)]); }
    throw e;
  } finally { if (handler) signal.removeEventListener("abort", handler); }
}

/** JSON Lines を 1 行追記(ディレクトリは作る)。 */
export function appendJsonl(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

export function readJsonl<T = any>(file: string, maxLines = 5000): T[] {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l) as T; } catch { return null as any; } }).filter((x) => x != null);
  } catch { return []; }
}

export function writeJsonAtomic(file: string, obj: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function readJson<T = any>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

/** GPU 情報。ping.gpu(新エンジン)を正とし、無ければ null(呼び出し側が WMI などへフォールバックする)。 */
export type GpuInfo = { name: string; driver: string; isSoftware: boolean };
export function gpuFromPing(ping: any): GpuInfo | null {
  const g = ping?.gpu;
  if (!g || typeof g.name !== "string") return null;
  return { name: g.name, driver: typeof g.driver === "string" ? g.driver : "", isSoftware: g.isSoftware === true || /Basic Render|WARP|Microsoft Basic/i.test(g.name) };
}

/** 構造化エラーを組む小さなヘルパ。 */
export function errBody(code: ErrorBody["code"], message: string, extra: Partial<ErrorBody> = {}): ErrorBody {
  return { code, message, retryable: false, ...extra };
}

/** ErrorBody を例外にして投げる/拾う(内部の早期脱出用)。 */
export class StepError extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) { super(body.message); this.name = "StepError"; this.body = body; }
}
export function fail(code: ErrorBody["code"], message: string, extra: Partial<ErrorBody> = {}): never {
  throw new StepError(errBody(code, message, extra));
}

/** エンジン呼び出しが投げたエラーを ErrorBody へ(engineClient のエラーは errName / hint などを持つ)。 */
export function bodyFromThrown(e: any, tool: string): ErrorBody {
  if (e instanceof StepError) return e.body;
  if (e?.errName) {
    return {
      code: e.errName, message: `${tool}: ${e.message}`, retryable: !!e.retryable,
      ...(e.hint ? { hint: e.hint } : {}), ...(Array.isArray(e.fix) ? { fix: e.fix } : {}),
      fix: Array.isArray(e.fix) && e.fix.length ? e.fix : [{ tool: "dx12_doctor", args: {}, why: "接続と状態を診断する" }],
    };
  }
  return { code: "E_INTERNAL", message: `${tool}: ${String(e?.message ?? e)}`, retryable: false, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と状態を診断する" }] };
}

/** プロジェクトの baseDir(ping.baseDir。環境変数 DX12_PROJECT_DIR があればそれ)。 */
export async function projectDirOf(call: EngineCall, override?: string | null): Promise<string | null> {
  if (override) return override;
  const env = process.env.DX12_PROJECT_DIR;
  if (env && fs.existsSync(env)) return env;
  try { const p = await call("ping", {}, { timeout: 5000, retry: false }); return typeof p?.baseDir === "string" && p.baseDir ? p.baseDir : null; }
  catch { return null; }
}

/** HTML エスケープ(レポート用)。 */
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);

/** 正規表現文字列を安全に作る(不正なら null)。大文字小文字は区別しない。 */
export function safeRegex(src: string): RegExp | null {
  try { return new RegExp(src, "i"); } catch { return null; }
}
