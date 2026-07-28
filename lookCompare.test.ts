/**
 * lookCompare.ts（3D の絵の測光比較）の自己テスト。ネット不要・エンジン不要。
 *
 * 検証対象:
 *   [1-3]  CCT — 白 = D65(6504K) / 赤みが強いほど低い K / 真っ黒は null
 *   [4-6]  露出・コントラスト・分位点 — 半分の明るさ = -1EV、単色はコントラスト 0
 *   [7-9]  ヒストグラム — 正規化(合計 1)・EMD が 0 / ビン移動量と一致
 *   [10-12] 彩度・黒潰れ・白飛び
 *   [13-16] compareLook の delta と suggestions（ノブ名 / 映らない post ノブの但し書き）
 *
 * 実行: node lookCompare.test.ts（Node v24 型ストリップ）
 */

import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  analyzeLook, cctFromXy, cctFromLinearRgb, compareLook, histogramEmd, histogramL1,
  planckianUv, roundDelta, xyToUv1960,
} from "./lookCompare.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

/** 単色 PNG。 */
function solid(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** 左半分 a / 右半分 b の 2 色 PNG。 */
function halves(w: number, h: number, a: [number, number, number], b: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = x < w / 2 ? a : b;
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// ─── [1-3] 相関色温度（McCamy 近似） ───────────────────────────────────────
console.log("\n[1-3] CCT（McCamy 1992 の三次近似）");
{
  // 1. 白(線形 1,1,1) は sRGB の白色点 D65 = 6504K。McCamy の近似はここで ±5K に収まる。
  const white = cctFromLinearRgb(1, 1, 1);
  assert.ok(white.cct !== null && Math.abs(white.cct - 6504) < 10, `white cct=${white.cct}`);
  assert.ok(white.xy !== null && Math.abs(white.xy[0] - 0.3127) < 0.001 && Math.abs(white.xy[1] - 0.3290) < 0.001);
  pass(`線形 (1,1,1) → ${Math.round(white.cct!)}K（D65 = 6504K）`);

  // 2. 赤を盛る = 暖色 = 低い K、青を盛る = 寒色 = 高い K
  const warm = cctFromLinearRgb(1, 0.75, 0.45);
  const cool = cctFromLinearRgb(0.75, 0.85, 1);
  assert.ok(warm.cct !== null && warm.cct < 5000, `warm=${warm.cct}`);
  assert.ok(cool.cct !== null && cool.cct > 7500, `cool=${cool.cct}`);
  pass(`暖色 ${Math.round(warm.cct!)}K < D65 < 寒色 ${Math.round(cool.cct!)}K`);

  // 3. 黒体軌跡からの距離 Duv。D65 は公表値どおり +0.0032 付近。
  assert.ok(white.duv !== null && Math.abs(white.duv - 0.0032) < 0.0005, `D65 duv=${white.duv}`);
  // Duv は「CIE 1960 UCS 上での黒体軌跡との距離」そのもの（丸めた xy/CCT で手計算しても一致する）
  const [u, v] = xyToUv1960(0.3127, 0.3290);
  const locus = planckianUv(6504)!;
  assert.ok(Math.abs(Math.hypot(u - locus[0], v - locus[1]) - Math.abs(white.duv!)) < 1e-3);
  assert.equal(planckianUv(900), null);     // Krystek 近似の有効域(1000–15000K)外
  assert.equal(planckianUv(20000), null);
  pass(`D65 の Duv = ${white.duv!.toFixed(4)}（公表値 +0.0032 と一致）`);

  // 4. 真っ黒 / 収束点 / 黒体軌跡から離れすぎ は null（デタラメな K を返さない）。
  //    ★純青に McCamy をそのまま当てると 1667K という「もっともらしい嘘」が出る。
  //    Duv ガードが無いと AI に「kelvin を 1667 にしろ」と言ってしまう。
  assert.equal(cctFromLinearRgb(0, 0, 0).cct, null);
  assert.equal(cctFromXy(0.3320, 0.1858).cct, null);   // 収束点は分母 0
  const blue = cctFromLinearRgb(0, 0, 1);
  assert.equal(blue.cct, null);
  assert.ok(blue.duv !== null && Math.abs(blue.duv) > 0.2, `blue duv=${blue.duv}`);
  assert.match(blue.reason ?? "", /黒体軌跡から離れすぎ/);
  pass(`純青は Duv=${blue.duv!.toFixed(3)} で棄却（理由つきで null を返す）`);
}

// ─── [4-6] 露出とコントラスト ──────────────────────────────────────────────
console.log("\n[4-6] 露出（対数輝度）とコントラスト");
{
  // 4. sRGB 128 と sRGB 92 は線形でおよそ 2:1 → 差はほぼ -1EV
  const bright = analyzeLook(solid(32, 32, [128, 128, 128]));
  const dark = analyzeLook(solid(32, 32, [92, 92, 92]));
  const ev = dark.meanEV - bright.meanEV;
  assert.ok(Math.abs(ev - -1) < 0.05, `ev=${ev}`);
  pass(`sRGB 128 → 92 は ${ev.toFixed(3)}EV（線形で約 1/2 = -1EV）`);

  // 5. 単色はコントラスト(対数輝度の標準偏差)0、P5=P95
  assert.ok(bright.contrastEV < 1e-9);
  assert.ok(Math.abs(bright.p95EV - bright.p5EV) < 1e-9);
  assert.ok(Math.abs(bright.medianEV - bright.meanEV) < 0.02);
  pass("単色画像は contrastEV = 0 / dynamicRangeEV = 0");

  // 6. 明暗 2 色を混ぜるとコントラストが立つ（標準偏差 = 差の半分）
  const mixed = analyzeLook(halves(32, 32, [230, 230, 230], [20, 20, 20]));
  assert.ok(mixed.contrastEV > 1, `contrast=${mixed.contrastEV}`);
  assert.ok(mixed.dynamicRangeEV > 3, `range=${mixed.dynamicRangeEV}`);
  pass(`明暗 2 色は contrastEV=${mixed.contrastEV.toFixed(2)} / P5–P95=${mixed.dynamicRangeEV.toFixed(2)}EV`);
}

// ─── [7-9] ヒストグラムと EMD ──────────────────────────────────────────────
console.log("\n[7-9] 対数輝度ヒストグラムと EMD（累積分布の L1 距離）");
{
  // 7. 正規化されている（合計 1）／ビン数は指定どおり
  const s = analyzeLook(halves(40, 20, [200, 200, 200], [30, 30, 30]), { bins: 16 });
  assert.equal(s.histogram.length, 16);
  assert.ok(Math.abs(s.histogram.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(s.histogramRange.bins, 16);
  pass("ヒストグラムは合計 1 に正規化され、bins 指定が効く");

  // 8. 同じ分布の EMD は 0、L1 も 0
  assert.equal(histogramEmd(s.histogram, s.histogram, s.histogramRange.binWidthEV), 0);
  assert.equal(histogramL1(s.histogram, s.histogram), 0);
  pass("同一ヒストグラムの EMD / L1 は 0");

  // 9. 1 ビンだけずれた分布の EMD = ビン幅（1D EMD の定義そのもの）
  const a = [0, 1, 0, 0];
  const b = [0, 0, 1, 0];
  assert.ok(Math.abs(histogramEmd(a, b, 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(histogramEmd(a, [0, 0, 0, 1], 0.5) - 1.0) < 1e-12);
  assert.equal(histogramL1(a, b), 2);
  pass("1 ビン移動の EMD = ビン幅、2 ビン移動 = 2×ビン幅（累積分布の L1）");
}

// ─── [10-12] 彩度・黒潰れ・白飛び ─────────────────────────────────────────
console.log("\n[10-12] 彩度 / 黒潰れ / 白飛び");
{
  // 10. 無彩色は S=0・C*=0、原色は高い
  const gray = analyzeLook(solid(16, 16, [128, 128, 128]));
  const red = analyzeLook(solid(16, 16, [220, 30, 30]));
  assert.equal(gray.saturationHsv, 0);
  assert.ok(gray.chromaLab < 0.001);
  assert.ok(red.saturationHsv > 0.8, `S=${red.saturationHsv}`);
  assert.ok(red.chromaLab > 50, `C*=${red.chromaLab}`);
  pass(`無彩色 S=0 / 赤 S=${red.saturationHsv.toFixed(2)} C*=${red.chromaLab.toFixed(1)}`);

  // 11. 真っ黒は黒潰れ 100%、真っ白は白飛び 100%
  assert.equal(analyzeLook(solid(8, 8, [0, 0, 0])).blackClipPercent, 100);
  assert.equal(analyzeLook(solid(8, 8, [255, 255, 255])).whiteClipPercent, 100);
  assert.equal(analyzeLook(solid(8, 8, [128, 128, 128])).blackClipPercent, 0);
  pass("黒潰れ / 白飛び率が端で 100% / 中間で 0%");

  // 12. 閾値は引数で動かせる（黒潰れの定義を変えられる）
  const dim = solid(8, 8, [10, 10, 10]);
  assert.equal(analyzeLook(dim).blackClipPercent, 0);              // 既定 4 では潰れ扱いしない
  assert.equal(analyzeLook(dim, { blackLevel: 16 }).blackClipPercent, 100);
  pass("blackLevel / whiteLevel で潰れ判定の閾値を変えられる");
}

// ─── [13-16] compareLook（delta と示唆） ──────────────────────────────────
console.log("\n[13-16] compareLook — 差分と『次の一手』");
{
  // 13. 同じ絵なら diffRatio 0・露出差 0・示唆は「ほぼ一致」1 本
  const img = halves(32, 24, [180, 170, 160], [40, 42, 48]);
  const same = compareLook(img, img);
  assert.equal(same.diffRatio, 0);
  assert.equal(same.delta.exposureEV, 0);
  assert.equal(same.delta.histogramEmdEV, 0);
  assert.equal(same.suggestions.length, 1);
  assert.match(same.suggestions[0], /ほぼ一致/);
  pass("同一画像: diffRatio=0 / exposureEV=0 / 示唆は「ほぼ一致」のみ");

  // 14. 現在が暗い → exposureEV が負。示唆は「太陽の intensity ×2.0」を第一候補にし、
  //     スクショに映る exposure も併記する（-1EV のズレ → 現在値の ×2.0）
  const ref = solid(32, 32, [128, 128, 128]);
  const cur = solid(32, 32, [92, 92, 92]);
  const r = compareLook(ref, cur);
  assert.ok(r.delta.exposureEV < -0.9 && r.delta.exposureEV > -1.1, `ev=${r.delta.exposureEV}`);
  const expo = r.suggestions.find((s) => s.startsWith("露出:"));
  assert.ok(expo, "露出の示唆が無い");
  assert.match(expo!, /dx12_set_sun の intensity/);
  assert.match(expo!, /exposure/);
  assert.match(expo!, /×2\.0/);
  pass(`暗い側: ${r.delta.exposureEV.toFixed(2)}EV → 「intensity / exposure を ×2.0」と言える`);

  // 15. 彩度と色温度のズレも名指しできる（ノブ名 saturation / kelvin が入る）
  const grayRef = solid(32, 32, [140, 140, 140]);
  const warmCur = solid(32, 32, [190, 130, 80]);
  const r2 = compareLook(grayRef, warmCur);
  const sat = r2.suggestions.find((s) => s.startsWith("彩度:"));
  const cct = r2.suggestions.find((s) => s.startsWith("色温度:"));
  assert.ok(sat && /saturation/.test(sat), "彩度の示唆にノブ名が無い");
  assert.ok(cct && /kelvin/.test(cct), "色温度の示唆に kelvin が無い");
  assert.ok(r2.delta.cctDeltaK !== null && r2.delta.cctDeltaK < 0, `cctDelta=${r2.delta.cctDeltaK}`);
  assert.ok(r2.delta.saturationRatio > 1);
  // 合成画像は uiCompare と同じ横並び（幅 = 左 + 4px + 右）
  const sheet = PNG.sync.read(r2.compositePng);
  assert.equal(sheet.width, 32 + 4 + 32);
  pass(`暖色ズレ ${Math.round(r2.delta.cctDeltaK!)}K を検出し kelvin を名指しできる`);

  // 16. ★回帰防止(postVisible=false): ポスト前のシーン RT を測っているときは、post の
  //     グレーディング(contrast/saturation/warmth)は測定値に映らない。それらを勧める示唆には
  //     必ず「この数値では追い込めない」の但し書きが付くこと。
  //     これが無いと「下げた → 数値が変わらない → もう一度下げる」の無限ループになる。
  const softRef = halves(32, 24, [250, 250, 250], [5, 5, 5]);      // 硬い参照
  const flatCur = halves(32, 24, [150, 150, 150], [120, 120, 120]); // 眠い現在
  const r3 = compareLook(softRef, flatCur, { postVisible: false });
  for (const s of r3.suggestions) {
    if (/dx12_set_post_process の (contrast|saturation|warmth)/.test(s)) {
      assert.match(s, /この数値では追い込めない/, `post ノブの示唆に但し書きが無い: ${s}`);
      assert.match(s, /source:'final'|dx12_screenshot_final|dx12_ui_screenshot/,
        `post ノブの示唆に「ではどうするか」が無い: ${s}`);
    }
  }
  const con = r3.suggestions.find((s) => s.startsWith("コントラスト:"));
  assert.ok(con, "コントラストの示唆が無い");
  assert.match(con!, /ambient/);                    // 先に「光で作る」を勧める
  assert.match(con!, /この数値では追い込めない/);      // post を出すなら但し書きつき
  pass("source:'sceneRT' で測るときは post グレーディングの示唆に『この数値では追い込めない』が付く");

  // 17. ★本来あるべき形(postVisible=true / 既定): dx12_screenshot_final はバックバッファ
  //     ＝ポスト適用後の最終画なので、グレーディングも測定値に乗る。
  //     d993d5a で入れた「映らないから勧めるな」の歪みは外れていること。
  const r4 = compareLook(softRef, flatCur);   // 既定 = postVisible: true
  assert.deepEqual(r4.suggestions.length > 0, true);
  for (const s of r4.suggestions) {
    assert.doesNotMatch(s, /映らない|この数値では追い込めない/,
      `最終画を測っているのに「映らない」制約が残っている: ${s}`);
  }
  const con4 = r4.suggestions.find((s) => s.startsWith("コントラスト:"));
  assert.ok(con4, "コントラストの示唆が無い");
  assert.match(con4!, /ambient/);                       // ★絵作りの順序は変えない(まず光で作る)
  assert.match(con4!, /dx12_set_post_process の contrast/);  // post も素直に勧めてよい
  assert.match(con4!, /撮り直せばこの数値がそのまま動く/);      // 追い込めることを伝える
  // 統計そのものは撮り方に依存しない(変わるのは示唆の文面だけ)。
  assert.deepEqual(roundDelta(r4.delta), roundDelta(r3.delta));
  pass("既定(最終画)では post グレーディングを但し書き無しで勧められる＝示唆が本来の形に戻っている");
}

console.log(`\nOK: lookCompare テスト ${passed} 項目すべて通過`);
