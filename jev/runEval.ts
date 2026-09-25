// 実 API で質問を評価する CLI。dx12_jev_eval と同じ関数(eval.ts の runEval)を呼ぶ。
//
//   node jev/runEval.ts                         # ケースを持つ質問を全部(キャッシュ使用)
//   node jev/runEval.ts --question finding.intended --cache off --verbose
//   node jev/runEval.ts --json > result.json
//   node jev/runEval.ts --union --mixin other-facts.json   # 品質ゲートと同じ state(全検査の事実入り)で測る
//
// ★鍵は環境変数 TYPESAFE_API_KEY から読むだけで、表示もファイルへの書き出しもしない。
// ★記録とキャッシュは --baseDir(既定: OS temp の dx12-jev-eval)の .dx12/jev/ に置く。
//   費用は最後にその log.jsonl から集計して出す(Jev の請求と突き合わせられるように)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasApiKey } from "./client.ts";
import { loadLibrary, summarizeLog, type CacheMode } from "./library.ts";
import { runEval, summarize, type EvalReport } from "./eval.ts";
import { JEV_RULES } from "./rules.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(a.slice(2), "true");
  else { args.set(a.slice(2), next); i++; }
}
const baseDir = args.get("baseDir") ?? path.join(os.tmpdir(), "dx12-jev-eval");
const cache = (args.get("cache") ?? "use") as CacheMode;
const verbose = args.get("verbose") === "true";
const asJson = args.get("json") === "true";
// --union: 全質問の state 路の和集合で射影する(品質ゲートの bundle:"one" と同じ state)。
// --mixin <file>: 各ケースに足りない facts を足す(他の検査の事実。{facts:{…}} の JSON)。
const union = args.get("union") === "true";
const mixin = args.get("mixin") ? JSON.parse(fs.readFileSync(args.get("mixin")!, "utf8")) : undefined;

if (!hasApiKey() && cache !== "only") {
  console.error("TYPESAFE_API_KEY が無いので全部ルールで答える(実測にならない)。--cache only でキャッシュだけ見ることはできる");
}

const lib = loadLibrary({ baseDir });
const ids = args.get("question")
  ? [args.get("question")!]
  : [...lib.questions.values()].filter((q) => q.casesPath).map((q) => q.id);

const statePaths = union ? [...new Set([...lib.questions.values()].flatMap((q) => q.state))] : undefined;
if (statePaths) console.log(`state の路(和集合): ${statePaths.join(", ")}${mixin ? " / mixin あり" : ""}`);
const reports: EvalReport[] = [];
for (const id of ids) {
  const r = await runEval({ baseDir, cache, library: lib, question: id, rules: JEV_RULES, statePaths, mixin });
  reports.push(r);
  if (asJson) continue;
  const s = summarize(r);
  console.log(`\n■ ${r.question} v${r.version} (${r.type})  ${r.n} 件  正解率 ${r.accuracy}  ルールなら ${r.rulesAccuracy ?? "-"}`);
  if (r.margin) {
    console.log(`  margin ${r.margin.margin}  (yes 群の最小 ${r.margin.yesMin} / no 群の最大 ${r.margin.noMax})`
      + `  推奨閾値 ${r.margin.suggestedThreshold ?? "なし(重なっている → 質問文を直す)"}  現在 ${r.threshold?.yes ?? 0.7}`);
  }
  if (r.mae !== undefined) console.log(`  平均絶対誤差 ${r.mae}`);
  if (r.pass) {
    console.log(`  合否(pass ${r.threshold?.pass}) の正解率 ${r.pass.accuracy}  margin ${r.pass.margin}`
      + ` (合格群の最小 ${r.pass.passMin} / 不合格群の最大 ${r.pass.failMax})  推奨合格線 ${r.pass.suggestedPass ?? "なし"}`);
  }
  if (r.confusion) {
    for (const [exp, row] of Object.entries(r.confusion)) {
      console.log(`  期待 ${exp.padEnd(20)} → ${Object.entries(row).map(([k, v]) => `${k}×${v}`).join(", ")}`);
    }
  }
  console.log(`  出所 ${JSON.stringify(s.sources)}  uncertain ${r.uncertainCount}  自信満々の誤り ${r.confidentWrong.length}`
    + `  $${r.usd}  ${r.inputTokens} tok  最長 ${r.maxMs}ms`);
  for (const c of r.cases) {
    if (!verbose && c.correct) continue;
    const v = typeof c.value === "number" ? c.value.toFixed(3) : c.value;
    const conf = c.confidence !== undefined ? ` conf ${c.confidence.toFixed(2)}` : "";
    console.log(`   ${c.correct ? "○" : "×"} ${c.name.padEnd(38)} 期待 ${JSON.stringify(c.expect).padEnd(34)} 答え ${v}${conf}${c.uncertain ? " (uncertain)" : ""}`);
  }
}

const log = summarizeLog(baseDir);
if (asJson) {
  console.log(JSON.stringify({ reports, log }, null, 2));
} else {
  console.log(`\n累計(${log.file}): リクエスト ${log.requests} 本 / 失敗 ${log.errors} / キャッシュ命中 ${log.cacheHits}`
    + ` / 入力 ${log.inputTokens} tok / $${log.usd}`);
}
