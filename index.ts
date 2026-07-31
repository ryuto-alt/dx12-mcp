import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "./engineClient.ts";
import { auditUiTree, designBrief } from "./uiQuality.ts";
import { BLUEPRINT_EXAMPLE, composeUi } from "./uiComposer.ts";
import { compareUiImages } from "./uiCompare.ts";
import { downloadFont } from "./uiAssets.ts";
import {
  LIGHTING_PRESETS, RENDER_DEBUG_MODES, SCULPT_BRUSHES, SCULPT_PRIMITIVES,
  TERRAIN_BRUSHES, TERRAIN_PRESETS,
  DIAG_CHECKS, fastDiagnoseOnly, nonSettableComponentError, normalizeDiagnoseOnly,
  normalizeStrokePoints, renderDebugModeIssue, argError, v2, v3, v4,
} from "./sceneTools.ts";
import { compareLook, roundDelta, roundStats } from "./lookCompare.ts";
import { buildContactSheet, planCameraPath, type PathMode } from "./contactSheet.ts";
import {
  assetsDirFromScenePath, checkScenePath,
  summarizeScene, validateSceneJson,
} from "./sceneWrite.ts";
import {
  COMPOSITE_TOOLS, METHOD_KEY_ALIASES, definedOnly, unknownKeyError, unknownParamKeys,
  verifyApplied,
} from "./paramGuard.ts";
import {
  HEIGHT_UNSUPPORTED_REASON, ROLE_TO_SLOT,
  filesDirectlyUnder, planPbr, resolveTextureSet, validateScalar, verifyTextureOverrides,
} from "./materialApply.ts";

// DX12 ゲームエンジン用 MCP サーバ。Codex / Claude Code から接続し、
// 起動中のエディタ(TCP 127.0.0.1:<port>)を叩いてゲームを作っていくための入口。
//
// ★遅延同期: create/spawn/delete/duplicate/open_scene/new_scene/play/stop は
//   エンジンがフレーム境界で実処理してから【同じ id】で本物の result を返す。
//   このサーバは id で待つだけなので、ツールは本物の entityId 等を【同期で】返す。
//   旧来の「{queued} が返るので後で name で list して探す」パターンは完全廃止。
//
// ツール名は dx12_ 接頭辞。entity パラメータ(int)はエンジンに合わせてそのまま渡す(変換しない)。
// result のフィールド名(entityId 等)もエンジンの返り値をそのまま通す。

const engine = new EngineClient();
const server = new McpServer({ name: "dx12-engine", version: "0.7.0" });

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// 全 JSON ツール共通の outputSchema。エンジンの result は method ごとに形が違い、
// 配列や null も返る(list_scenes 等)。structuredContent は JSON オブジェクト必須なので
// { result: <生の結果> } で一様にラップする(z.any() なので必ず検証を通る)。
// ※Claude Code / Codex は structuredContent を読まないため、本体は content[0].text の JSON 文字列。
const OUT = {
  result: z.any().describe("エンジンからの生の結果。実際の形は各ツールの説明 / dx12_describe_components を参照。text にも同内容を JSON 文字列で格納。"),
};

