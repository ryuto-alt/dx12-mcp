// ツール実行の共有状態(登録表・呼び出し文脈・エラー元)。toolset/core.ts と shell 層が使う。
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolEntry } from "./catalog.ts";

/**
 * 公開するツール面(surface)。環境変数 DX12_MCP_SURFACE(または互換の DX12_MCP_TOOLSET)で選ぶ。
 *   full   … shell 5 本 + 旧 220 本(既定。M1〜M3 の間は何も壊さない。outputSchema だけ削っている)
 *   core   … shell 5 本 + Core 28 本 + dx12_batch + dx12_call_guarded(計 35 本)。旧 220 名は dx12_call の別名で恒久サポート
 *   shell  … shell 5 本だけ(旧ツールも Core も dx12_call 経由。tools/list は約 10 KB)
 *   legacy … 旧 220 本だけ(shell も instructions も出さない。outputSchema も残す = M0 と同一の回帰基準)
 */
export type Surface = "full" | "core" | "shell" | "legacy";

export function parseSurface(surface: string | undefined, toolset?: string | undefined): Surface {
  const pick = (v: string | undefined): Surface | null => {
    const s = (v ?? "").trim().toLowerCase();
    return s === "full" || s === "core" || s === "shell" || s === "legacy" ? s : null;
  };
  // DX12_MCP_SURFACE が有効ならそれが正。無ければ従来の DX12_MCP_TOOLSET(full/legacy/shell、設計書どおり core も可)。
  return pick(surface) ?? pick(toolset) ?? "full";
}

export const SURFACE: Surface = parseSurface(process.env.DX12_MCP_SURFACE, process.env.DX12_MCP_TOOLSET);

/** 旧名の DX12_MCP_TOOLSET 相当(doctor などの表示・互換用)。core は「旧 220 を隠す」点で shell と同じ扱いにはしない。 */
export type Toolset = "full" | "legacy" | "shell";
export const TOOLSET: Toolset = SURFACE === "legacy" ? "legacy" : SURFACE === "shell" ? "shell" : "full";

/** 構造化エラー・shell などの M1/M2 機能を使うか(legacy は現行と同じ挙動に固定)。 */
export const ENHANCED = SURFACE !== "legacy";

/**
 * Core への昇格(マニフェストの expose:"core")を tools/list へ反映し、notifications/tools/list_changed を送るか。
 * ★Claude Code が list_changed を deferred 索引へ反映するかは未確認(#66084 / #97369)。これに依存しない設計
 *   (新 method は dx12_tool_describe → dx12_call で使える)なので、DX12_MCP_LIST_CHANGED=0 で丸ごと切れる。
 */
export function parseListChanged(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "off" || s === "no");
}
export const LIST_CHANGED_ENABLED = parseListChanged(process.env.DX12_MCP_LIST_CHANGED);

/** 登録済みの TS ツール(旧 220 + Core 専用 + shell)。dx12_call / dx12_tool_describe が引く。 */
export const TOOL_REGISTRY = new Map<string, ToolEntry & { registered?: { enable(): void; disable(): void; remove(): void } }>();

export type CallContext = {
  tool: string;
  args: unknown;
  /** direct=MCP の tools/call から直接、call=dx12_call 経由(こちらは呼び出し側が構造化する)。 */
  mode: "direct" | "call";
};
export const callContext = new AsyncLocalStorage<CallContext>();

/** errResult が作った結果 → 元の Error。dx12_call が構造化エラーを組むときに引く。 */
export const ERROR_SOURCE = new WeakMap<object, unknown>();

/** 構造化エラー(ErrorBody)を最初から組んで返すツール(dx12_engine_* など)。dx12_call がそのまま使う(組み直さない)。 */
export const ERROR_BODY = new WeakMap<object, unknown>();

/** 直近のエラー(dx12_doctor の recentErrors)。 */
export type RecentError = { at: number; tool: string; code: string; message: string };
const RECENT_ERRORS: RecentError[] = [];
export function recordError(e: RecentError) {
  RECENT_ERRORS.push(e);
  if (RECENT_ERRORS.length > 30) RECENT_ERRORS.shift();
}
export function recentErrors(): RecentError[] { return [...RECENT_ERRORS]; }
