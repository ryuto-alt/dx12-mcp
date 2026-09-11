// lookDev.ts の単体テスト(エンジン不要)。
// 守りたいのは 3 つ:
//   1) プリセットが使うフィールド名が【エンジンの名前表】から外れていない
//      (外れると set_post_process が黙って無視して「当てたのに変わらない」になる)
//   2) strength が絵を壊さない(0 に向かって薄めるのではなく、無味無臭の値へ寄せる)
//   3) 併用すると二重になる設定(フォグ×ゴッドレイ)や、効かない設定(ambient×HDRI)を必ず警告する

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOK_IDS, LOOK_PRESETS, LOOK_TAGS,
  blendPost, describeLooks, findLook, resolveLook,
} from "./lookDev.ts";
import { parseFieldMacro, parseTsTools } from "./schemaDrift.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] エンジンの名前表との突き合わせ");
{
  const header = fs.readFileSync(
    path.join(repoRoot, "src", "renderer", "PostProcessSettings.h"), "utf8");
  const postFields = new Set(parseFieldMacro(header, "DX12E_POST_FIELDS"));
  check("DX12E_POST_FIELDS を読めている", postFields.size > 50, `${postFields.size} 件`);

  for (const p of LOOK_PRESETS) {
    for (const key of Object.keys(p.post)) {
      if (!postFields.has(key)) {
        check(`look "${p.id}" の post キー ${key}`, false,
          "PostProcessSettings.h の名前表に無い＝set_post_process に黙って捨てられる");
      }
    }
  }
  console.log("  (上に NG が無ければ全プリセットのキーが実在する)");

  // ★数値だけ書いて <name>On を立て忘れると「設定したのに効かない」になる。
  //   名前表に <key>On がある項目は、使うなら必ずスイッチも一緒に指定していること。
  for (const p of LOOK_PRESETS) {
    for (const key of Object.keys(p.post)) {
      if (key.endsWith("On")) continue;
      const sw = `${key}On`;
      if (postFields.has(sw) && !(sw in p.post)) {
        check(`look "${p.id}": ${key} に対する ${sw}`, false, "スイッチを立てていないので効かない");
      }
    }
  }
  console.log("  (上に NG が無ければスイッチの立て忘れも無い)");

  // フォグのキーは dx12_set_volumetric_fog が宣言しているものだけ使う
  const indexSrc = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const fogTool = parseTsTools(indexSrc).find((t) => t.tool === "dx12_set_volumetric_fog");
  check("dx12_set_volumetric_fog のスキーマを読めている", !!fogTool);
  if (fogTool) {
    const fogKeys = new Set(fogTool.schemaKeys);
    for (const p of LOOK_PRESETS) {
      for (const key of Object.keys(p.fog ?? {})) {
        if (!fogKeys.has(key)) {
          check(`look "${p.id}" の fog キー ${key}`, false, `有効: ${[...fogKeys].join(", ")}`);
        }
      }
    }
    console.log("  (上に NG が無ければフォグのキーも実在する)");
  }
}

console.log("[2] プリセットの健全性");
{
  check("プリセットが 10 個以上ある", LOOK_PRESETS.length >= 10, `${LOOK_PRESETS.length} 個`);
  check("id が重複していない", new Set(LOOK_IDS).size === LOOK_IDS.length);
  check("タグ一覧が空でない", LOOK_TAGS.length >= 5);
  for (const p of LOOK_PRESETS) {
    if (p.notes.length === 0) check(`look "${p.id}" に注意書きがある`, false, "使い方が分からない");
    if (Object.keys(p.post).length < 5) {
      check(`look "${p.id}" のポストが薄すぎない`, false, `${Object.keys(p.post).length} 項目`);
    }
    // トーンマッパーは表示に必須(0=ACES / 1=AgX / 2=なし)なので必ず明示する
    if (!("tonemapper" in p.post)) check(`look "${p.id}" が tonemapper を明示`, false, "");
    if (p.sun?.kelvin !== undefined && (p.sun.kelvin < 1000 || p.sun.kelvin > 40000)) {
      check(`look "${p.id}" の kelvin が範囲内`, false, `${p.sun.kelvin}`);
    }
  }
  console.log("  (上に NG が無ければ全プリセット健全)");
}

