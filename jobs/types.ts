// ジョブ API(M6)の型。純データ(サーバにもエンジンにも依存しない)。設計は docs/MCP_FLEET_DESIGN.md §ジョブ。
//
//   ジョブ = 長い処理(ビルド・ctest・UI テスト・cook・ベンチ・スクショのバッチ)を「即座に id を返して裏で走らせる」仕組み。
//   Claude Code の 2 分超の自動背景化はメイン会話だけで、サブエージェントや claude -p には効かないので、自前の非同期 API にする。
//   状態は %LOCALAPPDATA%\UnoEngine\jobs\<id>\ に永続化し、MCP サーバを再起動しても status が引ける。

export type JobKind =
  | "build" | "ctest" | "ui_tests" | "screenshot_batch" | "bench" | "playtest" | "external" | "vg_cook" | "ue_import" | "scene_spec" | "visual_regression" | "perf_gate" | "ci_suite";

export const JOB_KINDS: readonly JobKind[] = ["build", "ctest", "ui_tests", "screenshot_batch", "bench", "playtest", "external", "vg_cook", "ue_import", "scene_spec", "visual_regression", "perf_gate", "ci_suite"];

export type JobStateName = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export const TERMINAL_STATES: ReadonlySet<JobStateName> = new Set<JobStateName>(["succeeded", "failed", "cancelled", "timeout"]);

export function isTerminal(s: JobStateName): boolean { return TERMINAL_STATES.has(s); }

/** 進捗。pct は 0..100(不明なら null)。message は 1 行。etaSec は残り秒の見積もり(不明なら null)。 */
export type Progress = {
  phase: string;
  pct: number | null;
  message: string;
  etaSec: number | null;
  updatedAt: number;
  /** pct が実測ではなく経過時間からの見積もりのとき true(UI テストなど、途中経過が出ない処理)。 */
  estimated?: boolean;
  /** 進捗が最後に変わってからの秒数(running のときだけ)。ninja は工程が終わるまで次の行を出さないので、長い 1 工程の間は pct が動かない。止まって見えるときの目安。 */
  sinceChangeSec?: number;
};

/** ジョブが返す構造化エラー(state.error)。dx12_call の ErrorBody に合わせた最小形。 */
export type JobError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  fix?: { tool?: string; args?: Record<string, unknown>; command?: string; why?: string }[];
};

export type JobArtifact = { path: string; kind: string; note?: string; bytes?: number };

export type JobRecord = {
  version: 1;
  id: string;
  kind: JobKind;
  args: Record<string, unknown>;
  /** 実行に使ったエンジン(専用エンジンの id など。あれば)。 */
  engine?: string;
  idempotencyKey?: string;
  /** process = 別プロセス(runner)が子プロセスを走らせる / inproc = MCP サーバ内でエンジンを呼ぶ。 */
  executor: "process" | "inproc";
  state: JobStateName;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 起動した MCP サーバ(セッション)。owner が死んでいれば孤児。 */
  owner: { pid: number; startMs: number };
  timeoutMs: number;
  progress: Progress;
  runnerPid?: number;
  childPid?: number;
  exitCode?: number | null;
  error?: JobError;
  /** 終了時の短い要約(status に載る)。全文は result.json(dx12_job_result)。 */
  summary?: Record<string, unknown>;
  artifacts: JobArtifact[];
  cancelRequestedAt?: number;
  /** 起動の補足(コマンド・注意など)。 */
  notes?: string[];
  /** 同時実行の分類(build は 1 本・engine 系はエンジンごとに 1 本など)。 */
  group: string;
};

/** runner が書く、実行中の生きた情報(live.json)。state.json の書き手は manager だけ、live.json の書き手は runner だけ。 */
export type LiveInfo = {
  runnerPid: number;
  childPid?: number;
  startedAt: number;
  updatedAt: number;
  progress?: { phase: string; pct: number | null; message: string; estimated?: boolean };
  finishedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  spawnError?: { code?: string; message: string };
};

export type ParserSpec =
  | { type: "build" }
  | { type: "ctest" }
  | { type: "uitests"; expectedSec?: number }
  | { type: "protocol"; fallbackPercent?: boolean }
  | { type: "none" };

/** manager が runner へ渡す実行計画(spec.json)。 */
export type RunnerSpec = {
  jobId: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  parser: ParserSpec;
  /** 子が書くログファイル(標準出力に出さない処理の進捗をここから拾う。ui_tests の dx12_engine.log)。 */
  tailFile?: string;
  /** 終了後に読む JUnit XML。 */
  junit?: string;
  logFile: string;
  liveFile: string;
  resultFile: string;
  logMaxBytes: number;
  /** true なら runner 自身も子も BelowNormal で動かす(PC 操作を邪魔しない)。 */
  belowNormal: boolean;
};

export type JobView = {
  id: string;
  kind: JobKind;
  state: JobStateName;
  progress: Progress;
  elapsedSec: number | null;
  queuePosition?: number | null;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  exitCode?: number | null;
  summary?: Record<string, unknown>;
  error?: JobError;
  artifacts: JobArtifact[];
  engine?: string;
  dir: string;
  logPath: string;
  resultPath: string | null;
  ownedByMe: boolean;
  /** owner(MCP サーバ)が消えたのに動いているジョブ(process 型は動き続ける)。 */
  orphaned?: boolean;
  idempotentReplay?: boolean;
  notes?: string[];
  /** この種類の直近の所要時間(秒)の中央値。見積もりの目安。 */
  typicalSec?: number | null;
  /** 状態や進捗が変わるたびに増える(long-poll の until:"change" 用)。 */
  seq: number;
};
