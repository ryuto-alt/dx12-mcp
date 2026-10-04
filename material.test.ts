/**
 * 素材ライブラリ(materialLibrary.ts)と Blender への貼り付け・焼き(blenderMaterial.ts)の自己テスト。
 * ネットワークも Blender も要らない(偽の getJson / download / blenderExec で流す)。
 *
 * 検証対象:
 *   [1] 検索語の英訳(日本語 → 英語)
 *   [2] マップ名の正規化(PolyHaven / ambientCG)・取るファイルの選び方・解像度の落とし方
 *   [3] ORM 詰めのチャンネル規則(arm はそのまま / 無いチャンネルは AO=1・roughness=1・metallic=0)
 *   [4] 検索結果の整形(実寸 mm / cm → m、0 は null)・両素材源の混ぜ・片方が落ちても返る
 *   [5] 解像度の計算・UV 拡縮の計算(1.7m の素材 → 1m の面に約 0.59 回)
 *   [6] Blender に送るスクリプトに SystemExit が無い・罠が埋まっている(回帰防止)
 *   [7] ensureMaterial のキャッシュ(2 回目はダウンロードも ORM 詰めもしない)・meta.json
 *   [8] applyMaterial / bakeMaterials の流れ(needsBake の理由・引数の検証)
 *
 * 実行: node material.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// キャッシュはテスト用の一時フォルダへ(実ユーザーの %LOCALAPPDATA% を汚さない)。import より前に決める
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-material-test-"));
process.env.DX12_MATERIALS_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 使用中でも落とさない */ } });

import {
  ambientAssetsToHits, ambientSearchUrl, buildOrmPackScript, ensureMaterial, materialDir, normalizeAmbientMap, normalizeMapName, normalizePolyhavenMap,
  ormPixel, ormPlan, pickAmbientDownload, pickPolyhavenFiles, pickResolutionKey, resolutionWarning, resolveMaterial, searchMaterials, searchPolyhavenList,
  translateQuery, type EnsureDeps, type MapPaths,
} from "./materialLibrary.ts";
import {
  applyMaterial, bakeMaterials, bakeReasons, bakeResolution, defaultMaterialName, buildApplyScript, buildBakeScript, isUniformUv, repeatsPerMeter, resolveScaleM, roundPow2,
  uvScaleFactor, uvScaleFromRatio,
} from "./blenderMaterial.ts";
import { buildExportScript, BAKED_SWAP_PY } from "./blenderBridge.ts";
import { buildPlaceScript } from "./blenderPlace.ts";

let passed = 0;
function pass(label: string): void { passed++; console.log(`  OK  ${label}`); }
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
/** スクリプトが json.loads("...") で埋めたパラメータを取り出す */
const paramsOf = (code: string): any => JSON.parse(JSON.parse(/json\.loads\((".*")\)/.exec(code)![1]));

console.log("[1] 検索語の英訳");
{
  assert.deepStrictEqual([...translateQuery("木の床")].sort(), ["floor", "wood"]);
  assert.ok(translateQuery("錆びた金属").includes("rust") && translateQuery("錆びた金属").includes("metal"));
  assert.ok(translateQuery("コンクリート").includes("concrete") && translateQuery("コンクリ").includes("concrete"));
  assert.deepStrictEqual(translateQuery("大理石"), ["marble"]);
  for (const [ja, en] of [["石", "stone"], ["布", "fabric"], ["革", "leather"], ["レンガ", "brick"], ["タイル", "tile"], ["土", "ground"], ["砂", "sand"], ["草", "grass"], ["樹皮", "bark"], ["壁", "wall"], ["屋根", "roof"], ["塗装", "paint"]])
    assert.ok(translateQuery(ja).includes(en), `${ja} → ${en}`);
  pass("木・床・石・金属・錆・布・革・コンクリ・レンガ・タイル・土・砂・草・大理石・樹皮・壁・屋根・塗装が英訳される");
  assert.deepStrictEqual(translateQuery("Rusty Metal"), ["rusty", "metal"]);
  assert.deepStrictEqual([...translateQuery("wood 床")].sort(), ["floor", "wood"]);
  assert.deepStrictEqual(translateQuery("ふわふわ"), ["ふわふわ"]);
  pass("英語はそのまま(小文字)・混在も OK・表に無い日本語だけなら元の語を返す(空検索にしない)");
  // 長い語が先: 「コンクリート」を「コン…」の短い語と取り違えない / 「木材」は「木」+「材」にならず wood 1 つ
  assert.deepStrictEqual(translateQuery("木材"), ["wood"]);
  pass("長い語を先に当てる(木材 → wood)");
}

