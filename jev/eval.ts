// 質問の評価。ラベル付きのケースを流して「その質問文で判断が分かれるか」を測る。
//
// ★見るのは正解率だけではない。noul は margin = (yes 群の最小) − (no 群の最大)。
//   margin が負 = 分布が重なっている = 閾値をどこに置いても必ずどれかを外す。
//   そのときに直すのは閾値ではなく【質問文】(bot3 のルータで実証済みの見方)。
//   margin が正なら、閾値は境界の中点(suggestedThreshold)に置く。
//
// ★ケースのラベルには出所(labelSource)を付ける。"claude-draft" は下書きで、人が見直すまでは
//   「Jev が外した」のか「ラベルが間違っている」のか区別できない。報告にもそのまま出す。

import fs from "node:fs";
import path from "node:path";
import { ask, loadLibrary, type AskOptions, type JevResult, type Library, type QuestionDef } from "./library.ts";

export type EvalCase = {
  name: string;
  /** 質問ファイルの state 路で射影する元。state と排他。 */
  context?: unknown;
  /** 射影せずそのまま送る state。 */
  state?: unknown;
  /** 質問文の {{var}}(finding.intended の code など)。 */
  vars?: Record<string, string>;
  /** noul: true/false、choice: 選択肢(配列なら「どれでも正解」)、score: 期待する段(0 始まり)。 */
  expect: boolean | string | string[] | number;
  labelSource: "human" | "claude-draft";
  note?: string;
};

export type CasesFile = { question: string; cases: EvalCase[] };

export function validateCases(c: any): string[] {
  const errs: string[] = [];
  if (!c || typeof c !== "object") return ["JSON オブジェクトでない"];
  if (typeof c.question !== "string") errs.push("question が無い");
  if (!Array.isArray(c.cases) || c.cases.length === 0) { errs.push("cases が空"); return errs; }
  const names = new Set<string>();
  c.cases.forEach((k: any, i: number) => {
    const at = `cases[${i}]${k?.name ? `(${k.name})` : ""}`;
    if (typeof k?.name !== "string" || !k.name) errs.push(`${at}: name が無い`);
    else if (names.has(k.name)) errs.push(`${at}: name が重複`);
    else names.add(k.name);
    if (k?.context === undefined && k?.state === undefined) errs.push(`${at}: context か state が要る`);
    if (k?.context !== undefined && k?.state !== undefined) errs.push(`${at}: context と state は排他`);
    if (k?.expect === undefined) errs.push(`${at}: expect が無い`);
    if (k?.labelSource !== "human" && k?.labelSource !== "claude-draft") errs.push(`${at}: labelSource は human / claude-draft`);
  });
  return errs;
}

export function loadCases(file: string): CasesFile {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const errs = validateCases(c);
  if (errs.length) throw new Error(`${file}: ${errs.join(" / ")}`);
  return c as CasesFile;
}

