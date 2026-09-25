// validate_layout の判断段。エンジンの配置検査(src/core/mcp/ApplicationMcpValidate.cpp)はそのまま残し、
// その指摘のうち「設計判断で意図的でありうるもの」だけを Brief と一緒に Jev へ聞く。
//
// ★なぜ要るか: OVERLAP(体積比 3 割超のめり込み)は「設計判断なので人/AI が決める」と保留されていて、
//   AI は毎回「直すべきか」を自分で推測していた。本棚の中の本・机に差し込んだ椅子・地面に半分埋めた岩は
//   意図どおりなのに、同じ規則で「めり込み」と言われる。浮き(FLOATING)も、吊りランプや宙に浮く結晶は
//   そういう設計。机の上の箱で浮きを誤爆した例(10704f2)はエンジン側で直したが、
//   「浮いていてよい物か」は名前と Brief を読まないと決まらない。
//
// ★聞くもの / 聞かないもの(ASKED_KINDS / RULE_KINDS。どちらにも無い種類はテストで落ちる):
//   聞く … OVERLAP / FLOATING / BURIED(layout.intended)と NO_COLLIDER(layout.no_collider_ok)。
//          名前・グループ・大きさ・程度・Brief しだいで「意図どおり」になりうる。
//   聞かない … Z_FIGHT(面が 1mm 以内で重なる＝描画がちらつく。どの作品でも欠陥)/
//          DUPLICATE(同じ物を同じ場所に 2 回置いた＝リトライの事故)/
//          COLLIDER_WITHOUT_BODY(このエンジンの罠。当たり判定が効いていないのは常に不具合)/
//          NAN_TRANSFORM / SCALE_ANOMALY(数値の事故・単位の取り違え)。
//          明らかな欠陥を聞くと「意図どおり」に倒れる危険だけが増えるので、ルールのまま。
//
// ★1 往復: 聞く指摘は全部 1 つの state(brief + facts.layout.issues[])に並べ、質問文の {{ref}}(A, B, …)で
//   どれを聞いているかを名指しする。指摘ごとに state を変えると指摘の数だけ Brief のトークンを払う。
//   Jev は数を数えられないので ref は数字ではなく英字にした。上限 MAX_JUDGED_ISSUES 件(state の肥大と
//   「関係ない state で劣化」を避ける)。溢れたぶんはルールのまま(skipped に件数)。

import { GROUPS, ROOT_TO_PREFIX, type EntityInfo, type GroupKey } from "../sceneOrganize.ts";
import { ask, type AskOptions, type AskOutcome, type JevResult, type QuestionRef, type RuleFn } from "./library.ts";
import {
  costOf, live, rulesReason, sourceOf, stripSerial,
  type JudgeBase, type JudgePlan, type JudgedFinding, type UncertainItem,
} from "./judgeCommon.ts";
import { BINS, wordOf } from "./wordify.ts";
import type { Brief } from "./brief.ts";

export const ASKED_KINDS = ["OVERLAP", "FLOATING", "BURIED", "NO_COLLIDER"] as const;
export const RULE_KINDS = ["Z_FIGHT", "DUPLICATE", "COLLIDER_WITHOUT_BODY", "NAN_TRANSFORM", "SCALE_ANOMALY"] as const;
export type AskedKind = (typeof ASKED_KINDS)[number];
export const isAskedKind = (k: string): k is AskedKind => (ASKED_KINDS as readonly string[]).includes(k);

export const MAX_JUDGED_ISSUES = 12;
const REFS = "ABCDEFGHIJKL".split("");

/** state に入れる指摘文(数値を含まない)。 */
export const LAYOUT_KIND_TEXT: Record<AskedKind, string> = {
  OVERLAP: "物どうしが食い込み合っている",
  FLOATING: "真下の面から浮いている",
  BURIED: "床や地面に沈み込んでいる",
  NO_COLLIDER: "人がぶつかる大きさなのに当たり判定が無い(すり抜ける)",
};

