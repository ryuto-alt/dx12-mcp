// ナビメッシュ(追いかける AI 用の経路探索)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  ナビメッシュ（追いかける AI 用の経路探索）
// ════════════════════════════════════════════════════════════════
// 生成はシーンの描画メッシュを【実際の三角形のまま】ボクセル化する自作パイプライン
// （Recast と同系統: ラスタライズ → フィルタ → コンパクト → 侵食 → 領域分割 → 輪郭 → ポリゴン化）。
// エディタの「ツール > ナビメッシュ」窓と同じ関数を呼ぶので、AI が焼いた結果と人が焼いた結果は一致する。

// 生成パラメータ。build と settings で同じ形を受ける（build は「設定を上書きしてから焼く」）。
const navConfigParams = {
  cellSize: z.number().optional().describe("水平ボクセル辺長 m(0.02..2)。エージェント半径の 1/2〜1/3 が目安。小さいほど正確で遅い。"),
  cellHeight: z.number().optional().describe("垂直ボクセル高さ m(0.01..1)。またげる段差の 1/3 以下にすること。"),
  agentHeight: z.number().optional().describe("エージェントの高さ m。頭上クリアランスがこれ未満の場所は歩行不可。"),
  agentRadius: z.number().optional().describe("エージェント半径 m。壁からこのぶん削る。大きすぎると狭い通路が全部消える。"),
  agentMaxClimb: z.number().optional().describe("またげる段差 m(階段一段)。これを超える高低差は崖として切れる。"),
  agentMaxSlope: z.number().optional().describe("★歩ける最大傾斜(度, 0..89)。坂道の許容角。既定 45。"),
  minRegionArea: z.number().optional().describe(
    "m^2。これより小さい孤立した島は捨てる。★箱や柱のような閉じた立体は「底面と天面の間」に"
    + "頭上クリアランスが空くと内部の床も歩行面として残る(どこからも行けない島になる)。消すには此処を上げる(8〜20 が実用値)。"),
  mergeRegionArea: z.number().optional().describe("m^2。これより小さい領域は隣へ吸収する。経路が素直になる。"),
  maxEdgeLen: z.number().optional().describe("輪郭の辺の最大長 m。0 で無制限。"),
  maxSimplificationErr: z.number().optional().describe("輪郭単純化の許容誤差(ボクセル単位, 既定 1.3)。大きいほどポリゴンが減るが壁に食い込む。"),
  maxVertsPerPoly: z.number().int().optional().describe("1 ポリゴンの最大頂点数(3..12, 既定 6)。"),
  monotonePartition: z.boolean().optional().describe("true で monotone 分割(速いが細長い)。既定 false = 分水嶺(形が良い)。"),
  filterLedgeSpans: z.boolean().optional().describe("崖ぎわを歩行不可にする(既定 true)。切ると AI が崖から落ちる経路を引く。"),
  filterLowHanging: z.boolean().optional().describe("縁石など低い障害物をまたげるようにする(既定 true)。"),
  useBounds: z.boolean().optional().describe("true で boundsMin/Max の範囲だけ焼く。false は全メッシュの AABB。"),
  boundsMin: v3().optional().describe("[x,y,z] 焼く範囲の最小。指定すると useBounds が自動で true になる。"),
  boundsMax: v3().optional().describe("[x,y,z] 焼く範囲の最大。同上。"),
};

const navSearchParams = {
  searchRadius: z.number().optional().describe("指定位置からナビメッシュを探す水平半径 m(既定 max(2, cellSize*8))。"),
  searchHeight: z.number().optional().describe("同じく垂直の許容 m(既定 max(agentHeight*2, 4))。多層フロアで階を取り違えるときは小さくする。"),
};

reg(
  "dx12_navmesh_build",
  "ナビメッシュ生成",
  "シーンのメッシュからナビメッシュを焼く。★AABB ではなく【実際の三角形】をボクセル化するので、"
  + "坂道・階段・斜めの壁がそのままの形で反映される。傾斜(agentMaxSlope)・段差(agentMaxClimb)・"
  + "エージェント半径/高さで通れる場所だけが残る。引数を渡すとシーンの生成設定を上書きしてから焼く"
  + "(設定はシーン JSON の navmesh に保存される)。"
  + "★Editor モード限定(Play 中は Stop で巻き戻るため弾く)。"
  + "★焼いた実体はシーンの隣の .nav。**dx12_save_scene を呼ぶまでディスクには残らない**。"
  + "除外したいメッシュには navMeshIgnore タグを付ける。スキンメッシュ(動くキャラ)は自動で除外される。"
  + "戻り値の stageLog に各段階の件数が出るので、0 になっている段階の直前の設定が原因と分かる。",
  { ...navConfigParams },
  { destructiveHint: true },
  (a) => run(() => engine.call("navmesh_build", a)),
);

