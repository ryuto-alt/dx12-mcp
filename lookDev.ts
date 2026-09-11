// 「絵作り(ルック)」のプリセット集。太陽 + フォグ + ポストを 1 セットで決める。
//
// ★なぜ要るか: エンジンのポストは約 90 フィールドある。1 つずつ触っても
//   「それっぽい絵」にはならず、AI は bloom と exposure だけ上げて終わる
//   (実際にそうなっていた)。映画的な絵は【光 → 空気 → グレーディング】の 3 段が
//   噛み合って初めて出るので、その組み合わせを名前付きで焼いておく。
//
// ★apply_lighting_preset(エンジン側の 6 種)との違い:
//   あちらは「太陽 + ごく一部のポスト」で、エディタのライティング窓と同じ実装＝土台。
//   こちらは【フォグ・DoF・グレイン・色収差・ビネットの形・トーンマッパーまで含めた完成形】で、
//   土台の上に乗せる仕上げにあたる。両方使ってよい(先に preset → 後から look)。
//
// このファイルは純関数だけ(エンジンを呼ばない)。テストは lookDev.test.ts。

export type Vec3 = [number, number, number];

/** dx12_set_sun に渡す形。 */
export type SunSpec = {
  timeOfDay?: number;
  azimuth?: number;
  elevation?: number;
  kelvin?: number;
  color?: Vec3;
  intensity?: number;
  ambient?: number;
};

/** dx12_set_volumetric_fog に渡す形(キー名はツールと同じ)。 */
export type FogSpec = {
  enabled: boolean;
  density?: number;
  albedo?: Vec3;
  anisotropy?: number;
  heightFalloff?: number;
  heightRef?: number;
  distance?: number;
  ambient?: Vec3;
  sunIntensity?: number;
};

/** dx12_set_scene_settings の skybox に渡す形(必要な看板だけ)。 */
export type SkySpec = {
  iblIntensity?: number;
  skyboxIntensity?: number;
  drawSkybox?: boolean;
};

export type LookPreset = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** 光。指定しない看板は触らない。 */
  sun?: SunSpec;
  /** 空気。enabled:false なら明示的に切る。 */
  fog?: FogSpec;
  /** 背景。屋内ルックで環境光を殺したいときに使う。 */
  sky?: SkySpec;
  /** グレーディング一式(PostProcessSettings のフィールド名そのまま)。 */
  post: Record<string, number | boolean | Vec3>;
  notes: string[];
  /** 相性の良い効果・使いどころ。 */
  pairsWith?: string[];
};

// ── strength(効き具合)を掛けるときの「無味無臭の値」──
// ★トーンマッパーや deband のような【表示に必須の設定】は blend しない(下の NO_BLEND)。
const NEUTRAL_POST: Record<string, number> = {
  exposure: 1.0, contrast: 1.0, brightness: 0.0, saturation: 1.0, warmth: 0.0, hueShift: 0.0,
  bloom: 0.0, bloomThreshold: 1.0, bloomKnee: 0.5, bloomRadius: 0.65,
  vignette: 0.0, vignetteRadius: 0.75, vignetteSoftness: 0.45, vignetteRoundness: 1.0,
  chromatic: 0.0, grain: 0.0, grainSize: 1.0, sharpen: 0.0, scanline: 0.0, scanCount: 240,
  scanCurve: 0.0, grayscale: 0.0, sepia: 0.0, posterize: 16, lens: 0.0, lensChroma: 0.0,
  waveAmp: 0.0, radial: 0.0, glitch: 0.0, aeEvComp: 0.0,
  grIntensity: 0.0, grDensity: 0.9, grDecay: 0.96,
  lfIntensity: 0.0, lfDispersal: 0.35, lfHalo: 0.45, lfChroma: 0.01,
  dofBlurSize: 12.0, mbStrength: 0.0, lutAmount: 0.0,
};
/** strength で薄めない項目(on/off と、意味が離散的なもの)。 */
const NO_BLEND = new Set(["tonemapper", "debandOn", "fxaaOn", "dofAperture", "dofFocalLength",
                          "dofFocusDist", "dofFocusName", "lutPath", "chromaMode", "lensMode",
                          "lensEdge", "lensCircular", "radialSamples", "mbSamples", "ditherLevels",
                          "aeSpeed", "aeLogMin", "aeLogMax", "vignetteColor", "tint",
                          "outlineColor", "outlineBg", "outlineThickness", "outlineThreshold",
                          "lfGhosts", "pixelSize"]);

