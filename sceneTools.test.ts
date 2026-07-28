/**
 * sceneTools.ts（地形 / スカルプト / 診断ツールの引数正規化）の自己テスト。
 *
 * 検証対象:
 *   [1-7]   normalizeStrokePoints — point / points / worldPos の畳み込みと拒否理由
 *   [8-12]  normalizeDiagnoseOnly / fastDiagnoseOnly — 検査 ID の検証と有効値の提示
 *   [13-15] 列挙定数がエンジン側の enum と同じ並びであること（順序がズレると別のブラシになる）
 *   [16-18] zod の $ref 回帰防止 — v3() が毎回新インスタンスを返し、JSON Schema に $ref が出ない
 *   [19-21] nonSettableComponentError — terrain / sculptMesh / gridPlane を「unknown」ではなく
 *           「専用ツールの担当」として弾く（B11）
 *   [22-26] renderDebugModeIssue — dx12_render_debug の mode 検証。非対応の albedo / overdraw を
 *           「理由 + 代わりに見るもの」つきで弾く（AI に無駄撃ちさせない）
 *
 * 実行: node sceneTools.test.ts（Node v24 型ストリップ・エンジン不要）
 */

import assert from "node:assert/strict";
import { z } from "zod";
import {
  DIAG_CHECKS, LIGHTING_PRESETS, RENDER_DEBUG_MODES, RENDER_DEBUG_UNSUPPORTED,
  SCULPT_BRUSHES, SCULPT_PRIMITIVES, TERRAIN_BRUSHES, TERRAIN_PRESETS,
  fastDiagnoseOnly, nonSettableComponentError, normalizeDiagnoseOnly, normalizeStrokePoints,
  renderDebugModeIssue, v2, v3, v4,
} from "./sceneTools.ts";

let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

// ─── [1-7] normalizeStrokePoints ────────────────────────────────────────────
console.log("\n[1-7] normalizeStrokePoints（ストローク点の畳み込み）");
{
  // 1. point:[x,z] は 1 点になる
  assert.deepStrictEqual(normalizeStrokePoints({ point: [3, -4] }), [[3, -4]]);
  pass("point:[x,z] → [[x,z]]");

  // 2. [x,y,z] は y を捨てて [x,z] になる（地形は XZ グリッドなので高さ入力は無意味）
  assert.deepStrictEqual(normalizeStrokePoints({ worldPos: [1, 99, 2] }), [[1, 2]]);
  pass("worldPos:[x,y,z] → y を捨てて [[x,z]]（dx12_pick の worldPos をそのまま渡せる）");

  // 3. points は順序を保つ / [x,z] と [x,y,z] が混ざってもよい
  assert.deepStrictEqual(
    normalizeStrokePoints({ points: [[0, 0], [1, 5, 2], [3, 4]] }),
    [[0, 0], [1, 2], [3, 4]],
  );
  pass("points — 順序保持 & [x,z]/[x,y,z] 混在 OK");

  // 4. points + point を同時に渡したら両方使う（points が先）
  assert.deepStrictEqual(
    normalizeStrokePoints({ points: [[0, 0]], point: [9, 9] }),
    [[0, 0], [9, 9]],
  );
  pass("points + point の併用 — points が先、点は重複しない");

  // 5. 何も指定しなければ「どう指定すればいいか」を hint に入れて弾く
  assert.throws(
    () => normalizeStrokePoints({}),
    (e: any) => e.code === 2 && typeof e.hint === "string" && e.hint.includes("point"),
    "点未指定は code=2 + hint 付きで弾かれること",
  );
  pass("点未指定 → code=2 + 次の一手つき hint");

  // 6. 要素数が違う点は弾く（[x] や [x,y,z,w]）
  assert.throws(() => normalizeStrokePoints({ point: [1] as any }), /\[x,z\]/);
  assert.throws(() => normalizeStrokePoints({ points: [[1, 2, 3, 4]] as any }), /\[x,z\]/);
  pass("要素数不正 → [x,z] / [x,y,z] を要求するエラー");

  // 7. 512 点を超えたら分割を促す（巨大ペイロードでエンジンを詰まらせない）
  const many = Array.from({ length: 513 }, (_, i) => [i, i]);
  assert.throws(
    () => normalizeStrokePoints({ points: many }),
    (e: any) => e.code === 2 && /512/.test(e.message),
    "513 点は上限エラーになること",
  );
  assert.strictEqual(normalizeStrokePoints({ points: many.slice(0, 512) }).length, 512);
  pass("points 上限 512（超過は分割を促す / ちょうど 512 は通る）");
}

