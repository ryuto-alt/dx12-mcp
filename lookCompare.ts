// 「3D の絵」を参照画像へ寄せるための画像測光ヘルパ。MCP/EngineClient に依存しない純ロジック。
//
// 目的: uiCompare.ts が UI の「形」を横並びで見せるのに対し、こちらは 3D の「光」を数値化する。
//   AI は画像を見ただけでは「参照より 0.8EV 暗い」「彩度が 1.3 倍」を言い当てられない。
//   数値で出して初めて exposure/saturation/kelvin を何倍にすればいいかの反復ができる。
//
// 依存は pngjs のみ(uiCompare.ts と同じ)。横並び合成そのものは compareUiImages を再利用する。
//
// ★★ 測定対象が「何の絵」なのか（示唆の作り方がこれに縛られる）★★
//
//   2026-07-26 に engine へ `screenshot_final`（バックバッファ＝ポスト適用後の最終画）が
//   入り、**ポストのノブも測れるようになった**。撮り方が 2 種類あるので postVisible で分ける。
//
//   ① dx12_screenshot_final（既定。postVisible = true）
//      バックバッファをそのまま読む。**人間がビューポートで見ている絵と同一**。
//      グレーディング / ブルーム / ゴッドレイ / ビネット / LUT / FXAA / デバンド /
//      TAA の解決結果まで全部乗るので、**どのノブを動かしても測定値が動く**。
//      → 示唆に「映らないから勧めるな」の制約は要らない。素直に効くノブを勧めてよい。
//
//   ② dx12_screenshot（postVisible = false）
//      m_sceneRT(リニア HDR)を読み戻し、CPU 側で【露出 → トーンマップ → ガンマ 1/2.2】
//      だけを掛けた絵(Application::ReadbackSceneBgra。PostProcess.hlsl の ToneMapGamma の写し)。
//        ○ 映る … ライト(intensity/color/kelvin)・環境光・材質・IBL・影・SSAO・
//                  dx12_set_post_process の exposure と tonemapper
//        × 映らない … カラーグレーディング(contrast/brightness/saturation/warmth/hueShift/tint)、
//                  ブルーム・ビネット・グレイン等のポスト効果全般
//      → こちらで測っている間だけは、映らないノブに「目視で確認」の但し書きを付ける。
//        付けないと「saturation を下げた → 測定値が変わらない → もう一度下げる」の無限ループになる。
//
//   ★どちらで測っても【まず光で作る】順序そのものは変えない。ライティングの破綻を
//     グレーディングで塗り潰すのは絵作りとして間違いで、それは測定手段とは無関係だから。
//     変えたのは「ポストのノブを出してよいか」ではなく「出すときに但し書きが要るか」。
//
//   なお engine 側のガンマは純 2.2、こちらの逆変換は sRGB の折れ線(参照が写真＝sRGB のため)。
//   中間調のズレは 0.03EV 程度で許容差(0.15EV)より十分小さい。両者を同じ曲線で戻すので
//   差分としては打ち消し合う。極端な暗部だけは曲線差が出るが、そこは元々ヒストグラム下限。
//
// ── 採用した式と出典 ────────────────────────────────────────────────
//  ① sRGB の逆ガンマ(EOTF): lin = c/12.92 (c<=0.04045) / ((c+0.055)/1.055)^2.4
//     IEC 61966-2-1 / W3C "A Standard Default Color Space for the Internet - sRGB"
//     https://www.w3.org/Graphics/Color/srgb
//  ② 相対輝度 Y = 0.2126R + 0.7152G + 0.0722B（線形 sRGB / Rec.709 原色 + D65）
//  ③ 線形 sRGB → CIE XYZ (D65) 行列（同上、ICC "Specification of sRGB" 表と一致）
//  ④ 相関色温度 CCT: McCamy の三次近似
//       n = (x - 0.3320) / (0.1858 - y)
//       CCT = 449n^3 + 3525n^2 + 6823.3n + 5520.33   [K]
//     C. S. McCamy, "Correlated color temperature as an explicit function of
//     chromaticity coordinates", Color Research & Application 17(2), 1992, pp.142-144.
//     https://onlinelibrary.wiley.com/doi/10.1002/col.5080170211
//     (等温線が (0.3320, 0.1858) の一点へ収束することを利用した近似。2000K〜12000K で誤差 ±2K 程度)
//  ④' Duv(黒体軌跡からの距離)による有効性ガード ★これが無いと嘘をつく
//     McCamy は「黒体軌跡の近く」でしか意味を持たない。真っ青な絵に対しても 1667K 等の
//     もっともらしい数値を返してしまうので、CIE 1960 UCS 上で黒体軌跡までの距離 Duv を測り、
//     離れすぎている(|Duv| > 0.05)ときは CCT を null にする。
//     ・CIE 1960 UCS: u = 4x/(-2x+12y+3), v = 6y/(-2x+12y+3)
//     ・黒体軌跡の (u,v) 有理近似(Krystek 1985、1000K < T < 15000K で有効):
//         u(T) = (0.860117757 + 1.54118254e-4 T + 1.28641212e-7 T^2)
//              / (1 + 8.42420235e-4 T + 7.08145163e-7 T^2)
//         v(T) = (0.317398726 + 4.22806245e-5 T + 4.20481691e-8 T^2)
//              / (1 - 2.89741816e-5 T + 1.61456053e-7 T^2)
//       https://en.wikipedia.org/wiki/Planckian_locus (Approximation 節)
//     検算: sRGB の白色点 D65 は Duv ≈ +0.0032(公表値と一致)、純青は Duv ≈ 0.30 で棄却される。
//  ⑤ ヒストグラム距離 EMD: 等幅ビン・正規化済みの 1 次元ヒストグラムでは
//     EMD(= 1-Wasserstein 距離) は累積分布の L1 距離に一致する。
//       EMD = Σ_i |CDF_a(i) - CDF_b(i)| * binWidth
//     Ling & Okada, "An Efficient Earth Mover's Distance Algorithm for Robust
//     Histogram Comparison" (EMD-L1) ほか、1D EMD の標準的な閉形式。
//  ⑥ CIELAB: CIE 15 の標準式（f(t)=t^(1/3) if t>(6/29)^3、白色点 D65）。彩度 C* = sqrt(a*^2 + b*^2)