console.log("[2] マップ名の正規化・ファイルの選び方");
{
  const ph: [string, string | null][] = [["Diffuse", "color"], ["Rough", "roughness"], ["nor_gl", "normal_gl"], ["nor_dx", null], ["AO", "ao"], ["Displacement", "height"], ["arm", "arm"], ["Metal", "metallic"], ["Mask", "opacity"], ["rough_ao", null], ["Bump", null], ["spec", null], ["blend", null], ["gltf", null]];
  for (const [k, v] of ph) assert.equal(normalizePolyhavenMap(k), v, k);
  pass("PolyHaven: Diffuse/Rough/nor_gl/AO/Displacement/arm/Metal/Mask を正規名に・nor_dx と rough_ao 等は使わない");
  const ac: [string, string | null][] = [["Bricks060_2K-JPG_Color.jpg", "color"], ["Bricks060_2K-JPG_Roughness.jpg", "roughness"], ["Bricks060_2K-JPG_NormalGL.jpg", "normal_gl"], ["Bricks060_2K-JPG_NormalDX.jpg", null],
    ["Bricks060_2K-JPG_Displacement.jpg", "height"], ["Bricks060_2K-JPG_AmbientOcclusion.jpg", "ao"], ["Bricks060_2K-JPG_Metalness.jpg", "metallic"], ["Bricks060_2K-JPG_Opacity.jpg", "opacity"],
    ["Bricks060_2K-JPG_Emission.jpg", "emission"], ["Bricks060.usdc", null], ["Bricks060_PREVIEW.png", null]];
  for (const [k, v] of ac) assert.equal(normalizeAmbientMap(k), v, k);
  assert.equal(normalizeMapName("polyhaven", "Diffuse"), "color");
  assert.equal(normalizeMapName("ambientcg", "x_2K-PNG_NormalGL.png"), "normal_gl");
  pass("ambientCG: _Color/_Roughness/_NormalGL/_Displacement/_AmbientOcclusion/_Metalness/_Opacity/_Emission を正規名に・NormalDX と preview は捨てる");

  const files: any = {
    Diffuse: { "2k": { jpg: { url: "https://x/d.jpg", size: 1 }, png: { url: "https://x/d.png" } } },
    arm: { "2k": { jpg: { url: "https://x/arm.jpg" } } },
    AO: { "2k": { jpg: { url: "https://x/ao.jpg" } } }, Rough: { "2k": { jpg: { url: "https://x/r.jpg" } } },
    nor_gl: { "2k": { png: { url: "https://x/n.png" }, jpg: { url: "https://x/n.jpg" } } }, nor_dx: { "2k": { png: { url: "https://x/ndx.png" } } },
    Displacement: { "2k": { jpg: { url: "https://x/h.jpg" } } }, blend: { "2k": { blend: { url: "https://x/b.blend" } } },
  };
  const pk = pickPolyhavenFiles(files, "2k");
  assert.deepStrictEqual(Object.keys(pk.picked).sort(), ["arm", "color", "height", "normal_gl"]);
  assert.equal(pk.picked.normal_gl!.ext, "png");
  assert.equal(pk.picked.color!.ext, "jpg");
  pass("arm があれば AO/Rough は取らない・nor_dx は取らない・法線は png 優先・他は jpg 優先");
  const noArm = pickPolyhavenFiles({ Diffuse: files.Diffuse, AO: files.AO, Rough: files.Rough, Metal: { "2k": { jpg: { url: "https://x/m.jpg" } } } }, "2k");
  assert.deepStrictEqual(Object.keys(noArm.picked).sort(), ["ao", "color", "metallic", "roughness"]);
  pass("arm が無ければ ao / roughness / metallic を個別に取る");
  assert.equal(pickResolutionKey(["1k", "2k", "4k", "8k"], "4k"), "4k");
  assert.equal(pickResolutionKey(["1k", "2k"], "8k"), "2k");
  assert.equal(pickResolutionKey(["4k", "8k"], "1k"), "4k");
  assert.equal(pickResolutionKey(["jpg"], "2k"), null);
  pass("要求の解像度が無ければ、それ以下で最大 → 無ければ最小");

  const dl = [{ attribute: "1K-JPG", downloadLink: "u1j", size: 1 }, { attribute: "2K-PNG", downloadLink: "u2p" }, { attribute: "2K-JPG", downloadLink: "u2j" }, { attribute: "4K-JPG", downloadLink: "u4j" }, { attribute: "junk", downloadLink: "z" }];
  assert.equal(pickAmbientDownload(dl, "2k")!.url, "u2j");
  assert.equal(pickAmbientDownload(dl, "8k")!.url, "u4j");
  assert.equal(pickAmbientDownload([{ attribute: "2K-PNG", downloadLink: "u2p" }], "2k")!.url, "u2p");
  assert.equal(pickAmbientDownload([], "2k"), null);
  pass("ambientCG: JPG 優先・無ければ PNG・解像度が無ければ以下で最大");
  assert.ok(resolutionWarning("8k", 480e6)!.includes("MB") && resolutionWarning("2k") === null);
  pass("8k だけ警告(数百 MB)");
}

