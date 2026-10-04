// 編集系(遅延同期): create / spawn / delete / duplicate / open_scene / play / stop
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { GROUP_ORDER, type GroupKey, GROUPS } from "../sceneOrganize.ts";
import path from "node:path";
import { engine, entityId, entityRef, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  編集系(遅延同期)— 本物の結果が【同期で】返る。{queued} は返りません。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_create_entity",
  "エンティティ生成",
  "エンティティを生成する(エディタ専用)。フレーム境界で実処理されるが、Node が完了を待って【本物の {entityId, name, sceneGeneration} を同期で返す】({queued} は返りません)。idempotency_key を付けると、再試行で同じキーが来ても二重生成されず同じ結果が返る。light_*/camera/particle_emitter/trigger は既定パラメータで生成される空エンティティ+コンポーネント(中身は dx12_describe_components 参照)。細かい値は生成後 dx12_set_component / dx12_set_transform で調整する。★ui_* はゲーム内UI: エディタと同じ部品構成で生成(ui_button=背景+ラベル子、ui_toggle=箱+ラベル子)され、応答に entityIds(生成された全id)も付く。親は parent/parentName で明示指定(省略時は最初のCanvas、Canvas不在なら自動生成)。レイアウト調整は set_component の uiRect、構造確認は dx12_ui_tree、見た目確認は dx12_ui_screenshot。",
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
    size: z.number().optional()
      .describe("type:\"plane\" のときの一辺(m)。0/省略で既定。"),
    subdivisions: z.number().int().optional()
      .describe("type:\"plane\" の分割数(既定 1 = 4 頂点の板)。★水/海のカスタムシェーダーを貼るなら上げること。4 頂点のままだと頂点を動かす波が一切出ない。"),
  },
  {},
  ({ type, name, position, parent, parentName, idempotency_key }) =>
    run(() => engine.call("create_entity", { type, name, position, parent, parentName, idempotency_key })),
);

// プリミティブを1コールで生成＋整形する合成ヘルパ(create_entity → set_transform/set_pbr/set_color)。
// create_entity は遅延同期で本物の entityId を返すので、それを使って後段を適用する。
/**
 * 生成したエンティティを規約グループへ入れる。グループのルートが無ければ作る。
 *
 * ★グループのルートは必ず原点・無回転・スケール 1 の空エンティティ。
 *   set_parent はワールド座標を保持しない（子はローカルとして解釈される）ので、
 *   ルートが単位変換でないと**ぶら下げた瞬間に物がワープする**。
 *   ここで作るルートは create_entity(type:"empty") の既定＝原点なので安全。
 */
export async function ensureGroupRoot(group: GroupKey): Promise<number> {
  const rootName = GROUPS[group].root;
  const found = await engine.call("find_entity", { name: rootName });
  if (found?.entityId != null) return found.entityId;
  const made = await engine.call("create_entity", { type: "empty", name: rootName });
  return made.entityId;
}

async function attachToGroup(entityId: number, group?: string): Promise<string | undefined> {
  if (!group) return undefined;
  const key = group.toUpperCase() as GroupKey;
  if (!(key in GROUPS)) return `未知のグループ "${group}"（有効: ${GROUP_ORDER.join(" / ")}）`;
  const parent = await ensureGroupRoot(key);
  await engine.call("set_parent", { entity: entityId, parent });
  return undefined;
}

async function spawnPrimitive(
  type: "box" | "sphere",
  a: { name?: string; position?: number[]; scale?: number[]; rotation?: number[];
       color?: number[]; metallic?: number; roughness?: number; group?: string },
) {
  const r = await engine.call("create_entity", { type, name: a.name, position: a.position });
  const entity = r.entityId;
  if (a.scale || a.rotation)
    await engine.call("set_transform", { entity, scale: a.scale, rotation: a.rotation });
  if (a.metallic != null || a.roughness != null)
    await engine.call("set_pbr", { entity, metallic: a.metallic, roughness: a.roughness });
  if (a.color) await engine.call("set_color", { entity, color: a.color });
  const warn = await attachToGroup(entity, a.group);
  if (warn) r.groupWarning = warn; else if (a.group) r.group = a.group.toUpperCase();
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
    group: z.enum(["ENV", "LVL", "LGT", "GP", "FX", "UI", "CAM"]).optional()
      .describe("入れる規約グループ。LVL=床/壁/足場・ENV=背景装飾・GP=遊びに絡むもの。無ければルートを自動生成して親付けする(位置は変わらない)。"),
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
    group: z.enum(["ENV", "LVL", "LGT", "GP", "FX", "UI", "CAM"]).optional()
      .describe("入れる規約グループ。LVL=床/壁/足場・ENV=背景装飾・GP=遊びに絡むもの。無ければルートを自動生成して親付けする(位置は変わらない)。"),
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
