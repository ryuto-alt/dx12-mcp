/**
 * blenderBridge.ts（Blender 連携）の自己テスト。純関数だけを対象にする（Blender 不要）。
 *
 * 検証対象:
 *   [1-3] parseCodeResult    — execute_code の stdout から JSON を取り出す
 *   [4-6] buildExportScript  — 踏んだ罠が本当にスクリプトへ埋まっているか（回帰防止）
 *   [7-9] planImageRenames   — tmp 名だけ直し、人が付けた名前と埋め込みは触らない
 *   [10]  modelBrief         — 用途に応じた注意が出る / 単色マテリアル禁止が必ず入る
 *   [11]  blenderCandidatePaths — 新しい版から順に返す
 *
 * 実行: node blenderBridge.test.ts
 */

import assert from "node:assert/strict";
import {
  blenderCandidatePaths, buildExportScript, buildMaterialScript, buildPolishScript, modelBrief,
  parseCodeResult, planImageRenames,
} from "./blenderBridge.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

// ─── [1-3] parseCodeResult ──────────────────────────────────────────────────
console.log("\n[1-3] parseCodeResult（stdout から JSON を拾う）");
{
  const r = parseCodeResult({ status: "success", result: { executed: true, result: '{"a":1}\n' } });
  assert.deepStrictEqual(r.json, { a: 1 });
  pass("print した JSON を取り出す");

  const multi = parseCodeResult({
    result: { result: "何かのログ\n{\"first\":1}\n{\"exported\":[\"Cube\"]}\n" },
  });
  assert.deepStrictEqual(multi.json, { exported: ["Cube"] }, "最後の JSON を採る");
  pass("print が複数あっても最後の JSON を採る");

  const none = parseCodeResult({ result: { result: "ただのログだけ\n" } });
  assert.equal(none.json, undefined);
  assert.ok(none.stdout.includes("ただのログ"), "stdout はそのまま返す");
  pass("JSON が無ければ stdout だけ返す（例外にしない）");
}

