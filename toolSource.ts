// ツール定義のソース(reg(...) / regRaw(...) を書いたテキスト)を返す。
// index.ts は toolset/*.ts への import だけになったので、テキスト解析系のテスト
// (schemaDrift / lookDev / polishJudge など)は index.ts 単体ではなくこれを読む。
// 並びは toolset/all.ts の import 順(= ツールの登録順)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** toolset/all.ts が import している toolset/*.ts の絶対パス(登録順。core は先頭)。 */
export function toolsetFiles(baseDir: string = here): string[] {
  const all = fs.readFileSync(path.join(baseDir, "toolset", "all.ts"), "utf8");
  const out: string[] = ["toolset/core.ts"];
  for (const m of all.matchAll(/^import\s+"\.\/([\w./-]+\.ts)";/gm)) out.push("toolset/" + m[1]);
  return out.map((f) => path.join(baseDir, f));
}

/** index.ts + core + 全モジュール(shell を含む)を連結したテキスト。 */
export function readToolSource(baseDir: string = here): string {
  const parts = [fs.readFileSync(path.join(baseDir, "index.ts"), "utf8")];
  for (const f of toolsetFiles(baseDir)) parts.push(fs.readFileSync(f, "utf8"));
  return parts.join("\n");
}