// エラーを日本語整形(error_code があれば付ける)。isError:true なら outputSchema 検証はスキップされる。
// エンジン/ツールが hint(次の一手) と valid_values(有効値) を添えてきたら必ず出す。
// 「何が悪いか」だけでなく「次にどうすればいいか」が本文に入っているかが成功率に直結する。
function errResult(e: any): ToolResult {
  const code = e?.code;
  const lines = [code != null ? `エラー(code=${code}): ${e.message}` : `エラー: ${e.message}`];
  if (e?.hint) lines.push(`ヒント: ${e.hint}`);
  if (Array.isArray(e?.valid_values) && e.valid_values.length > 0) {
    lines.push(`有効な値: ${e.valid_values.join(", ")}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
}

// JSON 結果ツール用ラッパ。result を text(JSON 文字列) + structuredContent({result}) の両方に入れる。
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return {
      content: [{ type: "text", text }],
      structuredContent: { result: data ?? null },
    };
  } catch (e: any) {
    return errResult(e);
  }
}

// 画像結果(PNG)を image ブロック + text(path/サイズ) で返す。
function imageResult(pngPath: string, extra: Record<string, unknown>): ToolResult {
  const data = fs.readFileSync(pngPath).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ path: pngPath, ...extra }) },
    ],
  };
}

type Ann = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };

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
function regRaw(
  name: string,
  config: { title: string; description: string; inputSchema?: Record<string, z.ZodTypeAny>;
            outputSchema?: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> },
  handler: (args: any) => Promise<ToolResult>,
) {
  const shape = config.inputSchema ?? {};
  const declared = Object.keys(shape);
  TOOL_PARAM_KEYS.set(name, declared);
  server.registerTool(
    name,
    {
      ...config,
      // as any: SDK は ZodRawShape でも ZodObject でも受けるが型定義は前者しか公開していない。
      inputSchema: z.object(shape).passthrough() as any,
    },
    async (args: any) => {
      const unknown = unknownParamKeys(args, declared);
      if (unknown.length > 0) return errResult(unknownKeyError(name, unknown, declared));
      return handler(args);
    },
  );
}

// JSON ツール登録ヘルパ。openWorldHint は常に false(外部世界とやり取りしない閉じたツール群)。
function reg(
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
async function applyAndVerify(
  setMethod: string, getMethod: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requested = definedOnly(args);
  await engine.call(setMethod, requested);
  let current: unknown = null;
  try {
    current = await engine.call(getMethod, {});
  } catch {
    // 読み返しに失敗したら「適用したかどうか分からない」と正直に返す
    return { applied: null, requested, note: `${getMethod} で読み返せなかった。値は自分で確認してくれ` };
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
const entityId = z.number().int().describe("エンティティ id(int)。dx12_list_entities / dx12_find_entity で取得。");
// エンティティ指定(id か name のどちらか)。name は完全一致。Stop / open_scene 後は id が変わる
// (sceneGeneration も変わる)ので、安定して操作したいときは name 指定が便利。両方省略は不可。
const entityRef = {
  entity: z.number().int().optional().describe("エンティティ id(int)。name と排他。"),
  name: z.string().optional().describe("エンティティ名(完全一致)。id の代わりに使える。Stop 後など id が変わる場面で安定。"),
};

// ════════════════════════════════════════════════════════════════
//  読み取り系(同期・readOnly)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_ping",
  "疎通確認",
  "エディタとの疎通確認。mode(Editor/Playing)・entityCount・sceneGeneration・currentScene・sceneDirty・protocolVersion を返す。★sceneDirty=true は未保存の変更がある状態。この状態で dx12_open_scene / dx12_new_scene / dx12_open_project を撃つとその変更は黙って消えるので、先に dx12_save_scene するか人間に確認すること。まず最初に叩いて生きてるか確認するのに使う。"
  + "★protocolVersion 4 からパス一式も返る: assetsDir / scriptsDir / baseDir / projectShaderDir / cwd(すべて絶対パス)。"
  + "assets 相対パスを絶対パスへ直したい時・シーン JSON を直接書きたい時は、ログから推測せずここを正とすること。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("ping", {})),
);

reg(
  "dx12_list_entities",
  "エンティティ一覧",
  "今開いてるシーンのエンティティ一覧(entityId, name)を返す。verbose で componentTypes も付く。name_prefix / component_type で絞り込み可。{entities, count, sceneGeneration} が返る。",
  {
    verbose: z.boolean().optional().describe("true で各エンティティの componentTypes も含める。"),
    name_prefix: z.string().optional().describe("名前の前方一致フィルタ。"),
    component_type: z.string().optional().describe("指定 jsonKey を持つものだけに絞る(例 pointLight)。"),
  },
  { readOnlyHint: true },
  ({ verbose, name_prefix, component_type }) =>
    run(() => engine.call("list_entities", { verbose, name_prefix, component_type })),
);

reg(
  "dx12_get_entity",
  "エンティティ詳細",
  "エンティティの全コンポーネントと値を JSON で読む(編集前の状態確認に使う)。entity(id) か name(完全一致)で指定。返り値は entityId, componentTypes, luaReadable(Lua から entity.<key> で直接読めるコンポーネント=現状 transform のみ), sceneGeneration と、各コンポーネントの jsonKey をキーにした値。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_entity", { entity, name })),
);

reg(
  "dx12_find_entity",
  "名前でエンティティ検索",
  "名前の完全一致でエンティティを1件探す。見つかれば {entityId, name}、無ければ null。",
  { name: z.string().describe("探すエンティティ名(完全一致)。") },
  { readOnlyHint: true },
  ({ name }) => run(() => engine.call("find_entity", { name })),
);

reg(
  "dx12_query_entities",
  "タグ/領域でエンティティ検索",
  "tag か box のどちらかで複数エンティティを探す(どちらか必須)。box は XZ 平面の矩形 [minX,minZ,maxX,maxZ]。{entities:[{entityId,name}], count} を返す。",
  {
    tag: z.string().optional().describe("このタグを持つエンティティを列挙。"),
    box: z.array(z.number()).length(4).optional().describe("[minX,minZ,maxX,maxZ]。この XZ 矩形に入るエンティティを列挙。"),
  },
  { readOnlyHint: true },
  ({ tag, box }) => run(() => engine.call("query_entities", { tag, box })),
);

reg(
  "dx12_list_scenes",
  "シーン一覧",
  "assets/scenes 配下のシーン(.json)一覧 [{path, name}] を返す。dx12_open_scene の path を選ぶのに使う。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("list_scenes", {})),
);

reg(
  "dx12_list_assets",
  "アセット一覧",
  "assets 配下のアセット一覧 [{path, type, name}] を返す。type で種別フィルタ(省略で全種別)。spawn_model / spawn_prefab / attach の path 探索に使う。",
  {
    type: z.enum(["model", "texture", "script", "audio", "scene", "prefab", "shader"]).optional().describe("種別フィルタ。省略で全種別。"),
  },
  { readOnlyHint: true },
  ({ type }) => run(() => engine.call("list_assets", { type })),
);

reg(
  "dx12_get_mode",
  "モード取得",
  "現在のエンジンモード(Editor / Playing)を返す。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_mode", {})),
);

reg(
  "dx12_get_log",
  "ログ取得",
  "エンジンログの末尾 N 行を配列で返す。エラーや print() の確認に使う。",
  { lines: z.number().int().optional().describe("取得行数(既定 50)。") },
  { readOnlyHint: true },
  ({ lines }) => run(() => engine.call("get_log", { lines })),
);

reg(
  "dx12_describe_components",
  "コンポーネント辞書",
  "set_component する前にフィールドを知るための辞書。component 省略で全コンポーネント、指定でそれだけ。返り値 components:[{jsonKey, settable, removable, fields:[{name,type,default}], note?}]。dx12_set_component の data を組み立てる前に必ず参照すると確実。",
  { component: z.string().optional().describe("特定 jsonKey の定義だけ欲しい時に指定(例 pointLight)。省略で全件。") },
  { readOnlyHint: true },
  ({ component }) => run(() => engine.call("describe_components", { component })),
);

reg(
  "dx12_describe_mcp_params",
  "MCP引数辞書",
  "エンジン側の MCP ハンドラが【実際に受け付ける引数キーと型】を method 名で引く辞書。"
  + "エンジンのディスパッチ表(McpDefine の第 2 引数)をそのまま返すので、"
  + "docs や このサーバの zod スキーマが古くても【エンジンの現物】が分かる。"
  + "\n■ 返り値 {methods:{<method名>:[{key,type}]}, count, globalKeys:[\"idempotency_key\"], note}。"
  + "type は bool / int / number / string / vec3 / object / any。"
  + "\"親.子\"(例 skybox.envMapPath)は入れ子オブジェクトのキー。"
  + "any は C++ 側で型を静的に決められなかっただけで「何でも通る」という意味ではない。"
  + "\n■ method には dx12_ 接頭辞を付けない(ツール名 dx12_set_dxr → method \"set_dxr\")。省略で全件。"
  + "\n■ ★使いどころ: ツールが『知らない引数』と言って弾いたときや、"
  + "設定したのに変わらないときに、まずこれでエンジンの現物と突き合わせること。",
  {
    method: z.string().optional().describe(
      "engine の method 名(dx12_ 接頭辞なし。例 \"set_dxr\")。省略で全 method を返す。"),
  },
  { readOnlyHint: true },
  ({ method }) => run(() => engine.call("describe_mcp_params", { method })),
);

reg(
  "dx12_ui_tree",
  "UIツリー取得",
  "ゲーム内 UI のツリー構造を丸ごと JSON で返す(キャンバスごと)。各ノード: {entityId, name, components(uiImage/uiButton等の種別), uiRect(anchor/offset/order/visible), resolvedRect:[x,y,w,h](レイアウト解決済み・キャンバス空間px=uiRectと同じ単位), text?, children}。★UI を組む時の基本ループ: create_entity(ui_*) → set_component(uiRect等) → ui_tree で位置を数値確認 → dx12_ui_screenshot で見た目確認。兄弟の描画順は uiRect.order(大きいほど手前)、親変更は dx12_set_parent。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("ui_tree", {})),
);

reg(
  "dx12_ui_design_brief",
  "ゲームUIデザイン方針",
  "画面を組む前に、ジャンルと画面目的から構図・視覚階層・余白・操作サイズ・避けるべきAI的表現を返す。単なる色テーマではなく、title/HUD/inventory/settings/result/dialogごとに情報設計を変える。★ui_composeや手動生成の前に呼び、返ったbriefを設計判断の基準にする。",
  {
    genre: z.enum(["cinematic", "tactical", "fantasy", "horror", "arcade", "cozy"]).describe("作品の視覚文法。安易な青紫ネオン固定を避け、ゲーム固有の方向性を選ぶ。"),
    screen: z.enum(["title", "hud", "inventory", "settings", "result", "dialog", "other"]).describe("作る画面の役割。"),
    tone: z.string().optional().describe("premium / playful / restrained / brutalist 等の補助トーン。"),
  },
  { readOnlyHint: true },
  ({ genre, screen, tone }) => run(async () => designBrief(genre, screen, tone)),
);

reg(
  "dx12_ui_audit",
  "ゲームUI品質監査",
  "現在のui_treeを自動解析し、崩れ・入力遮断・小さな操作領域・文字切れ・文字あふれ・rich/wrap競合・操作要素の重なり・過装飾・色の散乱を検出する。score/grade/passと、entityId付きの修正案を返す。★UI生成後は必ずstrictでpassさせ、その後ui_screenshotで美的判断を行う。数値監査だけで完成扱いにしない。",
  { strictness: z.enum(["balanced", "strict"]).optional().describe("strictはwarningが1件でもpass=false。最終検証ではstrict推奨。") },
  { readOnlyHint: true },
  ({ strictness }) => run(async () => auditUiTree(await engine.call("ui_tree", {}), strictness ?? "balanced")),
);

reg(
  "dx12_ui_compose",
  "制約付きゲームUI構築",
  "役割(role)とレイアウト意図(dock/stack/grid)から、Canvas・UIRect・UILayout・スタイル・ボタンラベル・控えめなインタラクションをまとめて構築する。生offsetの手計算を減らしUI崩れを防ぐ。themeは色だけでなく角・枠・コントラストの文法を変える。既存UIは消さず、prefix付きの新Canvasを作る。失敗時は作成Canvasを自動削除して半端なUIを残さない。構築後は返されるnext順にui_audit→ui_screenshot→save_sceneを行う。blueprint例: " + JSON.stringify(BLUEPRINT_EXAMPLE),
  {
    blueprint: z.any().describe("{theme,prefix,sortOrder?,root}。node={name,kind:'panel|text|button|stack|grid',role?,text?,event?,layout?,flow?,style?,textStyle?,children?}。layout.dock='fill|top|bottom|left|right|center|point', margin=数値または[l,t,r,b], width/height。stack.flow={direction:'vertical|horizontal',cellHeight,cellWidth,spacing,padding}、grid.flow={columns,...}。全nameはblueprint内で一意。"),
  },
  { destructiveHint: false },
  ({ blueprint }) => run(() => composeUi(engine, blueprint)),
);

reg(
  "dx12_describe_lua_api",
  "Lua API 辞書",
  "Lua コンポーネントスクリプトから使えるバインディング一覧を binding ごと(entity/transform/Vec3/self/scene/input/camera/physics/audio/ui/fx/events/globals/prelude)に返す静的辞書。★重要: MCP で見えるコンポーネントと Lua から読める API は違う。entity から直接読めるデータは transform だけで、entity.boxCollider 等は nil(collider/rigidBody の値は physics:getVelocity(e) 等の別 API 経由)。Lua を書く前にこれで実際に読める API を確認すると取り違えを防げる。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("describe_lua_api", {})),
);

reg(
  "dx12_get_lua_component_state",
  "Luaプロパティ状態取得",
  "エンティティの LuaScript の現在のプロパティ値を全部返す(スキーマ基準なので未上書きの既定値も含む。get_entity は保存済みの上書きしか出さない)。{scriptPath, enabled, started, loadError, errorMessage, properties:[{name,type,value,isOverride}]}。★loadError=true のとき errorMessage に Lua の traceback がそのまま入る。dx12_set_lua_property で変える前の確認に。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_lua_component_state", { entity, name })),
);

reg(
  "dx12_get_script_errors",
  "壊れているLuaを全部出す",
  "いま loadError が立っている LuaScript を全部返す: {count, mode, errors:[{entityId,name,scriptPath,message}]}。message は traceback 込み。★どのエンティティが壊れたか分からない状態ではこれを使う(dx12_get_lua_component_state は entity を1個ずつ聞くので使えない)。dx12_play の結果に scriptErrors>0 が出たら次はこれ。dx12_get_log と違ってログ行を漁らなくてよい。エラーの出たスクリプトは .lua を保存し直すだけでホットリロードされ復活する(Play を止めなくてよい)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_script_errors", {})),
);

reg(
  "dx12_reload_scripts",
  "Luaを強制リロード",
  "LuaScript を作り直して loadError を落とす: {reloaded, cleared}。★実行時エラーで死んだスクリプトを Play を止めずに復帰させる用。OnUpdate で 1 回でもエラーが出たスクリプトはそのフレーム以降まるごとスキップされるので、原因を直しても自動では戻らない場合にこれを叩く。path を渡すとその .lua を使うものだけ、省略で全部。ファイルを書き換えた場合は 0.5 秒で自動リロードされるのでこれは不要 — これが要るのは「外から状態を戻したい」「ファイルは変えずにやり直したい」ケース。Editor モードで呼ぶと env を捨てるだけで、実際の作り直しは次の Play。",
  { path: z.string().optional().describe("assets 相対の .lua パス。省略で全 LuaScript が対象") },
  {},
  ({ path }) => run(() => engine.call("reload_scripts", path ? { path } : {})),
);

reg(
  "dx12_set_lua_property",
  "Luaプロパティ設定",
  "LuaScript のプロパティを1つ書き換える(スクリプトの properties 宣言にあるものだけ)。type に応じて value は number/bool/string/[x,y,z]。Playing 中なら即再注入(スクリプト再ロード=OnStart 再実行)、Editor 中は保存だけで次 Play から反映。entity(id) か name 指定。型が不安なら先に dx12_get_lua_component_state で確認。",
  {
    ...entityRef,
    key: z.string().describe("プロパティ名(スクリプトの properties に宣言済みのもの)。"),
    value: z.any().describe("値。型はプロパティに合わせる: number / bool / string / [x,y,z](vec3,color)。"),
  },
  { idempotentHint: true },
  ({ entity, name, key, value }) =>
    run(() => engine.call("set_lua_property", { entity, name, key, value })),
);

reg(
  "dx12_project_world_to_screen",
  "ワールド→画面投影",
  "エンティティのワールド座標を、今シーンビューを描いているカメラで画面ピクセルへ投影する。{x, y, visible, depth, w, width, height, mode}。★Playing 中は m_camera=アクティブなゲームカメラなので「ゲーム画面で player が中央(x≈width/2, y≈height/2)か」「画面内(visible)か」を数値で検証できる(dx12_screenshot と同じカメラ)。w<=0 はカメラ背面。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("project_world_to_screen", { entity, name })),
);

reg(
  "dx12_get_scene_settings",
  "シーン設定取得",
  "シーンのスカイボックス/IBL 設定を返す。{skybox:{envMapPath,iblIntensity,skyboxIntensity,drawSkybox}, note}。dx12_set_scene_settings で変える前の確認に使う。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_scene_settings", {})),
);

// ════════════════════════════════════════════════════════════════
//  編集系(同期)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_set_transform",
  "Transform 設定",
  "エンティティの Transform を設定する。指定したフィールドだけ更新。回転は rotation(Euler 度) か quaternion([x,y,z,w]) のどちらか。即時反映で ok を返す。",
  {
    ...entityRef,
    position: v3().optional().describe("[x,y,z]"),
    rotation: v3().optional().describe("[x,y,z] Euler 度。quaternion と併用しない。"),
    quaternion: z.array(z.number()).length(4).optional().describe("[x,y,z,w] クォータニオン。rotation と併用しない。"),
    scale: v3().optional().describe("[x,y,z]"),
  },
  { idempotentHint: true },
  ({ entity, name, position, rotation, quaternion, scale }) =>
    run(() => engine.call("set_transform", { entity, name, position, rotation, quaternion, scale })),
);

reg(
  "dx12_set_component",
  "コンポーネント設定",
  "コンポーネントを設定(無ければ追加・あれば置換)。component は jsonKey、data は dx12_describe_components の形。tags は data=文字列配列、DataComponent(data) は {key:{t,v}} オブジェクト。即時反映で {entityId, component} を返す。形が不安なら先に dx12_describe_components を見るとええ。",
  {
    ...entityRef,
    component: z.string().describe("jsonKey。例: pointLight, directionalLight, spotLight, camera, rigidBody, boxCollider, transform, tags, data, particleEmitter, trailRenderer, decal, networkIdentity, networkTransform, sprite2d, audioSource, trigger, uiCanvas, uiRect, uiImage, uiText, uiButton, uiSlider, uiToggle, uiScrollView, uiAnimator"),
    data: z.union([z.record(z.any()), z.array(z.any())]).describe("コンポーネントの値。オブジェクト or 配列(tags は文字列配列)。dx12_describe_components の fields に合わせる。"),
  },
  { idempotentHint: true },
  ({ entity, name, component, data }) =>
    run(() => {
      // ★B11: terrain / sculptMesh / gridPlane 等はエンジンが UNKNOWN_COMPONENT で弾く
      //   (専用ツールの担当だから。詳細は sceneTools.ts の NON_SETTABLE_COMPONENTS)。
      //   "unknown" と言われると AI が名前を推測して撃ち直すので、送る前に本当の理由を返す。
      const blocked = nonSettableComponentError(component);
      if (blocked) throw blocked;
      return engine.call("set_component", { entity, name, component, data });
    }),
);

reg(
  "dx12_remove_component",
  "コンポーネント除去",
  "エンティティからコンポーネントを除去する。component は jsonKey。transform/name などコア不変のものは除去不可。即時反映で {entityId, removed} を返す。",
  {
    ...entityRef,
    component: z.string().describe("除去する jsonKey。例: pointLight, rigidBody, boxCollider, sphereCollider, camera, tags"),
  },
  { idempotentHint: true },
  ({ entity, name, component }) =>
    run(() => engine.call("remove_component", { entity, name, component })),
);

reg(
  "dx12_set_parent",
  "親子設定",
  "エンティティの親を設定する。parent 省略で親を解除。サイクルになる指定は拒否。即時反映で ok を返す。",
  {
    ...entityRef,
    parent: z.number().int().optional().describe("親エンティティ id。省略で親解除。"),
  },
  { idempotentHint: true },
  ({ entity, name, parent }) => run(() => engine.call("set_parent", { entity, name, parent })),
);

reg(
  "dx12_group_entities",
  "グループ化",
  "複数エンティティを空の親(グループ)へまとめる。ヒエラルキーの Ctrl+G と同じ。★親は原点・無回転・スケール1で作るので子のワールド位置は動かない(見た目は完全に同じまま)。以後はグループを dx12_set_transform で動かせば中身ごと移動/回転/拡縮できる。指定した中に親子関係があれば子側は自動で除外(親ごと動くため)。全員が同じ親の下にいたらグループもその親の下に入る。エディタと同じく Undo 可能。{groupId, name, count} を返す。エンティティが増えてヒエラルキーが膨れた時の整理に使う。",
  {
    entities: z.array(z.number().int()).optional().describe("まとめる エンティティ id の配列。names と併用可。"),
    names: z.array(z.string()).optional().describe("まとめる エンティティ名(完全一致)の配列。entities と併用可。"),
    name: z.string().optional().describe("グループ名。省略時 'Group'。重複したら連番が付く。"),
  },
  {},
  ({ entities, names, name }) =>
    run(() => engine.call("group_entities", { entities, names, name })),
);

reg(
  "dx12_rename_entity",
  "リネーム",
  "エンティティ名を変更する。重複名は連番(name_2 など)が付与され、確定した {name} を返す。",
  {
    entity: entityId,
    name: z.string().describe("新しい名前。"),
  },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("rename_entity", { entity, name })),
);

reg(
  "dx12_select_entity",
  "選択",
  "エディタ上で対象エンティティを選択状態にする(Inspector 表示が切り替わる)。entity(id) か name 指定。{selected} を返す。",
  { ...entityRef },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("select_entity", { entity, name })),
);

reg(
  "dx12_focus_camera",
  "カメラフォーカス",
  "エディタのフライカメラを対象エンティティに寄せる。entity(id) か name 指定。{cameraPos, target, distance} を返す。撮影前に画角を合わせるのに使う(dx12_focus_and_screenshot もある)。",
  { ...entityRef },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("focus_camera", { entity, name })),
);

reg(
  "dx12_set_pbr",
  "PBR マテリアル設定",
  "エンティティの PBR パラメータ(metallic/roughness/UV スケール)を設定する。指定分のみ更新。即時反映で {entityId, metallic, roughness, uvScaleU, uvScaleV} を返す。",
  {
    ...entityRef,
    metallic: z.number().optional().describe("金属度 0..1"),
    roughness: z.number().optional().describe("粗さ 0..1"),
    uvScaleU: z.number().optional().describe("UV の U 方向スケール(タイリング)"),
    uvScaleV: z.number().optional().describe("UV の V 方向スケール(タイリング)"),
  },
  { idempotentHint: true },
  ({ entity, name, metallic, roughness, uvScaleU, uvScaleV }) =>
    run(() => engine.call("set_pbr", { entity, name, metallic, roughness, uvScaleU, uvScaleV })),
);

reg(
  "dx12_set_color",
  "基本色設定",
  "メッシュの基本色(頂点色の乗算)を設定する。足場やコインの色付けに。color は [r,g,b](0..1)。entity(id) か name 指定。金属感は dx12_set_pbr の metallic/roughness と併用。",
  {
    ...entityRef,
    color: v3().describe("[r,g,b] 0..1。例: 金色=[1,0.84,0]"),
  },
  { idempotentHint: true },
  ({ entity, name, color }) => run(() => engine.call("set_color", { entity, name, color })),
);

reg(
  "dx12_set_mesh_shader",
  "カスタムシェーダー割当",
  "エンティティの MeshRenderer::shaderPath を設定/解除する(Inspector の「Shader」欄と同じ操作)。dx12_create_shader で作った .hlsl の assets/shaders 相対パスを渡す。shaderPath 省略/空文字で既定 Forward に戻す。modelPath と違いメッシュ再ロードを伴わないため即時反映。★スキンドメッシュ(SkeletalAnimation 持ち)は既定 Forward へ自動フォールバックする(返り値 skinnedFallbackWarning で判定可)。★シェーダーのピクセルシェーダーで alpha を出しても、既定では不透明固定(BlendEnable=FALSE)でブレンドに使われない。半透明にしたい場合は alphaBlend:true も渡すこと(Inspector の「アルファブレンド有効」チェックボックスと同じ)。entity(id) か name 指定。",
  {
    ...entityRef,
    shaderPath: z.string().optional().describe("assets/shaders 相対パス。例: ToonShade.hlsl。省略/空文字で既定 Forward に戻す。"),
    alphaBlend: z.boolean().optional().describe("true でシェーダーの alpha 出力を SrcAlpha/InvSrcAlpha ブレンドに使う(DepthWrite OFF)。省略時は既存値を維持、既定は false(不透明固定)。"),
  },
  { idempotentHint: true },
  ({ entity, name, shaderPath, alphaBlend }) => run(() => engine.call("set_mesh_shader", { entity, name, shaderPath, alphaBlend })),
);

reg(
  "dx12_set_sprite_shader",
  "Sprite2Dカスタムシェーダー割当",
  "エンティティの Sprite2D::shaderPath を設定/解除する(Inspector の Sprite2D「Shader」欄と同じ操作)。world-space スプライトのみ対応(HUD不可)。dx12_create_shader で作った .hlsl の assets/shaders 相対パスを渡す。shaderPath 省略/空文字で既定 Sprite シェーダーに戻す。★MeshRendererのカスタムシェーダーとはルートシグネチャ/頂点フォーマットの契約が異なる(cbuffer b0 = float4x4 transform + float time、頂点は POSITION/TEXCOORD0/COLOR0/TEXCOORD1(effect)、詳細はdocs/AUTHORING.md)ため同じ.hlslは使い回せない。alphaBlend は Inspector の「アルファブレンド有効」と同じ。entity(id) か name 指定。",
  {
    ...entityRef,
    shaderPath: z.string().optional().describe("assets/shaders 相対パス。例: Dissolve.hlsl。省略/空文字で既定 Sprite シェーダーに戻す。"),
    alphaBlend: z.boolean().optional().describe("true でシェーダーの alpha 出力を SrcAlpha/InvSrcAlpha ブレンドに使う(DepthWrite OFF)。省略時は既存値を維持、既定は false(不透明固定)。"),
  },
  { idempotentHint: true },
  ({ entity, name, shaderPath, alphaBlend }) => run(() => engine.call("set_sprite_shader", { entity, name, shaderPath, alphaBlend })),
);

reg(
  "dx12_set_scene_settings",
  "シーン設定変更",
  "シーンのスカイボックス/IBL を設定する。skybox 内の指定フィールドだけ適用。★適用後にエンジンから読み返した実値を current に返す(envMapPath を変えたときは envMapRebake も)。",
  {
    // ★入れ子も passthrough。素の z.object は skybox 内の未知キーを黙って捨てるため、
    //   skybox:{envMapPath:...} の打ち間違いが無言で無視されていた(下のハンドラで弾く)。
    skybox: z.object({
      envMapPath: z.string().optional().describe("環境マップ(HDR/EXR 等)の assets 相対パス。"),
      iblIntensity: z.number().optional().describe("IBL(間接光)の強さ。"),
      skyboxIntensity: z.number().optional().describe("スカイボックス描画の明るさ。"),
      drawSkybox: z.boolean().optional().describe("スカイボックスを描画するか。"),
    }).passthrough().describe("スカイボックス設定。指定したフィールドのみ適用。"),
  },
  { idempotentHint: true },
  ({ skybox }) => run(async () => {
    const known = ["envMapPath", "iblIntensity", "skyboxIntensity", "drawSkybox"];
    const bad = unknownParamKeys(skybox, known);
    if (bad.length > 0) throw unknownKeyError("dx12_set_scene_settings skybox", bad, known);
    const clean = definedOnly(skybox ?? {});
    const r = await engine.call("set_scene_settings", { skybox: clean }) as Record<string, unknown>;
    const current = await engine.call("get_scene_settings", {}).catch(() => null);
    const mismatched = verifyApplied({ skybox: clean }, current);
    return {
      applied: mismatched.length === 0,
      envMapRebake: r?.envMapRebake ?? false,
      current,
      ...(mismatched.length > 0
        ? { mismatched, hint: "要求した値がエンジンに入っていない。current の実値を見て次の手を決めること" }
        : {}),
    };
  }),
);

reg(
  "dx12_undo",
  "Undo",
  "エディタの Undo スタックを 1 つ戻す。フレーム境界で適用され {queuedUndo, undoable, willUndo} を返す。" +
    "★Undo に積まれる MCP 編集は dx12_group_entities / dx12_spawn_prefab / 地形とスカルプトの編集" +
    "(dx12_terrain_generate・dx12_terrain_sculpt・dx12_terrain_erode・dx12_terrain_paint・" +
    "dx12_terrain_autopaint・dx12_sculpt_brush)だけ。" +
    "set_transform / set_component 等は積まれないので、それらを取り消すつもりで呼ぶと" +
    "スタックの一番上にある別の操作(エディタでの編集や entity 生成)が戻る。戻す前に willUndo を見て、" +
    "自分の操作でなければ呼ばないこと。MCP の変更を戻したいなら反対の値を set し直す。",
  {},
  {},
  () => run(() => engine.call("undo", {})),
);

reg(
  "dx12_redo",
  "Redo",
  "取り消した操作をやり直す。フレーム境界で適用され {queuedRedo, redoable, willRedo} を返す。",
  {},
  {},
  () => run(() => engine.call("redo", {})),
);

reg(
  "dx12_save_scene",
  "シーン保存",
  "現在のシーンを保存する。path は assets 相対(例 scenes/title.json)。省略時は現在開いてるシーンへ上書き。{path} を返す。",
  { path: z.string().optional().describe("assets 相対パス。例: scenes/title.json。省略で上書き保存。") },
  { idempotentHint: true },
  ({ path }) => run(() => engine.call("save_scene", { path })),
);

reg(
  "dx12_create_lua_component",
  "Luaコンポーネント作成",
  "Lua コンポーネント(.lua)を assets/components/ に作成する。書き込み前に構文検証され、エラーなら書かず error を返す。返り値 {path} を dx12_attach_lua_component の script に渡す。",
  {
    name: z.string().describe("コンポーネント名(拡張子・パス区切りなし)。例: Health"),
    code: z.string().describe("Lua コード全体。properties / OnStart / OnUpdate を含められる。"),
  },
  {},
  ({ name, code }) => run(() => engine.call("create_lua_component", { name, code })),
);

reg(
  "dx12_attach_lua_component",
  "Luaコンポーネントアタッチ",
  "Lua コンポーネントをエンティティにアタッチする。エディタ上では貼るだけで、実際の初期化/実行は Play 時(OnStart/OnUpdate)。script は assets 相対(assets 配下限定)。即時反映で ok を返す。",
  {
    ...entityRef,
    script: z.string().describe("assets 相対パス。例: components/Health.lua"),
  },
  {},
  ({ entity, name, script }) => run(() => engine.call("attach_lua_component", { entity, name, script })),
);

reg(
  "dx12_create_shader",
  "カスタムシェーダー作成",
  "カスタムシェーダー(.hlsl)を assets/shaders/ に作成/上書きする(MeshRenderer::shaderPath 割当用)。★Lua と違い書く前の静的検証はできない(DXC はファイルからしかコンパイルできない)ので、まず書き込んでから即コンパイルを試し、成否をそのまま返す(失敗しても書いたファイルは残る=直して dx12_create_shader を撃ち直す反復修正が前提)。エントリポイントは VSMain(vs_6_0)/PSMain(ps_6_0)固定、静的メッシュ用の共有 RootSignature(b0=PerObject mvp+model, b1=PerFrameの先頭部分, t0+s0=アルベド)に合わせて書く。返り値 {path, compiled, error?}。compiled=false なら error を読んで直し、再度このツールで書き戻す。エンティティへの割当は dx12_set_mesh_shader。",
  {
    name: z.string().describe("シェーダー名(拡張子・パス区切りなし)。例: ToonShade"),
    code: z.string().describe("HLSL コード全体(VSMain/PSMain を含む)。dx12_read_shader で既存のテンプレ/ソースを読んでから書き換えるとよい。"),
  },
  {},
  ({ name, code }) => run(() => engine.call("create_shader", { name, code })),
);

reg(
  "dx12_read_shader",
  "カスタムシェーダー読み取り",
  "既存のカスタムシェーダー(.hlsl)のソースをそのまま読む。dx12_create_shader は新規/上書き書き込み専用で読み取りが無いため、既存シェーダーを確認してから修正版を書き戻す編集ループに使う。{path, code, compiled}(compiled は直近の既知のコンパイル成否)。",
  { path: z.string().describe("assets/shaders 相対パス。例: ToonShade.hlsl") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("read_shader", { path })),
);

// ════════════════════════════════════════════════════════════════
//  編集系(遅延同期)— 本物の結果が【同期で】返る。{queued} は返らへん。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_create_entity",
  "エンティティ生成",
  "エンティティを生成する(エディタ専用)。フレーム境界で実処理されるが、Node が完了を待って【本物の {entityId, name, sceneGeneration} を同期で返す】({queued} は返らへん)。idempotency_key を付けると、再試行で同じキーが来ても二重生成されず同じ結果が返る。light_*/camera/particle_emitter/trigger は既定パラメータで生成される空エンティティ+コンポーネント(中身は dx12_describe_components 参照)。細かい値は生成後 dx12_set_component / dx12_set_transform で調整する。★ui_* はゲーム内UI: エディタと同じ部品構成で生成(ui_button=背景+ラベル子、ui_toggle=箱+ラベル子)され、応答に entityIds(生成された全id)も付く。親は parent/parentName で明示指定(省略時は最初のCanvas、Canvas不在なら自動生成)。レイアウト調整は set_component の uiRect、構造確認は dx12_ui_tree、見た目確認は dx12_ui_screenshot。",
  {
    type: z.enum([
      "box", "sphere", "plane", "empty", "camera",
      "light_directional", "light_point", "light_spot",
      "particle_emitter", "trigger", "decal",
      "ui_canvas", "ui_image", "ui_text", "ui_button",
      "ui_slider", "ui_toggle", "ui_scrollview",
    ]).describe("種別。empty は Transform のみ。light_*/camera/particle_emitter/trigger は該当コンポーネント付きで生成(値は既定。set_component で調整)。ui_* はゲーム内UI要素(uiRect 等付き)。"),
    name: z.string().optional().describe("エンティティ名(一意推奨)。省略時は種別名。"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。UI 要素では未使用(uiRect で配置)。"),
    parent: z.number().int().optional().describe("UI 要素の親エンティティ id(ui_canvas 以外で有効)。parentName と排他。"),
    parentName: z.string().optional().describe("UI 要素の親エンティティ名(完全一致)。"),
    idempotency_key: z.string().optional().describe("再試行の重複防止キー。同じキーの再送は二重生成されない。"),
  },
  {},
  ({ type, name, position, parent, parentName, idempotency_key }) =>
    run(() => engine.call("create_entity", { type, name, position, parent, parentName, idempotency_key })),
);

// プリミティブを1コールで生成＋整形する合成ヘルパ(create_entity → set_transform/set_pbr/set_color)。
// create_entity は遅延同期で本物の entityId を返すので、それを使って後段を適用する。
async function spawnPrimitive(
  type: "box" | "sphere",
  a: { name?: string; position?: number[]; scale?: number[]; rotation?: number[];
       color?: number[]; metallic?: number; roughness?: number },
) {
  const r = await engine.call("create_entity", { type, name: a.name, position: a.position });
  const entity = r.entityId;
  if (a.scale || a.rotation)
    await engine.call("set_transform", { entity, scale: a.scale, rotation: a.rotation });
  if (a.metallic != null || a.roughness != null)
    await engine.call("set_pbr", { entity, metallic: a.metallic, roughness: a.roughness });
  if (a.color) await engine.call("set_color", { entity, color: a.color });
  return r;
}

reg(
  "dx12_spawn_box",
  "ボックス生成(整形込み)",
  "ボックス(立方体)を1コールで生成。足場/壁/床に最適。position/scale/rotation/color/metallic/roughness をまとめて指定でき、内部で create_entity→set_transform→set_pbr→set_color を順に実行する。{entityId, name, sceneGeneration} を返す。",
  {
    name: z.string().optional().describe("エンティティ名。省略時 'Box'。"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    scale: v3().optional().describe("[x,y,z]。足場なら例 [4,0.5,4]。"),
    rotation: v3().optional().describe("[x,y,z] Euler 度。"),
    color: v3().optional().describe("[r,g,b] 0..1 基本色。"),
    metallic: z.number().optional().describe("金属度 0..1。"),
    roughness: z.number().optional().describe("粗さ 0..1。"),
  },
  {},
  (a) => run(() => spawnPrimitive("box", a)),
);

reg(
  "dx12_spawn_sphere",
  "スフィア生成(整形込み)",
  "スフィア(球)を1コールで生成。position/scale/rotation/color/metallic/roughness をまとめて指定可。{entityId, name, sceneGeneration} を返す。",
  {
    name: z.string().optional().describe("エンティティ名。省略時 'Sphere'。"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    scale: v3().optional().describe("[x,y,z]。"),
    rotation: v3().optional().describe("[x,y,z] Euler 度。"),
    color: v3().optional().describe("[r,g,b] 0..1 基本色。"),
    metallic: z.number().optional().describe("金属度 0..1。"),
    roughness: z.number().optional().describe("粗さ 0..1。"),
  },
  {},
  (a) => run(() => spawnPrimitive("sphere", a)),
);

reg(
  "dx12_spawn_coin",
  "コイン生成",
  "コイン風の収集アイテムを1コールで生成(金色の薄い円盤状スフィア + tag 'coin' + 金属光沢)。足場ゲームの収集物置きに。position/name 指定可。回転やスコア加算は別途 Lua/trigger で付ける。{entityId, name, sceneGeneration} を返す。",
  {
    name: z.string().optional().describe("エンティティ名。省略時 'Coin'。"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。"),
  },
  {},
  ({ name, position }) => run(async () => {
    const r = await engine.call("create_entity", { type: "sphere", name: name ?? "Coin", position });
    const entity = r.entityId;
    await engine.call("set_transform", { entity, scale: [0.5, 0.5, 0.12] });   // 薄い円盤風
    await engine.call("set_pbr", { entity, metallic: 1.0, roughness: 0.25 });  // 金属光沢
    await engine.call("set_color", { entity, color: [1.0, 0.84, 0.0] });        // 金色
    await engine.call("set_component", { entity, component: "tags", data: ["coin"] });
    return { ...r, tag: "coin" };
  }),
);

reg(
  "dx12_spawn_model",
  "モデル生成",
  "モデル(.gltf/.glb/.fbx/.obj)を assets 相対パスから生成する。GPU ロードを伴いフレーム境界で実処理されるが、Node が完了を待って【本物の {entityId, name, sceneGeneration} を同期で返す】。idempotency_key で再試行の二重生成を防げる。",
  {
    path: z.string().describe("assets 相対パス。例: models/player.glb"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    name: z.string().optional().describe("エンティティ名。省略時はファイル名(拡張子なし)。"),
    idempotency_key: z.string().optional().describe("再試行の重複防止キー。同じキーの再送は二重生成されない。"),
  },
  {},
  ({ path, position, name, idempotency_key }) =>
    run(() => engine.call("spawn_model", { path, position, name, idempotency_key })),
);

reg(
  "dx12_spawn_prefab",
  "プレハブ生成",
  "プレハブ(.prefab)を assets 相対パスから生成する。フレーム境界で実処理され、Node が完了を待って【本物の {entityId, rootEntityId, entityIds:[...], name, sceneGeneration} を同期で返す】。"
  + "★idempotency_key を付けると再送で二重生成されない。2 回目は生成せず 1 回目のサブツリーを "
  + "{idempotentReplay:true, rootEntityId, entityIds:[...]} で返す(リプレイでも entityIds は全部揃う)。"
  + "キーはシーンをまたがない(dx12_open_scene / dx12_new_scene で捨てられる)し、記録した entity が削除済みなら普通に生成し直す。",
  {
    path: z.string().describe("assets 相対パス。例: prefabs/enemy.prefab"),
    position: v3().optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    name: z.string().optional().describe("ルートエンティティ名。省略時はプレハブ名。"),
    idempotency_key: z.string().optional().describe("再試行の重複防止キー。同じキーの再送は二重生成されず、1 回目の {rootEntityId, entityIds} が idempotentReplay:true 付きで返る。"),
  },
  {},
  ({ path, position, name, idempotency_key }) =>
    run(() => engine.call("spawn_prefab", { path, position, name, idempotency_key })),
);

reg(
  "dx12_duplicate_entity",
  "複製",
  "エンティティを子ごとディープ複製する。entity(id) か name 指定。フレーム境界で実処理され、Node が完了を待って【本物の {entityId, name, sceneGeneration} を同期で返す】。",
  { ...entityRef },
  {},
  ({ entity, name }) => run(() => engine.call("duplicate_entity", { entity, name })),
);

reg(
  "dx12_delete_entity",
  "削除",
  "エンティティを子ごと削除する(Undo 可)。entity(id) か name 指定。フレーム境界で実処理され、Node が完了を待って【本物の {deletedEntityId, deletedCount, sceneGeneration} を同期で返す】。",
  { ...entityRef },
  { destructiveHint: true },
  ({ entity, name }) => run(() => engine.call("delete_entity", { entity, name })),
);

reg(
  "dx12_open_scene",
  "シーンを開く",
  "シーンを開く(現在のシーンを置換)。path は assets 相対。重い遷移をフレーム境界で実処理し、Node が完了を待って【本物の {sceneName, path, entityCount, sceneGeneration} を同期で返す】。開いた後は古い entityId は無効になる(sceneGeneration が変わる)ので list し直すこと。",
  { path: z.string().describe("assets 相対パス。例: scenes/title.json") },
  {},
  ({ path }) => run(() => engine.call("open_scene", { path })),
);

reg(
  "dx12_open_project",
  "プロジェクトを開く",
  "プロジェクトを開く(ランチャーのクリックと同等)。path はプロジェクトルートの絶対パス(.dx12proj のあるフォルダ)。アセットルート/シーン/game.lua がそのプロジェクトに切り替わる。ロードは非同期に数フレームかけて進むので、完了確認は dx12_ping の currentScene / entityCount で行うこと。開いた後は古い entityId は無効になる。",
  { path: z.string().describe("プロジェクトルートの絶対パス。例: C:/Users/me/MyGame") },
  {},
  ({ path }) => run(() => engine.call("open_project", { path })),
);

reg(
  "dx12_new_scene",
  "新規シーン",
  "新規シーンを作る(現在のシーンを破棄)。savePath を渡すとそのパスに紐づけて作る。フレーム境界で実処理され {applied} を同期で返す。現在の編集内容は失われるので注意。",
  { savePath: z.string().optional().describe("新シーンの保存先 assets 相対パス(任意)。") },
  { destructiveHint: true },
  ({ savePath }) => run(() => engine.call("new_scene", { savePath })),
);

reg(
  "dx12_play",
  "再生開始",
  "Editor → Playing へ切り替える。フレーム境界で実処理され {mode:'Playing', sceneGeneration, scriptErrors} を同期で返す。カメラ無し等で再生不可なら error(code=3 MODE_CONFLICT)。★scriptErrors>0 なら Lua がその数だけ死んでいる(Play 自体は成功する) — 絵を見る前に dx12_get_script_errors を叩くこと。",
  {},
  {},
  () => run(() => engine.call("play", {})),
);

reg(
  "dx12_stop",
  "再生停止",
  "Playing → Editor へ切り替える(再生前のスナップショットに復元)。フレーム境界で実処理され {mode:'Editor', sceneGeneration} を同期で返す。★Stop ではシーンを丸ごと作り直すため全 entity id が変わる(sceneGeneration も +1)。Stop 後は古い id を使わず、返ってきた sceneGeneration の変化を見て dx12_list_entities で取り直すか、各ツールに name 指定で操作する。",
  {},
  {},
  () => run(() => engine.call("stop", {})),
);

reg(
  "dx12_get_play_session",
  "人間のプレイ記録を取る",
  "直近の Play 1 回ぶんの記録を返す。★dx12_play を押した時点で自動的に記録が始まる(開始ツールは無い)。Stop 後も次の Play まで残るので、人間に遊んでもらってから取りに来ればよい。返る形: {started, recording, durationSec, frames, fpsMin, summary:{errors,warnings,inputEvents,...}, events:[{t,kind,detail}], samples:[{t,fps,camPos,camYaw,camPitch,mouse}]}。kind は key_down/key_up/pad_down/pad_up(操作) と error/warn/lua(ログ)。detail のキー名は dx12_key_press にそのまま渡せる。samples は 10Hz。★挙動のデバッグは AI が合成入力で動かすより、人間に遊ばせてこれを読む方が正確。",
  {
    maxEvents: z.number().int().optional().describe("返すイベント数の上限(既定 400、最大 8000)。新しい方から残す。"),
    maxSamples: z.number().int().optional().describe("返すサンプル数の上限(既定 200、最大 4000)。新しい方から残す。"),
  },
  { readOnlyHint: true },
  ({ maxEvents, maxSamples }) => run(() => engine.call("get_play_session", { maxEvents, maxSamples })),
);

// ── 入力シミュレーション(Playing 中の挙動確認用)─────────────────
// Lua の input:isKeyDown/isKeyPressed(prelude の keyDown/keyPressed)に効く。
// GetAsyncKeyState を読む isAsyncKeyDown 系には効かない。エンジンウィンドウがフォーカスを
// 失うと合成キーはクリアされる(WM_KILLFOCUS)。

reg(
  "dx12_key_down",
  "キー押下(保持)",
  "キーを押した状態にする(key_up を呼ぶまで保持)。次フレーム以降の Lua input:isKeyDown / keyDown() が true になる。横移動など「押しっぱなし」の挙動確認に。key は VK 整数 or 名前(\"W\",\"D\",\"SPACE\",\"UP\" 等)。Playing 中に使う(isAsyncKeyDown 系には効かない)。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名(\"W\",\"SPACE\",\"UP\",\"F1\" 等)") },
  {},
  ({ key }) => run(() => engine.call("key_down", { key })),
);

reg(
  "dx12_key_up",
  "キー離す",
  "dx12_key_down で押したキーを離す。key は VK 整数 or 名前。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名") },
  {},
  ({ key }) => run(() => engine.call("key_up", { key })),
);

reg(
  "dx12_key_press",
  "キータップ(1フレーム)",
  "キーを1フレームだけ押して離す(isKeyPressed / keyPressed() が1回立つ)。ジャンプ(SPACE)などのタップ操作の確認に。key は VK 整数 or 名前。押しっぱなしにはならない。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名(\"SPACE\" 等)") },
  {},
  ({ key }) => run(() => engine.call("key_press", { key })),
);

reg(
  "dx12_step_frames",
  "Nフレーム進める",
  "N フレーム経過してから応答する同期バリア。key_down/key_press の後に呼ぶと、入力がシミュレーションに効いてから dx12_get_entity / dx12_project_world_to_screen / dx12_screenshot で結果を観測できる。例: key_down('D') → step_frames(30) → get_entity(name:'Player') で右に動いたか確認 → key_up('D')。frames は 1..600(~10s)。※決定論ステッパではない(各フレーム dt は実時間)。",
  { frames: z.number().int().optional().describe("進めるフレーム数(既定 1, 最大 600)。") },
  {},
  ({ frames }) => run(() => engine.call("step_frames", { frames })),
);

reg(
  "dx12_perf_stats",
  "パフォーマンス統計",
  "直近 window フレーム(既定60)の性能統計を即時取得。fps / frameMs(avg,min,max,p95) / cpu(workMs,fenceWaitMs,presentMs) / "
  + "gpuPassMs(total, shadows, depthPrepass, prepassSsao, clusterCull, raytracing, rtScreen, ddgi, screenSpaceGi, volFog, hiZ, mainScene, particles, postFx, ui "
  + "※約3フレーム遅れのGPUタイムスタンプ。raytracing = DXR の BLAS 遅延構築 + TLAS の毎フレーム再構築(加速構造だけ)、"
  + "rtScreen = RT サン影 + RT-AO + RT デバッグのスクリーン空間パス。どちらも DXR OFF なら 0) / "
  + "drawCalls / culled / triangles / vsync / fpsLimit / scene(エンティティ内訳・shadows/ssao) と "
  + "analysis(verdict: gpu-bound|cpu-bound|fps-limit-capped 等 + 改善ノート)を返す。FPS が出ない時はまずこれで犯人を特定する。",
  { window: z.number().int().optional().describe("平均するフレーム数(既定 60, 最大 240)。") },
  { readOnlyHint: true },
  ({ window }) => run(() => engine.call("perf_stats", { window })),
);

reg(
  "dx12_benchmark",
  "ベンチマーク実行",
  "N フレーム(既定300, 30..3600)計測してから統計を返す遅延同期ベンチ。返り値は dx12_perf_stats と同形式 + frames / fps1PercentLow(p99フレーム時間の逆数=スパイク体感指標)。★既定で計測中だけ FPS上限/VSync を外す(uncap)ので、fpsLimit に張り付かない真のスループットが出る。カメラ位置・シーン・Play/Editor 状態は呼び出し側が事前に整えること。最適化の前後で同条件で回して比較するのが正しい使い方。実行中の重複呼び出しはエラー。",
  {
    frames: z.number().int().optional().describe("計測フレーム数(既定 300)。30..3600。"),
    uncap: z.boolean().optional().describe("計測中だけ FPS上限/VSync を外す(既定 true)。false で普段の設定のまま測る。"),
  },
  { readOnlyHint: true },
  ({ frames, uncap }) =>
    run(() =>
      engine.call("benchmark", { frames, uncap }, {
        // 30fps まで落ちてても間に合う余裕: frames×34ms + 10s
        timeout: (frames ?? 300) * 67 + 10000,
      })),
);

// ════════════════════════════════════════════════════════════════
//  ランタイム物理検証(raycast/overlap/velocity) — 全て同期・読み取り系。
//  bodies は Play 中のみ登録される(RegisterBody は Play 開始/loadScene 時)。
//  Editor 中に呼んでもエラーにはならず hit=false / entities=[] / velocity=[0,0,0] が返る。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_raycast",
  "レイキャスト",
  "origin から direction 方向へ物理レイを飛ばし、最初にヒットしたボディを調べる。★Playing 中のみ意味のある結果(Editor 中は body 未登録なので hit=false)。{hit, distance?, point?, normal?, entityId?, name?}。normal はヒット面の真の法線(Jolt の GetWorldSpaceSurfaceNormal)。当たり判定確認・地面/壁の検出・ラインオブサイトの確認に。",
  {
    origin: v3().describe("[x,y,z] レイの始点。"),
    direction: v3().describe("[x,y,z] レイの方向(正規化不要。エンジン側で正規化される)。"),
    maxDistance: z.number().optional().describe("最大距離(既定 1000)。"),
  },
  { readOnlyHint: true },
  ({ origin, direction, maxDistance }) =>
    run(() => engine.call("raycast", { origin, direction, maxDistance })),
);

reg(
  "dx12_overlap_box",
  "ボックス範囲の物理クエリ",
  "center を中心とする AABB(半幅 halfExtents)と重なっている物理ボディのエンティティを列挙する。★Playing 中のみ意味のある結果。{entities:[{entityId,name}], count}。dx12_query_entities の box(Transform.position ベースの単純判定)とは違い、実際のコライダー形状で判定する。",
  {
    center: v3().describe("[x,y,z]"),
    halfExtents: v3().describe("[x,y,z] AABB の半幅。"),
    maxResults: z.number().int().optional().describe("最大取得数(既定 32、上限 256)。"),
  },
  { readOnlyHint: true },
  ({ center, halfExtents, maxResults }) =>
    run(() => engine.call("overlap_box", { center, halfExtents, maxResults })),
);

reg(
  "dx12_overlap_sphere",
  "球範囲の物理クエリ",
  "center を中心とする半径 radius の球と重なっている物理ボディのエンティティを列挙する。★Playing 中のみ意味のある結果。{entities:[{entityId,name}], count}。爆発範囲・索敵範囲・トリガー代替の確認に。",
  {
    center: v3().describe("[x,y,z]"),
    radius: z.number().describe("半径。"),
    maxResults: z.number().int().optional().describe("最大取得数(既定 32、上限 256)。"),
  },
  { readOnlyHint: true },
  ({ center, radius, maxResults }) =>
    run(() => engine.call("overlap_sphere", { center, radius, maxResults })),
);

reg(
  "dx12_get_physics_state",
  "物理ランタイム状態取得",
  "エンティティの物理ランタイム状態(速度・接地判定)を読む。{entityId, hasRigidBody, velocity:[x,y,z], hasCharacterController, isGrounded}。★Playing 中のみ意味のある結果(Editor 中は velocity=[0,0,0]/isGrounded=false)。RigidBody が無ければ velocity は常に [0,0,0]。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_physics_state", { entity, name })),
);

// ════════════════════════════════════════════════════════════════
//  コンテンツ制作ヘルパー拡充
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_read_lua_component",
  "Luaコンポーネント読み取り",
  "既存の .lua コンポーネントのソースをそのまま読む。dx12_create_lua_component は新規/上書き書き込み専用で読み取りが無かったため追加。既存スクリプトを確認してから修正版を dx12_create_lua_component で書き戻す、という編集ループに使う。{path, code}。",
  { path: z.string().describe("assets 相対パス。例: components/Health.lua") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("read_lua_component", { path })),
);

reg(
  "dx12_create_prefab",
  "プレハブ化",
  "エンティティ(+子孫)を .prefab として保存する(Hierarchy 右クリック「プレハブにする」と同じ処理)。path 省略時は assets/prefabs/<エンティティ名>.prefab に保存(重複時は連番)。{path, entityId}。entity(id) か name 指定。",
  {
    ...entityRef,
    path: z.string().optional().describe("assets 相対パス(.prefab 必須)。省略時は assets/prefabs/<name>.prefab。"),
  },
  {},
  ({ entity, name, path }) => run(() => engine.call("create_prefab", { entity, name, path })),
);

// ════════════════════════════════════════════════════════════════
//  ビジュアル/ポスト設定の操作(ポストプロセス・SSAO)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_get_post_process",
  "ポストプロセス設定取得",
  "現在のシーンのポストプロセス設定(約25エフェクトの on/off とパラメータ)を全て返す。フィールド名は dx12_set_post_process と同じ(例 exposureOn/exposure, bloomOn/bloom/bloomThreshold, tintOn/tint, outlineOn/outline/outlineColor 等)。変更前の確認に。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_post_process", {})),
);

reg(
  "dx12_set_post_process",
  "ポストプロセス設定変更",
  "ポストプロセスのフィールドを指定分だけ更新する(未指定フィールドは現状維持)。カラーグレーディング(exposure/contrast/brightness/saturation/warmth/hueShift/tint) / 自動露出(autoExposureOn/ae*) / 3D LUT(lutOn/lutPath/lutAmount) / ブルーム・ビネット(bloom/bloomThreshold/bloomKnee/bloomRadius/vignette) / ゴッドレイ(godraysOn/gr*) / レンズフレア(lensflareOn/lf*) / 被写界深度(dofOn/dof*) / モーションブラー(motionBlurOn/mb*) / スタイライズ(chromatic/pixelSize/posterize/ditherLevels/scanline/sharpen/grain) / 色操作(invert/sepia/grayscale) / 歪み(lens/waveAmp・Freq・Speed/radial/glitch) / 輪郭(outline/outlineColor) / fxaaOn / debandOn。各エフェクトは <name>On(bool) で有効化しないと数値を変えても見た目に効かない。先に dx12_get_post_process で現状値を確認するとよい。★適用後にエンジンから読み返した実値を current に入れて返す(要求と食い違うものは mismatched に出る)。",
  {
    enabled: z.boolean().optional().describe("マスタースイッチ(false で全エフェクト素通し)。"),
    // エンジンは以前から tonemapper を受けていたのに、このスキーマに無いせいで MCP から渡せなかった。
    // exposure と並んで dx12_screenshot(シーン RT の CPU トーンマップ)に反映される数少ないノブなので、
    // dx12_look_compare の示唆から実際に触れるようにここへ追加する。
    tonemapper: z.number().int().optional().describe("トーンマッパー: 0=ACES / 1=AgX / 2=なし(ガンマのみ)。★exposure と共に dx12_screenshot にも反映される(他のグレーディングは反映されない)。"),
    exposureOn: z.boolean().optional(), exposure: z.number().optional(),
    contrastOn: z.boolean().optional(), contrast: z.number().optional(),
    brightnessOn: z.boolean().optional(), brightness: z.number().optional(),
    saturationOn: z.boolean().optional(), saturation: z.number().optional(),
    warmthOn: z.boolean().optional(), warmth: z.number().optional(),
    hueOn: z.boolean().optional(), hueShift: z.number().optional(),
    tintOn: z.boolean().optional(), tint: v3().optional(),
    bloomOn: z.boolean().optional(), bloom: z.number().optional(), bloomThreshold: z.number().optional(),
    // ↓ bloomKnee / bloomRadius 以下は「エンジンは受けているのにスキーマに無い＝渡しても黙って捨てられる」
    //   状態だった分（PostProcessSettings.h の DX12E_POST_FIELDS が正。schemaDrift.test.ts が再発を止める）。
    bloomKnee: z.number().optional().describe("しきい値のソフト肩。既定 0.5。"),
    bloomRadius: z.number().optional().describe("アップサンプル合成率。大きいほど広く柔らかい。既定 0.65。"),
    vignetteOn: z.boolean().optional(), vignette: z.number().optional(),
    // ── 自動露出(eye adaptation。compute のヒストグラムで測光して時間追従) ──
    autoExposureOn: z.boolean().optional().describe("自動露出。ON にすると exposure より優先して効く。"),
    aeSpeed: z.number().optional().describe("適応速度(1/秒)。既定 2。"),
    aeEvComp: z.number().optional().describe("EV 補正(+で明るく)。既定 0。"),
    aeLogMin: z.number().optional().describe("測光レンジ下限(log2 輝度)。既定 -8。"),
    aeLogMax: z.number().optional().describe("測光レンジ上限(log2 輝度)。既定 4。"),
    // ── 3D LUT カラーグレーディング(トーンマップ後の LDR に適用) ──
    lutOn: z.boolean().optional().describe("3D LUT を有効化。"),
    lutPath: z.string().optional().describe("LUT 画像の assets 相対パス(ストリップ形式 N*N x N。例 1024x32)。"),
    lutAmount: z.number().optional().describe("LUT の適用率 0..1。既定 1。"),
    // ── ゴッドレイ(スクリーンスペース光条。平行光源が画面内/近くにある時のみ) ──
    godraysOn: z.boolean().optional().describe("ゴッドレイ(光芒)。★ボリュメトリックフォグと同時に使うと太陽の散乱が二重計上になる。"),
    grIntensity: z.number().optional().describe("光条の強さ。既定 0.6。"),
    grDensity: z.number().optional().describe("行進距離(大きいほど長い光条)。既定 0.9。"),
    grDecay: z.number().optional().describe("タップ毎の減衰(1 に近いほど遠くまで伸びる)。既定 0.96。"),
    // ── レンズフレア(疑似・ブルームチェーン入力。ブルームと併用推奨) ──
    lensflareOn: z.boolean().optional().describe("レンズフレア。bloomOn と併用推奨。"),
    lfIntensity: z.number().optional().describe("強度。既定 0.5。"),
    lfGhosts: z.number().int().optional().describe("ゴースト数 1..8。既定 4。"),
    lfDispersal: z.number().optional().describe("ゴースト間隔。既定 0.35。"),
    lfHalo: z.number().optional().describe("ハロー半径。既定 0.45。"),
    lfChroma: z.number().optional().describe("色収差量。既定 0.01。"),
    // ── 被写界深度(gather ボケ。透視カメラのみ) ──
    dofOn: z.boolean().optional().describe("被写界深度。★正射カメラでは効かない。"),
    dofFocusDist: z.number().optional().describe("フォーカス距離(カメラからのビュー距離)。既定 8。"),
    dofFocusRange: z.number().optional().describe("完全にシャープな範囲の広さ。既定 5。"),
    dofBlurSize: z.number().optional().describe("最大ボケ半径(px)。既定 12。"),
    // ── カメラモーションブラー(深度再構成方式・velocity buffer 不要) ──
    motionBlurOn: z.boolean().optional().describe("カメラモーションブラー。"),
    mbStrength: z.number().optional().describe("シャッター係数(速度に乗算)。既定 0.5。"),
    mbSamples: z.number().int().optional().describe("タップ数 4..16。既定 10。"),
    chromaticOn: z.boolean().optional(), chromatic: z.number().optional(),
    pixelizeOn: z.boolean().optional(), pixelSize: z.number().optional(),
    posterizeOn: z.boolean().optional(), posterize: z.number().int().optional(),
    ditherOn: z.boolean().optional(), ditherLevels: z.number().int().optional(),
    scanlineOn: z.boolean().optional(), scanline: z.number().optional(),
    sharpenOn: z.boolean().optional(), sharpen: z.number().optional(),
    grainOn: z.boolean().optional(), grain: z.number().optional(),
    invertOn: z.boolean().optional(), invert: z.number().optional(),
    sepiaOn: z.boolean().optional(), sepia: z.number().optional(),
    grayscaleOn: z.boolean().optional(), grayscale: z.number().optional(),
    lensOn: z.boolean().optional(), lens: z.number().optional(),
    waveOn: z.boolean().optional(), waveAmp: z.number().optional(), waveFreq: z.number().optional(), waveSpeed: z.number().optional(),
    radialOn: z.boolean().optional(), radial: z.number().optional(),
    glitchOn: z.boolean().optional(), glitch: z.number().optional(),
    outlineOn: z.boolean().optional(), outline: z.number().optional(), outlineColor: v3().optional(),
    fxaaOn: z.boolean().optional(),
    debandOn: z.boolean().optional().describe("8bit 出力のバンディング除去(TPDF ディザ)。既定 ON。切ると空やビネットに縞が出る。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_post_process", "get_post_process", a)),
);

reg(
  "dx12_get_ssao",
  "SSAO設定取得",
  "現在のシーンの SSAO(スクリーンスペース環境遮蔽)設定を返す。{enabled, radius, bias, intensity, power, sampleCount, blur}。★正射カメラ(俯瞰パズル等)では SSAO は自動無効化される(エンジン側の既知の制約)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_ssao", {})),
);

reg(
  "dx12_set_ssao",
  "SSAO設定変更",
  "SSAO のフィールドを指定分だけ更新する(未指定は現状維持)。radius=ワールド空間半径, bias=自己遮蔽バイアス, intensity=遮蔽の強さ, power=コントラスト(pow指数), sampleCount=8か16, blur=4x4ボックスブラーの有無。",
  {
    enabled: z.boolean().optional(),
    radius: z.number().optional(),
    bias: z.number().optional(),
    intensity: z.number().optional(),
    power: z.number().optional(),
    sampleCount: z.number().int().optional().describe("8 か 16。"),
    blur: z.boolean().optional(),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_ssao", "get_ssao", a)),
);

reg(
  "dx12_get_occlusion",
  "オクルージョンカリング取得",
  "Hi-Z オクルージョンカリングの状態を返す。{enabled, active, ready, pyramid{width,height,mips}}。"
  + "active は「このフレームで実際に走るか」(正射/2Dビューでは自動無効)。"
  + "実際に何体隠れたかは dx12_perf_stats の occlusion ブロック(occluded/tested/ratio/predicatedDraws)を見ること。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_occlusion", {})),
);

reg(
  "dx12_set_occlusion",
  "オクルージョンカリング切替",
  "Hi-Z オクルージョンカリングの ON/OFF。深度プリパスの深度から階層 Z ピラミッドを作り、"
  + "壁の裏に完全に隠れた描画を GPU 側で落とす(D3D12 のプレディケーション。遅延ゼロ)。"
  + "★ON にすると深度プリパスも強制的に走る。TAA/SSAO/SSR/DXR のどれかが有効なシーンでは"
  + "プリパスは元々走っているので追加コストは Hi-Z ぶん(実測 0.04ms)だけだが、"
  + "どれも無効なシーンで ON にするとプリパスぶんの描画コールが増えて**遅くなる**ことがある。"
  + "GPU 律速のときに効く機能で、CPU 律速のシーンでは fps は改善しない。既定 OFF。"
  + "設定は settings.json の render_occlusion_culling に保存される。",
  { enabled: z.boolean() },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_occlusion", "get_occlusion", a)),
);

reg(
  "dx12_get_ssr",
  "SSR設定取得",
  "現在のシーンの SSR(スクリーン空間反射)設定を返す。{enabled, intensity, maxDistance, thickness, maxSteps, stride, roughnessCutoff, edgeFade, bias}。★正射カメラ/2Dビューでは自動無効化される。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_ssr", {})),
);

reg(
  "dx12_set_ssr",
  "SSR設定変更",
  "SSR(スクリーン空間反射) のフィールドを指定分だけ更新する(未指定は現状維持)。" +
    "深度プリパスの G-Buffer(法線/ラフネス) と前フレームのシーンカラーをレイマーチして、IBL の鏡面反射を置き換える。" +
    "★反射は 1 フレーム遅れる。★roughnessCutoff を超えるラフネスの面はレイを打たず prefiltered キューブで近似される。" +
    "★有効にすると深度+速度プリパスが常時走る(TAA が OFF でも)。",
  {
    enabled: z.boolean().optional(),
    intensity: z.number().optional().describe("0..1。confidence への乗算"),
    maxDistance: z.number().optional().describe("レイの最大到達距離(m)"),
    thickness: z.number().optional().describe("ヒットとみなす深度差の上限(m)"),
    maxSteps: z.number().int().optional().describe("16..128"),
    stride: z.number().optional().describe("DDA の 1 ステップのピクセル数 1..8"),
    roughnessCutoff: z.number().optional().describe("これを超えるラフネスは IBL に任せる"),
    edgeFade: z.number().optional().describe("画面端フェード幅(NDC 比 0..0.5)"),
    bias: z.number().optional().describe("レイ始点の押し出し(m)"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_ssr", "get_ssr", a)),
);

reg(
  "dx12_get_ssgi",
  "SSGI設定取得",
  "現在のシーンの SSGI(スクリーン空間GI)設定を返す。{enabled, intensity, radius, thickness, rayCount, stepCount, clampValue, feedback, iblFallback}。★正射カメラ/2Dビューでは自動無効化される。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_ssgi", {})),
);

reg(
  "dx12_set_ssgi",
  "SSGI設定変更",
  "SSGI(スクリーン空間GI) のフィールドを指定分だけ更新する(未指定は現状維持)。" +
    "前フレームのシーンカラーを間接光のソースにして、IBL の拡散(irradiance)を置き換える。" +
    "★iblFallback を切るとカメラを回すたびに全体の明るさが変動する(既定 ON のままが安全)。" +
    "★ノイズは時間蓄積(feedback)で落とす。0.98 を超えると TAA と合わせて二重残像になる。",
  {
    enabled: z.boolean().optional(),
    intensity: z.number().optional().describe("間接拡散の強さ。既定 0.8"),
    radius: z.number().optional().describe("レイの最大到達距離(m)"),
    thickness: z.number().optional().describe("ヒットとみなす深度差の上限(m)"),
    rayCount: z.number().int().optional().describe("1..4"),
    stepCount: z.number().int().optional().describe("4..24"),
    clampValue: z.number().optional().describe("積分結果の輝度クランプ(firefly/発散対策)"),
    feedback: z.number().optional().describe("時間蓄積の履歴比率 0.8..0.98"),
    iblFallback: z.boolean().optional().describe("画面外へ抜けたレイに irradiance キューブを積む"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_ssgi", "get_ssgi", a)),
);

reg(
  "dx12_get_contact_shadow",
  "コンタクトシャドウ設定取得",
  "現在のシーンのコンタクトシャドウ(深度バッファをスクリーン空間でレイマーチする近接遮蔽)設定を返す。{enabled, rayLength, thickness, bias, intensity, steps, maxDistance, fadeDistance}。★太陽(平行光)専用。正射カメラ/2Dビューでは自動無効化される(SSAO と同じ制約)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_contact_shadow", {})),
);

reg(
  "dx12_set_contact_shadow",
  "コンタクトシャドウ設定変更",
  "コンタクトシャドウのフィールドを指定分だけ更新する(未指定は現状維持)。CSM の解像度では抜ける「物と地面の接地部の細かい影」を補うための機能。rayLength=レイ長(m。伸ばすほどノイズが増える), thickness=遮蔽とみなす深度差の上限(m), bias=自己遮蔽バイアス(m), intensity=強さ(0..1), steps=レイマーチのステップ数(4..32、16 が相場), maxDistance/fadeDistance=遠景のフェード(m)。",
  {
    enabled: z.boolean().optional(),
    rayLength: z.number().optional().describe("レイ長(m)。0.1〜0.5 が接触スケール。"),
    thickness: z.number().optional().describe("遮蔽とみなす深度差の上限(m)。"),
    bias: z.number().optional().describe("自己遮蔽バイアス(m)。シミが出るなら上げる。"),
    intensity: z.number().optional().describe("0..1。"),
    steps: z.number().int().optional().describe("4〜32。既定 16。"),
    maxDistance: z.number().optional().describe("この距離(m)からフェード開始。"),
    fadeDistance: z.number().optional().describe("フェードにかける距離(m)。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_contact_shadow", "get_contact_shadow", a)),
);

// ── PCSS(ソフトシャドウ) ─────────────────────────────────────────
// エンジン側は Application.cpp:5565 の 1 ブロックで get/set を捌いている(MSVC の C1061 対策)。
// 受け付ける引数とクランプ範囲はそこを読んで写した(憶測なし)。

reg(
  "dx12_get_shadow_pcss",
  "PCSSソフトシャドウ設定取得",
  "現在のシーンの PCSS(ブロッカー探索 → 可変ペナンブラのソフトシャドウ)設定を返す。"
  + "{enabled, lightTanAngle, maxPenumbraTexels, blockerSearchTexels, temporalDither} に加えて、"
  + "★実際に走る条件を満たしているかの active(影が ON かつ透視カメラ)と、"
  + "時間ディザが本当に効いているかの temporalDitherActive(TAA が ON のときだけ true)を返す。"
  + "enabled:true なのに active:false なら、シーンの影が切れているか正射/2D ビューになっている。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_shadow_pcss", {})),
);

reg(
  "dx12_set_shadow_pcss",
  "PCSSソフトシャドウ設定変更",
  "PCSS のフィールドを指定分だけ更新する(未指定は現状維持)。CSM の固定幅 3x3 PCF を"
  + "「ブロッカー探索 → 距離に応じた可変ペナンブラ」へ置き換える = 接地部は鋭く、離れるほど柔らかい影になる。"
  + "★OFF に戻すと従来の 3x3 PCF と【ビット一致】の絵に戻る(切り分けに使える)。"
  + "★lightTanAngle は太陽の角半径の tan。実際の太陽は 0.0044(ほぼ硬い影)で、既定 0.05 は誇張値。"
  + "影がぼやけすぎるなら下げる。★temporalDither は TAA 有効時のみ効く(無効時はエンジンが自動で切るので"
  + "temporalDitherActive:false が返る)。設定はシーン JSON の shadowPcss に保存される。"
  + "★適用後にエンジンから読み返した実値を current に入れて返す(要求と食い違うものは mismatched に出る)。",
  {
    enabled: z.boolean().optional().describe("PCSS を使うか。false で従来の 3x3 PCF(絵はビット一致)。"),
    lightTanAngle: z.number().optional().describe(
      "太陽の角半径の tan。0.001..0.5 にクランプされる。既定 0.05(誇張値)。実際の太陽は 0.0044。"),
    maxPenumbraTexels: z.number().optional().describe(
      "ペナンブラ幅の上限(シャドウマップのテクセル数)。1..64 にクランプ。大きいほど柔らかく重い。"),
    blockerSearchTexels: z.number().optional().describe(
      "ブロッカー探索の半径(シャドウマップのテクセル数)。1..64 にクランプ。小さすぎると遠くの影が硬いまま。"),
    temporalDither: z.boolean().optional().describe(
      "サンプル位置をフレームごとに回してバンディングを散らす。★TAA 有効時のみ効く(無効だとチラつくだけなのでエンジンが自動で切る)。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_shadow_pcss", "get_shadow_pcss", a)),
);

// ── DXR(レイトレーシング) ────────────────────────────────────────
// エンジン側は Application.cpp:3647 の 1 ブロックで get/set を捌いている(C1061 対策)。
// 受け付ける引数とクランプ範囲はそこと docs/MCP.md §4-2 を読んで写した(憶測なし)。
//
// ★非対応 GPU の扱いがこのツールの肝。set_dxr は m_dxrEnabled が false だと
//   McpErr::InvalidParam(error_code:2) を投げる。これを素の errResult で返すと
//   AI からは「引数を間違えた」と区別が付かず、値を変えて延々と撃ち直す
//   (error_code:2 は引数不正の汎用コードでもあるため)。
//   なので「環境が非対応」だけは【エラーではない結果】として返し、
//   applied:false / supported:false / retryable:false と代替手段まで書いて打ち切らせる。

/** set_dxr の「非対応 GPU」エラーだけを見分ける(同じ error_code:2 の引数不正と混ぜない)。 */
function isDxrUnsupportedError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown };
  return err?.code === 2 && typeof err.message === "string"
    && err.message.includes("does not support inline raytracing");
}

/**
 * 非対応 GPU で set_dxr を諦めるときの返り値。
 * 「バグ」ではなく「この機械では永久に無理」であることと、代わりに何を使うかを本文に書く。
 */
function dxrUnsupportedResult(current: any, requested: Record<string, unknown>) {
  return {
    applied: false,
    supported: false,
    retryable: false,
    requestedKeys: Object.keys(requested),
    raytracingTier: current?.raytracingTier ?? "none",
    highestShaderModel: current?.highestShaderModel ?? null,
    reason: "この GPU / ドライバは inline raytracing(RayQuery)に対応していないので、"
      + "dx12_set_dxr は何を渡しても error_code:2 で失敗する。"
      + "★これは不具合でも引数ミスでもない。引数を変えて撃ち直しても永久に通らないので繰り返さないこと。"
      + "要件は DXR Tier 1.1 かつ Shader Model 6.5(RTX 20 系 / RX 6000 系以降)。",
    next: "RT 影 / RT-AO は諦めて、影は dx12_set_shadow_pcss(CSM + PCSS)、"
      + "遮蔽は dx12_set_ssao と dx12_set_contact_shadow で作ること。"
      + '実際に見えている Tier と SM は起動ログの "DXR:" 行(dx12_get_log)と、この返り値の '
      + "raytracingTier / highestShaderModel で確認できる。",
    current,
  };
}

reg(
  "dx12_get_dxr",
  "DXR設定取得",
  "現在のシーンの DXR(DirectX Raytracing / inline raytracing)設定と、加速構造の実測値を返す。"
  + "★このツールは非対応 GPU でも【成功する】(supported:false が返るだけ)。"
  + "RT 系を触る前にまずこれを呼んで supported を見ること。"
  + "\n■ ケーパビリティ: supported(bool) / raytracingTier(\"1.1\" \"1.2\" … or \"none\") / highestShaderModel(\"6.8\" 等)。"
  + "\n■ 設定: shadowEnabled, shadowSunAngle, shadowNormalBias, shadowMaxDistance, shadowIntensity, "
  + "aoEnabled, aoRadius, aoRayCount, aoIntensity, aoPower, aoCombineWithSsao, aoDenoise, aoDenoiseRadius, "
  + "maxInstances, forceBuildTlas。"
  + "\n■ DDGI: ddgiEnabled, ddgiSpacing, ddgiProbeCountX/Y/Z, ddgiOriginX/Y/Z, ddgiRayLength, "
  + "ddgiHysteresis, ddgiIntensity, ddgiNormalBias, ddgiBounceIntensity。"
  + "実測は stats.ddgiReady(PSO が建ったか) / ddgiEnabled / ddgiProbes / ddgiRaysCast / ddgiBytes。"
  + "★ddgiEnabled:true なのに ddgiProbes:0 なら TLAS が無い(tlasReady を見ること)。"
  + "\n■ 実際に走ったか: shadowActive(ON でも本当に RT 影パスが走ったフレームか) / tlasReady(TLAS が建っているか)。"
  + "enabled:true なのに shadowActive:false なら supported / tlasReady / カメラ(正射)を疑う。"
  + "\n■ stats(直近フレームの加速構造の実測): instances, blasCount, blasBytes, blasTriangles, tlasBytes, "
  + "scratchBytes, instanceDescBytes, skippedSkinned, skippedTransparent, droppedOverLimit, bytesPerTriangle。"
  + "skippedSkinned / skippedTransparent は仕様(スキンドと半透明は TLAS に入らず CSM が担当する)。"
  + "droppedOverLimit > 0 なら maxInstances に引っかかっている。"
  + "\n■ 加速構造が正しいかの目視は dx12_render_debug の mode:\"rtDiff\"(黒 = ラスタと一致)が本命。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_dxr", {})),
);

reg(
  "dx12_set_dxr",
  "DXR設定変更",
  "DXR のフィールドを指定分だけ更新する(未指定は現状維持)。DXR 1.1 の inline raytracing(RayQuery)で、"
  + "RT サン影は既存のコンタクトシャドウ枠(t11)、RT-AO は既存の SSAO 枠(t8) へ書く"
  + "(ルートシグネチャは 1 DWORD も増えない)。設定はシーン JSON の raytracing に保存される"
  + "(forceBuildTlas だけは検証用の一時トグルなので保存されない)。"
  + "\n■ ★非対応 GPU では【適用できない】。その場合はエラーではなく "
  + "{applied:false, supported:false, retryable:false, reason, next} を返すので、"
  + "reason を読んで諦めること(引数を変えて撃ち直しても永久に通らない)。まず dx12_get_dxr で supported を見るのが早い。"
  + "\n■ スキンドメッシュと半透明は加速構造に入らない。そこは従来どおり CSM が担当し、"
  + "フォワードの min() で合成される(RT 影が有効なフレームは CSM が『RT の担当ぶん』を描かなくなる = 排他)。"
  + "\n■ PCSS と併用するときは shadowSunAngle:0(ハード)にして半影は PCSS に任せるのが正しい。"
  + "\n■ 効いているかの確認は dx12_get_dxr の shadowActive / tlasReady と、"
  + "dx12_render_debug の mode:\"rt\" / \"rtDiff\"、コストは dx12_perf_stats の gpuPassMs.raytracing / rtScreen。"
  + "\n■ ★適用後にエンジンから読み返した実値を current に入れて返す(要求と食い違うものは mismatched に出る)。",
  {
    shadowEnabled: z.boolean().optional().describe(
      "RT サン影を使うか(既定 false)。ON の間はコンタクトシャドウパスの代わりに RT 影が同じ t11 を埋める。"),
    shadowSunAngle: z.number().optional().describe(
      "太陽の角直径(度)。0..20 にクランプ。既定 0.53(実際の太陽)。0 でハードシャドウ。★PCSS 併用時は 0 が正しい。"),
    shadowNormalBias: z.number().optional().describe(
      "レイ始点の法線方向オフセット(m)。0..1 にクランプ。既定 0.02。アクネ(自己遮蔽の縞)が出るなら上げる。"
      + "CSM の depthBias と違いワールド空間の実距離なので peter-panning にならない。"),
    shadowMaxDistance: z.number().optional().describe(
      "影レイの最大距離(m)。0..100000 にクランプ。既定 0 = 無限。遠景の遮蔽物を追わない分だけ速くなる。"),
    shadowIntensity: z.number().optional().describe(
      "RT 影の強さ。0..1 にクランプ。既定 1(RT 影のみ)。0 で無効、途中の値は CSM とのブレンド(デバッグ用)。"),
    aoEnabled: z.boolean().optional().describe(
      "RT-AO を使うか(既定 false)。ON の間は SSAO 枠(t8)を RT-AO が埋める。"),
    aoRadius: z.number().optional().describe("半球レイの長さ(m)。0.01..100 にクランプ。既定 1。"),
    aoRayCount: z.number().int().optional().describe(
      "1px あたりのレイ本数。1..8 にクランプ。既定 2。増やすほど滑らかで重い。"),
    aoIntensity: z.number().optional().describe("RT-AO の強さ。0..1 にクランプ。既定 1。"),
    aoPower: z.number().optional().describe("pow() のべき指数(SSAO と同じ意味)。0.01..8 にクランプ。既定 1.5。"),
    aoCombineWithSsao: z.boolean().optional().describe(
      "SSAO と min() 合成するか(既定 false)。RT-AO は細かい皺の遮蔽が苦手なので、"
      + "『大きな遮蔽 = RT / 細部 = SSAO』の合成が実用上いちばん良い。"),
    aoDenoise: z.boolean().optional().describe(
      "RT-AO の空間デノイザ(joint bilateral)を使うか(既定 true)。1px 数本のレイをそのまま出すと"
      + "ノイズが乗るので、深度・法線・接平面でエッジを守りながら平滑化する。"
      + "★false で完全に従来経路(トレース結果をそのまま t8 へ)に戻る。"
      + "★G-Buffer が書かれていないフレームは重みが作れないので自動的にスキップされる。"),
    aoDenoiseRadius: z.number().optional().describe(
      "デノイザのフィルタ半径(px)。0..32 にクランプ。既定 8。0 で無効。"
      + "大きいほど滑らかになるが、細い形状の AO が潰れる。"),
    maxInstances: z.number().int().optional().describe(
      "TLAS へ入れるインスタンスの上限。0..32768 にクランプ。0 で既定(RaytracingScene::kMaxRtInstances)。"
      + "dx12_get_dxr の stats.droppedOverLimit > 0 なら足りていない。"),
    forceBuildTlas: z.boolean().optional().describe(
      "RT 影 / RT-AO が両方 OFF でも TLAS を建てる(検証用)。シーン JSON には保存されない。"
      + "dx12_render_debug の mode:\"rt\" / \"rtDiff\" はこれを一時的に立ててから撮る。"),
    // ── DDGI(world-space の拡散間接光。計画09 Step 6) ────────────────────
    ddgiEnabled: z.boolean().optional().describe(
      "DDGI を使うか(既定 false)。プローブ格子にレイを飛ばして八面体 irradiance アトラスを作り、"
      + "フォワードの ambient に拡散間接項として【加算】する。★TLAS が要る(RT 影 / RT-AO が両方 OFF なら "
      + "forceBuildTlas:true も一緒に立てること)。SSGI とは排他ではなく、"
      + "SSGI が画面内で当てた分は自動で差し引かれる(二重計上の回避)。"
      + "屋内は envMap が空で IBL フォールバックが無いため、ここがいちばん効く。"),
    ddgiSpacing: z.number().optional().describe(
      "プローブ間隔(m)。0.1..100 にクランプ。既定 2。格子が動くと履歴は捨てられる。"),
    ddgiProbeCountX: z.number().int().optional().describe("プローブ数 X。1..32 にクランプ。既定 8。"),
    ddgiProbeCountY: z.number().int().optional().describe("プローブ数 Y。1..32 にクランプ。既定 4。"),
    ddgiProbeCountZ: z.number().int().optional().describe("プローブ数 Z。1..32 にクランプ。既定 8。"),
    ddgiOriginX: z.number().optional().describe("格子の原点 X(m)。既定 -8。"),
    ddgiOriginY: z.number().optional().describe("格子の原点 Y(m)。既定 0.5。床より少し上に置く。"),
    ddgiOriginZ: z.number().optional().describe("格子の原点 Z(m)。既定 -8。"),
    ddgiRayLength: z.number().optional().describe(
      "プローブレイの最大距離(m)。0.1..10000 にクランプ。既定 30。"),
    ddgiHysteresis: z.number().optional().describe(
      "時間ブレンドの係数。0..0.995 にクランプ。既定 0.97(前フレームを 97% 残す)。"
      + "大きいほど安定するが光の変化への追従が遅い。0 で毎フレーム入れ替え。"),
    ddgiIntensity: z.number().optional().describe(
      "DDGI の強さ。0..10 にクランプ。既定 1。★アトラスへ書き込む時点で掛かるので、"
      + "変更は ddgiHysteresis ぶんの時間をかけて絵に効く(即時ではない)。0 なら実質 OFF。"),
    ddgiNormalBias: z.number().optional().describe(
      "サンプル位置を法線方向へ押し出す量(m)。0..1 にクランプ。既定 0.02。"
      + "壁際で裏側のプローブを引いてしまう(ライトリーク)なら上げる。"
      + "★段階2 の Chebyshev 可視性テストが入るまでは、これがリーク対策の主な手段。"),
    ddgiBounceIntensity: z.number().optional().describe(
      "多重バウンスの強さ。0..1 にクランプ。既定 0 = 1 バウンスのみ(段階2 までと同じ絵)。"
      + "プローブレイのヒット点で【前フレームのプローブ】を引いて足す量。1 フレームに 1 段ずつ"
      + "積み上がるので、変更は ddgiHysteresis ぶんの時間をかけて絵に出る(120 フレームは見ること)。"
      + "★1 を超えられないのは、収束値が E/(1-アルベド×これ) の幾何級数だから。"),
  },
  { idempotentHint: true },
  (a) => run(async () => {
    // 撃つ前に get_dxr で確定させる(get は非対応 GPU でも成功する)。
    // ここで打ち切ると「非対応なのに毎回 set を撃ってエラーを見る」ループが起きない。
    const before = await engine.call("get_dxr", {});
    if (before?.supported === false) return dxrUnsupportedResult(before, definedOnly(a));
    try {
      return await applyAndVerify("set_dxr", "get_dxr", a);
    } catch (e) {
      // get と set の間に非対応が判明する経路(デバイスロスト後の再初期化など)の保険。
      // ★引数不正の error_code:2 とは message で区別する(全部を握り潰すと本物のバグが隠れる)。
      if (!isDxrUnsupportedError(e)) throw e;
      return dxrUnsupportedResult(await engine.call("get_dxr", {}), definedOnly(a));
    }
  }),
);

reg(
  "dx12_get_taa",
  "TAA設定取得",
  "現在のシーンの TAA(テンポラルアンチエイリアス)設定を返す。{enabled, sampleCount, feedbackMin, feedbackMax, varianceGamma, jitterScale, debugVelocity} に加え、実際に走っているかの active と、FXAA が抑制されているかの fxaaSuppressed を返す。★正射カメラ/2Dビューでは自動無効化される(SSAO と同じ制約)。TAA が ON の間は dx12_set_post_process の fxaaOn は無視される。★効果の確認には dx12_ui_screenshot を使うこと(dx12_screenshot は解決前の m_sceneRT を読むため TAA が映らない)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_taa", {})),
);

reg(
  "dx12_set_taa",
  "TAA設定変更",
  "TAA のフィールドを指定分だけ更新する(未指定は現状維持)。速度バッファ(モーションベクター)と前フレームの履歴を使うサブピクセル AA で、FXAA と違って動いている物もぼけない。有効にすると深度+速度プリパスが常に走る(SSAO OFF のシーンではジオメトリパスが1回増える)。ゴーストが出るなら varianceGamma を下げるか feedbackMax を下げる。全体がぼけるなら jitterScale を下げる。",
  {
    enabled: z.boolean().optional(),
    sampleCount: z.number().int().optional().describe("ハルトン列の周期。4=シャープ / 8=標準 / 16=滑らか。"),
    feedbackMin: z.number().optional().describe("現フレームと食い違うピクセルで使う履歴の比率。既定 0.88。"),
    feedbackMax: z.number().optional().describe("安定しているピクセルで使う履歴の比率。既定 0.97。高いほど滑らかだがゴーストしやすい。"),
    varianceGamma: z.number().optional().describe("近傍色の許容幅 μ±γσ。既定 1.0。下げるとゴーストが減りチラつきが増える。"),
    jitterScale: z.number().optional().describe("ジッタ量の倍率。1.0 = ±0.5px。ブラーが強すぎるなら下げる。"),
    debugVelocity: z.boolean().optional().describe("速度バッファを画面に可視化する(検証用)。静止時に全面が均一なグレーになるのが正常で、縞々に揺れていたらジッタ除去のバグ。カメラを右へパンすると赤寄り、左で緑寄り。★確認は dx12_screenshot ではなく dx12_ui_screenshot を使うこと(dx12_screenshot はポスト前の m_sceneRT を読むので TAA も可視化も映らない)。保存はされない。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_taa", "get_taa", a)),
);

reg(
  "dx12_get_volumetric_fog",
  "ボリュメトリックフォグ設定取得",
  "現在のシーンのボリュメトリックフォグ(froxel)設定を返す。{enabled, density, albedo, anisotropy, heightFalloff, heightRef, distance, depthDistribution, ambient, sunIntensity, lightScattering, temporal, temporalBlend, extendBeyondRange, debugMode} に加え、実際に走っているかの active を返す。★正射カメラ/2Dビューでは自動無効化される(SSAO/TAA と同じ制約)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_volumetric_fog", {})),
);

reg(
  "dx12_set_volumetric_fog",
  "ボリュメトリックフォグ設定変更",
  "ボリュメトリックフォグのフィールドを指定分だけ更新する(未指定は現状維持)。視錐台に沿った 3D テクスチャ(160x90x64)へ散乱を焼いてから画面へ合成する方式で、空気そのものが光る=光の筋(ゴッドレイ)が立体的に見える。有効にした時点で VRAM を 28MB 確保する(以後 OFF にしても解放しない)。太陽 + CSM に加えて点光源/スポットの散乱もクラスタライトリストから引く。★GodRays(ポストの擬似シャフト)と同時に有効にすると太陽の散乱が二重計上される。",
  {
    enabled: z.boolean().optional(),
    density: z.number().optional().describe("消散係数 σ_t(1/m 相当)。既定 0.02。0.05 で濃い霧、0.2 でほぼ視界ゼロ。"),
    albedo: z.array(z.number()).length(3).optional().describe("散乱アルベド [r,g,b]。σ_s = density * albedo。"),
    anisotropy: z.number().optional().describe("Henyey-Greenstein の g(-0.9..0.9)。既定 0.3。0=等方 / 0.6-0.8 で太陽方向に強いシャフト。負にすると後方散乱。"),
    heightFalloff: z.number().optional().describe("高さ方向の指数減衰(1/m)。既定 0.1。0 で高さ無依存。"),
    heightRef: z.number().optional().describe("高さ減衰の基準高さ(world Y)。既定 0。"),
    distance: z.number().optional().describe("froxel ボリュームの到達距離(m)。既定 150。ここから先は解析フォグへ引き継ぐ。"),
    depthDistribution: z.number().optional().describe("Z 分布の冪 k(1..4)。z = distance * w^k。既定 2。1=線形 / 大きいほど手前が細かい。"),
    ambient: z.array(z.number()).length(3).optional().describe("環境散乱(等方) [r,g,b]。影の中の霧の明るさ。"),
    sunIntensity: z.number().optional().describe("太陽の散乱寄与スケール。既定 1。"),
    lightScattering: z.boolean().optional().describe("点光源/スポットも散乱させるか(クラスタライトリストを引く)。既定 true。"),
    temporal: z.boolean().optional().describe("時間再投影。既定 true。false にするとサブfroxelジッタも自動で切れる。"),
    temporalBlend: z.number().optional().describe("現フレームの比率(0.01..1)。既定 0.08。小さいほど滑らかだがゴーストが増える。"),
    extendBeyondRange: z.boolean().optional().describe("distance より遠方を解析的な指数フォグで延長する。既定 true。切ると遠景に『フォグが止まる帯』が出る。"),
    debugMode: z.number().int().optional().describe("0=オフ / 1=散乱だけ / 2=透過率だけ / 3=froxel スライスの縞。保存されない検証用。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_volumetric_fog", "get_volumetric_fog", a)),
);

// ════════════════════════════════════════════════════════════════
//  ビルド/検証パイプライン連携
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_validate_scene",
  "シーン検証",
  "シーン JSON の参照グラフをヘッドレスで検証する(CLI `--validate` と同じロジックをエンジン自身の子プロセスとして実行)。スクリプトパス存在・entity参照プロパティ解決・Trigger の filter/action target 解決・LoadScene 等のシーンパス存在をチェック。path 省略時は現在開いているシーン。{pass, exitCode, report, scenePath}。report はテキストレポート全文(PASS/FAIL・[info]/[warn]/[ERROR] 行)。編集→検証→修正のループに使う。子プロセスとして起動する(GPU初期化前に終了するので実行中のエディタと並行しても安全)。",
  { path: z.string().optional().describe("assets 相対パス。省略時は現在開いているシーン。") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("validate_scene", { path })),
);

reg(
  "dx12_build_game",
  "ゲームビルド",
  "現在のプロジェクトをヘッドレスでビルドする(ツールバーの「ビルド」ボタンと同じ処理: exe+DLL+assets+shaders を出力フォルダへコピー)。{success, outputDir, error?}。出力先はビルド設定(エンジン設定窓)で指定した場所、未設定なら build/game。数十秒〜かかることがある(同期呼び出し)。",
  {},
  { destructiveHint: true },
  () => run(() => engine.call("build_game", {})),
);

// ════════════════════════════════════════════════════════════════
//  Lua 即時実行(eval) — デバッグ用。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_eval_lua",
  "Lua即時実行",
  "任意の Lua コードをエンジンの Lua state でその場実行する(強力なデバッグ機能)。globals フォールバック環境なので scene/physics/camera/audio/events 等の既存グローバルバインディング(dx12_describe_lua_api 参照)がそのまま使える。例: `local e = scene:findEntity(\"Player\"); e.transform.position.y = e.transform.position.y + 1; return e.transform.position.y`。code が値を return していれば result にその tostring() 文字列が入る(無ければ空文字)。★print() も log(msg) も dx12_get_log に出る(print は Logger へ差し替え済み)。副作用のある操作(位置変更・物理力印加等)は Editor/Playing 両方で実行できるが、bodies は Play 中のみ登録されているため物理系は Playing 中でないと効果が無い。localhost 限定・認証なしという既存のセキュリティモデルと同水準。",
  { code: z.string().describe("実行する Lua コード(複数行可)。") },
  {},
  ({ code }) => run(() => engine.call("eval_lua", { code })),
);

// ════════════════════════════════════════════════════════════════
//  マテリアルテクスチャ・アニメーション制御
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_set_texture",
  "テクスチャ上書き割当",
  "エンティティの MeshRenderer にテクスチャを割り当てる(Inspector のアセットブラウザ D&D と同じ操作)。Material はモデル共有なので直接触らず、インスタンス単位の override に書く=他のインスタンスに波及しない。slot は albedo(既定)/normal/metalRoughness、submesh はサブメッシュ index(既定 0)。path 空文字で解除(Material 既定に戻る)。即時反映。entity(id) か name 指定。スプライトのテクスチャは set_component(sprite2d, {texturePath}) の方。",
  {
    ...entityRef,
    path: z.string().describe("assets 相対パス(例: textures/rust.png)。空文字で override 解除。"),
    slot: z.enum(["albedo", "normal", "metalRoughness"]).optional().describe("テクスチャスロット。省略で albedo。"),
    submesh: z.number().int().optional().describe("サブメッシュ index。省略で 0。"),
  },
  { idempotentHint: true },
  ({ entity, name, path, slot, submesh }) =>
    run(() => engine.call("set_texture", { entity, name, path, slot, submesh })),
);

reg(
  "dx12_material_apply",
  "PBRマテリアル一括割当",
  "PBR の 4 点セット(BaseColor / Normal / ORM / Height)を 1 回でエンティティへ割り当てる合成ツール。"
  + "dx12_set_texture を 3 回 + dx12_set_pbr を叩く手間を畳んだもの。★dir に素材フォルダ(assets 相対)を "
  + "渡すと中のファイル名から用途を推定する(Poly Haven 系の diff / nor_gl / arm / disp、および "
  + "albedo / basecolor / ORM / RMA / displacement 等)。推定できなかったファイルは黙って捨てず "
  + "ignored に理由付きで返す。個別に baseColor / normal / orm / height を渡せば推定より優先される。"
  + "★重要(既知の罠): エンジンは metallic/roughness の数値上書きが 1 つでも残っていると ORM テクスチャを "
  + "無効化する(Application.cpp:11617 の hasOverride が PBR flags から 2u を落とす)。dx12_spawn_model 経由の "
  + "モデルはシーン JSON の material.metallic/roughness からこの上書きが入っていることが多い。このツールは "
  + "ORM を割り当てるとき自動で metallic/roughness を -1(=上書き解除)へ戻すので、そのままで ORM が効く。"
  + "metallic/roughness を明示指定した場合はその指定を尊重するが、ORM が無効化されることを warnings で返す。"
  + "★height(disp) はメッシュに割当先が無い(set_texture の slot は albedo/normal/metalRoughness だけ)。"
  + "渡しても ignored に理由付きで出る。変位が使えるのは地形の .terrainlayers だけ。"
  + "★適用後に dx12_get_entity で読み返して照合し、食い違いがあれば applied:false + mismatched を返す。"
  + "返り値 {applied, resolved, source, ignored, warnings, targets:[{entityId, name, textures, pbr, applied, mismatched?}]}。",
  {
    ...entityRef,
    entities: z.array(z.union([z.number().int(), z.string()])).optional()
      .describe("複数対象。エンティティ id(int) と 名前(string) を混ぜて渡せる。entity/name と併用可。"),
    dir: z.string().optional()
      .describe("素材フォルダの assets 相対パス(例 textures/red_brick_03)。直下のテクスチャをファイル名から用途推定して割り当てる。サブフォルダは見ない。"),
    baseColor: z.string().optional().describe("BaseColor/Albedo の assets 相対パス。dir の推定より優先。"),
    normal: z.string().optional().describe("法線マップの assets 相対パス。★OpenGL 規約(nor_gl)のみ。nor_dx は使えない。"),
    orm: z.string().optional().describe("ORM/ARM(R=AO 未使用 / G=Roughness / B=Metallic)の assets 相対パス。set_texture の metalRoughness スロットへ入る。"),
    metalRoughness: z.string().optional().describe("orm の別名(glTF 語彙で書きたいとき用)。orm と同時指定なら orm が勝つ。"),
    height: z.string().optional().describe("変位(disp/height)。★メッシュには割当先が無いので ignored に理由付きで返るだけ。地形のレイヤー用。"),
    submesh: z.number().int().optional().describe("サブメッシュ index(既定 0)。モデルのサブメッシュ数は dx12_get_entity の materialTextureOverrides で分かる。"),
    uvScale: z.number().optional().describe("UV タイリング倍率(U/V 両方に入る)。タイル素材を広い床に貼るときに上げる。"),
    uvScaleU: z.number().optional().describe("U 方向だけ個別指定(uvScale より優先)。"),
    uvScaleV: z.number().optional().describe("V 方向だけ個別指定(uvScale より優先)。"),
    metallic: z.number().optional().describe("金属度 0..1 の数値上書き、または -1 で上書き解除。★ORM を割り当てるなら省略が正解(省略時は自動で -1 にする)。"),
    roughness: z.number().optional().describe("粗さ 0..1 の数値上書き、または -1 で上書き解除。★ORM を割り当てるなら省略が正解。"),
  },
  { idempotentHint: true },
  (args: any) => run(async () => {
    const { dir, submesh = 0 } = args;

    // 1) 対象エンティティ(id / 名前を混ぜて受ける)。set_texture / get_entity はどちらも受け付ける。
    //    entity と name は他ツールと同じく排他(両方来たら id を採る)。重複指定は畳んで二重適用を防ぐ。
    const refs: { entity?: number; name?: string }[] = [];
    const seen = new Set<string>();
    const pushRef = (r: { entity?: number; name?: string }) => {
      const key = r.entity !== undefined ? `#${r.entity}` : `@${r.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(r);
    };
    if (args.entity !== undefined) pushRef({ entity: args.entity });
    else if (args.name !== undefined) pushRef({ name: args.name });
    for (const t of args.entities ?? []) {
      pushRef(typeof t === "number" ? { entity: t } : { name: t });
    }
    if (refs.length === 0) {
      throw argError("対象エンティティが指定されていない",
        "entity(id) / name / entities:[id か 名前の配列] のどれかを渡す。id は dx12_list_entities で分かる");
    }

    // 2) 数値の範囲は投げる前に見る(エンジンはクランプせずそのまま入れるので -1 以外の負値は事故)。
    for (const [k, v] of [["metallic", args.metallic], ["roughness", args.roughness]] as const) {
      const msg = validateScalar(k, v as number | undefined);
      if (msg) throw argError(msg, "ORM テクスチャを効かせたいなら metallic/roughness は省略する(自動で -1 にする)");
    }

    // 3) dir を展開してファイル名から用途を推定 → 明示指定と突き合わせる。
    let files: string[] = [];
    if (dir) {
      const assets = await engine.call("list_assets", { type: "texture" });
      files = filesDirectlyUnder(dir, Array.isArray(assets) ? assets as { path: string }[] : []);
      if (files.length === 0) {
        throw argError(`dir "${dir}" の直下にテクスチャが 1 枚も無い`,
          "assets 相対のフォルダを渡す(例 textures/red_brick_03)。中身は dx12_list_assets type:\"texture\" で確認できる");
      }
    }
    const resolved = resolveTextureSet({
      files,
      explicit: {
        baseColor: args.baseColor,
        normal: args.normal,
        orm: args.orm ?? args.metalRoughness,
        height: args.height,
      },
    });
    const ignored = [...resolved.ignored];

    // height はメッシュに割当先が無い。捨てるが【何を捨てたか】は必ず返す。
    if (resolved.textures.height) {
      ignored.push({ path: resolved.textures.height, reason: HEIGHT_UNSUPPORTED_REASON });
      delete resolved.textures.height;
      delete resolved.source.height;
    }

    const slots: Record<string, string> = {};
    for (const role of ["baseColor", "normal", "orm"] as const) {
      const p = resolved.textures[role];
      const slot = ROLE_TO_SLOT[role];
      if (p && slot) slots[slot] = p;
    }
    const plan = planPbr({
      hasOrm: slots.metalRoughness !== undefined,
      metallic: args.metallic, roughness: args.roughness,
      uvScale: args.uvScale, uvScaleU: args.uvScaleU, uvScaleV: args.uvScaleV,
    });
    if (Object.keys(slots).length === 0 && plan.call === null) {
      throw argError("割り当てるものが 1 つも無い",
        "dir で素材フォルダを渡すか、baseColor / normal / orm のどれかを直接指定する",
      );
    }

    const warnings = [...plan.warnings];
    if (plan.clearedScalarOverride) {
      warnings.push("ORM を有効にするため metallic/roughness の数値上書きを -1(=Material の値を使う)へ戻した。"
        + "数値で金属感を作りたい場合は metallic/roughness を明示指定すること(ただし ORM は効かなくなる)");
    }

    // 4) 適用 → 読み返して照合。エンジンは set_texture に対し applied:true 相当を返すだけなので鵜呑みにしない。
    const targets: any[] = [];
    for (const ref of refs) {
      const t: any = { ...ref, textures: {}, applied: false };
      try {
        for (const [slot, path] of Object.entries(slots)) {
          const r = await engine.call("set_texture", { ...ref, path, slot, submesh });
          t.entityId = (r as any)?.entityId ?? t.entityId;
          t.textures[slot] = path;
        }
        if (plan.call) {
          const r: any = await engine.call("set_pbr", { ...ref, ...plan.call });
          t.entityId = r?.entityId ?? t.entityId;
          // set_pbr は上書きの【生値】(-1 込み)を返す。get_entity の material.metallic は
          // 上書きを解決した後の実効値なので -1 に戻したことを確認できない ＝ ここで照合する。
          t.pbr = { metallic: r?.metallic, roughness: r?.roughness, uvScaleU: r?.uvScaleU, uvScaleV: r?.uvScaleV };
          t.mismatched = verifyApplied(plan.call as Record<string, unknown>, r);
        } else {
          t.mismatched = [];
        }

        const ent: any = await engine.call("get_entity", ref);
        t.entityId = ent?.entityId ?? t.entityId;
        if (ent?.name) t.name = ent.name;
        const entry = Array.isArray(ent?.materialTextureOverrides)
          ? ent.materialTextureOverrides[submesh] : undefined;
        t.mismatched = [...t.mismatched, ...verifyTextureOverrides(slots, entry)];

        // 「割り当てたのに絵が変わらない」を先回りして名指しする。どちらもエンジンの仕様。
        const assigned = Array.isArray(ent?.materialAssets) ? ent.materialAssets[submesh] : undefined;
        if (assigned) {
          t.warning = `.dxmat(${assigned}) が割り当たっているので、このテクスチャ上書きは描画に使われない`
            + "(優先度: materialAsset > テクスチャ上書き > モデル焼き込み Material)。"
            + "上書きを効かせたいならシーン JSON の materialAssets を空にする(dx12_scene_write)";
        } else if (ent?.primitive && (slots.normal || slots.metalRoughness)) {
          t.warning = `プリミティブ(${ent.primitive})の焼き込み Material は法線/metalRoughness テクスチャを持たないため、`
            + "描画側が PBR flags を立てず normal / ORM は無視される可能性が高い"
            + "(Application.cpp:11615-11618 が mat->normalMapTexture / mat->metalRoughnessTexture しか見ていない)。"
            + "法線と ORM を効かせたいならモデル(.gltf)へ貼るか .dxmat を使う";
        }
        t.applied = t.mismatched.length === 0;
        if (t.mismatched.length === 0) delete t.mismatched;
      } catch (e: any) {
        t.error = e.message;
        if (e.code != null) t.error_code = e.code;
      }
      targets.push(t);
    }

    const applied = targets.length > 0 && targets.every((t) => t.applied);
    const out: any = {
      applied,
      resolved: resolved.textures,
      source: resolved.source,
      slots,
      submesh,
      targets,
    };
    if (plan.call) out.pbrRequested = plan.call;
    if (ignored.length > 0) out.ignored = ignored;
    if (warnings.length > 0) out.warnings = warnings;
    if (!applied) {
      out.hint = "要求したパスがエンティティに入っていない。targets[].mismatched / error を見ること。"
        + "同じ呼び出しを繰り返しても変わらない(パスが assets 相対で実在するか、対象に meshRenderer があるかを疑う)";
    }
    out.nextStep = "dx12_focus_and_screenshot で絵を確認する(テクスチャは即時反映される)";
    return out;
  }),
);

reg(
  "dx12_play_anim",
  "アニメーション再生",
  "スケルタルアニメーションを再生する。★2 つの経路がある: "
    + "(A) state を渡すと .animfsm ステートマシンの遷移(AnimatorController が必要。ステート名は dx12_describe_anim_graph で確認)。layer で対象レイヤーを選ぶ(既定 0=ベース)。"
    + "(B) state を渡さなければ従来どおりクリップのクロスフェード再生(Lua の playAnim/playAnimByName と同じ経路)。clipName(名前) か clip(index) で指定、loop/speed も変更できる。クリップ一覧は dx12_get_anim_state。"
    + "blend はどちらの経路でもフェード秒(既定 0.3)。★アニメーションの更新は Play 中に進む。entity(id) か name 指定。",
  {
    ...entityRef,
    clip: z.number().int().optional().describe("クリップ index。clipName と排他(clipName 優先)。省略時 0。state 指定時は無視。"),
    clipName: z.string().optional().describe("クリップ名(完全一致)。dx12_get_anim_state の clips から選ぶ。state 指定時は無視。"),
    blend: z.number().optional().describe("クロスフェード秒。省略で 0.3。"),
    loop: z.boolean().optional().describe("ループ再生するか。省略で現状維持。state 経路では無視。"),
    speed: z.number().optional().describe("再生速度倍率(1.0=等速、2.0=2倍速、0=一時停止)。省略で現状維持。state 経路では無視。"),
    state: z.string().optional().describe(
      ".animfsm のステート名(完全一致)。渡すと clip 経路ではなく FSM の遷移になる。"
      + "AnimatorController とロード済みグラフが要る。名前一覧は dx12_describe_anim_graph。"),
    layer: z.number().int().min(0).optional().describe(
      "state を遷移させるレイヤー index。省略で 0(ベースレイヤー)。上半身だけ差し替える等のマスク付きレイヤーは 1 以降。"),
  },
  {},
  ({ entity, name, clip, clipName, blend, loop, speed, state, layer }) =>
    run(() => engine.call("play_anim", { entity, name, clip, clipName, blend, loop, speed, state, layer })),
);

reg(
  "dx12_get_anim_state",
  "アニメーション状態取得",
  "エンティティのスケルタルアニメーション情報を返す。{hasSkeletalAnimation, clips:[名前...]}。dx12_play_anim の clipName/clip を選ぶのに使う。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_anim_state", { entity, name })),
);

reg(
  "dx12_describe_anim_graph",
  "アニメグラフ構造取得",
  ".animfsm(アニメーションステートマシン)の構造を返す。"
    + "{source, graph:{version, parameters, clipEvents, extraClips, layers:[{name, weight, blend, mask, defaultState, states, transitions}]}}。"
    + "entity/name を渡すとそのエンティティの AnimatorController がロード済みのグラフを、path を渡すと .animfsm ファイルを直接読む(path が優先)。"
    + "dx12_play_anim の state 名 / dx12_set_anim_param のパラメータ名を確認するのに使う。",
  {
    ...entityRef,
    path: z.string().optional().describe(
      ".animfsm の assets 相対パス。渡すとエンティティを見ずにファイルを直接パースする(entity/name より優先)。"),
  },
  { readOnlyHint: true },
  ({ entity, name, path }) => run(() => engine.call("describe_anim_graph", { entity, name, path })),
);

reg(
  "dx12_set_anim_param",
  "アニメパラメータ設定",
  "アニメーション FSM(.animfsm)のパラメータを外から書き換えて遷移を発火させる。"
    + "value に数値(Float パラメータ)か真偽値(Bool パラメータ)を渡すか、trigger:true で Trigger を立てる(value と trigger のどちらかが必須)。"
    + "パラメータ名の一覧は dx12_describe_anim_graph の graph.parameters、現在値は dx12_get_anim_state の parameters で確認。"
    + "★パラメータ名は param。name は他ツールと同じ【エンティティ名】(entity と排他)。"
    + "エンジンには『param 省略時だけ name をパラメータ名として読む』後方互換が残っているが、新しい呼び出しは必ず param を使うこと。"
    + "★遷移が実際に進むのは Play 中(dx12_play)だけ。",
  {
    // ★以前はここだけ entityRef を展開していなかった。エンジンが name を【パラメータ名】として
    //   読んでいた時期の名残で、今は param が正・name はエンティティ名に戻っている
    //   (Application.cpp:5943)。他ツールと同じ entityRef でよい。
    ...entityRef,
    param: z.string().describe("FSM パラメータ名(完全一致)。dx12_describe_anim_graph の graph.parameters から選ぶ。"),
    value: z.union([z.number(), z.boolean()]).optional().describe(
      "設定する値。Float パラメータなら数値、Bool パラメータなら真偽値。trigger と併用不可(trigger:true が優先)。"),
    trigger: z.boolean().optional().describe(
      "true で Trigger パラメータを立てる(値は true 固定。消費は FSM 側)。value の代わりに使う。"),
  },
  {},
  ({ entity, name, param, value, trigger }) =>
    run(() => engine.call("set_anim_param", { entity, name, param, value, trigger })),
);

// ════════════════════════════════════════════════════════════════
//  マルチプレイヤー(ローカルテストループを AI から回す)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_net_status",
  "ネットワーク状態取得",
  "マルチプレイヤーの現在状態を返す。{available, role(Offline/Host/Client), isConnected, localClientId, tick, syncedEntityCount, players:[{id, rttMs, bytesSent, bytesReceived}], config:{tickRate, snapshotRate, maxPlayers, defaultPort}, testRole, testJoinAddress}。接続確認・RTT/帯域の観測・複製エンティティ数の検証に。★players はホスト側にしか出ない(ピア表は接続を受理した側だけが持つ)。クライアント側のプロセスで撃つと常に空配列になるので、接続確認は isConnected / localClientId を見ること。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("net_status", {})),
);

reg(
  "dx12_net_setup",
  "ネットワークテストロール設定",
  "次の dx12_play で自動 Host/Join するロールを設定する(ツールバーの Play ロールドロップダウンと同じ)。典型フロー: ①複製したいエンティティに set_component で networkIdentity + networkTransform を付ける → ②net_setup(role='host') → ③dx12_play → ④dx12_net_launch_test_client → ⑤dx12_net_status で players/RTT を確認。role='offline' で解除。",
  {
    role: z.enum(["host", "client", "offline"]).describe("host=リッスンサーバー / client=address へ接続 / offline=マルチプレイ無効。"),
    address: z.string().optional().describe("client 時の接続先 IP。省略で現状維持(既定 127.0.0.1)。"),
    port: z.number().int().optional().describe("client 時の接続先ポート。省略/0 でエンジン設定の defaultPort。"),
  },
  { idempotentHint: true },
  ({ role, address, port }) => run(() => engine.call("net_setup", { role, address, port })),
);

reg(
  "dx12_net_launch_test_client",
  "テストクライアント起動",
  "ホスト中に、同じエンジンをもう1プロセス起動して 127.0.0.1 へ自動接続させる(ツールバーの「テストクライアント起動」ボタンと同じ)。マルチプレイの複製・補間・RPC を1台で動作確認するのに使う。★ホストとして Playing 中でないとエラー(net_setup role=host → play が先)。フレーム境界で起動されるので、直後に dx12_step_frames(60) を挟んでから dx12_net_status で players を確認するとよい。",
  {},
  {},
  () => run(() => engine.call("net_launch_test_client", {})),
);

// ════════════════════════════════════════════════════════════════
//  シーン編集の強化(カメラ操作・境界・向き・接地・階層)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_get_editor_camera",
  "エディタカメラ取得",
  "シーンビューを描いてるカメラの状態を返す。{position, forward, target, targetDistance, yawDeg, pitchDeg, fovYDeg, aspect, nearZ, farZ, orthographic, overridden, mode}。"
  + "Editor 中はフライカメラ、Playing 中はゲームカメラ。"
  + "★target は position + forward * targetDistance。そのまま dx12_set_editor_camera {position, target} へ渡すと同じ yaw/pitch に戻るので、視点の保存 → 復元 → 読み返し検証がこれ 1 組でできる。"
  + "★overridden:true は dx12_set_editor_camera が Play 中のゲームカメラ同期を止めて視点を固定している状態(release で解除)。",
  {
    targetDistance: z.number().optional().describe("target を再構成する距離(m)。既定 10。0.001〜100000。被写体までの距離を入れると target が実際の注視点に近くなる。"),
  },
  { readOnlyHint: true },
  ({ targetDistance }) => run(() => engine.call("get_editor_camera", { targetDistance })),
);

reg(
  "dx12_set_editor_camera",
  "エディタカメラ設定",
  "シーンビューのカメラを任意視点に置く(focus_camera より自由。俯瞰・引き構図・特定アングルの確認用)。position で位置、target で注視点(yaw/pitch を自動逆算)、または yawDeg/pitchDeg を直接指定。"
  + "★Play 中も使える(以前は MODE_CONFLICT だったが解消済み)。Playing 中に呼ぶとアクティブな CameraComponent の毎フレーム同期を止めて視点を固定する(返り値 overridden:true)。"
  + "ゲームカメラへ返すには {release:true}。Play/Stop の遷移でも自動解除されるので、撮影用の固定を持ち越す事故は無い。"
  + "この後 dx12_screenshot_final でその視点の最終画が撮れる(dx12_screenshot_from が一発でやる)。",
  {
    position: v3().optional().describe("カメラ位置 [x,y,z]。省略で現在位置のまま。"),
    target: v3().optional().describe("注視点 [x,y,z]。指定すると yaw/pitch を自動計算(yawDeg/pitchDeg より優先)。"),
    yawDeg: z.number().optional().describe("Y軸回転(度)。target 指定時は無視。"),
    pitchDeg: z.number().optional().describe("X軸回転(度、±89 でクランプ)。target 指定時は無視。"),
    release: z.boolean().optional().describe("true で Play 中のカメラ固定(overridden)を解除してゲームカメラへ返す。他の引数は無視され {released:true, overridden:false} が返る。"),
  },
  { idempotentHint: true },
  ({ position, target, yawDeg, pitchDeg, release }) =>
    run(() => engine.call("set_editor_camera", { position, target, yawDeg, pitchDeg, release })),
);

reg(
  "dx12_get_bounds",
  "ワールドAABB取得",
  "エンティティのワールド空間 AABB を返す。{min, max, center, size, hasMesh}。回転・スケール・親子変換込み。「テーブルの上に置く」「壁にぴったり寄せる」等、配置座標を数値で決める時の基礎情報。includeChildren=true で子孫も含めた全体境界。メッシュ無し(ライト等)は位置の点(size=0)。",
  {
    ...entityRef,
    includeChildren: z.boolean().optional().describe("true で子孫エンティティの AABB も合成する(モデルルートが empty の時に有効)。"),
  },
  { readOnlyHint: true },
  ({ entity, name, includeChildren }) =>
    run(() => engine.call("get_bounds", { entity, name, includeChildren })),
);

reg(
  "dx12_look_at",
  "エンティティを向ける",
  "エンティティを目標(座標 or 別エンティティ)の方へ回転させる(+Z が正面の想定で rotation Euler を書く)。カメラを被写体へ、敵をプレイヤーへ、砲台を目標へ等。upright=true で水平回転のみ(ピッチ 0=キャラ向け)。★rotation はローカル値なので親が回転してると厳密なワールド向きからずれる。",
  {
    ...entityRef,
    target: v3().optional().describe("目標のワールド座標 [x,y,z]。targetEntity/targetName と排他。"),
    targetEntity: z.number().int().optional().describe("目標エンティティ id。"),
    targetName: z.string().optional().describe("目標エンティティ名(完全一致)。"),
    upright: z.boolean().optional().describe("true でピッチ 0(水平回転のみ)。キャラや車など直立させたい時。"),
  },
  {},
  ({ entity, name, target, targetEntity, targetName, upright }) =>
    run(() => engine.call("look_at", { entity, name, target, targetEntity, targetName, upright })),
);

reg(
  "dx12_snap_to_ground",
  "接地(下の面に置く)",
  "エンティティを直下の床/他メッシュの天面に置く(Editor 中でも動く)。既定は三角形単位の精密レイキャストで真下の【実際の面】に乗せる(斜面・階段・地形の起伏に追従)。真下に三角形が無ければ AABB の天面判定へフォールバックし、それも無ければ y=0 平面へ。offset で浮かせられる。spawn した物が空中に浮いてる/めり込んでる時の修正に。{groundY, movedBy, position, method, groundEntityId?} が返る(method=raycast なら精密、aabb ならフォールバック)。",
  {
    ...entityRef,
    offset: z.number().optional().describe("接地面からの追加オフセット(m)。既定 0。"),
    // エンジンは以前から precise を受けていたのにスキーマに無く、渡しても黙って捨てられていた。
    precise: z.boolean().optional().describe("三角形単位の精密レイキャストで接地面を決める。既定 true。false にすると旧来の AABB 天面判定だけになる(地形の上で山頂の高さに吸い付く)。"),
  },
  { idempotentHint: true },
  ({ entity, name, offset, precise }) =>
    run(() => engine.call("snap_to_ground", { entity, name, offset, precise })),
);

reg(
  "dx12_get_hierarchy",
  "シーン階層ツリー取得",
  "シーン全体の親子ツリーを返す。{roots:[{entityId, name, children:[...]}], count, sceneGeneration}。dx12_list_entities のフラット一覧と違い構造(どれが誰の子か)が分かる。プレハブ/モデルの内部構造確認やシーン整理に。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_hierarchy", {})),
);

// ════════════════════════════════════════════════════════════════
//  アセット操作(import / メタ情報 / 移動 / 削除)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_import_asset",
  "外部アセット取り込み",
  "assets の外にあるファイル/フォルダをプロジェクトの assets/ へコピーする(ダウンロードした素材や /asset コマンドの出力の取り込み用)。sourcePath は絶対パス可(唯一 assets 外を読むツール)、destPath は assets 相対。フォルダを渡すと再帰コピー。★.gltf は同階層の .bin/テクスチャを参照するのでフォルダごと import すること。{imported:[相対パス...], count} が返る。",
  {
    sourcePath: z.string().describe("取り込み元の絶対パス(ファイル or フォルダ)。例: C:/Users/me/Downloads/rock.glb"),
    destPath: z.string().describe("assets 相対の置き先。ファイルなら 'models/rock.glb'、フォルダ/末尾'/' ならその中へ元ファイル名で入る。"),
    overwrite: z.boolean().optional().describe("true で既存を上書き。既定 false(存在したらエラー)。"),
  },
  {},
  ({ sourcePath, destPath, overwrite }) =>
    run(() => engine.call("import_asset", { sourcePath, destPath, overwrite })),
);

reg(
  "dx12_asset_info",
  "アセットのメタ情報",
  "アセットの中身情報を GPU を使わず読む。モデル(gltf/glb/fbx/obj): meshCount/totalVertices/totalFaces/materialCount/boneCount/hasSkeleton/animations[{name,durationSec}]/aabbMin,aabbMax(ノード変換込みのワールド AABB = スケール1で置いた時の実サイズ)。テクスチャ(png/jpg/dds/tga/bmp/hdr): width/height/mipLevels/format/isCubemap。その他は type と fileSizeBytes のみ。spawn 前に「このモデルどのくらいの大きさ? アニメ持ってる?」を確認するのに使う。",
  {
    path: z.string().describe("assets 相対パス。例: models/enemy.glb"),
  },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("asset_info", { path })),
);

reg(
  "dx12_move_asset",
  "アセット移動/リネーム",
  "assets 内のファイル/フォルダを移動・リネームする。★参照パスは自動で追従する: 開いているシーンはメモリ上で更新され(refsUpdated)、ディスク上の他シーン/.prefab/.dxmat/.animfsm/.spranim/.terrainlayers/.uianim も書き換わる(filesChanged / changedFiles)。★開いているシーンの分はメモリ上の更新なので dx12_save_scene で保存すること(保存しないとそのシーンだけ古いパスのまま残る)。ディレクトリを動かした場合は配下の相対部分を保って付け替える。",
  {
    from: z.string().describe("assets 相対の移動元。"),
    to: z.string().describe("assets 相対の移動先。"),
    overwrite: z.boolean().optional().describe("true で既存ファイルを上書き(ディレクトリは不可)。既定 false。"),
    updateFiles: z.boolean().optional().describe("ディスク上の他ファイル内の参照も書き換える。既定 true。false にすると開いているシーンのメモリ上だけ更新する。"),
  },
  {},
  // ★updateFiles を落とすと engine 側の既定 true が効いて、false を渡したのに
  //   ディスク上の他ファイルが書き換わる（成功が返るので気づけない）。
  ({ from, to, overwrite, updateFiles }) =>
    run(() => engine.call("move_asset", { from, to, overwrite, updateFiles })),
);

reg(
  "dx12_delete_asset",
  "アセット削除",
  "assets 内のファイルを削除する。ディレクトリは recursive=true が必須(誤爆防止)。★シーン/プレハブが参照中のアセットを消すとロードが壊れる。取り返しがつかないので消す前に本当に未参照か確認すること。",
  {
    path: z.string().describe("assets 相対パス。"),
    recursive: z.boolean().optional().describe("ディレクトリを丸ごと消す時に true。既定 false。"),
  },
  { destructiveHint: true },
  ({ path, recursive }) => run(() => engine.call("delete_asset", { path, recursive })),
);

// ════════════════════════════════════════════════════════════════
//  合成ツール(エンジンには無い。Node 内で複数 call を順に行う)
// ════════════════════════════════════════════════════════════════

// 決定的な乱数(mulberry32)。同じ seed なら同じ配置=AI のリトライで結果が再現する。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

reg(
  "dx12_scatter",
  "一括配置(散布/グリッド)",
  "プリミティブ/モデル/プレハブを矩形エリアへ一括配置する(木を50本、コインを敷き詰める等を1回の呼び出しで)。placement='random'(seed 付き乱数、同 seed で再現) か 'grid'(等間隔)。randomYaw で向きをばらし、scaleRange でサイズをばらす。snapToGround=true で1体ずつ接地。★Editor 限定(Playing 中は不可)。{entities:[{entityId, name}], count, seed} が返る。多数配置は時間がかかる(1体ずつフレーム境界で生成)。",
  {
    type: z.string().optional().describe("プリミティブ種別(box/sphere/plane/empty 等、dx12_create_entity と同じ)。type/model/prefab のどれか1つ必須。"),
    model: z.string().optional().describe("モデルの assets 相対パス(.gltf/.glb/.fbx/.obj)。"),
    prefab: z.string().optional().describe("プレハブの assets 相対パス(.prefab)。"),
    count: z.number().int().min(1).max(200).describe("配置する個数(1..200)。"),
    area: z.array(z.number()).length(4).describe("配置エリア [minX, minZ, maxX, maxZ](ワールド座標)。"),
    y: z.number().optional().describe("配置する高さ(Y)。既定 0。snapToGround を使うなら地面より上に。"),
    placement: z.enum(["random", "grid"]).optional().describe("random=seed 付き乱数(既定) / grid=等間隔グリッド。"),
    seed: z.number().int().optional().describe("乱数 seed。同じ seed なら同じ配置(既定 1)。"),
    randomYaw: z.boolean().optional().describe("true で各個体の Y 回転をランダムに(既定: random 時 true / grid 時 false)。"),
    scaleRange: z.array(z.number()).length(2).optional().describe("[min, max] の一様スケール倍率をランダム適用。例 [0.8, 1.3]。"),
    snapToGround: z.boolean().optional().describe("true で配置後に1体ずつ snap_to_ground を呼ぶ。"),
    namePrefix: z.string().optional().describe("エンティティ名の接頭辞(連番付与)。省略で種別/ファイル名。"),
  },
  {},
  (args: any) => run(async () => {
    const { count, area, placement = "random", seed = 1, scaleRange, snapToGround } = args;
    const sources = [args.type, args.model, args.prefab].filter((s: any) => s != null);
    if (sources.length !== 1) throw new Error("type / model / prefab のどれか1つだけ指定してや");
    const [minX, minZ, maxX, maxZ] = area;
    const y = args.y ?? 0;
    const randomYaw = args.randomYaw ?? (placement === "random");
    const rng = mulberry32(seed);
    const prefix = args.namePrefix
      ?? (args.type ?? String(args.model ?? args.prefab).split("/").pop()!.replace(/\.[^.]*$/, ""));

    // 位置リストを先に決める(grid は行×列で等間隔、random は seed 付き乱数)
    const positions: [number, number, number][] = [];
    if (placement === "grid") {
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      for (let i = 0; i < count; i++) {
        const cx = i % cols, rz = Math.floor(i / cols);
        const fx = cols > 1 ? cx / (cols - 1) : 0.5;
        const fz = rows > 1 ? rz / (rows - 1) : 0.5;
        positions.push([minX + (maxX - minX) * fx, y, minZ + (maxZ - minZ) * fz]);
      }
    } else {
      for (let i = 0; i < count; i++)
        positions.push([minX + (maxX - minX) * rng(), y, minZ + (maxZ - minZ) * rng()]);
    }

    const entities: any[] = [];
    const errors: any[] = [];
    for (let i = 0; i < count; i++) {
      const nm = `${prefix}_${String(i + 1).padStart(3, "0")}`;
      try {
        let created: any;
        if (args.type)        created = await engine.call("create_entity", { type: args.type, name: nm, position: positions[i] });
        else if (args.model)  created = await engine.call("spawn_model", { path: args.model, name: nm, position: positions[i] });
        else                  created = await engine.call("spawn_prefab", { path: args.prefab, name: nm, position: positions[i] });
        const id = created?.rootEntityId ?? created?.entityId;
        const tf: any = {};
        if (randomYaw) tf.rotation = [0, rng() * 360, 0];
        if (scaleRange) {
          const s = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * rng();
          tf.scale = [s, s, s];
        }
        if (Object.keys(tf).length) await engine.call("set_transform", { entity: id, ...tf });
        if (snapToGround) await engine.call("snap_to_ground", { entity: id });
        entities.push({ entityId: id, name: created?.name ?? nm });
      } catch (e: any) {
        errors.push({ index: i, error: e.message });
        if (errors.length >= 3) break;   // 失敗が3件溜まったら打ち切り(Playing 中など根本原因があるはず)
      }
    }
    const out: any = { entities, count: entities.length, seed, placement };
    if (errors.length) out.errors = errors;
    return out;
  }),
);

/**
 * dx12_batch の op(engine method 直叩き)に対して、対応するツールが宣言している
 * 引数キーを返す。合成ツール(engine と 1:1 でない)と未知 method は null = 検査しない。
 */
function batchDeclaredKeys(method: string): string[] | null {
  const toolName = `dx12_${method}`;
  if (COMPOSITE_TOOLS.has(toolName)) return null;
  const declared = TOOL_PARAM_KEYS.get(toolName);
  if (!declared) return null;   // ツール未登録の method(read_texture 等)はエンジンに任せる
  return [...declared, ...(METHOD_KEY_ALIASES[method] ?? [])];
}

reg(
  "dx12_batch",
  "一括実行",
  "複数のエンジン操作を順番に実行して往復を減らす。各 op は engine の method 名(dx12_ 接頭辞なし。例 create_entity)と params。結果は {results:[{index, ok, result?|error?, error_code?, skipped?}]}。stopOnError=true なら最初の失敗で打ち切り、残りは skipped 記録。各 op は同期結果なので確実(ただし1フレーム原子性は無い)。★params のキーは対応する dx12_<method> ツールと同じ。知らないキーが混じっていたらそのopは実行せずエラーにする(エンジンは知らないキーを黙って無視するため)。",
  {
    ops: z.array(z.object({
      method: z.string().describe("エンジン method 名(dx12_ 接頭辞なし)。例: create_entity, set_component"),
      params: z.record(z.any()).optional().describe("その method の params。省略で {}。"),
    })).describe("順に実行する操作の配列。"),
    stopOnError: z.boolean().optional().describe("true なら最初の失敗で打ち切り、残りを skipped 記録。"),
  },
  {},
  ({ ops, stopOnError }) => run(async () => {
    const results: any[] = [];
    let aborted = false;
    for (let i = 0; i < ops.length; i++) {
      if (aborted) { results.push({ index: i, ok: false, skipped: true }); continue; }
      const op = ops[i];
      try {
        // batch はツールのスキーマを通らない = 未知キーがそのままエンジンへ流れて
        // 黙って無視される唯一の抜け道。ここで同じ検査をかける。
        const declared = batchDeclaredKeys(op.method);
        if (declared) {
          const bad = unknownParamKeys(op.params, declared);
          if (bad.length > 0) throw unknownKeyError(`dx12_batch ops[${i}] (${op.method})`, bad, declared);
        }
        const r = await engine.call(op.method, op.params ?? {});
        results.push({ index: i, ok: true, result: r });
      } catch (e: any) {
        const entry: any = { index: i, ok: false, error: e.message };
        if (e.code != null) entry.error_code = e.code;
        results.push(entry);
        if (stopOnError) aborted = true;
      }
    }
    return { results };
  }),
);

// 画像を返す合成ツール(focus → 1フレーム描画 → 撮影)。outputSchema は宣言しない(構造化結果ではなく image)。
regRaw(
  "dx12_focus_and_screenshot",
  {
    title: "寄せて撮影",
    description: "カメラを対象エンティティに寄せてからスクショを撮り、PNG 画像で返す(dx12_focus_camera + dx12_screenshot_final の合成)。entity(id) か name 指定。配置や見た目を自分の目で確認するのに使う。"
      + "★撮るのは【ポスト適用後の最終画】なのでグレーディング/ブルーム/TAA 込みの見た目が確認できる。image ブロック + text(path/サイズ)を返す。",
    inputSchema: { ...entityRef },
    annotations: { title: "寄せて撮影", openWorldHint: false, idempotentHint: true },
  },
  async ({ entity, name }) => {
    try {
      await engine.call("focus_camera", { entity, name });
      const shot = await engine.call("screenshot_final", {});
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      return imageResult(shot.path, {
        entity, width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer", postApplied: shot.postApplied,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── スクショ 2 種の共通引数 ────────────────────────────────────────
// ★zod の同一インスタンスを 2 つのツールで共有すると JSON Schema が $ref に畳まれ、
//   $ref を解決しないクライアントではスキーマが空に見える。v3() と同じく
//   【呼ぶたびに新しいインスタンスを作るファクトリ】にすること。
const captureParams = () => ({
  path: z.string().optional().describe(
    "出力先の PNG パス(エンジンの CWD からの相対 or 絶対)。拡張子 .png は自動補完、親フォルダは自動生成、'..' は拒否。"
    + "★省略すると毎回【同じ既定ファイル】を上書きする。連写・並行実行するときは必ず別々の path を指定すること。"),
  deterministic: z.boolean().optional().describe(
    "true でピクセル完全再現モード。既定 false。time を固定(deband ディザ/グレイン/wave/glitch/パーティクルが止まる)し、"
    + "TAA・ボリュメトリックフォグ・SSGI の時間ジッタ位相を 0 に固定、時間蓄積の履歴を捨ててから settleFrames ぶん回して撮る。"
    + "★A/B のピクセル差分を取るなら必須(付けないと同じ設定でも 2 枚は一致しない: deband/グレインで画面の 66%、TAA で 9.4% が動く)。"
    + "★止まるのはレンダラの時間依存だけ。Play 中のゲームシミュレーション(移動/物理/アニメ)は止まらないので、厳密に比べるなら dx12_stop してから撮る。"),
  settleFrames: z.number().int().optional().describe(
    "deterministic:true のとき履歴を捨ててから回すフレーム数(1..240)。既定 8。増やすと TAA / SSGI の収束が進む(決定性そのものは 8 で得られる)。deterministic:false のときは無視される。"),
});

// スクショ単体も画像ブロックで返す。
regRaw(
  "dx12_screenshot",
  {
    title: "スクリーンショット(ポスト前)",
    description: "今シーンビューに映ってる絵を PNG に書き出して画像で返す(+text に path/width/height/source)。"
      + "★★これは【ポストプロセス前の m_sceneRT】。カラーグレーディング(contrast/brightness/saturation/warmth/hueShift/tint)・"
      + "ブルーム・ゴッドレイ・ビネット・LUT・FXAA・デバンド・TAA の解決結果が【1 つも写らない】。"
      + "見た目を判断する / 参照画像と比べる / ポストを触った結果を確かめるなら必ず dx12_screenshot_final を使うこと。"
      + "こちらは『幾何とライティングの素の値』を見たいとき(ポストの化粧を剥がして原因を切り分けたいとき)に使う。"
      + "★Playing 中はアクティブなゲームカメラの絵になる。Editor 中はエディタのフライカメラ。"
      + "dx12_project_world_to_screen と同じカメラなので「player が画面中央/画面内か」を数値+絵の両方で確認できる。",
    inputSchema: { ...captureParams() },
    annotations: { title: "スクリーンショット(ポスト前)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path: outPath, deterministic, settleFrames }) => {
    try {
      const shot = await engine.call("screenshot", { path: outPath, deterministic, settleFrames });
      if (!shot || !shot.path) throw new Error("screenshot が path を返さなかった");
      return imageResult(shot.path, {
        width: shot.width, height: shot.height,
        source: shot.source ?? "sceneRT(pre-post)",
        deterministic: shot.deterministic ?? false,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ★測定と目視の食い違いを断つ本命。バックバッファ(＝ポスト適用後の最終画)を撮る。
regRaw(
  "dx12_screenshot_final",
  {
    title: "最終画スクリーンショット(ポスト後)",
    description: "★見た目を判断するときの既定の撮り方。バックバッファ(ポスト適用後の最終画)のビューポート矩形を PNG で返す。"
      + "dx12_screenshot(ポスト前の m_sceneRT)と違い、カラーグレーディング・ブルーム・ゴッドレイ・ビネット・LUT・FXAA・デバンド・TAA の解決結果が【全部写る】"
      + "= 人間がビューポートで見ている絵と同じ。ImGui を描く前にコピーするので【エディタのパネル/ギズモは写らない】＝ゲームと同じ絵になる。"
      + "サイズはウィンドウ全体ではなくシーンビューの矩形。"
      + "★遅延同期(1 フレーム描いてから返る。deterministic:true なら settleFrames ぶん回してから返る)。"
      + "★エディタのパネル込みが欲しいなら dx12_ui_screenshot、中間バッファの可視化は dx12_render_debug。"
      + "★Playing 中はアクティブなゲームカメラの絵になる(= 実際のゲーム画面のポスト後)。",
    inputSchema: { ...captureParams() },
    annotations: { title: "最終画スクリーンショット(ポスト後)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path: outPath, deterministic, settleFrames }) => {
    try {
      const shot = await engine.call("screenshot_final", { path: outPath, deterministic, settleFrames });
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      return imageResult(shot.path, {
        width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer",
        postApplied: shot.postApplied,
        deterministic: shot.deterministic ?? false,
        taa: shot.taa,
        mode: shot.mode,
        note: shot.note,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// エディタウィンドウ全体のスクショ(ImGui パネル込み)。ゲーム内 UI / UIエディタの見た目確認用。
regRaw(
  "dx12_ui_screenshot",
  {
    title: "UIスクリーンショット",
    description: "エディタウィンドウ全体(ImGui パネル込み)を PNG で返す。★dx12_screenshot(シーンRT)には写らないゲーム内 UI プレビュー・UIエディタ・インスペクタが写る = AI が組んだ UI の見た目を目で確認して直すのに使う。ウィンドウが最小化中はエラー。レイアウトの数値確認は dx12_ui_tree の方が正確。",
    inputSchema: {},
    annotations: { title: "UIスクリーンショット", openWorldHint: false, readOnlyHint: true },
  },
  async () => {
    try {
      const shot = await engine.call("ui_screenshot", {});
      if (!shot || !shot.path) throw new Error("ui_screenshot が path を返さんかった");
      return imageResult(shot.path, { width: shot.width, height: shot.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── 中間バッファ可視化(「なぜ変に見えるか」の切り分け) ────────────────────
//
// ★mode を zod の enum にしてある。albedo / overdraw は【意図的に非対応】なので、
//   渡されたら errorMap で「なぜ無いか + 代わりに何を見るか」を本文にして弾く
//   (ただ弾くと AI は綴り間違いだと解釈して何度も撃ち直す)。理由の表は sceneTools.ts。
// ★毎回新しい zod インスタンスを作るファクトリにしてある($ref に畳まれるのを避ける流儀)。
const renderDebugModeSchema = () =>
  z.enum(RENDER_DEBUG_MODES as unknown as [string, ...string[]], {
    errorMap: (issue, ctx) => {
      const msg = renderDebugModeIssue((issue as { received?: unknown }).received);
      return { message: msg ?? ctx.defaultError };
    },
  });

regRaw(
  "dx12_render_debug",
  {
    title: "中間バッファ可視化",
    description:
      "レンダラの中間バッファを可視化して PNG 画像で返す。★『絵がなんか変』の原因を切り分けるための唯一の入口。"
      + "frames フレーム描いてから撮影し、【呼ぶ前と完全に同じ設定へ必ず戻す】(一時的に ON にした機能も戻る)。"
      + "可視化はポスト前の m_sceneRT へ描くので dx12_screenshot と違って必ず写る。"
      + "\n■ mode: normal(ワールド法線 0.5+0.5*N。★G-Buffer は幾何法線なので法線マップは載っていない) / "
      + "roughness / metallic(どちらも G-Buffer のスカラー値のみ。ORM テクスチャは載っていない) / "
      + "depth(ビュー空間 Z のヒートマップ。青=近→赤=遠、空は黒。depthRange で正規化) / "
      + "ao(SSAO。白=遮蔽なし) / contactShadow(白=遮蔽なし) / "
      + "velocity(速度バッファ。R=+X G=+画面下。★静止していれば一様な (0.5,0.5,0.5) が正常。gain 20 くらいが見やすい) / "
      + "ssr / ssgi(時間蓄積があるので frames を 8〜16 に) / "
      + "rt(DXR のプライマリレイのヒット距離をヒートマップ。空/ミスは黒。depthRange で正規化。"
      + "RT 影 / RT-AO が OFF でも TLAS を一時的に建てるので TLAS が正しく建つかの目視に使える) / "
      + "rtDiff(★加速構造の検証はこれが本命。|RT のヒット距離 − ラスタの距離| をヒートマップ。"
      + "【黒 = 完全一致】、マゼンタ = 片方だけヒット。行列の転置ミスやノード変換の付け忘れを一発で炙り出す。"
      + "gain を 20 くらいにすると 5cm でフルスケール。スキンドと半透明は TLAS に入らない仕様なのでマゼンタになるのが正常。"
      + "BLAS は LOD0 固定なので遠くて低 LOD の物に数 cm の差が出るのも正常) / "
      + "rtAlbedo(★バインドレスの検証。レイのヒット点のアルベドをそのまま出す。"
      + "ラスタの絵と色が一致すれば InstanceID → GeometryInfo → VB/IB/テクスチャ の配線と"
      + "バリセントリック補間が全部正しい。BLAS は LOD0 固定なので比較は近距離で。"
      + "Dynamic Resources 非対応 GPU では真っ黒。dx12_get_dxr の stats.bindlessReady で確認できる) / "
      + "shadowCascade(CSM のカスケードを赤/緑/青/黄で色分け) / "
      + "lightComplexity(クラスタごとの灯数ヒートマップ。青0→緑→赤、★白=128 灯で切り捨て中) / "
      + "clusterGrid(クラスタ境界の市松) / decalCount(★白=16 枚で切り捨て中) / "
      + "fogScattering・fogTransmittance・fogSlice(ボリュメトリックフォグの散乱/透過率/froxel スライス) / "
      + "off(何も撮らず全部戻すだけ。途中で失敗したときのリセット用)。"
      + "\n■ rt / rtDiff は DXR 非対応 GPU だと【真っ黒になるだけ】でエラーにはならない"
      + "(warnings に理由が出る)。先に dx12_get_dxr で supported を見ておくと空振りしない。"
      + "\n■ normal / roughness / metallic / velocity は【深度+速度プリパスでしか書かれない】ので、"
      + "TAA も SSR も SSGI も OFF のときはエンジンが TAA を一時 ON にして撮る(warnings に出る)。"
      + "この 4 モードが『ジオメトリだけの粗い絵』に見えるのは仕様。"
      + "\n■ 返り値 {path(絶対パス), mode, width, height, toneMapped, warnings:[...], mode_engine}。"
      + "toneMapped:false のモードはトーンマップ/露出を掛けずに 8bit へ落とすので、"
      + "【PNG のピクセル値がそのままバッファの値】として読める。warnings は必ず読むこと"
      + "(「フォグが無効なので何も出ない」等、真っ黒な絵の理由がここに出る)。"
      + "\n■ albedo と overdraw は意図的に非対応(理由つきで弾かれる)。",
    inputSchema: {
      mode: renderDebugModeSchema().describe(
        "可視化する中間バッファ。off は『何も撮らず設定を戻すだけ』。albedo / overdraw は非対応。"),
      frames: z.number().int().min(1).max(120).optional().describe(
        "撮影までに描くフレーム数(1..120、既定 3)。ssr / ssgi は時間蓄積があるので 8〜16 にすると安定する。"),
      gain: z.number().optional().describe(
        "可視化の倍率(既定 1)。velocity は値が小さいので 20 くらいにすると見やすい。"),
      depthRange: z.number().optional().describe(
        "mode:\"depth\" のヒートマップを正規化する距離(m。既定 100)。屋内なら 20、遠景なら 500 等。"),
      exposure: z.number().optional().describe(
        "HDR を出すモード(ssr / ssgi)の露出倍率(既定 1)。真っ黒/真っ白なときに動かす。"),
    },
    annotations: { title: "中間バッファ可視化", openWorldHint: false, readOnlyHint: true, idempotentHint: true },
  },
  async ({ mode, frames, gain, depthRange, exposure }) => {
    try {
      const r = await engine.call("render_debug", definedOnly({ mode, frames, gain, depthRange, exposure }));
      const meta = {
        mode: r?.mode ?? mode,
        width: r?.width, height: r?.height,
        toneMapped: r?.toneMapped,
        warnings: r?.warnings ?? [],
        mode_engine: r?.mode_engine,
      };
      // mode:"off" は撮影しない(エンジンが path:"(no capture)" を返す)。画像が無いので JSON だけ返す。
      const p: unknown = r?.path;
      if (typeof p !== "string" || !fs.existsSync(p)) {
        return { content: [{ type: "text", text: JSON.stringify({ path: p ?? null, ...meta }, null, 2) }] };
      }
      return imageResult(p, meta);
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// 参照UIスクショ + 現在UI を横並び1枚に合成して返す比較ツール(outputSchema なし = image 結果)。
regRaw(
  "dx12_ui_compare",
  {
    title: "参照UIとの比較",
    description: "参照ゲームのUIスクショ(referencePath)と現在のUI(ui_screenshot)を横並び1枚(左=参照、右=現在、間に区切り線)に合成したPNGで返す。2枚を別々に見るより正確に差分を比較できる。text にピクセル差分率 diffRatio(%) と両画像サイズも返す。grid=true で右側(現在)に8pxグリッド線を薄く重畳(整列・余白の確認用)。★使い方: 合成画像を見て『参照と違う点を3つ』具体的に挙げてから直し、再度このツールで確認するループを回す。1回で寄せきろうとしない。",
    inputSchema: {
      referencePath: z.string().describe("参照UI画像(PNG)の絶対パス。ユーザーから貰った目標スクショ。"),
      grid: z.boolean().optional().describe("true で右側(現在のUI)に8pxグリッド線を薄く重畳。整列確認用。既定 false。"),
    },
    annotations: { title: "参照UIとの比較", openWorldHint: false, readOnlyHint: true },
  },
  async ({ referencePath, grid }) => {
    try {
      const shot = await engine.call("ui_screenshot", {});
      if (!shot || !shot.path) throw new Error("ui_screenshot が path を返さんかった");
      const r = compareUiImages(fs.readFileSync(referencePath), fs.readFileSync(shot.path), { grid });
      const outPath = path.join(os.tmpdir(), `dx12_ui_compare_${Date.now()}.png`);
      fs.writeFileSync(outPath, r.compositePng);
      return imageResult(outPath, { diffRatio: Number(r.diffRatio.toFixed(2)), refSize: r.refSize, curSize: r.curSize });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── UI 素材(フォント導入) ──────────────────────────────────────
reg(
  "dx12_install_font",
  "Google Fonts からフォント導入",
  "Google Fonts からフォント(.ttf)をダウンロードして現在のプロジェクトの assets/fonts/ へ取り込む。返る fontPath を uiText.fontPath に設定して使う(例: dx12_set_component で uiText:{fontPath:'fonts/NotoSansJP-700.ttf'})。★日本語を表示する UI には日本語対応フォント(Noto Sans JP / M PLUS Rounded 1c / Zen Kaku Gothic New 等)を選ぶこと — Roboto 等の欧文フォントでは日本語が豆腐(□)になる。family は Google Fonts のファミリー名そのまま(スペース含む)。{fontPath, family, weight} が返る。",
  {
    family: z.string().describe("Google Fonts のファミリー名。例: 'Noto Sans JP', 'Roboto', 'Bebas Neue'"),
    weight: z.number().int().optional().describe("ウェイト(100–900)。省略時は 400。太字見出しは 700 推奨。"),
  },
  {},
  ({ family, weight }) =>
    run(async () => {
      const { tmpPath, fileName } = await downloadFont(family, weight);
      await engine.call("import_asset", { sourcePath: tmpPath, destPath: `fonts/${fileName}`, overwrite: true });
      return { fontPath: `fonts/${fileName}`, family, weight: weight ?? 400 };
    }),
);

// ゲームカメラ視点のスクショ。アクティブな CameraComponent でシーンを1フレーム描いて撮る。
// Editor 中でも Play せずにゲームカメラの画角を確認できる(Playing 中は通常 screenshot と同じ絵)。
regRaw(
  "dx12_screenshot_game_view",
  {
    title: "ゲーム画面スクショ",
    description: "アクティブな CameraComponent(ゲームカメラ)視点でシーンを1フレーム描画して PNG で返す。★Editor 中でも Play せずにゲームカメラの見え方(画角・構図)を確認できる。アクティブなカメラが無いとエラー(camera.isActive=true にする)。image ブロック + text(path/サイズ/mode)を返す。",
    inputSchema: {},
    annotations: { title: "ゲーム画面スクショ", openWorldHint: false, readOnlyHint: true },
  },
  async () => {
    try {
      const shot = await engine.call("screenshot_game_view", {});
      if (!shot || !shot.path) throw new Error("screenshot_game_view が path を返さんかった");
      return imageResult(shot.path, { width: shot.width, height: shot.height, mode: shot.mode });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// 任意視点スクショ(set_editor_camera → 次フレームで screenshot)。俯瞰/引きの構図を一発で。
regRaw(
  "dx12_screenshot_from",
  {
    title: "任意視点スクショ",
    description: "カメラを指定の位置・注視点へ動かしてからスクショを撮り、PNG 画像で返す(dx12_set_editor_camera + dx12_screenshot_final の合成)。俯瞰でレイアウト全体を見る、プレイヤー視点の高さで見る等。"
      + "★撮るのは【ポスト適用後の最終画】なのでグレーディング/ブルーム/TAA 込みの見た目が確認できる。"
      + "★Play 中も使える(カメラを固定して撮る。dx12_set_editor_camera {release:true} でゲームカメラへ返す)。image ブロック + text(path/サイズ)を返す。",
    inputSchema: {
      position: v3().describe("カメラ位置 [x,y,z]。"),
      target: v3().optional().describe("注視点 [x,y,z]。省略で現在の向きのまま位置だけ移動。"),
    },
    annotations: { title: "任意視点スクショ", openWorldHint: false, idempotentHint: true },
  },
  async ({ position, target }) => {
    try {
      await engine.call("set_editor_camera", { position, target });
      const shot = await engine.call("screenshot_final", {});
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      return imageResult(shot.path, {
        position, target, width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer", postApplied: shot.postApplied,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// テクスチャを画像として見る(エンジンが dds/tga 含め PNG へ変換 → 画像ブロックで返す)。
regRaw(
  "dx12_view_texture",
  {
    title: "テクスチャを見る",
    description: "assets 内のテクスチャ(png/jpg/dds/tga/bmp/hdr)を PNG に変換して画像で返す。割り当てる前に絵柄を目で確認するのに使う。長辺 maxSize(既定 1024)超は縮小。キューブマップは先頭面のみ。image ブロック + text(元パス/サイズ)を返す。",
    inputSchema: {
      path: z.string().describe("assets 相対パス。例: textures/rust.png"),
      maxSize: z.number().int().optional().describe("返す画像の長辺上限 px(16..4096)。既定 1024。"),
    },
    annotations: { title: "テクスチャを見る", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path, maxSize }) => {
    try {
      const r = await engine.call("read_texture", { path, maxSize });
      if (!r || !r.path) throw new Error("read_texture が path を返さんかった");
      return imageResult(r.path, { sourcePath: r.sourcePath, width: r.width, height: r.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// モデルのプレビュー(一時 spawn → 寄せて撮影 → 削除)。spawn する価値があるか見た目で判断する用。
regRaw(
  "dx12_preview_model",
  {
    title: "モデルプレビュー",
    description: "モデルを一時的にシーン外(遠方)へ spawn して撮影し、すぐ削除して PNG で返す(spawn_model → focus_and_screenshot → delete_entity の合成)。アセットの見た目を配置前に確認するのに使う。★Editor 限定。シーンは変更されない(一時エンティティは必ず削除される)。image ブロック + text(path/サイズ)を返す。",
    inputSchema: {
      path: z.string().describe("モデルの assets 相対パス(.gltf/.glb/.fbx/.obj)。"),
    },
    annotations: { title: "モデルプレビュー", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path }) => {
    let previewId: number | null = null;
    try {
      const created = await engine.call("spawn_model",
        { path, name: "__mcp_preview__", position: [0, -10000, 0] });
      previewId = created?.entityId;
      await engine.call("focus_camera", { entity: previewId });
      const shot = await engine.call("screenshot", {});
      if (!shot || !shot.path) throw new Error("screenshot が path を返さんかった");
      const img = imageResult(shot.path, { model: path, width: shot.width, height: shot.height });
      await engine.call("delete_entity", { entity: previewId });
      previewId = null;
      return img;
    } catch (e: any) {
      // 撮影に失敗しても一時エンティティは残さない
      if (previewId != null) { try { await engine.call("delete_entity", { entity: previewId }); } catch {} }
      return errResult(e);
    }
  },
);

// ════════════════════════════════════════════════════════════════
//  精密ピッキング / ワールドレイ(三角形単位)
//  エディタのクリック選択とまったく同じ RaycastScene を通すので、
//  「MCP が見たもの」と「エディタで選ばれるもの」がズレない。
// ════════════════════════════════════════════════════════════════

// 列挙は sceneTools.ts の定数から作る(エンジンの enum と 1 箇所で対応付ける)。
const enumOf = (values: readonly string[]) => z.enum(values as unknown as [string, ...string[]]);

reg(
  "dx12_pick",
  "画面座標でピック(三角形精密)",
  "シーンビューの画面座標から三角形単位でレイキャストして、当たったエンティティを手前から順に返す。"
  + "座標は x/y(ピクセル。dx12_screenshot / dx12_project_world_to_screen と同じ左上原点)か u/v(0..1 の正規化。中央=0.5,0.5)。"
  + "返り値 {hits:[{entityId,name,submeshIndex,distance,worldPos,worldNormal,isIcon}], count, totalHits, screen, viewport, mode}。"
  + "★スクリーンショットを見て『この物体は何？』『ここの床の高さは？』に答える口。worldPos はそのまま "
  + "dx12_set_transform / dx12_sculpt_brush の座標に使える。既定は最前面 1 件、all:true で重なり全部(循環選択の順)。"
  + "ライト/カメラ/空オブジェクトはアイコン当たり(isIcon:true)で拾う。includeIcons:false でメッシュだけに絞る。",
  {
    x: z.number().optional().describe("ピクセル X(左上原点)。y と対で指定。u/v と排他。"),
    y: z.number().optional().describe("ピクセル Y(左上原点)。x と対で指定。"),
    u: z.number().optional().describe("正規化 X(0..1)。v と対で指定。画面中央は 0.5。"),
    v: z.number().optional().describe("正規化 Y(0..1)。u と対で指定。"),
    all: z.boolean().optional().describe("true で重なり全部を手前から返す(既定 false=最前面のみ)。"),
    maxHits: z.number().int().optional().describe("all:true のときの最大件数(既定 16、上限 64)。"),
    includeIcons: z.boolean().optional().describe("ライト/カメラ/空オブジェクトのアイコン当たりを含めるか(既定 true)。"),
    trianglePrecise: z.boolean().optional().describe("三角形単位で判定(既定 true)。false でメッシュ AABB 止まり(粗いが速い)。"),
    maxCandidates: z.number().int().optional().describe("ナローフェーズに掛ける候補数の上限(既定 64)。密集シーンで奥まで拾いたいときだけ上げる。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ x, y, u, v, all, maxHits, includeIcons, trianglePrecise, maxCandidates }) =>
    run(() => engine.call("pick", { x, y, u, v, all, maxHits, includeIcons, trianglePrecise, maxCandidates })),
);

reg(
  "dx12_raycast_precise",
  "ワールドレイキャスト(三角形精密)",
  "ワールド空間のレイを飛ばして【描画メッシュの三角形】と交差判定する。返り値は dx12_pick と同形式。"
  + "★dx12_raycast との違い: あちらは Jolt の物理コライダー基準で Playing 中のみ有効。こっちは描画メッシュ基準で "
  + "Editor でも動き、地形の起伏や彫った岩の実際の表面に当たる(コライダーの有無に依存しない)。"
  + "用途: 真下へ撃って接地高さを取る / 視線が通るか確認 / 配置前に地面の法線(傾き)を知る。"
  + "スキンドメッシュ(SkeletalAnimation 持ち)だけはバインドポーズの AABB 止まりになる。",
  {
    origin: v3().describe("[x,y,z] レイの始点(ワールド)。"),
    direction: v3().describe("[x,y,z] レイの方向(正規化不要)。真下は [0,-1,0]。"),
    maxDistance: z.number().optional().describe("最大距離(既定 1000)。0 で無制限。"),
    all: z.boolean().optional().describe("true で貫通した全ヒットを手前から返す(既定 false=最前面のみ)。"),
    maxHits: z.number().int().optional().describe("all:true のときの最大件数(既定 16、上限 64)。"),
    trianglePrecise: z.boolean().optional().describe("三角形単位で判定(既定 true)。"),
    maxCandidates: z.number().int().optional().describe("候補数の上限(既定 256)。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ origin, direction, maxDistance, all, maxHits, trianglePrecise, maxCandidates }) =>
    run(() => engine.call("raycast_precise",
      { origin, direction, maxDistance, all, maxHits, trianglePrecise, maxCandidates })),
);

// ════════════════════════════════════════════════════════════════
//  ハイトフィールド地形（山・丘・峡谷。★Editor 限定）
//  高さ配列は assets/terrain/<name>.hf に自動保存され、Jolt の HeightFieldShape が
//  同じ配列を読む＝彫れば当たり判定も一緒に動く。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_terrain_create",
  "地形を作る/設定を更新",
  "ハイトフィールド地形を作る(静的コライダー付き)。★冪等: 同じ name の地形が既にあれば作り直さず設定だけ更新する"
  + "(resolution か worldSize を変えたときだけ高さ配列がリセットされ heightsReset:true が返る)。"
  + "返り値 {entityId, name, created, resolution, worldSize, maxHeight, sceneGeneration}。"
  + "作った直後は真っ平ら。山にするのは dx12_terrain_generate、手で彫るのは dx12_terrain_sculpt。"
  + "★Editor 限定(Playing 中は MODE_CONFLICT)。resolution が高いほど細かく彫れるが重い(128 が使いやすい)。",
  {
    name: z.string().optional().describe("エンティティ名(既定 \"Terrain\")。同名があれば設定更新になる。"),
    resolution: z.number().int().optional().describe("1 辺のサンプル数(既定 128、16..512。内部で 4 の倍数へ丸め)。"),
    worldSize: z.number().optional().describe("1 辺のワールド長 m(既定 200)。セル幅 = worldSize/(resolution-1)。"),
    maxHeight: z.number().optional().describe("ブラシの高さクランプ ±この値(既定 200)。"),
    position: v3().optional().describe("[x,y,z] 地形の原点(既定 [0,0,0])。地形は XZ グリッドなので回転/スケールは効かない。"),
    uvScale: z.number().optional().describe("地形全体での UV 繰り返し数(既定 24)。タイリングテクスチャの密度。"),
    color: v3().optional().describe("[r,g,b] 0..1 頂点色(マテリアル未割当時の見た目)。"),
  },
  { idempotentHint: true },
  ({ name, resolution, worldSize, maxHeight, position, uvScale, color }) =>
    run(() => engine.call("terrain_create",
      { name, resolution, worldSize, maxHeight, position, uvScale, color })),
);

reg(
  "dx12_terrain_generate",
  "地形を一発生成(fBm)",
  "fBm ノイズで地形の高さを丸ごと作り直す。preset は hills(なだらかな丘) / canyon(峡谷) / mountains(険しい山脈)。"
  + "★同じ seed と params なら毎回まったく同じ地形になる(冪等)。既存の彫りは消えるので、手で彫る前に必ずこれを先にやる。"
  + "個別パラメータ(frequency/octaves/amplitude/ridged/baseHeight/edgeFalloff/valleyDepth)は preset の値を上書きする。"
  + "返り値に実際に使った params と minHeight/maxHeight が入るので、次の調整の基準にできる。★Editor 限定。",
  {
    ...entityRef,
    preset: enumOf(TERRAIN_PRESETS).optional().describe("生成プリセット(既定 hills)。"),
    seed: z.number().int().optional().describe("乱数シード(既定 1337)。変えると同じ preset でも別の地形になる。"),
    frequency: z.number().optional().describe("空間周波数。小さいほど大きな起伏(0.0001..1)。"),
    octaves: z.number().int().optional().describe("重ねるノイズの段数(1..8)。多いほどディテールが増える。"),
    amplitude: z.number().optional().describe("高さの振幅 m。"),
    ridged: z.number().optional().describe("0..1。1 に近いほど鋭い尾根(山脈らしくなる)。"),
    baseHeight: z.number().optional().describe("全体のかさ上げ m。"),
    edgeFalloff: z.number().optional().describe("0..1。>0 で外周へ向かって高さを落とす(島にする / 縁の崖を防ぐ)。"),
    valleyDepth: z.number().optional().describe(">0 で低い所をさらに下げる(峡谷になる)。"),
  },
  { idempotentHint: true, destructiveHint: true },
  (a) => run(() => engine.call("terrain_generate", a)),
);

reg(
  "dx12_terrain_sculpt",
  "地形をブラシで彫る",
  "地形をブラシで彫る。point:[x,z] で 1 点、points:[[x,z],...] で連続ストローク(稜線・道・堀を一気に引ける。最大 512 点)。"
  + "座標は【ワールド XZ】(y は不要)。brush は raise(盛る)/lower(削る)/smooth(ならす)/flatten(平らに)/noise(岩肌)。"
  + "★相対操作なので同じ呼び出しを 2 回撃つと 2 回ぶん彫れる。絶対値で整地したいときは brush:\"flatten\" + flattenHeight "
  + "を使うと何回撃っても同じ形に収束する(冪等寄り)。strength は raise/lower/noise はメートル、smooth/flatten は寄せ具合(2 でほぼ完全)。"
  + "彫る場所は dx12_pick / dx12_raycast_precise の worldPos か dx12_terrain_sample で決める。★Editor 限定。",
  {
    ...entityRef,
    brush: enumOf(TERRAIN_BRUSHES).optional().describe("ブラシ種別(既定 raise)。浸食は dx12_terrain_erode。"),
    point: v2().optional().describe("[x,z] ワールド座標の 1 点。"),
    points: z.array(z.array(z.number())).optional().describe("[[x,z],...] 連続ストローク(最大 512 点)。[x,y,z] でも可(y は無視)。"),
    worldPos: v3().optional().describe("[x,y,z] ワールド座標(y は無視)。dx12_pick の worldPos をそのまま渡せる。"),
    radius: z.number().optional().describe("ブラシ半径 m(既定 12)。"),
    strength: z.number().optional().describe("1 ストロークぶんの適用量(既定 5)。"),
    falloff: z.number().optional().describe("縁のぼかし 0..1(既定 0.5)。0=硬い縁 / 1=とろけるように滑らか。"),
    flattenHeight: z.number().optional().describe("brush:flatten の目標高さ(ワールド Y)。省略時は最初の点の現在高さ。"),
    mirrorX: z.boolean().optional().describe("X ミラー(x を反転した位置にも同じ筆を置く)。"),
    mirrorZ: z.boolean().optional().describe("Z ミラー。"),
    noiseFrequency: z.number().optional().describe("brush:noise の周波数(既定 0.03)。"),
    noiseOctaves: z.number().int().optional().describe("brush:noise のオクターブ(1..8)。"),
    noiseRidged: z.number().optional().describe("brush:noise の尾根っぽさ 0..1。"),
    seed: z.number().int().optional().describe("brush:noise のシード。"),
  },
  { idempotentHint: false },
  ({ point, points, worldPos, ...rest }) =>
    run(() => {
      // 点の形は Node 側で畳んでからエンジンへ渡す(エラー文をここで具体的にできる & 二重指定で二度塗りしない)。
      const pts = normalizeStrokePoints({ point, points, worldPos });
      return engine.call("terrain_sculpt", { ...rest, points: pts });
    }),
);

reg(
  "dx12_terrain_erode",
  "地形を浸食させる",
  "熱浸食(安息角 talusDeg を超えた斜面の土砂を隣へ落とす)を掛ける。生成直後の CG くさい斜面が一気に自然になる。"
  + "region:[minX,minZ,maxX,maxZ](ワールド XZ)で範囲を絞れる(省略で全面)。"
  + "★相対操作: 繰り返すほど崩れる。まず iterations:16〜40 で試して、足りなければ撃ち足すのが速い。★Editor 限定。",
  {
    ...entityRef,
    iterations: z.number().int().optional().describe("反復回数(既定 16、1..200)。多いほど崩れて滑らかになる。"),
    talusDeg: z.number().optional().describe("安息角 度(既定 34)。小さいほどよく崩れる。"),
    region: v4().optional().describe("[minX,minZ,maxX,maxZ] ワールド XZ の矩形。省略で地形全面。"),
  },
  { idempotentHint: false },
  (a) => run(() => engine.call("terrain_erode", a)),
);

// ── 地形のテクスチャレイヤー（4 層スプラット。terrain.layerSetPath 必須）──────────
// ★エンジン側は Application.cpp:6358 の 1 ブロックで terrain_paint / terrain_autopaint の
//   両方を捌いている。受け付ける引数はそこを読んで写した(憶測なし)。
//   共通の前提: layerSetPath が空なら INVALID_PARAM、Playing 中は MODE_CONFLICT。

reg(
  "dx12_terrain_paint",
  "地形レイヤーを塗る",
  "地形のテクスチャレイヤー(4 層スプラット)の重みを円ブラシで塗る。layer は 0..3 で "
  + ".terrainlayers の並び順(既定は 0=草 / 1=土 / 2=岩 / 3=雪)。座標は【ワールド XZ】で "
  + "point:[x,z] が 1 点、points:[[x,z],...] が連続ストローク(最大 512 点。道や崖の帯を一気に引ける)。"
  + "★相対操作: 同じ呼び出しを 2 回撃つと 2 回ぶん塗れる。strength:1 で 1 回塗ればそのレイヤー 100%、"
  + "他レイヤーは合計 1 を保つよう比例縮小される。全面を傾斜/標高から焼き直すなら dx12_terrain_autopaint。"
  + "★高さを彫り直しても重みは追従しない(彫った後は autopaint し直すか、ここで塗り直す)。"
  + "★前提: terrain.layerSetPath に .terrainlayers が割り当たっていること(未設定なら INVALID_PARAM)。"
  + "割当は地形ツール窓かシーン JSON(dx12_scene_write)から — set_component では触れない。"
  + "返り値 {entityId, layer, points, radius, strength, changed, splatSize}。★Editor 限定。",
  {
    ...entityRef,
    layer: z.number().int().optional().describe("塗るレイヤー index 0..3(既定 0)。.terrainlayers の並び順。"),
    point: v2().optional().describe("[x,z] ワールド座標の 1 点。"),
    points: z.array(z.array(z.number())).optional().describe("[[x,z],...] 連続ストローク(最大 512 点)。[x,y,z] でも可(y は無視)。"),
    worldPos: v3().optional().describe("[x,y,z] ワールド座標(y は無視)。dx12_pick の worldPos をそのまま渡せる。"),
    radius: z.number().optional().describe("ブラシ半径 m(既定 12、0.01..地形の worldSize)。"),
    strength: z.number().optional().describe("1 ストロークぶんの塗り量 0..1(既定 0.7)。1 なら一発でそのレイヤー 100%。"),
    falloff: z.number().optional().describe("縁のぼかし 0..1(既定 0.5)。0=硬い縁 / 1=とろけるように滑らか。"),
  },
  { idempotentHint: false },
  ({ point, points, worldPos, ...rest }) =>
    run(() => {
      // 点の形は Node 側で畳んでから渡す(dx12_terrain_sculpt と同じ流儀)。
      // エンジンは point / points / worldPos を【全部足し込む】ので、そのまま流すと二度塗りになる。
      const pts = normalizeStrokePoints({ point, points, worldPos });
      return engine.call("terrain_paint", { ...rest, points: pts });
    }),
);

reg(
  "dx12_terrain_autopaint",
  "地形レイヤーを自動で焼き直す",
  "傾斜と標高から 4 層のスプラット重みを全面焼き直す(草→土→岩→雪)。★冪等: 何度呼んでも同じ結果になり、"
  + "手で塗った内容(dx12_terrain_paint)は上書きされて消える。しきい値の傾斜は 0=平ら 〜 1=垂直、"
  + "標高は【ワールド Y(m)】。rock*/dirt* は Start で混ざり始め End で完全に置き換わる。"
  + "snowHeightStart/End はどちらか渡した時点で自動雪線を切って手動になる(両方渡すのが安全)。"
  + "★地形を作った/彫った直後の基本手順は「terrain_generate → terrain_erode → autopaint → 仕上げに terrain_paint」。"
  + "★前提: terrain.layerSetPath に .terrainlayers が割り当たっていること(未設定なら INVALID_PARAM)。"
  + "返り値 {entityId, splatSize}。★Editor 限定。",
  {
    ...entityRef,
    rockSlopeStart: z.number().optional().describe("岩が混ざり始める傾斜 0..1(0=平ら, 1=垂直)。"),
    rockSlopeEnd: z.number().optional().describe("岩だけになる傾斜 0..1。Start より大きくする。"),
    dirtSlopeStart: z.number().optional().describe("土が混ざり始める傾斜 0..1。岩より緩い側。"),
    dirtSlopeEnd: z.number().optional().describe("土だけになる傾斜 0..1。"),
    snowHeightStart: z.number().optional().describe("雪が積もり始める標高(ワールド Y, m)。指定すると自動雪線が切れる。"),
    snowHeightEnd: z.number().optional().describe("完全に雪になる標高(ワールド Y, m)。Start と対で渡す。"),
    noiseStrength: z.number().optional().describe("境界を乱すノイズ量 0..1。0 だと帯が定規で引いたようになる。"),
  },
  { idempotentHint: true, destructiveHint: true },
  (a) => run(() => engine.call("terrain_autopaint", a)),
);

reg(
  "dx12_terrain_set_layers",
  "地形にテクスチャレイヤーを割り当てる",
  "地形へ .terrainlayers(4 層の PBR 素材セット)を割り当てる/外す。"
  + "★これが『地形にテクスチャを載せる唯一の MCP 経路』。set_component では terrain を触れないので、"
  + "ここを通らないと dx12_terrain_paint / dx12_terrain_autopaint は INVALID_PARAM で弾かれ続ける。"
  + "初回割当時にスプラット(4 層の重みテクスチャ)を作り、autopaint:true(既定)なら傾斜/標高から自動で塗る。"
  + "★layerSetPath:\"\"(空文字)を渡すと割当を外して従来の頂点色 / .dxmat 経路の見た目へ戻る。"
  + "★省略したパラメータは触らない(冪等)。手順: dx12_terrain_create → dx12_terrain_generate → ここで割当 → "
  + "dx12_terrain_paint で仕上げ → dx12_terrain_splat_info で数値確認。"
  + "返り値 {entityId, layerSetPath, previousLayerSetPath, layerCount, layerNames, splatPath, splatSize, "
  + "splatCreated, uvScale, terrainMatFlags, sceneGeneration, note}。★Editor 限定(Playing 中は MODE_CONFLICT)。",
  {
    ...entityRef,
    layerSetPath: z.string().describe(
      "assets 相対の .terrainlayers(例: terrain/alpine.terrainlayers)。空文字 \"\" で割当解除。存在しなければ NOT_FOUND。"),
    splatResolution: z.number().int().optional().describe(
      "スプラットの一辺(32..2048、既定 512。2 の冪へ正規化される)。初回作成時のみ効く。"),
    autopaint: z.boolean().optional().describe(
      "スプラットを新規作成したとき傾斜/標高から自動で塗るか(既定 true)。false だとレイヤー 0 一色。"),
    uvScale: z.number().optional().describe("レイヤーテクスチャのタイリング倍率(0.01..1000)。大きいほど細かく繰り返す。"),
    heightBlendDepth: z.number().optional().describe(
      "ハイトブレンドの食い込み深さ 0.01..1。大きいほど層の境界が『石の隙間に砂が入る』ような噛み合いになる。"),
    triplanarSharpness: z.number().optional().describe("三平面投影のブレンド鋭さ 1..16。大きいほど面の切り替わりが硬い。"),
    normalStrength: z.number().optional().describe("レイヤー法線マップの強さ 0..2。0 で法線マップ無効。"),
    macroScale: z.number().optional().describe("マクロバリエーションの周期(m) 10..400。遠景のタイリング感を崩す模様の大きさ。"),
    macroStrength: z.number().optional().describe("マクロバリエーションの強さ 0..1。0 で無効。"),
    distTilingStart: z.number().optional().describe("距離タイリング低減が始まる距離(m) 5..200。"),
    distTilingFarScale: z.number().optional().describe("遠景でのタイリング倍率 2..16。大きいほど遠くの繰り返しが目立たなくなる。"),
    pomHeightScale: z.number().optional().describe("視差オクルージョンマッピングの高さ 0..0.3。0 で凹凸なし。上げすぎると輪郭が溶ける。"),
    pomFadeStart: z.number().optional().describe("POM のフェード開始距離(m) 0..40。"),
    pomFadeEnd: z.number().optional().describe("POM が完全に消える距離(m) 1..120。Start より大きくする。"),
    triplanar: z.boolean().optional().describe("三平面投影を使うか(急斜面の引き伸ばし対策)。terrainMatFlags bit0。"),
    pom: z.boolean().optional().describe("視差オクルージョンマッピングを使うか。terrainMatFlags bit1。重い。"),
    macro: z.boolean().optional().describe("マクロバリエーションを使うか。terrainMatFlags bit2。"),
    distTiling: z.boolean().optional().describe("距離タイリング低減を使うか。terrainMatFlags bit3。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("terrain_set_layers", a)),
);

reg(
  "dx12_terrain_splat_info",
  "地形スプラットの要約を読む",
  "地形のスプラット(4 層の重みテクスチャ)の要約を返す【読み取り専用】ツール。"
  + "★dx12_terrain_paint / dx12_terrain_autopaint の結果を『絵を見ずに数値で』検証するのに使う。"
  + "coverage[4] は層ごとの平均重み(0..1。4 層の合計はほぼ 1)、dominantRatio[4] はその層が最大だったテクセルの割合。"
  + "grid は gridSize 本の文字列で、grid[z][x] が '0'..'3' = そのセルの支配レイヤー番号"
  + "(z が増えると +Z、x が増えると +X)。point/points を渡すとその【ワールド XZ】座標の正確な重みが samples に返る。"
  + "スプラット未作成なら hasSplat:false と案内だけ返る(まず dx12_terrain_set_layers で割り当てる)。Playing 中も呼べる。",
  {
    ...entityRef,
    gridSize: z.number().int().optional().describe(
      "支配レイヤーの粗いグリッドの一辺(0..32、既定 8)。0 を渡すと grid を返さない(coverage だけ欲しいとき)。"),
    point: v2().optional().describe("[x,z] ワールド座標 1 点の重みを見る。[x,y,z] でも可(y は無視)。"),
    points: z.array(z.array(z.number())).optional().describe(
      "[[x,z],...] 複数点(最大 256)。point と併用すると両方が samples に入る(読み取りなので二重適用の心配は無い)。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  (a) => run(() => engine.call("terrain_splat_info", a)),
);

reg(
  "dx12_terrain_sample",
  "地形の高さ/法線を問い合わせ",
  "地形の高さ・法線・傾きを座標で問い合わせる(読み取り専用)。points:[[x,z],...] を渡すと各点の "
  + "{x,z,height,worldY,normal,slopeDeg,inside} が返る。points 省略なら地形の情報(原点・解像度・worldSize・"
  + "cellSize・boundsXZ・minHeight/maxHeight)だけ返る。"
  + "★木や建物を地形に沿って並べる時の基本: ここで worldY を取って dx12_set_transform の y に入れる。"
  + "slopeDeg が大きい所(急斜面)には置かない、といった判断もこれでできる。",
  {
    ...entityRef,
    points: z.array(z.array(z.number())).optional().describe("[[x,z],...] ワールド座標(最大 512 点)。[x,y,z] でも可(y は無視)。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  (a) => run(() => engine.call("terrain_sample", a)),
);

// ════════════════════════════════════════════════════════════════
//  頂点スカルプト（洞窟・アーチ・岩など、ハイトフィールドで作れない異形。★Editor 限定）
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_sculpt_create",
  "スカルプト素体を作る",
  "彫るための素体メッシュ(box/sphere/plane/cylinder)を作る。岩は sphere、アーチ・柱は cylinder、崖は box が早い。"
  + "★冪等: 同じ name があれば素体は作り直さず(彫った形を失わない)見た目設定だけ更新する。"
  + "subdivisions が細かいほど彫り込めるが重い(16〜24 が使いやすい)。"
  + "地形と違いオーバーハング(せり出し)が作れるのが利点。返り値 {entityId, name, created, vertexCount, triangleCount}。★Editor 限定。",
  {
    name: z.string().optional().describe("エンティティ名(既定 \"Sculpt\")。同名があれば設定更新になる。"),
    primitive: enumOf(SCULPT_PRIMITIVES).optional().describe("素体の形(既定 sphere)。"),
    subdivisions: z.number().int().optional().describe("分割数(既定 16、1..64)。細かいほど彫り込めるが重い。"),
    size: z.number().optional().describe("一辺/直径のローカル長 m(既定 2)。"),
    position: v3().optional().describe("[x,y,z] 配置(既定 [0,0,0])。"),
    uvScale: z.number().optional().describe("UV の倍率(既定 1)。"),
    color: v3().optional().describe("[r,g,b] 0..1 頂点色。"),
    collision: z.boolean().optional().describe("彫った形の MeshShape コライダーを作るか(既定 true)。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("sculpt_create", a)),
);

reg(
  "dx12_sculpt_make_editable",
  "既存モデルを彫れるようにする",
  "既にシーンにあるモデル(MeshRenderer 持ち)から【彫れるコピー】を作る。元の .glb 等には一切書き戻さない。"
  + "全サブメッシュを 1 つに畳んで同じ姿勢の場所に置くので、見た目は重なったまま。"
  + "★冪等: 同名(既定 \"<元の名前>_Sculpt\")の変換結果が既にあればそれを返す(撃ち直しても増えない)。"
  + "CPU 頂点キャッシュを持たないモデルは変換できない(その場合は dx12_sculpt_create で素体から彫る)。"
  + "スキン付きモデルを変換するとボーン追従は落ちる(静的な形として彫る前提)。★Editor 限定。",
  {
    ...entityRef,
    name: z.string().optional().describe("できるエンティティの名前(既定 \"<元の名前>_Sculpt\")。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("sculpt_make_editable", a)),
);

reg(
  "dx12_sculpt_brush",
  "スカルプトを彫る",
  "スカルプトメッシュの頂点をブラシで動かす。position は【ワールド座標】で渡す(dx12_pick / dx12_raycast_precise の "
  + "worldPos をそのまま渡すのが確実)。brush は draw(法線方向に盛る)/pull・push(direction 方向へ引く・押す)/"
  + "smooth(ならす)/flatten(平らに)/pinch(つまむ)/noise(岩肌)/grab(掴んで動かす。grabDelta 必須)。"
  + "symmetryX/Y/Z で左右対称に彫れる(最大 8 個の筆)。"
  + "★radius / strength は【メッシュのローカル単位】= Transform の scale が掛かる前の大きさ。"
  + "★相対操作(撃つたびに彫れる)。トポロジは変わらないのでコライダーも彫った形に追従する。★Editor 限定。",
  {
    ...entityRef,
    brush: enumOf(SCULPT_BRUSHES).optional().describe("ブラシ種別(既定 draw)。"),
    position: v3().optional().describe("[x,y,z] ブラシ中心(ワールド)。localPosition と排他。どちらか必須。"),
    localPosition: v3().optional().describe("[x,y,z] ブラシ中心(メッシュのローカル空間)。position と排他。"),
    radius: z.number().optional().describe("ブラシ半径(ローカル単位。既定 0.5)。"),
    strength: z.number().optional().describe("1 回ぶんの適用量(既定 0.2)。"),
    falloff: z.number().optional().describe("縁のぼかし 0..1(既定 0.5)。"),
    direction: v3().optional().describe("[x,y,z] pull/push が押し引きする向き(ワールド)。省略時は法線方向。"),
    grabDelta: v3().optional().describe("[x,y,z] brush:grab の移動量(ワールド)。grab では必須。"),
    symmetryX: z.boolean().optional().describe("X ミラー対称。"),
    symmetryY: z.boolean().optional().describe("Y ミラー対称。"),
    symmetryZ: z.boolean().optional().describe("Z ミラー対称。"),
    noiseFrequency: z.number().optional().describe("brush:noise の周波数(既定 1.5)。"),
    noiseOctaves: z.number().int().optional().describe("brush:noise のオクターブ(1..8)。"),
    noiseRidged: z.number().optional().describe("brush:noise の尾根っぽさ 0..1。"),
    seed: z.number().int().optional().describe("brush:noise のシード。"),
  },
  { idempotentHint: false },
  (a) => run(() => engine.call("sculpt_brush", a)),
);

// ════════════════════════════════════════════════════════════════
//  ライティング
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_list_lights",
  "ライト一覧と灯数バジェット",
  "シーンのライトを種別・色・強度・range・コーン角・影の有無つきで列挙する。"
  + "★同時に【GPU へ送れる灯数の上限に対する使用数】と超過警告を返すのが本命。"
  + "クラスタードライティング(Forward+)なので点/スポットに個別上限は無く【合計 1024 灯】まで置ける"
  + "(ただし画面を割ったクラスタ 1 マスあたりは 128 灯まで。密集して超えた所は無言で切り捨て)。"
  + "【影が落ちるのは spot 4 / point 2 のまま】＝灯数の上限が消えても影の上限は消えていないので注意。"
  + "上限を超えた分は【無言で描画されない】ので、『ライトを置いたのに暗い』の原因はほぼこれ。"
  + "各ライトの overBudget / effective を見れば、どれが効いていないか一目で分かる。"
  + "平行光(太陽)は先頭 1 灯だけが有効。limit/cursor でページングできる(既定 50 件)。",
  {
    limit: z.number().int().optional().describe("1 回に返す件数(既定 50、1..200)。"),
    cursor: z.number().int().optional().describe("続きを取るときに前回の nextCursor を渡す。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ limit, cursor }) => run(() => engine.call("list_lights", { limit, cursor })),
);

reg(
  "dx12_set_sun",
  "太陽(平行光)を設定",
  "シーンの太陽(最初の DirectionalLight)の向き・色・強度・環境光を【絶対値で】設定する(冪等)。"
  + "timeOfDay(0..24)を渡すと向き・色・強度・環境光を時刻カーブで一括決定する(エディタのスライダや "
  + "Lua の Lighting.setTimeOfDay とまったく同じカーブ)。方位/高度で直接指定するなら azimuth / elevation。"
  + "★azimuth / elevation は【太陽が見える方向】(方位: +Z が 0°、+X が 90° / 高度: 0=地平線、90=真上)。"
  + "色は color:[r,g,b] か kelvin(色温度 1000..40000K。電球色 2900 / 昼白色 5600)。"
  + "timeOfDay と個別指定を同時に渡すと、時刻で決めた値の上に個別指定が乗る。",
  {
    timeOfDay: z.number().optional().describe("0..24 の時刻。向き/色/強度/環境光をまとめて決める。"),
    azimuth: z.number().optional().describe("方位角(度)。+Z が 0°、+X が 90°。"),
    elevation: z.number().optional().describe("高度角(度)。0=地平線、90=真上(-89..89)。"),
    color: v3().optional().describe("[r,g,b] 0..1。kelvin より優先。"),
    kelvin: z.number().optional().describe("色温度 K(1000..40000)。2900=電球色 / 5600=昼白色 / 7800=曇天。"),
    intensity: z.number().optional().describe("光の強さ(0..100)。"),
    ambient: z.number().optional().describe("この光が供給する環境光(影部分の明るさ。0..5)。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("set_sun", a)),
);

reg(
  "dx12_apply_lighting_preset",
  "ライティング・プリセット適用",
  "太陽 + ポストプロセスをまとめて『それらしい絵』に振る(冪等)。エディタの「ライティング」窓のプリセットと"
  + "【同じ実装・同じ値】なので、AI が触った結果と人が押した結果が一致する。"
  + "day=真上から白い光 / dusk=低いオレンジ+強めのブルーム / night=青白い弱い光+低い環境光 / "
  + "indoor=電球色の斜め光+環境光多め / horror=ほぼ真っ暗+冷たい薄明かり+強いビネット / studio=均一なニュートラル光。"
  + "まずこれで土台を作ってから dx12_set_sun / dx12_set_post_process で詰めるのが速い。"
  + "太陽(平行光)が無いシーンではポストだけ適用される。",
  {
    preset: enumOf(LIGHTING_PRESETS).describe("プリセット名。"),
  },
  { idempotentHint: true },
  ({ preset }) => run(() => engine.call("apply_lighting_preset", { preset })),
);

// ════════════════════════════════════════════════════════════════
//  エンジン診断（「壊れてないか」を 1 発で聞く口）
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_diagnose",
  "エンジン診断(機械可読)",
  "『いま何か壊れてないか？』を 1 回で聞くツール。シェーダーの作り忘れ・壊れたテクスチャ・法線マップが sRGB・"
  + "参照切れアセット(scene_assets: モデル/テクスチャ/マテリアル/シェーダに加えて音声・UI画像・フォント・パーティクル・.uianim/.spranim/.animfsm/.prefab・環境マップ・LUT・デカールアトラスまで見る。アセットを移動/削除しても参照は自動更新されないので、その後は必ずこれを撃つこと)・ライトの上限超過・地形の .hf 不整合・ピッキングが破綻する条件・インスタンシングの不適格理由・"
  + "エンティティ名参照の切れ(entity_refs: Lua の entity プロパティ / Trigger の絞り込み・相手。"
  + "これらは名前の文字列で相手を指すので、指し先を消すとファイルは何も欠けないまま黙って切れる＝"
  + "scene_assets では捕まらない。同名が複数あって『どちらを指すか決まらない』状態も出す。"
  + "エンティティを消した/リネームした後はこれを撃つこと)・"
  + "Lua の閉じ忘れ・DXR(dxr: ケーパビリティと加速構造、RT 影/RT-AO の設定矛盾)、を検査して JSON で返す。"
  + "★シーンビューやゲームビューが真っ暗 / カメラが何も映さないときは only:[\"render_health\"] を撃つこと"
  + "(render_debug の出しっぱなし・露出0・ティント黒・光源ゼロ・シーン矩形の潰れ・SRV ヒープ枯渇・"
  + "カメラの NaN や極端な座標・MCP のカメラ乗っ取り残り、を名指しする。速い)。"
  + "★判定は summary.errors > 0 だけを見ればよい(注意/情報は失敗ではない)。各 issue は日本語 1 行で次の一手が書いてある。"
  + "fast:true か only で重い検査(textures/models = assets 全走査で数十秒)を外せる。"
  + "instancing は 1 度も描画していないと測れない(skipped に理由が入る)。",
  {
    only: z.array(z.string()).optional().describe(
      `実行する検査 ID の配列。省略で全検査。有効値: ${DIAG_CHECKS.join(", ")}`),
    fast: z.boolean().optional().describe("true で重い検査(textures/models)を外して数秒で返す。only 指定時は無視。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ only, fast }) =>
    run(() => {
      const normalized = normalizeDiagnoseOnly(only);
      const target = normalized !== "" ? normalized : (fast ? fastDiagnoseOnly() : "");
      // 重い検査を含むときだけ長いタイムアウトを使う(既定 180s は待たせすぎなので短縮する)。
      const heavy = target === "" || target.includes("textures") || target.includes("models");
      return engine.call("diagnose", { only: target }, heavy ? undefined : { timeout: 30000 });
    }),
);

// ════════════════════════════════════════════════════════════════
//  品質判断系（絵を「見る」だけでなく「測る」ための道具）
// ════════════════════════════════════════════════════════════════
//
// dx12_ui_compare が UI の「形」を横並びで見せる担当なのに対し、ここは
//   ① dx12_look_compare  … 3D の「光」を数値化して参照画像との差を EV / K / 倍率で言う
//   ② dx12_camera_path   … 静止画では分からない時間方向のアラ(ゴースト/ポップ/ちらつき)を拾う
//   ③ dx12_scene_write   … 1 体 1 フレームの spawn を捨ててシーン JSON ごと差し替える
// が担当する。①②は【エンジン側の既存 method の組み合わせだけ】で作ってある(再ビルド不要)。

// ★どちらの絵を測るか。既定は "final"(バックバッファ＝ポスト適用後の最終画)。
//   "sceneRT" は従来どおりポスト前。ポストの化粧を剥がして幾何/ライティングだけ見たいとき用。
//   zod スキーマは毎回新規インスタンスを作る($ref 回避の流儀)。
const CAPTURE_SOURCES = ["final", "sceneRT"] as const;
type CaptureSource = (typeof CAPTURE_SOURCES)[number];
const captureSourceSchema = () =>
  z.enum(CAPTURE_SOURCES).optional().describe(
    "測る絵をどちらから撮るか。'final'(既定)=バックバッファ(ポスト適用後の最終画。人間が見ている絵と同一。"
    + "グレーディング/ブルーム/ビネット/LUT/FXAA/TAA 解決が全部乗る) / "
    + "'sceneRT'=ポスト前のシーン RT(ポストの化粧を剥がして幾何とライティングの素の値だけ見たいとき)。");

// エンジンの screenshot / screenshot_final は path 省略時、毎回 CWD の同じファイルへ上書きする。
// 連写するときは【次の撮影前に】必ず読み切ること(下の撮影ヘルパは即 readFileSync している)。
//
// ★settleFrames について:
//   sceneRT 側は step_frames で先に進めてから撮る(従来どおり)。final 側も同じ扱いにする。
//   engine の {deterministic:true, settleFrames} は「履歴を捨ててから固定 N フレーム」なので
//   意味が違う(ピクセル完全再現用)。ここでは「収束を待つ」だけが欲しいので step_frames を使う。
async function captureScene(
  settleFrames?: number, source: CaptureSource = "final",
): Promise<{ buf: Buffer; width: number; height: number; source: string; postApplied?: boolean }> {
  if (settleFrames && settleFrames > 0) await engine.call("step_frames", { frames: settleFrames });
  const method = source === "sceneRT" ? "screenshot" : "screenshot_final";
  const shot = await engine.call(method, {});
  if (!shot || !shot.path) throw new Error(`${method} が path を返さなかった`);
  return {
    buf: fs.readFileSync(shot.path), width: shot.width, height: shot.height,
    source: shot.source ?? (source === "sceneRT" ? "sceneRT(pre-post)" : "backbuffer"),
    postApplied: shot.postApplied,
  };
}

function readReference(referencePath: string): Buffer {
  if (!fs.existsSync(referencePath)) {
    throw argError(
      `参照画像が見つからない: ${referencePath}`,
      "referencePath は【絶対パス】の PNG。ユーザーから貰った実写写真や参考ゲームのスクショを指す",
    );
  }
  return fs.readFileSync(referencePath);
}

// ── ① 参照画像との「絵づくり」比較（測光つき）─────────────────
regRaw(
  "dx12_look_compare",
  {
    title: "参照画像との絵づくり比較(測光)",
    description:
      "参照画像(実写写真 / 参考ゲームのスクショ)と現在のシーンビューを横並び 1 枚に合成し、"
      + "★さらに『どのノブをどっちへ何倍動かせばいいか』を数値で返す。リアル系ライティングを詰める本体はこれ。"
      + "返す数値: 対数輝度ヒストグラム(既定 24 ビン)とその EMD、平均/中央輝度、コントラスト(対数輝度の標準偏差と P5–P95)、"
      + "相関色温度 CCT(McCamy 近似)、平均彩度(HSV S と CIELAB C*)、黒潰れ率 / 白飛び率。"
      + "suggestions に『参照より平均輝度が -0.8EV 暗い → 太陽の intensity を ×1.74』の形で具体的な次の一手が入る。"
      + "★使い方: suggestions のとおりノブを 1 つだけ動かして撮り直す、を繰り返す(同時に触ると何が効いたか分からない)。"
      + "★★測っているのは既定で dx12_screenshot_final(バックバッファ＝ポスト適用後の最終画)なので、"
      + "ライト・環境光・材質・IBL・影・SSAO に加えて post のグレーディング(contrast/saturation/warmth/tint)・"
      + "ブルーム・ビネット・LUT・FXAA・TAA 解決まで【全部反映される】= 人間が見ている絵と同じものを測る。"
      + "source:'sceneRT' にするとポスト前のシーン RT を測る(ポストの化粧を剥がして幾何とライティングだけ見たいとき。"
      + "そのときはポストのノブが数値に効かないので suggestions に但し書きが付く)。"
      + "position/target を渡すとその視点へカメラを動かしてから撮る(★Play 中も可。撮影後もカメラは固定されたままなので、"
      + "ゲームカメラへ返すには dx12_set_editor_camera {release:true})。",
    inputSchema: {
      referencePath: z.string().describe("参照画像(PNG)の絶対パス。実写写真や参考ゲームのスクショ。"),
      source: captureSourceSchema(),
      position: v3().optional().describe("撮影カメラ位置 [x,y,z]。省略で現在のカメラのまま。"),
      target: v3().optional().describe("注視点 [x,y,z]。position と併用。"),
      gameView: z.boolean().optional().describe(
        "true でアクティブな CameraComponent(ゲームカメラ)視点で撮る。position/target は無視。"
        + "★これは screenshot_game_view = 常に【ポスト前】のシーン RT なので source は無視され、ポストのノブは測れない。"
        + "ポスト込みのゲーム画面を測りたいなら dx12_play してから gameView なしで呼ぶこと(Playing 中の最終画はゲームカメラの絵そのもの)。"),
      settleFrames: z.number().int().optional().describe("撮る前に進めるフレーム数(0..60)。TAA / 露出順応を収束させたい時に 4〜8。既定 0。"),
      bins: z.number().int().optional().describe("対数輝度ヒストグラムのビン数(8..64)。既定 24。"),
      minEV: z.number().optional().describe("ヒストグラム下限 EV。既定 -10(相対輝度 2^-10)。"),
      maxEV: z.number().optional().describe("ヒストグラム上限 EV。既定 0(相対輝度 1.0 = 白)。"),
      blackLevel: z.number().int().optional().describe("黒潰れ判定の luma 閾値(sRGB 0..255、以下を潰れと数える)。既定 4。"),
      whiteLevel: z.number().int().optional().describe("白飛び判定の luma 閾値(sRGB 0..255、以上を飛びと数える)。既定 250。"),
      diffThreshold: z.number().optional().describe("画素差分率の RGB 距離閾値。既定 30(dx12_ui_compare と同じ)。"),
    },
    annotations: { title: "参照画像との絵づくり比較(測光)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ referencePath, source, position, target, gameView, settleFrames, bins, minEV, maxEV, blackLevel, whiteLevel, diffThreshold }) => {
    try {
      const ref = readReference(referencePath);
      // ★gameView(screenshot_game_view)だけは常にポスト前のシーン RT。エンジンに
      //   「ゲームカメラ視点のバックバッファ」を撮る method が無いため、ここは source を無視する。
      const src: CaptureSource = gameView ? "sceneRT" : ((source as CaptureSource | undefined) ?? "final");
      const postVisible = src === "final";
      let cur: Buffer;
      let measuredOn: string;
      if (gameView) {
        if (settleFrames && settleFrames > 0) await engine.call("step_frames", { frames: settleFrames });
        const shot = await engine.call("screenshot_game_view", {});
        if (!shot || !shot.path) throw new Error("screenshot_game_view が path を返さなかった");
        cur = fs.readFileSync(shot.path);
        measuredOn = "screenshot_game_view(ゲームカメラ視点のシーン RT。★ポスト前)";
      } else {
        if (position) await engine.call("set_editor_camera", { position, target });
        const shot = await captureScene(settleFrames, src);
        cur = shot.buf;
        measuredOn = postVisible
          ? `screenshot_final(バックバッファ = ポスト適用後の最終画。postApplied=${shot.postApplied})`
          : "screenshot(シーン RT を CPU で 露出→トーンマップ→ガンマ した絵。★ポスト前)";
      }

      const r = compareLook(ref, cur, { bins, minEV, maxEV, blackLevel, whiteLevel, diffThreshold, postVisible });
      const outPath = path.join(os.tmpdir(), `dx12_look_compare_${Date.now()}.png`);
      fs.writeFileSync(outPath, r.compositePng);
      return imageResult(outPath, {
        diffRatio: Number(r.diffRatio.toFixed(2)),
        reference: roundStats(r.reference),
        current: roundStats(r.current),
        delta: roundDelta(r.delta),
        suggestions: r.suggestions,
        cctFormula: "McCamy 1992: n=(x-0.3320)/(0.1858-y), CCT=449n^3+3525n^2+6823.3n+5520.33"
          + "（黒体軌跡からの距離 Duv > 0.05 なら CCT は null。理由は cctNote）",
        measuredOn,
        notReflected: postVisible
          ? null   // 最終画なので「映らないもの」は無い(ImGui のパネル/ギズモだけ)
          : "post のグレーディング(contrast/brightness/saturation/warmth/hueShift/tint)・"
            + "ブルーム・ビネット・グレインはこの絵に映らない。測りながら追い込むなら source:'final' で呼び直すこと。",
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── ② カメラを動かして連写 → コンタクトシート ────────────────
regRaw(
  "dx12_camera_path",
  {
    title: "カメラを動かして連写(コンタクトシート)",
    description:
      "カメラを経路に沿って動かしながら N 枚撮り、格子状の 1 枚(コンタクトシート)にして返す。"
      + "★静止画 1 枚では TAA のゴースト・LOD ポップ・影のちらつき・カリング抜けが分からない。動かして初めて出る。"
      + "★★撮るのは既定で dx12_screenshot_final(バックバッファ)。TAA の【解決結果】はポスト前のシーン RT には出ないので、"
      + "ゴーストを探すならこちらでないと見えない。source:'sceneRT' でポスト前に切り替えられる"
      + "(ゴーストがポストのせいか本体のせいかを切り分けたいとき)。"
      + "各タイルに『何枚目/全体』を焼き込み、連続フレーム間の画素差分率 frameDiffs(%) も返すので、"
      + "『4→5 だけ差分 18%』のように目で探す前に当たりを付けられる(周りが 3% 前後なのに 1 箇所だけ跳ねていたらポップかちらつき)。"
      + "mode:'line' は from → to を直線補間、mode:'orbit' は target を中心に radius/height の円周を回る。"
      + "★Play 中も使える(dx12_set_editor_camera が Play 中のカメラを固定できるようになったため)。"
      + "撮り終わったら元のカメラへ戻す(restore:false で戻さない)。Play 中に使った後は dx12_set_editor_camera {release:true} でゲームカメラへ返すこと。",
    inputSchema: {
      mode: z.enum(["line", "orbit"]).optional().describe("'line'=直線移動(既定) / 'orbit'=注視点まわりを周回。"),
      source: captureSourceSchema(),
      frames: z.number().int().optional().describe("撮影枚数(2..24)。既定 6。多いほど遅い(1 枚につき 2 往復 + 1 フレーム)。"),
      columns: z.number().int().optional().describe("格子の列数(1..8)。既定 3。"),
      from: v3().optional().describe("line: 始点カメラ位置 [x,y,z]。"),
      to: v3().optional().describe("line: 終点カメラ位置 [x,y,z]。"),
      fromTarget: v3().optional().describe("line: 始点の注視点。省略時は target を使う。"),
      toTarget: v3().optional().describe("line: 終点の注視点。省略時は target を使う。"),
      target: v3().optional().describe("共通の注視点。line では固定注視点、orbit では周回の中心(必須)。dx12_get_bounds の center が使える。"),
      radius: z.number().optional().describe("orbit: 中心からの水平距離(必須、> 0)。被写体の大きさは dx12_get_bounds で測る。"),
      height: z.number().optional().describe("orbit: 中心からの高さオフセット。既定 0。見下ろしたいなら +。"),
      startAngleDeg: z.number().optional().describe("orbit: 開始方位角(度)。+Z が 0°、+X が 90°(dx12_set_sun の azimuth と同じ)。既定 0。"),
      endAngleDeg: z.number().optional().describe("orbit: 終了方位角(度)。既定 360(1 周。全周時は終端が始端と重ならないよう自動で詰める)。"),
      settleFrames: z.number().int().optional().describe("各カットで撮る前に進めるフレーム数(0..60)。既定 0(★TAA のゴーストを見たいなら 0 のまま)。"),
      tileWidth: z.number().int().optional().describe("タイル 1 枚の幅 px。既定 min(元画像幅, 480)。"),
      diffThreshold: z.number().optional().describe("連続フレーム差分の RGB 距離閾値。既定 30。"),
      restore: z.boolean().optional().describe("false で撮影後にカメラを元へ戻さない。既定 true。"),
    },
    annotations: { title: "カメラを動かして連写(コンタクトシート)", openWorldHint: false, idempotentHint: true },
  },
  async (a) => {
    try {
      const poses = planCameraPath({
        mode: a.mode as PathMode | undefined,
        frames: a.frames,
        from: a.from, to: a.to, fromTarget: a.fromTarget, toTarget: a.toTarget,
        target: a.target, radius: a.radius, height: a.height,
        startAngleDeg: a.startAngleDeg, endAngleDeg: a.endAngleDeg,
      });

      const settle = Math.max(0, Math.min(60, Math.round(a.settleFrames ?? 0)));
      const restore = a.restore !== false;
      // 元のカメラを覚えておく(撮影は「見に行く」操作なので、勝手に視点を変えたまま返さない)。
      const before = restore ? await engine.call("get_editor_camera", {}).catch(() => null) : null;

      const src: CaptureSource = (a.source as CaptureSource | undefined) ?? "final";
      const shots: Buffer[] = [];
      let measuredOn = "";
      for (const p of poses) {
        await engine.call("set_editor_camera", { position: p.position, target: p.target });
        const shot = await captureScene(settle, src);   // ★次の撮影で上書きされる前に読み切る
        measuredOn = shot.source;
        shots.push(shot.buf);
      }

      if (before && before.position) {
        await engine.call("set_editor_camera", {
          position: before.position, yawDeg: before.yawDeg, pitchDeg: before.pitchDeg,
        }).catch(() => { /* 戻せなくても撮影結果は返す */ });
      }
      // Play 中に set_editor_camera を撃つとゲームカメラの追従が止まる(override)。
      // 上の復元自体が override を立て直すので、最後に必ず返す。
      // 忘れるとカメラが最後のポーズに固定され「ゲームが何も映さない」になる。
      if (before && before.overridden === false) {
        await engine.call("set_editor_camera", { release: true })
          .catch(() => { /* 返せなくても撮影結果は返す */ });
      }

      const sheet = buildContactSheet(shots, {
        columns: a.columns, tileWidth: a.tileWidth, diffThreshold: a.diffThreshold,
      });
      const outPath = path.join(os.tmpdir(), `dx12_camera_path_${Date.now()}.png`);
      fs.writeFileSync(outPath, sheet.sheetPng);
      return imageResult(outPath, {
        mode: a.mode ?? "line",
        source: src,
        measuredOn,
        frames: shots.length,
        columns: sheet.columns,
        rows: sheet.rows,
        tile: sheet.tile,
        frameDiffs: sheet.frameDiffs,
        maxDiff: sheet.maxDiff,
        poses: poses.map((p) => ({ position: p.position.map((v) => Number(v.toFixed(3))), target: p.target })),
        note: "frameDiffs[i] は フレーム i+1 → i+2 の画素差分率(%)。カメラ移動量に比例するので、"
            + "周囲より突出した山だけがちらつき/ポップの候補。"
            + (src === "final"
                ? "★最終画(ポスト後)で撮っているので TAA の解決結果・グレーディング・ブルームも差分に乗る。"
                  + "デバンドのディザ/グレインは ±1〜2 LSB なので既定の閾値 30 では拾わない。"
                : "★ポスト前のシーン RT で撮っているので TAA の解決結果は差分に出ない。"),
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── ③ シーン JSON の直接書き出し ─────────────────────────────
// assets ディレクトリは【エンジンが dx12_ping で返す】(protocolVersion 4 以降。
// PathResolver::AssetsDir をそのまま載せている)。引数 → 環境変数 → ping の順で解決する。
//
// ★以前はここで get_log を 500 行引いて「ログに混ざる絶対パスから assets らしき祖先を推定し、
//   list_scenes の相対パスが実在するかで裏取りする」という回避コードを持っていた(#20-3)。
//   別プロジェクトの古いログを掴む・ログが流れていると失敗する・裏取りできない時は
//   当てずっぽうを返す、という三重に不確かなものだった。エンジンが正を返すようになったので削除。
async function resolveAssetsDir(explicit?: string): Promise<{ dir: string; how: string }> {
  const ok = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
  const norm = (d: string) => d.replace(/\\/g, "/").replace(/\/+$/, "");

  if (explicit) {
    const d = norm(explicit);
    if (!ok(d)) throw argError(`assetsDir が存在しない: ${explicit}`, "プロジェクトの assets フォルダの絶対パスを渡す");
    return { dir: d, how: "引数 assetsDir" };
  }
  const env = process.env.DX12_ASSETS_DIR;
  if (env && ok(norm(env))) return { dir: norm(env), how: "環境変数 DX12_ASSETS_DIR" };

  // エンジンに聞く(唯一の正)。protocolVersion 4 未満のエンジンは assetsDir を返さない。
  const pong = await engine.call("ping", {}).catch(() => null);
  const fromEngine = typeof pong?.assetsDir === "string" ? norm(pong.assetsDir) : "";
  if (fromEngine && ok(fromEngine)) return { dir: fromEngine, how: "dx12_ping の assetsDir(エンジンが返す正)" };

  throw argError(
    fromEngine
      ? `エンジンが返した assetsDir が存在しない: ${fromEngine}`
      : "assets ディレクトリを特定できなかった"
        + (pong ? `(エンジンの protocolVersion=${pong.protocolVersion ?? "不明"}。4 未満は assetsDir を返さない)` : "(エンジンに繋がらない)"),
    "assetsDir にプロジェクトの assets フォルダの絶対パス(例 C:/Users/me/game/MyGame/assets)を渡すか、"
    + "path 自体を絶対パスで渡す。環境変数 DX12_ASSETS_DIR でも指定できる",
  );
}

regRaw(
  "dx12_scene_write",
  {
    title: "シーンJSONを直接書き出す",
    description:
      "シーン JSON をファイルへ直接書く。★MCP で 1 体ずつ spawn すると【1 体につき 1 フレーム】かかる(遅延同期)ため、"
      + "数十体以上を一気に並べるならこちらが桁違いに速い。書いた後 open:true で dx12_open_scene まで一気にやれる。"
      + "★書く前に検証する: entities 配列の有無、name / transform / parent(=配列インデックス)の型、"
      + "primitive の値、meshRenderer.modelPath と luaScript.scriptPath の【実在確認】(dx12_list_assets 突き合わせ)、"
      + "親子の循環、そして『エンジンが無言で無視するキー名の打ち間違い』(例 meshrenderer / rotate)。"
      + "エラーが 1 つでもあれば書かずに理由を全部返す(壊れた JSON を黙って置かない)。"
      + "既存ファイルを上書きする場合は必ず先に読んで、上書き前のエンティティ数などの要約 replaced と、"
      + "%TEMP% に取ったバックアップ backupPath を返す(何を壊したか分かるように)。"
      + "スキーマは src/scene/SceneSerializer.cpp と同じ: "
      + "{version:1, entities:[{name, transform:{position,rotation,scale}, parent?:<配列index>, "
      + "primitive?:'box'|'sphere'|'plane' | meshRenderer:{modelPath}, color?:[r,g,b], material?:{metallic,roughness}, "
      + "pointLight?/directionalLight?/spotLight?/camera?/rigidBody?/boxCollider?/luaScript?:{scriptPath,props}, tags?:[...]}], "
      + "postProcess?, skybox?, ssao?, shadows?}",
    inputSchema: {
      path: z.string().describe("書き出し先。assets 相対(推奨、例 'scenes/level1.json')か絶対パス。dx12_open_scene が開けるのは assets 配下の .json だけ。"),
      sceneJson: z.union([z.record(z.any()), z.string()]).describe("シーン JSON 本体(オブジェクト、または その JSON 文字列)。{version:1, entities:[...]}"),
      assetsDir: z.string().optional().describe("assets フォルダの絶対パス。省略時は 環境変数 DX12_ASSETS_DIR → dx12_ping の assetsDir(エンジンが返す正) の順で自動解決する。"),
      open: z.boolean().optional().describe("true で書いた後に dx12_open_scene して読み込む(★Editor 限定)。既定 false。"),
      overwrite: z.boolean().optional().describe("false にすると既存ファイルがある場合に書かずにエラー。既定 true(上書きするが要約とバックアップを返す)。"),
      skipAssetCheck: z.boolean().optional().describe("true で modelPath/scriptPath の実在確認を省く(これから import するアセットを先に書く時)。既定 false。"),
      force: z.boolean().optional().describe("true で検証エラーがあっても書く。★壊れたシーンができるので通常は使わない(エラーは返り値に残る)。既定 false。"),
    },
    annotations: { title: "シーンJSONを直接書き出す", openWorldHint: false, destructiveHint: true },
  },
  async ({ path: outPath, sceneJson, assetsDir, open, overwrite, skipAssetCheck, force }) =>
    run(async () => {
      // 1) JSON 本体を確定(文字列なら parse。ここで壊れていたら位置つきで返す)
      let root: unknown;
      if (typeof sceneJson === "string") {
        try {
          root = JSON.parse(sceneJson);
        } catch (e: any) {
          throw argError(`sceneJson が JSON として読めない: ${e.message}`, "オブジェクトのまま渡すのが確実");
        }
      } else {
        root = sceneJson;
      }

      // 2) 書き出し先の絶対パスと assets 相対パスを決める
      const isAbs = path.isAbsolute(outPath) || /^[A-Za-z]:[\\/]/.test(outPath);
      let absPath: string;
      let dir: string;
      let how: string;
      let relPath: string | null;
      if (isAbs) {
        absPath = path.resolve(outPath).replace(/\\/g, "/");
        const derived = assetsDirFromScenePath(absPath);
        if (assetsDir || !derived) {
          const r = await resolveAssetsDir(assetsDir);
          dir = r.dir; how = r.how;
        } else {
          dir = derived; how = "path から推定(.../assets/ を検出)";
        }
        const rel = path.relative(dir, absPath).replace(/\\/g, "/");
        relPath = rel.startsWith("..") ? null : rel;
      } else {
        const chk = checkScenePath(outPath.replace(/\\/g, "/"));
        if (!chk.ok) throw argError(chk.error!, "assets 相対の .json パスにする(例 'scenes/level1.json')");
        const r = await resolveAssetsDir(assetsDir);
        dir = r.dir; how = r.how;
        relPath = outPath.replace(/\\/g, "/");
        absPath = path.join(dir, relPath).replace(/\\/g, "/");
      }
      if (open && !relPath) {
        throw argError(
          `open:true だが ${absPath} は assets(${dir}) の外にある`,
          "dx12_open_scene は assets 相対パスしか受けない。assets 配下へ書くか open:false にする",
        );
      }

      // 3) 検証(参照アセットはエンジンの list_assets と突き合わせる)
      let knownAssets: string[] | undefined;
      if (!skipAssetCheck) {
        const list = await engine.call("list_assets", {}).catch(() => null);
        if (Array.isArray(list)) knownAssets = list.map((a: any) => String(a?.path ?? "")).filter(Boolean);
      }
      const validation = validateSceneJson(root, { knownAssets });
      if (!validation.ok && !force) {
        const e: any = new Error(
          `シーン JSON の検証で ${validation.errors.length} 件のエラー。書き込みは行っていない。\n`
          + validation.errors.map((s) => `  - ${s}`).join("\n")
          + (validation.warnings.length > 0
            ? `\n警告 ${validation.warnings.length} 件:\n` + validation.warnings.slice(0, 20).map((s) => `  - ${s}`).join("\n")
            : ""),
        );
        e.code = 2;   // INVALID_PARAM
        e.hint = "上のエラーを直してから撃ち直す。どうしても先に書きたい場合だけ force:true(壊れたシーンになる)";
        throw e;
      }

      // 4) 既存ファイルの要約とバックアップ(何を壊すのかを必ず言う)
      let replaced: Record<string, unknown> | null = null;
      if (fs.existsSync(absPath)) {
        if (overwrite === false) {
          throw argError(
            `${absPath} は既に存在する(overwrite:false)`,
            "上書きしてよいなら overwrite を省く(既定 true)。別名で書くなら path を変える",
          );
        }
        const prevText = fs.readFileSync(absPath, "utf8");
        const backupPath = path.join(os.tmpdir(), `dx12_scene_backup_${Date.now()}_${path.basename(absPath)}`);
        fs.writeFileSync(backupPath, prevText);
        let prevSummary: unknown = null;
        let parseError: string | null = null;
        try { prevSummary = summarizeScene(JSON.parse(prevText)); }
        catch (e: any) { parseError = e.message; }
        replaced = {
          bytes: Buffer.byteLength(prevText),
          backupPath,
          summary: prevSummary,
          parseError,
          note: "上書き前の内容。バックアップは %TEMP% に置いた(assets を汚さないため)",
        };
      }

      // 5) 書き出し(SceneSerializer と同じ 2 スペースインデント)
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const text = JSON.stringify(root, null, 2);
      fs.writeFileSync(absPath, text, "utf8");

      // 6) 任意で開く
      let opened: unknown = null;
      if (open && relPath) opened = await engine.call("open_scene", { path: relPath });

      return {
        path: relPath, absolutePath: absPath, assetsDir: dir, assetsDirResolvedBy: how,
        bytes: Buffer.byteLength(text),
        wrote: validation.summary,
        replaced,
        validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
        opened,
        nextStep: open
          ? "dx12_screenshot / dx12_look_compare で絵を確認する"
          : `読み込むには dx12_open_scene path:"${relPath ?? "(assets 外)"}"`,
      };
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
