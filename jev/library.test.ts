// jev/library.ts の単体テスト(ネット不要。fetch を差し替え、置き場は temp)。
// 守りたいのは:
//   1) 射影: 質問ごとに要るフィールドだけを state に入れる(入れ子の形は保つ)
//   2) 束ね: 同じ state の質問は 1 リクエスト、違う state は別リクエスト
//   3) キャッシュ: 2 回目はネットに出ない / only は無ければルール / off は毎回撃つ
//   4) フォールバック: 鍵なし・Brief なし・失敗 → 必ずルール(例外を投げない)
//   5) 記録: 1 行 1 リクエスト、state 本文と鍵は書かない
//   6) 閾値の当て方(noul の境界、choice / score の confidence)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ask, askRaw, cacheKey, countCache, interpretAnswer, jevDir, loadLibrary, project, renderQuestion,
  stableStringify, summarizeLog, type QuestionDef,
} from "./library.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const KEY = "apikey_library_test_secret_987654321";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-lib-"));
const QDIR = path.join(TMP, "questions");
fs.mkdirSync(QDIR, { recursive: true });

function writeQ(q: Record<string, unknown>) {
  fs.writeFileSync(path.join(QDIR, `${q.id}.jevq.json`), JSON.stringify(q, null, 2));
}
writeQ({ id: "t.dark", version: 1, type: "noul", instructions: "Is the look dark?", state: ["brief", "facts.look"],
         threshold: { yes: 0.7 }, fallback: "no" });
writeQ({ id: "t.fit", version: 3, type: "score", instructions: "Fit?", criteria: ["bad", "ok", "good"],
         state: ["brief", "facts.look"], threshold: { pass: 1.5 } });
writeQ({ id: "t.fix", version: 1, type: "choice", instructions: "Next fix?", criteria: { fog: "Add fog", keep: "Keep" },
         state: ["brief", "facts.findings"], fallback: "choice:keep" });
writeQ({ id: "t.var", version: 1, type: "noul", instructions: { what: "Is {{code}} ({{gloss}}) intended?" },
         state: ["brief", "facts.look"], fallback: "no",
         lookup: { gloss: { by: "code", map: { NO_FOG: "no fog" } } } });
writeQ({ id: "t.nobrief", version: 1, type: "noul", instructions: "Is it dark?", state: ["facts.look"] });
fs.writeFileSync(path.join(QDIR, "broken.jevq.json"), JSON.stringify({ id: "t.broken", type: "maybe" }));

const CONTEXT = {
  brief: { genre: "ホラー", mood: ["暗い"], secret: "STATE_SENTINEL_文字列" },
  facts: { look: { brightness: "とても暗い" }, findings: [{ code: "NO_FOG" }] },
  unrelated: { huge: "関係ない" },
};

/** 偽 Jev。質問の型に合わせて答え、呼ばれた中身を記録する。 */
function fakeJev(opts: { status?: number; noul?: number; choice?: string; confidence?: number; score?: number } = {}) {
  const calls: { state: any; questions: Record<string, any> }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ state: body.state, questions: body.questions });
    if (opts.status && opts.status !== 200) {
      return { ok: false, status: opts.status, text: async () => "boom", headers: { get: () => null } };
    }
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(body.questions)) {
      if (q.type === "noul") answers[k] = { type: "noul", noul: opts.noul ?? 0.9 };
      if (q.type === "choice") answers[k] = { type: "choice", choice: opts.choice ?? "fog", confidence: opts.confidence ?? 0.9,
                                             probabilities: { fog: 0.9, keep: 0.1 } };
      if (q.type === "score") answers[k] = { type: "score", score: opts.score ?? 1.8, confidence: opts.confidence ?? 0.9,
                                            legend: { 0: "bad" }, probabilities: { 0: 0, 1: 0.2, 2: 0.8 } };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "jev-test", answers,
             usage: { input_tokens: 500, output_tokens: 10 } }), headers: { get: () => null } };
  };
  return { fetch, calls };
}