console.log("[3] ORM 詰めのチャンネル規則");
{
  const arm = ormPlan({ arm: "/a/arm.jpg", color: "/a/c.jpg" });
  assert.equal(arm.mode, "arm"); assert.deepStrictEqual(arm.defaults, []);
  assert.deepStrictEqual(ormPixel(arm, { arm: [0.3, 0.6, 0.9] }), [0.3, 0.6, 0.9]);
  pass("arm はそのまま(R=AO G=roughness B=metallic)");
  const full = ormPlan({ ao: "ao", roughness: "r", metallic: "m" });
  assert.deepStrictEqual(ormPixel(full, { ao: 0.2, roughness: 0.4, metallic: 0.8 }), [0.2, 0.4, 0.8]);
  pass("個別: R=AO / G=roughness / B=metallic");
  const noMetal = ormPlan({ ao: "ao", roughness: "r" });
  assert.deepStrictEqual(noMetal.defaults, ["B(metallic)=0"]);
  assert.deepStrictEqual(ormPixel(noMetal, { ao: 0.5, roughness: 0.7 }), [0.5, 0.7, 0]);
  pass("metallic が無ければ B=0(★粗さを B に入れると金属になる)");
  const onlyRough = ormPlan({ roughness: "r" });
  assert.deepStrictEqual(onlyRough.defaults, ["R(AO)=1", "B(metallic)=0"]);
  assert.deepStrictEqual(ormPixel(onlyRough, { roughness: 0.3 }), [1, 0.3, 0]);
  const none = ormPlan({});
  assert.deepStrictEqual(ormPixel(none, {}), [1, 1, 0]);
  pass("AO が無ければ R=1・roughness も無ければ G=1");
  const py = buildOrmPackScript();
  assert.ok(py.includes('out[..., 0] = px(ims["ao"], W, H)[..., 0] if "ao" in ims else 1.0'));
  assert.ok(py.includes('out[..., 1] = px(ims["roughness"], W, H)[..., 0] if "roughness" in ims else 1.0'));
  assert.ok(py.includes('out[..., 2] = px(ims["metallic"], W, H)[..., 0] if "metallic" in ims else 0.0'));
  assert.ok(py.includes("Non-Color") && py.includes("is_data=True") && !/SystemExit|sys\.exit/.test(py));
  pass("詰めスクリプトは Python 側でも同じ規則(AO=1 / roughness=1 / metallic=0 / Non-Color)");
}

