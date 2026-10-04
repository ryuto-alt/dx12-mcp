// シーンの世代つきバックアップ(scene_backups)がマニフェストのスナップショット・ガイドに載っていること。
//   エンジン不要(同梱の manifest.snapshot.json とガイドの文面だけを見る)。
// 実行: node sceneBackups.test.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 500)}` : ""}`); }
}

const snap = JSON.parse(fs.readFileSync(path.join(here, "manifest.snapshot.json"), "utf8"));
const m = (snap.methods as any[]).find((x) => x.name === "scene_backups");
check("manifest.snapshot.json に scene_backups がある", !!m);
const keys = new Set<string>((m?.params ?? []).map((p: any) => p.key ?? p.name));
for (const k of ["op", "path", "id", "enabled", "generations", "maxMb", "intervalSec"])
  check(`引数 ${k} が載っている`, keys.has(k), [...keys]);
check("op は必須の enum(list|restore|snapshot|settings)", (m?.params ?? []).some((p: any) => (p.key ?? p.name) === "op" && p.required && String(p.enum ?? p.values ?? "").includes("restore")), m?.params);
check("effect は write_scene・editor モード", m?.effect === "write_scene" && m?.mode === "editor", { effect: m?.effect, mode: m?.mode });
check("別名 dx12_scene_backups", (m?.aliases ?? []).includes("dx12_scene_backups"));

const safety = fs.readFileSync(path.join(here, "guides", "safety.md"), "utf8");
check("safety ガイドに「シーンの世代(scene_backups)」の節がある", safety.includes("scene_backups") && safety.includes("objects"));
check("safety ガイドの古い「20 世代」の記述が消えている", !safety.includes("20 世代"));
const doc = fs.readFileSync(path.join(here, "..", "..", "docs", "MCP.md"), "utf8");
check("docs/MCP.md に scene_backups の節がある", doc.includes("`scene_backups`") && doc.includes("objects/<内容ハッシュ>"));

console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
