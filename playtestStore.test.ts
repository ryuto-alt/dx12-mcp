/**
 * playtestStore.ts（人のプレイを回帰テストに変える）の自己テスト。
 *
 * 検証対象:
 *   [1-5]  sessionToPlaytest — キー列の変換 / look の間引き / 無入力と欠落の拒否
 *   [6-8]  validatePlaytest  — 古い形式・壊れたファイルを走らせる前に弾く
 *   [9-11] referenceAt       — 記録と再生でサンプル時刻が揃わないので必ず補間する
 *   [12-16] compareReplay    — 終点ずれ / 経路ずれ / Lua 死亡、どれも「どこで」を返す
 *   [17-18] safeName         — ファイル名に使えない名前を弾く
 *
 * 実行: node playtestStore.test.ts
 */

import assert from "node:assert/strict";
import {
  PLAYTEST_VERSION, PlaytestConvertError, bakeGoldenRun, compareReplay, referenceAt, safeName,
  sessionToPlaytest, validatePlaytest, type PlaytestFile, type RawSession,
} from "./playtestStore.ts";
import type { TraceSample } from "./playtest.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

const session = (over: Partial<RawSession> = {}): RawSession => ({
  durationSec: 2,
  frames: 120,
  events: [
    { t: 0.0, kind: "key_down", detail: "W" },
    { t: 1.0, kind: "key_up", detail: "W" },
    { t: 1.2, kind: "key_down", detail: "SPACE" },
    { t: 1.3, kind: "key_up", detail: "SPACE" },
    { t: 1.5, kind: "lua", detail: "print" },      // 入力以外は無視される
  ],
  samples: [
    { t: 0.0, camPos: [0, 1.6, 0], camYaw: 0 },
    { t: 0.1, camPos: [0, 1.6, 1], camYaw: 5 },
    { t: 0.2, camPos: [0, 1.6, 2], camYaw: 10 },
    { t: 2.0, camPos: [0, 1.6, 8], camYaw: 10 },
  ],
  ...over,
});

// ─── [1-5] sessionToPlaytest ────────────────────────────────────────────────
console.log("\n[1-5] sessionToPlaytest（記録 → テスト）");
{
  const pt = sessionToPlaytest(session(), { name: "run", scene: "scenes/main.json" });
  assert.equal(pt.steps.length, 4, "キーイベントだけが steps になる");
  assert.deepStrictEqual(pt.steps[0], { t: 0, down: "W" });
  assert.deepStrictEqual(pt.steps[1], { t: 1, up: "W" });
  pass("key_down / key_up だけを steps に変換する");

  assert.equal(pt.reference.length, 4);
  assert.deepStrictEqual(pt.reference[3].pos, [0, 1.6, 8]);
  pass("カメラ軌跡を基準として持つ");

  // look は間引かれる（0.1 秒間隔なので 0.0/0.1/0.2/2.0 が全部残る）
  assert.ok(pt.look.length <= pt.reference.length);
  assert.equal(pt.look[0].yaw, 0);
  pass("yaw の目標列を持つ");

  // 入力ゼロの記録は保存しない（常に合格する無意味なテストを増やさない）
  assert.throws(
    () => sessionToPlaytest(session({ events: [] }), { name: "x", scene: "s" }),
    PlaytestConvertError);
  pass("入力が 1 つも無い記録は拒否する");

  // 記録がリング上限でこぼれていたら再生できない
  assert.throws(
    () => sessionToPlaytest(session({ droppedEvents: 12 }), { name: "x", scene: "s" }),
    /こぼれ/);
  pass("記録が欠けていたら拒否する（黙って短いテストを作らない）");

  // 記録中に決定論ステップを使うと、実時間 1.5 秒で 210 フレーム進むような記録になる。
  // 時刻が意味を失って再生が必ずずれるので、変換の時点で弾く。
  assert.throws(
    () => sessionToPlaytest(session({ durationSec: 1.5, frames: 900 }), { name: "x", scene: "s" }),
    /実時間と噛み合っていない/);
  pass("決定論ステップで作った記録を拒否する（時刻が意味を失うため）");

  // 普通に遊んだ記録（60〜144fps 程度）は通る
  sessionToPlaytest(session({ durationSec: 2, frames: 288 }), { name: "x", scene: "s" });
  pass("144fps 程度の普通の記録は通る");
}

// ─── [6-8] validatePlaytest ─────────────────────────────────────────────────
console.log("\n[6-8] validatePlaytest（走らせる前に弾く）");
{
  const ok = sessionToPlaytest(session(), { name: "run", scene: "scenes/main.json" });
  assert.deepStrictEqual(validatePlaytest(ok), []);
  pass("正しいファイルは指摘なし");

  assert.ok(validatePlaytest({ ...ok, version: 0 }).some((e) => /version/.test(e)));
  pass("古い形式を弾く");

  assert.ok(validatePlaytest({ ...ok, steps: [] }).some((e) => /steps/.test(e)));
  pass("steps が空のものを弾く");
}