// ─── [8-12] normalizeDiagnoseOnly / fastDiagnoseOnly ────────────────────────
console.log("\n[8-12] normalizeDiagnoseOnly（検査 ID の検証）");
{
  // 8. 省略は空文字 = 全検査
  assert.strictEqual(normalizeDiagnoseOnly(undefined), "");
  pass("only 省略 → \"\"（全検査）");

  // 9. 配列でもカンマ区切り文字列でも同じ結果
  assert.strictEqual(normalizeDiagnoseOnly(["lighting", "terrain"]), "lighting,terrain");
  assert.strictEqual(normalizeDiagnoseOnly(" lighting , terrain "), "lighting,terrain");
  pass("配列 / カンマ区切り文字列（空白込み）どちらも同じ結果");

  // 10. 重複は畳む（同じ検査を 2 回走らせない）
  assert.strictEqual(normalizeDiagnoseOnly(["lighting", "lighting"]), "lighting");
  pass("重複 ID は 1 回に畳む");

  // 11. 未知 ID は valid_values 付きで弾く（AI に推測させない）
  assert.throws(
    () => normalizeDiagnoseOnly(["lightning"]),
    (e: any) =>
      e.code === 2 &&
      Array.isArray(e.valid_values) &&
      e.valid_values.includes("lighting") &&
      e.valid_values.length === DIAG_CHECKS.length,
    "未知の検査 ID は有効値一覧つきで弾かれること",
  );
  pass("未知の検査 ID → code=2 + valid_values に全 ID");

  // 12. fast は重い検査(textures/models)だけを外す
  const fast = fastDiagnoseOnly().split(",");
  assert.ok(!fast.includes("textures") && !fast.includes("models"));
  assert.strictEqual(fast.length, DIAG_CHECKS.length - 2);
  assert.ok(fast.includes("lighting") && fast.includes("terrain") && fast.includes("picking"));
  pass("fastDiagnoseOnly — textures/models だけ除外");
}

// ─── [13-15] 列挙定数の並び（エンジンの enum と 1:1）──────────────────────
console.log("\n[13-15] 列挙定数の並び（エンジン側 enum との対応）");
{
  // 13. TerrainBrushType: Raise=0, Lower=1, Smooth=2, Flatten=3, Noise=4（Erode は専用ツール）
  assert.deepStrictEqual([...TERRAIN_BRUSHES], ["raise", "lower", "smooth", "flatten", "noise"]);
  assert.deepStrictEqual([...TERRAIN_PRESETS], ["hills", "canyon", "mountains"]);
  pass("地形ブラシ / プリセットの並びが TerrainBrush.h の enum と一致");

  // 14. SculptBrushType: Draw,Pull,Push,Smooth,Flatten,Pinch,Noise,Grab / SculptPrimitive
  assert.deepStrictEqual([...SCULPT_BRUSHES],
    ["draw", "pull", "push", "smooth", "flatten", "pinch", "noise", "grab"]);
  assert.deepStrictEqual([...SCULPT_PRIMITIVES], ["box", "sphere", "plane", "cylinder"]);
  pass("スカルプトブラシ / 素体の並びが SculptMesh.h の enum と一致");

  // 15. ライティング・プリセットの id は editor/LightingPresets.h と一致
  assert.deepStrictEqual([...LIGHTING_PRESETS],
    ["day", "dusk", "night", "indoor", "horror", "studio"]);
  pass("ライティング・プリセット id が LightingPresets.h と一致");
}

