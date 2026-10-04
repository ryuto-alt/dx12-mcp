/**
 * blenderPlace.ts(Blender の配置をそのまま置く)の自己テスト。Blender もエンジンも要らない(偽の deps で流す)。
 *
 * 検証対象:
 *   [1] 座標変換(位置・クォータニオン・スケール)。★正しさの定義: 「各オブジェクトを原点で書き出してエンジン側で変換」が
 *       「シーン全体を 1 つの glTF に出す」と同じ見た目 = C·M·v == M'·(C·v)(C は (x,y,z)→(x,z,-y))を乱択で確かめる
 *   [2] エンジンの Euler 度 → クォータニオン(実測した Cyl の値で)
 *   [3] 配置計画の差分(新規 / 更新 / prune / 重複 / 変更なし)
 *   [4] Blender スクリプトに罠が埋まっている(回帰防止)
 *   [5] placeFromBlender の流れ(dryRun は何も書かない / 1 回目 / 2 回目 / prune / 失敗で rollback / 画像の改名)
 *
 * 実行: node blenderPlace.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetModelPath, blenderToEngine, blenderToEnginePos, blenderToEngineQuat, blenderToEngineScale, buildPlaceScript,
  engineEulerToQuat, placeFromBlender, planPlacement, quatClose, vecClose,
  type ExistingChild, type PlaceObject,
} from "./blenderPlace.ts";
import { modelBrief } from "./blenderBridge.ts";

let passed = 0;
function pass(label: string): void { passed++; console.log(`  OK  ${label}`); }
/** buildPlaceScript が json.loads("...") で埋めたパラメータを取り出す */
const paramsOf = (code: string): any => JSON.parse(JSON.parse(/json\.loads\((".*")\)/.exec(code)![1]));
const close = (a: readonly number[], b: readonly number[], eps = 1e-5) => assert.ok(vecClose(a, b, eps), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

// ─── 小さな行列ユーティリティ(テスト用) ─────────────────────────────────────
type M3 = number[][];
const mul3 = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
const apply3 = (m: M3, v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
/** クォータニオン [x,y,z,w] → 回転行列 */
function rotOf(q: readonly number[]): M3 {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const diag = (s: readonly number[]): M3 => [[s[0], 0, 0], [0, s[1], 0], [0, 0, s[2]]];
const C: M3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];   // Blender → エンジン((x,y,z) → (x,z,-y))

// ─── [1] 座標変換 ────────────────────────────────────────────────────────────
console.log("\n[1] 座標変換");
{
  close(blenderToEnginePos([1, 2, 3]), [1, 3, -2]);
  close(blenderToEngineScale([2, 3, 4]), [2, 4, 3]);
  close(blenderToEngineQuat([0.5, 0.1, 0.2, 0.3]), [0.1, 0.3, -0.2, 0.5]);
  pass("位置 [x,z,-y] / スケール [sx,sz,sy] / クォータニオン (w,x,y,z)→[x,z,-y,w]");

  // modelBrief の「Blender の -Y がエンジンの +Z」と矛盾しない
  close(blenderToEnginePos([0, -1, 0]), [0, 0, 1]);
  assert.ok(modelBrief("prop").rules.some((r) => r.includes("Blender の -Y がエンジンの +Z")));
  pass("Blender の -Y がエンジンの +Z(modelBrief の記述と同じ)");

  // 実測ケース: +X 方向 2m の棒を Blender の Z 軸 90° 相当 [0,0.7071,0,0.7071] でエンジンに置くと z∈[-2,0]。
  // Blender で Z 軸 90° 回すと +X の棒は +Y(y∈[0,2])に向く。(x,z,-y) で z∈[-2,0]。
  const s = Math.SQRT1_2;
  const t = blenderToEngine({ loc: [0, 0, 0], quat: [s, 0, 0, s], scale: [1, 1, 1] });
  close(t.quaternion, [0, s, 0, s], 1e-5);
  const tip = apply3(rotOf(t.quaternion), [2, 0, 0]);   // エンジン側で棒の先端([2,0,0])がどこへ行くか
  close(tip, [0, 0, -2], 1e-5);
  pass("実測ケース: Z 軸 90° の棒は z∈[-2,0] に伸びる(Blender の y∈[0,2] と一致)");

  // ★正しさの定義。M = T·R·S(Blender)、M' = T'·R'·S'(エンジン)に対し、乱択した位置・回転・スケール・頂点で
  //   C·(M v) == M'·(C v)。つまり原点で書き出した glTF(頂点 C v)にエンジン側で M' を掛けると、
  //   シーン全体を 1 つの glTF に出したとき(頂点 C·(M v))と同じ場所に来る。
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let maxErr = 0;
  for (let i = 0; i < 200; i++) {
    const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const n = Math.hypot(...q); const bq = q.map((v) => v / n);   // (w,x,y,z)
    const loc = [rnd() * 20 - 10, rnd() * 20 - 10, rnd() * 20 - 10];
    const scale = [0.2 + rnd() * 3, 0.2 + rnd() * 3, 0.2 + rnd() * 3];
    const v = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
    // Blender 側のワールド頂点
    const Rb = rotOf([bq[1], bq[2], bq[3], bq[0]]);
    const mv = apply3(Rb, apply3(diag(scale), v)).map((x, k) => x + loc[k]);
    const expected = apply3(C, mv);
    // エンジン側: 原点書き出しの頂点 C v に M' を掛ける
    const e = blenderToEngine({ loc, quat: bq, scale });
    const got = apply3(rotOf(e.quaternion), apply3(diag(e.scale), apply3(C, v))).map((x, k) => x + e.position[k]);
    maxErr = Math.max(maxErr, ...got.map((x, k) => Math.abs(x - expected[k])));
  }
  assert.ok(maxErr < 1e-4, `最大誤差 ${maxErr}`);
  pass(`乱択 200 ケース(非一様スケール+任意回転)で「個別に原点で書き出す」==「全体を 1 つの glTF」(最大誤差 ${maxErr.toExponential(1)})`);
}

// ─── [2] エンジンの Euler 度 → クォータニオン ─────────────────────────────────
console.log("\n[2] engineEulerToQuat");
{
  // 実機(2026-10-05): Blender の Euler XYZ (20°,35°,50°) → エンジンが保持する rotation [16.27,38.21,-36.69](度)
  const viaBlender = blenderToEngine({ loc: [0, 0, 0], quat: [0.8732973337173462, 0.02494165487587452, 0.33838197588920593, 0.34961017966270447], scale: [1, 1, 1] }).quaternion;
  const viaEuler = engineEulerToQuat([16.270172119140625, 38.207977294921875, -36.691444396972656]);
  assert.ok(quatClose(viaBlender, viaEuler, 1e-9), `${viaBlender} vs ${viaEuler}`);
  pass("エンジンの Euler(Y→X→Z 合成)が Blender の回転の変換結果と一致する(q と -q は同一視)");
  assert.ok(quatClose([0, 0, 0, 1], [0, 0, 0, -1]) && !quatClose([0, 0, 0, 1], [0, 0.1, 0, 0.99]));
  pass("quatClose は符号違いを同じ回転とみなし、丸めで長さがずれても正規化して比べる");
}

// ─── [3] 配置計画 ────────────────────────────────────────────────────────────
console.log("\n[3] planPlacement");
const obj = (name: string, model = "m/a/a.gltf", x = 0): PlaceObject => ({ name, modelPath: model, position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
const ex = (entityId: number, name: string, model = "m/a/a.gltf", x = 0): ExistingChild =>
  ({ entityId, name, modelPath: model, position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
{
  const p0 = planPlacement([obj("A"), obj("B")], []);
  assert.deepEqual(p0.spawn.map((o) => o.name), ["A", "B"]);
  assert.equal(p0.update.length + p0.prune.length, 0);
  pass("既存が無ければ全部 spawn");

  const p1 = planPlacement([obj("A", "m/a/a.gltf", 1), obj("B"), obj("C")], [ex(10, "A"), ex(11, "B"), ex(12, "Old")]);
  assert.deepEqual(p1.spawn.map((o) => o.name), ["C"]);
  assert.deepEqual(p1.update.map((u) => [u.obj.name, u.entityId, u.modelChanged, u.transformChanged]), [["A", 10, false, true], ["B", 11, false, false]]);
  assert.equal(p1.prune.length, 0, "prune:false では消さない");
  pass("同名は update(動いたものだけ transformChanged)、無いものは spawn、既定では prune しない");

  const p2 = planPlacement([obj("A", "m/b/b.gltf")], [ex(10, "A", "m/a/a.gltf"), ex(12, "Old")], { prune: true });
  assert.equal(p2.update[0].modelChanged, true);
  assert.deepEqual(p2.prune.map((p) => p.name), ["Old"]);
  pass("モデルのパスが変われば modelChanged、prune:true で今回の一覧に無い子を消す");

  const p3 = planPlacement([obj("A")], [ex(10, "A"), ex(13, "A")], { prune: true });
  assert.deepEqual(p3.duplicates, [{ entityId: 13, name: "A" }]);
  assert.deepEqual(p3.prune.map((p) => p.entityId), [13]);
  assert.equal(planPlacement([obj("A")], [ex(10, "A"), ex(13, "A")]).prune.length, 0);
  pass("同名の子が重複していたら 2 個目以降を duplicates に出し、prune:true のときだけ消す");

  assert.equal(assetModelPath("models/blender/x/", "Box"), "models/blender/x/Box/Box.gltf");
  pass("アセットのパスは <assetDir>/<キー>/<キー>.gltf");
}

// ─── [4] Blender スクリプトの罠 ──────────────────────────────────────────────
console.log("\n[4] buildPlaceScript");
{
  const code = buildPlaceScript({ objects: ["A"], assetsRoot: "C:\\proj\\assets", assetDir: "", group: "", exportMeshes: true });
  assert.ok(code.includes("use_selection=True") && code.includes("export_yup=True") && code.includes("export_apply=True"));
  assert.ok(code.includes("export_morph=False") && code.includes('export_format="GLTF_SEPARATE"') && code.includes('export_texture_dir="textures"'));
  pass("use_selection=True / export_yup / export_apply / export_morph=False / GLTF_SEPARATE / textures");
  assert.ok(!code.includes("shape_key_clear"), "シェイプキーは消さない(export_morph=False で除外する)");
  pass("シェイプキーを shape_key_clear で消さない");
  assert.ok(/for sc in bpy\.data\.scenes[\s\S]*select_set\(False/.test(code) && /finally:[\s\S]*select_set\(True, view_layer=vl\)/.test(code));
  assert.ok(code.includes("tmp = rep.copy()") && code.includes("tmp.parent = None") && code.includes("bpy.data.objects.remove(tmp"));
  assert.ok(!/\.matrix_world\s*=/.test(code), "ユーザーのオブジェクトの matrix_world を書き換えない");
  pass("全シーンの選択を外す / 一時コピーで書き出して必ず消す / 選択とアクティブを finally で戻す / matrix_world を書き換えない");
  assert.ok(code.includes("decompose()") && code.includes("せん断") && code.includes("負のスケール") && code.includes("TEX_IMAGE"));
  assert.ok(code.includes('raw_key(ob)') && code.includes('"o:" + ob.name') && code.includes('"m:" + ob.data.name'));
  pass("decompose / せん断・負スケール・単色マテリアルの警告 / メッシュキー(モディファイア有=オブジェクト固有)");
  const noexp = buildPlaceScript({ objects: [], assetsRoot: "C:/a", assetDir: "models/x", group: "G", exportMeshes: false });
  const pp = paramsOf(noexp);
  assert.ok(pp.exportMeshes === false && pp.assetDir === "models/x" && pp.group === "G" && pp.assetsRoot === "C:/a");
  pass("パラメータは JSON として埋まる(exportMeshes:false なら書き出さない)");
}

// ─── [5] placeFromBlender の流れ(偽の deps) ───────────────────────────────────
console.log("\n[5] placeFromBlender");
{
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bplace-"));
  const report = (over: any = {}) => ({
    blendName: "untitled", assetDir: "models/blender/untitled", group: "Blender_untitled", source: "visible",
    objects: [
      { name: "Box_A", key: "BoxMesh", parent: null, loc: [3, 1, 0.5], quat: [1, 0, 0, 0], scale: [1, 1, 1] },
      { name: "Box_B", key: "BoxMesh", parent: null, loc: [-2, 4, 0.5], quat: [1, 0, 0, 0], scale: [1, 2, 3] },
      { name: "Ball", key: "BallMesh", parent: "Box_A", loc: [3, 1, 2.5], quat: [1, 0, 0, 0], scale: [1, 1, 1] },
    ],
    skipped: [{ name: "Lamp", type: "LIGHT", reason: "ライトは対象外" }],
    warnings: [],
    assets: [
      { key: "BallMesh", meshKey: "m:BallMesh", path: "models/blender/untitled/BallMesh/BallMesh.gltf", objects: ["Ball"], exported: true, size: 10 },
      { key: "BoxMesh", meshKey: "m:BoxMesh", path: "models/blender/untitled/BoxMesh/BoxMesh.gltf", objects: ["Box_A", "Box_B"], exported: true, size: 10 },
    ],
    ...over,
  });
  /** 書き出し(本番の Blender の代わり): gltf に tmp 名の画像を持たせて置く */
  const writeAssets = (exportMeshes: boolean) => {
    if (!exportMeshes) return;
    for (const k of ["BallMesh", "BoxMesh"]) {
      const d = path.join(assetsDir, "models/blender/untitled", k);
      fs.mkdirSync(path.join(d, "textures"), { recursive: true });
      fs.writeFileSync(path.join(d, "textures", "tmpabc123.jpg"), "x");
      fs.writeFileSync(path.join(d, `${k}.gltf`), JSON.stringify({ images: [{ uri: "textures/tmpabc123.jpg" }, { uri: "textures/wood.png" }] }));
    }
  };
  const mkDeps = (state: { children: ExistingChild[]; hasGroup: boolean; failAt?: string }, rep: any) => {
    const calls: { m: string; p: any }[] = [];
    let nextId = 100;
    return {
      calls,
      deps: {
        assetsDir,
        blenderExec: async (code: string) => { writeAssets(paramsOf(code).exportMeshes === true); return { stdout: "", json: rep }; },
        engineCall: async (m: string, p: any = {}) => {
          calls.push({ m, p });
          if (state.failAt === m) throw new Error(`boom ${m}`);
          switch (m) {
            case "find_entity": return state.hasGroup ? { entityId: 1, name: p.name } : null;
            case "get_hierarchy": return { roots: [{ entityId: 1, name: "Blender_untitled", children: state.children.map((c) => ({ entityId: c.entityId, name: c.name })) }] };
            case "get_entity": {
              const c = state.children.find((x) => x.entityId === p.entity)!;
              return { meshRenderer: { modelPath: c.modelPath }, transform: { position: c.position, rotation: [0, 0, 0], scale: c.scale } };
            }
            case "create_entity": case "spawn_model": return { entityId: nextId++ };
            case "reload_assets": return { reloaded: 1 };
            default: return {};
          }
        },
      },
    };
  };
  const names = (calls: { m: string }[]) => calls.map((c) => c.m);
  const WRITES = ["create_entity", "spawn_model", "set_parent", "set_transform", "delete_entity", "reload_assets", "transaction_begin", "transaction_commit", "transaction_rollback"];

  // dryRun: 何も書かない
  {
    const { deps, calls } = mkDeps({ children: [], hasGroup: false }, report());
    const r: any = await placeFromBlender({ dryRun: true }, deps);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.spawn.map((s: any) => s.name), ["Box_A", "Box_B", "Ball"]);
    assert.equal(r.willCreateGroup, true);
    assert.ok(!names(calls).some((m) => WRITES.includes(m)), `dryRun がエンジンへ書いた: ${names(calls)}`);
    assert.equal(r.skipped[0].name, "Lamp");
    pass("dryRun は spawn / update / prune / 書き出すアセットだけ返し、エンジンへ何も書かない");
  }
  // 1 回目: group を作って spawn 3 個・アセット 2 個(リンク複製は共有)・transaction で囲む・画像を改名
  {
    const { deps, calls } = mkDeps({ children: [], hasGroup: false }, report());
    const r: any = await placeFromBlender({}, deps);
    assert.equal(r.spawned.length, 3);
    assert.equal(r.assets.length, 2);
    assert.deepEqual(r.assets.find((a: any) => a.key === "BoxMesh").objects, ["Box_A", "Box_B"]);
    const seq = names(calls).filter((m) => WRITES.includes(m));
    assert.equal(seq[0], "transaction_begin");
    assert.equal(seq[1], "reload_assets");
    assert.equal(seq[2], "create_entity");
    assert.equal(seq[seq.length - 1], "transaction_commit");
    assert.deepEqual(seq.filter((m) => m === "spawn_model").length, 3);
    const spawn = calls.filter((c) => c.m === "spawn_model");
    assert.equal(spawn.filter((c) => c.p.path.includes("BoxMesh")).length, 2, "箱 2 個は同じアセットを共有");
    const tf = calls.find((c) => c.m === "set_transform" && c.p.scale[1] === 3)!;   // Box_B: Blender scale [1,2,3] → [1,3,2]
    assert.deepEqual(tf.p.scale, [1, 3, 2]);
    close(tf.p.position, [-2, 0.5, -4]);
    const gltf = JSON.parse(fs.readFileSync(path.join(assetsDir, "models/blender/untitled/BoxMesh/BoxMesh.gltf"), "utf8"));
    assert.equal(gltf.images[0].uri, "textures/BoxMesh_0.jpg", "tmp 名の画像はフォルダを保ったまま改名される");
    assert.equal(gltf.images[1].uri, "textures/wood.png", "人が付けた名前は触らない");
    assert.ok(fs.existsSync(path.join(assetsDir, "models/blender/untitled/BoxMesh/textures/BoxMesh_0.jpg")));
    pass("1 回目: group を作り spawn 3 / アセット 2(箱は共有) / begin…commit / tmp 画像の改名");
  }
  // 2 回目(meshes:false): spawn 0・update・重複しない・書き出さない
  {
    const children: ExistingChild[] = [
      { entityId: 5, name: "Box_A", modelPath: "models/blender/untitled/BoxMesh/BoxMesh.gltf", position: [3, 0.5, -1], scale: [1, 1, 1] },
      { entityId: 6, name: "Box_B", modelPath: "models/blender/untitled/BoxMesh/BoxMesh.gltf", position: [0, 0, 0], scale: [1, 1, 1] },
      { entityId: 7, name: "Ball", modelPath: "models/blender/untitled/BallMesh/BallMesh.gltf", position: [3, 2.5, -1], scale: [1, 1, 1] },
    ];
    const { deps, calls } = mkDeps({ children, hasGroup: true }, report());
    const r: any = await placeFromBlender({ meshes: false }, deps);
    assert.equal(r.spawned.length, 0);
    assert.deepEqual(r.updated.map((u: any) => [u.name, u.transformChanged]), [["Box_A", false], ["Box_B", true], ["Ball", false]]);
    assert.equal(calls.filter((c) => c.m === "set_transform").length, 1, "動いた 1 個だけ書く");
    assert.ok(!names(calls).includes("create_entity") && !names(calls).includes("reload_assets"));
    pass("2 回目(meshes:false): spawn 0・update・動いたものだけ set_transform・reload もしない");
  }
  // prune
  {
    const children: ExistingChild[] = [
      { entityId: 5, name: "Box_A", modelPath: "models/blender/untitled/BoxMesh/BoxMesh.gltf" },
      { entityId: 9, name: "Gone", modelPath: "x" },
    ];
    const { deps } = mkDeps({ children, hasGroup: true }, report());
    const r: any = await placeFromBlender({ meshes: false, prune: true }, deps);
    assert.deepEqual(r.pruned.map((p: any) => p.name), ["Gone"]);
    pass("prune:true で今回の Blender 側に無い子を削除する");
  }
  // meshes:false でアセットが無ければ skipped
  {
    const rep = report();
    rep.assets[0].path = "models/blender/untitled/Nothing/Nothing.gltf";
    const { deps } = mkDeps({ children: [], hasGroup: true }, rep);
    const r: any = await placeFromBlender({ meshes: false }, deps);
    assert.ok(r.skipped.some((s: any) => s.name === "Ball" && /アセットが無い/.test(s.reason)));
    assert.equal(r.spawned.length, 2);
    pass("meshes:false でアセットが無いオブジェクトは理由付きで skipped(落とさない)");
  }
  // 失敗で rollback
  {
    const { deps, calls } = mkDeps({ children: [], hasGroup: true, failAt: "spawn_model" }, report());
    await assert.rejects(() => placeFromBlender({ meshes: false }, deps), /boom spawn_model/);
    assert.equal(names(calls).at(-1), "transaction_rollback");
    assert.ok(!names(calls).includes("transaction_commit"));
    pass("途中で失敗したら transaction_rollback して元のエラーを返す");
  }
  // トランザクションが使えない場合は外して警告(MODE_CONFLICT は落とす)
  {
    const { deps } = mkDeps({ children: [], hasGroup: true, failAt: "transaction_begin" }, report());
    const r: any = await placeFromBlender({ meshes: false }, deps);
    assert.ok(r.warnings.some((w: string) => w.includes("トランザクションを開けなかった")));
    pass("トランザクションが開けなければ警告して続ける");
  }
  fs.rmSync(assetsDir, { recursive: true, force: true });
}

console.log(`\nOK: ${passed} 件すべて成功`);
