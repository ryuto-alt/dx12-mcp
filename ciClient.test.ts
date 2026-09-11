/**
 * ciClient.ts（ヘッドレス CI）の自己テスト。純関数だけを対象にする（エンジン不要）。
 *
 * 検証対象:
 *   [1-3] shouldFail    — errors か到達不能があるシーンで CI を落とす
 *   [4-6] formatReport  — error だけ本文に出す / 到達不能を出す / 合格は 1 行
 *   [7-8] findFreePort  — 空きポートを見つける / 使用中を避ける
 *
 * 実行: node ciClient.test.ts
 */

import assert from "node:assert/strict";
import net from "node:net";
import { findFreePort, formatReport, portOpen, shouldFail, type SceneReport } from "./ciClient.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

const R = (over: Partial<SceneReport> = {}): SceneReport => ({
  scene: "scenes/main.json", errors: 0, warnings: 0, checked: 10, issues: [], failed: false, ...over,
});

// ─── [1-3] shouldFail ───────────────────────────────────────────────────────
console.log("\n[1-3] shouldFail（CI を落とす条件）");
{
  assert.equal(shouldFail([R(), R()]), false);
  pass("全部合格なら落とさない");

  assert.equal(shouldFail([R(), R({ failed: true, errors: 1 })]), true);
  pass("1 つでも不合格なら落とす");

  // 注意（warning）だけでは落とさない。落とすと誰も直さなくなる。
  assert.equal(shouldFail([R({ warnings: 5 })]), false);
  pass("警告だけでは落とさない");
}

// ─── [4-6] formatReport ─────────────────────────────────────────────────────
console.log("\n[4-6] formatReport（人が読む形）");
{
  const r = R({
    failed: true, errors: 1, warnings: 2,
    issues: [
      { kind: "Z_FIGHT", text: "面が重なっている", level: "error" },
      { kind: "FLOATING", text: "浮いている", level: "warning" },
    ],
  });
  const out = formatReport(r);
  assert.ok(out.startsWith("FAIL"), out);
  assert.ok(out.includes("Z_FIGHT"), "error は本文に出る");
  assert.ok(!out.includes("FLOATING"), "warning は本文に出さない（埋もれるので）");
  pass("error だけ本文に出し、warning は件数だけ");

  const reach = formatReport(R({
    failed: true,
    reachability: [{ pass: false, detail: "GP_Goal へ到達できない" }, { pass: true, detail: "ok" }],
  }));
  assert.ok(reach.includes("UNREACHABLE") && reach.includes("GP_Goal"));
  assert.ok(!reach.includes("detail: ok"));
  pass("到達不能は理由付きで出し、通ったものは出さない");

  assert.equal(formatReport(R()).split("\n").length, 1);
  pass("合格したシーンは 1 行だけ");
}

// ─── [7-8] portOpen / findFreePort ──────────────────────────────────────────
console.log("\n[7-8] ポート探索（CI を並列に回すため）");
{
  const free = await findFreePort(8990, 20);
  assert.ok(free >= 8990 && free < 9010, `free=${free}`);
  pass("空きポートを見つける");

  // 実際に塞いでみて、その番号を避けることを確かめる
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(free, "127.0.0.1", () => res()));
  assert.equal(await portOpen(free), true, "塞いだポートは open と判定される");
  const next = await findFreePort(free, 20);
  assert.notEqual(next, free, "使用中のポートは返さない");
  srv.close();
  pass("使用中のポートを避ける");
}

console.log(`\nOK: ${passed} 件すべて成功`);
