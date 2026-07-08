import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import { EngineClient } from "./engineClient.ts";

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
const server = new McpServer({ name: "dx12-engine", version: "0.5.0" });

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
function errResult(e: any): ToolResult {
  const code = e?.code;
  const msg = code != null ? `エラー(code=${code}): ${e.message}` : `エラー: ${e.message}`;
  return { content: [{ type: "text", text: msg }], isError: true };
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

// JSON ツール登録ヘルパ。openWorldHint は常に false(外部世界とやり取りしない閉じたツール群)。
function reg(
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  ann: Ann,
  handler: (args: any) => Promise<ToolResult>,
) {
  server.registerTool(
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

// ── 共通 zod 部品 ────────────────────────────────────────────────
const vec3 = z.array(z.number()).length(3);
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
  "エディタとの疎通確認。mode(Editor/Playing)・entityCount・sceneGeneration・currentScene・protocolVersion を返す。まず最初に叩いて生きてるか確認するのに使う。",
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
  "エンティティの LuaScript の現在のプロパティ値を全部返す(スキーマ基準なので未上書きの既定値も含む。get_entity は保存済みの上書きしか出さない)。{scriptPath, enabled, started, loadError, properties:[{name,type,value,isOverride}]}。dx12_set_lua_property で変える前の確認に。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_lua_component_state", { entity, name })),
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
    position: vec3.optional().describe("[x,y,z]"),
    rotation: vec3.optional().describe("[x,y,z] Euler 度。quaternion と併用しない。"),
    quaternion: z.array(z.number()).length(4).optional().describe("[x,y,z,w] クォータニオン。rotation と併用しない。"),
    scale: vec3.optional().describe("[x,y,z]"),
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
    component: z.string().describe("jsonKey。例: pointLight, directionalLight, spotLight, camera, rigidBody, boxCollider, transform, tags, data, particleEmitter, trailRenderer, networkIdentity, networkTransform, sprite2d, audioSource, trigger"),
    data: z.union([z.record(z.any()), z.array(z.any())]).describe("コンポーネントの値。オブジェクト or 配列(tags は文字列配列)。dx12_describe_components の fields に合わせる。"),
  },
  { idempotentHint: true },
  ({ entity, name, component, data }) =>
    run(() => engine.call("set_component", { entity, name, component, data })),
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
    color: vec3.describe("[r,g,b] 0..1。例: 金色=[1,0.84,0]"),
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
  "シーンのスカイボックス/IBL を設定する。skybox 内の指定フィールドだけ適用。envMapPath を変えると {applied, envMapRebake} を返し再ベイクが走ることがある。",
  {
    skybox: z.object({
      envMapPath: z.string().optional().describe("環境マップ(HDR/EXR 等)の assets 相対パス。"),
      iblIntensity: z.number().optional().describe("IBL(間接光)の強さ。"),
      skyboxIntensity: z.number().optional().describe("スカイボックス描画の明るさ。"),
      drawSkybox: z.boolean().optional().describe("スカイボックスを描画するか。"),
    }).describe("スカイボックス設定。指定したフィールドのみ適用。"),
  },
  { idempotentHint: true },
  ({ skybox }) => run(() => engine.call("set_scene_settings", { skybox })),
);

reg(
  "dx12_undo",
  "Undo",
  "直前の編集操作を取り消す。フレーム境界で適用され {queuedUndo} を返す(取り消し自体は次フレームで反映)。",
  {},
  {},
  () => run(() => engine.call("undo", {})),
);

