// シーンファイル形式 v2 の既定値表の【コピー】を更新する。
//   正本: src/scene/scene_defaults_v2.json（エンジンがビルド時に埋め込む。凍結データ）
//   コピー: tools/mcp-server/scene_defaults_v2.json（publish.ps1 はこのフォルダだけを配布するので、実行時にここから読む）
// 使い方: node scripts/sync_scene_defaults.mjs [--check]   --check は差があれば終了コード 1（書かない）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "..", "src", "scene", "scene_defaults_v2.json");
const dst = path.resolve(here, "..", "scene_defaults_v2.json");
const a = fs.readFileSync(src), b = fs.existsSync(dst) ? fs.readFileSync(dst) : Buffer.alloc(0);
if (a.equals(b)) { console.log("scene_defaults_v2.json: 同期済み"); process.exit(0); }
if (process.argv.includes("--check")) { console.error("scene_defaults_v2.json がエンジン側の正本と違う。node scripts/sync_scene_defaults.mjs で更新する"); process.exit(1); }
fs.copyFileSync(src, dst);
console.log("scene_defaults_v2.json を更新した");
