// Pure UI comparison helpers. Kept independent from MCP/EngineClient so the logic is unit-testable.
//
// 目的: 参照ゲームのUIスクショと現在のUIスクショを「1枚の横並び画像」に合成する。
// AI は2枚別々の画像より、1枚に合成された画像の方が正確に差分を比較できるため。
// PNG の decode/encode は pngjs(純JS・ネイティブ依存なし)を使う。

import { PNG } from "pngjs";

export type Size = { width: number; height: number };

export type CompareOptions = {
  /** true なら右側(現在のUI)に8pxグリッド線を薄く重畳する(整列確認用)。 */
  grid?: boolean;
  /** 差分判定のRGB距離閾値(0–441.67、各ch 0–255のユークリッド距離)。既定 30。 */
  diffThreshold?: number;
};

export type CompareResult = {
  /** 横並び合成PNG(左=参照、右=現在、間に4pxの区切り線)。 */
  compositePng: Buffer;
  /** ピクセル差分率(%)。同サイズに正規化した上で RGB 距離が閾値を超えたピクセルの割合。 */
  diffRatio: number;
  refSize: Size;
  curSize: Size;
};

// nearest neighbor の簡易リサイズ。比較用途には十分で、依存も増えない。
function resizeNearest(src: PNG, width: number, height: number): PNG {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

// 同サイズ2枚の RGB 距離ベース差分率(%)。アルファは無視(スクショは常に不透明のため)。
function diffRatioPercent(a: PNG, b: PNG, threshold: number): number {
  const total = a.width * a.height;
  if (total === 0) return 0;
  const t2 = threshold * threshold;
  let diff = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i + 1] - b.data[i + 1];
    const db = a.data[i + 2] - b.data[i + 2];
    if (dr * dr + dg * dg + db * db > t2) diff++;
  }
  return (diff / total) * 100;
}

const SEPARATOR_WIDTH = 4;   // 左右の間の区切り線(px)
const GRID_STEP = 8;         // grid=true の時のグリッド間隔(px)
const GRID_ALPHA = 0.25;     // グリッド線の重畳強度(薄く)

// 参照(ref)と現在(cur)のUIスクショPNGを比較し、横並び合成PNGと差分率を返す。
export function compareUiImages(
  refPngBuffer: Buffer,
  curPngBuffer: Buffer,
  opts: CompareOptions = {},
): CompareResult {
  const ref = PNG.sync.read(refPngBuffer);
  const cur = PNG.sync.read(curPngBuffer);
  const refSize: Size = { width: ref.width, height: ref.height };
  const curSize: Size = { width: cur.width, height: cur.height };
  if (ref.width <= 0 || ref.height <= 0 || cur.width <= 0 || cur.height <= 0)
    throw new Error("PNG のサイズが 0 です。");

  // 1) 2枚を同じ高さに揃える(高い方に合わせ、アスペクト比を保って幅を拡縮)。
  const h = Math.max(ref.height, cur.height);
  const refW = Math.max(1, Math.round((ref.width * h) / ref.height));
  const curW = Math.max(1, Math.round((cur.width * h) / cur.height));
  const left = ref.height === h && ref.width === refW ? ref : resizeNearest(ref, refW, h);
  const right = cur.height === h && cur.width === curW ? cur : resizeNearest(cur, curW, h);

  // 2) 横並び合成(左=参照、右=現在)。間に4pxの区切り線(明灰)。
  const outW = refW + SEPARATOR_WIDTH + curW;
  const out = new PNG({ width: outW, height: h });
  for (let y = 0; y < h; y++) {
    // 左: 参照
    left.data.copy(out.data, (y * outW) * 4, (y * refW) * 4, (y * refW + refW) * 4);
    // 区切り線
    for (let x = refW; x < refW + SEPARATOR_WIDTH; x++) {
      const i = (y * outW + x) * 4;
      out.data[i] = 255; out.data[i + 1] = 200; out.data[i + 2] = 0; out.data[i + 3] = 255;
    }
    // 右: 現在
    right.data.copy(out.data, (y * outW + refW + SEPARATOR_WIDTH) * 4, (y * curW) * 4, (y * curW + curW) * 4);
  }

  // 4) grid=true なら右側(現在)にだけ8pxグリッドを薄く重畳(整列確認用)。
  if (opts.grid) {
    const x0 = refW + SEPARATOR_WIDTH;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < curW; x++) {
        if (x % GRID_STEP !== 0 && y % GRID_STEP !== 0) continue;
        const i = (y * outW + x0 + x) * 4;
        // 下地が暗ければ白、明るければ黒の線を alpha ブレンド(どんな背景でも薄く見える)。
        const lum = (out.data[i] + out.data[i + 1] + out.data[i + 2]) / 3;
        const line = lum < 128 ? 255 : 0;
        for (let c = 0; c < 3; c++)
          out.data[i + c] = Math.round(out.data[i + c] * (1 - GRID_ALPHA) + line * GRID_ALPHA);
      }
    }
  }

  // 3) 差分率: 現在を参照サイズへ正規化してから RGB 距離で比較。
  const curNorm = cur.width === ref.width && cur.height === ref.height
    ? cur : resizeNearest(cur, ref.width, ref.height);
  const diffRatio = diffRatioPercent(ref, curNorm, opts.diffThreshold ?? 30);

  return { compositePng: PNG.sync.write(out), diffRatio, refSize, curSize };
}