/** グループのルート → Jev に渡す言葉(sceneOrganize.ts の GROUPS の説明と同じ意味)。 */
export const GROUP_WORD: Record<GroupKey, string> = {
  LVL: "LVL(床・壁・足場などのレベル形状。当たり判定を持つのが原則)",
  ENV: "ENV(背景・装飾。当たり判定が要らない見せ物)",
  LGT: "LIGHT(ライト)",
  GP: "GAMEPLAY(プレイヤー・敵・アイテム・仕掛け)",
  FX: "FX(エフェクト)",
  UI: "UI(ゲーム内 UI)",
  CAM: "CAMERA(カメラ)",
};
export const NO_GROUP_WORD = "グループ外";

/** エンジンの validate_layout の issues[] 1 件。 */
export type LayoutIssue = {
  kind: string; level: "error" | "warning" | string; text: string; fixed?: boolean;
  entityId?: number; name?: string; otherEntityId?: number; otherName?: string;
};

// ────────────────────────────────────────────────────────────────
//  指摘文から程度を読む
// ────────────────────────────────────────────────────────────────
//
// ★エンジンは程度を数値のフィールドでは返さず、指摘文(text)に埋めている。C++ には触らない方針なので
//   文から読む。書式は ApplicationMcpValidate.cpp の snprintf と一致している必要があり、
//   layoutJudge.test.ts が C++ の書式文字列を読んで突き合わせる(書式が変わったらテストが落ちる)。
//   読めなかったら程度の語を出さない(「無い」と決めつけない)。

export const DEGREE_PATTERNS = {
  /** "%s が %s に体積比 %.0f%% めり込んでいる。" */
  OVERLAP: /体積比\s*([\d.]+)%\s*めり込んでいる/,
  /** "%s が真下の面から %.2fm 浮いている。" */
  FLOATING: /真下の面から\s*([\d.]+)m\s*浮いている/,
  /** "%s が地面へ %.2fm 埋まっている（高さ %.2fm の %.0f%%）。" */
  BURIED: /埋まっている（高さ\s*([\d.]+)m\s*の\s*([\d.]+)%）/,
} as const;

export function degreeOf(issue: Pick<LayoutIssue, "kind" | "text">, heightM?: number): { word?: string; value?: number } {
  const t = String(issue.text ?? "");
  if (issue.kind === "OVERLAP") {
    const m = t.match(DEGREE_PATTERNS.OVERLAP);
    if (!m) return {};
    const v = Number(m[1]) / 100;
    return { word: wordOf("overlap", v), value: v };
  }
  if (issue.kind === "FLOATING") {
    const m = t.match(DEGREE_PATTERNS.FLOATING);
    if (!m || !(heightM && heightM > 0)) return {};
    const v = Number(m[1]) / heightM;
    return { word: wordOf("lift", v), value: v };
  }
  if (issue.kind === "BURIED") {
    const m = t.match(DEGREE_PATTERNS.BURIED);
    if (!m) return {};
    const v = Number(m[2]) / 100;
    return { word: wordOf("buried", v), value: v };
  }
  return {};
}

// ────────────────────────────────────────────────────────────────
//  材料集め(エンジンを叩く部分。call を差し替えればテストできる)
// ────────────────────────────────────────────────────────────────

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<any>;

export type LayoutContext = {
  /** entityId → 子を含むワールド AABB の大きさ [x, y, z](m)。 */
  sizes: Map<number, [number, number, number]>;
  /** entityId → 親付きの一覧(グループの判定用)。 */
  entities: Map<number, EntityInfo>;
};

