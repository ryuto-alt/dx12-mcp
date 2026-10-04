// サーバ本体 / 登録ラッパ / 共通 zod 部品(全ツールモジュールの土台)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import type { EngineClient } from "../engineClient.ts";
import { EngineRouter } from "../fleet/router.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { definedOnly, unknownKeyError, unknownParamKeys, verifyApplied } from "../paramGuard.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_SOURCE, callContext, recordError } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS, CORE_LEGACY_SET } from "../coreSpec.ts";
import { GUARDED_NAMES } from "../catalog.ts";
import { envelope } from "../errors.ts";
import { structureError } from "../structure.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { instructionsFor } from "../instructions.ts";
import { guardApproval } from "../guardCtx.ts";

// engine は EngineRouter(EngineClient と同じ公開面)。束縛が無ければ従来の EngineClient(ポート探索)にそのまま委ねるので、
// フリートを使わない運用は従来と同じ。束縛は dx12_engine_launch / use / attach が切り替える(docs/MCP_FLEET_DESIGN.md)。
export const router = new EngineRouter();
export const engine = router as unknown as EngineClient;
// instructions は shell 層(M1)の一部。legacy モードは現行と同じ(instructions 無し)。
export const SERVER_VERSION = "0.8.0";
export const server = new McpServer(
  { name: "dx12-engine", version: SERVER_VERSION },
  ENHANCED ? { instructions: instructionsFor(SURFACE) } : undefined,
);

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// 全 JSON ツール共通の outputSchema。エンジンの result は method ごとに形が違い、
// 配列や null も返る(list_scenes 等)。structuredContent は JSON オブジェクト必須なので
// { result: <生の結果> } で一様にラップする(z.any() なので必ず検証を通る)。
// ※Claude Code / Codex は structuredContent を読まないため、本体は content[0].text の JSON 文字列。
export const OUT = {
  result: z.any().describe("エンジンからの生の結果。実際の形は各ツールの説明 / dx12_describe_components を参照。text にも同内容を JSON 文字列で格納。"),
};

// エラーを日本語整形(error_code があれば付ける)。isError:true なら outputSchema 検証はスキップされる。
// エンジン/ツールが hint(次の一手) と valid_values(有効値) を添えてきたら必ず出す。
// 「何が悪いか」だけでなく「次にどうすればいいか」が本文に入っているかが成功率に直結する。
export function errResult(e: any): ToolResult {
  const code = e?.code;
  const lines = [code != null ? `エラー(code=${code}): ${e.message}` : `エラー: ${e.message}`];
  if (e?.hint) lines.push(`ヒント: ${e.hint}`);
  if (Array.isArray(e?.valid_values) && e.valid_values.length > 0) {
    lines.push(`有効な値: ${e.valid_values.join(", ")}`);
  }
  const res: ToolResult = { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  ERROR_SOURCE.set(res, e);   // dx12_call が元の Error(code/hint/構造化フィールド)を取り出す
  return res;
}

/**
 * 旧ツールを MCP から直接呼んだときのエラーに、機械可読の構造化 JSON を【もう 1 ブロック足す】。
 * 1 ブロック目(従来の日本語本文)は変えない。dx12_call 経由(mode:"call")は呼び出し側が組むので何もしない。
 */
async function withStructuredBlock(res: ToolResult, e: any): Promise<ToolResult> {
  if (!ENHANCED) return res;
  const ctx = callContext.getStore();
  if (ctx?.mode === "call") return res;   // dx12_call 経由は呼び出し側(shellRuntime)が 1 回だけ構造化する
  try {
    const body = await structureError(e, { tool: ctx?.tool, args: ctx?.args, engine });
    recordError({ at: Date.now(), tool: ctx?.tool ?? "?", code: body.code, message: body.message });
    res.content.push({ type: "text", text: JSON.stringify(envelope(body)) });
  } catch { /* 構造化に失敗しても従来の本文は返す */ }
  return res;
}

// JSON 結果ツール用ラッパ。result を text(JSON 文字列) + structuredContent({result}) の両方に入れる。
export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return {
      content: [{ type: "text", text }],
      structuredContent: { result: data ?? null },
    };
  } catch (e: any) {
    return withStructuredBlock(errResult(e), e);
  }
}

// 画像結果(PNG)を image ブロック + text(path/サイズ) で返す。
export function imageResult(pngPath: string, extra: Record<string, unknown>): ToolResult {
  const data = fs.readFileSync(pngPath).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ path: pngPath, ...extra }) },
    ],
  };
}

export type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

