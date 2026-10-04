// ジョブ API の設定。環境変数を 1 か所で読む。
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JobKind } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export type JobsConfig = {
  /** 永続先。%LOCALAPPDATA%\UnoEngine\jobs(DX12_JOBS_DIR で差し替え)。 */
  dir: string;
  /** リポジトリのルート(tools\build.ps1 の場所)。DX12_REPO_DIR で差し替え。配布リポジトリ(dx12-mcp)には無い。 */
  repoDir: string;
  /** 同時に走るジョブの総数の上限。 */
  maxRunning: number;
  /** 種類ごとの同時実行数の上限(group 単位)。build は常に 1(build.ps1 の排他ロックと整合)。 */
  groupCap: Record<string, number>;
  timeoutSec: Record<JobKind, number>;
  /** 終わったジョブを残す日数と件数。 */
  keepDays: number;
  keepMax: number;
  /** manager の監視間隔(ms)。 */
  pollMs: number;
  logMaxBytes: number;
  /** MCP サーバの終了時に、走っている process 型ジョブも止めるか(既定 false = 走らせ続けて再起動後に status で引ける)。 */
  killOnExit: boolean;
  disabled: boolean;
  /** テスト用: コマンドの差し替え(["node","fake.ts"] など)。 */
  buildCmd?: string[];
  ctestCmd?: string[];
  pwsh: string;
  runnerScript: string;
  /** ui_tests がエンジンの exe の元を探すときの build ディレクトリ(フリートと同じ DX12_FLEET_BUILD_DIR)。 */
  buildDir?: string;
};

function num(v: string | undefined, dflt: number, min = 0): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
}
function flag(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function cmd(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  try { const a = JSON.parse(v); if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a; } catch { /* 無視 */ }
  return undefined;
}

export function defaultJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));
  return path.join(local, "UnoEngine", "jobs");
}

export const DEFAULT_TIMEOUT_SEC: Record<JobKind, number> = {
  build: 3600, ctest: 1800, ui_tests: 1500, screenshot_batch: 1800, bench: 900, playtest: 1800, external: 3600, vg_cook: 7200, ue_import: 7200, scene_spec: 1800,
  visual_regression: 1800, perf_gate: 1800, ci_suite: 7200,
};

export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  return {
    dir: env.DX12_JOBS_DIR || defaultJobsDir(env),
    repoDir: path.resolve(env.DX12_REPO_DIR || path.join(here, "..", "..", "..")),
    maxRunning: Math.max(1, Math.floor(num(env.DX12_JOBS_MAX_RUNNING, 3, 1))),
    groupCap: { build: 1, ctest: 1, ui_tests: 1, screenshot_batch: 1, bench: 1, playtest: 1, external: 2, visual_regression: 1, perf_gate: 1, ci_suite: 1 },
    timeoutSec: { ...DEFAULT_TIMEOUT_SEC },
    keepDays: num(env.DX12_JOBS_KEEP_DAYS, 7, 0),
    keepMax: Math.max(10, Math.floor(num(env.DX12_JOBS_KEEP_MAX, 200, 10))),
    pollMs: Math.max(20, num(env.DX12_JOBS_POLL_MS, 500, 20)),
    logMaxBytes: Math.max(64 * 1024, num(env.DX12_JOBS_LOG_MAX_BYTES, 20 * 1024 * 1024, 64 * 1024)),
    killOnExit: flag(env.DX12_JOBS_KILL_ON_EXIT),
    disabled: flag(env.DX12_JOBS_DISABLE),
    buildCmd: cmd(env.DX12_JOBS_BUILD_CMD),
    ctestCmd: cmd(env.DX12_JOBS_CTEST_CMD),
    pwsh: env.DX12_PWSH || "pwsh",
    runnerScript: path.join(here, "runner.ts"),
    buildDir: env.DX12_FLEET_BUILD_DIR || undefined,
  };
}
