// materialApply.ts の単体テスト(ネット不要・エンジン不要)。
// 守りたいのは 3 つ:
//   1) ファイル名からの用途推定が Poly Haven / 一般的な PBR パックの命名で当たる
//   2) 推定できなかったファイルを【黙って捨てない】(ignored に理由付きで出る)
//   3) hasOverride の罠(metallic/roughness の上書きが ORM テクスチャを殺す)を自動で外す

import {
  HEIGHT_UNSUPPORTED_REASON, ROLE_TO_SLOT,
  filesDirectlyUnder, guessTextureRole, planPbr, resolveTextureSet,
  tokenizeTextureName, validateScalar, verifyTextureOverrides,
} from "./materialApply.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] ファイル名 → 用途の推定");
{
  const cases: [string, string | null][] = [
    // エンジン同梱のマテリアルライブラリが実際に保存する名前
    // (MaterialLibraryPanel.cpp:346-349 → <id>_diff.jpg / <id>_nor_gl.png / <id>_arm.png)
    ["textures/red_brick_03/red_brick_03_diff.jpg", "baseColor"],
    ["textures/red_brick_03/red_brick_03_nor_gl.png", "normal"],
    ["textures/red_brick_03/red_brick_03_arm.png", "orm"],
    // Poly Haven から直接落とすと解像度が付く
    ["rocky_terrain_02_diff_2k.jpg", "baseColor"],
    ["rocky_terrain_02_nor_gl_4k.png", "normal"],
    ["rocky_terrain_02_arm_2k.png", "orm"],
    ["rocky_terrain_02_disp_2k.png", "height"],
    // 一般的な PBR パックの語彙
    ["Wood_BaseColor.png", "baseColor"],
    ["Wood_Albedo.png", "baseColor"],
    ["Wood_Normal.png", "normal"],
    ["Wood_ORM.png", "orm"],
    ["Wood_RMA.png", "orm"],
    ["Wood_Height.png", "height"],
    ["Wood_Displacement.png", "height"],
    ["metal_plate_metallicRoughness.png", "orm"],
    // 判定できないもの
    ["random_photo.png", null],
    ["wood_ao_2k.png", null],
    ["wood_rough_2k.png", null],
    ["wood_spec.png", null],
  ];
  for (const [file, want] of cases) {
    const g = guessTextureRole(file);
    check(`${file} → ${want ?? "(不明)"}`, g.role === want, `got=${g.role} reason=${g.reason ?? "-"}`);
  }
  check("トークン分割は英数字以外で割る",
    JSON.stringify(tokenizeTextureName("a/b/Red_Brick-03.nor_gl.png"))
    === '["red","brick","03","nor","gl","png"]');
}

console.log("\n[2] 誤爆しにくさ（用途トークンは後ろにある方を採る）");
{
  check("素材名に arm が入っていても末尾の diff を採る",
    guessTextureRole("arm_chair_diff_2k.jpg").role === "baseColor");
  check("素材名に color が入っていても末尾の nor_gl を採る",
    guessTextureRole("color_concrete_nor_gl.png").role === "normal");
  const dx = guessTextureRole("brick_nor_dx_2k.png");
  check("nor_dx は採用せず理由を返す(シェーダが OpenGL 規約)",
    dx.role === null && (dx.reason ?? "").includes("nor_gl"), dx.reason);
  check("nor_gl は普通に法線として採る", guessTextureRole("brick_nor_gl_2k.png").role === "normal");
  const ao = guessTextureRole("brick_ao_2k.png");
  check("AO 単体は「ORM の R として使う」と理由が出る",
    ao.role === null && (ao.reason ?? "").includes("ORM"), ao.reason);
}

console.log("\n[3] ディレクトリ → 4 点セットの解決");
{
  const files = [
    "textures/rock/rock_diff_2k.jpg",
    "textures/rock/rock_nor_gl_2k.png",
    "textures/rock/rock_arm_2k.png",
    "textures/rock/rock_disp_2k.png",
    "textures/rock/rock_ao_2k.png",
    "textures/rock/rock_nor_dx_2k.png",
    "textures/rock/preview.png",
  ];
  const r = resolveTextureSet({ files });
  check("baseColor/normal/orm/height が全部埋まる",
    r.textures.baseColor === "textures/rock/rock_diff_2k.jpg"
    && r.textures.normal === "textures/rock/rock_nor_gl_2k.png"
    && r.textures.orm === "textures/rock/rock_arm_2k.png"
    && r.textures.height === "textures/rock/rock_disp_2k.png",
    JSON.stringify(r.textures));
  check("推定できなかった 3 枚は ignored に理由付きで残る",
    r.ignored.length === 3 && r.ignored.every((i) => i.reason.length > 0),
    JSON.stringify(r.ignored));
  check("ignored に nor_dx / ao / preview が揃っている",
    ["rock_nor_dx_2k.png", "rock_ao_2k.png", "preview.png"]
      .every((n) => r.ignored.some((i) => i.path.endsWith(n))),
    JSON.stringify(r.ignored.map((i) => i.path)));
  check("source で「ディレクトリ推定」と分かる", r.source.baseColor === "dir");
}
{
  // 明示指定が勝ち、負けたディレクトリ側の候補も理由付きで出る
  const r = resolveTextureSet({
    files: ["t/a_diff.jpg", "t/a_arm.png"],
    explicit: { baseColor: "t/override_diff.png" },
  });
  check("明示指定が優先される", r.textures.baseColor === "t/override_diff.png"
    && r.source.baseColor === "explicit");
  check("ディレクトリ側の同用途は ignored へ",
    r.ignored.some((i) => i.path === "t/a_diff.jpg" && i.reason.includes("明示指定")),
    JSON.stringify(r.ignored));
  check("被っていない用途はディレクトリから拾う", r.textures.orm === "t/a_arm.png");
}
{
  // 同じ用途が複数（解像度違い）: 名前順の先頭を採り、残りも理由付きで報告
  const r = resolveTextureSet({ files: ["t/x_diff_1k.jpg", "t/x_diff_4k.jpg"] });
  check("同用途が複数なら名前順の先頭を採用", r.textures.baseColor === "t/x_diff_1k.jpg");
  check("採らなかった方も ignored に出る",
    r.ignored.length === 1 && r.ignored[0].path === "t/x_diff_4k.jpg"
    && r.ignored[0].reason.includes("複数"), JSON.stringify(r.ignored));
}

