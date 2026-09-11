// polish.ts の単体テスト(エンジン不要)。
// 守りたいのは 3 つ:
//   1) 「足りないもの」を取りこぼさない(死んだ絵の典型パターンを全部拾う)
//   2) 揃っているシーンに難癖を付けない(誤検知は助言の信用を壊す)
//   3) 指摘に必ず【なぜ】と【次に撃つコマンド】が入っている

import {
  CATEGORIES, PROCEDURAL_SKY, auditScene, imageFacts, polishScore, verdict,
  lightFactsFrom, entityHasNormalMap, entityHasDefaultPbr, type SceneFacts,
} from "./polish.ts";
import { PNG } from "pngjs";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

/** 全部入りの「良いシーン」。ここから 1 つずつ壊して指摘が出るか見る。 */
const GOOD: SceneFacts = {
  envMapPath: "textures/hdri/sunset_2k.hdr",
  iblIntensity: 1,
  lights: [
    { type: "Directional", intensity: 3, castShadow: true },
    { type: "Point", intensity: 1.2 },
    { type: "Point", intensity: 0.6 },
  ],
  fog: { enabled: true, density: 0.015 },
  post: { bloomOn: true, bloom: 0.4, vignetteOn: true, exposureOn: true, contrastOn: true },
  ssao: { enabled: true },
  contactShadow: { enabled: true },
  emitterCount: 3,
  meshCount: 40,
  normalMapCount: 12,
  defaultPbrCount: 8,
  outdoor: true,
  image: { meanLuma: 0.42, dynamicRange: 0.72, blackPct: 6, whitePct: 1.2, saturation: 0.22 },
};

console.log("[1] 揃っているシーンには難癖を付けない");
{
  const f = auditScene(GOOD);
  check("指摘ゼロ", f.length === 0, JSON.stringify(f.map((x) => x.what)));
  check("満点", polishScore(f) === 100);
  check("次の一手を言う", verdict(100, f).includes("構図"));
}

console.log("[2] 死んだ絵の典型を拾う");
{
  const dead: SceneFacts = {
    envMapPath: "",
    lights: [{ type: "Directional", intensity: 2 }],
    fog: { enabled: false },
    post: { bloomOn: false, vignetteOn: false },
    ssao: { enabled: false },
    contactShadow: { enabled: false },
    emitterCount: 0,
    meshCount: 20, normalMapCount: 0, defaultPbrCount: 20,
    image: { meanLuma: 0.5, dynamicRange: 0.2, blackPct: 2, whitePct: 12, saturation: 0.05 },
  };
  const f = auditScene(dead);
  const kinds = f.map((x) => x.what).join(" / ");
  check("HDRI 無しを拾う", f.some((x) => x.what.includes("環境マップ")), kinds);
  // ★既定のシーンは空文字ではなく "__procedural_sky__" が入っている。
  //   ここを見落とすと「一番よくある未完成状態」が合格してしまう。
  check("手続き空(sentinel)も HDRI 無しとして拾う",
    auditScene({ envMapPath: PROCEDURAL_SKY }).some((x) => x.what.includes("環境マップ")));
  check("本物の HDRI なら言わない",
    !auditScene({ envMapPath: "textures/hdri/x.hdr" }).some((x) => x.what.includes("環境マップ")));
  check("1 灯だけを拾う", f.some((x) => x.what.includes("補助光")), kinds);
  check("影なしを拾う", f.some((x) => x.what.includes("影を落とす")), kinds);
  check("フォグ無しを拾う", f.some((x) => x.what.includes("空気")), kinds);
  check("ポスト素通しを拾う", f.some((x) => x.what.includes("素通し")), kinds);
  check("動くものゼロを拾う", f.some((x) => x.what.includes("動くもの")), kinds);
  check("法線マップ無しを拾う", f.some((x) => x.what.includes("法線マップ")), kinds);
  check("既定 PBR まみれを拾う", f.some((x) => x.what.includes("既定の PBR")), kinds);
  check("SSAO 無しを拾う", f.some((x) => x.what.includes("SSAO")), kinds);
  check("眠い絵を拾う", f.some((x) => x.what.includes("明暗の幅")), kinds);
  check("白飛びを拾う", f.some((x) => x.what.includes("白飛び")), kinds);
  check("彩度ゼロを拾う", f.some((x) => x.what.includes("彩度")), kinds);

  check("効く順(high が先頭)に並ぶ", f[0].severity === "high", f[0].what);
  check("スコアが落ちる", polishScore(f) < 40, `${polishScore(f)}`);
  check("判定が『土台が欠けている』", verdict(polishScore(f), f).includes("土台"));
}