import { PNG } from "pngjs";
import { compareUiImages, type Size } from "./uiCompare.ts";

// ── 定数 ─────────────────────────────────────────────────────────
/** log2 輝度ヒストグラムの既定レンジ [EV]。0EV = 相対輝度 1.0(白)。 */
export const DEFAULT_MIN_EV = -10;
export const DEFAULT_MAX_EV = 0;
export const DEFAULT_BINS = 24;
/** 黒潰れ/白飛びの既定閾値(sRGB 符号化後の 0..255 luma)。 */
export const DEFAULT_BLACK_LEVEL = 4;
export const DEFAULT_WHITE_LEVEL = 250;
/** log2(0) を避けるための下駄。2^-14 ≒ 6.1e-5(8bit の最下位より十分小さい)。 */
const EPS_LUM = Math.pow(2, -14);

// sRGB(0..255) → 線形(0..1) の LUT。全画素ループで pow を回さないため。
const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export type LookOptions = {
  /** 対数輝度ヒストグラムのビン数(8..64)。既定 24。 */
  bins?: number;
  /** ヒストグラムの下限 EV。既定 -10。 */
  minEV?: number;
  /** ヒストグラムの上限 EV。既定 0。 */
  maxEV?: number;
  /** 黒潰れ判定の luma 閾値(sRGB 0..255、これ「以下」を潰れと数える)。既定 4。 */
  blackLevel?: number;
  /** 白飛び判定の luma 閾値(sRGB 0..255、これ「以上」を飛びと数える)。既定 250。 */
  whiteLevel?: number;
  /** 横並び合成の差分判定 RGB 距離閾値。既定 30(uiCompare と同じ)。 */
  diffThreshold?: number;
  /**
   * 比較対象の絵にポストプロセスが乗っているか(示唆の但し書きが変わる)。
   * dx12_screenshot_final(バックバッファ)なら true、dx12_screenshot(シーン RT)なら false。既定 true。
   */
  postVisible?: boolean;
};

export type LookStats = {
  size: Size;
  /** 平均相対輝度(線形 0..1)。 */
  meanLuminance: number;
  /** 中央値の相対輝度(線形 0..1)。 */
  medianLuminance: number;
  /** 対数輝度の平均 [EV]。露出比較はこれ(幾何平均)を使う。 */
  meanEV: number;
  /** 中央値の対数輝度 [EV]。 */
  medianEV: number;
  /** 対数輝度の標準偏差 [EV] = コントラスト。 */
  contrastEV: number;
  /** P5 / P95 の対数輝度 [EV] とその幅(実効ダイナミックレンジ)。 */
  p5EV: number;
  p95EV: number;
  dynamicRangeEV: number;
  /** 平均色(sRGB 0..255、表示値の単純平均。人が目で照合する用)。 */
  meanRgb: [number, number, number];
  /** 平均色(線形。CCT はこちらから計算する)。 */
  meanLinearRgb: [number, number, number];
  /** 相関色温度 [K]。McCamy 近似 + Duv ガード。表せない色なら null。 */
  cct: number | null;
  /** 黒体軌跡からの符号付き距離(CIE 1960 UCS)。+ = 緑寄り、− = 紫寄り。 */
  duv: number | null;
  /** cct が null のときの理由。 */
  cctNote?: string;
  /** CIE 1931 xy 色度(平均色)。 */
  chromaticityXy: [number, number] | null;
  /** 平均彩度(HSV の S、0..1)。 */
  saturationHsv: number;
  /** 平均彩度(CIELAB の C*、0..~130)。 */
  chromaLab: number;
  /** 黒潰れ率(%)。luma <= blackLevel の画素割合。 */
  blackClipPercent: number;
  /** 白飛び率(%)。luma >= whiteLevel の画素割合。 */
  whiteClipPercent: number;
  /** 対数輝度ヒストグラム(合計 1 に正規化)。 */
  histogram: number[];
  /** ヒストグラムのビン定義。 */
  histogramRange: { minEV: number; maxEV: number; bins: number; binWidthEV: number };
};