console.log("[4] 検索結果の整形");
{
  const list: any = {
    wood_floor: { name: "Wood Floor", tags: ["wood", "floor"], categories: ["wood", "floor"], dimensions: [1700, 1700], max_resolution: [8192, 8192], download_count: 100, thumbnail_url: "https://t/wf.png" },
    rusty_metal: { name: "Rusty Metal", tags: ["rust", "metal"], categories: ["metal"], dimensions: [2000, 1000], max_resolution: [4096, 4096], download_count: 50 },
    brick_wall: { name: "Brick Wall", tags: ["brick"], categories: ["wall"], dimensions: [0, 0], max_resolution: [2048, 2048], download_count: 5 },
  };
  const w = searchPolyhavenList(list, ["wood", "floor"], 5);
  assert.equal(w[0].id, "wood_floor");
  assert.deepStrictEqual(w[0].sizeM, [1.7, 1.7]);
  assert.equal(w[0].maxRes, 8192); assert.equal(w[0].license, "CC0"); assert.equal(w[0].url, "https://polyhaven.com/a/wood_floor");
  assert.deepStrictEqual(searchPolyhavenList(list, ["metal"], 5)[0].sizeM, [2, 1]);
  assert.equal(searchPolyhavenList(list, ["brick"], 5)[0].sizeM, null);
  assert.equal(searchPolyhavenList(list, ["zzz"], 5).length, 0);
  pass("PolyHaven: dimensions[mm] → sizeM[m]・0 は null・全語に当たるものが先頭");

  const found = [{ assetId: "Bricks060", displayName: "Bricks 060", tags: ["brick"], dimensionX: 105, dimensionY: 105, shortLink: "https://ambientcg.com/a/Bricks060",
    downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: "1K-JPG" }, { attribute: "8K-JPG" }] } } } }, previewImage: { "256-JPG-FFFFFF": "https://t/b.jpg" } },
  { assetId: "Bricks097", displayName: "Bricks 097", tags: [], dimensionX: 0, dimensionY: 0 }];
  const a = ambientAssetsToHits(found);
  assert.deepStrictEqual(a[0].sizeM, [1.05, 1.05]); assert.equal(a[0].maxRes, 8192); assert.equal(a[0].thumbnailUrl, "https://t/b.jpg");
  assert.equal(a[1].sizeM, null); assert.equal(a[1].source, "ambientcg");
  pass("ambientCG: dimensionX/Y[cm] → sizeM[m]・0 は null・maxRes は zip の最大解像度");
  assert.ok(ambientSearchUrl("a b", 5).includes("q=a%20b") && ambientSearchUrl("a", 5).includes("include=downloadData,displayData,dimensionsData,tagData"));

  const deps = { getJson: async (url: string) => url.includes("polyhaven") ? list : { foundAssets: found } };
  const r = await searchMaterials({ query: "木の床", limit: 3 }, deps);
  assert.deepStrictEqual(r.english.sort(), ["floor", "wood"]);
  assert.deepStrictEqual(r.results.map((x) => x.source), ["polyhaven", "ambientcg", "ambientcg"].slice(0, r.results.length));
  assert.ok(r.results.length >= 2 && r.results.length <= 3);
  pass("両素材源を交互に混ぜて limit まで返す");
  const only = await searchMaterials({ query: "brick", source: "polyhaven" }, deps);
  assert.ok(only.results.every((x) => x.source === "polyhaven"));
  const half = await searchMaterials({ query: "wood" }, { getJson: async (url: string) => { if (url.includes("ambientcg")) throw new Error("boom"); return list; } });
  assert.ok(half.results.length > 0 && half.warnings.some((x) => x.includes("ambientCG")));
  pass("source 指定で片方だけ・片方が落ちても残りを返して warnings に出す");
  assert.equal((await searchMaterials({ query: "wood", limit: 99 }, deps)).results.length <= 30, true);

  const hit = await resolveMaterial({ id: "wood_floor", source: "polyhaven" }, { getJson: async () => ({ name: "Wood Floor", tags: [], dimensions: [1700, 1700], max_resolution: [8192, 8192] }) });
  assert.equal(hit.id, "wood_floor"); assert.deepStrictEqual(hit.sizeM, [1.7, 1.7]);
  const q1 = await resolveMaterial({ query: "brick" }, deps);
  assert.ok(q1.id.length > 0);
  await assert.rejects(resolveMaterial({}, deps), /id か query/);
  pass("resolveMaterial: id 指定はその素材・query は検索 1 位・どちらも無ければ分かる失敗");
}

