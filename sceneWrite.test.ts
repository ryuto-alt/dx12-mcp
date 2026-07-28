/**
 * sceneWrite.ts（シーン JSON の検証・要約・パス解決）の自己テスト。
 * ネット不要・エンジン不要・ファイルも書かない。
 *
 * 検証対象:
 *   [1-3]   正常系 — 最小構成が通る / 要約の数え方 / knownAssets 未指定は警告に残す
 *   [4-8]   エラー — entities 欠落・name 欠落・transform の型・parent の型と範囲・循環
 *   [9-12]  「無言で無視される」系 — 未知キーの検出と打ち間違い候補 / 生成キーの競合 /
 *           反射コンポーネントが非オブジェクト / tags の形式
 *   [13-15] 参照切れ — modelPath / scriptPath を dx12_list_assets と突き合わせる
 *   [16-18] パス解決 — checkScenePath / assetsDirFromScenePath / ログ推定ハックの不在確認
 *
 * 実行: node sceneWrite.test.ts
 */

import assert from "node:assert/strict";
import {
  assetsDirFromScenePath, checkScenePath, entityKind,
  isSafeAssetRelPath, nearestAsset, nearestKey, summarizeScene, validateSceneJson,
} from "./sceneWrite.ts";
// 名前空間ごと取るのは「削除した export が復活していないか」を [18] で見るため。
import * as sceneWrite from "./sceneWrite.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

const tf = (x = 0, y = 0, z = 0) => ({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] });
/** エラー配列に指定の断片を含む行があるか。 */
const has = (arr: string[], re: RegExp) => arr.some((s) => re.test(s));