export type LookDelta = {
  /** 露出差 [EV](現在 - 参照)。負なら現在が暗い。 */
  exposureEV: number;
  /** コントラスト比(現在 / 参照)。1 より小さければ眠い絵。 */
  contrastRatio: number;
  /** 実効ダイナミックレンジ差 [EV]。 */
  dynamicRangeDeltaEV: number;
  /** 彩度比(HSV S、現在 / 参照)。 */
  saturationRatio: number;
  /** 彩度比(CIELAB C*、現在 / 参照)。 */
  chromaRatio: number;
  /** 色温度差 [K](現在 - 参照)。負なら現在が暖色(低い K)寄り。どちらか null なら null。 */
  cctDeltaK: number | null;
  /** 対数輝度ヒストグラムの EMD [EV]。累積分布の L1 距離 × ビン幅。 */
  histogramEmdEV: number;
  /** 対数輝度ヒストグラムのビン毎差の総和(0..2)。 */
  histogramL1: number;
  /** 黒潰れ率の差(%ポイント、現在 - 参照)。 */
  blackClipDelta: number;
  /** 白飛び率の差(%ポイント、現在 - 参照)。 */
  whiteClipDelta: number;
};

export type LookCompareResult = {
  /** 横並び合成 PNG(左=参照、右=現在)。 */
  compositePng: Buffer;
  /** 画素差分率(%)。uiCompare と同じ定義。 */
  diffRatio: number;
  reference: LookStats;
  current: LookStats;
  delta: LookDelta;
  /** 「参照へ寄せるには何をどっちへ動かすか」の具体的な示唆(日本語)。 */
  suggestions: string[];
};

// ── 内部ヘルパ ───────────────────────────────────────────────────

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** 線形 sRGB → CIE XYZ (D65)。IEC 61966-2-1 の行列。 */
function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

/** CIE xy → CIE 1960 UCS (u,v)。Duv はこの空間で定義される。 */
export function xyToUv1960(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  if (Math.abs(d) < 1e-12) return [0, 0];
  return [(4 * x) / d, (6 * y) / d];
}

/** 黒体軌跡の (u,v)(Krystek 1985 の有理近似。1000K < T < 15000K)。範囲外は null。 */
export function planckianUv(T: number): [number, number] | null {
  if (!Number.isFinite(T) || T <= 1000 || T >= 15000) return null;
  const t2 = T * T;
  const u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * t2)
          / (1 + 8.42420235e-4 * T + 7.08145163e-7 * t2);
  const v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * t2)
          / (1 - 2.89741816e-5 * T + 1.61456053e-7 * t2);
  return [u, v];
}

/** |Duv| がこれを超えたら「黒体軌跡から離れすぎ」＝ CCT は意味を持たないと判断する。 */
export const DUV_LIMIT = 0.05;

export type CctResult = {
  /** 相関色温度 [K]。近似の有効域外 / 黒体軌跡から離れすぎ の時は null。 */
  cct: number | null;
  /** 黒体軌跡からの符号付き距離(CIE 1960 UCS)。+ = 緑寄り、− = 紫寄り。測れない時は null。 */
  duv: number | null;
  /** CCT を null にした理由(null にしていない時は undefined)。 */
  reason?: string;
};

/**
 * McCamy(1992) の三次近似で相関色温度を求め、Duv で有効性を検査する。
 *   n = (x - 0.3320) / (0.1858 - y),  CCT = 449n^3 + 3525n^2 + 6823.3n + 5520.33
 * ★近似は「黒体軌跡の近く」でしか意味を持たない。離れている色に対しては
 *   もっともらしい K を返してしまうので、必ず Duv で弾く。
 */
