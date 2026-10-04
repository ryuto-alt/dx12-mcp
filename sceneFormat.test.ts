/**
 * sceneFormat.ts（シーンファイル形式 v2 の補完・省略・整形）と、sceneWrite.ts の v2 対応の自己テスト。
 * ネット不要・エンジン不要。ファイルは読むだけ（既定値表）。
 *
 *   [1] 既定値表のコピーがエンジン側の正本とバイト一致（配布はこのフォルダだけを写すのでコピーが要る）
 *   [2] 最短 float: float32 で正確な値だけが短くなり、float32 として読み戻すと同じ値
 *   [3] strip / inflate の往復（-0 と 0 は別物・整数と小数は別物・入れ子は再帰しない）
 *   [4] 整形: version → 設定 → entities が 1 行 1 体・LF のみ・正しい JSON・-0 の符号を保つ
 *   [5] 変換: convertToV2 → inflateScene が完全形に戻る（parent index は parentGuid があれば消える）
 *   [6] sceneWrite の検証が v2 の省略形を受け付ける（rigidBody:{} / transform は position だけ / parentGuid のみ / meshCollider）
 *   [7] v1 は触らない（inflateScene は複製せずそのまま返す）
 *   [8] 分割保存（§4.3）: seq の復号・セルの統合（並び順・seq 無し/壊れ・欠け）・"parts" の 1 行整形・ファイルから読む・検証
 *
 * 実行: node sceneFormat.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  convertToV2, decodeSeq, defaultsV2, dumpSceneV2, f32Shortest, inflateDefaults, inflateScene, isSafePartName, isV2,
  mergeParts, normalizeFloats, partNames, readSceneFile, stripDefaults,
} from "./sceneFormat.ts";
import { summarizeScene, validateSceneJson } from "./sceneWrite.ts";

let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };
const has = (arr: string[], re: RegExp) => arr.some((s) => re.test(s));

// ─── [1] 表のコピー ───────────────────────────────────────────────────────
console.log("\n[1] 既定値表");
{
  const copy = new URL("./scene_defaults_v2.json", import.meta.url);
  const master = new URL("../../src/scene/scene_defaults_v2.json", import.meta.url);
  if (fs.existsSync(master)) {
    assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(master)),
      "tools/mcp-server/scene_defaults_v2.json が src/scene/scene_defaults_v2.json と違う。node scripts/sync_scene_defaults.mjs で更新する");
    pass("コピーがエンジン側の正本とバイト一致");
  } else {
    console.log("  --  配布先（src/ が無い）のためバイト一致の確認は省略");
  }
  const t = defaultsV2();
  assert.ok(Object.keys(t).length >= 20);
  assert.deepEqual(t.transform, { rotation: [0, 0, 0], scale: [1, 1, 1] });
  assert.ok("rigidBody" in t && "meshCollider" in t);
  assert.equal((t.rigidBody as any).motionType, 0, "rigidBody の既定は静的コライダー（docs/SCENE_FORMAT_DESIGN.md §3.1）");
  assert.equal((t.rigidBody as any).useGravity, false);
  pass("表が読めて、transform / rigidBody（静的）/ meshCollider を持つ");
}

// ─── [2] 最短 float ───────────────────────────────────────────────────────
console.log("\n[2] 最短 float");
{
  assert.equal(f32Shortest(0.019999999552965164), 0.02);
  assert.equal(f32Shortest(0.800000011920929), 0.8);
  assert.equal(f32Shortest(0.20000000298023224), 0.2);
  assert.equal(f32Shortest(0.1), 0.1, "float32 で正確でない 0.1 は触らない");
  assert.equal(f32Shortest(1 / 3), 1 / 3);
  assert.equal(f32Shortest(1), 1);
  assert.ok(Object.is(f32Shortest(-0), -0));
  assert.equal(f32Shortest(Infinity), Infinity);
  assert.ok(Number.isNaN(f32Shortest(NaN)));
  // 任意の float32 は、短縮後に float32 へ丸めても同じ値
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let shortened = 0;
  for (let i = 0; i < 20000; i++) {
    const f = Math.fround((rnd() - 0.5) * 2000);
    const n = f32Shortest(f);
    assert.equal(Math.fround(n), f);
    assert.equal(Math.fround(JSON.parse(JSON.stringify(n))), f);
    if (n !== f) shortened++;
  }
  assert.ok(shortened > 1000);
  pass("float32 で正確な値だけが短くなり、float32 として読み戻すと同じ値");
  const norm = normalizeFloats({ b: [0.019999999552965164, 0.1], a: 1 }) as any;
  assert.deepEqual(Object.keys(norm), ["a", "b"], "キーは辞書順");
  assert.deepEqual(norm.b, [0.02, 0.1]);
  pass("normalizeFloats は再帰して辞書順に揃える");
}

// ─── [3] strip / inflate ──────────────────────────────────────────────────
console.log("\n[3] strip / inflate");
{
  const table = defaultsV2();
  const full = () => ({
    name: "A", guid: "00000000000000aa",
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    rigidBody: JSON.parse(JSON.stringify(table.rigidBody)),
    meshCollider: JSON.parse(JSON.stringify(table.meshCollider)),
    meshRenderer: { modelPath: "models/a.glb" },
    material: { metallic: 1, roughness: 0.1 },
    tags: ["a"],
  });
  const e = full();
  stripDefaults(e as any);
  assert.deepEqual(e.transform, { position: [1, 2, 3] });
  assert.deepEqual(e.rigidBody, {});
  assert.deepEqual(e.meshCollider, {});
  assert.deepEqual(e.meshRenderer, { modelPath: "models/a.glb" }, "表に無いキーは触らない");
  assert.deepEqual(e.material, { metallic: 1, roughness: 0.1 });
  inflateDefaults(e as any);
  assert.deepEqual(e, full());
  pass("省略 → 補完で完全形に戻る（空になったコンポーネントのキーは残る）");

  // 負のゼロは 0 と別物
  const nz: any = { transform: { rotation: [0, -0, 0], scale: [1, 1, 1] } };
  stripDefaults(nz);
  assert.ok("rotation" in nz.transform && !("scale" in nz.transform));
  pass("-0 を含む配列は省略しない");

  // 配列は丸ごと比較・入れ子は再帰しない
  const part: any = { transform: { rotation: [0, 0, 0.5], scale: [1, 1, 1] } };
  stripDefaults(part);
  assert.deepEqual(part.transform, { rotation: [0, 0, 0.5] });
  pass("配列は丸ごと比較（1 要素違えば残る）");

  // 部分的に違う剛体は違うフィールドだけ残る
  const rb: any = { rigidBody: { ...(table.rigidBody as object), motionType: 2, mass: 1 } };
  stripDefaults(rb);
  assert.deepEqual(rb.rigidBody, { motionType: 2, mass: 1 });
  inflateDefaults(rb);
  assert.deepEqual(rb.rigidBody, { ...(table.rigidBody as object), motionType: 2, mass: 1 });
  pass("動的剛体は違うフィールドだけ残り、補完で戻る");
}

// ─── [4] 整形 ─────────────────────────────────────────────────────────────
console.log("\n[4] 整形");
const sample = () => ({
  version: 1,
  postProcess: { exposure: 0.019999999552965164, bloom: { enabled: true, threshold: 1 } },
  skybox: { envMapPath: "sky/a.hdr" },
  entities: [
    { guid: "0000000000000001", name: "Root", transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { guid: "0000000000000002", name: "Child", parent: 0, parentGuid: "0000000000000001",
      transform: { position: [1, 2, 3], rotation: [0, -0, 0], scale: [1, 1, 1] },
      rigidBody: JSON.parse(JSON.stringify(defaultsV2().rigidBody)), meshCollider: { offset: [0, 0, 0] },
      meshRenderer: { modelPath: "models/a.glb" } },
  ],
});
{
  const v2 = convertToV2(sample() as any);
  const text = dumpSceneV2(v2);
  assert.ok(text.endsWith("\n") && !text.includes("\r"));
  assert.ok(text.startsWith('{\n  "version": 2,\n'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.entities.length, 2);
  assert.equal(parsed.postProcess.exposure, 0.02);
  const entLines = text.split("\n").filter((l) => l.startsWith('{"'));
  assert.equal(entLines.length, 2);
  assert.ok(entLines.every((l) => !l.includes(": ") && !l.includes(", ")));
  assert.ok(!("parent" in parsed.entities[1]), "parentGuid があれば parent index は書かない");
  assert.deepEqual(parsed.entities[1].rigidBody, {});
  assert.deepEqual(parsed.entities[1].meshCollider, {});
  assert.deepEqual(parsed.entities[0].transform, { position: [0, 0, 0] });
  assert.ok(entLines[1].includes('"rotation":[0,-0.0,0]'), "-0 の符号を保つ（0 に落とさない）");
  assert.ok(text.indexOf('"entities"') > text.indexOf('"skybox"'), "entities は最後");
  pass("version 先頭 / 設定は整形 / entities は 1 行 1 体 / 既定値は省略 / parent は消える / -0 を保つ");
  // 空の entities
  assert.equal(JSON.parse(dumpSceneV2({ version: 2, entities: [] })).entities.length, 0);
  assert.equal(dumpSceneV2({ version: 2, entities: [] }), '{\n  "version": 2,\n  "entities": []\n}\n');
  pass("entities が空でも正しい JSON");
}

// ─── [5] 変換の往復 ───────────────────────────────────────────────────────
console.log("\n[5] 変換の往復");
{
  const text = dumpSceneV2(convertToV2(sample() as any));
  assert.ok(isV2(JSON.parse(text)));
  const back = inflateScene(JSON.parse(text)) as any;
  const expect: any = normalizeFloats(sample() as any);
  expect.version = 2;
  delete expect.entities[1].parent;
  assert.deepEqual(back, expect);
  assert.ok(Object.is(back.entities[1].transform.rotation[1], -0) || back.entities[1].transform.rotation[1] === 0);
  pass("convertToV2 → dump → parse → inflateScene が、正規化済みの完全形（parent 以外）に戻る");
  // 整形し直しは固定点
  const again = dumpSceneV2(convertToV2(inflateScene(JSON.parse(text)) as any));
  assert.equal(again, text);
  pass("v2 → 補完 → 変換 → 整形は固定点（保存し直しても差分が出ない）");
}

// ─── [6] sceneWrite の検証が v2 の省略形を受け付ける ───────────────────────
console.log("\n[6] 検証");
{
  const scene = {
    version: 2,
    entities: [
      { guid: "00000000000000aa", name: "Root", transform: { position: [0, 0, 0] } },
      { guid: "00000000000000bb", name: "Piece", parentGuid: "00000000000000aa", rigidBody: {}, meshCollider: {},
        meshRenderer: { modelPath: "models/a.glb" }, material: { metallic: 0, roughness: 0.2 }, transform: { position: [1, 2, 3] } },
    ],
  };
  const v = validateSceneJson(scene, { knownAssets: ["models/a.glb"] });
  assert.deepEqual(v.errors, []);
  assert.ok(!has(v.warnings, /version/), `version 2 に警告が出ている: ${v.warnings.join(" / ")}`);
  assert.ok(!has(v.warnings, /meshCollider/), "meshCollider が未知キー扱いになっている");
  assert.equal(v.summary.parentedCount, 1);
  assert.equal(v.summary.version, 2);
  pass("rigidBody:{} / meshCollider:{} / transform は position だけ / parentGuid のみ、が通る");

  // transform が無い・部分的でもエラーにならない
  assert.deepEqual(validateSceneJson({ version: 2, entities: [{ name: "X", transform: { rotation: [0, 90, 0] } }] }, { knownAssets: [] }).errors, []);
  pass("transform の一部だけでもエラーにならない");

  // parentGuid の循環は検出する・存在しない guid は警告
  const cyc = validateSceneJson({ version: 2, entities: [
    { guid: "0000000000000001", name: "A", parentGuid: "0000000000000002" },
    { guid: "0000000000000002", name: "B", parentGuid: "0000000000000001" },
  ] }, { knownAssets: [] });
  assert.ok(has(cyc.errors, /循環/));
  const dangling = validateSceneJson({ version: 2, entities: [{ guid: "0000000000000001", name: "A", parentGuid: "00000000000000ff" }] }, { knownAssets: [] });
  assert.ok(has(dangling.warnings, /parentGuid .* guid に持つエンティティが無い/));
  const badGuid = validateSceneJson({ version: 2, entities: [{ name: "A", parentGuid: 12345 }] }, { knownAssets: [] });
  assert.ok(has(badGuid.errors, /parentGuid は/));
  pass("parentGuid の循環 / 存在しない guid / 数値 guid を検出する");

  // version 3 は警告（読めるのは 1 と 2）
  assert.ok(has(validateSceneJson({ version: 3, entities: [] }, { knownAssets: [] }).warnings, /version が 3/));
  pass("未知の version は警告");
  // 従来の v1 は従来どおり（version 警告なし）
  assert.ok(!has(validateSceneJson({ version: 1, entities: [] }, { knownAssets: [] }).warnings, /version/));
}

// ─── [7] v1 は触らない ────────────────────────────────────────────────────
console.log("\n[7] v1 互換");
{
  const v1 = { version: 1, entities: [{ name: "A", rigidBody: {} }] };
  assert.equal(inflateScene(v1), v1, "v1 は複製せずそのまま返す");
  assert.deepEqual(v1.entities[0].rigidBody, {}, "v1 の {} は補完しない（構造体の既定のまま）");
  const noVersion = { entities: [{ name: "A", rigidBody: {} }] };
  assert.equal(inflateScene(noVersion), noVersion);
  assert.ok(!isV2("x") && !isV2(null) && !isV2([]) && !isV2({ version: "2" }));
  pass("v1（version 無し / 1）と非オブジェクトは補完しない");
  const sum = summarizeScene({ version: 2, entities: [{ name: "A", parentGuid: "0000000000000001" }] });
  assert.equal(sum.parentedCount, 1);
  pass("summarizeScene は parentGuid も親ありと数える");
}

// ─── [8] 分割保存 ─────────────────────────────────────────────────────────
console.log("\n[8] 分割保存（foo.json + foo.parts/）");
{
  // seq
  assert.deepEqual(decodeSeq("0-2,10,15-16", 6, 20), [0, 1, 2, 10, 15, 16]);
  assert.deepEqual(decodeSeq("", 0, 5), []);
  for (const [s, n, t] of [["0-2", 4, 20], ["0-2,", 3, 20], ["a", 1, 20], ["5-3", 3, 20], ["25", 1, 20], [3, 1, 20]] as const) {
    assert.equal(decodeSeq(s, n, t), null, `壊れた seq ${JSON.stringify(s)} を弾く`);
  }
  assert.ok(isSafePartName("cell_-1_2.json") && !isSafePartName("a/b.json") && !isSafePartName("..") && !isSafePartName("c:x") && !isSafePartName("a\\b"));
  pass("seq の復号と壊れた入力・パーツ名の検査");

  // 統合: 並び順どおりに（foo.json のエンティティは空いた位置を埋める）
  const mk = (n: string) => ({ guid: n, name: n });
  const cells: Record<string, string> = {
    "cell_0_0.json": JSON.stringify({ version: 2, seq: "1,4", entities: [mk("b"), mk("e")] }),
    "cell_1_0.json": JSON.stringify({ version: 2, seq: "2-3", entities: [mk("c"), mk("d")] }),
  };
  const root: any = { version: 2, partition: { cellSize: 64 }, parts: [{ file: "cell_0_0.json", count: 2 }, { file: "cell_1_0.json", count: 2 }], entities: [mk("a"), mk("f")] };
  assert.deepEqual(partNames(root), ["cell_0_0.json", "cell_1_0.json"]);
  const r = mergeParts(root, (n) => cells[n]);
  assert.deepEqual(root.entities.map((e: any) => e.name), ["a", "b", "c", "d", "e", "f"]);
  assert.equal(r.seqUsed, true);
  assert.ok(!("parts" in root));
  pass("mergeParts: seq どおりに元の並びへ戻る");

  // seq が無い → foo.json → セルの順 / 重複 → 同じ / 読めない・壊れ・不正名 → throw
  const noSeq: any = { version: 2, parts: [{ file: "cell_0_0.json" }], entities: [mk("a")] };
  const r2 = mergeParts(noSeq, () => JSON.stringify({ version: 2, entities: [mk("x")] }));
  assert.equal(r2.seqUsed, false);
  assert.deepEqual(noSeq.entities.map((e: any) => e.name), ["a", "x"]);
  assert.throws(() => mergeParts({ version: 2, parts: [{ file: "cell_0_0.json" }], entities: [] } as any, () => { throw new Error("ENOENT"); }), /読めない/);
  assert.throws(() => mergeParts({ version: 2, parts: [{ file: "cell_0_0.json" }], entities: [] } as any, () => "{oops"), /読めない/);
  assert.throws(() => mergeParts({ version: 2, parts: [{ file: "../x.json" }], entities: [] } as any, () => "{}"), /不正/);
  assert.throws(() => mergeParts({ version: 2, parts: [{ file: "c.json" }], entities: [] } as any, () => "{\"version\":2}"), /entities/);
  pass("mergeParts: seq 無し/壊れは つなぎ順・読めないセルや不正な名前は失敗（部分読みしない）");

  // 整形: "parts" は 1 要素 1 行・C++ の DumpSceneV2 と同じ形
  const dumped = dumpSceneV2({ version: 2, partition: { cellSize: 64 }, parts: [{ file: "cell_0_0.json", count: 1, cell: [0, 0], bounds: [0, 0, 64, 64] }, { file: "cell_1_0.json", count: 2, cell: [1, 0], bounds: [64, 0, 128, 64] }], entities: [{ guid: "a", name: "A" }] });
  assert.ok(dumped.includes('  "parts": [\n    {"bounds":[0,0,64,64],"cell":[0,0],"count":1,"file":"cell_0_0.json"},\n    {"bounds":[64,0,128,64],"cell":[1,0],"count":2,"file":"cell_1_0.json"}\n  ],\n'), dumped);
  assert.ok(dumpSceneV2({ version: 2, parts: [], entities: [] }).includes('  "parts": [],\n'));
  JSON.parse(dumped);
  pass("dumpSceneV2: parts の目次は 1 要素 1 行・正しい JSON");

  // ファイルから: foo.json + foo.parts/ をつなげて読む（エンジンが書く形）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx12_split_"));
  try {
    fs.mkdirSync(path.join(dir, "foo.parts"));
    fs.writeFileSync(path.join(dir, "foo.json"), dumpSceneV2({ version: 2, parts: [{ file: "cell_0_0.json", count: 1 }], entities: [mk("a")] }));
    fs.writeFileSync(path.join(dir, "foo.parts", "cell_0_0.json"), dumpSceneV2({ version: 2, seq: "0", entities: [mk("z")] }));
    const merged = readSceneFile(path.join(dir, "foo.json"));
    assert.deepEqual((merged.entities as any[]).map((e) => e.name), ["z", "a"]);
    assert.ok(!("parts" in merged));
    // 分割していないシーンはそのまま
    fs.writeFileSync(path.join(dir, "bar.json"), dumpSceneV2({ version: 2, entities: [mk("q")] }));
    assert.equal(((readSceneFile(path.join(dir, "bar.json")).entities as any[])[0]).name, "q");
    // セルが欠けていれば throw
    fs.rmSync(path.join(dir, "foo.parts", "cell_0_0.json"));
    assert.throws(() => readSceneFile(path.join(dir, "foo.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  pass("readSceneFile: foo.json + foo.parts/ をつなげて読む（欠けは失敗）");

  // 検証: partition / parts のキーと値
  const ok = validateSceneJson({ version: 2, partition: { cellSize: 64 }, entities: [{ name: "A", partition: "root" }] }, { knownAssets: [] });
  assert.ok(ok.ok && !has(ok.warnings, /未知キー/), JSON.stringify(ok));
  assert.ok(has(validateSceneJson({ version: 2, partition: { cellSize: "x" }, entities: [] }, { knownAssets: [] }).errors, /partition/));
  assert.ok(has(validateSceneJson({ version: 2, partition: { cellSize: 1 }, entities: [] }, { knownAssets: [] }).warnings, /小さすぎる/));
  assert.ok(has(validateSceneJson({ version: 2, parts: [{ file: "cell_0_0.json" }], entities: [] }, { knownAssets: [] }).warnings, /目次/));
  assert.ok(has(validateSceneJson({ version: 2, parts: "x", entities: [] }, { knownAssets: [] }).errors, /parts/));
  pass("sceneWrite の検証が partition / parts / エンティティの partition 印を扱う");
}

console.log(`\nOK: sceneFormat テスト ${passed} 項目すべて通過`);