console.log("[5] 解像度・UV 拡縮の計算");
{
  assert.equal(roundPow2(2508), 2048); assert.equal(roundPow2(2800), 2048); assert.equal(roundPow2(3000), 4096); assert.equal(roundPow2(1), 1); assert.equal(roundPow2(0.2), 1);
  const b = bakeResolution(6, 1024, 512, 4096);   // 1m の箱: sqrt(6)*1024 = 2508 → 2048
  assert.equal(b.resolution, 2048); near(b.raw, Math.sqrt(6) * 1024, 1e-6); assert.equal(b.clamped, null);
  assert.equal(bakeResolution(0.01, 1024, 512, 4096).resolution, 512);        // 小物は下限
  assert.equal(bakeResolution(0.01, 1024, 512, 4096).clamped, "min");
  assert.equal(bakeResolution(400, 1024, 512, 4096).resolution, 4096);        // 大きな物は上限
  assert.equal(bakeResolution(400, 1024, 512, 4096).clamped, "max");
  assert.equal(bakeResolution(1, 1024, 300, 5000).resolution, 1024);           // min/max も 2 の冪に丸まる
  assert.equal(bakeResolution(1, 100, 512, 4096).resolution, 512);
  pass("解像度 = round_pow2(sqrt(面積) × texelDensity) を [minRes, maxRes] で挟む");
  near(uvScaleFactor(1.7), 1 / 1.7); near(repeatsPerMeter(1.7), 0.5882352941176471);
  assert.ok(Math.abs(repeatsPerMeter(1.7) - 0.59) < 0.005);
  pass("1.7m の素材 → 1m の面に約 0.59 回");
  near(uvScaleFromRatio(1, 1.7), 1 / 1.7);          // 1m あたり 1 UV の UV
  near(uvScaleFromRatio(0.5, 1), 2);                // 2m の面に 0..1 を貼っただけの UV は 2 倍にして 1m 1 枚
  assert.ok(isUniformUv([1, 1.1, 0.95]) && !isUniformUv([0.5, 5, 1]) && !isUniformUv([]) && !isUniformUv([1, 0]));
  pass("元 UV の実寸比が一様なら一様拡縮・一様でなければ箱投影(2m×0.2m×1m の板は辺比 10 倍で箱投影になる)");
  assert.deepStrictEqual(resolveScaleM(undefined, [1.7, 1.7]), { scaleM: 1.7, from: "material", aspect: 1 });
  assert.deepStrictEqual(resolveScaleM(3, [1.7, 1.7]), { scaleM: 3, from: "arg", aspect: 1 });
  assert.deepStrictEqual(resolveScaleM(undefined, null), { scaleM: 2, from: "default", aspect: 1 });
  assert.equal(resolveScaleM(0, null).scaleM, 2);
  near(resolveScaleM(undefined, [2.2, 1.1]).aspect, 0.5);
  pass("scaleM: 指定 > 素材の実寸 > 2m(不明)・正方形でない実寸は V 方向の aspect に");
  const r = bakeReasons({ projection: "uv", antiTile: false, displacement: "none", hasHeight: true, edgeWear: 0, dirt: 0 });
  assert.equal(r.length, 0);
  assert.equal(bakeReasons({ projection: "box", antiTile: true, displacement: "bump", hasHeight: true, edgeWear: 0.2, dirt: 0 }).length, 4);
  assert.equal(bakeReasons({ projection: "uv", antiTile: false, displacement: "bump", hasHeight: false, edgeWear: 0, dirt: 0 }).length, 0);
  pass("needsBake の理由: antiTile / box / weathering / bump(height がある時だけ)");
  const dn = (o: any) => defaultMaterialName("wood_floor", "2k", { antiTile: false, projection: "uv", edgeWear: 0, dirt: 0, bump: false, ...o });
  assert.equal(dn({}), "dx12_wood_floor_2k");
  assert.equal(dn({ antiTile: true, edgeWear: 0.8, dirt: 0.5, bump: true }), "dx12_wood_floor_2k_at_e0.8_d0.5_bump");
  assert.notEqual(dn({}), dn({ antiTile: true })); assert.notEqual(dn({ projection: "box" }), dn({}));
  pass("既定のマテリアル名はノードの作りが違えば別名(同名の作り直しで先に貼った物を壊さない)");
}