let dirN = 0;
const freshBase = () => { const d = path.join(TMP, `base${dirN++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const base = (extra: Record<string, unknown> = {}) => ({ apiKey: KEY, questionDirs: [QDIR], ...extra });

console.log("[1] 読み込みと上書き");
{
  const lib = loadLibrary({ questionDirs: [QDIR] });
  check("組み込み 3 問 + テスト用が読める", ["look.brief_fit", "look.next_fix", "finding.intended", "t.dark", "t.fit"]
    .every((id) => lib.questions.has(id)), [...lib.questions.keys()].join(","));
  check("壊れた質問ファイルは読み飛ばして errors に積む", !lib.questions.has("t.broken") && lib.errors.some((e) => e.includes("broken")),
    lib.errors.join(" | "));
  const b = freshBase();
  const pdir = path.join(b, "assets", "jev");
  fs.mkdirSync(pdir, { recursive: true });
  const builtin = loadLibrary({}).questions.get("look.brief_fit")!;
  fs.writeFileSync(path.join(pdir, "look.brief_fit.jevq.json"), JSON.stringify({ ...builtin, version: 99, file: undefined, origin: undefined }));
  const lib2 = loadLibrary({ baseDir: b });
  check("同じ id はプロジェクト(<baseDir>/assets/jev)が勝つ",
    lib2.questions.get("look.brief_fit")?.version === 99 && lib2.questions.get("look.brief_fit")?.origin === "project");
}

console.log("[2] 射影と正規化");
{
  const s = project(CONTEXT, ["brief", "facts.look"]);
  check("要るフィールドだけ入る", JSON.stringify(Object.keys(s)) === JSON.stringify(["brief", "facts"]) && !("unrelated" in s));
  check("入れ子の形を保つ(facts.look → {facts:{look}})", (s as any).facts?.look?.brightness === "とても暗い"
    && (s as any).facts?.findings === undefined);
  check("無いパスは入れない", JSON.stringify(project({}, ["brief"])) === "{}");
  check("キー順が違っても同じ文字列", stableStringify({ a: 1, b: { d: 2, c: 3 } }) === stableStringify({ b: { c: 3, d: 2 }, a: 1 }));
  check("undefined のキーは消す", stableStringify({ a: 1, b: undefined }) === stableStringify({ a: 1 }));
}

console.log("[3] 同じ state は 1 リクエストに束ね、違う state は別リクエスト");
{
  const j = fakeJev();
  const out = await ask(["t.dark", "t.fit", "t.fix"], CONTEXT, base({ fetch: j.fetch, baseDir: freshBase() }));
  check("リクエストは 2 本(brief+look と brief+findings)", j.calls.length === 2, String(j.calls.length));
  const big = j.calls.find((c) => Object.keys(c.questions).length === 2);
  check("t.dark と t.fit が 1 本に束ねられる", !!big, JSON.stringify(j.calls.map((c) => Object.keys(c.questions))));
  check("送るキーは q0, q1(id の記号を避ける)", !!big && JSON.stringify(Object.keys(big.questions)) === '["q0","q1"]');
  check("関係ないフィールドは送らない", j.calls.every((c) => !JSON.stringify(c.state).includes("関係ない")));
  check("結果は refs の順", out.results.map((r) => r.id).join() === "t.dark,t.fit,t.fix", out.results.map((r) => r.id).join());
  check("全部 source=jev", out.results.every((r) => r.source === "jev"), JSON.stringify(out.results.map((r) => r.source)));
  check("usd と tokens を集計", out.inputTokens === 1000 && Math.abs(out.usd - 1000 * 0.042e-6) < 1e-12, JSON.stringify(out));
  check("noul 0.9 → decided true", out.results[0].decided === true && out.results[0].value === 0.9);
  check("score 1.8 ≥ pass 1.5 → pass", out.results[1].decided === "pass");
  check("choice → 選択肢", out.results[2].decided === "fog" && out.results[2].confidence === 0.9);
}

console.log("[4] キャッシュ");
{
  const b = freshBase();
  const j = fakeJev();
  await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b }));
  const again = await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b }));
  check("2 回目はネットに出ない", j.calls.length === 1, String(j.calls.length));
  check("source=cache で同じ値", again.results[0].source === "cache" && again.results[0].value === 0.9);
  check("キャッシュは <baseDir>/.dx12/jev/cache", countCache(b) === 1 && fs.existsSync(path.join(b, ".dx12", "jev", "cache")));
  const changed = await ask(["t.dark"], { ...CONTEXT, facts: { look: { brightness: "明るい" } } }, base({ fetch: j.fetch, baseDir: b }));
  check("state が変われば撃ち直す", j.calls.length === 2 && changed.results[0].source === "jev");

  const only = await ask(["t.fit"], CONTEXT, base({ fetch: j.fetch, baseDir: b, cache: "only" }));
  check("only: 無ければネットに出ずルールへ", j.calls.length === 2 && only.results[0].source === "rules", JSON.stringify(only.results[0]));
  const onlyHit = await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b, cache: "only" }));
  check("only: あればキャッシュを返す", onlyHit.results[0].source === "cache");

  const b2 = freshBase();
  await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b2, cache: "off" }));
  await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b2, cache: "off" }));
  check("off: 毎回撃つ", j.calls.length === 4, String(j.calls.length));
  check("off: キャッシュを書かない", countCache(b2) === 0);

  const def = loadLibrary({ questionDirs: [QDIR] }).questions.get("t.dark")!;
  const q = { type: "noul" as const, instructions: "Is the look dark?" };
  const k1 = cacheKey("t.dark", 1, "jev-latest", q, "{}");
  check("キーは版で変わる", k1 !== cacheKey("t.dark", 2, "jev-latest", q, "{}"));
  check("キーは質問文で変わる(版を上げ忘れても古い答えを返さない)",
    k1 !== cacheKey("t.dark", 1, "jev-latest", { ...q, instructions: "Is it bright?" }, "{}"));
  check("キーはモデルで変わる", k1 !== cacheKey("t.dark", 1, "jev-2", q, "{}"));
  check("def は読めている", def.version === 1);
}

console.log("[5] フォールバック(例外を投げない)");
{
  const j = fakeJev();
  // 環境変数に本物の鍵があっても拾わないよう、一時的に外して確かめる(このテストはネットに出ない)。
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const noKey2 = await ask(["t.dark", "t.fit", "t.fix"], CONTEXT, { questionDirs: [QDIR], baseDir: freshBase(), fetch: j.fetch });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし: ネットに出ない", noKey2.results.every((r) => r.source === "rules") && j.calls.length === 0,
    JSON.stringify(noKey2.results.map((r) => r.source)));
  const explicitNone = await ask(["t.dark"], CONTEXT, { questionDirs: [QDIR], baseDir: freshBase(), fetch: j.fetch, apiKey: "" });
  check("apiKey:\"\" は環境変数があっても「鍵なし」", explicitNone.results[0].source === "rules" && j.calls.length === 0);
  check("鍵なし: fallback \"no\" → decided false", noKey2.results[0].decided === false && noKey2.results[0].value === 0);
  check("鍵なし: fallback \"choice:keep\"", noKey2.results[2].value === "keep");
  check("鍵なし: 規則の無い質問は value null + uncertain", noKey2.results[1].value === null && noKey2.results[1].uncertain === true);
  check("鍵なし: 理由を言う", (noKey2.results[0].reason ?? "").includes("TYPESAFE_API_KEY"));

  const j2 = fakeJev();
  const noBrief = await ask(["t.dark", "t.nobrief"], { facts: CONTEXT.facts }, base({ fetch: j2.fetch, baseDir: freshBase() }));
  check("Brief なし: Brief 依存の質問はルールへ + briefMissing", noBrief.results[0].source === "rules"
    && noBrief.results[0].briefMissing === true && noBrief.briefMissing === true);
  check("Brief なし: Brief に依存しない質問は聞く", noBrief.results[1].source === "jev" && j2.calls.length === 1);
  const emptyBrief = await ask(["t.dark"], { brief: { title: "", mood: [] }, facts: CONTEXT.facts }, base({ fetch: j2.fetch, baseDir: freshBase() }));
  check("中身の無い Brief も「無い」扱い", emptyBrief.results[0].briefMissing === true);

  const j3 = fakeJev({ status: 500 });
  const failedReq = await ask(["t.dark", "t.fit"], CONTEXT, base({ fetch: j3.fetch, baseDir: freshBase() }));
  check("失敗: 規則があれば rules + error", failedReq.results[0].source === "rules" && !!failedReq.results[0].error);
  check("失敗: 規則が無ければ source=error", failedReq.results[1].source === "error" && failedReq.results[1].value === null);
  check("失敗: requests に error で残る", failedReq.requests[0]?.source === "error");

  const missing = await ask(["no.such"], CONTEXT, base({ fetch: j.fetch }));
  check("知らない質問は error 結果(例外にしない)", missing.results[0].source === "error" && (missing.results[0].error ?? "").includes("no.such"));
}

console.log("[6] 質問文の変数");
{
  const def = loadLibrary({ questionDirs: [QDIR] }).questions.get("t.var")!;
  const r = renderQuestion(def, { code: "NO_FOG" });
  check("{{code}} と lookup の {{gloss}} が埋まる", r.ok && JSON.stringify(r.question).includes("NO_FOG (no fog)"), JSON.stringify(r));
  const miss = renderQuestion(def, {});
  check("埋まらない変数はエラー(黙って {{code}} を送らない)", !miss.ok && miss.error.includes("code"));
  const unknown = renderQuestion(def, { code: "NO_SUCH" });
  check("表に無い値もエラー", !unknown.ok && unknown.error.includes("NO_SUCH"));
  const j = fakeJev();
  const out = await ask([{ id: "t.var", vars: { code: "NO_FOG" } }, { id: "t.var", vars: { code: "NO_FOG" } }, "t.var"], CONTEXT,
    base({ fetch: j.fetch, baseDir: freshBase() }));
  check("インスタンス id は id#値", out.results[0].id === "t.var#NO_FOG");
  check("変数の無い参照はエラー結果", out.results[2].source === "error");
}

console.log("[7] 記録(1 行 1 リクエスト、state 本文と鍵は書かない)");
{
  const b = freshBase();
  const j = fakeJev();
  await ask(["t.dark", "t.fit", "t.fix"], CONTEXT, base({ fetch: j.fetch, baseDir: b }));
  await ask(["t.dark"], CONTEXT, base({ fetch: j.fetch, baseDir: b }));   // キャッシュ命中
  const logText = fs.readFileSync(path.join(jevDir(b), "log.jsonl"), "utf8");
  const lines = logText.trim().split("\n").map((l) => JSON.parse(l));
  check("ネットの 2 本 + キャッシュ 1 行", lines.filter((l) => l.source === "jev").length === 2
    && lines.filter((l) => l.source === "cache").length === 1, logText);
  const first = lines.find((l) => l.source === "jev" && l.ids.length === 2)!;
  check("id・版・ms・tokens・usd が入る", !!first && first.versions["t.fit"] === 3 && first.inputTokens === 500
    && typeof first.ms === "number" && first.usd > 0, JSON.stringify(first));
  check("state 本文を書かない", !logText.includes("STATE_SENTINEL") && !logText.includes("とても暗い"));
  check("鍵を書かない", !logText.includes(KEY));
  const sum = summarizeLog(b);
  check("summarizeLog: requests 2 / cacheHits 1 / tokens 1000", sum.requests === 2 && sum.cacheHits === 1 && sum.inputTokens === 1000,
    JSON.stringify(sum));
  check("baseDir 不明なら OS temp 配下", jevDir(null).startsWith(os.tmpdir()));
}

console.log("[8] 閾値の当て方");
{
  const noul = { id: "x", version: 1, type: "noul", instructions: "", state: ["a"], threshold: { yes: 0.7 } } as QuestionDef;
  const a = interpretAnswer(noul, { type: "noul", noul: 0.71 }) as any;
  check("0.71 は yes だが境界付近で uncertain", a.decided === true && a.uncertain === true);
  const b = interpretAnswer(noul, { type: "noul", noul: 0.95 }) as any;
  check("0.95 は yes で確信", b.decided === true && b.uncertain === false);
  const c = interpretAnswer(noul, { type: "noul", noul: 0.2 }) as any;
  check("0.2 は no で確信", c.decided === false && c.uncertain === false);
  const d = interpretAnswer({ ...noul, threshold: undefined }, { type: "noul", noul: 0.6 }) as any;
  check("既定の閾値は 0.7(0.5 ではない)", d.decided === false);
  const ch = { id: "c", version: 1, type: "choice", instructions: "", criteria: { a: "", b: "" }, state: ["a"] } as QuestionDef;
  check("choice: confidence 0.3 は uncertain", (interpretAnswer(ch, { type: "choice", choice: "a", confidence: 0.3, probabilities: {} }) as any).uncertain === true);
  check("choice: 選択肢に無い答えはエラー", "error" in interpretAnswer(ch, { type: "choice", choice: "zzz", confidence: 1, probabilities: {} }));
  const sc = { id: "s", version: 1, type: "score", instructions: "", criteria: ["a", "b", "c"], state: ["a"], threshold: { pass: 1.5 } } as QuestionDef;
  const s1 = interpretAnswer(sc, { type: "score", score: 1.6, confidence: 0.9 }) as any;
  check("score: 合格線の近くは uncertain", s1.decided === "pass" && s1.uncertain === true);
  const s2 = interpretAnswer({ ...sc, threshold: undefined }, { type: "score", score: 1.6, confidence: 0.9 }) as any;
  check("score: pass が無ければ最寄りの段", s2.decided === 2);
  check("型が違う答えはエラー", "error" in interpretAnswer(noul, { type: "choice", choice: "a", confidence: 1, probabilities: {} }));
}

console.log("[9] アドホックな直接質問(raw)");
{
  const j = fakeJev();
  const out = await askRaw({ foo: "bar" }, { q1: { type: "noul", instructions: "ok?" }, q2: { type: "choice", instructions: "x", criteria: { fog: "", keep: "" } } },
    { apiKey: KEY, fetch: j.fetch, baseDir: freshBase() });
  check("1 リクエストで 2 問", j.calls.length === 1 && Object.keys(j.calls[0].questions).length === 2);
  check("state はそのまま", JSON.stringify(j.calls[0].state) === '{"foo":"bar"}');
  check("id は渡したキー", out.results.map((r) => r.id).join() === "q1,q2");
  const bad = await askRaw({}, { q: { type: "maybe", instructions: "?" } as any }, { apiKey: KEY, fetch: j.fetch, baseDir: freshBase() });
  check("壊れた質問はエラー結果", bad.results[0].source === "error");
}

console.log("[10] stateUnion: 違う state 路の質問を和集合で射影して 1 リクエストに束ねる(品質ゲート用)");
{
  const j = fakeJev();
  await ask(["t.dark", "t.fix"], CONTEXT, base({ fetch: j.fetch, baseDir: freshBase(), cache: "off" }));
  check("既定は質問ごとの射影 = 2 リクエスト", j.calls.length === 2);
  const u = fakeJev();
  await ask(["t.dark", "t.fix"], CONTEXT, base({ fetch: u.fetch, baseDir: freshBase(), cache: "off", stateUnion: true }));
  check("stateUnion なら 1 リクエスト", u.calls.length === 1 && Object.keys(u.calls[0].questions).length === 2);
  check("state は和集合(brief + facts.look + facts.findings)で、関係ない unrelated は入らない",
    JSON.stringify(Object.keys(u.calls[0].state.facts).sort()) === '["findings","look"]' && !("unrelated" in u.calls[0].state));
  const nb = fakeJev();
  const r = await ask(["t.dark", "t.fix"], { ...CONTEXT, brief: null }, base({ fetch: nb.fetch, baseDir: freshBase(), cache: "off", stateUnion: true }));
  check("stateUnion でも Brief が無ければ聞かない", nb.calls.length === 0 && r.briefMissing === true);
  const sp = fakeJev();
  await ask(["t.dark"], CONTEXT, base({ fetch: sp.fetch, baseDir: freshBase(), cache: "off", statePaths: ["brief", "facts.findings", "unrelated"] }));
  check("statePaths は質問の state 路より優先(評価で品質ゲートの state を再現する用)",
    JSON.stringify(Object.keys(sp.calls[0].state).sort()) === '["brief","facts","unrelated"]' && !("look" in sp.calls[0].state.facts));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed === 0 ? "\nOK: jev/library テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
