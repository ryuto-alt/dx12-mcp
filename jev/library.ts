// Jev の質問ライブラリ: 質問ファイルの読み込み → state の射影 → 束ねて 1 往復 → キャッシュと記録。
//
// ★質問はコードに直書きせずファイル(*.jevq.json)に置く。質問文は「評価ケースで margin を測って
//   直す」対象で、直すたびに TS を触ると差分が読めなくなる。ファイルなら版(version)を上げて
//   notes に根拠を書ける。プロジェクト側 <baseDir>/assets/jev/ に同じ id を置けば上書きできる
//   (作品ごとに言い回しを詰めたいとき)。
//
// ★state は質問ごとに「要るフィールドだけ」を射影する(質問ファイルの state: ["brief", "facts.look"])。
//   関係ない state が混ざると Jev の精度が落ちる(公式 model-jaggedness)。
//   射影した結果が同じ質問は 1 リクエストに束ねる。束ねても並列評価なので遅延は増えず、
//   state のトークンを 1 回ぶんしか払わない。state が違う質問は別リクエストを並列に撃つ。
//
// ★失敗・鍵なし・Brief なし・キャッシュ専用で未キャッシュ → 必ずルール(fallback)へ落ちる。
//   判断段は「あれば賢い」だけで、無くても全機能が動くことが前提。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_MODEL, hasApiKey, systemOne,
  type ClientOptions, type JevAnswer, type JevQuestion, type JevType,
} from "./client.ts";
import { isBriefEmpty } from "./brief.ts";

export const BUILTIN_QUESTIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "questions");
/** 1 リクエストに束ねる質問の上限。公式に明記は無いが、64k トークン上限の手前で切る保険。 */
export const MAX_QUESTIONS_PER_REQUEST = 40;

export type CacheMode = "use" | "only" | "off";

export type Threshold = {
  /** noul: この確率以上で yes(既定 0.7。実測で肯定側が甘いので 0.5 にしない)。 */
  yes?: number;
  /** score: この値以上で "pass"。 */
  pass?: number;
  /** choice / score: confidence がこれ未満なら uncertain(既定 0.5)。 */
  minConfidence?: number;
  /** noul / score: 閾値からこの幅以内なら uncertain(既定 noul 0.1 / score 0.5)。 */
  band?: number;
};

/** 質問ファイル 1 つ(*.jevq.json)。 */
export type QuestionDef = {
  id: string;
  version: number | string;
  type: JevType;
  instructions: unknown;
  criteria?: unknown;
  /** context から state へ入れるフィールドのドット路。 */
  state: string[];
  threshold?: Threshold;
  /** 失敗時の規則。"no" / "yes" / "choice:<id>" / "score:<n>" / ask(opts.rules) に渡した名前。 */
  fallback?: string;
  /** 評価ケースのファイル(質問ファイルからの相対)。 */
  cases?: string;
  notes?: string;
  /** 質問文の {{var}} を別の var から引く表(例 gloss を code から)。 */
  lookup?: Record<string, { by: string; map: Record<string, string> }>;
  // ── 以下は読み込み時に付く ──
  file?: string;
  origin?: "builtin" | "project";
  casesPath?: string;
};

export type QuestionRef = string | { id: string; vars?: Record<string, string>; key?: string };

export type JevSource = "jev" | "cache" | "rules" | "error";

/** 判断結果の共通型。どの経路(Jev / キャッシュ / ルール)で出ても同じ形。 */
export type JevResult = {
  /** インスタンス id(vars 付きなら "finding.intended#NO_FOG")。 */
  id: string;
  question: string;
  version: number | string;
  type: JevType;
  source: JevSource;
  /** noul: yes の確率 / choice: 選んだ選択肢 / score: 加重平均。出せなかったら null。 */
  value: number | string | null;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, unknown>;
  /** threshold を当てた結論(noul: true/false、choice: 選択肢、score: "pass"/"fail" か最寄りの段)。 */
  decided?: boolean | string | number;
  /** 境界付近・confidence が低い → Claude(スクショ)か人に上げるべき。 */
  uncertain?: boolean;
  reason?: string;
  error?: string;
  briefMissing?: boolean;
  model?: string;
};

export type RuleFn = (ctx: {
  context: any; vars: Record<string, string>; def: QuestionDef;
}) => { value: number | string | null; decided?: boolean | string | number; reason?: string } | null;