console.log("[6] Blender に送るスクリプト");
{
  const ap = buildApplyScript({ objects: ["A"], materialName: "m", scaleM: 1.7, projection: "uv", antiTile: true, displacement: "bump", edgeWear: 0.5, dirt: 0.5, imageBase: "m",
    maps: { color: "C:\\a\\color.jpg", orm: "C:\\a\\orm.png", normal_gl: "C:\\a\\n.png", height: "C:\\a\\h.jpg" }, meta: { id: "x" } });
  const bk = buildBakeScript({ objects: ["A"], texelDensity: 1024, maxRes: 4096, minRes: 512, samples: 16, maps: ["basecolor", "normal"], device: "auto", fallbackDir: "C:\\t" });
  const ex = buildExportScript({ objectNames: ["A"], outPath: "C:/t/a.gltf" });
  const pl = buildPlaceScript({ objects: [], assetsRoot: "C:/a", assetDir: "", group: "", exportMeshes: true });
  for (const sc of [ap, bk, ex, pl, buildOrmPackScript(), BAKED_SWAP_PY]) assert.ok(!/SystemExit|sys\.exit|quit_blender/.test(sc), "SystemExit / sys.exit が入っている");
  pass("生成スクリプトに SystemExit / sys.exit が含まれない(apply / bake / export / place / ORM 詰め)");
  const p = paramsOf(ap);
  assert.equal(p.scaleM, 1.7); assert.equal(p.maps.color, "C:/a/color.jpg"); assert.equal(p.antiTile, true);
  pass("パラメータは JSON で渡る(Windows のパスは / に)");
  assert.ok(ap.includes('"glTF Material Output"') && ap.includes('"Occlusion"') && ap.includes('sep.outputs["Red"], gn.inputs["Occlusion"]'));
  assert.ok(ap.includes('sep.outputs["Green"]') && ap.includes('sep.outputs["Blue"]') && ap.includes("Non-Color"));
  pass("apply: orm の R を glTF Material Output(Occlusion)・G=roughness・B=metallic(Non-Color)につなぐ");
  assert.ok(ap.includes('UVN = "dx12_uv"') && ap.includes("dx12_uv_to_front(me, UVN)") && ap.includes("1.25"));
  assert.ok(!ap.includes("ShaderNodeMapping") || ap.indexOf("BOX") > 0);   // Mapping での縮尺合わせは箱投影のときだけ
  pass("apply: 専用 UV dx12_uv を作り先頭へ(texCoord は並び順)・元 UV の一様判定");
  assert.ok(bk.includes("dx12_baked_material") && bk.includes('"_dx12"') && bk.includes("orig.copy()") && bk.includes("s.material = m"));
  assert.ok(bk.includes("type=kind") && bk.includes("'NORMAL'") && bk.includes("'AO'") && bk.includes("'EMIT'") && bk.includes("normal_g='POS_Y'"));
  assert.ok(bk.includes("smart_project") && bk.includes("dx12_bake"));
  pass("bake: 複製マテリアルに焼く・元の割り当てを finally で戻す・dx12_baked_material を書く・EMIT/NORMAL/AO・OpenGL 法線");
  for (const sc of [ex, pl]) assert.ok(sc.includes("dx12_swap_in(") && sc.includes("dx12_swap_out("));
  assert.ok(BAKED_SWAP_PY.includes("orig.copy()") && BAKED_SWAP_PY.includes("ob.data = st[\"orig\"]") && BAKED_SWAP_PY.includes("dx12_uv_to_front(me2, uvn)"));
  pass("書き出し(export / place)は一時コピーのメッシュ複製にだけ焼いたマテリアルを差し替え、元のデータに戻す");
  assert.deepStrictEqual(paramsOf(bk).maps, ["basecolor", "normal"]);
  assert.equal(paramsOf(bk).fallbackDir, "C:/t");
}