// ─── [16-18] zod $ref 回帰防止 ──────────────────────────────────────────────
console.log("\n[16-18] zod の $ref 回帰防止（vec の使い回し禁止）");
{
  // 16. v3() は呼ぶたびに別インスタンス（使い回すと JSON Schema が $ref に畳まれる）
  assert.notStrictEqual(v3(), v3());
  assert.notStrictEqual(v2(), v2());
  assert.notStrictEqual(v4(), v4());
  pass("v2/v3/v4 — 呼ぶたびに新しい zod インスタンス");

  // 17. 同じ形のフィールドを 3 つ並べても JSON Schema に $ref が出ない
  //     （$ref が出ると一部クライアントで「received string」と誤判定され引数が弾かれる）
  let zodToJsonSchema: any = null;
  try {
    ({ zodToJsonSchema } = await import("zod-to-json-schema"));
  } catch {
    // SDK の依存が変わって解決できない場合はここだけ飛ばす（他の検証は続ける）
  }
  if (zodToJsonSchema) {
    const shape = {
      entity: z.number().int(),
      position: v3().optional(),
      rotation: v3().optional(),
      scale: v3().optional(),
      region: v4().optional(),
    };
    const schema = JSON.stringify(zodToJsonSchema(z.object(shape)));
    assert.ok(!schema.includes("$ref"), "生成された JSON Schema に $ref が含まれないこと");
    pass("v3() を 3 フィールドで使っても JSON Schema に $ref なし");

    // 18. 逆に「使い回すと $ref が出る」ことも確認しておく（この不具合の再発を検知できる根拠）
    const shared = z.array(z.number()).length(3);
    const bad = JSON.stringify(zodToJsonSchema(z.object({
      position: shared.optional(), rotation: shared.optional(),
    })));
    assert.ok(bad.includes("$ref"), "使い回した場合は $ref が出る（この検査自体が有効である証拠）");
    pass("使い回すと $ref が出る — 検査そのものが有効であることの確認");
  } else {
    console.log("  --  zod-to-json-schema を解決できないため $ref 検査はスキップ");
  }
}

// 19-21. set_component で触れないコンポーネント（B11）— 「unknown」ではなく
//        「専用ツールの担当」だと言い切れているか。名前を推測して撃ち直させない。
{
  const t = nonSettableComponentError("terrain")!;
  assert.ok(t, "terrain は set_component 非対応として弾く");
  assert.equal(t.code, 6, "UNKNOWN_COMPONENT(6) を名乗る（エンジンと同じ code）");
  assert.ok(t.hint!.includes("dx12_terrain_sculpt") && t.hint!.includes("dx12_terrain_paint"),
    "代わりに使う専用ツールが hint に並ぶ");
  pass("terrain は理由 + 代替ツール付きで弾かれる");

  for (const key of ["sculptMesh", "sculpt", "gridPlane", "meshRenderer", "skeletalAnimation"]) {
    const e = nonSettableComponentError(key);
    assert.ok(e && e.hint && e.hint.length > 0, `${key} も弾かれ、代替手段が示される`);
  }
  pass("sculptMesh / sculpt / gridPlane / meshRenderer / skeletalAnimation も同様");

  for (const key of ["pointLight", "uiRect", "trigger", "tags", "transform", "", "  ", "unknownThing"]) {
    assert.equal(nonSettableComponentError(key), null, `${key} は素通りしてエンジンへ届く`);
  }
  assert.equal(nonSettableComponentError(undefined), null);
  pass("触れるコンポーネント / 未知の名前は素通り（エンジンの判断を奪わない）");
}