// ─── [1-3] 正常系 ──────────────────────────────────────────────────────────
console.log("\n[1-3] 正常系");
{
  const scene = {
    version: 1,
    shadows: true,
    entities: [
      { name: "Floor", transform: tf(0, 0, 0), primitive: "plane", color: [0.5, 0.5, 0.5] },
      { name: "Box", transform: tf(0, 1, 0), primitive: "box", parent: 0, material: { metallic: 0, roughness: 0.7 } },
      { name: "Sun", transform: tf(0, 10, 0), directionalLight: { color: [1, 0.95, 0.9], intensity: 3 } },
    ],
  };
  // 1. エラー無しで通る（knownAssets を渡さないので警告は 1 件出る）
  const v = validateSceneJson(scene, { knownAssets: [] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
  pass("最小構成（primitive + light + 親子）はエラー 0 で通る");

  // 2. 要約が正しく数えられている（何を書いたか / 何を壊すかの説明に使う）
  assert.equal(v.summary.entityCount, 3);
  assert.equal(v.summary.version, 1);
  assert.equal(v.summary.parentedCount, 1);
  assert.equal(v.summary.byKind["primitive:plane"], 1);
  assert.equal(v.summary.byKind["primitive:box"], 1);
  assert.equal(v.summary.byKind["light"], 1);
  assert.equal(v.summary.byComponent["directionalLight"], 1);
  assert.equal(v.summary.shadows, true);
  pass("summary が種別・コンポーネント・親子数を数えられる");

  // 3. knownAssets を渡さないと「実在確認をしていない」ことを警告に残す（黙って通さない）
  const v2 = validateSceneJson(scene);
  assert.ok(has(v2.warnings, /実在確認をしていない/));
  assert.equal(v2.ok, true);
  // 生成分岐の判定は InstantiateEntityJson と同じ優先順
  assert.equal(entityKind({ terrain: {}, meshRenderer: {} }), "terrain");
  assert.equal(entityKind({ camera: {} }), "camera");
  assert.equal(entityKind({ name: "x" }), "empty");
  pass("knownAssets 未指定は警告として残る / entityKind は復元時の分岐と同じ優先順");
}

// ─── [4-8] 構造エラー ──────────────────────────────────────────────────────
console.log("\n[4-8] 構造エラー（書かせない）");
{
  // 4. ルートが壊れている / entities が無い
  assert.equal(validateSceneJson(null).ok, false);
  assert.ok(has(validateSceneJson([]).errors, /ルートがオブジェクトではない/));
  assert.ok(has(validateSceneJson({ version: 1 }).errors, /"entities" 配列が無い/));
  assert.ok(has(validateSceneJson({ entities: {} }).errors, /"entities" は配列/));
  pass("ルート / entities の型不正を弾く");

  // 5. name が無い（MCP は name で操作するので無名は後から触れなくなる）
  const noName = validateSceneJson({ entities: [{ transform: tf() }] });
  assert.equal(noName.ok, false);
  assert.ok(has(noName.errors, /"name"\(空でない文字列\)が無い/));
  // 重複名は警告（エンジンは作れるが find_entity が曖昧になる）
  const dup = validateSceneJson({ entities: [{ name: "A", transform: tf() }, { name: "A", transform: tf() }] });
  assert.equal(dup.ok, true);
  assert.ok(has(dup.warnings, /重複/));
  pass("name 欠落はエラー / 重複名は警告");

  // 6. transform の型
  const badTf = validateSceneJson({
    entities: [{ name: "A", transform: { position: [1, 2], rotation: "0,0,0", scale: [1, 1, 1] } }],
  });
  assert.ok(has(badTf.errors, /transform\.position は有限な数値 3 つ/));
  assert.ok(has(badTf.errors, /transform\.rotation は有限な数値 3 つ/));
  // scale 0 はエンジンが作れてしまうが、ピッキングが破綻するので警告
  const zeroScale = validateSceneJson({ entities: [{ name: "A", transform: { scale: [1, 0, 1] } }] });
  assert.ok(has(zeroScale.warnings, /scale に 0/));
  pass("transform の要素型を検査 / scale に 0 は警告（ピッキング破綻）");

  // 7. parent は「entities 配列のインデックス」であって entityId でも name でもない
  const badParent = validateSceneJson({
    entities: [
      { name: "A", transform: tf(), parent: "B" },
      { name: "B", transform: tf(), parent: 99 },
      { name: "C", transform: tf(), parent: 2 },
    ],
  });
  assert.ok(has(badParent.errors, /parent は整数\(entities 配列のインデックス\)/));
  assert.ok(has(badParent.errors, /parent = 99 が範囲外/));
  assert.ok(has(badParent.errors, /自分自身/));
  pass("parent の型 / 範囲 / 自己参照を弾く");

  // 8. 親子の循環（0 → 1 → 2 → 0）
  const cyc = validateSceneJson({
    entities: [
      { name: "A", transform: tf(), parent: 1 },
      { name: "B", transform: tf(), parent: 2 },
      { name: "C", transform: tf(), parent: 0 },
    ],
  });
  assert.ok(has(cyc.errors, /循環/));
  pass("親子の循環を検出する");
}

// ─── [9-12] 「エンジンが無言で無視する」系 ────────────────────────────────
console.log("\n[9-12] 無言で無視されるミス（手書き JSON の最大の罠）");
{
  // 9. 未知キー + 打ち間違い候補の提示
  const typo = validateSceneJson({
    entities: [{ name: "A", transform: tf(), meshrenderer: { modelPath: "m.gltf" }, rotaton: [0, 0, 0] }],
  });
  assert.ok(has(typo.warnings, /未知キー "meshrenderer".*"meshRenderer" の打ち間違い/));
  assert.ok(has(typo.warnings, /未知キー "rotaton"/));
  assert.equal(nearestKey("pointlight", ["pointLight", "spotLight"]), "pointLight");
  assert.equal(nearestKey("zzzzzzzzzz", ["pointLight"]), null);
  pass("未知キーを検出し、近い正しいキーを提示する");

  // 10. transform 内の未知キー / ルートの未知キー
  const rootTypo = validateSceneJson({ entities: [], shadow: true, postprocess: {} });
  assert.ok(has(rootTypo.warnings, /ルートの未知キー "shadow".*"shadows"/));
  assert.ok(has(rootTypo.warnings, /ルートの未知キー "postprocess".*"postProcess"/));
  const tfTypo = validateSceneJson({ entities: [{ name: "A", transform: { pos: [0, 0, 0] } }] });
  assert.ok(has(tfTypo.warnings, /transform の未知キー "pos"/));
  pass("ルート / transform の未知キーも拾う");

  // 11. 生成キーの競合（先勝ちで後ろが捨てられる）
  const conflict = validateSceneJson({
    entities: [{ name: "A", transform: tf(), primitive: "box", meshRenderer: { modelPath: "m.gltf" } }],
  }, { knownAssets: ["m.gltf"] });
  assert.ok(has(conflict.warnings, /生成キーが複数/));
  // primitive の値そのものも検査する
  assert.ok(has(validateSceneJson({ entities: [{ name: "A", primitive: "cube" }] }).errors, /primitive は box/));
  pass("生成キーの競合と primitive の値を検査する");

  // 12. 反射登録コンポーネントが非オブジェクト = 丸ごと無視される / tags の形式
  const badComp = validateSceneJson({
    entities: [{ name: "A", transform: tf(), pointLight: 5, tags: { a: 1 } }],
  });
  assert.ok(has(badComp.errors, /pointLight はオブジェクト/));
  assert.ok(has(badComp.errors, /tags は文字列の配列/));
  pass("コンポーネントの非オブジェクト / tags の形式ミスを弾く");
}

// ─── [13-15] 参照切れ ──────────────────────────────────────────────────────
console.log("\n[13-15] 参照アセットの実在確認");
{
  const assets = ["models/tree.gltf", "models/rock.gltf", "components/Rotate.lua"];

  // 13. 実在するパスは通る
  const okScene = {
    entities: [{
      name: "Tree", transform: tf(),
      meshRenderer: { modelPath: "models/tree.gltf" },
      luaScript: { scriptPath: "components/Rotate.lua" },
    }],
  };
  assert.equal(validateSceneJson(okScene, { knownAssets: assets }).ok, true);
  pass("assets に実在する modelPath / scriptPath は通る");

  // 14. 参照切れは「エンティティごと消える」ことまで書いて弾く + 近い候補を出す
  const broken = validateSceneJson({
    entities: [{ name: "T", transform: tf(), meshRenderer: { modelPath: "model/tree.gltf" } }],
  }, { knownAssets: assets });
  assert.equal(broken.ok, false);
  assert.ok(has(broken.errors, /assets に無い/));
  assert.ok(has(broken.errors, /丸ごと消える/));
  assert.ok(has(broken.errors, /models\/tree\.gltf.*のこと\?/));
  assert.equal(nearestAsset("models/Tree.GLTF", assets), "models/tree.gltf");
  assert.equal(nearestAsset("zzzzzzzzzzzzzzzzzzzz.gltf", assets), null);
  pass("参照切れを弾き、ファイル名一致から正しいパスを提案する");

  // 15. パスの形式（assets 相対のみ。絶対パス / バックスラッシュ / .. は不可）
  assert.equal(isSafeAssetRelPath("models/a.gltf"), true);
  assert.equal(isSafeAssetRelPath("C:/x/a.gltf"), false);
  assert.equal(isSafeAssetRelPath("models\\a.gltf"), false);
  assert.equal(isSafeAssetRelPath("../a.gltf"), false);
  assert.equal(isSafeAssetRelPath("/a.gltf"), false);
  const absPath = validateSceneJson({
    entities: [{ name: "T", transform: tf(), meshRenderer: { modelPath: "C:/models/tree.gltf" } }],
  }, { knownAssets: assets });
  assert.ok(has(absPath.errors, /assets 相対パスにする/));
  // scriptPath 欠落・空も弾く
  assert.ok(has(validateSceneJson({ entities: [{ name: "A", luaScript: {} }] }).errors, /scriptPath が無い/));
  pass("assets 相対パスの形式（絶対 / \\ / .. を拒否）");
}

// ─── [16-18] パス解決 ─────────────────────────────────────────────────────
console.log("\n[16-18] 書き出し先の解決");
{
  // 16. checkScenePath
  assert.equal(checkScenePath("scenes/level1.json").ok, true);
  assert.equal(checkScenePath("scenes/level1.json").warning, undefined);
  assert.match(checkScenePath("level1.json").warning!, /scenes\/ 配下ではない/);
  assert.match(checkScenePath("scenes/level1.txt").error!, /\.json ではない/);
  assert.match(checkScenePath("../evil.json").error!, /assets 相対/);
  pass("checkScenePath が拡張子と assets 相対を検査する");

  // 17. 絶対パスから assets ディレクトリを推定
  assert.equal(assetsDirFromScenePath("C:/Users/me/game/My/assets/scenes/a.json"), "C:/Users/me/game/My/assets");
  assert.equal(assetsDirFromScenePath("C:\\Users\\me\\game\\My\\assets\\scenes\\a.json"), "C:/Users/me/game/My/assets");
  assert.equal(assetsDirFromScenePath("C:/tmp/a.json"), null);
  pass("絶対パスの .../assets/ から assets ディレクトリを推定する");

  // 18. ★assetsDirCandidatesFromLog は削除済み(エンジンが dx12_ping で assetsDir を返すため)。
  //     「もう存在しない」ことを検査して、うっかり復活させたら気づけるようにしておく。
  assert.equal((sceneWrite as Record<string, unknown>).assetsDirCandidatesFromLog, undefined,
    "assetsDirCandidatesFromLog が復活している。assets の正は dx12_ping の assetsDir(#20-3)");
  // 要約はパースできない/空の入力でも落ちない
  assert.equal(summarizeScene(undefined).entityCount, 0);
  assert.equal(summarizeScene({ entities: [1, "x", null] }).entityCount, 3);
  pass("ログからの assetsDir 推定ハックが削除されたままである");
}

console.log(`\nOK: sceneWrite テスト ${passed} 項目すべて通過`);