/**
 * ツール名 → そのツールが宣言している引数キー。dx12_batch の引数検査と
 * schemaDrift.test.ts(エンジンとのドリフト検出)から引く。
 */
export const TOOL_PARAM_KEYS = new Map<string, string[]>();

/**
 * 全ツール共通の登録ラッパ。★ここが「引数を無言で捨てない」ための要。
 *
 * inputSchema を生の shape ではなく z.object(shape).passthrough() で渡している。
 * 生の shape だと SDK が z.object(shape) にするため zod が未知キーを【黙って捨て】、
 * ハンドラは何事も無かったように engine を呼んで {applied:true} を返す(＝AI が
 * 「設定したのに変わらない」と同じ操作を繰り返す事故の原因)。passthrough なら
 * 未知キーがここまで届くので、捨てずに「近い正解つきのエラー」にして返せる。
 *
 * ★.strict() を使わない理由: SDK は inputSchema の parse 失敗を -32602 の
 * バリデーションエラーにするだけで、どのキーが余計かの具体的な案内も
 * 「近い正解」も出せない。自前で弾けばヒントと有効値を添えられる。
 */
export function regRaw(
  name: string,
  config: { title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>;
            outputSchema?: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> },
  handler: (args: any) => Promise<ToolResult>,
) {
  const shape = config.inputSchema ?? {};
  const declared = Object.keys(shape);
  TOOL_PARAM_KEYS.set(name, declared);
  // ── ツール面(surface)ごとの出し分け(M3) ────────────────────────────────────────────
  //   legacy … M0 と同一(outputSchema も残す。回帰基準)
  //   full   … 旧 220 本を従来どおり登録。ただし情報の無い共通 outputSchema({result:any} 約 45 KB)は出さない
  //   core   … Core に入る旧ツール(CORE_LEGACY)だけを tools/list に出し、説明は Core 用テンプレに差し替える。他は登録だけして隠す(dx12_call で使う)
  //   shell  … 全部隠す(dx12_call で使う)
  const isCoreLegacy = CORE_LEGACY_SET.has(name);
  const coreDescription = isCoreLegacy ? CORE_DESCRIPTIONS[name] : undefined;
  const { outputSchema: _dropOutputSchema, ...configNoOut } = config;
  const listed: typeof config = SURFACE === "legacy" ? config : {
    ...configNoOut,
    ...(SURFACE === "core" && coreDescription ? { description: coreDescription } : {}),
    annotations: annotationsFor(name, config.annotations),
  };
  // SDK の zod 検証を通った後に呼ばれる本体(未知キー検査つき)。dx12_call も同じものを呼ぶので、
  // 直接呼んでも dx12_call 経由でも挙動が同じになる。
  const invoke = async (args: any): Promise<ToolResult> => {
    const unknown = unknownParamKeys(args, declared);
    if (unknown.length > 0) {
      const res = errResult(unknownKeyError(name, unknown, declared));
      if (ENHANCED && callContext.getStore()?.mode !== "call") {
        const issues = unknownKeyIssues(args ?? {}, declared);
        res.content.push({ type: "text", text: JSON.stringify(envelope(bodyFromIssues(name, args ?? {}, issues, declared))) });
      }
      return res;
    }
    // guarded な旧ツール(git_push / eval_lua / delete_asset など)を直接呼ぶ = そのツールの呼び出し自体が承認の対象
    // (full 面ではクライアント側の権限確認が、core / shell 面では dx12_call_guarded / confirm がゲート)。エンジン側の最終ゲートを通す。
    // dx12_batch や他の合成ツールの内部呼び出しはここを通らないので承認済みにならない(エンジンが拒否する)。
    if (GUARDED_NAMES.has(name)) return guardApproval.run({ approved: true, via: `tool:${name}` }, () => handler(args));
    return handler(args);
  };
  const registered = server.registerTool(
    name,
    {
      ...listed,
      // as any: SDK は ZodRawShape でも ZodObject でも受けるが型定義は前者しか公開していない。
      inputSchema: z.object(shape).passthrough() as any,
    },
    async (args: any) => callContext.run({ tool: name, args, mode: "direct" }, () => invoke(args)),
  );
  // registry の description は旧文のまま(dx12_tool_describe が返す詳しい説明)。core 面の tools/list に出る短い説明は coreDescription。
  const hidden = SURFACE === "shell" || (SURFACE === "core" && !isCoreLegacy);
  TOOL_REGISTRY.set(name, {
    name, title: config.title, description: config.description, shape,
    annotations: config.annotations ?? {}, tier: "legacy", invoke, listed: !hidden, registered,
    core: isCoreLegacy, ...(coreDescription ? { coreDescription } : {}),
  });
  // shell / core 面: 旧ツールは登録だけして tools/list には出さない(dx12_call から呼ぶ)。
  if (hidden) registered.disable();
}