export type AskOptions = ClientOptions & {
  baseDir?: string | null;
  cache?: CacheMode;
  /** fallback で名前指定される規則。 */
  rules?: Record<string, RuleFn>;
  /** 既に読んだライブラリを使い回す(評価で何百回も読み直さないため)。 */
  library?: Library;
  /** 追加の質問ディレクトリ(テスト用)。後ろほど優先。 */
  questionDirs?: string[];
  /** 射影せずこの state をそのまま使う(評価ケースの state 直指定用)。 */
  stateOverride?: unknown;
  /**
   * true なら、この ask に来た全質問を「全質問の state 路の和集合」で射影する(= 全部が同じ state になり 1 リクエストに束なる)。
   * ★品質ゲートが polish / ui / layout / play の質問を 1 往復で聞くため。質問ごとの射影より state が大きくなる
   *   (他の検査の事実も見える)ので、精度が落ちないかは評価(eval.ts の mixin + stateUnion)で測ってから使う。
   */
  stateUnion?: boolean;
  /** 全質問をこの路で射影する(stateUnion より優先)。評価で「品質ゲートと同じ state」を再現するため。 */
  statePaths?: string[];
  /** false で log.jsonl に書かない。 */
  log?: boolean;
  /** キャッシュもネットも使わずルールで答える(評価で「ルールならどう答えたか」を並べる比較用)。 */
  forceRules?: boolean;
};

export type RequestRecord = {
  ids: string[];
  source: "jev" | "error";
  ms: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  attempts: number;
  error?: string;
};

export type AskOutcome = {
  results: JevResult[];
  /** ネットへ出たリクエスト(キャッシュ命中は含まない)。 */
  requests: RequestRecord[];
  usd: number;
  inputTokens: number;
  /** 並列に撃ったうちの最長(= 利用者が待った時間)。 */
  ms: number;
  briefMissing: boolean;
};

// ────────────────────────────────────────────────────────────────
//  読み込み
// ────────────────────────────────────────────────────────────────

export type Library = {
  questions: Map<string, QuestionDef>;
  errors: string[];
  dirs: string[];
};

export function projectQuestionsDir(baseDir: string): string {
  return path.join(baseDir, "assets", "jev");
}

/** 形の検査。壊れた質問ファイルは読み飛ばして errors に積む(1 本壊れても他は使える)。 */
export function validateQuestion(q: any): string[] {
  const errs: string[] = [];
  if (!q || typeof q !== "object") return ["JSON オブジェクトでない"];
  if (typeof q.id !== "string" || !q.id) errs.push("id が無い");
  if (typeof q.version !== "number" && typeof q.version !== "string") errs.push("version が無い");
  if (!["noul", "choice", "score"].includes(q.type)) errs.push(`type が noul/choice/score のどれでもない: ${q.type}`);
  if (typeof q.instructions !== "string" && (typeof q.instructions !== "object" || q.instructions === null))
    errs.push("instructions は文字列かオブジェクト");
  if (!Array.isArray(q.state) || q.state.length === 0 || !q.state.every((s: unknown) => typeof s === "string" && s))
    errs.push("state はドット路の配列(1 つ以上)");
  if (q.type === "choice") {
    const keys = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
    if (keys.length < 2 || keys.length > 255) errs.push("choice の criteria は 2〜255 個の選択肢マップ");
  }
  if (q.type === "score") {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)
      errs.push("score の criteria は低→高の配列で 2〜10 段");
  }
  if (q.type === "noul" && q.criteria !== undefined) {
    if (typeof q.criteria !== "object" || Array.isArray(q.criteria)) errs.push("noul の criteria は {true, false} のオブジェクト");
  }
  const th = q.threshold;
  if (th !== undefined) {
    for (const k of ["yes", "pass", "minConfidence", "band"]) {
      if (th[k] !== undefined && (typeof th[k] !== "number" || !Number.isFinite(th[k]))) errs.push(`threshold.${k} は数値`);
    }
    if (typeof th.yes === "number" && (th.yes < 0 || th.yes > 1)) errs.push("threshold.yes は 0..1");
  }
  if (q.lookup !== undefined) {
    for (const [name, spec] of Object.entries<any>(q.lookup ?? {})) {
      if (!spec || typeof spec.by !== "string" || typeof spec.map !== "object") errs.push(`lookup.${name} は {by, map}`);
    }
  }
  return errs;
}