// ─── [4-6] buildExportScript ────────────────────────────────────────────────
console.log("\n[4-6] buildExportScript（罠が埋まっているか）");
{
  const code = buildExportScript({ objectNames: ["Rock"], outPath: "C:/tmp/rock.glb" });

  assert.ok(code.includes("use_selection=True"),
    "use_selection=False は .blend 内の全シーンを書き出してしまう");
  pass("use_selection=True で出す（全シーン書き出しの事故を防ぐ）");

  assert.ok(/for sc in bpy\.data\.scenes[\s\S]*select_set\(False/.test(code),
    "全シーンの全 view_layer で deselect してから対象を選ぶ");
  pass("書き出し前に全シーンで選択解除する");

  assert.ok(code.includes("shape_key_clear"), "シェイプキー削除が入っている");
  assert.ok(code.includes("TEX_IMAGE"), "画像テクスチャ有無の検査が入っている");
  pass("シェイプキー削除と単色マテリアル検出が入っている");

  // パスは Python 側で使えるよう / に正規化される
  const win = buildExportScript({ objectNames: [], outPath: "C:\\a\\b.glb" });
  assert.ok(win.includes('"C:/a/b.glb"'));
  pass("Windows のパス区切りを / に直して埋める");

  // ★拡張子から形式を決めて渡すこと。渡さないと既定の GLB になり、
  //   models/rock.gltf を頼んだのに rock.glb ができて参照が全部切れる（実際に踏んだ）。
  assert.ok(buildExportScript({ objectNames: [], outPath: "a/x.gltf" })
            .includes('EXPORT_FORMAT = "GLTF_SEPARATE"'));
  assert.ok(buildExportScript({ objectNames: [], outPath: "a/x.glb" })
            .includes('EXPORT_FORMAT = "GLB"'));
  pass("拡張子から書き出し形式を決めて渡す");

  assert.ok(code.includes("頼んだパスにファイルができていない"));
  pass("書き出し後に実在を確かめて、違えば error を返す");

  // PNG マジックが JS のテンプレートリテラルに食われて改行で割れていないこと
  const mat0 = buildMaterialScript({ objectNames: [], assetId: "a" });
  const pngLine = mat0.split("\n").find((l) => l.includes("png = b"));
  assert.ok(pngLine && pngLine.includes("x89PNG"), "PNG マジックが壊れている: " + pngLine);
  pass("PNG マジックがテンプレートリテラルに食われていない");
}

// ─── [7-9] planImageRenames ─────────────────────────────────────────────────
console.log("\n[7-9] planImageRenames（tmp 名の直し）");
{
  const plan = planImageRenames(
    { images: [{ uri: "tmp1a2b3c.jpg" }, { uri: "brick_diff.png" }, { uri: "data:image/png;base64,AAA" }] },
    "rock",
  );
  assert.equal(plan.length, 1, "tmp 名の 1 枚だけが対象");
  pass("tmp 名だけを直す");

  assert.ok(!plan.some((p) => p.from === "brick_diff.png"));
  pass("人が付けた名前は触らない");

  assert.ok(!plan.some((p) => p.from.startsWith("data:")));
  pass("埋め込み画像（data:）は触らない");

  const dup = planImageRenames({ images: [{ uri: "tmpAAA.png" }, { uri: "tmpBBB.png" }] }, "wall");
  assert.equal(new Set(dup.map((p) => p.to)).size, 2, "新しい名前が衝突しない");
  pass("複数の tmp があっても名前が衝突しない");
}

// ─── [10] modelBrief ────────────────────────────────────────────────────────
console.log("\n[10] modelBrief（規約）");
{
  const b = modelBrief("prop");
  assert.ok(b.materials.some((m) => m.includes("単色マテリアルは禁止")),
    "エンジンが baseColorFactor を読まない件は必ず出す");
  assert.ok(b.rules.some((r) => r.includes("メートル")));
  const lvl = modelBrief("level 床");
  assert.ok(lvl.rules.some((r) => r.includes("rigidBody")), "床なら当たり判定の注意が増える");
  pass("用途に応じた注意が出て、単色マテリアル禁止は必ず入る");
}

// ─── [11] blenderCandidatePaths ─────────────────────────────────────────────
console.log("\n[11] blenderCandidatePaths");
{
  const p = blenderCandidatePaths();
  assert.ok(p[0].includes("Blender 5.2"), "新しい版が先頭");
  assert.ok(p.every((x) => x.endsWith("blender.exe")));
  pass("新しい版から順に候補を返す");
}

// ─── [12-17] buildPolishScript（「うすぺらい」を消す幾何の処理） ─────────────
console.log("\n[12-17] buildPolishScript（罠が埋まっているか）");
{
  const code = buildPolishScript({ objectNames: ["Crate"] });

  // ★スケール適用がベベルより【前】に来ていること。順番が逆だと軸ごとに幅が変わる。
  const iScale = code.indexOf("transform_apply");
  const iBevel = code.indexOf("'BEVEL'");
  assert.ok(iScale > 0 && iBevel > 0 && iScale < iBevel,
    `スケール適用(${iScale}) がベベル(${iBevel}) より前に来ていない`);
  pass("スケール適用がベベルより前に来る（幅が軸ごとに変わるのを防ぐ）");

  assert.ok(code.includes("harden_normals"), "ベベルの陰影が平面へ漏れないように");
  pass("harden normals が入っている");

  assert.ok(code.includes("WEIGHTED_NORMAL"));
  pass("加重法線が入っている");

  // Blender 4.1 で消えた API を使っていないこと
  assert.ok(!code.includes("use_auto_smooth"), "4.1 以降で消えた API");
  assert.ok(code.includes("shade_auto_smooth"));
  pass("自動スムーズは新しい API を使う（use_auto_smooth は 4.1 で消えた）");

  assert.ok(code.includes("cube_project"), "実寸で UV を切り直す");
  pass("UV を実寸で切り直す（既定 UV は面ごとに 0..1 で縮尺が合わない）");

  assert.ok(code.includes("SOLIDIFY"));
  pass("厚みゼロの板に Solidify を掛ける");

  // 数値がそのまま埋まること
  const custom = buildPolishScript({ objectNames: [], bevelWidth: 0.005, bevelSegments: 3, smoothAngle: 40 });
  assert.ok(custom.includes("BEVEL_W = 0.005") && custom.includes("BEVEL_SEG = 3")
            && custom.includes("SMOOTH_ANGLE = 40"));
  pass("指定した数値がスクリプトに埋まる");
}

// ─── [18-21] buildMaterialScript（PolyHaven の PBR） ────────────────────────
console.log("\n[18-21] buildMaterialScript（ORM の扱い）");
{
  const code = buildMaterialScript({ objectNames: ["Crate"], assetId: "brown_planks_05" });

  // ★arm（ORM 済み）を優先すること
  assert.ok(code.includes('grab("arm")'));
  pass("arm（ORM 済みマップ）を優先して使う");

  // ★rough 単体をそのまま metallicRoughness にすると B に粗さが入って金属になる。
  //   合成側で B=0 を書いていることを確かめる。
  assert.ok(/bytes\(\(r, g, 0\)\)/.test(code), "合成 ORM の B が 0 でない");
  pass("arm が無いときは B=0 の ORM を合成する（木が金属になるのを防ぐ）");

  // glTF エクスポータが metallicRoughness と認識する結線
  assert.ok(code.includes('sep.outputs["Green"]') && code.includes('bsdf.inputs["Roughness"]'));
  assert.ok(code.includes('sep.outputs["Blue"]') && code.includes('bsdf.inputs["Metallic"]'));
  pass("G→Roughness / B→Metallic に結線する（エクスポータが認識する形）");

  assert.ok(code.includes('grab("nor_gl")') && !code.includes('grab("nor_dx")'));
  pass("法線は OpenGL 規約（nor_gl）だけを取る");
}

// ─── [22] modelBrief に実測で分かった項目が入っているか ─────────────────────
console.log("\n[22] modelBrief（実測に基づく注意）");
{
  const b = modelBrief("prop");
  assert.ok(b.rules.some((r) => r.includes("ベベル")), "うすぺらいの主因");
  assert.ok(b.rules.some((r) => r.includes("UV は実寸")), "既定 UV は面ごとに 0..1");
  assert.ok(b.materials.some((m) => m.includes("PolyHaven")), "素材の入手先");
  assert.ok(b.materials.some((m) => m.includes("B=metallic")), "ORM の並び");
  assert.ok(b.gotchas.some((g) => g.includes("HDRI")), "環境光が無いと質感が出ない");
  pass("ベベル / 実寸 UV / PolyHaven / ORM / HDRI が全部入っている");
}

console.log(`\nOK: ${passed} 件すべて成功`);
