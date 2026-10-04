// ビジュアル/ポスト設定(ポストプロセス / SSAO / SSR / SSGI / TAA / フォグ / PCSS / DXR ほか)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { definedOnly } from "../paramGuard.ts";
import { applyAndVerify, engine, entityRef, reg, run } from "./core.ts";

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
    tonemapper: z.number().int().optional().describe("トーンマッパー: 0=ACES / 1=AgX / 2=なし(ガンマのみ) / 3=UE Filmic(UE 5 の既定の ACES 系。film* で調整) / 4=線形(トーンマップ無し。1 でクリップ) / 5=Khronos PBR Neutral。3〜5 の出力は sRGB OETF(0〜2 は従来どおり pow(1/2.2))。★exposure と共に dx12_screenshot にも反映される(他のグレーディングは反映されない)。"),
    // ── UE Filmic(tonemapper=3)のパラメータ ──
    filmSlope: z.number().optional().describe("UE Filmic の Slope(既定 0.88)。tonemapper=3 のときだけ効く。"),
    filmToe: z.number().optional().describe("UE Filmic の Toe(既定 0.55)。"),
    filmShoulder: z.number().optional().describe("UE Filmic の Shoulder(既定 0.26)。"),
    filmBlackClip: z.number().optional().describe("UE Filmic の Black Clip(既定 0)。"),
    filmWhiteClip: z.number().optional().describe("UE Filmic の White Clip(既定 0.04)。"),
    // ── 露出モード(Q2 校正): 物理単位と組にして使う ──
    exposureMode: z.number().int().optional().describe("露出モード: 0=従来(exposureOn/exposure の乗算と autoExposureOn。絵は従来と不変) / 1=手動 EV100(係数 = 1/(1.2·2^(ev100−evComp))。マスター enabled が OFF でも効く) / 2=自動(ヒストグラム測光。平均輝度を 18% グレー×2^evComp へ適応。上下限は aeMinEv100/aeMaxEv100)。"),
    ev100: z.number().optional().describe("手動露出の EV100(既定 15 = 晴天 Sunny 16。EV100=15 + 補正 0 が露出 0 の基準)。exposureMode=1 のとき。1 上げると 1 段暗い。"),
    evComp: z.number().optional().describe("露出補正 [EV](+ で明るく)。exposureMode 1/2 の両方に効く。"),
    aeMinEv100: z.number().optional().describe("自動露出(exposureMode=2)の EV100 下限(既定 -10)。"),
    aeMaxEv100: z.number().optional().describe("自動露出(exposureMode=2)の EV100 上限(既定 20)。"),
    aeSpeedUp: z.number().optional().describe("シーンが明るくなる方向の適応速度[1/秒]。0 = aeSpeed と同じ。"),
    aeSpeedDown: z.number().optional().describe("シーンが暗くなる方向の適応速度[1/秒]。0 = aeSpeed と同じ。"),
    aeLowPercent: z.number().optional().describe("測光ヒストグラムの下側の除外割合 0..0.99(既定 0)。0..1 = 全画素の対数平均(平均輝度)、0.8..0.983 = UE のヒストグラム測光の既定。"),
    aeHighPercent: z.number().optional().describe("測光ヒストグラムの上側の上限割合(既定 1)。"),
    // ── ライティング単位(シーン設定) ──
    lightingUnits: z.number().int().optional().describe("ライティング単位: 0=従来(点/スポットは saturate(1−d/range)^2。強度は任意単位。絵は従来と不変) / 1=物理(太陽=lux・点/スポット=cd の逆二乗[sourceRadius と range の窓つき]・空/IBL/自己発光=nit。シーン RT の 1.0 = 1 nit。露出は exposureMode=1/2 の EV100 で表示へ変換)。切替はフォワード系 PSO の差し替えで GPU 待ちが 1 回入る。"),
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
    vignetteOn: z.boolean().optional(), vignette: z.number().optional().describe("減光の濃さ 0..1。"),
    vignetteRadius: z.number().optional().describe("減光が始まる正規化半径(中心=0 / 四隅=1)。既定 0.75。上げるほど四隅だけが落ちる。"),
    vignetteSoftness: z.number().optional().describe("境界のぼけ幅。既定 0.45。小さいほどハッキリした縁。"),
    vignetteRoundness: z.number().optional().describe("1=真円 / 0=画面のアスペクト比なりの楕円。既定 1。"),
    vignetteColor: v3().optional().describe("減光先の色。既定 [0,0,0]（黒）。"),
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
    dofBlurSize: z.number().optional().describe("ボケ半径の上限(px)。既定 12。物理モードでは『暴走防止の上限』としてだけ効く。"),
    dofFocusName: z.string().optional().describe("合焦させるエンティティ名(完全一致)。空でなければ毎フレームそのエンティティまでのビュー距離を合焦距離に使う=被写体に合焦したまま寄る/回るが Lua 無しで作れる。"),
    dofAperture: z.number().optional().describe("F 値。既定 2.8(>0 で物理モード: 焦点距離と F 値から錯乱円を出す)。0 以下にすると旧 dofFocusRange 方式へ戻る。"),
    dofFocalLength: z.number().optional().describe("焦点距離(mm)。既定 0 = カメラの FOV から導出(35mm 判・センサ高 24mm 換算)。"),
    // ── カメラモーションブラー(深度再構成方式・velocity buffer 不要) ──
    motionBlurOn: z.boolean().optional().describe("カメラモーションブラー。"),
    mbStrength: z.number().optional().describe("シャッター係数(速度に乗算)。既定 0.5。"),
    mbSamples: z.number().int().optional().describe("タップ数 4..16。既定 10。"),
    chromaticOn: z.boolean().optional(), chromatic: z.number().optional(),
    chromaMode: z.number().int().optional().describe("色収差のずらし方: 0=放射(画面端ほど強い) / 1=水平 / 2=垂直。既定 0。"),
    pixelizeOn: z.boolean().optional(), pixelSize: z.number().optional(),
    posterizeOn: z.boolean().optional(), posterize: z.number().int().optional(),
    ditherOn: z.boolean().optional(), ditherLevels: z.number().int().optional(),
    scanlineOn: z.boolean().optional(), scanline: z.number().optional().describe("走査線の濃さ 0..1。"),
    scanCount: z.number().optional().describe("走査線の本数(画面の縦に何本引くか)。既定 240。"),
    scanCurve: z.number().optional().describe("ブラウン管の画面湾曲の量。既定 0.18。0 で平面(湾曲なし)。"),
    sharpenOn: z.boolean().optional(), sharpen: z.number().optional(),
    grainOn: z.boolean().optional(), grain: z.number().optional(),
    grainSize: z.number().optional().describe("粒の大きさ(px)。既定 1。大きいほど粗い。"),
    grainColored: z.boolean().optional().describe("true=RGB 独立のカラーノイズ / false(既定)=輝度ノイズ。"),
    invertOn: z.boolean().optional(), invert: z.number().optional(),
    sepiaOn: z.boolean().optional(), sepia: z.number().optional(),
    grayscaleOn: z.boolean().optional(), grayscale: z.number().optional(),
    // ── レンズ歪み / 魚眼(縦横比を補正するので円が楕円にならない) ──
    lensOn: z.boolean().optional(), lens: z.number().optional().describe("歪み量。+ = 樽/魚眼、- = 糸巻き。"),
    lensMode: z.number().int().optional().describe("0=バレル(多項式 k1/k2) / 1=魚眼(等距離射影) / 2=魚眼(等立体角射影)。既定 0。"),
    lensK2: z.number().optional().describe("2 次の歪み係数(バレルのみ。端だけ余計に曲げる)。既定 0。"),
    lensZoom: z.number().optional().describe("拡大補正。魚眼で四隅が空くときに上げる。既定 1。"),
    lensCircular: z.boolean().optional().describe("縦横比を補正して円形に歪ませる。既定 true(false=旧来の UV 空間で横だけ強く歪む)。"),
    lensEdge: z.number().int().optional().describe("はみ出した所: 0=端を引き伸ばす / 1=黒で塗る / 2=鏡映。既定 1。"),
    lensChroma: z.number().optional().describe("倍率色収差(歪みに比例して RGB がずれる)。既定 0。"),
    waveOn: z.boolean().optional(), waveAmp: z.number().optional(), waveFreq: z.number().optional(), waveSpeed: z.number().optional(),
    radialOn: z.boolean().optional(), radial: z.number().optional(),
    radialSamples: z.number().int().optional().describe("放射ブラーのタップ数 2..32。既定 8。"),
    radialCenterX: z.number().optional().describe("放射ブラーの中心 X(0..1)。既定 0.5。"),
    radialCenterY: z.number().optional().describe("放射ブラーの中心 Y(0..1)。既定 0.5。"),
    glitchOn: z.boolean().optional(), glitch: z.number().optional().describe("横ずれ量。"),
    glitchBlocks: z.number().optional().describe("横帯の本数。既定 24。"),
    glitchSpeed: z.number().optional().describe("崩れが差し替わる速さ(1/秒)。既定 12。"),
    glitchColor: z.number().optional().describe("RGB 分離の量。既定 0.5。0 で色ずれ無し。"),
    outlineOn: z.boolean().optional(), outline: z.number().optional(), outlineColor: v3().optional(),
    outlineThickness: z.number().optional().describe("Sobel のタップ間隔(px)＝線の太さ。既定 1。"),
    outlineThreshold: z.number().optional().describe("これ未満の勾配は線にしない(暗部のノイズ止め)。既定 0.02。"),
    outlineOnly: z.boolean().optional().describe("true=絵を捨てて線画だけ描く(下地は outlineBg)。既定 false。"),
    outlineBg: v3().optional().describe("outlineOnly のときの下地色。既定 [1,1,1]（白）。"),
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

