/**
 * contactSheet.ts（カメラ経路の生成 + コンタクトシート合成）の自己テスト。
 * ネット不要・エンジン不要。
 *
 * 検証対象:
 *   [1-4]  planCameraPath — line の等間隔補間 / orbit の円周と方位角の向き / 引数不足の拒否
 *   [5-8]  buildContactSheet — 格子の寸法 / タイル配置 / フレーム番号の焼き込み
 *   [9-11] frameDiffs — 連続フレーム差分率と「跳ねた場所」の特定
 *
 * 実行: node contactSheet.test.ts
 */

import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  buildContactSheet, diffRatioPercent, drawLabel, planCameraPath, resizeNearest, textWidth,
} from "./contactSheet.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

function solid(w: number, h: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

// ─── [1-4] カメラ経路 ──────────────────────────────────────────────────────
console.log("\n[1-4] planCameraPath（撮影する視点の列）");
{
  // 1. line: 始点と終点を含み、間は等間隔
  const p = planCameraPath({ mode: "line", frames: 3, from: [0, 2, 0], to: [10, 2, 0], target: [5, 0, 0] });
  assert.equal(p.length, 3);
  assert.deepEqual(p[0].position, [0, 2, 0]);
  assert.deepEqual(p[1].position, [5, 2, 0]);
  assert.deepEqual(p[2].position, [10, 2, 0]);
  assert.deepEqual(p[1].target, [5, 0, 0]);   // target 単独指定は全カットで固定
  pass("line: from → to を等間隔で補間し、両端を必ず含む");

  // 2. line: 注視点も fromTarget → toTarget で補間される（パン撮り）
  const p2 = planCameraPath({
    mode: "line", frames: 3, from: [0, 0, 0], to: [0, 0, 0],
    fromTarget: [0, 0, 10], toTarget: [10, 0, 10],
  });
  assert.deepEqual(p2[1].target, [5, 0, 10]);
  pass("line: fromTarget → toTarget も補間される（位置固定のパン撮りができる）");

  // 3. orbit: +Z が 0°、+X が 90°（dx12_set_sun の azimuth と同じ向き）。
  //    全周は終端が始端と重ならないよう自動で 1 枚分詰める。
  const o = planCameraPath({ mode: "orbit", frames: 4, target: [0, 1, 0], radius: 10, height: 2 });
  assert.equal(o.length, 4);
  assert.ok(near(o[0].position[0], 0) && near(o[0].position[2], 10), `0°=${o[0].position}`);
  assert.ok(near(o[1].position[0], 10) && near(o[1].position[2], 0, 1e-9), `90°=${o[1].position}`);
  assert.ok(near(o[2].position[0], 0, 1e-9) && near(o[2].position[2], -10), `180°=${o[2].position}`);
  assert.ok(near(o[3].position[0], -10), `270°=${o[3].position}`);
  assert.ok(o.every((q) => near(q.position[1], 3)));            // center.y(1) + height(2)
  assert.ok(o.every((q) => q.target![0] === 0 && q.target![2] === 0));
  pass("orbit: +Z=0° / +X=90° の円周を等分し、全周では始端と重複しない");

  // 4. 引数不足は「何を渡せばいいか」を書いて拒否する
  assert.throws(() => planCameraPath({ mode: "orbit", target: [0, 0, 0] }), /radius/);
  assert.throws(() => planCameraPath({ mode: "orbit", radius: 5 }), /target/);
  assert.throws(() => planCameraPath({ mode: "line", from: [0, 0, 0] }), /to/);
  assert.throws(() => planCameraPath({ mode: "line", from: [0, 0], to: [1, 1, 1] } as any), /from/);
  pass("必要な引数が無ければ理由つきで throw（憶測で 0 埋めしない）");
}

// ─── [5-8] コンタクトシート合成 ────────────────────────────────────────────
console.log("\n[5-8] buildContactSheet（格子合成とフレーム番号）");
{
  const frames = [
    solid(64, 32, [200, 40, 40]),
    solid(64, 32, [40, 200, 40]),
    solid(64, 32, [40, 40, 200]),
    solid(64, 32, [200, 200, 40]),
  ];

  // 5. 寸法: columns 列 × ceil(n/columns) 行、隙間は (列数+1) 本
  const s = buildContactSheet(frames, { columns: 2 });
  assert.equal(s.columns, 2);
  assert.equal(s.rows, 2);
  assert.deepEqual(s.tile, { width: 64, height: 32 });
  const out = PNG.sync.read(s.sheetPng);
  assert.equal(out.width, 2 * 64 + 3 * 4);
  assert.equal(out.height, 2 * 32 + 3 * 4);
  pass(`格子 2×2 → ${out.width}×${out.height}px（タイル 64×32 + 隙間 4px）`);

  // 6. 配置: 1 枚目は左上、2 枚目は右上（各タイルの右下隅で色を確認。左上はラベルが乗る）
  const at = (x: number, y: number) => {
    const i = (y * out.width + x) * 4;
    return [out.data[i], out.data[i + 1], out.data[i + 2]];
  };
  assert.deepEqual(at(4 + 63, 4 + 31), [200, 40, 40]);          // タイル 1 右下 = 赤
  assert.deepEqual(at(4 + 64 + 4 + 63, 4 + 31), [40, 200, 40]);  // タイル 2 右下 = 緑
  assert.deepEqual(at(4 + 63, 4 + 32 + 4 + 31), [40, 40, 200]);  // タイル 3 右下 = 青
  pass("タイルは左上から行優先で並ぶ（1,2 / 3,4）");

  // 7. フレーム番号が焼き込まれている（左上に元の色でない画素が出る）
  let stamped = false;
  for (let y = 4; y < 4 + 16 && !stamped; y++) {
    for (let x = 4; x < 4 + 40; x++) {
      const c = at(x, y);
      if (c[0] !== 200 || c[1] !== 40 || c[2] !== 40) { stamped = true; break; }
    }
  }
  assert.ok(stamped, "フレーム番号が描かれていない");
  // label:false なら焼かない（差分測定の邪魔をしたくない時用）
  const plain = PNG.sync.read(buildContactSheet(frames, { columns: 2, label: false }).sheetPng);
  const pi = (6 * plain.width + 6) * 4;
  assert.deepEqual([plain.data[pi], plain.data[pi + 1], plain.data[pi + 2]], [200, 40, 40]);
  pass("フレーム番号を焼き込む / label:false で焼かない");

  // 8. 3x5 フォントの幅計算とリサイズ
  assert.equal(textWidth("1/4", 2), 3 * 3 * 2 + 2 * 1 * 2);
  assert.equal(textWidth("", 2), 0);
  const small = resizeNearest(PNG.sync.read(frames[0]), 16, 8);
  assert.equal(small.width, 16);
  assert.equal(small.height, 8);
  assert.equal(small.data[0], 200);
  const canvas = new PNG({ width: 40, height: 20 });
  drawLabel(canvas, "12/34", 4, 4, 1);   // 例外を出さずに描けること（未知文字も空白扱い）
  drawLabel(canvas, "?!", 4, 4, 1);
  pass("textWidth / resizeNearest / drawLabel（未知文字は空白扱いで落ちない）");
}

// ─── [9-11] 連続フレーム差分 ───────────────────────────────────────────────
console.log("\n[9-11] frameDiffs（ちらつき・ポップの当たり付け）");
{
  // 9. 全部同じ絵なら差分 0、maxDiff も 0
  const same = buildContactSheet([solid(32, 16, [90, 90, 90]), solid(32, 16, [90, 90, 90]), solid(32, 16, [90, 90, 90])]);
  assert.deepEqual(same.frameDiffs, [0, 0]);
  assert.deepEqual(same.maxDiff, { percent: 0, fromFrame: 1, toFrame: 2 });
  pass("同一フレームの連続 → frameDiffs 全 0");

  // 10. 3 枚目だけ真っ白 = 2→3 と 3→4 が跳ねる。maxDiff がその境界を指す。
  const flick = buildContactSheet([
    solid(32, 16, [10, 10, 10]),
    solid(32, 16, [10, 10, 10]),
    solid(32, 16, [255, 255, 255]),
    solid(32, 16, [10, 10, 10]),
  ]);
  assert.deepEqual(flick.frameDiffs, [0, 100, 100]);
  assert.equal(flick.maxDiff!.fromFrame, 2);
  assert.equal(flick.maxDiff!.toFrame, 3);
  assert.equal(flick.maxDiff!.percent, 100);
  pass("1 枚だけ飛んだフレームを frameDiffs の山として特定できる");

  // 11. 閾値以下の微小な差は数えない（ノイズで山を作らない）
  const a = PNG.sync.read(solid(16, 16, [100, 100, 100]));
  const b = PNG.sync.read(solid(16, 16, [110, 100, 100]));   // RGB 距離 10
  assert.equal(diffRatioPercent(a, b, 30), 0);
  assert.equal(diffRatioPercent(a, b, 5), 100);
  assert.throws(() => buildContactSheet([]), /1 枚もありません/);
  pass("diffThreshold 以下の差は無視 / 画像 0 枚は理由つきで throw");
}

console.log(`\nOK: contactSheet テスト ${passed} 項目すべて通過`);