/** 聞く指摘に出てくるエンティティだけ大きさを測り、グループを引くための階層を読む。例外は投げない。 */
export async function collectLayoutContext(call: EngineCall, issues: LayoutIssue[]): Promise<LayoutContext> {
  const ctx: LayoutContext = { sizes: new Map(), entities: new Map() };
  const ids = new Set<number>();
  for (const is of selectAsked(issues).picked) {
    if (typeof is.entityId === "number") ids.add(is.entityId);
    if (typeof is.otherEntityId === "number") ids.add(is.otherEntityId);
  }
  if (ids.size === 0) return ctx;
  for (const id of ids) {
    const b = await call("get_bounds", { entity: id, includeChildren: true }).catch(() => null);
    if (Array.isArray(b?.size)) ctx.sizes.set(id, [Number(b.size[0]), Number(b.size[1]), Number(b.size[2])]);
  }
  try {
    const list = await call("list_entities", { verbose: true });
    const hier = await call("get_hierarchy", {});
    const parentOf = new Map<number, number>();
    const walk = (node: any, parent?: number) => {
      if (parent != null) parentOf.set(node.entityId, parent);
      for (const c of node.children ?? []) walk(c, node.entityId);
    };
    for (const r of hier?.roots ?? []) walk(r);
    for (const e of list?.entities ?? []) {
      ctx.entities.set(e.entityId, { entityId: e.entityId, name: e.name, componentTypes: e.componentTypes ?? [], parent: parentOf.get(e.entityId) });
    }
  } catch { /* グループが分からなくても大きさと名前で聞ける */ }
  return ctx;
}

/** グループ(ルートの祖先)と、ルートでない直近の親の名前。 */
export function groupOf(id: number | undefined, name: string | undefined, entities: Map<number, EntityInfo>):
  { key: GroupKey | null; parent?: string } {
  let key: GroupKey | null = null;
  let parent: string | undefined;
  let cur = id !== undefined ? entities.get(id) : undefined;
  for (let d = 0; cur && cur.parent !== undefined && d < 64; d++) {
    const p = entities.get(cur.parent);
    if (!p) break;
    const k = ROOT_TO_PREFIX.get(p.name);
    if (k && p.parent === undefined) { key = k; break; }
    if (parent === undefined) parent = p.name;
    cur = p;
  }
  if (!key) {
    // 規約どおりの名前なら接頭辞から推す(グループにぶら下がっていない散らかったシーンでも言葉を出す)
    const m = String(name ?? "").match(/^(ENV|LVL|LGT|GP|FX|UI|CAM)_/);
    if (m) key = m[1] as GroupKey;
  }
  return { key, ...(parent ? { parent } : {}) };
}

// ────────────────────────────────────────────────────────────────
//  指摘 → 言葉
// ────────────────────────────────────────────────────────────────

export type LayoutIssueFacts = {
  ref: string;
  kind: AskedKind;
  what: string;
  object: string;
  group: string;
  parent?: string;
  size?: string;
  other?: string;
  otherGroup?: string;
  otherSize?: string;
  degree?: string;
};

/** 聞く指摘を選ぶ(未修正・聞く種類・エラーを先に・上限まで)。 */
export function selectAsked(issues: LayoutIssue[]): { picked: LayoutIssue[]; skipped: number } {
  const cand = issues.filter((i) => !i.fixed && isAskedKind(i.kind));
  const sorted = [...cand].sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
  return { picked: sorted.slice(0, MAX_JUDGED_ISSUES), skipped: Math.max(0, sorted.length - MAX_JUDGED_ISSUES) };
}

const maxSide = (s?: [number, number, number]) => (s ? Math.max(s[0], s[1], s[2]) : undefined);

export function wordifyLayout(issues: LayoutIssue[], ctx: LayoutContext):
  { layout: { issues: LayoutIssueFacts[] }; picked: LayoutIssue[]; skipped: number; raw: Record<string, unknown>[] } {
  const { picked, skipped } = selectAsked(issues);
  const out: LayoutIssueFacts[] = [];
  const raw: Record<string, unknown>[] = [];
  picked.forEach((is, i) => {
    const size = is.entityId !== undefined ? ctx.sizes.get(is.entityId) : undefined;
    const otherSize = is.otherEntityId !== undefined ? ctx.sizes.get(is.otherEntityId) : undefined;
    const g = groupOf(is.entityId, is.name, ctx.entities);
    const deg = degreeOf(is, size?.[1]);
    const f: LayoutIssueFacts = {
      ref: REFS[i], kind: is.kind as AskedKind, what: LAYOUT_KIND_TEXT[is.kind as AskedKind],
      object: stripSerial(is.name), group: g.key ? GROUP_WORD[g.key] : NO_GROUP_WORD,
    };
    if (g.parent) f.parent = stripSerial(g.parent);
    const sw = wordOf("objectSize", maxSide(size));
    if (sw) f.size = sw;
    if (is.otherName) {
      f.other = stripSerial(is.otherName);
      const og = groupOf(is.otherEntityId, is.otherName, ctx.entities);
      f.otherGroup = og.key ? GROUP_WORD[og.key] : NO_GROUP_WORD;
      const ow = wordOf("objectSize", maxSide(otherSize));
      if (ow) f.otherSize = ow;
    }
    if (deg.word) f.degree = deg.word;
    out.push(f);
    raw.push({ ref: REFS[i], entityId: is.entityId, name: is.name, size, otherSize, degree: deg.value });
  });
  return { layout: { issues: out }, picked, skipped, raw };
}

