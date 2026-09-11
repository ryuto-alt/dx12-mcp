/**
 * sceneOrganize.ts（グループ分けと命名規則）の自己テスト。
 *
 * 検証対象:
 *   [1-4]  isDefaultName — Box / Cube.001 / Sphere_2 を「名前が付いていない」と判定する
 *   [5-9]  classify      — コンポーネントを名前より優先する（名前は嘘をつく）
 *   [10-13] toKind       — 日本語・空白・Blender の .001 を落として英数字の Kind にする
 *   [14-19] planOrganize — 連番の衝突回避 / 既に規約どおりなら触らない（＝冪等）/ 子は親ごと動く
 *   [20-24] lintNames    — 既定名・接頭辞なし・重複名・ルート直下を数える
 *
 * 実行: node sceneOrganize.test.ts（エンジン不要）
 */

import assert from "node:assert/strict";
import {
  GROUPS, GROUP_ORDER, classify, conventionText, findNameReferences, isDefaultName, lintNames,
  planOrganize, toKind,
  type EntityInfo,
} from "./sceneOrganize.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

const E = (id: number, name: string, comps: string[] = [], parent?: number): EntityInfo =>
  ({ entityId: id, name, componentTypes: comps, parent });

// ─── [1-4] isDefaultName ────────────────────────────────────────────────────
console.log("\n[1-4] isDefaultName（既定名の検出）");
{
  assert.ok(isDefaultName("Box"));
  pass("Box は既定名");
  assert.ok(isDefaultName("Cube.001"), "Blender 由来の連番も既定名");
  pass("Cube.001 は既定名");
  assert.ok(isDefaultName("Sphere_2"));
  pass("Sphere_2 は既定名");
  assert.ok(!isDefaultName("ENV_Rock_03"));
  pass("ENV_Rock_03 は既定名ではない");
}

// ─── [5-9] classify ─────────────────────────────────────────────────────────
console.log("\n[5-9] classify（コンポーネント優先の分類）");
{
  // 名前が "Floor" でもライトが付いていればライト。コンポーネントの方が正しい。
  assert.equal(classify(E(1, "Floor", ["pointLight"])), "LGT");
  pass("pointLight は名前に関わらず LGT");

  assert.equal(classify(E(2, "Thing", ["uiButton"])), "UI");
  pass("uiButton は UI");

  assert.equal(classify(E(3, "Thing", ["particleEmitter"])), "FX");
  pass("particleEmitter は FX");

  // 名前しか手掛かりが無いときは名前で決める
  assert.equal(classify(E(4, "Platform_A", ["meshRenderer"])), "LVL");
  pass("名前に platform があれば LVL");

  assert.equal(classify(E(5, "Enemy_Slime", ["meshRenderer"])), "GP");
  pass("名前に enemy があれば GP");
}

// ─── [10-13] toKind ─────────────────────────────────────────────────────────
console.log("\n[10-13] toKind（Kind 部分の正規化）");
{
  assert.equal(toKind("Rock.001", "Prop"), "Rock");
  pass("Blender の .001 を落とす");
  assert.equal(toKind("赤い箱", "Prop"), "Prop", "日本語だけなら fallback");
  pass("日本語だけなら fallback を使う");
  assert.equal(toKind("wooden crate", "Prop"), "Wooden_crate");
  pass("空白は _ になり先頭が大文字になる");
  assert.equal(toKind("ENV_Rock_03", "Prop"), "Rock", "既に規約名なら Kind を取り出す");
  pass("規約名から Kind を取り出す（撃ち直しで名前が伸びない）");
}

// ─── [14-19] planOrganize ───────────────────────────────────────────────────
console.log("\n[14-19] planOrganize（整理計画）");
{
  const scene: EntityInfo[] = [
    E(1, "Box", ["meshRenderer"]),
    E(2, "Box_2", ["meshRenderer"]),
    E(3, "Sun", ["directionalLight"]),
  ];
  const p = planOrganize(scene);
  assert.equal(p.moves.length, 3);
  pass("規約外の 3 件が全部計画に乗る");

  const names = p.moves.map((m) => m.newName);
  assert.equal(new Set(names).size, 3, "新しい名前が衝突しない");
  pass("新しい名前が互いに衝突しない");

  assert.ok(names.some((n) => /^LGT_Sun/.test(n)), `LGT が付く: ${names}`);
  pass("directionalLight は LGT_Sun_NN になる");

  // 既存の規約名の番号は避ける
  const scene2: EntityInfo[] = [
    E(10, "ENV", []),                       // グループのルート
    E(1, "ENV_Prop_01", ["meshRenderer"], 10),
    E(2, "Box", ["meshRenderer"]),
  ];
  const p2 = planOrganize(scene2);
  const created = p2.moves.find((m) => m.entityId === 2)!;
  assert.notEqual(created.newName, "ENV_Prop_01", "使用済み番号を再利用しない");
  pass("既存の連番を避けて採番する");

  // 冪等: 規約どおりに整ったシーンは 1 件も動かさない
  const tidy: EntityInfo[] = [
    E(10, "ENV", []),
    E(11, "LIGHT", []),
    E(1, "ENV_Rock_01", ["meshRenderer"], 10),
    E(2, "LGT_Sun_01", ["directionalLight"], 11),
  ];
  assert.equal(planOrganize(tidy).moves.length, 0);
  pass("既に規約どおりなら何もしない（冪等）");

  // 子（グループ以外の親を持つもの）は親ごと動くので触らない
  const nested: EntityInfo[] = [
    E(10, "ENV", []),
    E(1, "ENV_Table_01", ["meshRenderer"], 10),
    E(2, "Drawer", ["meshRenderer"], 1),
  ];
  const p3 = planOrganize(nested);
  assert.ok(!p3.moves.some((m) => m.entityId === 2), "子は計画に乗らない");
  pass("子は親ごと動くので触らない");
}