/** noul の分離具合。どちらかの群が空なら測れない(null)。 */
export function marginOf(yesValues: number[], noValues: number[]) {
  if (!yesValues.length || !noValues.length) return null;
  const yesMin = Math.min(...yesValues);
  const noMax = Math.max(...noValues);
  const margin = yesMin - noMax;
  return {
    yesMin: r3(yesMin), noMax: r3(noMax), margin: r3(margin),
    /** 完全に分離しているときだけ意味のある「真ん中」。重なっていたら閾値ではなく質問文を直す。 */
    suggestedThreshold: margin > 0 ? r3((yesMin + noMax) / 2) : null,
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function isCorrect(def: QuestionDef, c: EvalCase, r: JevResult): boolean {
  if (r.value === null || r.value === undefined) return false;
  if (def.type === "noul") return typeof c.expect === "boolean" && r.decided === c.expect;
  if (def.type === "choice") {
    const ok = Array.isArray(c.expect) ? c.expect : [c.expect];
    return ok.includes(r.value as string);
  }
  return typeof c.expect === "number" && Math.round(Number(r.value)) === c.expect;
}

/** 同時実行を絞る(公式上限は 1,200 req/分。評価で一気に撃って 429 を食らうより少し待つ方が速い)。 */
async function pooled<T, R>(items: T[], size: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

export type EvalOptions = AskOptions & {
  /** 質問 id。省略時は casesPath の question。 */
  question?: string;
  casesPath?: string;
  concurrency?: number;
  /**
   * 各ケースの context に「足りないキーだけ」足す材料({facts:{…}})。statePaths と組み合わせて、
   * 品質ゲートのように他の検査の事実も state に入った状態で精度が落ちないかを測る。
   */
  mixin?: Record<string, unknown>;
};

/** base に無いキーだけ extra から足す(2 段目まで。facts.ui があるケースに facts.layout を足す用)。 */
export function mixDefaults(base: unknown, extra: Record<string, unknown> | undefined): unknown {
  if (!extra || !base || typeof base !== "object") return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) {
    if (out[k] === undefined) out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      const inner: Record<string, unknown> = { ...(out[k] as Record<string, unknown>) };
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (inner[k2] === undefined) inner[k2] = v2;
      out[k] = inner;
    }
  }
  return out;
}

export type CaseOutcome = {
  name: string;
  expect: EvalCase["expect"];
  value: number | string | null;
  decided?: unknown;
  confidence?: number;
  correct: boolean;
  source: JevResult["source"];
  uncertain?: boolean;
  labelSource: EvalCase["labelSource"];
  rulesValue?: number | string | null;
  rulesCorrect?: boolean;
  note?: string;
  error?: string;
};

export type EvalReport = {
  question: string;
  version: number | string;
  type: QuestionDef["type"];
  casesPath: string;
  n: number;
  correct: number;
  accuracy: number;
  threshold: QuestionDef["threshold"];
  /** noul のみ。 */
  margin?: ReturnType<typeof marginOf>;
  /** choice のみ。confusion[期待][答え] = 件数(期待が配列なら先頭を行に使う)。 */
  confusion?: Record<string, Record<string, number>>;
  /** score のみ。|答え − 期待| の平均。 */
  mae?: number;
  /**
   * score で threshold.pass があるときだけ。判断段が実際に使うのは段の番号ではなく pass/fail なので、
   * 「期待 ≥ pass の群の最小 − 期待 < pass の群の最大」を noul の margin と同じ見方で出す。
   */
  pass?: { accuracy: number; passMin: number; failMax: number; margin: number; suggestedPass: number | null } | null;
  /** 同じケースをルール(fallback)で答えた場合の正解率。Jev を使う意味があるかの比較対象。 */
  rulesAccuracy?: number | null;
  sources: Record<string, number>;
  uncertainCount: number;
  wrong: string[];
  /**
   * 外したのに uncertain でなかったケース。判断段は uncertain を Claude に上げるので、
   * 外れても uncertain なら実害は小さい。自動で直してしまう「自信満々の誤り」はこちらで数える。
   */
  confidentWrong: string[];
  usd: number;
  inputTokens: number;
  requests: number;
  maxMs: number;
  draftLabels: number;
  cases: CaseOutcome[];
};

/** 1 質問ぶんの評価。例外はケースファイルが読めないときだけ。 */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const lib: Library = opts.library ?? loadLibrary({ baseDir: opts.baseDir, questionDirs: opts.questionDirs });
  let casesPath = opts.casesPath;
  let qid = opts.question;
  if (!casesPath) {
    const d = qid ? lib.questions.get(qid) : undefined;
    if (!d) throw new Error(`質問 ${qid ?? "(未指定)"} が見つからない`);
    if (!d.casesPath) throw new Error(`${qid} の質問ファイルに cases が無い`);
    casesPath = d.casesPath;
  }
  const file = loadCases(casesPath);
  qid = qid ?? file.question;
  const def = lib.questions.get(qid);
  if (!def) throw new Error(`質問 ${qid} が見つからない(${lib.dirs.join(" / ")})`);

  let usd = 0, inputTokens = 0, requests = 0, maxMs = 0;
  const outcomes = await pooled(file.cases, opts.concurrency ?? 6, async (c) => {
    const ref = { id: qid!, vars: c.vars };
    const common = { ...opts, library: lib, ...(c.state !== undefined ? { stateOverride: c.state } : {}) };
    const context = mixDefaults(c.context ?? {}, opts.mixin);
    const out = await ask([ref], context, common);
    usd += out.usd; inputTokens += out.inputTokens; requests += out.requests.length; maxMs = Math.max(maxMs, out.ms);
    const r = out.results[0];
    // ルールならどう答えたか(ネットにもキャッシュにも行かない)。
    const rules = await ask([ref], context, { ...common, apiKey: undefined, cache: "off", log: false,
                                                     fetch: undefined, forceRules: true } as AskOptions);
    const rr = rules.results[0];
    const oc: CaseOutcome = {
      name: c.name, expect: c.expect, value: r.value, decided: r.decided, confidence: r.confidence,
      correct: isCorrect(def, c, r), source: r.source, uncertain: r.uncertain, labelSource: c.labelSource,
      rulesValue: rr.value, rulesCorrect: rr.value === null ? undefined : isCorrect(def, c, rr),
      ...(c.note ? { note: c.note } : {}), ...(r.error ? { error: r.error } : {}),
    };
    return oc;
  });

  const correct = outcomes.filter((o) => o.correct).length;
  const report: EvalReport = {
    question: qid, version: def.version, type: def.type, casesPath, n: outcomes.length, correct,
    accuracy: r3(correct / Math.max(1, outcomes.length)),
    threshold: def.threshold,
    sources: outcomes.reduce<Record<string, number>>((a, o) => { a[o.source] = (a[o.source] ?? 0) + 1; return a; }, {}),
    uncertainCount: outcomes.filter((o) => o.uncertain).length,
    wrong: outcomes.filter((o) => !o.correct).map((o) => o.name),
    confidentWrong: outcomes.filter((o) => !o.correct && !o.uncertain).map((o) => o.name),
    usd: Number(usd.toFixed(8)), inputTokens, requests, maxMs,
    draftLabels: file.cases.filter((c) => c.labelSource === "claude-draft").length,
    cases: outcomes,
  };
  const ruled = outcomes.filter((o) => o.rulesCorrect !== undefined);
  report.rulesAccuracy = ruled.length ? r3(ruled.filter((o) => o.rulesCorrect).length / ruled.length) : null;

  if (def.type === "noul") {
    const num = (o: CaseOutcome) => typeof o.value === "number";
    report.margin = marginOf(
      outcomes.filter((o) => o.expect === true && num(o)).map((o) => o.value as number),
      outcomes.filter((o) => o.expect === false && num(o)).map((o) => o.value as number),
    );
  } else if (def.type === "choice") {
    const m: Record<string, Record<string, number>> = {};
    for (const o of outcomes) {
      const row = String(Array.isArray(o.expect) ? o.expect[0] : o.expect);
      const col = String(o.value);
      m[row] ??= {};
      m[row][col] = (m[row][col] ?? 0) + 1;
    }
    report.confusion = m;
  } else {
    const errs = outcomes.filter((o) => typeof o.value === "number" && typeof o.expect === "number")
      .map((o) => Math.abs((o.value as number) - (o.expect as number)));
    report.mae = errs.length ? r3(errs.reduce((a, b) => a + b, 0) / errs.length) : undefined;
    const pass = def.threshold?.pass;
    if (typeof pass === "number") {
      const scored = outcomes.filter((o) => typeof o.value === "number" && typeof o.expect === "number");
      const hi = scored.filter((o) => (o.expect as number) >= pass).map((o) => o.value as number);
      const lo = scored.filter((o) => (o.expect as number) < pass).map((o) => o.value as number);
      const ok = scored.filter((o) => ((o.value as number) >= pass) === ((o.expect as number) >= pass)).length;
      const m = marginOf(hi, lo);
      report.pass = m ? { accuracy: r3(ok / scored.length), passMin: m.yesMin, failMax: m.noMax, margin: m.margin,
                          suggestedPass: m.suggestedThreshold } : null;
    }
  }
  return report;
}