console.log("[7] ensureMaterial(キャッシュ)");
{
  let downloads = 0, packs = 0, extracts = 0;
  const fake: EnsureDeps = {
    getJson: async (url: string) => {
      if (url.includes("/info/")) return { name: "Wood Floor", dimensions: [1700, 1700] };
      if (url.includes("/files/")) return { Diffuse: { "2k": { jpg: { url: "https://x/c.jpg" } } }, arm: { "2k": { jpg: { url: "https://x/arm.jpg" } } }, nor_gl: { "2k": { png: { url: "https://x/n.png" } } }, Displacement: { "2k": { jpg: { url: "https://x/h.jpg" } } } };
      return { foundAssets: [{ assetId: "Bricks060", displayName: "Bricks 060", dimensionX: 105, dimensionY: 105, downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: "2K-JPG", downloadLink: "https://ambientcg.com/get?file=Bricks060_2K-JPG.zip" }] } } } } }] };
    },
    download: async (_u: string, dest: string) => { downloads++; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, "x"); return 1; },
    extractZip: async (_z: string, dir: string) => { extracts++; fs.mkdirSync(dir, { recursive: true }); for (const f of ["Bricks060_2K-JPG_Color.jpg", "Bricks060_2K-JPG_Roughness.jpg", "Bricks060_2K-JPG_NormalGL.jpg", "Bricks060_2K-JPG_NormalDX.jpg", "Bricks060_2K-JPG_AmbientOcclusion.jpg", "Bricks060_2K-JPG_Displacement.jpg", "Bricks060.usdc"]) fs.writeFileSync(path.join(dir, f), "x"); },
    packOrm: async (_plan: any, out: string) => { packs++; (fake as any).lastPlan = _plan; fs.writeFileSync(out, "orm"); return { size: [2048, 2048] as [number, number], mean: [1, 0.5, 0] }; },
  };
  const m1 = await ensureMaterial({ source: "polyhaven", id: "wood_floor", resolution: "2k" }, fake);
  assert.equal(m1.cached, false); assert.equal(m1.dir, materialDir("polyhaven", "wood_floor", "2k"));
  assert.ok(m1.dir.startsWith(TMP) && m1.dir.endsWith(path.join("polyhaven", "wood_floor", "2k")));
  assert.deepStrictEqual(Object.keys(m1.maps).sort(), ["arm", "color", "height", "normal_gl"]);
  assert.equal(downloads, 4); assert.equal(packs, 1); assert.equal((fake as any).lastPlan.mode, "arm");
  const meta = JSON.parse(fs.readFileSync(path.join(m1.dir, "meta.json"), "utf8"));
  assert.equal(meta.license, "CC0"); assert.deepStrictEqual(meta.sizeM, [1.7, 1.7]); assert.equal(meta.complete, true); assert.ok(meta.fetchedAt && meta.url.includes("polyhaven.com"));
  assert.ok(fs.existsSync(path.join(m1.dir, "orm.png")));
  const m2 = await ensureMaterial({ source: "polyhaven", id: "wood_floor", resolution: "2k" }, fake);
  assert.equal(m2.cached, true); assert.equal(downloads, 4); assert.equal(packs, 1);
  pass("PolyHaven: <root>/<source>/<id>/<res>/ にマップ名を正規化して保存・meta.json(CC0・実寸・取得日時)・2 回目は取り直さず ORM も作り直さない");
  const m3 = await ensureMaterial({ source: "ambientcg", id: "Bricks060", resolution: "2k" }, fake);
  assert.deepStrictEqual(Object.keys(m3.maps).sort(), ["ao", "color", "height", "normal_gl", "roughness"]);
  assert.equal(extracts, 1); assert.equal((fake as any).lastPlan.mode, "channels"); assert.deepStrictEqual((fake as any).lastPlan.defaults, ["B(metallic)=0"]);
  assert.ok(!fs.existsSync(path.join(m3.dir, "_zip")) && !fs.existsSync(path.join(m3.dir, "_download.zip")) && !fs.existsSync(path.join(m3.dir, "normal_dx.jpg")));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(m3.dir, "meta.json"), "utf8")).sizeM, [1.05, 1.05]);
  pass("ambientCG: zip を展開 → 正規名に改名(NormalDX と usdc は捨てる)・zip と一時フォルダは消す・AO 別マップは ao・metallic 無しは B=0");
  const m8 = await ensureMaterial({ source: "polyhaven", id: "wood_floor", resolution: "8k" }, { ...fake, getJson: async (u: string) => u.includes("/files/") ? { Diffuse: { "2k": { jpg: { url: "u" } } }, arm: { "2k": { jpg: { url: "a" } } } } : { name: "W", dimensions: [1000, 1000] } });
  assert.ok(m8.warnings.some((w) => w.includes("8k") && w.includes("MB")) && m8.warnings.some((w) => w.includes("2k で取った")));
  pass("8k は警告・要求の解像度が無ければ落として知らせる");
}