// ─── [20-24] lintNames ──────────────────────────────────────────────────────
console.log("\n[20-24] lintNames（命名の lint）");
{
  const issues = lintNames([
    E(10, "ENV", []),
    E(1, "Box", ["meshRenderer"]),                 // 既定名
    E(2, "myRock", ["meshRenderer"], 10),          // 接頭辞なし
    E(3, "ENV_Rock_01", ["meshRenderer"], 10),     // OK
    E(4, "ENV_Rock_01", ["meshRenderer"], 10),     // 重複名
    E(5, "ENV_箱 A", ["meshRenderer"], 10),        // 空白と日本語
    E(6, "ENV_Crate_02", ["meshRenderer"]),        // 名前は規約どおりだがルート直下
  ]);
  const kinds = issues.map((i) => i.kind);
  assert.ok(kinds.includes("DEFAULT_NAME"));
  pass("既定名を拾う");
  assert.ok(kinds.includes("NO_PREFIX"));
  pass("接頭辞なしを拾う");
  assert.ok(kinds.includes("DUPLICATE_NAME"));
  pass("重複名を拾う");
  assert.ok(kinds.includes("BAD_CHARS"));
  pass("空白 / 非 ASCII を拾う");
  assert.ok(kinds.includes("NOT_IN_GROUP"), "ルート直下の ENV_Crate_02 を拾う");
  pass("ルート直下に浮いているものを拾う");

  // 規約どおりのシーンは指摘ゼロ
  assert.equal(lintNames([E(10, "ENV", []), E(1, "ENV_Rock_01", ["meshRenderer"], 10)]).length, 0);
  pass("規約どおりなら指摘ゼロ");
}

// ─── [26-30] findNameReferences と改名ロック ────────────────────────────────
console.log("\n[26-30] Lua 参照の保護（改名で findEntity を壊さない）");
{
  const lua = [
    'local cam = scene:findEntity("MainCamera")',
    "local p = scene:findEntity('Player')",
  ];
  const refs = findNameReferences(lua, ["MainCamera", "Player", "Box", "MainCameraX"]);
  assert.ok(refs.has("MainCamera"));
  pass("二重引用符の参照を拾う");
  assert.ok(refs.has("Player"));
  pass("単一引用符の参照を拾う");
  assert.ok(!refs.has("Box"), "参照されていない名前は拾わない");
  pass("参照されていない名前は拾わない");
  assert.ok(!refs.has("MainCameraX"), "部分一致で誤検出しない");
  pass("部分一致では拾わない（完全一致のみ）");

  // 参照されている名前は改名しない。グループ分けだけ行う。
  const plan = planOrganize(
    [E(1, "MainCamera", ["camera"]), E(2, "Box", ["meshRenderer"])],
    { protectedNames: new Set(["MainCamera"]) },
  );
  const cam = plan.moves.find((m) => m.entityId === 1)!;
  assert.equal(cam.newName, "MainCamera", "改名しない");
  assert.ok(cam.reparent, "でもグループへは入れる");
  assert.ok(cam.locked, "locked 印が付く");
  const box = plan.moves.find((m) => m.entityId === 2)!;
  assert.notEqual(box.newName, "Box", "参照されていないものは改名する");
  assert.equal(box.newName, "ENV_Prop_01", "既定名は種別の既定語になる（Box_01 にはしない）");
  pass("Lua から参照される名前は改名せずグループ分けだけ行う");
}

// ─── 規約テキストが全グループを載せている ────────────────────────────────
console.log("\n[25] 規約テキスト");
{
  const t = conventionText();
  for (const g of GROUP_ORDER) assert.ok(t.includes(GROUPS[g].root), `${g} が説明に出る`);
  pass("conventionText が 7 グループ全部を説明している");
}

console.log(`\nOK: ${passed} 件すべて成功`);
