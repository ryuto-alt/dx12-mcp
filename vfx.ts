// VFX(パーティクル/トレイル)のレシピ集と解決器。
//
// ★なぜ要るか: エンジンのパーティクルは 1 レイヤーに 40 個近いフィールドがあり、
//   「炎らしさ」は blend/intensity/turbStrength/flicker/gravity の組み合わせで決まる。
//   AI が set_component へ生の数値を並べると、たいてい
//   「加算ブレンドの白い粒が等速で飛ぶだけ」の安っぽい絵になる（実際にそうなっていた）。
//   ここに【人が見て納得する値】を焼いておき、AI は preset 名 + 倍率だけで呼ぶ。
//
// ★設計方針:
//   - レシピは必ず【複数レイヤー】で考える。本物の炎は「炎＋煙＋火の粉」であって、
//     1 種類の粒では絶対にそう見えない。エンジンは 1 放出器に 16 レイヤーまで持てる。
//   - 値は engine 同梱テンプレート(src/project/ProjectTemplates.cpp の松明/ゴール演出)を
//     出発点に、同じ流儀（火は加算+intensity>1、煙は前乗算アルファ）で広げてある。
//   - このファイルは【純関数だけ】。エンジンを呼ばないのでテストが速い(vfx.test.ts)。
//
// kind: 0=Glow 1=Fire 2=Smoke 3=Spark 4=Magic 5=Electric 6=Ring 7=Star
// blend: 0=加算(エネルギー/光) 1=前乗算アルファ(煙/埃/雪)
// orient: 0=ビルボード 1=水平(地面に寝かせる) 2=垂直

import { PNG } from "pngjs";

export type Vec3 = [number, number, number];

/** ParticleLayer(ecs/Components.h)へそのまま流し込める形。省略したものはエンジン既定のまま。 */
export type LayerSpec = {
  name: string;
  kind: number;
  blend?: number;
  orient?: number;
  rate: number;
  playOnStart?: boolean;
  looping?: boolean;
  duration?: number;
  offset?: Vec3;
  dir?: Vec3;
  spread?: number;
  speed?: number;
  speedVar?: number;
  size: number;
  sizeMid?: number;
  sizeEnd?: number;
  life: number;
  lifeVar?: number;
  color: Vec3;
  colorMid?: Vec3;
  colorEnd: Vec3;
  intensity?: number;
  gravity?: number;
  drag?: number;
  up?: number;
  stretch?: number;
  turbStrength?: number;
  turbFreq?: number;
  distort?: number;
  light?: boolean;
  lightRange?: number;
  flicker?: number;
  flickerFreq?: number;
  gpu?: boolean;
};

/** TrailRenderer(剣閃/弾道)。1 エンティティに 1 本だけ持てる。 */
export type TrailSpec = {
  width: number;
  life: number;
  color: Vec3;
  colorEnd: Vec3;
  intensity?: number;
  blend?: number;
  minDist?: number;
};

export type VfxPreset = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** scale:1 のときの想定サイズ(人が読む用)。 */
  sizeHint: string;
  /** 置き方の注意。オフセット基準・向き・相性の悪い設定など。 */
  notes: string[];
  layers: LayerSpec[];
  trail?: TrailSpec;
  /** この効果が映える絵作り(呼び出し側への助言。自動では適用しない)。 */
  lookHint?: string;
};

// ════════════════════════════════════════════════════════════════
//  レシピ本体
// ════════════════════════════════════════════════════════════════
// 共通の作法:
//   - 炎/魔法/電気 = blend 0(加算) + intensity 3〜6。ブルームに乗って初めて「光って」見える。
//   - 煙/埃/雪/血  = blend 1(前乗算アルファ)。加算にすると白く光って煙に見えない。
//   - 上へ立ち上る物は gravity を【正】にする(浮力)。落ちる物は負。
//   - ★【密度 × 強度】が最重要。加算ブレンドは重なった枚数だけ足し算になるので、
//     rate を上げたまま intensity を上げると【芯が真っ白に潰れて色も形も消える】
//     (実測: 松明を intensity 4.0 で置くと、暗い部屋でもただの白い球にしか見えない)。
//     炎のように粒が重なる層は **rate × intensity ≒ 50** を目安にする
//     (rate 34 なら intensity 1.6 / rate 55 なら 1.0 / rate 80 なら 0.9)。
//     逆に火の粉・星屑のような【細かくて重ならない】粒は intensity 6〜8 で構わない。
//     そこが「点が光っている」ように見える唯一の作り方で、炎の中の火の粉もこれで出す。
//   - ★色は【濃いめに指定する】。加算 + ブルームは色を白へ流すので、[0.6,0.9,1.0] のような
//     淡い青は画面では【ただの白】になる(実測)。狙った色相を残したいなら [0.25,0.65,1.0] まで濃くする。
//   - light:true は「明るい粒の上位 N 個を実ポイントライト化」。周囲を照らせるが
//     ライト予算(dx12_list_lights の budget)を食うので、1 シーンに数個まで。

