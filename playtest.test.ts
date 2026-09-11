/**
 * playtest.ts（テストプレイの台本・断言・移動能力）の自己テスト。
 *
 * 検証対象:
 *   [1-5]   compileTimeline — 時刻→フレームの丸め / 同フレームの併合 / 昇順
 *   [6-7]   danglingKeys    — 押しっぱなしのまま終わるキーを拾う（次のテストへ漏らさない）
 *   [8-13]  evaluate        — at / by / near / yAbove / grounded / movedAtLeast と失敗時のヒント
 *   [14-18] analyzePath     — 登れない段差・届かない隙間・戻れない落下
 *   [19-20] yawTowards      — +Z が前・右回りが正
 *   [21-22] capabilityWarnings — 実測が 0 のときに測り直しを促す
 *
 * 実行: node playtest.test.ts（エンジン不要）
 */

import assert from "node:assert/strict";
import {
  analyzePath, capabilityWarnings, compileTimeline, danglingKeys, evaluate, scriptDuration,
  mouseDeltaForYaw, wrapDeg, yawTowards, type MovementCapability, type TraceSample,
} from "./playtest.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

const DT = 1 / 60;

// ─── [1-5] compileTimeline ──────────────────────────────────────────────────
console.log("\n[1-5] compileTimeline（台本→フレーム）");
{
  const c = compileTimeline([{ t: 0, down: "W" }, { t: 1, up: "W" }], DT);
  assert.deepStrictEqual(c.map((e) => e.frame), [0, 60]);
  pass("秒がフレーム番号になる");

  // 0.05s は 3 フレーム（floor だと 2 になり 0.0333s にずれる）
  assert.equal(compileTimeline([{ t: 0.05, press: "SPACE" }], DT)[0].frame, 3);
  pass("時刻は floor ではなく round で最も近いフレームに乗る");

  const merged = compileTimeline([{ t: 0, down: "W" }, { t: 0.001, down: "SHIFT" }], DT);
  assert.equal(merged.length, 1, "同じフレームに落ちたら 1 件にまとまる");
  assert.deepStrictEqual(merged[0].downs, ["W", "SHIFT"]);
  pass("同じフレームの指示はまとまる");

  const sorted = compileTimeline([{ t: 2, up: "W" }, { t: 0, down: "W" }], DT);
  assert.ok(sorted[0].frame < sorted[1].frame, "昇順に並ぶ");
  pass("入力順に関わらずフレーム昇順で返る");

  assert.equal(scriptDuration([{ t: 0 }, { t: 3.5 }, { t: 1 }]), 3.5);
  pass("scriptDuration が最後の指示の時刻を返す");
}

// ─── [6-7] danglingKeys ─────────────────────────────────────────────────────
console.log("\n[6-7] danglingKeys（押しっぱなしの漏れ）");
{
  assert.deepStrictEqual(danglingKeys([{ t: 0, down: "W" }, { t: 1, up: "W" }]), []);
  pass("離していれば漏れなし");
  assert.deepStrictEqual(danglingKeys([{ t: 0, down: ["W", "D"] }, { t: 1, up: "W" }]), ["D"]);
  pass("離し忘れたキーを拾う");
}

// ─── [8-13] evaluate ────────────────────────────────────────────────────────
console.log("\n[8-13] evaluate（断言）");
{
  const trace: TraceSample[] = [
    { t: 0.0, pos: [0, 0, 0], grounded: true },
    { t: 0.5, pos: [0, 1.2, 2], grounded: false },
    { t: 1.0, pos: [0, 0, 4], grounded: true },
    { t: 1.5, pos: [0, 0, 6], grounded: true },
  ];

  assert.ok(evaluate(trace, [{ near: [0, 0, 6], radius: 0.5 }])[0].pass);
  pass("near: 走行中どこかで到達していれば合格");

  assert.ok(!evaluate(trace, [{ near: [0, 0, 6], radius: 0.5, by: 0.6 }])[0].pass);
  pass("by: 期限より後の到達は不合格");

  const r = evaluate(trace, [{ near: [10, 0, 0], radius: 0.5 }])[0];
  assert.ok(!r.pass && /最接近/.test(r.detail), `失敗理由に最接近が入る: ${r.detail}`);
  pass("失敗時は最接近距離をヒントに出す");

  assert.ok(evaluate(trace, [{ at: 0.5, yAbove: 1 }])[0].pass);
  pass("at: 指定時刻に最も近いサンプルで判定する");

  assert.ok(evaluate(trace, [{ by: 1.0, grounded: false }])[0].pass);
  pass("grounded の判定");

  assert.ok(evaluate(trace, [{ movedAtLeast: 5 }])[0].pass);
  assert.ok(!evaluate(trace, [{ movedAtLeast: 50 }])[0].pass);
  pass("movedAtLeast は開始位置からの水平距離で見る");
}