console.log("[8] applyMaterial / bakeMaterials の流れ");
{
  const ensured = { dir: "C:/m/x", maps: { color: "C:/m/x/color.jpg", arm: "C:/m/x/arm.jpg", normal_gl: "C:/m/x/normal_gl.png", height: "C:/m/x/height.jpg" } as MapPaths, orm: "C:/m/x/orm.png",
    meta: { sizeM: [1.7, 1.7] as [number, number], resolution: "2k", orm: { mode: "arm" as const, defaults: [], mean: [1, 1, 0], size: [2048, 2048] as [number, number] } }, cached: true, warnings: [] };
  const hit = { source: "polyhaven" as const, id: "wood_floor", name: "Wood Floor", tags: [], sizeM: [1.7, 1.7] as [number, number], maxRes: 8192, thumbnailUrl: "", license: "CC0" as const, url: "https://polyhaven.com/a/wood_floor" };
  const seen: string[] = [];
  const deps = {
    resolve: async () => hit, ensure: async () => ensured as any,
    blenderExec: async (code: string) => { seen.push(code); return { stdout: "", json: { material: "dx12_wood_floor_2k", objects: [{ name: "Box1", uvSource: "original" }], warnings: [] } }; },
  };
  const r1: any = await applyMaterial({ objects: ["Box1"], id: "wood_floor", displacement: "none" }, deps);
  assert.equal(r1.needsBake, false); assert.equal(r1.needsBakeReasons, undefined); near(r1.scaleM, 1.7); near(r1.repeatsPerMeter, 1 / 1.7);
  assert.ok(Math.abs(r1.repeatsPerMeter - 0.59) < 0.005);
  assert.equal(paramsOf(seen[0]).maps.height, undefined);                 // displacement:none は height を渡さない
  const r2: any = await applyMaterial({ objects: ["Box1"], id: "wood_floor", antiTile: true, weathering: { edgeWear: 2, dirt: -1 }, scaleM: 3 }, deps);
  assert.equal(r2.needsBake, true); assert.ok(r2.needsBakeReasons.length === 3 && r2.next.includes("dx12_material_bake"));
  assert.equal(r2.scaleM, 3); const p2 = paramsOf(seen[1]);
  assert.equal(p2.edgeWear, 1); assert.equal(p2.dirt, 0); assert.equal(p2.maps.height, "C:/m/x/height.jpg"); assert.equal(p2.maps.orm, "C:/m/x/orm.png");
  pass("apply: needsBake の理由と next(dx12_material_bake)・weathering は 0..1 に丸める・height は bump のときだけ渡す");
  await assert.rejects(applyMaterial({ id: "x" }, { ...deps, blenderExec: async () => ({ stdout: "", json: { error: "貼る対象が無い" } }) }), /貼る対象が無い/);
  await assert.rejects(applyMaterial({ id: "x" }, { ...deps, blenderExec: async () => ({ stdout: "garbage" }) }), /結果を読めなかった/);
  pass("Blender 側のエラー・読めない出力は分かる失敗にする");

  const bseen: string[] = [];
  const bdeps = { blenderExec: async (code: string) => { bseen.push(code); return { stdout: "", json: { units: [{ objects: ["A"], bakedMaterial: "M_dx12" }], warnings: [] } }; } };
  const b1: any = await bakeMaterials({}, bdeps);
  const bp = paramsOf(bseen[0]);
  assert.equal(bp.texelDensity, 1024); assert.equal(bp.maxRes, 4096); assert.equal(bp.minRes, 512); assert.equal(bp.samples, 16);
  assert.deepStrictEqual(bp.maps, ["basecolor", "roughness", "metallic", "normal", "ao", "emission"]); assert.equal(bp.device, "auto");
  assert.equal(b1.ok, true); assert.ok(b1.next.includes("dx12_blender_place"));
  await bakeMaterials({ texelDensity: 512, maxRes: 2048, minRes: 256, samples: 8, maps: ["normal"], device: "cpu", objects: ["A"] }, bdeps);
  const bp2 = paramsOf(bseen[1]);
  assert.deepStrictEqual([bp2.texelDensity, bp2.maxRes, bp2.minRes, bp2.samples, bp2.maps, bp2.device, bp2.objects], [512, 2048, 256, 8, ["normal"], "cpu", ["A"]]);
  await assert.rejects(bakeMaterials({ maps: ["opacity"] as any }, bdeps), /未対応/);
  const b3: any = await bakeMaterials({}, { blenderExec: async () => ({ stdout: "", json: { units: [{ objects: ["A"], error: "x" }], warnings: [] } }) });
  assert.equal(b3.ok, false);
  pass("bake: 既定(1024 px/m・4096・512・16・全マップ)・引数の受け渡し・未対応マップは失敗・ユニットの失敗は ok:false");
}

console.log(`\nOK: ${passed} 件すべて成功`);