export const VFX_PRESETS: VfxPreset[] = [
  // ── 火・熱 ────────────────────────────────────────────────
  {
    id: "torch",
    title: "松明の炎",
    summary: "炎 + 立ち上る煙 + たまに弾ける火の粉。周囲を照らす実ライト付き。",
    tags: ["fire", "light", "loop"],
    sizeHint: "炎の高さ 約 0.8m（松明・壁掛けランタン向け）",
    notes: [
      "エンティティ原点が炎の【根元】。松明のモデルなら先端の位置へ置く。",
      "light:true のレイヤーが 1 枚入っている。同じ部屋に 4 本以上並べるなら light:false にして、"
        + "代わりにポイントライトを 1 個手で置いた方が予算的に安全。",
    ],
    lookHint: "暗所で映える。dx12_look_apply preset='horror_candle' か 'moonlit_night' と相性が良い。",
    layers: [
      {
        name: "Flame", kind: 1, blend: 0, rate: 34, dir: [0, 1, 0], spread: 0.24,
        speed: 2.2, speedVar: 0.45, size: 0.2, sizeMid: 0.13, sizeEnd: 0.0, life: 0.7, lifeVar: 0.3,
        color: [1.0, 0.62, 0.2], colorEnd: [1.0, 0.12, 0.04], intensity: 1.6,
        gravity: 0.6, drag: 1.0, turbStrength: 0.9, turbFreq: 1.6, flicker: 0.5, flickerFreq: 16,
        light: true, lightRange: 6.0,
      },
      {
        name: "Smoke", kind: 2, blend: 1, rate: 7, offset: [0, 0.45, 0], dir: [0, 1, 0],
        spread: 0.35, speed: 0.9, speedVar: 0.3, size: 0.22, sizeMid: 0.5, sizeEnd: 0.85,
        life: 1.8, lifeVar: 0.4, color: [0.16, 0.15, 0.14], colorEnd: [0.07, 0.07, 0.07],
        intensity: 0.7, gravity: 0.35, drag: 1.4, turbStrength: 0.8, turbFreq: 0.7,
      },
      {
        name: "Sparks", kind: 3, blend: 0, rate: 4, dir: [0, 1, 0], spread: 0.55,
        speed: 2.4, speedVar: 1.0, size: 0.05, sizeEnd: 0.0, life: 0.9, lifeVar: 0.5,
        color: [1.0, 0.8, 0.4], colorEnd: [0.9, 0.2, 0.05], intensity: 6.0,
        gravity: -1.2, drag: 0.6, stretch: 0.35, turbStrength: 0.5,
      },
    ],
  },
  {
    id: "campfire",
    title: "焚き火",
    summary: "地面で燃える炎。太い炎 + 濃い煙 + 舞い上がる燃えさし。",
    tags: ["fire", "light", "loop"],
    sizeHint: "炎の直径 約 1.2m / 高さ 約 1.5m",
    notes: [
      "原点が薪の上面。地面に置くなら y=+0.15 くらい浮かせる。",
      "煙は上へ 3m ほど伸びる。天井が低い屋内では smoke の life を下げること。",
    ],
    lookHint: "dx12_set_volumetric_fog を density 0.02 前後で入れると、炎の光が空気に散って一気に本物になる。",
    layers: [
      {
        name: "Flame", kind: 1, blend: 0, rate: 55, dir: [0, 1, 0], spread: 0.4,
        speed: 2.6, speedVar: 0.6, size: 0.3, sizeMid: 0.2, sizeEnd: 0.0, life: 0.8, lifeVar: 0.3,
        color: [1.0, 0.66, 0.24], colorMid: [1.0, 0.35, 0.08], colorEnd: [0.7, 0.08, 0.02],
        intensity: 1.0, gravity: 0.8, drag: 1.1, turbStrength: 1.0, turbFreq: 1.5,
        flicker: 0.45, flickerFreq: 14, light: true, lightRange: 9.0,
      },
      {
        name: "Smoke", kind: 2, blend: 1, rate: 12, offset: [0, 0.8, 0], dir: [0, 1, 0],
        spread: 0.3, speed: 1.2, speedVar: 0.4, size: 0.45, sizeMid: 0.9, sizeEnd: 1.6,
        life: 2.6, lifeVar: 0.5, color: [0.2, 0.19, 0.18], colorEnd: [0.06, 0.06, 0.06],
        intensity: 0.6, gravity: 0.4, drag: 1.5, turbStrength: 1.0, turbFreq: 0.6,
      },
      {
        name: "Embers", kind: 3, blend: 0, rate: 9, dir: [0, 1, 0], spread: 0.6,
        speed: 2.8, speedVar: 1.2, size: 0.06, sizeEnd: 0.0, life: 1.6, lifeVar: 0.6,
        color: [1.0, 0.75, 0.35], colorEnd: [0.8, 0.15, 0.03], intensity: 7.0,
        gravity: 0.25, drag: 0.5, stretch: 0.25, turbStrength: 1.4, turbFreq: 1.0, flicker: 0.6,
      },
    ],
  },
  {
    id: "candle",
    title: "ろうそくの火",
    summary: "小さく揺れる 1 点の炎。手前に置いても粒が見えない密度。",
    tags: ["fire", "light", "loop", "small"],
    sizeHint: "炎の高さ 約 0.12m",
    notes: ["原点が芯の先。size が小さいので scale を 1 のまま使うこと(0.3 などにすると点になる)。"],
    layers: [
      {
        name: "Flame", kind: 1, blend: 0, rate: 26, dir: [0, 1, 0], spread: 0.1,
        speed: 0.35, speedVar: 0.08, size: 0.07, sizeEnd: 0.0, life: 0.35, lifeVar: 0.15,
        color: [1.0, 0.75, 0.35], colorEnd: [1.0, 0.25, 0.05], intensity: 2.2,
        gravity: 0.3, drag: 1.6, turbStrength: 0.25, turbFreq: 2.2,
        flicker: 0.55, flickerFreq: 9, light: true, lightRange: 3.2,
      },
    ],
  },
  {
    id: "bonfire_large",
    title: "大きな焚き火／かがり火",
    summary: "篝火サイズの炎。熱ゆらぎ(画面の歪み)付きで空気の熱まで見える。",
    tags: ["fire", "light", "loop", "distort"],
    sizeHint: "高さ 約 3m",
    notes: [
      "distort レイヤーは画面を歪ませる。TAA と併用すると尾を引くので、気になるなら distort を 0 にする。",
      "光が強いので lightRange が大きい。屋内では他のライトを暗くしてバランスを取ること。",
    ],
    layers: [
      {
        name: "Core", kind: 1, blend: 0, rate: 80, dir: [0, 1, 0], spread: 0.32,
        speed: 3.8, speedVar: 0.9, size: 0.55, sizeMid: 0.38, sizeEnd: 0.0, life: 1.1, lifeVar: 0.3,
        color: [1.0, 0.72, 0.3], colorMid: [1.0, 0.38, 0.1], colorEnd: [0.6, 0.06, 0.02],
        intensity: 0.9, gravity: 1.2, drag: 1.0, turbStrength: 1.3, turbFreq: 1.2,
        flicker: 0.4, flickerFreq: 11, light: true, lightRange: 16.0,
      },
      {
        name: "Heat", kind: 0, blend: 0, rate: 18, offset: [0, 1.2, 0], dir: [0, 1, 0],
        spread: 0.5, speed: 2.0, speedVar: 0.4, size: 1.1, sizeEnd: 1.6, life: 1.2, lifeVar: 0.3,
        color: [0.05, 0.04, 0.03], colorEnd: [0.02, 0.02, 0.02], intensity: 0.15,
        gravity: 0.9, drag: 1.2, distort: 0.5, turbStrength: 0.6,
      },
      {
        name: "Smoke", kind: 2, blend: 1, rate: 16, offset: [0, 2.2, 0], dir: [0, 1, 0],
        spread: 0.28, speed: 1.8, speedVar: 0.5, size: 1.0, sizeMid: 1.8, sizeEnd: 3.0,
        life: 3.2, lifeVar: 0.6, color: [0.18, 0.17, 0.16], colorEnd: [0.05, 0.05, 0.05],
        intensity: 0.55, gravity: 0.5, drag: 1.6, turbStrength: 1.2, turbFreq: 0.5,
      },
      {
        name: "Embers", kind: 3, blend: 0, rate: 16, dir: [0, 1, 0], spread: 0.65,
        speed: 4.5, speedVar: 1.6, size: 0.09, sizeEnd: 0.0, life: 2.4, lifeVar: 0.8,
        color: [1.0, 0.78, 0.4], colorEnd: [0.85, 0.12, 0.02], intensity: 8.0,
        gravity: 0.3, drag: 0.45, stretch: 0.3, turbStrength: 1.8, turbFreq: 0.8, flicker: 0.7,
      },
    ],
  },
  {
    id: "heat_haze",
    title: "陽炎（熱で歪む空気）",
    summary: "見えない粒で画面だけ歪ませる。砂漠・エンジン・溶岩の上に置く。",
    tags: ["distort", "loop", "invisible"],
    sizeHint: "歪む幅 約 2m",
    notes: [
      "粒自体はほぼ黒(intensity 0.1)。『見えないのにバグに見える』ので、置いたら必ず dx12_vfx_preview で確認すること。",
      "distort はポスト前のシーン RT を歪ませる。screenshot(sceneRT) では出るが、UI には掛からない。",
    ],
    layers: [
      {
        name: "Haze", kind: 0, blend: 0, rate: 14, dir: [0, 1, 0], spread: 0.7,
        speed: 1.1, speedVar: 0.3, size: 0.9, sizeEnd: 1.4, life: 1.6, lifeVar: 0.4,
        color: [0.03, 0.03, 0.03], colorEnd: [0.01, 0.01, 0.01], intensity: 0.1,
        gravity: 0.5, drag: 1.3, distort: 0.6, turbStrength: 0.5, turbFreq: 1.4,
      },
    ],
  },
  {
    id: "ember_drift",
    title: "漂う火の粉",
    summary: "空中をゆっくり舞う残り火。戦場跡・溶岩地帯の空気感。",
    tags: ["ambient", "loop", "fire"],
    sizeHint: "半径 約 4m にばらける",
    notes: ["広い範囲に撒きたいときは、この放出器を 3〜4 個 dx12_scatter で散らすのが安い。"],
    layers: [
      {
        name: "Embers", kind: 3, blend: 0, rate: 12, dir: [0, 1, 0], spread: 1.4,
        speed: 0.8, speedVar: 0.5, size: 0.055, sizeEnd: 0.0, life: 4.0, lifeVar: 1.2,
        color: [1.0, 0.6, 0.25], colorEnd: [0.7, 0.1, 0.02], intensity: 6.0,
        gravity: 0.12, drag: 0.35, turbStrength: 1.6, turbFreq: 0.5, flicker: 0.8, flickerFreq: 5,
      },
    ],
  },

  // ── 煙・霧・埃 ────────────────────────────────────────────
  {
    id: "chimney_smoke",
    title: "煙突の煙",
    summary: "ゆっくり立ち上って広がる煙。家・工場・列車の煙突に。",
    tags: ["smoke", "loop"],
    sizeHint: "高さ 約 6m まで立ち上る",
    notes: ["風で流したいなら dir を [0.3, 1, 0] のように傾ける(dir は速度の向き)。"],
    layers: [
      {
        name: "Smoke", kind: 2, blend: 1, rate: 10, dir: [0, 1, 0], spread: 0.18,
        speed: 1.6, speedVar: 0.4, size: 0.4, sizeMid: 1.0, sizeEnd: 2.2, life: 4.0, lifeVar: 0.8,
        color: [0.28, 0.27, 0.26], colorEnd: [0.1, 0.1, 0.1], intensity: 0.6,
        gravity: 0.25, drag: 1.5, turbStrength: 0.9, turbFreq: 0.4,
      },
    ],
  },
  {
    id: "steam_vent",
    title: "蒸気の噴出",
    summary: "白い蒸気が勢いよく吹き出す。配管・温泉・マンホール。",
    tags: ["smoke", "loop"],
    sizeHint: "到達 約 2.5m",
    notes: ["横向きに吹かせるなら dir を [1,0,0] 等にして、エンティティを回転させず dir で向きを決める。"],
    layers: [
      {
        name: "Steam", kind: 2, blend: 1, rate: 30, dir: [0, 1, 0], spread: 0.22,
        speed: 3.2, speedVar: 0.7, size: 0.18, sizeMid: 0.5, sizeEnd: 1.1, life: 1.4, lifeVar: 0.35,
        color: [0.85, 0.87, 0.9], colorEnd: [0.5, 0.53, 0.58], intensity: 0.9,
        gravity: 0.6, drag: 1.8, turbStrength: 0.7, turbFreq: 1.0,
      },
    ],
  },
  {
    id: "ground_mist",
    title: "地を這う霧",
    summary: "床に寝かせた薄い霧。墓地・森・ダンジョンの床面。",
    tags: ["smoke", "loop", "ambient"],
    sizeHint: "半径 約 5m を覆う",
    notes: [
      "orient:1(水平)なので床すれすれ(y=+0.1)に置くこと。ビルボードだと板が立って見える。",
      "床を覆いたいだけなら dx12_set_volumetric_fog の heightFalloff を使う方が安い。粒でやるのは『動く霧』が欲しいとき。",
    ],
    layers: [
      {
        name: "Mist", kind: 2, blend: 1, orient: 1, rate: 6, dir: [0, 0.15, 0], spread: 1.6,
        speed: 0.35, speedVar: 0.15, size: 2.6, sizeMid: 3.4, sizeEnd: 4.2, life: 7.0, lifeVar: 1.5,
        color: [0.5, 0.54, 0.6], colorEnd: [0.3, 0.33, 0.4], intensity: 0.35,
        gravity: 0.0, drag: 2.0, turbStrength: 0.35, turbFreq: 0.25,
      },
    ],
  },
  {
    id: "dust_puff",
    title: "砂埃（ワンショット）",
    summary: "着地・落下・崩落の瞬間に一度だけ出る土煙。",
    tags: ["smoke", "oneshot", "impact"],
    sizeHint: "半径 約 1.5m",
    notes: [
      "playOnStart=false / looping=false。Trigger の PlayEffect か Lua の emitter 起動で鳴らす。",
      "地面の色に合わせて color を変えると一気に馴染む（砂=[0.76,0.68,0.5] / 土=[0.4,0.32,0.24] / 雪=[0.9,0.92,0.95]）。",
    ],
    layers: [
      {
        name: "Dust", kind: 2, blend: 1, rate: 90, playOnStart: false, looping: false, duration: 0.25,
        dir: [0, 0.35, 0], spread: 1.3, speed: 3.0, speedVar: 1.0,
        size: 0.35, sizeMid: 0.8, sizeEnd: 1.3, life: 1.3, lifeVar: 0.4,
        color: [0.62, 0.56, 0.45], colorEnd: [0.35, 0.32, 0.28], intensity: 0.7,
        gravity: -0.5, drag: 2.2, turbStrength: 0.6, turbFreq: 0.9,
      },
    ],
  },
  {
    id: "footstep_dust",
    title: "足元の土煙（ワンショット）",
    summary: "歩く・走るたびに足元へ出す小さな埃。Lua から毎歩鳴らす前提。",
    tags: ["smoke", "oneshot", "small"],
    sizeHint: "半径 約 0.4m",
    notes: ["プレイヤーの子に置いて、着地/歩数のタイミングで PlayEffect する。常時 looping にしないこと。"],
    layers: [
      {
        name: "Dust", kind: 2, blend: 1, rate: 40, playOnStart: false, looping: false, duration: 0.12,
        dir: [0, 0.4, 0], spread: 1.1, speed: 1.1, speedVar: 0.5,
        size: 0.12, sizeMid: 0.26, sizeEnd: 0.4, life: 0.6, lifeVar: 0.2,
        color: [0.6, 0.55, 0.46], colorEnd: [0.34, 0.31, 0.27], intensity: 0.6,
        gravity: -0.3, drag: 2.5, turbStrength: 0.3,
      },
    ],
  },

  // ── 魔法・神秘 ────────────────────────────────────────────
  {
    id: "magic_circle",
    title: "魔法陣",
    summary: "床に広がるリング + 中心の光 + 立ち上る星屑。召喚・セーブポイント・祭壇。",
    tags: ["magic", "loop", "light"],
    sizeHint: "直径 約 3m",
    notes: [
      "Ring レイヤーは orient:1(水平)。床から y=+0.05 に置くと Z ファイトしない。",
      "色を変えるだけで性格が変わる（青=神聖 / 紫=禁呪 / 緑=自然 / 赤=呪い）。color 引数を使うこと。",
    ],
    lookHint: "暗い場所 + bloom 強めで映える。dx12_set_post_process bloomOn=true bloom=0.6 推奨。",
    layers: [
      {
        name: "Ring", kind: 6, blend: 0, orient: 1, rate: 10, dir: [0, 0.02, 0], spread: 0.05,
        speed: 0.05, speedVar: 0.0, size: 2.4, sizeMid: 2.8, sizeEnd: 3.0, life: 2.2, lifeVar: 0.2,
        color: [0.25, 0.65, 1.0], colorEnd: [0.08, 0.25, 0.95], intensity: 2.6,
        gravity: 0.0, drag: 2.0, flicker: 0.15, flickerFreq: 3,
      },
      {
        name: "Core", kind: 0, blend: 0, rate: 6, offset: [0, 0.25, 0], dir: [0, 1, 0], spread: 0.2,
        speed: 0.3, speedVar: 0.1, size: 0.45, sizeEnd: 0.1, life: 1.6, lifeVar: 0.3,
        color: [0.35, 0.75, 1.0], colorEnd: [0.1, 0.3, 1.0], intensity: 0.9,
        gravity: 0.15, drag: 1.5, flicker: 0.25, flickerFreq: 6, light: true, lightRange: 7.0,
      },
      {
        name: "Motes", kind: 7, blend: 0, rate: 14, dir: [0, 1, 0], spread: 0.9,
        speed: 1.1, speedVar: 0.5, size: 0.13, sizeEnd: 0.0, life: 2.4, lifeVar: 0.7,
        color: [0.5, 0.85, 1.0], colorEnd: [0.12, 0.35, 1.0], intensity: 4.5,
        gravity: 0.25, drag: 0.8, turbStrength: 0.9, turbFreq: 0.6, flicker: 0.5,
      },
    ],
  },
  {
    id: "portal_swirl",
    title: "次元の門",
    summary: "渦を巻く魔法の膜 + 縁の放電。ワープ先・ボス登場口。",
    tags: ["magic", "loop", "light", "electric"],
    sizeHint: "直径 約 2.4m の縦面",
    notes: [
      "orient:2(垂直 XY 面)。門をくぐらせるならエンティティを Y 回転させても粒の向きは +Z 正対のまま(仕様)。"
        + "見せたい向きからカメラが入るように配置すること。",
    ],
    layers: [
      {
        name: "Membrane", kind: 4, blend: 0, orient: 2, rate: 45, dir: [0, 0, 0], spread: 1.6,
        speed: 0.9, speedVar: 0.4, size: 0.5, sizeMid: 0.35, sizeEnd: 0.0, life: 1.1, lifeVar: 0.3,
        color: [0.55, 0.18, 1.0], colorMid: [0.32, 0.1, 0.9], colorEnd: [0.08, 0.02, 0.5],
        intensity: 1.5, gravity: 0.0, drag: 1.2, turbStrength: 1.4, turbFreq: 1.6,
      },
      {
        name: "Arc", kind: 5, blend: 0, rate: 7, dir: [0, 1, 0], spread: 2.2,
        speed: 2.4, speedVar: 1.2, size: 0.16, sizeEnd: 0.0, life: 0.28, lifeVar: 0.15,
        color: [0.9, 0.7, 1.0], colorEnd: [0.35, 0.15, 0.9], intensity: 7.0,
        gravity: 0.0, drag: 0.5, stretch: 0.6, flicker: 0.9, flickerFreq: 24,
      },
      {
        name: "Glow", kind: 0, blend: 0, rate: 4, dir: [0, 0, 0], spread: 0.3,
        speed: 0.1, speedVar: 0.05, size: 1.2, sizeEnd: 0.8, life: 1.4, lifeVar: 0.2,
        color: [0.5, 0.25, 0.95], colorEnd: [0.15, 0.05, 0.5], intensity: 0.6,
        drag: 2.0, light: true, lightRange: 8.0, flicker: 0.3, flickerFreq: 5,
      },
    ],
  },
  {
    id: "heal_aura",
    title: "回復のオーラ",
    summary: "足元から立ち上る優しい光の粒。回復・バフ・聖域。",
    tags: ["magic", "loop"],
    sizeHint: "直径 約 1.2m / 高さ 2m",
    notes: ["キャラの子エンティティにして原点を足元へ置く。回復中だけ出すなら looping=false + duration で。"],
    layers: [
      {
        name: "Motes", kind: 7, blend: 0, rate: 18, dir: [0, 1, 0], spread: 0.55,
        speed: 1.3, speedVar: 0.4, size: 0.11, sizeEnd: 0.0, life: 1.6, lifeVar: 0.4,
        color: [0.45, 1.0, 0.5], colorEnd: [0.08, 0.8, 0.25], intensity: 4.0,
        gravity: 0.35, drag: 0.9, turbStrength: 0.5, turbFreq: 0.8, flicker: 0.35,
      },
      {
        name: "Ring", kind: 6, blend: 0, orient: 1, rate: 3, dir: [0, 0.6, 0], spread: 0.05,
        speed: 0.55, speedVar: 0.0, size: 1.0, sizeMid: 1.1, sizeEnd: 0.9, life: 1.4, lifeVar: 0.1,
        color: [0.6, 1.0, 0.7], colorEnd: [0.1, 0.7, 0.3], intensity: 2.0, drag: 1.4,
      },
    ],
  },
  {
    id: "soul_wisp",
    title: "人魂・導きの光",
    summary: "ふわふわ漂う 1 つの光球と尾。案内役・幽霊・妖精。",
    tags: ["magic", "loop", "light", "trail"],
    sizeHint: "光球 直径 約 0.3m",
    notes: [
      "TrailRenderer 付き。動かして初めて尾が出る（止まっていると尾は縮んで消える）。",
      "Lua で位置を動かす前提。止め置きなら trail は不要。",
    ],
    layers: [
      {
        name: "Core", kind: 0, blend: 0, rate: 24, dir: [0, 0, 0], spread: 0.25,
        speed: 0.25, speedVar: 0.1, size: 0.3, sizeEnd: 0.05, life: 0.5, lifeVar: 0.15,
        color: [0.35, 0.75, 1.0], colorEnd: [0.08, 0.3, 0.9], intensity: 2.4,
        drag: 1.6, flicker: 0.4, flickerFreq: 7, light: true, lightRange: 5.0,
      },
      {
        name: "Motes", kind: 7, blend: 0, rate: 8, dir: [0, -1, 0], spread: 1.2,
        speed: 0.4, speedVar: 0.25, size: 0.06, sizeEnd: 0.0, life: 1.2, lifeVar: 0.4,
        color: [0.5, 0.85, 1.0], colorEnd: [0.1, 0.3, 0.8], intensity: 3.5,
        gravity: -0.2, drag: 1.0, turbStrength: 0.8,
      },
    ],
    trail: {
      width: 0.16, life: 0.45, color: [0.5, 0.9, 1.0], colorEnd: [0.08, 0.2, 0.8],
      intensity: 1.8, blend: 0, minDist: 0.02,
    },
  },

  // ── 衝撃・戦闘 ────────────────────────────────────────────
  {
    id: "explosion",
    title: "爆発（ワンショット）",
    summary: "閃光 → 火球 → 黒煙 → 飛び散る破片。5 レイヤーの合わせ技。",
    tags: ["fire", "oneshot", "impact", "light"],
    sizeHint: "火球 直径 約 3m",
    notes: [
      "playOnStart=false。Trigger の PlayEffect / Lua から鳴らす。鳴らし終わっても粒が消えるまで約 3 秒かかる。",
      "同じ場所で連発するなら放出器を 2 個用意して交互に鳴らすと途切れない。",
      "画面全体を揺らす演出は dx12_sequence_author の shake トラックで足すこと（粒だけでは揺れない）。",
    ],
    lookHint: "motionBlurOn + bloom 強めで迫力が出る。爆発の瞬間に post の exposure を一瞬上げるとさらに効く。",
    layers: [
      {
        name: "Flash", kind: 0, blend: 0, rate: 60, playOnStart: false, looping: false, duration: 0.06,
        dir: [0, 0, 0], spread: 0.4, speed: 0.5, speedVar: 0.2,
        size: 2.6, sizeEnd: 0.4, life: 0.18, lifeVar: 0.05,
        color: [1.0, 0.95, 0.8], colorEnd: [1.0, 0.5, 0.15], intensity: 5.0,
        drag: 2.5, light: true, lightRange: 18.0,
      },
      {
        name: "Fireball", kind: 1, blend: 0, rate: 160, playOnStart: false, looping: false, duration: 0.22,
        dir: [0, 0.35, 0], spread: 1.6, speed: 6.5, speedVar: 2.2,
        size: 0.8, sizeMid: 1.1, sizeEnd: 0.0, life: 0.8, lifeVar: 0.3,
        color: [1.0, 0.7, 0.25], colorMid: [1.0, 0.3, 0.05], colorEnd: [0.4, 0.05, 0.01],
        intensity: 1.2, gravity: 0.9, drag: 2.0, turbStrength: 1.2, turbFreq: 1.4,
      },
      {
        name: "Shock", kind: 6, blend: 0, orient: 1, rate: 20, playOnStart: false, looping: false, duration: 0.05,
        dir: [0, 0.05, 0], spread: 0.02, speed: 0.1, speedVar: 0.0,
        size: 0.6, sizeMid: 3.2, sizeEnd: 5.0, life: 0.45, lifeVar: 0.05,
        color: [1.0, 0.9, 0.7], colorEnd: [0.6, 0.3, 0.1], intensity: 4.0,
        drag: 1.0, distort: 0.7,
      },
      {
        name: "Smoke", kind: 2, blend: 1, rate: 70, playOnStart: false, looping: false, duration: 0.5,
        dir: [0, 0.5, 0], spread: 1.4, speed: 3.0, speedVar: 1.2,
        size: 0.9, sizeMid: 1.8, sizeEnd: 3.0, life: 2.6, lifeVar: 0.8,
        color: [0.16, 0.15, 0.14], colorEnd: [0.05, 0.05, 0.05], intensity: 0.6,
        gravity: 0.35, drag: 1.8, turbStrength: 1.4, turbFreq: 0.7,
      },
      {
        name: "Debris", kind: 3, blend: 0, rate: 120, playOnStart: false, looping: false, duration: 0.15,
        dir: [0, 0.6, 0], spread: 1.7, speed: 11.0, speedVar: 4.0,
        size: 0.09, sizeEnd: 0.0, life: 1.4, lifeVar: 0.6,
        color: [1.0, 0.8, 0.45], colorEnd: [0.8, 0.15, 0.03], intensity: 7.5,
        gravity: -6.0, drag: 0.35, stretch: 0.5,
      },
    ],
  },
  {
    id: "impact_sparks",
    title: "金属の火花（ワンショット）",
    summary: "刃・弾・金属同士がぶつかった瞬間の火花。重力で落ちて跳ねる軌跡。",
    tags: ["spark", "oneshot", "impact"],
    sizeHint: "飛距離 約 1.5m",
    notes: ["dir を【面の法線方向】にすること。raycast の worldNormal をそのまま dir に渡すのが正解。"],
    layers: [
      {
        name: "Sparks", kind: 3, blend: 0, rate: 200, playOnStart: false, looping: false, duration: 0.08,
        dir: [0, 1, 0], spread: 1.2, speed: 7.0, speedVar: 3.0,
        size: 0.05, sizeEnd: 0.0, life: 0.5, lifeVar: 0.25,
        color: [1.0, 0.9, 0.6], colorEnd: [1.0, 0.35, 0.05], intensity: 9.0,
        gravity: -9.0, drag: 0.3, stretch: 0.7,
      },
      {
        name: "Flash", kind: 0, blend: 0, rate: 40, playOnStart: false, looping: false, duration: 0.03,
        dir: [0, 0, 0], spread: 0.3, speed: 0.2, size: 0.4, sizeEnd: 0.0, life: 0.1, lifeVar: 0.03,
        color: [1.0, 0.95, 0.75], colorEnd: [1.0, 0.5, 0.1], intensity: 8.0, drag: 2.0,
      },
    ],
  },
  {
    id: "muzzle_flash",
    title: "銃口の発砲炎（ワンショット）",
    summary: "1 発ぶんの閃光 + 前方へ抜ける火花 + 薄い硝煙。",
    tags: ["fire", "oneshot", "impact", "light"],
    sizeHint: "長さ 約 0.5m",
    notes: [
      "銃口の子にして dir を [0,0,1](前方)に。エンティティを回転させれば dir も回る。",
      "life が非常に短い。dx12_vfx_preview は frames を多め(8)・秒数を短め(0.3)にしないと写らない。",
    ],
    layers: [
      {
        name: "Flash", kind: 0, blend: 0, rate: 80, playOnStart: false, looping: false, duration: 0.03,
        dir: [0, 0, 1], spread: 0.35, speed: 1.2, speedVar: 0.4,
        size: 0.42, sizeEnd: 0.0, life: 0.07, lifeVar: 0.02,
        color: [1.0, 0.9, 0.6], colorEnd: [1.0, 0.4, 0.1], intensity: 6.0,
        drag: 2.0, light: true, lightRange: 6.0,
      },
      {
        name: "Sparks", kind: 3, blend: 0, rate: 120, playOnStart: false, looping: false, duration: 0.04,
        dir: [0, 0, 1], spread: 0.5, speed: 9.0, speedVar: 3.5,
        size: 0.035, sizeEnd: 0.0, life: 0.22, lifeVar: 0.1,
        color: [1.0, 0.85, 0.5], colorEnd: [1.0, 0.3, 0.05], intensity: 8.0,
        gravity: -3.0, drag: 0.4, stretch: 0.8,
      },
      {
        name: "Smoke", kind: 2, blend: 1, rate: 30, playOnStart: false, looping: false, duration: 0.1,
        dir: [0, 0.2, 1], spread: 0.6, speed: 1.6, speedVar: 0.6,
        size: 0.14, sizeMid: 0.3, sizeEnd: 0.5, life: 0.9, lifeVar: 0.3,
        color: [0.35, 0.34, 0.33], colorEnd: [0.12, 0.12, 0.12], intensity: 0.5,
        gravity: 0.3, drag: 2.0, turbStrength: 0.5,
      },
    ],
  },
  {
    id: "blood_burst",
    title: "血しぶき（ワンショット）",
    summary: "被弾の瞬間に飛ぶ暗赤の飛沫と霧。前乗算アルファなので光らない。",
    tags: ["oneshot", "impact"],
    sizeHint: "飛距離 約 1.2m",
    notes: [
      "加算にすると【赤く光って】しまい血に見えない。blend=1 を崩さないこと。",
      "床に跡を残したいなら decal(DecalComponent)を別途置く。粒だけでは跡は残らない。",
    ],
    layers: [
      {
        name: "Spray", kind: 3, blend: 1, rate: 150, playOnStart: false, looping: false, duration: 0.1,
        dir: [0, 0.3, 1], spread: 0.9, speed: 5.5, speedVar: 2.5,
        size: 0.07, sizeEnd: 0.03, life: 0.6, lifeVar: 0.25,
        color: [0.5, 0.03, 0.03], colorEnd: [0.18, 0.01, 0.01], intensity: 0.9,
        gravity: -9.0, drag: 0.8, stretch: 0.35,
      },
      {
        name: "Mist", kind: 2, blend: 1, rate: 50, playOnStart: false, looping: false, duration: 0.12,
        dir: [0, 0.4, 1], spread: 1.1, speed: 2.0, speedVar: 0.8,
        size: 0.16, sizeMid: 0.3, sizeEnd: 0.45, life: 0.7, lifeVar: 0.25,
        color: [0.32, 0.02, 0.02], colorEnd: [0.1, 0.01, 0.01], intensity: 0.7,
        gravity: -1.5, drag: 2.2, turbStrength: 0.5,
      },
    ],
  },
  {
    id: "shockwave_ring",
    title: "衝撃波リング（ワンショット）",
    summary: "床を走る 1 本の輪。着地・必殺技・ボスの咆哮。歪み付き。",
    tags: ["oneshot", "impact", "distort"],
    sizeHint: "最大直径 約 8m",
    notes: ["orient:1(水平)。床から y=+0.1。垂直に出したいなら orient を 0 にして spread を 0 にする。"],
    layers: [
      {
        name: "Ring", kind: 6, blend: 0, orient: 1, rate: 24, playOnStart: false, looping: false, duration: 0.06,
        dir: [0, 0.02, 0], spread: 0.02, speed: 0.1, speedVar: 0.0,
        size: 0.8, sizeMid: 4.5, sizeEnd: 8.0, life: 0.6, lifeVar: 0.05,
        color: [0.9, 0.95, 1.0], colorEnd: [0.2, 0.5, 1.0], intensity: 4.5,
        drag: 1.0, distort: 0.8,
      },
    ],
  },

  // ── 天候・環境 ────────────────────────────────────────────
  {
    id: "rain",
    title: "雨",
    summary: "上空から降る雨粒。速度方向に伸びた線で降る。",
    tags: ["weather", "loop", "gpu"],
    sizeHint: "半径 約 12m の範囲に降る",
    notes: [
      "★放出は【1 点から円錐状】。プレイヤーの真上 8〜12m に置き、Lua でプレイヤーに追従させるのが定石"
        + "（置きっぱなしだと歩いて範囲外へ出る）。",
      "gpu=true（大量の粒を安く出すため）。GPU 粒は加算専用なので、色を暗くして『線』として見せている。",
      "地面の跳ね返りは別途 rain_splash 的なワンショットを足すこと。",
    ],
    lookHint: "濡れた路面(roughness を下げる) + ssr を入れると雨らしさが跳ね上がる。",
    layers: [
      {
        name: "Drops", kind: 3, blend: 0, rate: 600, dir: [0, -1, 0], spread: 0.9,
        speed: 16.0, speedVar: 3.0, size: 0.035, sizeEnd: 0.035, life: 1.1, lifeVar: 0.2,
        color: [0.45, 0.52, 0.62], colorEnd: [0.25, 0.3, 0.4], intensity: 1.2,
        gravity: -6.0, drag: 0.05, stretch: 1.6, gpu: true,
      },
    ],
  },
  {
    id: "snow",
    title: "雪",
    summary: "ゆっくり舞い落ちる雪片。乱流で横に流れる。",
    tags: ["weather", "loop"],
    sizeHint: "半径 約 10m の範囲に降る",
    notes: ["雨と同じくプレイヤーの上に追従させること。life が長いので rate を上げすぎると 8000 粒の上限に当たる。"],
    layers: [
      {
        name: "Flakes", kind: 0, blend: 1, rate: 120, dir: [0, -1, 0], spread: 1.0,
        speed: 1.2, speedVar: 0.5, size: 0.07, sizeEnd: 0.07, life: 6.0, lifeVar: 1.5,
        color: [0.95, 0.97, 1.0], colorEnd: [0.8, 0.85, 0.95], intensity: 1.0,
        gravity: -0.35, drag: 1.2, turbStrength: 1.3, turbFreq: 0.35,
      },
    ],
  },
  {
    id: "fireflies",
    title: "蛍・妖精の光",
    summary: "明滅しながら漂う小さな光点。夜の森・沼・洞窟。",
    tags: ["ambient", "loop", "magic"],
    sizeHint: "半径 約 5m に漂う",
    notes: ["flicker が高いので『点いたり消えたり』する。intensity を下げすぎると消えている時間が全く見えなくなる。"],
    layers: [
      {
        name: "Flies", kind: 0, blend: 0, rate: 6, dir: [0, 0.2, 0], spread: 1.8,
        speed: 0.45, speedVar: 0.3, size: 0.05, sizeEnd: 0.05, life: 6.0, lifeVar: 2.0,
        color: [0.8, 1.0, 0.4], colorEnd: [0.35, 0.8, 0.15], intensity: 5.0,
        gravity: 0.02, drag: 0.8, turbStrength: 1.1, turbFreq: 0.3, flicker: 0.95, flickerFreq: 3.5,
      },
    ],
  },
  {
    id: "dust_motes",
    title: "光に舞う埃",
    summary: "光の筋の中でゆっくり漂う細かい埃。窓・天窓・廃墟の空気。",
    tags: ["ambient", "loop", "small"],
    sizeHint: "半径 約 3m",
    notes: [
      "これ単体では地味。ゴッドレイ(dx12_set_post_process godraysOn) かボリュメトリックフォグと併せて初めて効く。",
      "屋内の『空気が澱んでいる』感じは、この効果 1 つで別物になる（安い割に効果が大きい）。",
    ],
    layers: [
      {
        name: "Motes", kind: 0, blend: 0, rate: 22, dir: [0, -0.15, 0], spread: 1.9,
        speed: 0.12, speedVar: 0.08, size: 0.022, sizeEnd: 0.022, life: 9.0, lifeVar: 3.0,
        color: [1.0, 0.95, 0.85], colorEnd: [0.8, 0.75, 0.65], intensity: 2.2,
        gravity: -0.01, drag: 1.0, turbStrength: 0.5, turbFreq: 0.2, flicker: 0.35, flickerFreq: 1.5,
      },
    ],
  },
  {
    id: "falling_leaves",
    title: "舞い落ちる葉",
    summary: "ひらひら落ちる木の葉。乱流でゆっくり回り込む。",
    tags: ["weather", "loop", "ambient"],
    sizeHint: "半径 約 6m",
    notes: ["色は季節で変える（秋=[0.8,0.35,0.1] / 春の桜=[1.0,0.75,0.8] / 常緑=[0.3,0.5,0.2]）。"],
    layers: [
      {
        name: "Leaves", kind: 0, blend: 1, rate: 8, dir: [0, -1, 0], spread: 1.1,
        speed: 0.9, speedVar: 0.4, size: 0.14, sizeEnd: 0.14, life: 7.0, lifeVar: 2.0,
        color: [0.85, 0.42, 0.12], colorEnd: [0.5, 0.25, 0.06], intensity: 0.9,
        gravity: -0.5, drag: 1.4, turbStrength: 2.0, turbFreq: 0.4,
      },
    ],
  },
  {
    id: "ash_fall",
    title: "降る灰",
    summary: "火山灰・焼け跡の灰。雪より暗く、ゆっくり。",
    tags: ["weather", "loop", "ambient"],
    sizeHint: "半径 約 10m",
    notes: ["暗い粒なので明るい空を背景にすると見える。曇天・夕暮れの look と相性が良い。"],
    layers: [
      {
        name: "Ash", kind: 0, blend: 1, rate: 70, dir: [0, -1, 0], spread: 1.0,
        speed: 0.8, speedVar: 0.4, size: 0.05, sizeEnd: 0.05, life: 7.0, lifeVar: 2.0,
        color: [0.32, 0.3, 0.29], colorEnd: [0.18, 0.17, 0.16], intensity: 0.8,
        gravity: -0.25, drag: 1.3, turbStrength: 1.0, turbFreq: 0.3,
      },
    ],
  },

  // ── 水 ────────────────────────────────────────────────────
  {
    id: "water_splash",
    title: "水しぶき（ワンショット）",
    summary: "着水の瞬間に上がる水柱と飛沫。",
    tags: ["water", "oneshot", "impact"],
    sizeHint: "高さ 約 1.5m",
    notes: ["水面の位置に置く。加算だと光る水になるので blend=1 のままにすること。"],
    layers: [
      {
        name: "Crown", kind: 2, blend: 1, rate: 90, playOnStart: false, looping: false, duration: 0.12,
        dir: [0, 1, 0], spread: 0.55, speed: 4.0, speedVar: 1.4,
        size: 0.2, sizeMid: 0.35, sizeEnd: 0.5, life: 0.8, lifeVar: 0.25,
        color: [0.7, 0.8, 0.88], colorEnd: [0.4, 0.5, 0.62], intensity: 1.0,
        gravity: -7.0, drag: 1.2, turbStrength: 0.4,
      },
      {
        name: "Droplets", kind: 3, blend: 1, rate: 120, playOnStart: false, looping: false, duration: 0.1,
        dir: [0, 1, 0], spread: 1.0, speed: 6.0, speedVar: 2.5,
        size: 0.045, sizeEnd: 0.03, life: 0.9, lifeVar: 0.3,
        color: [0.75, 0.85, 0.95], colorEnd: [0.45, 0.55, 0.7], intensity: 1.3,
        gravity: -9.5, drag: 0.4, stretch: 0.3,
      },
    ],
  },
  {
    id: "waterfall_mist",
    title: "滝壺の飛沫",
    summary: "落下点で立ち上る白い霧と跳ねる水滴。虹が出そうな空気。",
    tags: ["water", "loop"],
    sizeHint: "高さ 約 3m",
    notes: ["滝の【下端】に置く。上から落ちる水そのものは別途メッシュ/シェーダで作ること。"],
    layers: [
      {
        name: "Mist", kind: 2, blend: 1, rate: 26, dir: [0, 1, 0], spread: 0.8,
        speed: 1.6, speedVar: 0.6, size: 0.5, sizeMid: 1.1, sizeEnd: 1.8, life: 2.4, lifeVar: 0.7,
        color: [0.82, 0.88, 0.92], colorEnd: [0.5, 0.58, 0.65], intensity: 0.85,
        gravity: 0.35, drag: 1.7, turbStrength: 0.9, turbFreq: 0.6,
      },
      {
        name: "Droplets", kind: 3, blend: 1, rate: 24, dir: [0, 1, 0], spread: 1.1,
        speed: 3.4, speedVar: 1.5, size: 0.04, sizeEnd: 0.03, life: 1.0, lifeVar: 0.4,
        color: [0.85, 0.9, 0.96], colorEnd: [0.5, 0.6, 0.72], intensity: 1.4,
        gravity: -8.0, drag: 0.5, stretch: 0.25,
      },
    ],
  },
  {
    id: "bubbles",
    title: "水中の泡",
    summary: "ゆらゆら上がる泡。水中・沼・薬瓶。",
    tags: ["water", "loop"],
    sizeHint: "上昇 約 3m",
    notes: ["水面の高さで消したいなら life を『水深 ÷ speed』に合わせる。当たり判定は無い。"],
    layers: [
      {
        name: "Bubbles", kind: 0, blend: 1, rate: 14, dir: [0, 1, 0], spread: 0.4,
        speed: 0.9, speedVar: 0.4, size: 0.06, sizeMid: 0.08, sizeEnd: 0.1, life: 3.2, lifeVar: 1.0,
        color: [0.75, 0.88, 0.95], colorEnd: [0.55, 0.7, 0.85], intensity: 1.1,
        gravity: 0.25, drag: 1.0, turbStrength: 0.8, turbFreq: 0.7,
      },
    ],
  },

  // ── 電気・エネルギー ──────────────────────────────────────
  {
    id: "electric_arc",
    title: "放電・漏電",
    summary: "パチパチ弾ける電弧。壊れた機械・感電・雷属性。",
    tags: ["electric", "loop", "light"],
    sizeHint: "半径 約 0.8m",
    notes: ["flickerFreq が高いので、1 フレームだけ撮ると写らないことがある。preview は frames を多めに。"],
    layers: [
      {
        name: "Arcs", kind: 5, blend: 0, rate: 16, dir: [0, 0, 0], spread: 2.0,
        speed: 3.0, speedVar: 1.5, size: 0.2, sizeEnd: 0.0, life: 0.18, lifeVar: 0.1,
        color: [0.75, 0.9, 1.0], colorEnd: [0.2, 0.45, 1.0], intensity: 5.0,
        gravity: 0.0, drag: 0.6, stretch: 0.55, flicker: 1.0, flickerFreq: 30,
        light: true, lightRange: 5.0,
      },
      {
        name: "Sparks", kind: 3, blend: 0, rate: 10, dir: [0, -0.3, 0], spread: 1.5,
        speed: 4.0, speedVar: 2.0, size: 0.035, sizeEnd: 0.0, life: 0.4, lifeVar: 0.2,
        color: [0.9, 0.95, 1.0], colorEnd: [0.3, 0.5, 1.0], intensity: 7.0,
        gravity: -8.0, drag: 0.4, stretch: 0.6,
      },
    ],
  },
  {
    id: "energy_orb",
    title: "エネルギー球",
    summary: "回転する光の核 + 吸い込まれる粒。チャージ・コア・弱点。",
    tags: ["magic", "loop", "light"],
    sizeHint: "直径 約 0.8m",
    notes: ["『吸い込み』は dir を内向きにできないため、外側で生まれて drag で減速する見せ方にしてある。"],
    layers: [
      {
        name: "Core", kind: 0, blend: 0, rate: 22, dir: [0, 0, 0], spread: 0.15,
        speed: 0.2, speedVar: 0.1, size: 0.45, sizeMid: 0.34, sizeEnd: 0.06, life: 0.55, lifeVar: 0.15,
        color: [0.35, 0.72, 1.0], colorMid: [0.18, 0.5, 1.0], colorEnd: [0.06, 0.16, 0.9],
        intensity: 0.9, drag: 2.0, flicker: 0.3, flickerFreq: 12, light: true, lightRange: 7.0,
      },
      {
        name: "Orbit", kind: 7, blend: 0, rate: 26, dir: [0, 0, 0], spread: 2.5,
        speed: 1.6, speedVar: 0.6, size: 0.09, sizeEnd: 0.0, life: 0.7, lifeVar: 0.25,
        color: [0.8, 0.95, 1.0], colorEnd: [0.15, 0.35, 1.0], intensity: 6.0,
        drag: 2.6, turbStrength: 1.5, turbFreq: 2.0,
      },
    ],
  },

  // ── トレイル（尾）──────────────────────────────────────────
  {
    id: "sword_trail",
    title: "剣閃（トレイル）",
    summary: "振った軌跡が残る帯。粒は出さず TrailRenderer だけ。",
    tags: ["trail", "combat"],
    sizeHint: "帯の幅 約 0.25m",
    notes: [
      "★動かさないと何も出ない。剣の【先端】の子エンティティに付けて、アニメーションで振ること。",
      "常時出っぱなしが嫌なら、Lua で trailRenderer.emitting を false にすると尾が自然に消える。",
    ],
    layers: [],
    trail: {
      width: 0.25, life: 0.32, color: [0.7, 0.9, 1.0], colorEnd: [0.1, 0.25, 0.9],
      intensity: 2.0, blend: 0, minDist: 0.03,
    },
  },
  {
    id: "projectile_trail",
    title: "弾道の尾",
    summary: "飛翔体の後ろに残る光の尾 + 散る火の粉。魔法弾・ロケット。",
    tags: ["trail", "magic", "loop"],
    sizeHint: "帯の幅 約 0.12m",
    notes: ["飛翔体エンティティ本体に付ける。止まっている間は尾が縮むだけで消えない（life ぶん残る）。"],
    layers: [
      {
        name: "Sparks", kind: 3, blend: 0, rate: 30, dir: [0, 0, -1], spread: 0.6,
        speed: 1.0, speedVar: 0.5, size: 0.05, sizeEnd: 0.0, life: 0.4, lifeVar: 0.2,
        color: [1.0, 0.8, 0.4], colorEnd: [0.9, 0.25, 0.05], intensity: 6.0,
        gravity: -0.5, drag: 1.2, stretch: 0.3, turbStrength: 0.6,
      },
    ],
    trail: {
      width: 0.12, life: 0.28, color: [1.0, 0.75, 0.35], colorEnd: [0.8, 0.15, 0.03],
      intensity: 2.4, blend: 0, minDist: 0.02,
    },
  },
];