console.log("\n[4] hasOverride の罠（ORM が無効化される事故）");
{
  const p = planPbr({ hasOrm: true });
  check("ORM を割り当てるならスカラー上書きを -1 に戻す",
    p.call?.metallic === -1 && p.call?.roughness === -1 && p.clearedScalarOverride,
    JSON.stringify(p));
  check("その場合は警告を出さない(自動で正しく処理したので)", p.warnings.length === 0);

  const p2 = planPbr({ hasOrm: true, metallic: 1, roughness: 0.4 });
  check("明示指定は尊重する", p2.call?.metallic === 1 && p2.call?.roughness === 0.4);
  check("ただし ORM が無効化されることを警告する",
    p2.warnings.length === 1 && p2.warnings[0].includes("hasOverride"), JSON.stringify(p2.warnings));
  check("明示指定したので「解除した」とは言わない", p2.clearedScalarOverride === false);

  const p3 = planPbr({ hasOrm: false });
  check("ORM が無いなら metallic/roughness には触らない", p3.call === null, JSON.stringify(p3));

  const p4 = planPbr({ hasOrm: false, uvScale: 4 });
  check("uvScale は U/V 両方へ展開",
    p4.call?.uvScaleU === 4 && p4.call?.uvScaleV === 4
    && p4.call?.metallic === undefined, JSON.stringify(p4));
  const p5 = planPbr({ hasOrm: true, uvScale: 4, uvScaleV: 8 });
  check("uvScaleU/V の個別指定が uvScale より優先",
    p5.call?.uvScaleU === 4 && p5.call?.uvScaleV === 8);

  const p6 = planPbr({ hasOrm: true, metallic: -1, roughness: -1 });
  check("-1 を明示しても解除扱い・警告なし",
    p6.clearedScalarOverride && p6.warnings.length === 0, JSON.stringify(p6));
}

console.log("\n[5] 引数の検証とスロット対応");
{
  check("metallic は 0..1 か -1", validateScalar("metallic", 0.5) === null
    && validateScalar("metallic", -1) === null && validateScalar("metallic", 2) !== null
    && validateScalar("roughness", -0.5) !== null);
  check("未指定は検証を通す", validateScalar("metallic", undefined) === null);
  check("用途 → set_texture の slot 名",
    ROLE_TO_SLOT.baseColor === "albedo" && ROLE_TO_SLOT.normal === "normal"
    && ROLE_TO_SLOT.orm === "metalRoughness" && ROLE_TO_SLOT.height === null);
  check("height を割り当てられない理由が具体的",
    HEIGHT_UNSUPPORTED_REASON.includes("slot") && HEIGHT_UNSUPPORTED_REASON.includes("terrainlayers"));
}

console.log("\n[6] list_assets からディレクトリ直下だけ抜く");
{
  const assets = [
    { path: "textures/rock/rock_diff.jpg" },
    { path: "textures/rock/sub/deep.png" },
    { path: "textures/other/x_diff.jpg" },
    { path: "textures/rockstar/y_diff.jpg" },
  ];
  check("直下のみ・サブディレクトリは見ない",
    JSON.stringify(filesDirectlyUnder("textures/rock", assets)) === '["textures/rock/rock_diff.jpg"]');
  check("末尾スラッシュ / 逆スラッシュを許容",
    filesDirectlyUnder("textures\\rock\\", assets).length === 1);
  check("前方一致で別ディレクトリ(rockstar)を巻き込まない",
    filesDirectlyUnder("textures/rock", assets).every((p) => !p.includes("rockstar")));
}

console.log("\n[7] 適用後の読み返し照合");
{
  const req = { albedo: "t/a.png", normal: "t/n.png", metalRoughness: "t/m.png" };
  check("全部入っていれば不一致なし",
    verifyTextureOverrides(req, { albedo: "t/a.png", normal: "t/n.png", metalRoughness: "t/m.png" }).length === 0);
  const bad = verifyTextureOverrides(req, { albedo: "t/a.png" });
  check("入っていないスロットを不一致として拾う", bad.length === 2, JSON.stringify(bad));
  check("読み返せなかった(null)なら要求分すべて不一致として出す",
    verifyTextureOverrides(req, null).length === 3);
  check("要求していないスロットは見ない",
    verifyTextureOverrides({ albedo: "t/a.png" }, { albedo: "t/a.png", normal: "t/zzz.png" }).length === 0);
}

console.log(failed === 0 ? "\nOK: materialApply テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