export function cctFromXy(x: number, y: number): CctResult {
  const denom = 0.1858 - y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(denom) < 1e-9) {
    return { cct: null, duv: null, reason: "McCamy の等温線収束点(0.3320, 0.1858)に一致し計算できない" };
  }
  const n = (x - 0.3320) / denom;
  const cct = 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33;
  if (!Number.isFinite(cct) || cct < 1000 || cct > 25000) {
    return { cct: null, duv: null, reason: `McCamy 近似の有効域(1000–25000K)外(${Math.round(cct)}K)` };
  }
  const uvSample = xyToUv1960(x, y);
  const uvLocus = planckianUv(cct);
  if (!uvLocus) {
    // 15000–25000K は Krystek 近似の外。CCT は返すが Duv による裏取りはできない。
    return { cct, duv: null, reason: undefined };
  }
  const du = uvSample[0] - uvLocus[0];
  const dv = uvSample[1] - uvLocus[1];
  const duv = Math.sign(dv || 1) * Math.hypot(du, dv);
  if (Math.abs(duv) > DUV_LIMIT) {
    return {
      cct: null, duv,
      reason: `黒体軌跡から離れすぎ(Duv=${duv.toFixed(3)} > ${DUV_LIMIT})。CCT では表せない色`,
    };
  }
  return { cct, duv };
}

/** 線形 sRGB の平均色から CCT / Duv / xy を求める。真っ黒なら全て null。 */
export function cctFromLinearRgb(r: number, g: number, b: number): CctResult & { xy: [number, number] | null } {
  const [X, Y, Z] = linearRgbToXyz(r, g, b);
  const sum = X + Y + Z;
  if (!(sum > 1e-12)) return { cct: null, duv: null, xy: null, reason: "平均色が真っ黒で色度を計算できない" };
  const x = X / sum;
  const y = Y / sum;
  return { ...cctFromXy(x, y), xy: [x, y] };
}

/** CIELAB の f(t)。CIE 15 の標準式。 */
function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : (903.2962962962963 * t + 16) / 116;
}

/** 等幅ビン・正規化済み 1 次元ヒストグラムの EMD(= 累積分布の L1 距離 × ビン幅)。 */
export function histogramEmd(a: number[], b: number[], binWidth: number): number {
  if (a.length !== b.length) throw new Error("ヒストグラムのビン数が違います");
  let ca = 0, cb = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    ca += a[i];
    cb += b[i];
    sum += Math.abs(ca - cb);
  }
  return sum * binWidth;
}