console.log("[3] 指摘の形");
{
  const f = auditScene({ envMapPath: "", emitterCount: 0, post: {} });
  check("1 つ以上出る", f.length > 0);
  for (const x of f) {
    if (!x.why || x.why.length < 10) check(`${x.what}: why がある`, false, x.why);
    if (!x.fix || !x.fix.includes("dx12_")) check(`${x.what}: fix に実行できるコマンドがある`, false, x.fix);
    if (!CATEGORIES.includes(x.category)) check(`${x.what}: category が既知`, false, x.category);
  }
  console.log("  (上に NG が無ければ全指摘に why と実行できる fix が入っている)");
}

console.log("[4] 読めなかった項目は判定しない");
{
  // 何も渡さなければ何も言わない(「読めなかった」を「無い」と決めつけない)
  check("空の事実では指摘ゼロ", auditScene({}).length === 0);
  // ライトだけ読めた場合、ライトのことしか言わない
  const only = auditScene({ lights: [] });
  check("読めた範囲だけ指摘する", only.length === 1 && only[0].category === "light",
    JSON.stringify(only.map((x) => x.category)));
}

console.log("[5] 二重計上・過検知の境界");
{
  // ゴッドレイ + 濃いフォグは「二重」を言うが、ゴッドレイが弱ければ言わない
  const strong = auditScene({ ...GOOD, post: { ...GOOD.post, godraysOn: true, grIntensity: 0.8 } });
  check("ゴッドレイ×フォグの二重計上を言う", strong.some((x) => x.what.includes("ゴッドレイ")),
    JSON.stringify(strong.map((x) => x.what)));
  const weak = auditScene({ ...GOOD, post: { ...GOOD.post, godraysOn: true, grIntensity: 0.3 } });
  check("弱ければ言わない", !weak.some((x) => x.what.includes("ゴッドレイ")));

  // 屋内(outdoor:false)ならフォグ無しは低優先
  const indoor = auditScene({ ...GOOD, fog: { enabled: false }, outdoor: false });
  const fogFind = indoor.find((x) => x.what.includes("空気"));
  check("屋内のフォグ無しは low", fogFind?.severity === "low", JSON.stringify(fogFind));

  // 法線マップが 1 枚でもあれば言わない
  const someNormal = auditScene({ meshCount: 10, normalMapCount: 1, defaultPbrCount: 0 });
  check("法線マップが 1 枚でもあれば言わない",
    !someNormal.some((x) => x.what.includes("法線マップ")));
}

console.log("[6] 最終画の統計");
{
  const make = (fn: (x: number, y: number) => [number, number, number], w = 64, h = 64): Buffer => {
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const [r, g, b] = fn(x, y);
        png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  };

  const flat = imageFacts(make(() => [128, 128, 128]));
  check("眠い絵は実効レンジがほぼ 0", flat.dynamicRange < 0.05, JSON.stringify(flat));
  check("灰色は彩度 0", flat.saturation < 0.01);

  const ramp = imageFacts(make((x) => { const v = Math.round((x / 63) * 255); return [v, v, v]; }));
  check("黒→白のグラデは実効レンジが広い", ramp.dynamicRange > 0.9, JSON.stringify(ramp));

  // 真っ黒の判定は輝度 0.02 未満(= 8bit で 5 程度)。10 は「暗い」であって「潰れている」ではない
  const blown = imageFacts(make((x) => (x < 32 ? [255, 255, 255] : [3, 3, 3])));
  check("白飛びの割合を数える", Math.abs(blown.whitePct - 50) < 1, `${blown.whitePct}`);
  check("真っ黒の割合を数える", Math.abs(blown.blackPct - 50) < 1, `${blown.blackPct}`);

  const red = imageFacts(make(() => [220, 30, 30]));
  check("彩度を測る", red.saturation > 0.6, `${red.saturation}`);

  // 外れ画素 1 個でレンジが満点にならないこと(上位/下位 1% を落としている)
  const oneDot = imageFacts(make((x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [40, 40, 40])));
  check("外れ画素 1 個ではレンジが伸びない", oneDot.dynamicRange < 0.1, `${oneDot.dynamicRange}`);
}