// ★この 4 本は docs/MCP.md に載っていてエンジン側の実装もあるのに、
//   MCP サーバへ登録されていなかった＝ドキュメントにある機能が 1 度も呼べなかった。
//   原因はエンジン側が "get_x|set_x" の合体形式で定義されていたこと（引数が get にも
//   付いてしまいスキーマドリフトテストが落ちるので登録を諦めた形跡がある）。
//   エンジン側を get/set へ分割したうえでここに登録する。
reg(
  "dx12_ui_click",
  "ゲーム内UIを押す",
  "ゲーム内 UI（UIButton / UIToggle / UISlider）を合成ポインタで押す。"
  + "★テストプレイで AI がメニューを操作する口。これが無いと『タイトルから始めて 1 面をクリアする』"
  + "のような検証が UI に触れず成立しない。"
  + "★実マウスとまったく同じ経路（レイキャスト → 最前面判定 → 押下キャプチャ → release-inside で確定）"
  + "へ流し込むので、**前面に別の要素が被っているボタンは押せない**のが正しく再現される"
  + "（名前で onClick を直接呼ぶ方式ではないため、被りやクリップのバグもちゃんと見つかる）。"
  + "name / entity を渡すとその要素の中心を押す。x,y（ビューポート基準 0..1）でも押せるので、"
  + "**何も無い所を押してフォーカスを外す**のにも使える。"
  + "押す→離す→イベント配送の 3 フレームを回してから返る（遅延同期）。"
  + "Lua の onClick が走るのは Play 中だけ。結果はゲーム側の状態か dx12_ui_tree で確かめること。",
  {
    ...entityRef,
    x: z.number().optional().describe("ビューポート基準 0..1 の横位置。name/entity の代わりに使う"),
    y: z.number().optional().describe("ビューポート基準 0..1 の縦位置。name/entity の代わりに使う"),
    move: z.boolean().optional().describe("true で押さずにカーソルを動かすだけ(ホバーの確認用)。既定 false"),
  },
  {},
  (a) => run(() => engine.call("ui_click", a), 20000),
);