/** ビン毎差の総和(0..2)。分布の重なりの粗い指標。 */
export function histogramL1(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

// ── 本体 ─────────────────────────────────────────────────────────

/**
 * PNG 1 枚の測光統計を出す。アルファは無視(スクショは常に不透明)。
 * 全画素を 1 パスで走査する(1920x1080 でおよそ 0.2 秒)。
 */
export function analyzeLook(pngBuffer: Buffer, opts: LookOptions = {}): LookStats {
  const png = PNG.sync.read(pngBuffer);
  return analyzeLookPng(png, opts);
}

export function analyzeLookPng(png: PNG, opts: LookOptions = {}): LookStats {
  const total = png.width * png.height;
  if (total <= 0) throw new Error("PNG のサイズが 0 です。");

  const bins = clampInt(opts.bins ?? DEFAULT_BINS, 8, 64);
  const minEV = opts.minEV ?? DEFAULT_MIN_EV;
  const maxEV = opts.maxEV ?? DEFAULT_MAX_EV;
  if (!(maxEV > minEV)) throw new Error("maxEV は minEV より大きい必要があります。");
  const binWidthEV = (maxEV - minEV) / bins;
  const blackLevel = clampInt(opts.blackLevel ?? DEFAULT_BLACK_LEVEL, 0, 255);
  const whiteLevel = clampInt(opts.whiteLevel ?? DEFAULT_WHITE_LEVEL, 0, 255);

  const hist = new Float64Array(bins);
  const lumaHist = new Float64Array(256);   // sRGB 符号化 luma のヒストグラム(中央値/分位点用)
  let sumLin = 0;          // 相対輝度(線形)の総和
  let sumEV = 0;           // log2 輝度の総和
  let sumEV2 = 0;          // log2 輝度の二乗和(標準偏差用)
  let sumR = 0, sumG = 0, sumB = 0;             // 線形 RGB の総和
  let sumR8 = 0, sumG8 = 0, sumB8 = 0;          // sRGB 0..255 の総和
  let sumSat = 0;          // HSV S の総和
  let sumChroma = 0;       // CIELAB C* の総和
  let black = 0, white = 0;

  const d = png.data;
  for (let i = 0, n = total * 4; i < n; i += 4) {
    const r8 = d[i], g8 = d[i + 1], b8 = d[i + 2];
    sumR8 += r8; sumG8 += g8; sumB8 += b8;

    const rl = SRGB_TO_LINEAR[r8], gl = SRGB_TO_LINEAR[g8], bl = SRGB_TO_LINEAR[b8];
    sumR += rl; sumG += gl; sumB += bl;

    // 相対輝度(線形、Rec.709 原色)
    const Y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
    sumLin += Y;
    const ev = Math.log2(Y > EPS_LUM ? Y : EPS_LUM);
    sumEV += ev;
    sumEV2 += ev * ev;
    let bi = Math.floor((ev - minEV) / binWidthEV);
    if (bi < 0) bi = 0; else if (bi >= bins) bi = bins - 1;
    hist[bi]++;

    // 符号化 luma(0..255)。中央値/P5/P95 と黒潰れ・白飛び判定に使う。
    // sRGB 空間での近似輝度(Rec.709 係数を符号化値に直接掛ける = 一般的なビデオ的 luma)。
    const luma = (0.2126729 * r8 + 0.7151522 * g8 + 0.0721750 * b8) | 0;
    lumaHist[luma < 0 ? 0 : luma > 255 ? 255 : luma]++;
    if (luma <= blackLevel) black++;
    if (luma >= whiteLevel) white++;

    // HSV の S(sRGB 表示値ベース。人の「彩度が高い/低い」の感覚に近い)
    const mx = r8 > g8 ? (r8 > b8 ? r8 : b8) : (g8 > b8 ? g8 : b8);
    const mn = r8 < g8 ? (r8 < b8 ? r8 : b8) : (g8 < b8 ? g8 : b8);
    if (mx > 0) sumSat += (mx - mn) / mx;

    // CIELAB の C*(知覚的な彩度。暗部の色ノリまで拾う)
    const [X, Yn, Z] = linearRgbToXyz(rl, gl, bl);
    const fx = labF(X / 0.95047), fy = labF(Yn), fz = labF(Z / 1.08883);
    const a = 500 * (fx - fy);
    const bb = 200 * (fy - fz);
    sumChroma += Math.sqrt(a * a + bb * bb);
  }

  // 分位点(符号化 luma の累積から) → 線形 → EV
  const pct = (p: number): number => {
    const want = total * p;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += lumaHist[v];
      if (acc >= want) return v;
    }
    return 255;
  };
  const lumaToEV = (v8: number): number => {
    const lin = SRGB_TO_LINEAR[clampInt(v8, 0, 255)];
    return Math.log2(lin > EPS_LUM ? lin : EPS_LUM);
  };

  const median8 = pct(0.5);
  const meanEV = sumEV / total;
  const varEV = Math.max(0, sumEV2 / total - meanEV * meanEV);
  const p5EV = lumaToEV(pct(0.05));
  const p95EV = lumaToEV(pct(0.95));

  const meanLinearRgb: [number, number, number] = [sumR / total, sumG / total, sumB / total];
  const { cct, duv, xy, reason } = cctFromLinearRgb(meanLinearRgb[0], meanLinearRgb[1], meanLinearRgb[2]);

  const histogram: number[] = new Array(bins);
  for (let i = 0; i < bins; i++) histogram[i] = hist[i] / total;

  return {
    size: { width: png.width, height: png.height },
    meanLuminance: sumLin / total,
    medianLuminance: SRGB_TO_LINEAR[median8],
    meanEV,
    medianEV: lumaToEV(median8),
    contrastEV: Math.sqrt(varEV),
    p5EV,
    p95EV,
    dynamicRangeEV: p95EV - p5EV,
    meanRgb: [sumR8 / total, sumG8 / total, sumB8 / total],
    meanLinearRgb,
    cct,
    duv,
    cctNote: reason,
    chromaticityXy: xy,
    saturationHsv: sumSat / total,
    chromaLab: sumChroma / total,
    blackClipPercent: (black / total) * 100,
    whiteClipPercent: (white / total) * 100,
    histogram,
    histogramRange: { minEV, maxEV, bins, binWidthEV },
  };
}

// 「差が意味を持つ」しきい値。これ未満は示唆に出さない(ノイズで AI を振り回さないため)。
const TOL_EV = 0.15;          // 露出 [EV]
const TOL_RATIO = 0.10;       // 比率(コントラスト/彩度)の ±10%
const TOL_CCT = 200;          // 色温度 [K]
const TOL_CLIP = 2.0;         // 黒潰れ/白飛び率の差 [%ポイント]

function fixed(v: number, n = 2): string {
  return v.toFixed(n);
}

