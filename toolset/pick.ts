// 精密ピッキング / ワールドレイ(三角形単位)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  精密ピッキング / ワールドレイ(三角形単位)
//  エディタのクリック選択とまったく同じ RaycastScene を通すので、
//  「MCP が見たもの」と「エディタで選ばれるもの」がズレない。
// ════════════════════════════════════════════════════════════════

// 列挙は sceneTools.ts の定数から作る(エンジンの enum と 1 箇所で対応付ける)。
export const enumOf = (values: readonly string[]) => z.enum(values as unknown as [string, ...string[]]);

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