reg(
  "dx12_get_render_scale",
  "内部解像度スケール取得",
  "内部解像度スケール(レンダー解像度と表示解像度の分離)を返す。"
  + "{scale, renderResolution{width,height}, displayResolution{width,height}, pending, note}。"
  + "★dx12_screenshot はレンダー解像度、dx12_screenshot_final は表示解像度で返る。"
  + "dx12_pick / dx12_project_world_to_screen の座標系もレンダー解像度。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_render_scale", {})),
);

reg(
  "dx12_set_render_scale",
  "内部解像度スケール変更",
  "3D シーン系の RT(sceneRT / 深度 / SSAO / コンタクトシャドウ / TAA 履歴・速度 / G-Buffer / "
  + "SSR・SSGI / ブルーム / DoF / ゴッドレイ / 歪み)だけを scale 倍で確保し、最終パスで表示解像度へ"
  + "引き伸ばす。**UI / ImGui / エディタのアイコンとギズモは常に表示解像度のまま**＝文字はボケない。"
  + "GPU 律速のときに一番効く手。settings.json の render_scale に保存される。"
  + "★変更は**次のフレーム先頭**で反映される(内部で WaitIdle するのでフレーム外でしか作り直せない)ので、"
  + "直後の返り値の renderResolution はまだ 1 フレーム前の値であり得る(pending:true で分かる)。"
  + "★反映後は TAA / SSR / SSGI / ボリュメトリックフォグの**時間履歴が全部捨てられる**"
  + "(座標系が変わるため。持ち越すとゴーストする)。",
  { scale: z.number().describe("0.25..1.0。1.0 で等倍(既定)。0.7 くらいから効きが分かる") },
  { idempotentHint: true },
  (a) => run(() => engine.call("set_render_scale", a)),
);

reg(
  "dx12_get_depth_prepass",
  "深度プリパス単独トグル取得",
  "深度プリパスの単独強制が ON かを返す。{enabled, note}。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_depth_prepass", {})),
);