// ---------------------------------------------------------------------------
console.log("\n[7] エンジンの返り値からの抽出（実際の生 JSON 形状で守る）");
// ★ここが無かったせいで、抽出側のキー名が engine とズレていても
//   auditScene のテストは全部 green のままだった。以下の 2 つのリテラルは
//   **動いているエディタに dx12_list_lights / dx12_get_entity を撃って得た実物**。
//   engine 側が返り値の形を変えたらこのテストが落ちる＝ドリフトを検出できる。
{
  // 実物: dx12_list_lights（影付きポイント 2 灯 + 消灯した平行光）
  const LIST_LIGHTS_REAL = {
    count: 3,
    lights: [
      { type: "directional", name: "TitleAmbient", intensity: 0, effective: true, overBudget: false },
      { type: "point", name: "TitleLight_3", intensity: 0, castShadows: true, effective: false, overBudget: false },
      { type: "point", name: "TitleLight_2", intensity: 7.2, castShadows: true, effective: true, overBudget: false },
    ],
  };
  const lf = lightFactsFrom(LIST_LIGHTS_REAL)!;
  check("ライトを 3 灯とも拾う", lf.length === 3);
  check("castShadows(複数形) を影ありとして読む",
        lf.filter((l) => l.castShadow).length === 2,
        JSON.stringify(lf.map((l) => l.castShadow)));
  check("影を落とすライトがあるので『影が無い』とは言わない",
        !auditScene({ ...GOOD, lights: lf }).some((f) => f.what.includes("影")),
        JSON.stringify(auditScene({ ...GOOD, lights: lf }).map((x) => x.what)));

  // 実物: dx12_get_entity（サブメッシュ 0 に法線マップ、roughness は 0.88 に設定済み）
  const GET_ENTITY_REAL = {
    componentTypes: ["transform", "meshRenderer"],
    entityId: 5,
    material: { metallic: 0, roughness: 0.88 },
    meshRenderer: { modelPath: "models/arch/wall/wall.gltf" },
    bakedTextures: [
      { albedo: true, metalRoughness: false, normal: true },
      { albedo: true, metalRoughness: false, normal: false },
    ],
    name: "TitleWall_Left",
  };
  check("モデル焼き込みの法線マップを見つける", entityHasNormalMap(GET_ENTITY_REAL));
  check("設定済みの roughness を『既定のまま』と誤判定しない", !entityHasDefaultPbr(GET_ENTITY_REAL));

  // エンティティ側オーバーライドでも拾う
  check("materialTextureOverrides の法線も拾う",
        entityHasNormalMap({ materialTextureOverrides: [{ normal: "textures/brick_n.png" }] }));
  check(".dxmat 割り当ても手つかず扱いにしない",
        entityHasNormalMap({ materials: ["materials/brick.dxmat"] }));

  // 本当に手つかずのものは、ちゃんと手つかずと言う（誤検知の逆＝見逃しも防ぐ）
  const UNTOUCHED = { meshRenderer: { modelPath: "__primitive_box__" },
                      material: { metallic: 0, roughness: 0.5 } };
  check("素のプリミティブは『PBR 既定のまま』と言う", entityHasDefaultPbr(UNTOUCHED));
  check("素のプリミティブに法線マップは無い", !entityHasNormalMap(UNTOUCHED));

  // material ブロックそのものが無い場合も既定扱い（get_entity は未設定なら省く）
  check("material が無いものも既定扱い", entityHasDefaultPbr({ meshRenderer: {} }));
  check("空の返り値で落ちない", lightFactsFrom({})?.length === 0 && !entityHasNormalMap(null));
}

console.log(failed === 0 ? "\nOK: polish テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
