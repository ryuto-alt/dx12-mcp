// ハイトフィールド地形 / 地形レイヤー / 頂点スカルプト(Editor 限定)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { normalizeStrokePoints, SCULPT_BRUSHES, SCULPT_PRIMITIVES, TERRAIN_BRUSHES, TERRAIN_PRESETS, v2, v3, v4 } from "../sceneTools.ts";
import { engine, entityRef, reg, run } from "./core.ts";
import { enumOf } from "./pick.ts";

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