export const VFX_IDS: string[] = VFX_PRESETS.map((p) => p.id);

export function findVfxPreset(id: string): VfxPreset | undefined {
  return VFX_PRESETS.find((p) => p.id === id);
}

// ════════════════════════════════════════════════════════════════
//  解決（プリセット + 倍率 → 実レイヤー）
// ════════════════════════════════════════════════════════════════

export type VfxOverrides = {
  /** 全体の大きさ倍率。size / speed / offset / gravity / lightRange / trail.width に掛かる。 */
  scale?: number;
  /** 放出レート倍率(粒の密度)。 */
  rate?: number;
  /** HDR 強度倍率(ブルームの乗り方)。 */
  intensity?: number;
  /** 主色の置き換え。colorMid/colorEnd は元レシピの明度比を保ったまま追従する。 */
  color?: Vec3;
  /** true で全レイヤーをワンショット化(looping=false)。false で常時放出へ。 */
  oneShot?: boolean;
  /** ワンショットの放出継続秒(oneShot=true のときだけ意味がある)。 */
  duration?: number;
  /** 実ポイントライト化の強制 ON/OFF(省略でレシピのまま)。 */
  light?: boolean;
  /** 粒の寿命倍率。長くすると滞空が増える＝粒数も増える。 */
  life?: number;
};

