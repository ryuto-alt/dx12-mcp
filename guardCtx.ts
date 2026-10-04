// 副作用の安全性(M5)の TS 側の文脈。呼び出しの非同期文脈(AsyncLocalStorage)で 2 つのことを運ぶ。
//
//  1. 承認(guardApproval): guarded な操作(git push / eval_lua / delete_asset / build_game / 任意の外部プロセスのジョブなど)は、
//     dx12_call_guarded(core 面)または dx12_call {confirm:true}(full / shell 面)のゲートを通ったときだけ実行できる。
//     ゲートを通った呼び出しの中だけ approved になる。dx12_batch や合成ツールが内部で撃つ呼び出しは approved ではない。
//     エンジン側にも最終ゲートがある(docs/MCP.md §13): guarded な method は 1 回限りの confirm_token が無いと拒否される。
//     approved の呼び出しのときだけ、EngineClient が guard_token を取って confirm_token を付ける。
//  2. 冪等キー(idemCtx): dx12_call {idempotency_key} の呼び出し内でエンジンへ撃つ write 系の呼び出しに、
//     サブキー `<key>:<method>:<引数のハッシュ>:<出現順>` を付ける。合成ツール(複数の呼び出しを束ねる)を再送しても、
//     完了済みの部分は前回の結果が返り、二重に実行されない。同じ引数の繰り返しでも衝突しない。
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

export type GuardApproval = { approved: true; via: string };
export const guardApproval = new AsyncLocalStorage<GuardApproval>();
export function isGuardApproved(): boolean { return guardApproval.getStore()?.approved === true; }

/**
 * エンジンの guarded な method(マニフェストの effect:"guarded")。ここに載っていれば、承認済みの呼び出しは最初から confirm_token を付ける
 * (無くてもエンジンが E_GUARDED で断れば、承認済みのときだけ取り直して 1 回再送する)。catalog.ts の GUARDED_NAMES と一致することをテストが見張る。
 */
export const GUARDED_METHODS: ReadonlySet<string> = new Set([
  "eval_lua", "delete_asset", "build_game", "net_launch_test_client",
  "git_checkout", "git_merge", "git_merge_abort", "git_commit", "git_push", "git_pull", "git_fetch",
]);

// ── 冪等キーのサブキー ──────────────────────────────────────────────────────────
export type IdemCtx = { key: string; seen: Map<string, number> };
export const idemCtx = new AsyncLocalStorage<IdemCtx>();

/** 冪等キーを付けない method(読み取り・診断・エンジンの冪等対象外)。 */
const NO_KEY = /^(get_|list_|describe_|find_|query_|read_|ping$|guard_token$|cancel$|journal_list$|perf_stats$|diagnose$|raycast|overlap_|pick$|project_world_to_screen$|perceive$|screenshot|imgui_screenshot$|imgui_find$|render_debug$|view_texture$|preview_model$|ui_tree$|validate_|audio_state$|brain_state$|net_status$|navmesh_(info|path|sample|raycast)$|terrain_(sample|splat_info)$|transaction_status$|editor_(state|command_list)$)/;
export function takesIdempotencyKey(method: string): boolean { return !NO_KEY.test(method); }

/** キーの順序に依らない安定した文字列化(サブキーのハッシュ用)。 */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

const EXCLUDED_FROM_HASH = new Set(["idempotency_key", "idempotencyKey", "confirm_token", "dryRun"]);

export function subKeyFor(ctx: IdemCtx, method: string, params: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!EXCLUDED_FROM_HASH.has(k)) clean[k] = v;
  const h = crypto.createHash("sha1").update(stableJson(clean)).digest("hex").slice(0, 8);
  const slot = `${method}:${h}`;
  const n = (ctx.seen.get(slot) ?? 0) + 1;
  ctx.seen.set(slot, n);
  return `${ctx.key}:${slot}:${n}`;
}

export function newIdemCtx(key: string): IdemCtx { return { key, seen: new Map() }; }

/** 自動採番のキー(dx12_call が write 系に付ける。E_ENGINE_TIMEOUT の再送で二重実行を防ぐ)。 */
export function autoKey(): string { return `auto-${crypto.randomBytes(6).toString("hex")}`; }