export const LAYOUT_VOCAB: Record<string, readonly string[]> = {
  kind: ASKED_KINDS,
  what: Object.values(LAYOUT_KIND_TEXT),
  group: [...Object.values(GROUP_WORD), NO_GROUP_WORD],
  otherGroup: [...Object.values(GROUP_WORD), NO_GROUP_WORD],
  size: BINS.objectSize.words,
  otherSize: BINS.objectSize.words,
  degree: [...BINS.overlap.words, ...BINS.lift.words, ...BINS.buried.words],
};

/** 語彙の検査(評価ケースの手書きが本番とずれていないか)。名前は数字を含まないことだけ見る。 */
export function isLayoutWord(key: string, word: unknown): boolean {
  if (typeof word !== "string") return false;
  if (key === "ref") return REFS.includes(word);
  if (key === "object" || key === "other" || key === "parent") return word.length > 0 && !/[0-9０-９]/.test(word);
  return (LAYOUT_VOCAB[key] ?? []).includes(word);
}

// ────────────────────────────────────────────────────────────────
//  ルール(フォールバック)
// ────────────────────────────────────────────────────────────────

/**
 * NO_COLLIDER の既定の結論: グループの規約(AGENTS.md「ENV = 当たり判定が要らない見せ物」)。
 * ENV / FX / LIGHT なら「当たり判定は要らない」、それ以外(LVL / GAMEPLAY / グループ外)は「要る」。
 * ★Brief も名前も読まないので、写実の探索ゲームで巨木をすり抜けさせる、のような誤りをする。
 */