/**
 * tools/list に出す annotations。旧ツールのヒントは変えないが、guarded(取り返しが付かない/外部へ出る)なのに
 * destructiveHint が無いものには付ける(git_push / eval_lua など。ヒントを足すだけで、許可・確認の緩和にはならない)。
 */
export function annotationsFor(name: string, ann: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!GUARDED_NAMES.has(name)) return ann;
  // 既に destructiveHint がある / 読み取り専用のヒント(git_fetch)が付いているものは触らない(矛盾するヒントを作らない)。
  if (ann?.destructiveHint === true || ann?.readOnlyHint === true) return ann;
  return { ...(ann ?? {}), destructiveHint: true };
}

// JSON ツール登録ヘルパ。openWorldHint は常に false(外部世界とやり取りしない閉じたツール群)。
export function reg(
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  ann: Ann,
  handler: (args: any) => Promise<ToolResult>,
) {
  regRaw(
    name,
    {
      title,
      description,
      inputSchema,
      outputSchema: OUT,
      annotations: { title, openWorldHint: false, ...ann },
    },
    handler,
  );
}

/**
 * set_* → get_* の対がある設定ツール用。適用してから【エンジンから読み返して】返す。
 *
 * 旧実装は engine の {applied:true} をそのまま返していた。エンジンは未知フィールドを
 * 無視しても applied:true を返すので「成功したように見えて何も変わっていない」が
 * 起きる。読み返した実値を返せば AI が自分で気づけるし、要求と食い違ったフィールドは
 * mismatched に出して applied:false にする(嘘をつかない)。
 */
export async function applyAndVerify(
  setMethod: string, getMethod: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requested = definedOnly(args);
  await engine.call(setMethod, requested);
  let current: unknown = null;
  try {
    current = await engine.call(getMethod, {});
  } catch {
    // 読み返しに失敗したら「適用したかどうか分からない」と正直に返す
    return { applied: null, requested, note: `${getMethod} で読み返せなかった。値は自分で確認すること` };
  }
  const mismatched = verifyApplied(requested, current);
  const out: Record<string, unknown> = {
    applied: mismatched.length === 0,
    requestedKeys: Object.keys(requested),
    current,
  };
  if (mismatched.length > 0) {
    out.mismatched = mismatched;
    out.hint = "要求した値がエンジンに入っていない(エンジンがクランプしたか、そのフィールドを見ていない)。"
      + "current の実値を見て次の手を決めること。同じ呼び出しを繰り返しても変わらない";
  }
  return out;
}

// ── 共通 zod 部品 ────────────────────────────────────────────────
// v2 / v3 / v4（固定長の数値配列）は sceneTools.ts から import している。
// ★呼ぶたびに【新しい zod インスタンス】を返す関数であることが重要。同じインスタンスを
//   1 ツール内の複数フィールドで使い回すと JSON Schema が $ref に畳まれ、$ref を解決しない
//   クライアントで「received string」と誤判定される（set_transform の rotation/scale が
//   弾かれていた既知の不具合）。新しいツールでも必ず v3() の形で使うこと。
//   回帰テストは sceneTools.test.ts。
export const entityId = z.number().int().describe("エンティティ id(int)。dx12_list_entities / dx12_find_entity で取得。");
// エンティティ指定(id か name のどちらか)。name は完全一致。Stop / open_scene 後は id が変わる
// (sceneGeneration も変わる)ので、安定して操作したいときは name 指定が便利。両方省略は不可。
export const entityRef = {
  entity: z.number().int().optional().describe("エンティティ id(int)。name と排他。"),
  name: z.string().optional().describe("エンティティ名(完全一致)。id の代わりに使える。Stop 後など id が変わる場面で安定。"),
};

/**
 * Brief と Jev の記録を置くプロジェクトの baseDir。エディタが開いているプロジェクトが正(dx12_ping)。
 * 環境変数 DX12_PROJECT_DIR で上書きできる(エディタ無しで評価だけ回すとき)。繋がらなければ null。
 */
export async function jevProjectBaseDir(): Promise<string | null> {
  const env = process.env.DX12_PROJECT_DIR;
  if (env && fs.existsSync(env)) return env;
  const pong = await engine.call("ping", {}, { timeout: 3000 }).catch(() => null);
  return typeof pong?.baseDir === "string" && pong.baseDir ? pong.baseDir : null;
}
