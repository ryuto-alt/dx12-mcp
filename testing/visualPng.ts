// 視覚回帰の TS 側の最小画像処理(pngjs のみ・Python 不要)。
//   ・PNG の読み書き / 画素 SHA-256(RGB。アルファは見ない)
//   ・差分の集計(tolLsb を超えて違う画素の割合・maxDelta・meanAbs・PSNR・外接矩形)
//   ・差の大きさのヒートマップ(magma 風)/ baseline | current | heat の並べ画像
// FLIP・SSIM・ΔE は tools/parity(Python)が担当する。ここは「Python が無くても回帰が判定できる」ための最小限。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PNG } from "pngjs";

export type Rgba = { width: number; height: number; data: Buffer };

export function decodePng(buf: Buffer): Rgba {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: p.data };
}
export function readPng(file: string): Rgba { return decodePng(fs.readFileSync(file)); }
export function encodePng(img: Rgba): Buffer {
  const p = new PNG({ width: img.width, height: img.height });
  img.data.copy(p.data);
  return PNG.sync.write(p);
}
export function writePng(file: string, img: Rgba): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(img));
}

/** 画素の SHA-256(RGB のみ。PNG の圧縮やメタデータの違いに影響されない)。 */
export function pixelSha(img: Rgba): string {
  const h = crypto.createHash("sha256");
  const n = img.width * img.height;
  const rgb = Buffer.allocUnsafe(n * 3);
  for (let i = 0, j = 0; i < n; i++) { rgb[j++] = img.data[i * 4]; rgb[j++] = img.data[i * 4 + 1]; rgb[j++] = img.data[i * 4 + 2]; }
  h.update(`${img.width}x${img.height}:`);
  h.update(rgb);
  return h.digest("hex");
}

export type DiffBBox = { x: number; y: number; w: number; h: number; pixels: number; ratio: number };
export type DiffStats = {
  width: number; height: number; tolLsb: number;
  diffPixels: number; diffRatio: number; maxDelta: number; meanAbsDelta: number; psnr: number; diffBBox: DiffBBox | null;
};

/** 同じ大きさの 2 枚の差。tolLsb を超えて(いずれかのチャンネルが)違う画素を数える。 */
export function diffStats(a: Rgba, b: Rgba, tolLsb = 2): DiffStats {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`画像の大きさが違う(${a.width}x${a.height} と ${b.width}x${b.height})`);
  const n = a.width * a.height;
  let diffPixels = 0, maxDelta = 0, sumAbs = 0, sumSq = 0;
  let minX = a.width, minY = a.height, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]), dg = Math.abs(a.data[o + 1] - b.data[o + 1]), db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const m = Math.max(dr, dg, db);
    if (m > maxDelta) maxDelta = m;
    sumAbs += dr + dg + db;
    sumSq += dr * dr + dg * dg + db * db;
    if (m > tolLsb) {
      diffPixels++;
      const x = i % a.width, y = (i / a.width) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const mse = sumSq / (n * 3);
  const psnr = mse === 0 ? 100 : Math.min(100, 10 * Math.log10((255 * 255) / mse));
  return {
    width: a.width, height: a.height, tolLsb, diffPixels, diffRatio: n ? diffPixels / n : 0, maxDelta,
    meanAbsDelta: n ? sumAbs / (n * 3) : 0, psnr: Math.round(psnr * 1000) / 1000,
    diffBBox: diffPixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels: diffPixels, ratio: diffPixels / n } : null,
  };
}

// magma 風の 6 点 LUT(0..1 → RGB)
const STOPS: [number, number, number][] = [[0, 0, 4], [40, 17, 89], [120, 28, 109], [205, 63, 91], [253, 158, 106], [252, 253, 191]];
function magma(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/** 差の大きさ(3 チャンネルの最大)を magma 風に塗る。完全に同じ画素は現在の絵を暗くして下敷きにする。gain=差を何倍して見るか。 */
export function heatmap(baseline: Rgba, current: Rgba, gain = 8): Rgba {
  const out = Buffer.alloc(baseline.width * baseline.height * 4);
  const n = baseline.width * baseline.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const m = Math.max(Math.abs(baseline.data[o] - current.data[o]), Math.abs(baseline.data[o + 1] - current.data[o + 1]), Math.abs(baseline.data[o + 2] - current.data[o + 2]));
    if (m === 0) {
      out[o] = current.data[o] * 0.3; out[o + 1] = current.data[o + 1] * 0.3; out[o + 2] = current.data[o + 2] * 0.3;
    } else {
      const c = magma(0.25 + Math.min(1, (m * gain) / 255) * 0.75);
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
    }
    out[o + 3] = 255;
  }
  return { width: baseline.width, height: baseline.height, data: out };
}

/** 差分画像(差 x4、グレー)。 */
export function diffImage(baseline: Rgba, current: Rgba, gain = 4): Rgba {
  const out = Buffer.alloc(baseline.width * baseline.height * 4);
  const n = baseline.width * baseline.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.abs(baseline.data[o + c] - current.data[o + c]) * gain);
    out[o + 3] = 255;
  }
  return { width: baseline.width, height: baseline.height, data: out };
}

function scaleNearest(src: Rgba, w: number, h: number): Rgba {
  if (src.width === w && src.height === h) return src;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w));
      const so = (sy * src.width + sx) * 4, o = (y * w + x) * 4;
      out[o] = src.data[so]; out[o + 1] = src.data[so + 1]; out[o + 2] = src.data[so + 2]; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** baseline | current | heat を横に並べる(各パネルは最大 tileW 幅へ縮小。パネルの間は 4px の隙間)。 */
export function sideBySide(panels: Rgba[], tileW = 480): Rgba {
  const gap = 4;
  const scaled = panels.map((p) => { const w = Math.min(tileW, p.width); return scaleNearest(p, w, Math.max(1, Math.round((p.height * w) / p.width))); });
  const h = Math.max(...scaled.map((p) => p.height));
  const w = scaled.reduce((a, p) => a + p.width, 0) + gap * (scaled.length - 1);
  const out = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 255;
  let x0 = 0;
  for (const p of scaled) {
    for (let y = 0; y < p.height; y++) p.data.copy(out, (y * w + x0) * 4, y * p.width * 4, (y + 1) * p.width * 4);
    x0 += p.width + gap;
  }
  return { width: w, height: h, data: out };
}