/** ケースを持つ質問を全部評価する。 */
export async function runEvalAll(opts: AskOptions & { concurrency?: number } = {}): Promise<EvalReport[]> {
  const lib = opts.library ?? loadLibrary({ baseDir: opts.baseDir, questionDirs: opts.questionDirs });
  const out: EvalReport[] = [];
  for (const def of lib.questions.values()) {
    if (!def.casesPath || !fs.existsSync(def.casesPath)) continue;
    out.push(await runEval({ ...opts, library: lib, question: def.id }));
  }
  return out;
}

/** 評価結果の短い要約(MCP の返り値と CLI の表示に使う)。ケースごとの詳細は落とす。 */
export function summarize(r: EvalReport) {
  return {
    question: r.question, version: r.version, type: r.type, n: r.n,
    accuracy: r.accuracy, rulesAccuracy: r.rulesAccuracy,
    ...(r.margin !== undefined ? { margin: r.margin } : {}),
    ...(r.mae !== undefined ? { mae: r.mae } : {}),
    ...(r.pass ? { pass: r.pass } : {}),
    threshold: r.threshold, wrong: r.wrong, confidentWrong: r.confidentWrong, uncertainCount: r.uncertainCount,
    sources: r.sources, usd: r.usd, inputTokens: r.inputTokens, draftLabels: r.draftLabels,
    casesPath: path.basename(r.casesPath),
  };
}