function readQuestionDir(dir: string, origin: "builtin" | "project", into: Map<string, QuestionDef>, errors: string[]) {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".jevq.json")).sort(); } catch { return; }
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      const q = JSON.parse(fs.readFileSync(file, "utf8"));
      const errs = validateQuestion(q);
      if (errs.length) { errors.push(`${file}: ${errs.join(" / ")}`); continue; }
      const def: QuestionDef = { ...q, file, origin };
      if (typeof q.cases === "string") def.casesPath = path.resolve(dir, q.cases);
      into.set(def.id, def);   // 後から読んだ方(プロジェクト)が勝つ
    } catch (e: any) {
      errors.push(`${file}: 読めない (${e?.message ?? e})`);
    }
  }
}

/** 組み込み → プロジェクト → 追加ディレクトリの順に読む。同じ id は後が勝つ。 */
export function loadLibrary(opts: { baseDir?: string | null; questionDirs?: string[] } = {}): Library {
  const questions = new Map<string, QuestionDef>();
  const errors: string[] = [];
  const dirs = [BUILTIN_QUESTIONS_DIR];
  readQuestionDir(BUILTIN_QUESTIONS_DIR, "builtin", questions, errors);
  if (opts.baseDir) {
    const p = projectQuestionsDir(opts.baseDir);
    dirs.push(p);
    readQuestionDir(p, "project", questions, errors);
  }
  for (const d of opts.questionDirs ?? []) { dirs.push(d); readQuestionDir(d, "project", questions, errors); }
  return { questions, errors, dirs };
}

// ────────────────────────────────────────────────────────────────
//  射影・正規化・描画
// ────────────────────────────────────────────────────────────────

function getPath(obj: any, dotted: string): unknown {
  let cur = obj;
  for (const k of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj: any, dotted: string, value: unknown) {
  const ks = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (!cur[ks[i]] || typeof cur[ks[i]] !== "object") cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = value;
}

/**
 * context から paths だけを抜き出す。入れ子の形は保つ({facts:{look}})。
 * ★末尾だけに潰さない: "facts.look" と "brief.look" が同じ "look" に化けて衝突するのを避ける。
 */
export function project(context: unknown, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const v = getPath(context, p);
    if (v !== undefined) setPath(out, p, v);
  }
  return out;
}

/** キーを並べ替えた JSON。束ねる判定とキャッシュキーは「意味が同じなら同じ文字列」でないといけない。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x === undefined ? null : x)).join(",")}]`;
  const keys = Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(",")}}`;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * キャッシュキー = sha256(インスタンス id + 版 + モデル + 質問本文 + 正規化 state)。
 * ★質問本文のハッシュも入れる: 評価で質問文を直している最中に版を上げ忘れると、
 *   古い言い回しの答えが返って「直したのに数字が動かない」になる。
 */
export function cacheKey(instanceId: string, version: number | string, model: string,
                         question: JevQuestion, stateKey: string): string {
  return sha256(JSON.stringify([instanceId, String(version), model, sha256(stableStringify(question)), stateKey]));
}

function substitute(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") return v.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = substitute(x, vars);
    return o;
  }
  return v;
}

/** 質問文の {{var}} を埋めて送れる形にする。埋まらない var が残ったらエラー(黙って {{code}} を送らない)。 */
export function renderQuestion(def: QuestionDef, varsIn: Record<string, string> = {}):
  { ok: true; question: JevQuestion; vars: Record<string, string> } | { ok: false; error: string } {
  const vars = { ...varsIn };
  for (const [name, spec] of Object.entries(def.lookup ?? {})) {
    if (vars[name] !== undefined) continue;
    const key = vars[spec.by];
    if (key === undefined) continue;
    const hit = spec.map[key];
    if (hit === undefined) return { ok: false, error: `${def.id}: lookup.${name} に ${spec.by}=${key} が無い(質問ファイルの表に足すこと)` };
    vars[name] = hit;
  }
  const question: JevQuestion = { type: def.type, instructions: substitute(def.instructions, vars) };
  if (def.criteria !== undefined) question.criteria = substitute(def.criteria, vars);
  const left = JSON.stringify(question).match(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/);
  if (left) return { ok: false, error: `${def.id}: vars.${left[1]} が要る(質問文の {{${left[1]}}} が埋まらない)` };
  return { ok: true, question, vars };
}