export type ResolvedVfx = {
  preset: VfxPreset;
  layers: LayerSpec[];
  trail?: TrailSpec;
  /** 同時に生きる粒のおおよその数(rate × life の合計)。CPU 粒の上限は 8000。 */
  estimatedLiveParticles: number;
  warnings: string[];
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const lum = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * 色の置き換え。元レシピの「開始色 → 終了色」の明度比だけを保って新しい色相へ移す。
 * ★単純に colorEnd も同じ色にすると、炎の「オレンジ→赤へ落ちる」ような減衰が消えて
 *   のっぺりした単色の粒になる(実際にそう見えた)。比を保つのはそのため。
 */
export function retintTo(base: Vec3, from: Vec3, to: Vec3): Vec3 {
  const lf = lum(from);
  const lt = lum(to);
  if (lf <= 0.0001) return [clamp01(base[0]), clamp01(base[1]), clamp01(base[2])];
  const ratio = lt / lf;
  return [clamp01(base[0] * ratio), clamp01(base[1] * ratio), clamp01(base[2] * ratio)];
}

/** レイヤー 1 枚に倍率を適用する。未指定の項目は触らない(エンジン既定のまま残す)。 */
export function applyOverrides(layer: LayerSpec, ov: VfxOverrides): LayerSpec {
  const s = ov.scale ?? 1;
  const out: LayerSpec = { ...layer };

  if (s !== 1) {
    out.size = round3(layer.size * s);
    if (layer.sizeMid !== undefined && layer.sizeMid >= 0) out.sizeMid = round3(layer.sizeMid * s);
    if (layer.sizeEnd !== undefined) out.sizeEnd = round3(layer.sizeEnd * s);
    if (layer.speed !== undefined) out.speed = round3(layer.speed * s);
    if (layer.speedVar !== undefined) out.speedVar = round3(layer.speedVar * s);
    if (layer.gravity !== undefined) out.gravity = round3(layer.gravity * s);
    if (layer.up !== undefined) out.up = round3(layer.up * s);
    if (layer.lightRange !== undefined) out.lightRange = round3(layer.lightRange * s);
    if (layer.offset) {
      out.offset = [round3(layer.offset[0] * s), round3(layer.offset[1] * s), round3(layer.offset[2] * s)];
    }
  }
  if (ov.rate !== undefined && ov.rate !== 1) out.rate = round3(layer.rate * ov.rate);
  if (ov.life !== undefined && ov.life !== 1) {
    out.life = round3(layer.life * ov.life);
    if (layer.lifeVar !== undefined) out.lifeVar = round3(layer.lifeVar * ov.life);
  }
  if (ov.intensity !== undefined && ov.intensity !== 1 && layer.intensity !== undefined) {
    out.intensity = round3(layer.intensity * ov.intensity);
  }
  if (ov.color) {
    // 煙・埃・血のような「色そのものが意味を持つ」層まで塗り替えると台無しになるので、
    // 加算(blend 0)の発光レイヤーだけを塗り替える。煙は元の色を保つ。
    const additive = (layer.blend ?? 0) === 0;
    if (additive) {
      const from = layer.color;
      out.color = [clamp01(ov.color[0]), clamp01(ov.color[1]), clamp01(ov.color[2])];
      out.colorEnd = retintTo(layer.colorEnd, from, ov.color);
      if (layer.colorMid) out.colorMid = retintTo(layer.colorMid, from, ov.color);
    }
  }
  if (ov.oneShot !== undefined) {
    out.looping = !ov.oneShot;
    if (ov.oneShot) {
      out.playOnStart = layer.playOnStart ?? false;
      out.duration = ov.duration ?? layer.duration ?? 0.3;
    } else {
      out.playOnStart = true;
    }
  } else if (ov.duration !== undefined && layer.looping === false) {
    out.duration = ov.duration;
  }
  if (ov.light !== undefined) out.light = ov.light;

  return out;
}

/** 同時生存粒のおおよその数。連続放出は rate×life、ワンショットは rate×duration で見る。 */
export function estimateLiveParticles(layers: LayerSpec[]): number {
  let n = 0;
  for (const l of layers) {
    if (l.gpu) continue;  // GPU 粒は別バッファ(最大 131072)なので CPU 上限には効かない
    const looping = l.looping !== false;
    const span = looping ? l.life : Math.min(l.life, l.duration ?? 0.3);
    n += l.rate * span;
  }
  return Math.round(n);
}

export function resolveVfx(id: string, ov: VfxOverrides = {}): ResolvedVfx {
  const preset = findVfxPreset(id);
  if (!preset) {
    throw new Error(
      `未知の VFX プリセット "${id}"。使えるのは: ${VFX_IDS.join(", ")}`,
    );
  }
  const layers = preset.layers.map((l) => applyOverrides(l, ov));
  const warnings: string[] = [];

  const lightLayers = layers.filter((l) => l.light).length;
  if (lightLayers > 0) {
    warnings.push(
      `実ポイントライト化するレイヤーが ${lightLayers} 枚ある。`
      + "ライトには上限があるので、同じ効果を 4 個以上並べるなら light:false で置いて、"
      + "代表 1 個だけ light:true にするか手でポイントライトを置くこと(dx12_list_lights で予算を見る)。",
    );
  }
  const live = estimateLiveParticles(layers);
  if (live > 2000) {
    warnings.push(
      `同時生存粒が約 ${live} 個。CPU パーティクルの上限は 8000(シーン全体)なので、`
      + "この効果を複数置くなら rate を下げるか life を短くすること。",
    );
  }
  for (const l of layers) {
    if (l.gpu && ((l.blend ?? 0) === 1 || (l.distort ?? 0) > 0 || l.light || (l.sizeMid ?? -1) >= 0)) {
      warnings.push(
        `レイヤー "${l.name}" は gpu=true だが、GPU パーティクルは `
        + "アルファブレンド / distort / light / sizeMid に非対応(黙って無視される)。",
      );
    }
    if ((l.distort ?? 0) > 0) {
      warnings.push(
        `レイヤー "${l.name}" は画面を歪ませる(distort=${l.distort})。TAA が有効だと尾を引くことがある。`,
      );
    }
  }
  if (ov.color && preset.layers.every((l) => (l.blend ?? 0) === 1)) {
    warnings.push(
      "color を渡したが、このレシピは加算レイヤーを持たない(煙/埃系)ため色は変わらない。"
      + "煙の色を変えたいなら dx12_set_component で layer を指定して直接書くこと。",
    );
  }

  return {
    preset,
    layers,
    trail: preset.trail,
    estimatedLiveParticles: live,
    warnings,
  };
}

/** ライブラリ一覧(tool の返り値用。レイヤーの中身までは返さず、選ぶのに要る情報だけ)。 */
export function describeLibrary(tag?: string): Array<Record<string, unknown>> {
  const list = tag ? VFX_PRESETS.filter((p) => p.tags.includes(tag)) : VFX_PRESETS;
  return list.map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    tags: p.tags,
    sizeHint: p.sizeHint,
    layers: p.layers.length,
    layerNames: p.layers.map((l) => l.name),
    hasTrail: !!p.trail,
    oneShot: p.layers.length > 0 && p.layers.every((l) => l.looping === false),
  }));
}