reg(
  "dx12_navmesh_settings",
  "ナビメッシュ設定",
  "ナビメッシュの生成パラメータだけを変える(焼き直しはしない)。引数なしで現在値を読める。"
  + "変更後に反映するには dx12_navmesh_build を呼ぶこと。",
  { ...navConfigParams },
  { idempotentHint: true },
  (a) => run(() => engine.call("navmesh_settings", a)),
);

reg(
  "dx12_navmesh_info",
  "ナビメッシュ情報",
  "現在のナビメッシュの統計(ポリゴン数/頂点数/歩行面積/生成時間/メモリ/範囲)と生成設定を返す。"
  + "stats.built=false なら未生成。",
  {},
  { readOnlyHint: true, idempotentHint: true },
  () => run(() => engine.call("navmesh_info", {})),
);

reg(
  "dx12_navmesh_path",
  "経路探索",
  "ナビメッシュ上で from → to の経路を求める。A* でポリゴン列を出し、ファネル(string pulling)で"
  + "通路内の最短折れ線に引き直すので、ポリゴン中心を数珠つなぎにした不自然な形にはならない。"
  + "各点の高さはナビメッシュから引き直すので坂道でも足が浮かない。"
  + "reached=false は「目標へ到達できないので一番近い所までを返した」意味(段差や半径で分断されている)。",
  { from: v3().describe("[x,y,z] 開始位置。"), to: v3().describe("[x,y,z] 目標位置。"), ...navSearchParams },
  { readOnlyHint: true, idempotentHint: true },
  (a) => run(() => engine.call("navmesh_path", a)),
);

reg(
  "dx12_navmesh_sample",
  "ナビメッシュへ落とす",
  "任意の位置を一番近い歩行面へ落とす。onNavMesh=false なら searchRadius/searchHeight の範囲に歩ける場所が無い。"
  + "返る point の高さは高さサンプル格子から引くのでボクセル分解能で正確(坂道でも階段状にならない)。",
  { point: v3().describe("[x,y,z] 調べる位置。"), ...navSearchParams },
  { readOnlyHint: true, idempotentHint: true },
  (a) => run(() => engine.call("navmesh_sample", a)),
);

reg(
  "dx12_navmesh_raycast",
  "ナビメッシュのレイキャスト",
  "from から to へナビメッシュ上を直進し、壁(隣のポリゴンが無い辺)に当たるまでの t と交点/法線を返す。"
  + "★AABB 近似ではなく実際の輪郭の辺との交差＝『そこまで真っ直ぐ行けるか』の精密な判定。"
  + "追跡 AI の『視線が通るか / 経路を張らずに直進できるか』に使う。",
  { from: v3().describe("[x,y,z] 始点(ナビメッシュ上か、その近く)。"),
    to: v3().describe("[x,y,z] 終点。"), ...navSearchParams },
  { readOnlyHint: true, idempotentHint: true },
  (a) => run(() => engine.call("navmesh_raycast", a)),
);

reg(
  "dx12_navmesh_debug",
  "ナビメッシュ可視化",
  "シーンビューに歩行ポリゴンのワイヤを重ねる。明るい線=壁(そこから先へ行けない) / 暗い線=ポリゴン同士のポータル。"
  + "物理デバッグ描画とは独立にトグルできる。シーンには保存されない。"
  + "★MCP のスクショ(dx12_screenshot / dx12_screenshot_final)にも写るので、焼けた形の確認に使える。",
  { enabled: z.boolean().optional().describe("省略で現在値を返すだけ。") },
  { idempotentHint: true },
  (a) => run(() => engine.call("navmesh_debug", a)),
);

reg(
  "dx12_navmesh_clear",
  "ナビメッシュ破棄",
  "焼いたナビメッシュを捨てる。シーンを保存すると隣の .nav も消える。Editor モード限定。",
  {},
  { destructiveHint: true, idempotentHint: true },
  () => run(() => engine.call("navmesh_clear", {})),
);