/** state の路が brief を指しているか(Brief が無いときにルールへ落とす判定)。 */
export function dependsOnBrief(def: QuestionDef): boolean {
  return def.state.some((p) => p === "brief" || p.startsWith("brief."));
}

// ────────────────────────────────────────────────────────────────
//  答えの解釈(閾値)とフォールバック
// ────────────────────────────────────────────────────────────────

export const DEFAULT_NOUL_YES = 0.7;
export const DEFAULT_NOUL_BAND = 0.1;
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_SCORE_BAND = 0.5;

type Interpreted = Pick<JevResult, "value" | "probabilities" | "confidence" | "legend" | "decided" | "uncertain" | "reason">;

export function interpretAnswer(def: QuestionDef, ans: JevAnswer | undefined): Interpreted | { error: string } {
  if (!ans || ans.type !== def.type) return { error: `答えの型が違う(期待 ${def.type} / 実際 ${ans?.type ?? "なし"})` };
  const th = def.threshold ?? {};
  if (ans.type === "noul") {
    const p = Number(ans.noul);
    if (!Number.isFinite(p)) return { error: "noul が数値でない" };
    const yes = th.yes ?? DEFAULT_NOUL_YES;
    const band = th.band ?? DEFAULT_NOUL_BAND;
    const uncertain = Math.abs(p - yes) < band;
    return {
      value: p, decided: p >= yes, uncertain,
      reason: uncertain ? `yes の確率 ${p.toFixed(2)} が閾値 ${yes} の ±${band} 以内` : undefined,
    };
  }
  if (ans.type === "choice") {
    const keys = def.criteria && typeof def.criteria === "object" ? Object.keys(def.criteria as object) : [];
    if (keys.length && !keys.includes(ans.choice)) return { error: `選択肢に無い答え: ${ans.choice}` };
    const minC = th.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const uncertain = !(ans.confidence >= minC);
    return {
      value: ans.choice, probabilities: ans.probabilities, confidence: ans.confidence,
      decided: ans.choice, uncertain,
      reason: uncertain ? `confidence ${Number(ans.confidence).toFixed(2)} < ${minC}` : undefined,
    };
  }
  // score
  const v = Number(ans.score);
  if (!Number.isFinite(v)) return { error: "score が数値でない" };
  const minC = th.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const lowConf = !(ans.confidence >= minC);
  let decided: string | number = Math.round(v);
  let nearPass = false;
  if (typeof th.pass === "number") {
    decided = v >= th.pass ? "pass" : "fail";
    nearPass = Math.abs(v - th.pass) < (th.band ?? DEFAULT_SCORE_BAND);
  }
  const reasons = [
    lowConf ? `confidence ${Number(ans.confidence).toFixed(2)} < ${minC}` : "",
    nearPass ? `値 ${v.toFixed(2)} が合格線 ${th.pass} の近く` : "",
  ].filter(Boolean);
  return {
    value: v, probabilities: ans.probabilities, confidence: ans.confidence, legend: ans.legend,
    decided, uncertain: lowConf || nearPass, reason: reasons.length ? reasons.join(" / ") : undefined,
  };
}

/** 規則を引く。組み込みの定数規則 + 呼び出し側が渡した名前付き規則。 */
function runRule(def: QuestionDef, context: any, vars: Record<string, string>, rules: Record<string, RuleFn> | undefined) {
  const f = def.fallback;
  if (!f) return null;
  if (f === "no") return { value: 0, decided: false, reason: "ルール: 既定で no" };
  if (f === "yes") return { value: 1, decided: true, reason: "ルール: 既定で yes" };
  if (f.startsWith("choice:")) { const c = f.slice(7); return { value: c, decided: c, reason: `ルール: 既定で ${c}` }; }
  if (f.startsWith("score:")) { const n = Number(f.slice(6)); return Number.isFinite(n) ? { value: n, decided: Math.round(n), reason: `ルール: 既定で ${n}` } : null; }
  const fn = rules?.[f];
  if (!fn) return null;
  try { return fn({ context, vars, def }); } catch { return null; }
}