reg(
  "dx12_redo",
  "Redo",
  "取り消した操作をやり直す。フレーム境界で適用され {queuedRedo} を返す。",
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
  "エンティティを生成する(エディタ専用)。フレーム境界で実処理されるが、Node が完了を待って【本物の {entityId, name, sceneGeneration} を同期で返す】({queued} は返らへん)。idempotency_key を付けると、再試行で同じキーが来ても二重生成されず同じ結果が返る。light_*/camera/particle_emitter/trigger は既定パラメータで生成される空エンティティ+コンポーネント(中身は dx12_describe_components 参照)。細かい値は生成後 dx12_set_component / dx12_set_transform で調整する。",
  {
    type: z.enum([
      "box", "sphere", "plane", "empty", "camera",
      "light_directional", "light_point", "light_spot",
      "particle_emitter", "trigger",
    ]).describe("種別。empty は Transform のみ。light_*/camera/particle_emitter/trigger は該当コンポーネント付きで生成(値は既定。set_component で調整)。"),
    name: z.string().optional().describe("エンティティ名(一意推奨)。省略時は種別名。"),
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    idempotency_key: z.string().optional().describe("再試行の重複防止キー。同じキーの再送は二重生成されない。"),
  },
  {},
  ({ type, name, position, idempotency_key }) =>
    run(() => engine.call("create_entity", { type, name, position, idempotency_key })),
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
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    scale: vec3.optional().describe("[x,y,z]。足場なら例 [4,0.5,4]。"),
    rotation: vec3.optional().describe("[x,y,z] Euler 度。"),
    color: vec3.optional().describe("[r,g,b] 0..1 基本色。"),
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
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    scale: vec3.optional().describe("[x,y,z]。"),
    rotation: vec3.optional().describe("[x,y,z] Euler 度。"),
    color: vec3.optional().describe("[r,g,b] 0..1 基本色。"),
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
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
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
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
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
  "プレハブ(.prefab)を assets 相対パスから生成する。フレーム境界で実処理され、Node が完了を待って【本物の {entityId, rootEntityId, entityIds:[...], name, sceneGeneration} を同期で返す】。",
  {
    path: z.string().describe("assets 相対パス。例: prefabs/enemy.prefab"),
    position: vec3.optional().describe("[x,y,z]。省略時 [0,0,0]。"),
    name: z.string().optional().describe("ルートエンティティ名。省略時はプレハブ名。"),
  },
  {},
  ({ path, position, name }) =>
    run(() => engine.call("spawn_prefab", { path, position, name })),
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
  "Editor → Playing へ切り替える。フレーム境界で実処理され {mode:'Playing', sceneGeneration} を同期で返す。カメラ無し等で再生不可なら error(code=3 MODE_CONFLICT)。",
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

// ════════════════════════════════════════════════════════════════
//  ランタイム物理検証(raycast/overlap/velocity) — 全て同期・読み取り系。
//  bodies は Play 中のみ登録される(RegisterBody は Play 開始/loadScene 時)。
//  Editor 中に呼んでもエラーにはならず hit=false / entities=[] / velocity=[0,0,0] が返る。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_raycast",
  "レイキャスト",
  "origin から direction 方向へ物理レイを飛ばし、最初にヒットしたボディを調べる。★Playing 中のみ意味のある結果(Editor 中は body 未登録なので hit=false)。{hit, distance?, point?, normal?, entityId?, name?}。normal は現状 常に up 方向の近似値(エンジンの既知の制約)。当たり判定確認・地面/壁の検出・ラインオブサイトの確認に。",
  {
    origin: vec3.describe("[x,y,z] レイの始点。"),
    direction: vec3.describe("[x,y,z] レイの方向(正規化不要。エンジン側で正規化される)。"),
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
    center: vec3.describe("[x,y,z]"),
    halfExtents: vec3.describe("[x,y,z] AABB の半幅。"),
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
    center: vec3.describe("[x,y,z]"),
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
  "ポストプロセスのフィールドを指定分だけ更新する(未指定フィールドは現状維持)。カラーグレーディング(exposure/contrast/brightness/saturation/warmth/hueShift/tint) / ブルーム・ビネット(bloom/bloomThreshold/vignette) / スタイライズ(chromatic/pixelSize/posterize/ditherLevels/scanline/sharpen/grain) / 色操作(invert/sepia/grayscale) / 歪み(lens/waveAmp・Freq・Speed/radial/glitch) / 輪郭(outline/outlineColor) / fxaaOn。各エフェクトは <name>On(bool) で有効化しないと数値を変えても見た目に効かない。先に dx12_get_post_process で現状値を確認するとよい。",
  {
    enabled: z.boolean().optional().describe("マスタースイッチ(false で全エフェクト素通し)。"),
    exposureOn: z.boolean().optional(), exposure: z.number().optional(),
    contrastOn: z.boolean().optional(), contrast: z.number().optional(),
    brightnessOn: z.boolean().optional(), brightness: z.number().optional(),
    saturationOn: z.boolean().optional(), saturation: z.number().optional(),
    warmthOn: z.boolean().optional(), warmth: z.number().optional(),
    hueOn: z.boolean().optional(), hueShift: z.number().optional(),
    tintOn: z.boolean().optional(), tint: vec3.optional(),
    bloomOn: z.boolean().optional(), bloom: z.number().optional(), bloomThreshold: z.number().optional(),
    vignetteOn: z.boolean().optional(), vignette: z.number().optional(),
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
    outlineOn: z.boolean().optional(), outline: z.number().optional(), outlineColor: vec3.optional(),
    fxaaOn: z.boolean().optional(),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("set_post_process", a)),
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
  (a) => run(() => engine.call("set_ssao", a)),
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
  "任意の Lua コードをエンジンの Lua state でその場実行する(強力なデバッグ機能)。globals フォールバック環境なので scene/physics/camera/audio/events 等の既存グローバルバインディング(dx12_describe_lua_api 参照)がそのまま使える。例: `local e = scene:findEntity(\"Player\"); e.transform.position.y = e.transform.position.y + 1; return e.transform.position.y`。code が値を return していれば result にその tostring() 文字列が入る(無ければ空文字)。★print() は捕捉されない — デバッグ出力は log(msg) を使うと dx12_get_log に出る。副作用のある操作(位置変更・物理力印加等)は Editor/Playing 両方で実行できるが、bodies は Play 中のみ登録されているため物理系は Playing 中でないと効果が無い。localhost 限定・認証なしという既存のセキュリティモデルと同水準。",
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
  "dx12_play_anim",
  "アニメーション再生",
  "スケルタルアニメーションのクリップをクロスフェード再生する(Lua の playAnim/playAnimByName と同じ経路)。clipName(名前) か clip(index) で指定、blend はフェード秒(既定 0.3)。loop を渡すとループ設定も変更。クリップ一覧は dx12_get_anim_state で確認。★アニメーションの更新は Play 中に進む。entity(id) か name 指定。",
  {
    ...entityRef,
    clip: z.number().int().optional().describe("クリップ index。clipName と排他(clipName 優先)。省略時 0。"),
    clipName: z.string().optional().describe("クリップ名(完全一致)。dx12_get_anim_state の clips から選ぶ。"),
    blend: z.number().optional().describe("クロスフェード秒。省略で 0.3。"),
    loop: z.boolean().optional().describe("ループ再生するか。省略で現状維持。"),
  },
  {},
  ({ entity, name, clip, clipName, blend, loop }) =>
    run(() => engine.call("play_anim", { entity, name, clip, clipName, blend, loop })),
);

reg(
  "dx12_get_anim_state",
  "アニメーション状態取得",
  "エンティティのスケルタルアニメーション情報を返す。{hasSkeletalAnimation, clips:[名前...]}。dx12_play_anim の clipName/clip を選ぶのに使う。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_anim_state", { entity, name })),
);

