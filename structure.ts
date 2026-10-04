// エンジン/接続/タイムアウトのエラー → 構造化エラー(ErrorBody)。
//
// エンジンが構造化フィールド(error_name / error_did_you_mean / error_fix ...)を付けてきたらそれを正とし、
// 付いていない旧エンジン・TS 側で起きたエラーは、メッセージと数値コードから同じ形へ組み直す。
// 足りない「近い名前」は、必要なときだけ読み取り系の method(list_entities / list_scenes / list_assets)を
// 1 回引いて補う(失敗しても本来のエラーを隠さない)。

import type { EngineClient, EngineCallError } from "./engineClient.ts";
import type { ErrorBody, ErrorCodeName, Fix } from "./errors.ts";
import { ERROR_CODES, classifyCode, extractValidValues, nearest } from "./errors.ts";
import { launchFixes } from "./doctor.ts";

export type StructureCtx = {
  /** 呼んだツール/method 名(dx12_call の name か、旧ツール名)。 */
  tool?: string;
  args?: unknown;
  engine?: EngineClient;
  /** 未知ツールの候補を出すための名前一覧。 */
  suggestNames?: () => string[];
  /** 名前の候補を引く読み取り(テストで差し替える)。省略時は engine.call。 */
  lookup?: (method: string, params: Record<string, unknown>) => Promise<any>;
};

const asArgs = (a: unknown): Record<string, unknown> =>
  a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};