// ─── [22-26] renderDebugModeIssue（dx12_render_debug の mode 検証）───────────
console.log("\n[22-26] renderDebugModeIssue（非対応 mode を理由つきで弾く）");
{
  // 22. 有効な mode は全部素通り（null）
  for (const m of RENDER_DEBUG_MODES) {
    assert.equal(renderDebugModeIssue(m), null, `${m} は有効`);
  }
  // 数は schemaDrift.test.ts [10] が C++ の kEntries[] と集合一致で見張っているので、
  // ここは「増減に気づく」ための固定値。増えたら kEntries[] と突き合わせてから更新すること。
  assert.equal(RENDER_DEBUG_MODES.length, 20, "19 種の可視化(rt / rtDiff を含む) + off");
  assert.ok(RENDER_DEBUG_MODES.includes("rt") && RENDER_DEBUG_MODES.includes("rtDiff"),
    "DXR の rt / rtDiff が enum に入っている(入っていないと zod が新モードを弾く)");
  pass(`有効な mode ${RENDER_DEBUG_MODES.length} 件は素通り（off を含む）`);

  // 23. albedo / overdraw は「非対応」だと言い切り、理由と代替を本文に持つ。
  //     ここが弱いと AI は綴り違いだと解釈して何度も撃ち直す。
  for (const [mode, why] of Object.entries(RENDER_DEBUG_UNSUPPORTED)) {
    const msg = renderDebugModeIssue(mode);
    assert.ok(msg, `${mode} は弾かれる`);
    assert.ok(msg!.includes(mode), "どの mode が駄目かが本文に入る");
    assert.ok(msg!.includes("非対応"), "「間違い」ではなく「非対応」だと言い切る");
    assert.ok(msg!.includes(why.slice(0, 12)), "理由(なぜ作っていないか)が本文に入る");
    assert.ok(msg!.includes("代わりに"), "代わりに何を見ればいいかが本文に入る");
  }
  pass("albedo / overdraw は『非対応 + 理由 + 代替手段』で弾かれる");

  // 24. albedo は前方レンダラであること、overdraw は perf_stats / lightComplexity を案内する
  assert.ok(renderDebugModeIssue("albedo")!.includes("前方レンダラ"));
  assert.ok(renderDebugModeIssue("albedo")!.includes("dx12_screenshot"));
  assert.ok(renderDebugModeIssue("overdraw")!.includes("dx12_perf_stats"));
  assert.ok(renderDebugModeIssue("overdraw")!.includes("lightComplexity"));
  pass("それぞれ具体的な代替ツール名が入っている");

  // 25. 未知の綴りは有効値の一覧つきで弾く（+ 非対応 2 種の存在も知らせる）
  const unknown = renderDebugModeIssue("nromal");
  assert.ok(unknown && unknown.includes("nromal"));
  assert.ok(unknown!.includes("normal") && unknown!.includes("shadowCascade"), "有効値の一覧が出る");
  assert.ok(unknown!.includes("albedo") && unknown!.includes("overdraw"), "非対応 2 種も併せて知らせる");
  pass("未知の mode は有効値一覧つきで弾かれる");

  // 26. 型違い(数値/undefined)は zod の既定メッセージに任せる = null
  assert.equal(renderDebugModeIssue(3), null);
  assert.equal(renderDebugModeIssue(undefined), null);
  assert.equal(renderDebugModeIssue(null), null);
  pass("文字列以外は zod の既定メッセージに委ねる");

  // z.enum の errorMap 経由でも同じ本文が出ること（index.ts の renderDebugModeSchema と同じ組み立て）。
  const modeSchema = z.enum(RENDER_DEBUG_MODES as unknown as [string, ...string[]], {
    errorMap: (issue, ctx) => {
      const msg = renderDebugModeIssue((issue as { received?: unknown }).received);
      return { message: msg ?? ctx.defaultError };
    },
  });
  const r = modeSchema.safeParse("albedo");
  assert.equal(r.success, false);
  assert.ok(!r.success && r.error.issues[0].message.includes("前方レンダラ"),
    "zod のエラー本文がそのまま理由になる（SDK はこの message を -32602 の本文に載せる）");
  assert.ok(modeSchema.safeParse("velocity").success, "有効な mode は通る");
  pass("z.enum + errorMap で理由つきのスキーマ違反になる");

  // $ref 回帰防止の流儀: mode スキーマもファクトリで毎回新インスタンスにする
  const factory = () => z.enum(RENDER_DEBUG_MODES as unknown as [string, ...string[]]);
  assert.notStrictEqual(factory(), factory());
  pass("mode スキーマもファクトリ（インスタンス使い回し禁止の流儀に従う）");
}

console.log(`\nOK: sceneTools テスト ${passed} 件通過`);
process.exit(0);