function fallbackResult(
  base: Pick<JevResult, "id" | "question" | "version" | "type">,
  def: QuestionDef, context: any, vars: Record<string, string>, rules: Record<string, RuleFn> | undefined,
  why: string, error?: string,
): JevResult {
  const r = runRule(def, context, vars, rules);
  if (r && r.value !== null && r.value !== undefined) {
    return { ...base, source: "rules", value: r.value, decided: r.decided, uncertain: false,
             reason: r.reason ? `${why}。${r.reason}` : why, ...(error ? { error } : {}) };
  }
  // 規則でも出せない(例: Brief 適合度はルールでは測れない)。error が原因なら error、そうでなければ rules。
  return { ...base, source: error ? "error" : "rules", value: null, uncertain: true,
           reason: `${why}。この質問にはルールの代わりが無い`, ...(error ? { error } : {}) };
}

// ────────────────────────────────────────────────────────────────
//  キャッシュと記録(置き場は <baseDir>/.dx12/jev/)
// ────────────────────────────────────────────────────────────────

/** baseDir が分からないとき(エディタ未接続)は OS の temp 配下へ。プロジェクトを汚さない。 */
export function jevDir(baseDir?: string | null): string {
  return baseDir ? path.join(baseDir, ".dx12", "jev") : path.join(os.tmpdir(), "dx12-jev");
}

type CacheEntry = { key: string; id: string; version: number | string; model: string; responseModel?: string; answer: JevAnswer; at: string };

function cachePath(dir: string, key: string) { return path.join(dir, "cache", `${key}.json`); }

function readCache(dir: string, key: string): CacheEntry | null {
  try { return JSON.parse(fs.readFileSync(cachePath(dir, key), "utf8")); } catch { return null; }
}

function writeCache(dir: string, entry: CacheEntry) {
  try {
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    fs.writeFileSync(cachePath(dir, entry.key), JSON.stringify(entry), "utf8");
  } catch { /* 書けなくても判断そのものは返せる */ }
}

export type LogLine = {
  t: string;
  source: "jev" | "error" | "cache";
  ids: string[];
  versions: Record<string, number | string>;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  attempts?: number;
  error?: string;
};

/** 1 行 1 リクエスト。★state 本文は書かない(大きい + 作品の中身が漏れる)。 */
function appendLog(dir: string, line: LogLine) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify(line) + "\n", "utf8");
  } catch { /* 記録に失敗しても判断は返す */ }
}

export function summarizeLog(baseDir?: string | null) {
  const file = path.join(jevDir(baseDir), "log.jsonl");
  const out = { file, requests: 0, errors: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as LogLine;
      if (l.source === "cache") { out.cacheHits += l.ids?.length ?? 0; continue; }
      out.requests++;
      if (l.source === "error") out.errors++;
      out.inputTokens += l.inputTokens ?? 0;
      out.outputTokens += l.outputTokens ?? 0;
      out.usd += l.usd ?? 0;
    } catch { /* 壊れた行は飛ばす */ }
  }
  out.usd = Number(out.usd.toFixed(8));
  return out;
}

export function countCache(baseDir?: string | null): number {
  try { return fs.readdirSync(path.join(jevDir(baseDir), "cache")).filter((f) => f.endsWith(".json")).length; }
  catch { return 0; }
}

// ────────────────────────────────────────────────────────────────
//  聞く
// ────────────────────────────────────────────────────────────────

type Instance = {
  idx: number;
  base: Pick<JevResult, "id" | "question" | "version" | "type">;
  def: QuestionDef;
  question: JevQuestion;
  vars: Record<string, string>;
  state: unknown;
  stateKey: string;
  key: string;
};

function refOf(r: QuestionRef): { id: string; vars: Record<string, string>; key?: string } {
  return typeof r === "string" ? { id: r, vars: {} } : { id: r.id, vars: { ...(r.vars ?? {}) }, key: r.key };
}

function instanceIdOf(id: string, vars: Record<string, string>, key?: string): string {
  if (key) return key;
  const vals = Object.keys(vars).sort().map((k) => vars[k]);
  return vals.length ? `${id}#${vals.join(",")}` : id;
}

/**
 * 質問を聞く。refs の順に結果を返す(失敗したものもルールの結果で埋まる。例外は投げない)。
 *
 *   ask(["look.brief_fit", {id:"finding.intended", vars:{code:"NO_FOG"}}], {brief, facts}, {baseDir})
 */
