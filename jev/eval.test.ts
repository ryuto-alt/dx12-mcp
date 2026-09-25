// jev/eval.ts の単体テスト(ネット不要。fetch を差し替え、質問とケースは temp に作る)。
// 守りたいのは: margin の定義(yes 群の最小 − no 群の最大)と推奨閾値(中点、重なっていたら出さない)、
// choice の混同行列と「どれでも正解」の配列、score の平均絶対誤差、ルールとの比較。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCases, marginOf, mixDefaults, runEval, runEvalAll, validateCases } from "./eval.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-eval-"));
const QDIR = path.join(TMP, "q");
fs.mkdirSync(QDIR);
const w = (name: string, o: unknown) => fs.writeFileSync(path.join(QDIR, name), JSON.stringify(o, null, 2));

w("e.noul.jevq.json", { id: "e.noul", version: 2, type: "noul", instructions: "?", state: ["x"],
                        threshold: { yes: 0.7 }, fallback: "no", cases: "e.noul.cases.json" });
w("e.noul.cases.json", { question: "e.noul", cases: [
  { name: "y1", context: { x: "y1" }, expect: true, labelSource: "human" },
  { name: "y2", context: { x: "y2" }, expect: true, labelSource: "claude-draft" },
  { name: "n1", context: { x: "n1" }, expect: false, labelSource: "claude-draft" },
  { name: "n2", context: { x: "n2" }, expect: false, labelSource: "claude-draft" },
] });
w("e.choice.jevq.json", { id: "e.choice", version: 1, type: "choice", instructions: "?", state: ["x"],
                          criteria: { a: "A", b: "B", c: "C" }, fallback: "choice:a", cases: "e.choice.cases.json" });
w("e.choice.cases.json", { question: "e.choice", cases: [
  { name: "ca", context: { x: "ca" }, expect: "a", labelSource: "human" },
  { name: "cb", context: { x: "cb" }, expect: "b", labelSource: "human" },
  { name: "cbc", context: { x: "cbc" }, expect: ["b", "c"], labelSource: "human" },
] });
w("e.score.jevq.json", { id: "e.score", version: 1, type: "score", instructions: "?", state: ["x"],
                         criteria: ["0", "1", "2", "3", "4"], cases: "e.score.cases.json" });
w("e.pass.jevq.json", { id: "e.pass", version: 1, type: "score", instructions: "?", state: ["x"],
                        criteria: ["0", "1", "2", "3", "4"], threshold: { pass: 2.5 }, cases: "e.pass.cases.json" });
w("e.pass.cases.json", { question: "e.pass", cases: [
  { name: "s4", context: { x: "s4" }, expect: 4, labelSource: "human" },
  { name: "s3", context: { x: "s3" }, expect: 3, labelSource: "human" },
  { name: "s0", context: { x: "s0" }, expect: 0, labelSource: "human" },
  { name: "s1", context: { x: "s1" }, expect: 1, labelSource: "human" },
] });
w("e.score.cases.json", { question: "e.score", cases: [
  { name: "s4", context: { x: "s4" }, expect: 4, labelSource: "human" },
  { name: "s0", context: { x: "s0" }, expect: 0, labelSource: "human" },
] });

/** state.x を見て答える偽 Jev。 */
const NOUL: Record<string, number> = { y1: 0.92, y2: 0.75, n1: 0.3, n2: 0.72 };
const CHOICE: Record<string, string> = { ca: "a", cb: "c", cbc: "c" };
const SCORE: Record<string, number> = { s4: 3.6, s0: 1.0, s3: 2.9, s1: 2.2 };
let calls = 0;
const fetch: FetchLike = async (_u, init) => {
  calls++;
  const body = JSON.parse(init.body);
  const x = body.state.x;
  const q = body.questions.q0;
  const ans = q.type === "noul" ? { type: "noul", noul: NOUL[x] }
    : q.type === "choice" ? { type: "choice", choice: CHOICE[x], confidence: 0.8, probabilities: {} }
    : { type: "score", score: SCORE[x], confidence: 0.9 };
  return { ok: true, status: 200, headers: { get: () => null },
           text: async () => JSON.stringify({ model: "m", answers: { q0: ans }, usage: { input_tokens: 100, output_tokens: 5 } }) };
};
const opts = { apiKey: "k", fetch, questionDirs: [QDIR], baseDir: TMP };

console.log("[1] margin の定義");
{
  const m = marginOf([0.92, 0.75], [0.3, 0.6])!;
  check("margin = yes の最小 − no の最大", m.margin === 0.15 && m.yesMin === 0.75 && m.noMax === 0.6, JSON.stringify(m));
  check("推奨閾値は中点", m.suggestedThreshold === 0.675);
  const o = marginOf([0.6, 0.9], [0.7])!;
  check("重なっていれば負で、推奨閾値は出さない(直すのは質問文)", o.margin < 0 && o.suggestedThreshold === null, JSON.stringify(o));
  check("片方の群が空なら測れない", marginOf([0.9], []) === null);
}