// ─── [9-11] referenceAt ─────────────────────────────────────────────────────
console.log("\n[9-11] referenceAt（時刻がずれても比べられる）");
{
  const ref = [
    { t: 0, pos: [0, 0, 0] as [number, number, number] },
    { t: 1, pos: [0, 0, 10] as [number, number, number] },
  ];
  assert.deepStrictEqual(referenceAt(ref, 0.5), [0, 0, 5]);
  pass("間の時刻は線形補間する");
  assert.deepStrictEqual(referenceAt(ref, -5), [0, 0, 0]);
  pass("開始より前は最初の点");
  assert.deepStrictEqual(referenceAt(ref, 99), [0, 0, 10]);
  pass("終了より後は最後の点");
}

// ─── [12-16] compareReplay ──────────────────────────────────────────────────
console.log("\n[12-16] compareReplay（どこでずれたかを返す）");
{
  const pt: PlaytestFile = sessionToPlaytest(session(), { name: "run", scene: "s" });
  const same: TraceSample[] = pt.reference.map((r) => ({ t: r.t, pos: r.pos }));

  assert.equal(compareReplay(pt, same).pass, true);
  pass("同じ軌跡なら合格");

  // 終点だけ大きくずれる
  const offEnd = same.map((s, i) =>
    i === same.length - 1 ? { t: s.t, pos: [0, 1.6, 20] as [number, number, number] } : s);
  const v1 = compareReplay(pt, offEnd);
  assert.equal(v1.pass, false);
  assert.ok(v1.reasons.some((r) => /終点/.test(r)), v1.reasons.join(" / "));
  assert.ok(v1.endDistance > 10);
  pass("終点がずれたら落ちる（記録値と実測値を両方出す）");

  // 途中だけ大きくずれる（終点は戻ってくる）
  const offMid = same.map((s) =>
    s.t === 0.1 ? { t: s.t, pos: [30, 1.6, 1] as [number, number, number] } : s);
  const v2 = compareReplay(pt, offMid);
  assert.equal(v2.pass, false);
  assert.ok(v2.reasons.some((r) => /経路/.test(r)));
  assert.equal(v2.maxDeviationAt, 0.1, "ずれた時刻を返す");
  pass("途中でずれたら『いつ』を返す");

  assert.equal(compareReplay(pt, same, 3).pass, false);
  assert.ok(compareReplay(pt, same, 3).reasons.some((r) => /Lua/.test(r)));
  pass("再生中に Lua が死んだら落ちる");

  assert.equal(compareReplay(pt, []).pass, false);
  pass("サンプルが取れなかったら落ちる（黙って合格にしない）");
}

// ─── [19-21] bakeGoldenRun ──────────────────────────────────────────────────
console.log("\n[19-21] bakeGoldenRun（基準は初回再生）");
{
  const pt = sessionToPlaytest(session(), { name: "run", scene: "s" });
  const replay: TraceSample[] = [
    { t: 0, pos: [0, 1.6, 0] },
    { t: 1, pos: [0, 1.6, 5] },
    { t: 2, pos: [0, 1.6, 9] },     // 人は 8 まで行った。再生は 9
  ];
  const baked = bakeGoldenRun(pt, replay);

  assert.deepStrictEqual(baked.reference[2].pos, [0, 1.6, 9]);
  pass("基準が初回再生の軌跡に置き換わる");

  assert.deepStrictEqual(baked.humanReference?.[3].pos, [0, 1.6, 8]);
  pass("人の軌跡は参考として残る");

  assert.ok((baked.humanDrift ?? 0) >= 1, `humanDrift=${baked.humanDrift}`);
  pass("人の軌跡からのずれを記録する（再現できていない印になる）");

  // 焼いた基準に対して同じ再生をぶつければ当然合格する
  assert.equal(compareReplay(baked, replay).pass, true);
  pass("焼いた基準に対して同じ再生は合格する");

  assert.throws(() => bakeGoldenRun(pt, []), PlaytestConvertError);
  pass("再生に失敗していたら焼かない");
}

// ─── [17-18] safeName ───────────────────────────────────────────────────────
console.log("\n[17-18] safeName（ファイル名）");
{
  assert.equal(safeName("ボス戦 run 1"), "run_1");
  pass("使えない文字を落とす");
  assert.throws(() => safeName("日本語だけ"), PlaytestConvertError);
  pass("全部落ちる名前は拒否する（無名ファイルを作らない）");
}

console.log(`\nOK: ${passed} 件すべて成功`);