export async function ask(refs: QuestionRef[], context: any, opts: AskOptions = {}): Promise<AskOutcome> {
  const lib = opts.library ?? loadLibrary({ baseDir: opts.baseDir, questionDirs: opts.questionDirs });
  const plan = refs.map((r) => {
    const ref = refOf(r);
    return { ref, def: lib.questions.get(ref.id) };
  });
  const results: JevResult[] = new Array(plan.length);
  const instances: Instance[] = [];
  const unionPaths = opts.statePaths?.length ? opts.statePaths
    : opts.stateUnion ? [...new Set(plan.flatMap(({ def }) => def?.state ?? []))] : null;

  plan.forEach(({ ref, def }, idx) => {
    const id = instanceIdOf(ref.id, ref.vars, ref.key);
    if (!def) {
      results[idx] = { id, question: ref.id, version: "?", type: "noul", source: "error", value: null,
                       uncertain: true, error: `質問 ${ref.id} が見つからない(${lib.dirs.join(" / ")})` };
      return;
    }
    const base = { id, question: def.id, version: def.version, type: def.type };
    const rendered = renderQuestion(def, ref.vars);
    if (!rendered.ok) {
      results[idx] = { ...base, source: "error", value: null, uncertain: true, error: rendered.error };
      return;
    }
    const state = opts.stateOverride !== undefined ? opts.stateOverride : project(context, unionPaths ?? def.state);
    const stateKey = stableStringify(state);
    instances.push({
      idx, base, def, question: rendered.question, vars: rendered.vars, state, stateKey,
      key: cacheKey(id, def.version, opts.model ?? JEV_MODEL, rendered.question, stateKey),
    });
  });

  const outcome = await runInstances(instances, context, opts, results);
  return { ...outcome, results, briefMissing: results.some((r) => r?.briefMissing === true) };
}

/**
 * アドホックな直接質問(質問ファイルを経由しない)。閾値は既定値。
 * dx12_jev_ask の raw 用。キャッシュと記録は通常の質問と同じ置き場。
 */
export async function askRaw(state: unknown, questions: Record<string, JevQuestion>, opts: AskOptions = {}): Promise<AskOutcome> {
  const results: JevResult[] = [];
  const instances: Instance[] = [];
  const stateKey = stableStringify(state);
  Object.entries(questions).forEach(([k, q], idx) => {
    const def: QuestionDef = { id: `raw:${k}`, version: "raw", type: q?.type, instructions: q?.instructions,
                               criteria: q?.criteria, state: ["raw"] };
    const base = { id: k, question: def.id, version: def.version, type: q?.type };
    const errs = validateQuestion(def);
    if (errs.length) { results[idx] = { ...base, source: "error", value: null, uncertain: true, error: errs.join(" / ") }; return; }
    instances.push({ idx, base, def, question: q, vars: {}, state, stateKey,
                     key: cacheKey(def.id, def.version, opts.model ?? JEV_MODEL, q, stateKey) });
  });
  const outcome = await runInstances(instances, { state }, opts, results);
  return { ...outcome, results, briefMissing: false };
}

