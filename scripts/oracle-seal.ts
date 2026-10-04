// 人が使う封印コマンド(エンジン不要): 「書き換えられない正解」(金画像・性能予算・封印したプレイテスト)の状態表示と封印。
//   node tools/mcp-server/scripts/oracle-seal.ts <projectDir>            封印する(金画像と予算を確認してから)
//   node tools/mcp-server/scripts/oracle-seal.ts <projectDir> --status   状態を表示する(封印は変えない)
// AI が自分で実行してはいけない(正解を書き換えて通す事故を防ぐための承認が封印)。
import fs from "node:fs";
import path from "node:path";
import { ledgerPath, manifestPath, readManifest, verifyLedger, writeLedger } from "../oracles.ts";

const args = process.argv.slice(2);
const status = args.includes("--status");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir || args.includes("--help")) {
  console.log("使い方: node tools/mcp-server/scripts/oracle-seal.ts <projectDir> [--status]\n  既定 = 封印する / --status = 状態だけ表示");
  process.exit(dir ? 0 : 2);
}
const baseDir = path.resolve(dir);
if (!fs.existsSync(baseDir)) { console.error(`プロジェクトが無い: ${baseDir}`); process.exit(2); }

let m;
try { m = readManifest(baseDir); } catch (e: any) { console.error(String(e?.message ?? e)); process.exit(1); }
if (!m) { console.error(`正解が無い(${manifestPath(baseDir)})。先に dx12_oracle {op:"add_view"} などで作る`); process.exit(1); }

const show = () => {
  const s = verifyLedger(baseDir);
  console.log(`views ${m!.views.length} / perf ${m!.perf.length} / playtests ${m!.playtests.length}`);
  console.log(`台帳: ${ledgerPath(baseDir)}`);
  if (!s.sealed) console.log("未封印");
  else {
    console.log(`封印済み(${s.sealedAt})`);
    for (const f of s.changed) console.log(`  変更: ${f}`);
    for (const f of s.missing) console.log(`  消失: ${f}`);
    for (const f of s.extra) console.log(`  未封印の追加: ${f}`);
    if (!s.changed.length && !s.missing.length && !s.extra.length) console.log("  改ざんなし");
  }
  return s;
};
if (status) { const s = show(); process.exit(s.sealed && (s.changed.length || s.missing.length || s.extra.length) ? 1 : 0); }
const r = writeLedger(baseDir);
console.log(`封印した: ${r.files} ファイル(${r.sealedAt})`);
if (r.missingPlaytests.length) console.log(`注意: マニフェストにあるが見つからないプレイテスト: ${r.missingPlaytests.join(", ")}`);
show();