// ════════════════════════════════════════════════════════════════
//  ルック本体
// ════════════════════════════════════════════════════════════════
// 値の決め方:
//   - 露出は「絵の明るさ」ではなく【光の量】で作る。exposure で持ち上げるのは最後の微調整。
//   - コントラストは光と影の差で作る。contrast を上げるのは色が眠いときだけ。
//   - ビネットは vignette(濃さ)だけでは絵にならない。radius/softness で【形】を決める。
//   - トーンマッパーは既定 ACES。彩度の高い光源(ネオン/魔法)が色割れするなら AgX(1)。

export const LOOK_PRESETS: LookPreset[] = [
  {
    id: "golden_hour",
    title: "ゴールデンアワー（夕方の斜光）",
    summary: "低く長い橙の光。影が伸び、空気が光る。屋外の『きれいな絵』の第一候補。",
    tags: ["outdoor", "warm", "cinematic"],
    sun: { azimuth: -60, elevation: 8, kelvin: 3200, intensity: 3.4, ambient: 0.22 },
    fog: { enabled: true, density: 0.012, albedo: [1.0, 0.92, 0.82], anisotropy: 0.7,
           heightFalloff: 0.06, distance: 200, sunIntensity: 1.4 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.0,
      contrastOn: true, contrast: 1.06,
      saturationOn: true, saturation: 1.12,
      warmthOn: true, warmth: 0.18,
      bloomOn: true, bloom: 0.42, bloomThreshold: 1.05, bloomKnee: 0.55, bloomRadius: 0.7,
      vignetteOn: true, vignette: 0.28, vignetteRadius: 0.8, vignetteSoftness: 0.5,
      godraysOn: true, grIntensity: 0.5, grDensity: 0.92, grDecay: 0.96,
      grainOn: true, grain: 0.08, grainSize: 1.2,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "太陽が低いので、影の向きが絵の骨格になる。azimuth を変えて被写体に長い影が落ちる角度を探すこと。",
      "ゴッドレイは【太陽が画面内か画面際にある】ときだけ出る。カメラを太陽の方へ向けないと何も起きない。",
      "ボリュメトリックフォグとゴッドレイを両方強くすると太陽の散乱が二重に乗る。どちらかを主役にする。",
    ],
    pairsWith: ["dust_motes", "ember_drift", "falling_leaves"],
  },
  {
    id: "blue_hour",
    title: "ブルーアワー（日没直後）",
    summary: "太陽が沈んだ直後の青い薄明かり。人工光が主役になる時間帯。",
    tags: ["outdoor", "cool", "cinematic", "dark"],
    sun: { azimuth: -75, elevation: 1.5, kelvin: 9000, intensity: 0.55, ambient: 0.3 },
    fog: { enabled: true, density: 0.02, albedo: [0.7, 0.8, 1.0], anisotropy: 0.35,
           heightFalloff: 0.08, distance: 160, sunIntensity: 0.6 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.15,
      contrastOn: true, contrast: 1.08,
      saturationOn: true, saturation: 0.95,
      tintOn: true, tint: [0.9, 0.96, 1.1],
      bloomOn: true, bloom: 0.35, bloomThreshold: 0.95, bloomRadius: 0.72,
      vignetteOn: true, vignette: 0.35, vignetteRadius: 0.72, vignetteSoftness: 0.5,
      grainOn: true, grain: 0.12,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "この時間帯は【窓・街灯・焚き火の暖色】と空の青の対比で見せる。点光源を置いてこそ活きる。",
      "空が主光源なので ambient を下げすぎないこと(0.25〜0.35)。下げると夜になる。",
    ],
    pairsWith: ["torch", "campfire", "fireflies"],
  },
  {
    id: "moonlit_night",
    title: "月明かりの夜",
    summary: "青白い弱い光と深い影。彩度を落として『夜目』の見え方に寄せる。",
    tags: ["outdoor", "cool", "dark", "night"],
    sun: { azimuth: 140, elevation: 42, kelvin: 13000, intensity: 0.35, ambient: 0.06 },
    fog: { enabled: true, density: 0.018, albedo: [0.6, 0.72, 1.0], anisotropy: 0.25,
           heightFalloff: 0.12, distance: 120, sunIntensity: 0.8 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.25,
      contrastOn: true, contrast: 1.1,
      saturationOn: true, saturation: 0.68,
      tintOn: true, tint: [0.85, 0.93, 1.15],
      bloomOn: true, bloom: 0.4, bloomThreshold: 0.85, bloomRadius: 0.75,
      vignetteOn: true, vignette: 0.5, vignetteRadius: 0.65, vignetteSoftness: 0.55,
      grainOn: true, grain: 0.22, grainSize: 1.3,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "夜は【暗くする】のではなく【彩度を落として青へ寄せる】。真っ黒にすると何も見えないだけの絵になる。",
      "プレイヤーが動く場所には必ず暖色の光源(松明/窓)を置いて道標にすること。",
    ],
    pairsWith: ["moon", "fireflies", "ground_mist", "torch"],
  },
  {
    id: "overcast_gloom",
    title: "曇天（陰鬱）",
    summary: "影の出ない拡散光。彩度とコントラストを落として重い空気にする。",
    tags: ["outdoor", "neutral", "moody"],
    sun: { azimuth: 30, elevation: 58, kelvin: 7200, intensity: 1.5, ambient: 0.5 },
    fog: { enabled: true, density: 0.03, albedo: [0.78, 0.8, 0.84], anisotropy: 0.1,
           heightFalloff: 0.05, distance: 180, sunIntensity: 0.5 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 0.95,
      contrastOn: true, contrast: 0.92,
      saturationOn: true, saturation: 0.78,
      bloomOn: true, bloom: 0.18, bloomThreshold: 1.3,
      vignetteOn: true, vignette: 0.3, vignetteRadius: 0.75, vignetteSoftness: 0.5,
      grainOn: true, grain: 0.15,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "影が薄いので、立体感は【フォグの奥行き】で作る。遠景と近景の距離差を大きく取ること。",
      "コントラストを下げた絵は眠く見えやすい。近景に 1 つだけ濃い色の物を置くと締まる。",
    ],
    pairsWith: ["rain", "ash_fall", "chimney_smoke"],
  },
  {
    id: "neon_noir",
    title: "ネオン・ノワール（雨の夜の繁華街）",
    summary: "暗い空に彩度の高い人工光。滲み・色収差・強いビネットで映画寄りに。",
    tags: ["night", "stylized", "cinematic", "dark"],
    sun: { azimuth: 200, elevation: 15, kelvin: 11000, intensity: 0.18, ambient: 0.07 },
    fog: { enabled: true, density: 0.035, albedo: [0.55, 0.6, 0.75], anisotropy: 0.5,
           heightFalloff: 0.1, distance: 90, sunIntensity: 0.4 },
    post: {
      tonemapper: 1,   // AgX: 彩度の高いネオンが ACES だと色割れするため
      exposureOn: true, exposure: 1.1,
      contrastOn: true, contrast: 1.18,
      saturationOn: true, saturation: 1.28,
      bloomOn: true, bloom: 0.72, bloomThreshold: 0.85, bloomKnee: 0.6, bloomRadius: 0.8,
      vignetteOn: true, vignette: 0.6, vignetteRadius: 0.6, vignetteSoftness: 0.6,
      chromaticOn: true, chromatic: 0.3, chromaMode: 0,
      lensflareOn: true, lfIntensity: 0.35, lfGhosts: 4, lfDispersal: 0.35, lfHalo: 0.45,
      grainOn: true, grain: 0.25, grainSize: 1.2,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "主役は【置いた色光】。青と橙、あるいは桃と水色のように補色で 2 色だけに絞ると一気に映画になる。",
      "濡れた路面の反射がこのルックの命。床の roughness を 0.1〜0.2 まで下げて dx12_set_ssr を有効にすること。",
      "トーンマッパーを AgX(1) にしてある。ACES だと高彩度の光源が色割れして汚くなる。",
    ],
    pairsWith: ["rain", "steam_vent", "electric_arc", "portal_swirl"],
  },
  {
    id: "horror_candle",
    title: "ホラー（蝋燭 1 本）",
    summary: "ほぼ真っ暗な中に暖色の小さな光。粒子の粗さと強いビネットで視界を狭める。",
    tags: ["indoor", "dark", "moody", "night"],
    sun: { azimuth: 25, elevation: 30, kelvin: 2600, intensity: 0.12, ambient: 0.03 },
    fog: { enabled: true, density: 0.045, albedo: [0.5, 0.48, 0.45], anisotropy: 0.2,
           heightFalloff: 0.15, distance: 60, sunIntensity: 0.3 },
    sky: { iblIntensity: 0.05, skyboxIntensity: 0.05, drawSkybox: false },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.3,
      contrastOn: true, contrast: 1.22,
      saturationOn: true, saturation: 0.62,
      bloomOn: true, bloom: 0.45, bloomThreshold: 0.8, bloomRadius: 0.7,
      vignetteOn: true, vignette: 0.75, vignetteRadius: 0.5, vignetteSoftness: 0.55,
      grainOn: true, grain: 0.38, grainSize: 1.5, grainColored: false,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "★このルックは【光源を置いてから】当てること。真っ暗なシーンに当てても真っ黒になるだけ。",
      "sky を落としているので環境光がほぼ無い。手持ちの灯り(candle / torch)が唯一の情報になる。",
      "見える範囲が狭いほど怖い。フォグの distance を 40〜60 まで詰めると『先が見えない』が作れる。",
    ],
    pairsWith: ["candle", "torch", "ground_mist", "dust_motes"],
  },
  {
    id: "clean_studio",
    title: "スタジオ（製品撮影）",
    summary: "均一で素直なニュートラル光。素材と形を正しく見せるための絵。",
    tags: ["indoor", "neutral", "product"],
    sun: { azimuth: -30, elevation: 42, kelvin: 5600, intensity: 3.0, ambient: 0.55 },
    fog: { enabled: false },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.0,
      contrastOn: true, contrast: 1.04,
      saturationOn: true, saturation: 1.02,
      bloomOn: true, bloom: 0.18, bloomThreshold: 1.45, bloomRadius: 0.6,
      vignetteOn: true, vignette: 0.12, vignetteRadius: 0.85, vignetteSoftness: 0.6,
      sharpenOn: true, sharpen: 0.25,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "モデルの質感を判断したいときはこれを当ててから見る。色が付いたルックのままだと素材の良し悪しが分からない。",
      "金属と光沢は【映り込む物が無いと質感が出ない】。dx12_scene_env で HDRI を入れること。",
    ],
    pairsWith: [],
  },
  {
    id: "anime_daylight",
    title: "アニメ調の昼",
    summary: "彩度高め・影は浅め・白は飛ばし気味。セル調の明るい絵。",
    tags: ["outdoor", "stylized", "bright"],
    sun: { azimuth: -45, elevation: 62, kelvin: 6200, intensity: 3.6, ambient: 0.6 },
    fog: { enabled: true, density: 0.006, albedo: [0.85, 0.92, 1.0], anisotropy: 0.2, distance: 250 },
    post: {
      tonemapper: 1,   // AgX: 明るい部分の色を残したまま白へ寄せる
      exposureOn: true, exposure: 1.05,
      contrastOn: true, contrast: 1.12,
      saturationOn: true, saturation: 1.32,
      bloomOn: true, bloom: 0.4, bloomThreshold: 1.0, bloomKnee: 0.7, bloomRadius: 0.75,
      vignetteOn: true, vignette: 0.14, vignetteRadius: 0.85, vignetteSoftness: 0.6,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "輪郭線が欲しければ outlineOn:true / outline:1.0 / outlineThickness:1.2 を足す(このルックには含めていない)。",
      "影を浅くしたいなら太陽の ambient を上げる。影そのものを消すと立体感まで消えるので 0.6 前後で止める。",
    ],
    pairsWith: ["falling_leaves", "heal_aura", "magic_circle"],
  },
  {
    id: "desert_heat",
    title: "灼熱の砂漠",
    summary: "真上からの強い白光。空気が焼けて遠景が滲む。",
    tags: ["outdoor", "warm", "bright"],
    sun: { azimuth: 10, elevation: 78, kelvin: 5400, intensity: 4.6, ambient: 0.55 },
    fog: { enabled: true, density: 0.014, albedo: [1.0, 0.94, 0.8], anisotropy: 0.45,
           heightFalloff: 0.03, distance: 300, sunIntensity: 1.2 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.08,
      contrastOn: true, contrast: 1.1,
      saturationOn: true, saturation: 0.92,
      warmthOn: true, warmth: 0.28,
      bloomOn: true, bloom: 0.35, bloomThreshold: 1.25,
      vignetteOn: true, vignette: 0.22, vignetteRadius: 0.8, vignetteSoftness: 0.5,
      godraysOn: true, grIntensity: 0.3, grDensity: 0.85,
      grainOn: true, grain: 0.1,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "真上からの光は影が真下に落ちる＝立体感が出にくい。地面の起伏と物の配置で影を作ること。",
      "地面付近に heat_haze(陽炎)を置くと一気に『暑い』絵になる。",
    ],
    pairsWith: ["heat_haze", "dust_puff", "ember_drift"],
  },
  {
    id: "underwater",
    title: "水中",
    summary: "青緑に濁った光、揺らぎ、強い減衰。深さで色が抜ける。",
    tags: ["stylized", "cool", "moody"],
    sun: { azimuth: 0, elevation: 72, kelvin: 8500, intensity: 1.1, ambient: 0.25 },
    fog: { enabled: true, density: 0.09, albedo: [0.25, 0.6, 0.7], anisotropy: 0.35,
           heightFalloff: 0.0, distance: 60, sunIntensity: 1.0 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.1,
      contrastOn: true, contrast: 0.95,
      saturationOn: true, saturation: 0.9,
      tintOn: true, tint: [0.6, 0.95, 1.05],
      bloomOn: true, bloom: 0.4, bloomThreshold: 0.95, bloomRadius: 0.78,
      vignetteOn: true, vignette: 0.45, vignetteRadius: 0.65, vignetteSoftness: 0.6,
      waveOn: true, waveAmp: 0.004, waveFreq: 9.0, waveSpeed: 1.2,
      grainOn: true, grain: 0.12,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "水中は【減衰】が命。フォグの distance を短く(40〜80)して、遠くが本当に見えないようにする。",
      "画面の揺らぎ(wave)は強くすると酔う。waveAmp 0.003〜0.006 で十分伝わる。",
    ],
    pairsWith: ["bubbles", "waterfall_mist", "dust_motes"],
  },
  {
    id: "film_noir",
    title: "フィルム・ノワール（白黒）",
    summary: "モノクロ・高コントラスト・粗い粒子。硬い光で影を武器にする。",
    tags: ["stylized", "dark", "cinematic"],
    sun: { azimuth: -100, elevation: 22, kelvin: 5000, intensity: 3.2, ambient: 0.08 },
    fog: { enabled: true, density: 0.025, albedo: [0.8, 0.8, 0.8], anisotropy: 0.6,
           heightFalloff: 0.1, distance: 80, sunIntensity: 1.3 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.0,
      contrastOn: true, contrast: 1.38,
      grayscaleOn: true, grayscale: 1.0,
      bloomOn: true, bloom: 0.3, bloomThreshold: 1.1,
      vignetteOn: true, vignette: 0.62, vignetteRadius: 0.62, vignetteSoftness: 0.5,
      grainOn: true, grain: 0.35, grainSize: 1.6,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "白黒は【明暗の形】が全て。ブラインド越しの光や柱の影など、はっきりした形の影を作ること。",
      "色が無いぶん、粒子(grain)とビネットの強さがそのまま時代感になる。",
    ],
    pairsWith: ["chimney_smoke", "ground_mist", "steam_vent"],
  },
  {
    id: "dreamy_soft",
    title: "夢・回想（やわらかい）",
    summary: "低しきい値のブルームで光が滲み、周辺がぼける。回想・幻覚・エンディング。",
    tags: ["stylized", "bright", "cinematic"],
    sun: { azimuth: -20, elevation: 25, kelvin: 4200, intensity: 2.6, ambient: 0.45 },
    fog: { enabled: true, density: 0.02, albedo: [1.0, 0.95, 0.92], anisotropy: 0.5,
           heightFalloff: 0.04, distance: 150, sunIntensity: 1.3 },
    post: {
      tonemapper: 1,
      exposureOn: true, exposure: 1.12,
      contrastOn: true, contrast: 0.9,
      saturationOn: true, saturation: 0.88,
      warmthOn: true, warmth: 0.12,
      bloomOn: true, bloom: 0.75, bloomThreshold: 0.65, bloomKnee: 0.8, bloomRadius: 0.85,
      vignetteOn: true, vignette: 0.3, vignetteRadius: 0.7, vignetteSoftness: 0.7,
      grainOn: true, grain: 0.1,
      fxaaOn: true, debandOn: true,
    },
    notes: [
      "ブルームのしきい値を下げてあるので【中間調まで滲む】。文字や UI が読めなくなるので HUD 中は避けること。",
      "被写界深度を足すとさらに効く: dofOn:true / dofFocusName:'Player' / dofAperture:1.8。",
    ],
    pairsWith: ["dust_motes", "heal_aura", "soul_wisp"],
  },
  {
    id: "retro_vhs",
    title: "レトロ VHS",
    summary: "走査線・色収差・階調落ち。ビデオテープ越しの画。",
    tags: ["stylized", "moody"],
    sun: { azimuth: -50, elevation: 35, kelvin: 4800, intensity: 2.4, ambient: 0.35 },
    post: {
      tonemapper: 0,
      exposureOn: true, exposure: 1.02,
      contrastOn: true, contrast: 1.14,
      saturationOn: true, saturation: 1.15,
      bloomOn: true, bloom: 0.35, bloomThreshold: 1.0,
      vignetteOn: true, vignette: 0.42, vignetteRadius: 0.68, vignetteSoftness: 0.5,
      chromaticOn: true, chromatic: 0.45, chromaMode: 1,
      scanlineOn: true, scanline: 0.35, scanCount: 320, scanCurve: 0.1,
      posterizeOn: true, posterize: 12,
      grainOn: true, grain: 0.3, grainColored: true,
      debandOn: true,
    },
    notes: [
      "走査線の本数(scanCount)は画面の縦解像度に合わせる。少なすぎると縞が太くて汚い。",
      "グリッチ(glitchOn)を足すと一気に『壊れたテープ』になる。常時 ON にはせず演出の一瞬だけにすること。",
    ],
    pairsWith: ["electric_arc"],
  },
];