// ─── [14-18] analyzePath ────────────────────────────────────────────────────
console.log("\n[14-18] analyzePath（到達性）");
{
  const cap: MovementCapability = {
    walkSpeed: 4, jumpHeight: 1.2, jumpDistance: 4.0, stepHeight: 0.3, maxSlopeDeg: 50,
  };

  assert.equal(analyzePath([[0, 0, 0], [0, 0, 3]], cap).length, 0);
  pass("平坦な短い区間は指摘なし");

  const tall = analyzePath([[0, 0, 0], [0, 3, 1]], cap);
  assert.ok(tall.length > 0 && /登れない/.test(tall[0].reason));
  pass("ジャンプ高を超える登りを拾う");

  const far = analyzePath([[0, 0, 0], [0, 1, 8]], cap);
  assert.ok(far.some((i) => /跳び越し/.test(i.reason)), JSON.stringify(far));
  pass("ジャンプ距離を超える隙間を拾う");

  const drop = analyzePath([[0, 20, 0], [0, 0, 2]], cap);
  assert.ok(drop.some((i) => /戻れない/.test(i.reason)));
  pass("戻れない落下を拾う（詰み予防）");

  // 安全率のぶん、ちょうど届く距離は「届かない」と言う（言い切って外すより安全側）
  const edge = analyzePath([[0, 0, 0], [0, 0.5, 3.9]], cap);
  assert.ok(edge.some((i) => /跳び越し/.test(i.reason)), "3.9m は安全率込み 3.4m を超える");
  pass("安全率を掛けてぎりぎりは『届かない』側に倒す");
}

// ─── [19-20] yawTowards ─────────────────────────────────────────────────────
console.log("\n[19-20] yawTowards（向き）");
{
  assert.equal(Math.round(yawTowards([0, 0, 0], [0, 0, 5])), 0, "+Z が前 = yaw 0");
  pass("+Z を向くと yaw 0");
  assert.equal(Math.round(yawTowards([0, 0, 0], [5, 0, 0])), 90, "+X は右回り 90 度");
  pass("+X を向くと yaw 90（右回りが正）");
}

// ─── [21-22] capabilityWarnings ─────────────────────────────────────────────
console.log("\n[21-22] capabilityWarnings（実測の妥当性）");
{
  const zero: MovementCapability = {
    walkSpeed: 0, jumpHeight: 0, jumpDistance: 0, stepHeight: 0.3, maxSlopeDeg: 50,
  };
  const w = capabilityWarnings(zero);
  assert.ok(w.some((x) => /歩行速度/.test(x)));
  pass("歩行速度 0 を警告する");
  assert.ok(w.some((x) => /ジャンプ高/.test(x)));
  pass("ジャンプ高 0 を警告する");
}

// ─── [23-27] wrapDeg / mouseDeltaForYaw ─────────────────────────────────────
console.log("\n[23-27] 向きを合わせる（感度が未知でも効く閉ループ）");
{
  assert.equal(wrapDeg(370), 10);
  assert.equal(wrapDeg(-190), 170);
  pass("wrapDeg が -180..180 に畳む");

  // 359 度から 1 度へは +2 度（-358 度ではない）
  assert.equal(wrapDeg(1 - 359), 2);
  pass("359→1 は +2 度として扱う（遠回りしない）");

  // 感度が未知なら probe 量を、符号は誤差の向きで返す
  assert.equal(mouseDeltaForYaw(0, 90, null, 120), 120);
  assert.equal(mouseDeltaForYaw(0, -90, null, 120), -120);
  pass("感度が未知なら probe 量を返す（符号は誤差の向き）");

  // 感度が分かっていれば比例で出す
  assert.equal(mouseDeltaForYaw(0, 30, 0.12), 250);
  pass("感度が分かれば必要ピクセル数を比例で出す");

  // 行き過ぎて振動しないよう上限が掛かる
  assert.ok(Math.abs(mouseDeltaForYaw(0, 179, 0.001)) <= 800);
  pass("1 フレームの回し量に上限が掛かる（振動しない）");
}

console.log(`\nOK: ${passed} 件すべて成功`);