/** list_* の応答から文字列候補(名前/パス)を集める。 */
export function collectNames(result: any, keys: string[] = ["name", "path", "assetPath", "file"]): string[] {
  const out: string[] = [];
  const walk = (v: any, depth: number) => {
    if (depth > 3 || v == null) return;
    if (typeof v === "string") { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      let took = false;
      for (const k of keys) if (typeof v[k] === "string") { out.push(v[k]); took = true; break; }
      if (!took) for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(result, 0);
  return out;
}

async function lookup(ctx: StructureCtx, method: string, params: Record<string, unknown>): Promise<any> {
  if (ctx.lookup) return ctx.lookup(method, params);
  if (!ctx.engine) throw new Error("no engine");
  return ctx.engine.call(method, params, { timeout: 3000 });
}

/** 名前・パスを持つ引数キーのうち、見つからなかった値を持つものを探す(name / path / entity 名 など)。 */
function nameArgKeys(args: Record<string, unknown>, kind: "entity" | "scene" | "asset"): string[] {
  const pref = kind === "entity" ? ["name", "entityName", "parentName", "target", "targetName"]
    : kind === "scene" ? ["path", "scene", "name"] : ["path", "assetPath", "model", "modelPath", "texture", "file", "name"];
  return pref.filter((k) => typeof args[k] === "string" && (args[k] as string).length > 0);
}

async function enrichNotFound(code: ErrorCodeName, body: ErrorBody, ctx: StructureCtx) {
  const args = asArgs(ctx.args);
  const kind = code === "E_NOT_FOUND_ENTITY" ? "entity" : code === "E_NOT_FOUND_SCENE" ? "scene" : code === "E_NOT_FOUND_ASSET" ? "asset" : null;
  if (!kind) return;
  const keys = nameArgKeys(args, kind);
  if (!keys.length) return;
  const method = kind === "entity" ? "list_entities" : kind === "scene" ? "list_scenes" : "list_assets";
  // メッセージに出てきた値を優先(複数の名前引数があるとき、実際に見つからなかった方を選ぶ)
  const msg = body.message;
  const key = keys.find((k) => msg.includes(String(args[k]))) ?? keys[0];
  const value = String(args[key]);
  // エンジンが近い名前(error_did_you_mean)を返してきた場合は、それで「撃ち直す」fix を先頭に作るだけ(一覧は引かない)。
  if ((body.didYouMean?.length ?? 0) > 0) {
    if (ctx.tool && body.didYouMean![0] !== value) {
      const fix: Fix = { tool: ctx.tool, args: { ...args, [key]: body.didYouMean![0] }, why: `'${value}' に最も近い '${body.didYouMean![0]}' で撃ち直す` };
      body.fix = [fix, ...(body.fix ?? [])];
    }
    return;
  }
  let names: string[];
  try { names = collectNames(await lookup(ctx, method, {}), kind === "entity" ? ["name"] : ["path", "assetPath", "file", "name"]); } catch { return; }
  if (!names.length) return;
  // シーン/アセットは拡張子・ディレクトリ違いを吸収するため、末尾のファイル名でも比較する
  let dym = nearest(value, names, 5);
  if (!dym.length && kind !== "entity") {
    const base = (s: string) => s.split(/[\\/]/).pop() ?? s;
    const byBase = new Map(names.map((n) => [base(n), n]));
    dym = nearest(base(value), [...byBase.keys()], 5).map((b) => byBase.get(b) as string);
  }
  if (!dym.length) {
    body.fix = [...(body.fix ?? []), { tool: method === "list_entities" ? "dx12_list_entities" : method === "list_scenes" ? "dx12_list_scenes" : "dx12_list_assets", args: {}, why: "存在する名前の一覧を引く" }];
    return;
  }
  body.didYouMean = dym;
  const fixed = { ...args, [key]: dym[0] };
  const fixes: Fix[] = [{ tool: ctx.tool, args: fixed, why: `'${value}' に最も近い '${dym[0]}' で撃ち直す` }];
  fixes.push({ tool: method === "list_entities" ? "dx12_list_entities" : method === "list_scenes" ? "dx12_list_scenes" : "dx12_list_assets", args: kind === "entity" ? { name_prefix: value.slice(0, 3) } : {}, why: "存在する名前の一覧を引く" });
  body.fix = [...fixes, ...(body.fix ?? []).filter((f) => f.tool !== fixes[0].tool)];
}

/** エンジンの enum 違い(valid_values 付き)で、どの引数が外れたかを突き止めて直した引数を作る。 */
function enrichEnum(body: ErrorBody, ctx: StructureCtx) {
  const values = body.validValues;
  const args = asArgs(ctx.args);
  if (!values?.length || !ctx.tool) return;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string" || values.includes(v)) continue;
    // メッセージにその値が出ているものだけを対象にする(無関係な文字列引数を書き換えない)
    if (!body.message.includes(v)) continue;
    const dym = nearest(v, values, 3, { liberal: values.length <= 16 });
    if (body.code === "E_INVALID_PARAM" || body.code === "E_BAD_TYPE") body.code = "E_BAD_ENUM";
    if (!body.didYouMean?.length) body.didYouMean = dym;
    if (dym[0]) body.fix = [{ tool: ctx.tool, args: { ...args, [k]: dym[0] }, why: `'${v}' に最も近い '${dym[0]}' で撃ち直す` }, ...(body.fix ?? [])];
    return;
  }
}

function modeFix(body: ErrorBody, ctx: StructureCtx) {
  const text = `${body.message} ${body.hint ?? ""} ${body.cause ?? ""}`;
  const fixes: Fix[] = [];
  if (/dx12_stop|playing|再生中|Play 中/i.test(text) && !/dx12_play\b/.test(text.replace(/dx12_play_/g, ""))) {
    fixes.push({ tool: "dx12_stop", args: {}, thenRetry: true, why: "Playing 中は実行できない。停止してから同じ呼び出しを撃ち直す" });
  } else if (/dx12_play\b|editor 中|Editor では|Play してから/i.test(text)) {
    fixes.push({ tool: "dx12_play", args: {}, thenRetry: true, why: "Play 中でないと動かない。再生してから同じ呼び出しを撃ち直す" });
  }
  if (/transaction|トランザクション/i.test(text)) {
    fixes.push({ tool: "dx12_transaction_commit", args: {}, thenRetry: true, why: "開いているトランザクションを確定してから撃ち直す(戻すなら dx12_transaction_rollback)" });
  }
  if (fixes.length) body.fix = [...fixes, ...(body.fix ?? [])];
}

/**
 * Error(エンジン応答 / 接続 / タイムアウト / TS 内部)を構造化エラーにする。async なのは、
 * 近い名前を引くための読み取り 1 回と、タイムアウト時の応答確認 ping があるため。決して throw しない。
 */
export async function structureError(e: any, ctx: StructureCtx = {}): Promise<ErrorBody> {
  const err = e as EngineCallError;
  const message = String(err?.message ?? e ?? "unknown error");
  let code = classifyCode(typeof err?.code === "number" ? err.code : undefined, message, err?.errName);
  // 未知 method(旧エンジンは code 2 の "unknown method: X")
  if (/^unknown method:/i.test(message)) code = "E_UNKNOWN_TOOL";

  const body: ErrorBody = {
    code, message,
    engineCode: typeof err?.code === "number" ? err.code : undefined,
    cause: err?.errCause ?? err?.hint,
    hint: err?.hint,
    retryable: err?.retryable ?? ERROR_CODES[code].retryable,
    didYouMean: err?.didYouMean?.length ? err.didYouMean : undefined,
    validValues: err?.valid_values?.length ? err.valid_values : undefined,
    details: err?.errDetails,
    fix: err?.errFix?.length ? err.errFix.map((f) => ({ tool: f.tool, args: f.args, why: f.why })) : undefined,
  };
  if (body.hint && body.cause === body.hint) delete body.hint;   // 同じ文を 2 度出さない
  // 素の Error(TS ハンドラ)は有効値がメッセージに埋まっていることがある。取り出して validValues にする。
  if (code === "E_BAD_ENUM" && !body.validValues?.length) { const vv = extractValidValues(message); if (vv.length) body.validValues = vv; }

  try {
    if (code === "E_UNKNOWN_TOOL") {
      const fromMsg = /unknown method:\s*(\S+)/i.exec(message)?.[1];
      const args = asArgs(ctx.args);
      const bare = (s: string) => s.replace(/^dx12_/, "");
      // 未知だと言われた名前が、呼んだツール自身ではなく【引数の値】のとき(例: describe_mcp_manifest {method:"set_transfrom"})。
      const argKey = fromMsg && ctx.tool && bare(fromMsg) !== bare(ctx.tool)
        ? Object.keys(args).find((k) => args[k] === fromMsg) : undefined;
      if (argKey && ctx.tool) {
        const dym0 = body.didYouMean?.[0];
        body.fix = [
          ...(dym0 ? [{ tool: ctx.tool, args: { ...args, [argKey]: dym0 }, why: `引数 ${argKey} の '${fromMsg}' に最も近い '${dym0}' で撃ち直す` } as Fix] : []),
          ...(body.fix ?? []),
        ];
      } else {
        const bad = ctx.tool ?? fromMsg ?? "";
        if (!body.didYouMean?.length && ctx.suggestNames && bad) body.didYouMean = nearest(bare(bad), ctx.suggestNames().map(bare), 5);
        const fixes: Fix[] = [];
        if (body.didYouMean?.[0]) fixes.push({ tool: body.didYouMean[0].startsWith("dx12_") ? body.didYouMean[0] : "dx12_" + body.didYouMean[0], args, why: `'${bad}' に最も近い名前で撃ち直す` });
        fixes.push({ tool: "dx12_tool_search", args: { query: bare(bad).replace(/_/g, " ") }, why: "名前で検索する" });
        body.fix = [...fixes, ...(body.fix ?? [])];
      }
    } else if (code === "E_ENGINE_UNREACHABLE") {
      const d = (body.details ?? {}) as any;
      body.fix = [...launchFixes({ port: d.port, host: d.host }), ...(body.fix ?? [])];
      body.fix.unshift({ tool: "dx12_doctor", args: {}, why: "ポート・プロセス・ログを調べて原因を診断する" });
    } else if (code === "E_ENGINE_TIMEOUT") {
      const fixes: Fix[] = [
        { tool: "dx12_ping", args: {}, why: "エンジンが応答するか確認する(応答するなら処理中)" },
        { tool: "dx12_get_log", args: { lines: 20 }, why: "エンジンのログ末尾で処理の進み具合を確認する" },
      ];
      body.fix = [...fixes, ...(body.fix ?? [])];
      body.cause = body.cause ?? "エンジンがまだ処理中の可能性がある";
      if (ctx.engine) {
        // 短い ping で「固まっているのか処理中か」を区別する
        try { await ctx.engine.call("ping", {}, { timeout: 1500 }); body.details = { ...(body.details ?? {}), engineResponsive: true }; }
        catch { body.details = { ...(body.details ?? {}), engineResponsive: false }; }
      }
    } else if (code === "E_NOT_FOUND_ENTITY" || code === "E_NOT_FOUND_SCENE" || code === "E_NOT_FOUND_ASSET") {
      await enrichNotFound(code, body, ctx);
    } else if (code === "E_NOT_FOUND") {
      // 種類を特定できなかった: 名前引数があるならエンティティとして候補を引く
      if (nameArgKeys(asArgs(ctx.args), "entity").length) { body.code = "E_NOT_FOUND_ENTITY"; await enrichNotFound("E_NOT_FOUND_ENTITY", body, ctx); }
    } else if (code === "E_BAD_ENUM" || code === "E_INVALID_PARAM") {
      enrichEnum(body, ctx);
    } else if (code === "E_MODE_CONFLICT") {
      modeFix(body, ctx);
    } else if (code === "E_VIRTUAL_INPUT_OFF") {
      body.fix = [{ tool: "dx12_imgui_virtual_input", args: { enable: true }, thenRetry: true, why: "仮想入力モードを ON にしてから撃ち直す(実マウス/実キーボードは使わない)" }, ...(body.fix ?? [])];
    } else if (code === "E_STALE_SCENE") {
      body.fix = [{ tool: "dx12_list_entities", args: {}, thenRetry: false, why: "シーンが変わった。entityId を引き直してから撃ち直す(name 指定なら世代に影響されない)" }, ...(body.fix ?? [])];
    } else if (code === "E_FILE_IO") {
      if (!body.fix?.length) body.fix = [{ tool: "dx12_tool_describe", args: { name: ctx.tool ?? "" }, why: "path 引数を明示する(省略すると CWD 相対で書けないことがある)" }];
    }
  } catch {
    /* 補足情報が作れなくても本来のエラーは返す */
  }
  if (!body.fix?.length && ctx.tool) body.fix = [{ tool: "dx12_tool_describe", args: { name: ctx.tool }, why: "引数と注意点を確認する" }];
  body.docs = body.docs ?? (ctx.tool ? `dx12_tool_describe {name:'${ctx.tool}'}` : undefined);
  return body;
}
