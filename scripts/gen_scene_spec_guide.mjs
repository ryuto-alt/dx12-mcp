// guides/scene_spec.md を sceneSpec/guide.template.md と sceneSpec/examples/*.json から生成する(例を書き写して古くなる事故を防ぐ)。
//   使い方: node scripts/gen_scene_spec_guide.mjs [--check]
//   ・--check: 生成結果が現在の guides/scene_spec.md と一致するかだけ確認する(一致しなければ終了コード 1)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const NAMES = [
  ["fps_arena", "FPS のアリーナ(柱の輪・散らした遮蔽物・到達性の検証)"],
  ["room", "部屋(テーブルの上のランプ・左右の椅子・壁に沿った本)"],
  ["garden", "散歩できる庭(木・花・池・ベンチ・飛び石)"],
  ["showcase", "ショーケース(台 + 3 灯 + カメラ)"],
  ["horror_corridor", "ホラー廊下(暗い赤灯・崩れた柱・突き当たりの扉)"],
];

/** 読みやすさと長さのバランス: 最上位のキーは 1 行ずつ、entities は 1 エンティティ 1 行。comment は載せない。 */
function compact(spec) {
  const { comment: _c, entities, ...rest } = spec;
  const lines = ["{"];
  const head = Object.entries(rest).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const ents = (entities ?? []).map((e) => `    ${JSON.stringify(e)}`);
  lines.push([...head, `  "entities": [\n${ents.join(",\n")}\n  ]`].join(",\n"));
  lines.push("}");
  return lines.join("\n");
}

const tpl = fs.readFileSync(path.join(root, "sceneSpec", "guide.template.md"), "utf8");
const blocks = NAMES.map(([n, title]) => {
  const spec = JSON.parse(fs.readFileSync(path.join(root, "sceneSpec", "examples", `${n}.json`), "utf8"));
  return `### ${n} — ${title}\n\`${n}.json\`\n\`\`\`json\n${compact(spec)}\n\`\`\``;
});
const out = tpl.replace("@@EXAMPLES@@", blocks.join("\n\n"));
const dest = path.join(root, "guides", "scene_spec.md");
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : "";
  if (cur.replace(/\r\n/g, "\n") !== out) { console.error("guides/scene_spec.md が古い。node scripts/gen_scene_spec_guide.mjs で再生成する"); process.exit(1); }
  console.log("guides/scene_spec.md は最新");
} else {
  fs.writeFileSync(dest, out, "utf8");
  console.log(`wrote ${dest} (${Buffer.byteLength(out)} bytes)`);
}