export const VFX_TAGS: string[] = Array.from(
  new Set(VFX_PRESETS.flatMap((p) => p.tags)),
).sort();

// ════════════════════════════════════════════════════════════════
//  プレビューの計測（「出ているのか」を絵を見ずに数える）
// ════════════════════════════════════════════════════════════════
// ★なぜ要るか: パーティクルは【時間方向にしか存在しない】。静止画 1 枚では
//   「1 フレームだけ写っていない」のか「そもそも出ていない」のか区別できない。
//   人間は連番を見れば分かるが、AI は数えないと分からないのでここで数える。
//   画面中央(既定 60%)だけを見るのは、背景の明るさに判定が引っ張られないようにするため。


export type FrameStat = {
  /** 効果が変えた画素の割合(%)。粒そのもの＋それが照らした場所を含む「影響範囲」。 */
  changedPct: number;
  /** 変えた画素だけの平均輝度。背景の明るさに引っ張られない。 */
  effectLuma: number;
  /** 変えた画素だけの最大輝度。 */
  effectPeak: number;
  /** 変えた画素のうち、地の絵より明るくなった上で飽和(輝度 0.97 超)している割合(%)。 */
  blownPct: number;
  /** 飽和した画素が【画面(中央窓)】に占める割合(%)。白い塊の大きさ。 */
  blownAreaPct: number;
  /** 直前フレームからの変化画素の割合(%)。粒が動いているか(1 枚目は null)。 */
  motionPct: number | null;
};

