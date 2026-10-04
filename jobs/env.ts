// ジョブ種別(kinds)が使う外部依存の窓口。本番は jobs/runtime.ts が EngineRouter・フリート・TS ツール登録表で組み、テストは模擬で差し替える。
import type { JobsConfig } from "./config.ts";

export type FleetOps = {
  launch(input: Record<string, unknown>): Promise<any>;
  stop(input: Record<string, unknown>): Promise<any>;
  list(input?: Record<string, unknown>): Promise<any>;
  refresh(input: Record<string, unknown>): Promise<any>;
};

export type KindEnv = {
  cfg: JobsConfig;
  /** エンジンを呼ぶ。engine 省略で束縛先(従来の探索を含む)。id / name / port 指定でその 1 台。 */
  callEngine(engine: string | undefined, method: string, params: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }): Promise<any>;
  /** 使うエンジンの id を返す(束縛が無ければ undefined = 従来の探索)。engine 引数の id / name / port を id に解決する。 */
  resolveEngineId(engine?: string): string | undefined;
  /** engine の待受ポート(external ジョブへ DX12_MCP_PORT として渡す)。 */
  enginePort(engine?: string): number | undefined;
  /** フリート(専用エンジンの起動・停止・更新)。無効なら null。 */
  fleet(): FleetOps | null;
  /** TS ツールの登録表から旧ツールを呼ぶ(playtest ジョブが dx12_run_playtests を使う)。 */
  callTool(name: string, args: Record<string, unknown>, engine?: string): Promise<{ text: string; isError: boolean; images: number }>;
  /** 画像を書いたファイルとして扱えるよう、エンジンが返した path の PNG を読む(コンタクトシート用)。 */
  now(): number;
};