reg(
  "dx12_set_depth_prepass",
  "深度プリパス単独トグル",
  "深度プリパスを単独で走らせる。通常は SSAO / コンタクトシャドウ / TAA / SSR / SSGI / DXR の"
  + "どれかが要求したときだけ走る。**そのシーンにオーバードローがどれだけあるか＝"
  + "オクルージョンカリングの余地**を測るための道具で、ON/OFF で "
  + "dx12_perf_stats の gpuPassMs.mainScene がどれだけ減るかを見る"
  + "(gpuPassMs.depthPrepass がプリパスの描画だけ、prepassSsao はそれを含むプリパス一式)。"
  + "正射 / 2D ビューでは自動的に無効。settings.json の render_depth_prepass に保存される。",
  { enabled: z.boolean() },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_depth_prepass", "get_depth_prepass", a)),
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

reg(
  "dx12_get_normal_filter",
  "法線マップフィルタリング設定取得",
  "法線マップフィルタリング(分散→ラフネス / 平均法線の復元)の設定を返す。{enabled, strength, varianceClamp, geometricBlend}。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_normal_filter", {})),
);

reg(
  "dx12_set_normal_filter",
  "法線マップフィルタリング設定変更",
  "法線マップのエイリアシング対策。1 画素の中に法線マップの山谷が何個も入る状況(高いタイリング / 遠景 / 面を舐める角度)で、①鏡面のちらつき ②【光源が面を舐める角度で N·L の符号が裏返り、面が黒い斑点で埋まる】の 2 つが起きる。スクリーン空間の法線微分から画素内の法線分散を見積もり、分散を GGX のラフネス(α)へ足し込み、分散が大きい画素は法線を幾何法線へ寄せる(=平均法線の復元)。★これが【法線マップを貼ると床が消える】の直接の対策。既定 ON。シーン JSON の normalFilter に保存される。",
  {
    enabled: z.boolean().optional().describe("既定 true。false で完全に従来どおり。"),
    strength: z.number().optional().describe("分散のスケール。既定 2。上げるほど強く効く(0 で OFF 相当)。"),
    varianceClamp: z.number().optional().describe("ラフネス α に足せる量の上限。既定 0.25。上げるとよりボケる。"),
    geometricBlend: z.number().optional().describe("分散に応じて幾何法線へ寄せる強さ。既定 2。0 にするとラフネス補正だけになる(黒斑点は残る)。"),
  },
  { idempotentHint: true },
  (a) => run(() => applyAndVerify("set_normal_filter", "get_normal_filter", a)),
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
  + "ddgiHysteresis, ddgiIntensity, ddgiNormalBias, ddgiBounceIntensity, ddgiFollowCamera, ddgiSpacing1, ddgiBudgetMs。"
  + "実測は stats.ddgiReady(PSO が建ったか) / ddgiEnabled / ddgiProbes / ddgiRaysCast / ddgiBytes。"
  + "★ddgiEnabled:true なのに ddgiProbes:0 なら TLAS が無い(tlasReady を見ること)。"
  + "\n■ 実際に走ったか: shadowActive(ON でも本当に RT 影パスが走ったフレームか) / tlasReady(TLAS が建っているか)。"
  + "enabled:true なのに shadowActive:false なら supported / tlasReady / カメラ(正射)を疑う。"
  + "\n■ stats(直近フレームの加速構造の実測): instances, blasCount, blasBytes, blasTriangles, tlasBytes, "
  + "scratchBytes, instanceDescBytes, skippedSkinned, skippedTransparent, droppedOverLimit, "
  + "tlasReuseFrames, bytesPerTriangle。"
  + "skippedSkinned / skippedTransparent は仕様(スキンドと半透明は TLAS に入らず CSM が担当する)。"
  + "droppedOverLimit > 0 なら maxInstances に引っかかっている。"
  + "tlasReuseFrames は「前フレームの TLAS をそのまま使い回しているフレーム数」。シーンが動いていない間は毎フレーム増える(= CPU の再構築を省けている)。動く物があるフレームや forceBuildTlas:true では 0 のまま。"
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
    ddgiFollowCamera: z.boolean().optional().describe(
      "GI モード new のときだけ有効。true = カメラ追従のスクロール格子 + 2 カスケード(近景 ddgiSpacing / 遠景 ddgiSpacing1。"
      + "ddgiProbeCountX/Y/Z は 1 カスケードの格子数・ddgiOrigin は無視)。false(既定)= 従来の固定ボリューム。"),
    ddgiSpacing1: z.number().optional().describe(
      "遠景カスケードのプローブ間隔(m)。0.1..100 にクランプ。既定 2.0。ddgiFollowCamera:true のときだけ使う。"),
    ddgiBudgetMs: z.number().optional().describe(
      "1 フレームの DDGI の GPU 予算(ms)。0.05..20 にクランプ。既定 1。実測の GPU 時間から更新するプローブ数を決める(超えそうなら間引く)。"),
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