/**
 * ポストのノブを勧める行に添える但し書き。
 * - postVisible=false（dx12_screenshot で測っている）… 「この数値では追い込めない」と断る。
 * - postVisible=true （dx12_screenshot_final で測っている）… ポストも測定値に乗るので
 *   但し書きは不要。代わりに「そのまま撮り直せば数値で追える」ことを伝える。
 */
function postCaveat(postVisible: boolean): string {
  return postVisible
    ? "(ポストも最終画に乗っているので、動かして dx12_screenshot_final で撮り直せばこの数値がそのまま動く)"
    : "★ポストのグレーディングは dx12_screenshot(シーン RT)に映らないため、この数値では追い込めない。"
      + "測りながら追い込むなら dx12_look_compare を source:'final' で呼び直すこと"
      + "(または触った後に dx12_screenshot_final / dx12_ui_screenshot で目視して確認する)";
}

/** 示唆の作り方を変えるスイッチ。 */
export type SuggestionOptions = {
  /**
   * 測っている絵にポストプロセスが乗っているか。
   * dx12_screenshot_final(バックバッファ)なら true、dx12_screenshot(シーン RT)なら false。
   * 既定 true（screenshot_final が既定の撮り方になったため）。
   */
  postVisible?: boolean;
};

/**
 * 統計の差から「何をどっちへ動かすか」の日本語の示唆を作る。
 * エンジン側のノブ名(dx12_set_sun / dx12_set_post_process のフィールド)を必ず添える。
 *
 * ★順序: ライト・環境光・材質(＝絵の作りとして正しい直し方)を第一候補にし、
 *   ポストのグレーディングは「一律に効かせる最後の手段」として後ろに置く。これは
 *   測定手段とは無関係の絵作りの原則なので、postVisible に関わらず変えない。
 * ★postVisible=false のときだけ、ポストのノブに「この数値では追い込めない」但し書きを足す
 *   (これが無いと「下げた→数値が変わらない→もう一度下げる」の無限ループになる)。
 * ※ exposure / contrast / saturation は【現在値への倍率】で書く(シェーダがそれぞれ乗算・
 *    ピボット 0.5 の乗算・luma との lerp なので、倍率で指示するのが一番外さない)。
 */