export type VfxMeasure = {
  frames: FrameStat[];
  /** 中央窓の「効果が無いときの絵」の平均輝度。 */
  sceneLuma: number;
  /** 地の絵をどうやって求めたか。"baseline"=効果を退けて実際に撮った / "median"=時間方向の中央値で推定。 */
  backgroundFrom: "baseline" | "median";
  /** 効果が見えていると判断できるか。 */
  visible: boolean;
  suggestions: string[];
};

const srgbLuma = (r: number, g: number, b: number): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** 中央 ratio の矩形だけを見る。ratio=0.6 なら中央 60%。 */
function centerWindow(png: PNG, ratio: number): { x0: number; y0: number; w: number; h: number } {
  const w = Math.max(1, Math.round(png.width * ratio));
  const h = Math.max(1, Math.round(png.height * ratio));
  return { x0: Math.floor((png.width - w) / 2), y0: Math.floor((png.height - h) / 2), w, h };
}

/** 中央窓の輝度を 1 次元配列で取り出す。 */
export function windowLuma(png: PNG, ratio = 0.6): { data: Float32Array; w: number; h: number } {
  const win = centerWindow(png, ratio);
  const out = new Float32Array(win.w * win.h);
  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      const i = ((win.y0 + y) * png.width + (win.x0 + x)) * 4;
      out[y * win.w + x] = srgbLuma(png.data[i], png.data[i + 1], png.data[i + 2]);
    }
  }
  return { data: out, w: win.w, h: win.h };
}