async function runInstances(instances: Instance[], context: any, opts: AskOptions, results: JevResult[]) {
  const dir = jevDir(opts.baseDir);
  const cacheMode: CacheMode = opts.cache ?? "use";
  const keyPresent = hasApiKey(opts);
  const model = opts.model ?? JEV_MODEL;
  const pending: Instance[] = [];
  const cacheHits: Instance[] = [];

  for (const inst of instances) {
    // ★Brief に依存する質問は Brief が無ければ聞かない。空の Brief に照らした判断は
    //   「何にでも合う」「何も意図していない」に倒れてしまい、ルールより悪い。
    if (opts.stateOverride === undefined && dependsOnBrief(inst.def) && isBriefEmpty(context?.brief)) {
      results[inst.idx] = { ...fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules,
        "Brief(作品の意図)が無いので判断しない。dx12_brief で書くと Jev が使われる"), briefMissing: true };
      continue;
    }
    if (opts.forceRules) {
      results[inst.idx] = fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules, "ルールで答えた(比較用)");
      continue;
    }
    if (cacheMode !== "off") {
      const hit = readCache(dir, inst.key);
      if (hit) {
        const it = interpretAnswer(inst.def, hit.answer);
        if (!("error" in it)) {
          results[inst.idx] = { ...inst.base, source: "cache", ...it, model: hit.responseModel ?? hit.model };
          cacheHits.push(inst);
          continue;
        }
      }
      if (cacheMode === "only") {
        results[inst.idx] = fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules,
          "cache:\"only\" でキャッシュに無い");
        continue;
      }
    }
    if (!keyPresent) {
      results[inst.idx] = fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules,
        "TYPESAFE_API_KEY が無いのでルールで判断");
      continue;
    }
    pending.push(inst);
  }

  if (cacheHits.length && opts.log !== false) {
    appendLog(dir, {
      t: new Date().toISOString(), source: "cache", ids: cacheHits.map((i) => i.base.id),
      versions: Object.fromEntries(cacheHits.map((i) => [i.base.question, i.def.version])),
      ms: 0, inputTokens: 0, outputTokens: 0, usd: 0,
    });
  }

  // 同じ state の質問を束ねる(1 リクエスト = 1 state)。上限を超えたら分ける。
  const groups = new Map<string, Instance[]>();
  for (const inst of pending) {
    const g = groups.get(inst.stateKey) ?? [];
    g.push(inst);
    groups.set(inst.stateKey, g);
  }
  const chunks: Instance[][] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i += MAX_QUESTIONS_PER_REQUEST) chunks.push(g.slice(i, i + MAX_QUESTIONS_PER_REQUEST));
  }

  const requests: RequestRecord[] = [];
  await Promise.all(chunks.map(async (chunk) => {
    // 送るキーは q0, q1 …(質問 id の "." や "#" をサーバがどう扱うか分からないので避ける)。
    const questions: Record<string, JevQuestion> = {};
    chunk.forEach((inst, i) => { questions[`q${i}`] = inst.question; });
    const res = await systemOne({ state: chunk[0].state, questions }, { ...opts, model });
    const ids = chunk.map((i) => i.base.id);
    const versions = Object.fromEntries(chunk.map((i) => [i.base.question, i.def.version]));
    if (res.ok) {
      requests.push({ ids, source: "jev", ms: res.ms, inputTokens: res.usage.input_tokens,
                      outputTokens: res.usage.output_tokens, usd: res.usd, attempts: res.attempts });
      if (opts.log !== false) appendLog(dir, {
        t: new Date().toISOString(), source: "jev", ids, versions, ms: res.ms,
        inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, usd: res.usd, attempts: res.attempts,
      });
      chunk.forEach((inst, i) => {
        const ans = res.answers[`q${i}`];
        const it = interpretAnswer(inst.def, ans);
        if ("error" in it) {
          results[inst.idx] = fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules, "Jev の答えが使えない", it.error);
          return;
        }
        results[inst.idx] = { ...inst.base, source: "jev", ...it, model: res.model };
        if (cacheModeWrites(opts.cache)) {
          writeCache(dir, { key: inst.key, id: inst.base.id, version: inst.def.version, model,
                            responseModel: res.model, answer: ans!, at: new Date().toISOString() });
        }
      });
    } else {
      requests.push({ ids, source: "error", ms: res.ms, inputTokens: 0, outputTokens: 0, usd: 0,
                      attempts: res.attempts, error: res.error });
      if (opts.log !== false) appendLog(dir, {
        t: new Date().toISOString(), source: "error", ids, versions, ms: res.ms,
        inputTokens: 0, outputTokens: 0, usd: 0, attempts: res.attempts, error: `${res.kind}: ${res.error}`.slice(0, 300),
      });
      for (const inst of chunk) {
        results[inst.idx] = fallbackResult(inst.base, inst.def, context, inst.vars, opts.rules,
          `Jev に聞けなかった(${res.kind})のでルールで判断`, res.error);
      }
    }
  }));

  return {
    requests,
    usd: Number(requests.reduce((a, r) => a + r.usd, 0).toFixed(8)),
    inputTokens: requests.reduce((a, r) => a + r.inputTokens, 0),
    ms: requests.reduce((a, r) => Math.max(a, r.ms), 0),
  };
}

/** "off" は読みも書きもしない(毎回撃ち直して揺れを見たい評価用)。 */
function cacheModeWrites(mode: CacheMode | undefined): boolean {
  return mode !== "off";
}