console.log("[2] noul の評価");
{
  const r = await runEval({ ...opts, question: "e.noul" });
  check("4 件", r.n === 4 && r.type === "noul" && r.version === 2);
  check("n2(0.72 ≥ 0.7)だけ外す", r.correct === 3 && r.wrong.join() === "n2", JSON.stringify(r.wrong));
  check("n2 は閾値 ±0.1 以内なので uncertain = 自信満々の誤りではない", r.confidentWrong.length === 0, JSON.stringify(r.confidentWrong));
  check("正解率 0.75", r.accuracy === 0.75);
  check("margin = 0.75 − 0.72 = 0.03、推奨 0.735", r.margin?.margin === 0.03 && r.margin?.suggestedThreshold === 0.735, JSON.stringify(r.margin));
  check("ルール(fallback no)の正解率は no 群だけ当たる 0.5", r.rulesAccuracy === 0.5, String(r.rulesAccuracy));
  check("下書きラベルの数を数える", r.draftLabels === 3);
  check("費用を集計", r.requests === 4 && r.inputTokens === 400 && r.usd > 0, JSON.stringify({ req: r.requests, tok: r.inputTokens }));
  check("ケースごとに出所と答えを残す", r.cases.every((c) => c.source === "jev" && typeof c.value === "number"));
}

console.log("[3] choice / score の評価");
{
  const c = await runEval({ ...opts, question: "e.choice" });
  check("配列の expect はどれでも正解(cbc は c で正解)", c.cases.find((x) => x.name === "cbc")?.correct === true);
  check("cb は外す", c.wrong.join() === "cb" && c.accuracy === 0.667, JSON.stringify({ w: c.wrong, a: c.accuracy }));
  check("confidence 0.8 で外した cb は自信満々の誤り", c.confidentWrong.join() === "cb");
  check("混同行列[期待][答え]", c.confusion?.b?.c === 2 && c.confusion?.a?.a === 1, JSON.stringify(c.confusion));
  check("ルール(choice:a)は a だけ当たる", c.rulesAccuracy === 0.333, String(c.rulesAccuracy));
  const s = await runEval({ ...opts, question: "e.score" });
  check("score: 平均絶対誤差 (0.4 + 1.0)/2 = 0.7", s.mae === 0.7, String(s.mae));
  check("score: 最寄りの段で正解判定(3.6→4 は正解、1.0→1 は外れ)", s.correct === 1 && s.wrong.join() === "s0");
  check("ルールの無い質問は rulesAccuracy null", s.rulesAccuracy === null);
  check("pass の無い score は合否を出さない", s.pass === undefined);
}

{
  const p = await runEval({ ...opts, question: "e.pass" });
  // 合格群 {3.6, 2.9} / 不合格群 {1.0, 2.2}: 段の正解率は 3.6→4, 2.9→3, 1.0→1(期待 0 で外れ), 2.2→2(期待 1 で外れ) の 2/4
  check("段の正解率は厳しい(2/4)", p.accuracy === 0.5, String(p.accuracy));
  check("合否の正解率は 4/4", p.pass?.accuracy === 1, JSON.stringify(p.pass));
  check("合否の margin = 合格群の最小 2.9 − 不合格群の最大 2.2", p.pass?.margin === 0.7 && p.pass?.suggestedPass === 2.55, JSON.stringify(p.pass));
}

console.log("[4] キャッシュで 2 回目は無料 / 全部評価");
{
  const before = calls;
  const again = await runEval({ ...opts, question: "e.noul" });
  check("2 回目はネットに出ない", calls === before && again.usd === 0 && again.sources.cache === 4, JSON.stringify(again.sources));
  const all = await runEvalAll({ ...opts, cache: "only" });
  check("ケースを持つ質問を全部回す(組み込み 3 問はケースがあれば含む)", ["e.noul", "e.choice", "e.score"].every((id) => all.some((r) => r.question === id)),
    all.map((r) => r.question).join());
}

console.log("[5] ケースファイルの検査");
{
  check("正しいファイルは通る", validateCases(JSON.parse(fs.readFileSync(path.join(QDIR, "e.noul.cases.json"), "utf8"))).length === 0);
  const errs = validateCases({ question: "x", cases: [
    { name: "a", expect: true, labelSource: "human" },
    { name: "a", context: {}, state: {}, expect: true, labelSource: "me" },
  ] });
  check("context/state 無し・重複名・排他違反・labelSource 違反を全部言う",
    ["context か state", "重複", "排他", "labelSource"].every((k) => errs.some((e) => e.includes(k))), errs.join(" | "));
  const bad = path.join(TMP, "bad.cases.json");
  fs.writeFileSync(bad, JSON.stringify({ question: "x", cases: [] }));
  let threw = false;
  try { loadCases(bad); } catch { threw = true; }
  check("空のケースファイルは読み込みで弾く", threw);
}

console.log("[mixin] 他の検査の事実を足して測る(品質ゲートの和集合 state の再現)");
{
  const base = { brief: { genre: "x" }, facts: { ui: { a: "case" } } };
  const mixed = mixDefaults(base, { facts: { ui: { a: "mixin" }, layout: { b: "mixin" } }, other: 1 }) as any;
  check("足りないキーだけ足す(ケースの facts.ui は上書きしない)", mixed.facts.ui.a === "case" && mixed.facts.layout.b === "mixin" && mixed.other === 1);
  check("元の context は壊さない", !("layout" in base.facts));
  check("mixin が無ければそのまま", mixDefaults(base, undefined) === base);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? "\nOK: jev/eval テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