/**
 * 画素ごとの中央値による背景推定(baseline を撮れなかったときの代替)。
 *
 * ★限界: 【同じ場所で燃え続ける炎】のように時間で動かない効果は中央値に取り込まれてしまい、
 *   「効果ゼロ」に見える(実測で踏んだ)。だから既定では効果を一旦退けて撮る baseline を使う。
 */
export function medianBackground(frames: Float32Array[], n: number): Float32Array {
  const bg = new Float32Array(n);
  const tmp: number[] = new Array(frames.length);
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < frames.length; f++) tmp[f] = frames[f][i];
    tmp.sort((a, b) => a - b);
    const m = tmp.length >> 1;
    bg[i] = (tmp.length % 2) ? tmp[m] : (tmp[m - 1] + tmp[m]) / 2;
  }
  return bg;
}

/**
 * 連番フレームから「効果が出ているか / 出すぎていないか」を判定し、次の一手を返す。
 *
 * baseline を渡すと【効果が無い状態の絵】として使う(放出器を一時的に遠くへ退けて撮ったもの)。
 * 渡さないときは時間方向の中央値で代用する(上の限界あり)。
 * additive=true(加算系レシピ)のときだけ「暗すぎる」を見る(煙・雪は暗くて正常なので)。
 */
export function measureVfxFrames(
  pngBuffers: Buffer[],
  opts: { additive?: boolean; windowRatio?: number; baseline?: Buffer } = {},
): VfxMeasure {
  if (pngBuffers.length === 0) throw new Error("フレームが 1 枚もない。");
  const ratio = opts.windowRatio ?? 0.6;
  const wins = pngBuffers.map((b) => windowLuma(PNG.sync.read(b), ratio));
  const w = wins[0].w, h = wins[0].h;
  if (wins.some((v) => v.w !== w || v.h !== h)) {
    throw new Error("フレームの解像度が揃っていない(同じ画角で撮ること)。");
  }
  const n = w * h;

  let bg: Float32Array;
  let backgroundFrom: "baseline" | "median" = "median";
  if (opts.baseline) {
    const b = windowLuma(PNG.sync.read(opts.baseline), ratio);
    if (b.w !== w || b.h !== h) throw new Error("baseline の解像度がフレームと違う。");
    bg = b.data;
    backgroundFrom = "baseline";
  } else {
    bg = medianBackground(wins.map((v) => v.data), n);
  }

  let bgSum = 0;
  for (let i = 0; i < n; i++) bgSum += bg[i];
  const sceneLuma = round3(bgSum / Math.max(1, n));

  const DIFF = 0.09;   // 輝度差これ以上を「効果が変えた画素」とみなす(24/255 相当)
  const frames: FrameStat[] = wins.map((win, fi) => {
    let cnt = 0, sum = 0, peak = 0, blown = 0, moved = 0;
    const prev = fi > 0 ? wins[fi - 1].data : null;
    for (let i = 0; i < n; i++) {
      const l = win.data[i];
      if (prev && Math.abs(l - prev[i]) >= DIFF) moved++;
      const d = l - bg[i];
      if (d > -DIFF && d < DIFF) continue;
      cnt++;
      sum += l;
      if (l > peak) peak = l;
      if (d > 0 && l > 0.97) blown++;   // 地の絵より明るくなった上で飽和 = 粒が白く潰れている
    }
    return {
      changedPct: round3((cnt / Math.max(1, n)) * 100),
      effectLuma: cnt ? round3(sum / cnt) : 0,
      effectPeak: cnt ? round3(peak) : 0,
      blownPct: cnt ? round3((blown / cnt) * 100) : 0,
      blownAreaPct: round3((blown / Math.max(1, n)) * 100),
      motionPct: prev ? round3((moved / Math.max(1, n)) * 100) : null,
    };
  });

  const areas = frames.map((f) => f.changedPct);
  const maxArea = Math.max(...areas);
  const maxBlown = Math.max(...frames.map((f) => f.blownPct));
  const maxBlownArea = Math.max(...frames.map((f) => f.blownAreaPct));
  const motions = frames.map((f) => f.motionPct).filter((v): v is number => v != null);
  const maxPeak = Math.max(...frames.map((f) => f.effectPeak));
  const suggestions: string[] = [];

  // ① そもそも出ていない
  //    ★閾値は 0.05%(画面の 2000 画素に 1 個)まで下げてある。蛍・埃・火の粉のような
  //      まばらな環境効果は、正しく出ていても中央窓の 0.1〜0.5% しか占めない(実測)。
  //      0.3% を境にしていた頃は、それらを全部「出ていない」と誤判定していた。
  //    ★面積が足りなくても「地の絵よりはっきり明るい画素がある」なら出ていると見なす。
  //      蛍・埃・火の粉は画面の 0.01% しか占めないが、点として確かに光っている(実測)。
  const visible = maxArea >= 0.05 || (maxArea > 0 && maxPeak >= sceneLuma + 0.25);
  if (!visible) {
    suggestions.push(
      "効果が絵をほとんど変えていない。出ていない可能性が高い。確認する順番: "
      + "①looping=false のワンショットではないか(dx12_list_particle_layers の looping)。"
      + "ワンショットは dx12_vfx_preview(fire:true) か Trigger の PlayEffect で鳴らさないと出ない。"
      + "②カメラが効果を画角に入れているか / 手前の物に隠れていないか(distance を広げて撮り直す)。"
      + "③rate が 0 になっていないか。④粒が小さすぎないか(size)。"
      + "⑤★煙・埃・血・灰のような【暗い前乗算アルファの粒】は暗い背景では文字通り見えない。"
      + "明るい床や空を背にして撮り直すこと(暗所で確かめても何も分からない)。",
    );
  }
  // ② 白飛び。「効果の画素のうち」と「画面のうち」の両方で見る。
  //    加算パーティクルは周りも照らすので『変えた画素』の分母が大きくなり、
  //    割合だけでは白い塊を見逃す(実測: 炎が真っ白なのに blownPct 14%)。
  if (visible && (maxBlown > 40 || maxBlownArea > 1.5)) {
    suggestions.push(
      `効果の白飛びが大きい(効果画素の ${maxBlown.toFixed(1)}% / 画面の ${maxBlownArea.toFixed(2)}% が飽和)。`
      + "色が全部飛んで白い塊になっているので、intensity を半分にすること。"
      + "それでも白いなら size か rate を落とす(ブルームが乗るので HDR 強度の効きは非線形に強い)。",
    );
  }
  // ③ 暗すぎ(加算系のみ)
  if (visible && opts.additive && maxPeak > 0 && maxPeak < 0.35) {
    suggestions.push(
      `効果の最大輝度が ${maxPeak.toFixed(2)} しかない。加算パーティクルとしては暗い。`
      + "intensity を 1.5〜2 倍にするか、周りを暗くすること。"
      + "dx12_set_post_process bloomOn=true も効く。",
    );
  }
  // ④ 明るい背景 + 加算 = 埋もれる
  if (opts.additive && sceneLuma > 0.6) {
    suggestions.push(
      `地の絵が明るい(中央の平均輝度 ${sceneLuma.toFixed(2)})。加算パーティクルは明るい背景では埋もれる。`
      + "暗所での見え方を確かめるなら dx12_apply_lighting_preset preset='night' を当ててから撮り直すこと。",
    );
  }
  // ⑤ 粒がほとんど動いていない(止まった板に見える典型)
  //    ★影響範囲の増減で見ると、周りを照らす効果では常に一定になって誤検知する。
  //      フレーム間で実際に変わった画素で見ること。
  if (visible && motions.length >= 2 && Math.max(...motions) < 0.5) {
    suggestions.push(
      "フレーム間で絵がほとんど変わっていない＝粒が動いていない。speed / turbStrength を上げるか、"
      + "life を短くして入れ替わりを速くすること(止まった板に見えている)。",
    );
  }
  if (suggestions.length === 0) {
    suggestions.push("問題は見当たらない。あとは絵を見て色と密度を決めること。");
  }
  return { frames, sceneLuma, backgroundFrom, visible, suggestions };
}

/** レシピのレイヤーから「粒が消えるまでの秒数」を見積もる(baseline を撮る待ち時間に使う)。 */
export function maxParticleLife(layers: Array<{ life?: number; lifeVar?: number }>): number {
  let m = 0;
  for (const l of layers) {
    const life = (l.life ?? 0) * (1 + (l.lifeVar ?? 0));
    if (life > m) m = life;
  }
  return m;
}