export const LOOK_IDS: string[] = LOOK_PRESETS.map((p) => p.id);
export const LOOK_TAGS: string[] = Array.from(new Set(LOOK_PRESETS.flatMap((p) => p.tags))).sort();

export function findLook(id: string): LookPreset | undefined {
  return LOOK_PRESETS.find((p) => p.id === id);
}

export type LookPart = "sun" | "fog" | "post" | "sky";
export const LOOK_PARTS: LookPart[] = ["sun", "fog", "post", "sky"];

export type ResolvedLook = {
  preset: LookPreset;
  sun?: SunSpec;
  fog?: FogSpec;
  sky?: SkySpec;
  post: Record<string, number | boolean | Vec3>;
  warnings: string[];
};

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * strength(0..1) でポストを薄める。
 * ★数値は「無味無臭の値 → プリセット値」を線形に混ぜる。0 に向かって薄めるのではない
 *   (contrast を 0 に向かわせたら灰色になってしまう)。
 * ★on/off は strength が小さいときに切る。数値だけ薄めて On のままだと、
 *   「効いていないのに有効」というムダな状態が残るため。
 */
export function blendPost(
  post: Record<string, number | boolean | Vec3>, strength: number,
): Record<string, number | boolean | Vec3> {
  const s = Math.max(0, Math.min(1, strength));
  if (s === 1) return { ...post };
  const out: Record<string, number | boolean | Vec3> = {};
  for (const [k, v] of Object.entries(post)) {
    if (NO_BLEND.has(k)) { out[k] = v; continue; }
    if (typeof v === "boolean") { out[k] = k.endsWith("On") ? (v && s > 0.15) : v; continue; }
    if (typeof v === "number") {
      const neutral = NEUTRAL_POST[k];
      out[k] = neutral === undefined ? v : round3(neutral + (v - neutral) * s);
      continue;
    }
    out[k] = v;   // vec3(tint / vignetteColor)はそのまま
  }
  return out;
}

