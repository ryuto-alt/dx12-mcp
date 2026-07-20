import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { compareUiImages } from "./uiCompare.ts";

// 単色PNGをその場で生成するヘルパ。
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ── 同一画像: diffRatio は 0%、合成幅 = 左 + 4px区切り + 右 ──
{
  const img = solidPng(32, 16, [40, 120, 200]);
  const r = compareUiImages(img, img);
  assert.equal(r.diffRatio, 0);
  assert.deepEqual(r.refSize, { width: 32, height: 16 });
  assert.deepEqual(r.curSize, { width: 32, height: 16 });
  const out = PNG.sync.read(r.compositePng);
  assert.equal(out.width, 32 + 4 + 32);
  assert.equal(out.height, 16);
  // 左端は参照の色、区切り線の直後(右側先頭)は現在の色。
  assert.equal(out.data[0], 40);
  const rightStart = (0 * out.width + 36) * 4;
  assert.equal(out.data[rightStart], 40);
}

// ── 反転画像(白 vs 黒): diffRatio はほぼ100% ──
{
  const white = solidPng(20, 20, [255, 255, 255]);
  const black = solidPng(20, 20, [0, 0, 0]);
  const r = compareUiImages(white, black);
  assert.ok(r.diffRatio > 99, `diffRatio=${r.diffRatio}`);
}

// ── 高さが違う2枚: 高い方に揃い、幅はアスペクト比を保ってスケール ──
{
  const ref = solidPng(100, 50, [10, 10, 10]);   // 高さ50 → 100 に拡大、幅も2倍
  const cur = solidPng(60, 100, [10, 10, 10]);
  const r = compareUiImages(ref, cur);
  const out = PNG.sync.read(r.compositePng);
  assert.equal(out.height, 100);
  assert.equal(out.width, 200 + 4 + 60);
  // 同色なので(サイズ正規化後)差分はほぼ0。
  assert.ok(r.diffRatio < 1, `diffRatio=${r.diffRatio}`);
}

// ── grid=true: 右側だけにグリッドが重畳され、色が変わる ──
{
  const img = solidPng(64, 32, [100, 100, 100]);
  const r = compareUiImages(img, img, { grid: true });
  const out = PNG.sync.read(r.compositePng);
  // 左側 (1,1) はグリッド非対象で元色のまま。
  const li = (1 * out.width + 1) * 4;
  assert.equal(out.data[li], 100);
  // 右側のグリッド線上 (x%8==0) は元色から変化している。
  const gi = (1 * out.width + (64 + 4 + 8)) * 4;
  assert.notEqual(out.data[gi], 100);
  // 右側のグリッド線でないピクセル (x%8!=0 && y%8!=0) は元色のまま。
  const pi = (3 * out.width + (64 + 4 + 3)) * 4;
  assert.equal(out.data[pi], 100);
  // grid は diffRatio(元画像同士の比較)に影響しない。
  assert.equal(r.diffRatio, 0);
}

// ── diffThreshold: 距離が閾値以下なら差分に数えない ──
{
  const a = solidPng(10, 10, [100, 100, 100]);
  const b = solidPng(10, 10, [110, 100, 100]); // 距離10
  assert.equal(compareUiImages(a, b, { diffThreshold: 30 }).diffRatio, 0);
  assert.equal(compareUiImages(a, b, { diffThreshold: 5 }).diffRatio, 100);
}

console.log("OK: UI比較合成テスト通過");