export function buildSuggestions(
  ref: LookStats, cur: LookStats, delta: LookDelta, opts: SuggestionOptions = {},
): string[] {
  const out: string[] = [];
  const postVisible = opts.postVisible !== false;
  const POST_ONLY = postCaveat(postVisible);

  if (Math.abs(delta.exposureEV) >= TOL_EV) {
    const dir = delta.exposureEV < 0 ? "暗い" : "明るい";
    const mul = Math.pow(2, -delta.exposureEV);
    out.push(
      `露出: 参照より平均輝度が ${delta.exposureEV >= 0 ? "+" : ""}${fixed(delta.exposureEV)}EV ${dir}。` +
      `dx12_set_sun の intensity を現在値の ×${fixed(mul)} にする(絵の作りとして正しい直し方)。` +
      `全体を一律に持ち上げるだけなら dx12_set_post_process の exposure を ×${fixed(mul)}` +
      `(exposureOn:true。${postVisible ? "測っている最終画に反映される" : "exposure と tonemapper だけはスクショにも反映される"})。`,
    );
  }

  if (Math.abs(delta.contrastRatio - 1) >= TOL_RATIO) {
    const soft = delta.contrastRatio < 1;
    out.push(
      `コントラスト: 対数輝度の標準偏差が参照の ×${fixed(delta.contrastRatio)} で` +
      `${soft ? "眠い(コントラスト不足)" : "硬い(コントラスト過多)"}。` +
      `実効レンジ P5–P95 は 参照 ${fixed(ref.dynamicRangeEV, 1)}EV / 現在 ${fixed(cur.dynamicRangeEV, 1)}EV。` +
      (soft
        ? "まず光で作る: dx12_set_sun の ambient を下げて影を締める / intensity を上げて陰影の比を広げる。"
        : "まず光で作る: dx12_set_sun の ambient を上げて影を起こす / 補助ライトを足して影を潰さない。") +
      `それでも足りなければ dx12_set_post_process の contrast を現在値の ×${fixed(1 / delta.contrastRatio)}` +
      `(contrastOn:true)。${POST_ONLY}。`,
    );
  }

  if (Math.abs(delta.saturationRatio - 1) >= TOL_RATIO) {
    const high = delta.saturationRatio > 1;
    out.push(
      `彩度: 参照より ${fixed(delta.saturationRatio)} 倍 ${high ? "高い" : "低い"}` +
      `(HSV S: 参照 ${fixed(ref.saturationHsv, 3)} / 現在 ${fixed(cur.saturationHsv, 3)}、` +
      `CIELAB C*: 参照 ${fixed(ref.chromaLab, 1)} / 現在 ${fixed(cur.chromaLab, 1)})。` +
      `まず素材と光で作る: ${high ? "ライトの color を白へ寄せる" : "ライトの color に色味を足す"}、` +
      `dx12_set_pbr / dx12_set_color でアルベドの鮮やかさを${high ? "落とす" : "上げる"}、` +
      `IBL(skybox)の色被りを疑う。` +
      `一律に効かせるなら dx12_set_post_process の saturation を現在値の ×${fixed(1 / delta.saturationRatio)}` +
      `(saturationOn:true)。${POST_ONLY}。`,
    );
  }

  if (delta.cctDeltaK != null && Math.abs(delta.cctDeltaK) >= TOL_CCT) {
    const dir = delta.cctDeltaK > 0 ? "寒色(青白い)" : "暖色(オレンジ)";
    out.push(
      `色温度: 参照より ${Math.abs(Math.round(delta.cctDeltaK))}K ${dir}寄り` +
      `(参照 ${Math.round(ref.cct!)}K / 現在 ${Math.round(cur.cct!)}K)。` +
      `dx12_set_sun の kelvin を ${Math.round(ref.cct!)} にする(光源そのものを直すので一番外さない)。` +
      `dx12_set_post_process の warmth / tint でも寄せられる。${POST_ONLY}。`,
    );
  } else if (ref.cct == null || cur.cct == null) {
    const why = [
      ref.cct == null ? `参照: ${ref.cctNote ?? "算出不可"}` : null,
      cur.cct == null ? `現在: ${cur.cctNote ?? "算出不可"}` : null,
    ].filter(Boolean).join(" / ");
    out.push(
      `色温度: CCT で表せない色なので比較を省略した(${why})。` +
      "強い色被り(カラーライト・強いティント)がかかっているか、絵が暗すぎる。" +
      "まず露出と色被りを外してから撮り直すこと。",
    );
  }

  if (Math.abs(delta.blackClipDelta) >= TOL_CLIP) {
    if (delta.blackClipDelta > 0) {
      out.push(
        `黒潰れ: 現在 ${fixed(cur.blackClipPercent, 1)}% / 参照 ${fixed(ref.blackClipPercent, 1)}% で潰れすぎ。` +
        `影のディテールが消えている。dx12_set_sun の ambient を上げる、` +
        `影側を起こす補助ライトを足す、スカイ/IBL の強度を上げる(dx12_set_scene_settings)。`,
      );
    } else {
      out.push(
        `黒潰れ: 現在 ${fixed(cur.blackClipPercent, 1)}% / 参照 ${fixed(ref.blackClipPercent, 1)}% で参照より締まっていない。` +
        `暗部が浮いて霞んで見える。dx12_set_sun の ambient を下げる、IBL の強度を下げる。`,
      );
    }
  }

  if (Math.abs(delta.whiteClipDelta) >= TOL_CLIP) {
    if (delta.whiteClipDelta > 0) {
      out.push(
        `白飛び: 現在 ${fixed(cur.whiteClipPercent, 1)}% / 参照 ${fixed(ref.whiteClipPercent, 1)}% で飛びすぎ。` +
        `dx12_set_sun の intensity か dx12_set_post_process の exposure を下げる。` +
        `トーンマッパーを ACES / AgX にするとハイライトの粘りが出る` +
        `(tonemapper は${postVisible ? "最終画に" : "スクショにも"}反映される)。`,
      );
    } else {
      out.push(
        `白飛び: 現在 ${fixed(cur.whiteClipPercent, 1)}% / 参照 ${fixed(ref.whiteClipPercent, 1)}% でハイライトが伸びていない。` +
        `参照はもっと光っている。光源の intensity を上げる / 鏡面の強い材質(roughness を下げる)を置く。` +
        `dx12_set_post_process の bloom(bloomOn:true)で伸ばす手もある。${POST_ONLY}。`,
      );
    }
  }

  // ヒストグラム形状そのものの乖離(平均・分散を合わせても分布が違う場合を拾う)
  if (delta.histogramEmdEV >= 0.5) {
    out.push(
      `輝度分布: ヒストグラムの EMD が ${fixed(delta.histogramEmdEV)}EV あり、平均だけ合わせても形が違う。` +
      `露出やグレーディングでは埋まらない。ライトの数・配置・種類(面光源的な補助光の有無)と` +
      `トーンマッパーの選択(dx12_set_post_process の tonemapper: 0=ACES / 1=AgX / 2=なし)を見直す。`,
    );
  }

  if (out.length === 0) {
    out.push(
      `参照とほぼ一致(露出 ${fixed(delta.exposureEV)}EV / コントラスト ×${fixed(delta.contrastRatio)} / ` +
      `彩度 ×${fixed(delta.saturationRatio)} / 色温度差 ${delta.cctDeltaK == null ? "n/a" : Math.round(delta.cctDeltaK) + "K"})。` +
      `これ以上は数値では詰められないので、合成画像を見て構図・素材・法線の差を探すこと。`,
    );
  }
  return out;
}