export const LAYOUT_RULES: Record<string, RuleFn> = {
  "layout.noColliderByGroup": ({ context, vars }) => {
    const is = (context?.facts?.layout?.issues ?? []).find((x: any) => x?.ref === vars.ref);
    const g = String(is?.group ?? "");
    const ok = /^(ENV|FX|LIGHT)\(/.test(g);
    return { value: ok ? 1 : 0, decided: ok, reason: ok ? `ルール: ${g.split("(")[0]} グループは当たり判定が要らない規約` : "ルール: 当たり判定が要る" };
  },
};

// ────────────────────────────────────────────────────────────────
//  plan → ask → interpret
// ────────────────────────────────────────────────────────────────

export type LayoutJudgeInput = {
  brief: Brief | null | undefined;
  /** エンジンの validate_layout の返り値(issues / errors / warnings)。 */
  report: { issues?: LayoutIssue[]; errors?: number; warnings?: number };
  ctx: LayoutContext;
};

export type LayoutJudge = JudgeBase & {
  /** keep と判断した指摘を除いた件数。pass はエラーが 0 か。 */
  errorsExcludingKept: number;
  warningsExcludingKept: number;
  passExcludingKept: boolean;
  /** 指摘があったが聞かない種類(明らかな欠陥。ルールのまま)。 */
  notAsked: string[];
  /** 聞く種類だが上限を超えたので聞かなかった件数。 */
  skipped: number;
  next?: string;
};

export function lookFor(is: LayoutIssue) {
  return typeof is.entityId === "number"
    ? { tool: "dx12_focus_and_screenshot", args: { entity: is.entityId } }
    : { tool: "dx12_focus_and_screenshot", args: { name: is.name } };
}

export function planLayout(input: LayoutJudgeInput): JudgePlan & { picked: LayoutIssue[]; skipped: number } {
  const w = wordifyLayout(input.report.issues ?? [], input.ctx);
  const refs: QuestionRef[] = w.layout.issues.map((f) => f.kind === "NO_COLLIDER"
    ? { id: "layout.no_collider_ok", vars: { ref: f.ref }, key: `layout.no_collider_ok#${f.ref}` }
    : { id: "layout.intended", vars: { ref: f.ref, kind: f.kind }, key: `layout.intended#${f.ref}` });
  return { facts: { layout: w.layout }, refs, picked: w.picked, skipped: w.skipped };
}

function counts(issues: LayoutIssue[], keptIdx: Set<LayoutIssue>) {
  const live = issues.filter((i) => !i.fixed && !keptIdx.has(i));
  const errors = live.filter((i) => i.level === "error").length;
  return { errors, warnings: live.length - errors };
}

export function interpretLayout(input: LayoutJudgeInput, plan: ReturnType<typeof planLayout>, results: JevResult[],
                                out: Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms" | "briefMissing" | "results"> | null): LayoutJudge {
  const all = input.report.issues ?? [];
  const notAsked = [...new Set(all.filter((i) => !i.fixed && !isAskedKind(i.kind)).map((i) => i.kind))];
  const uncertain: UncertainItem[] = [];
  const kept = new Set<LayoutIssue>();
  const findings: JudgedFinding[] = plan.picked.map((is, i) => {
    const r = results[i];
    const base = { code: is.kind, ref: REFS[i], ...(is.entityId !== undefined ? { entityId: is.entityId } : {}), ...(is.name ? { name: is.name } : {}) };
    if (!r || r.value === null || r.value === undefined) return { ...base, intended: null, keep: false };
    // ★ルールの答え(NO_COLLIDER のグループ規約)も採る。Jev の答えだけ intended(確率)を出す。
    const keep = r.decided === true;
    if (keep) kept.add(is);
    if (live(r) && r.uncertain) uncertain.push({ id: r.id, why: r.reason ?? "境界付近", look: lookFor(is) });
    return { ...base, intended: live(r) && typeof r.value === "number" ? Number(r.value.toFixed(3)) : null, keep,
             ...(live(r) && r.uncertain ? { uncertain: true } : {}) };
  });
  const c = counts(all, kept);
  const anyLive = results.some(live);
  const keptNames = [...kept].map((i) => i.name).filter(Boolean);
  return {
    source: plan.picked.length === 0 ? "rules" : sourceOf(results),
    ...(out?.briefMissing ? { briefMissing: true } : {}),
    ...(!anyLive && plan.picked.length > 0 ? { reason: rulesReason(out ? { ...out, results } : null) } : {}),
    ...(plan.picked.length === 0 ? { reason: "Jev に聞く種類の指摘が無い(ルールのまま)" } : {}),
    findings, uncertain,
    errorsExcludingKept: c.errors, warningsExcludingKept: c.warnings, passExcludingKept: c.errors === 0,
    notAsked, skipped: plan.skipped,
    cost: costOf(out),
    next: uncertain.length
      ? "uncertain がある。look のツールで絵を見て、そこだけは Claude が決めること"
      : keptNames.length
        ? `keep:true(${keptNames.slice(0, 4).join(", ")})は意図どおり＝直さない。★fix:"safe" は BURIED/FLOATING を`
          + "種類ごとに全部動かすので、keep にした物があるときは残りを dx12_snap_to_ground で個別に直すこと"
        : c.errors > 0 ? "dx12_validate_layout(fix:\"safe\") で自動修正できるものを直してから続けること" : undefined,
  };
}

/** 判断段の本体。例外は投げない。 */
export async function judgeLayout(input: LayoutJudgeInput & { askOptions?: AskOptions }): Promise<LayoutJudge> {
  const plan = planLayout(input);
  if (plan.refs.length === 0) return interpretLayout(input, plan, [], null);
  const out = await ask(plan.refs, { brief: input.brief ?? null, facts: plan.facts },
    { ...input.askOptions, rules: { ...LAYOUT_RULES, ...input.askOptions?.rules } });
  return interpretLayout(input, plan, out.results, out);
}

/** GROUPS の説明と GROUP_WORD の対応(テスト用に公開)。 */
export const GROUP_KEYS = Object.keys(GROUPS) as GroupKey[];