// ════════════════════════════════════════════════════════════════
//  マルチプレイヤー(ローカルテストループを AI から回す)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_net_status",
  "ネットワーク状態取得",
  "マルチプレイヤーの現在状態を返す。{available, role(Offline/Host/Client), isConnected, localClientId, tick, syncedEntityCount, players:[{id, rttMs, bytesSent, bytesReceived}], config:{tickRate, snapshotRate, maxPlayers, defaultPort}, testRole, testJoinAddress}。接続確認・RTT/帯域の観測・複製エンティティ数の検証に。",
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
//  合成ツール(エンジンには無い。Node 内で複数 call を順に行う)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_batch",
  "一括実行",
  "複数のエンジン操作を順番に実行して往復を減らす。各 op は engine の method 名(dx12_ 接頭辞なし。例 create_entity)と params。結果は {results:[{index, ok, result?|error?, error_code?, skipped?}]}。stopOnError=true なら最初の失敗で打ち切り、残りは skipped 記録。各 op は同期結果なので確実(ただし1フレーム原子性は無い)。",
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
server.registerTool(
  "dx12_focus_and_screenshot",
  {
    title: "寄せて撮影",
    description: "カメラを対象エンティティに寄せてから(1フレーム描画を挟んで)スクショを撮り、PNG 画像で返す。entity(id) か name 指定。配置や見た目を自分の目で確認するのに使う(エディタカメラ。Playing 中のゲーム画面は dx12_screenshot がアクティブなゲームカメラの絵を返す)。image ブロック + text(path/サイズ)を返す。",
    inputSchema: { ...entityRef },
    annotations: { title: "寄せて撮影", openWorldHint: false, idempotentHint: true },
  },
  async ({ entity, name }) => {
    try {
      await engine.call("focus_camera", { entity, name });
      const shot = await engine.call("screenshot", {});
      if (!shot || !shot.path) throw new Error("screenshot が path を返さんかった");
      return imageResult(shot.path, { entity, width: shot.width, height: shot.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// スクショ単体も画像ブロックで返す。
server.registerTool(
  "dx12_screenshot",
  {
    title: "スクリーンショット",
    description: "今シーンビューに映ってる絵を PNG に書き出して画像で返す(+text に path/width/height)。AI が自分の操作結果(配置・見た目)を目で確認して直すのに使う。引数なし。★Playing 中はアクティブなゲームカメラの絵になる(=実際のゲーム画面)。Editor 中はエディタのフライカメラ。dx12_project_world_to_screen と同じカメラなので「player が画面中央/画面内か」を数値+絵の両方で確認できる。",
    inputSchema: {},
    annotations: { title: "スクリーンショット", openWorldHint: false, readOnlyHint: true },
  },
  async () => {
    try {
      const shot = await engine.call("screenshot", {});
      if (!shot || !shot.path) throw new Error("screenshot が path を返さんかった");
      return imageResult(shot.path, { width: shot.width, height: shot.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ゲームカメラ視点のスクショ。アクティブな CameraComponent でシーンを1フレーム描いて撮る。
// Editor 中でも Play せずにゲームカメラの画角を確認できる(Playing 中は通常 screenshot と同じ絵)。
server.registerTool(
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

const transport = new StdioServerTransport();
await server.connect(transport);