console.log("[3] strength の効き方");
{
  const full = resolveLook("neon_noir");
  const half = resolveLook("neon_noir", { strength: 0.5 });
  const zero = resolveLook("neon_noir", { strength: 0 });

  check("strength 1 はプリセットそのまま", full.post.saturation === 1.28);
  check("strength 0.5 は無味無臭の値との中間",
    half.post.saturation === 1.14, `${half.post.saturation}`);
  check("strength 0 は無味無臭の値へ戻る(0 になるのではない)",
    zero.post.saturation === 1 && zero.post.contrast === 1,
    `saturation=${zero.post.saturation} contrast=${zero.post.contrast}`);
  check("strength 0 ではスイッチも切れる", zero.post.bloomOn === false);
  check("strength 1 ならスイッチは入ったまま", full.post.bloomOn === true);
  check("トーンマッパーは薄めない(表示に必須)", zero.post.tonemapper === 1);
  check("色(vec3)はそのまま", JSON.stringify(resolveLook("blue_hour", { strength: 0.4 }).post.tint)
    === JSON.stringify([0.9, 0.96, 1.1]));

  // 直接呼んでも同じ
  const b = blendPost({ contrast: 2.0, contrastOn: true, tonemapper: 1 }, 0.25);
  check("blendPost は中立値から線形に混ぜる", b.contrast === 1.25, `${b.contrast}`);
}

console.log("[4] parts で部分適用");
{
  const postOnly = resolveLook("golden_hour", { parts: ["post"] });
  check("post だけなら太陽もフォグも触らない",
    postOnly.sun === undefined && postOnly.fog === undefined);
  check("post は入っている", Object.keys(postOnly.post).length > 5);

  const sunOnly = resolveLook("golden_hour", { parts: ["sun"] });
  check("sun だけならポストは空", Object.keys(sunOnly.post).length === 0);
  check("sun は入っている", sunOnly.sun?.kelvin === 3200);

  const warned = resolveLook("golden_hour", { parts: ["sun"], strength: 0.5 });
  check("post を外して strength を渡したら『効かない』と言う",
    warned.warnings.some((w) => w.includes("ポストにしか効かない")), JSON.stringify(warned.warnings));
}

console.log("[5] 警告");
{
  const gh = resolveLook("golden_hour");
  check("フォグ×ゴッドレイの二重計上を警告する",
    gh.warnings.some((w) => w.includes("二重")), JSON.stringify(gh.warnings));

  const horror = resolveLook("horror_candle");
  check("環境光ゼロのルックは HDRI の罠を警告する",
    horror.warnings.some((w) => w.includes("envMap")), JSON.stringify(horror.warnings));

  const studio = resolveLook("clean_studio");
  check("素直なルックでは余計な警告を出さない", studio.warnings.length === 0,
    JSON.stringify(studio.warnings));
  check("フォグを明示的に切るルックがある", studio.fog?.enabled === false);

  let threw = false;
  try { resolveLook("nope"); } catch (e: any) {
    threw = e.message.includes("nope") && e.message.includes("golden_hour");
  }
  check("未知の id はエラー + 使える id の一覧", threw);
}

console.log("[6] ライブラリ一覧");
{
  const all = describeLooks();
  check("全件返る", all.length === LOOK_PRESETS.length);
  const dark = describeLooks("dark");
  check("タグで絞れる", dark.length > 0 && dark.every((p: any) => p.tags.includes("dark")));
  check("何を触るルックか分かる",
    (all.find((p: any) => p.id === "horror_candle") as any).touches.includes("sky"));
  check("相性の良い VFX が分かる",
    (all.find((p: any) => p.id === "neon_noir") as any).pairsWith.includes("rain"));
  check("findLook が引ける", findLook("moonlit_night")?.title.includes("月"));
}

console.log(failed === 0 ? "\nOK: lookDev テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