export function resolveLook(
  id: string,
  opts: { strength?: number; parts?: LookPart[] } = {},
): ResolvedLook {
  const preset = findLook(id);
  if (!preset) {
    throw new Error(`未知のルック "${id}"。使えるのは: ${LOOK_IDS.join(", ")}`);
  }
  const parts = opts.parts && opts.parts.length > 0 ? opts.parts : LOOK_PARTS;
  const strength = opts.strength ?? 1;
  const warnings: string[] = [];

  const out: ResolvedLook = { preset, post: {}, warnings };
  if (parts.includes("post")) out.post = blendPost(preset.post, strength);
  if (parts.includes("sun") && preset.sun) out.sun = { ...preset.sun };
  if (parts.includes("fog") && preset.fog) out.fog = { ...preset.fog };
  if (parts.includes("sky") && preset.sky) out.sky = { ...preset.sky };

  if (strength < 1 && !parts.includes("post")) {
    warnings.push("strength はポストにしか効かない。太陽とフォグは常に指定どおり適用される。");
  }
  if (preset.fog?.enabled && preset.post.godraysOn) {
    warnings.push(
      "ボリュメトリックフォグとゴッドレイを同時に有効にしている。"
      + "太陽の散乱が二重に乗るので、眩しすぎると感じたら grIntensity かフォグの sunIntensity のどちらかを下げること。",
    );
  }
  if ((preset.sun?.ambient ?? 1) <= 0.1) {
    warnings.push(
      "環境光をほぼ切るルック。★シーンに envMap(HDRI)が設定されていると DirectionalLight.ambient は無視されるので、"
      + "暗くならなかったら dx12_set_scene_settings で iblIntensity を下げること。",
    );
  }
  return out;
}

/** ライブラリ一覧(ツールの返り値用)。 */
export function describeLooks(tag?: string): Array<Record<string, unknown>> {
  const list = tag ? LOOK_PRESETS.filter((p) => p.tags.includes(tag)) : LOOK_PRESETS;
  return list.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    tags: p.tags,
    touches: [p.sun ? "sun" : null, p.fog ? "fog" : null, p.sky ? "sky" : null, "post"].filter(Boolean),
    postKeys: Object.keys(p.post).length,
    pairsWith: p.pairsWith ?? [],
  }));
}