/**
 * 参照画像と現在のシーンビューを比較する。
 * 横並び合成 PNG(uiCompare と同じ) + 測光統計 + 差分 + 日本語の示唆を返す。
 */
export function compareLook(
  refPngBuffer: Buffer,
  curPngBuffer: Buffer,
  opts: LookOptions = {},
): LookCompareResult {
  const composed = compareUiImages(refPngBuffer, curPngBuffer, { diffThreshold: opts.diffThreshold });
  const reference = analyzeLook(refPngBuffer, opts);
  const current = analyzeLook(curPngBuffer, opts);

  const safeRatio = (a: number, b: number): number => (b > 1e-9 ? a / b : (a > 1e-9 ? Infinity : 1));

  const delta: LookDelta = {
    exposureEV: current.meanEV - reference.meanEV,
    contrastRatio: safeRatio(current.contrastEV, reference.contrastEV),
    dynamicRangeDeltaEV: current.dynamicRangeEV - reference.dynamicRangeEV,
    saturationRatio: safeRatio(current.saturationHsv, reference.saturationHsv),
    chromaRatio: safeRatio(current.chromaLab, reference.chromaLab),
    cctDeltaK: (current.cct != null && reference.cct != null) ? current.cct - reference.cct : null,
    histogramEmdEV: histogramEmd(reference.histogram, current.histogram, reference.histogramRange.binWidthEV),
    histogramL1: histogramL1(reference.histogram, current.histogram),
    blackClipDelta: current.blackClipPercent - reference.blackClipPercent,
    whiteClipDelta: current.whiteClipPercent - reference.whiteClipPercent,
  };

  return {
    compositePng: composed.compositePng,
    diffRatio: composed.diffRatio,
    reference,
    current,
    delta,
    suggestions: buildSuggestions(reference, current, delta, { postVisible: opts.postVisible }),
  };
}

/** 数値を MCP の text へ載せる用に丸める(小数を垂れ流さない)。 */
export function roundStats(s: LookStats): Record<string, unknown> {
  const r = (v: number, n = 3) => Number(v.toFixed(n));
  return {
    size: s.size,
    meanLuminance: r(s.meanLuminance, 4),
    medianLuminance: r(s.medianLuminance, 4),
    meanEV: r(s.meanEV, 2),
    medianEV: r(s.medianEV, 2),
    contrastEV: r(s.contrastEV, 2),
    p5EV: r(s.p5EV, 2),
    p95EV: r(s.p95EV, 2),
    dynamicRangeEV: r(s.dynamicRangeEV, 2),
    meanRgb: s.meanRgb.map((v) => r(v, 1)),
    cct: s.cct == null ? null : Math.round(s.cct),
    duv: s.duv == null ? null : r(s.duv, 4),
    cctNote: s.cctNote ?? null,
    chromaticityXy: s.chromaticityXy == null ? null : s.chromaticityXy.map((v) => r(v, 4)),
    saturationHsv: r(s.saturationHsv, 3),
    chromaLab: r(s.chromaLab, 1),
    blackClipPercent: r(s.blackClipPercent, 2),
    whiteClipPercent: r(s.whiteClipPercent, 2),
    histogram: s.histogram.map((v) => r(v, 4)),
    histogramRange: s.histogramRange,
  };
}

export function roundDelta(d: LookDelta): Record<string, unknown> {
  const r = (v: number, n = 3) => Number(v.toFixed(n));
  return {
    exposureEV: r(d.exposureEV, 2),
    contrastRatio: r(d.contrastRatio, 3),
    dynamicRangeDeltaEV: r(d.dynamicRangeDeltaEV, 2),
    saturationRatio: r(d.saturationRatio, 3),
    chromaRatio: r(d.chromaRatio, 3),
    cctDeltaK: d.cctDeltaK == null ? null : Math.round(d.cctDeltaK),
    histogramEmdEV: r(d.histogramEmdEV, 3),
    histogramL1: r(d.histogramL1, 3),
    blackClipDelta: r(d.blackClipDelta, 2),
    whiteClipDelta: r(d.whiteClipDelta, 2),
  };
}
