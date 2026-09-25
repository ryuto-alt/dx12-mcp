// ui_audit の判断段。uiQuality.ts の auditUiTree(ルール)はそのまま残し、その上に
// 「この UI の指摘は作品の意図(Brief)に照らして採るべきか」を載せる。
//
// ★なぜ要るか: auditUiTree には好みのルール(全部中央揃えは AI 的 / 文字サイズは 5 種まで /
//   面色は 12 系統まで / 装飾は 1〜2 種まで / 光沢は遅く)が混ざっていて、AGENTS.md は
//   「最後は目視」と逃げていた。ガチャ演出のにぎやかなタイトルでも、静かなホラーの HUD でも
//   同じ重さで「直せ」と言うので、AI が作品の文法を壊す方向へ直してしまう。
//
// ★聞くもの / 聞かないもの:
//   聞く(好み・文法の問題) … UI_JUDGED_CODES の 7 種。Brief の UI の方向性しだいで正解が変わる。
//   聞かない(機能の欠陥)   … COLLAPSED_RECT / SMALL_HIT_TARGET / TEXT_CLIPPED_HEIGHT / RICH_WRAP_CONFLICT /
//     INPUT_BLOCKER / INTERACTIVE_OVERLAP / BUTTON_NO_EVENT / SMALL_TEXT / TEXT_OVERFLOW_RISK /
//     DEEP_HIERARCHY / SIBLING_MISALIGNMENT / OFF_GRID_SPACING。押せない・読めない・崩れているは
//     どの作品でも欠陥で、Brief で意図になることが無い(聞くと「意図どおり」に倒れる危険だけが増える)。
//
// ★質問は 1 往復: ui.brief_fit(score) と、指摘コードごとの ui.finding_intended(noul)は
//   全部同じ state(brief + facts.ui)に射影されるので library が 1 リクエストに束ねる。
//   指摘は要素ごとではなくコードごとに聞く(同じコードが 5 要素に出ても 1 問)。要素ごとに聞くと
//   問いの数が要素数に比例して増えるうえ、「この画面で光沢を使うか」は要素ではなく画面の文法の問題なので。

import { scoreUiIssues, type UiIssue } from "../uiQuality.ts";
import { ask, type AskOptions, type AskOutcome, type JevResult, type QuestionRef } from "./library.ts";
import {
  costOf, live, maskDigits, rulesReason, sourceOf, stripSerial,
  type JudgeBase, type JudgePlan, type LookHint, type UncertainItem,
} from "./judgeCommon.ts";
import { BINS, ratioWord, wordOf } from "./wordify.ts";
import type { Brief } from "./brief.ts";

export const UI_JUDGED_CODES = [
  "CENTERED_MONOTONY", "FONT_SIZE_SPRAWL", "PALETTE_SPRAWL",
  "OVER_DECORATED", "BUSY_GLOSS", "EFFECT_STACKING", "OUT_OF_CANVAS",
] as const;
export type UiJudgedCode = (typeof UI_JUDGED_CODES)[number];

export const isUiJudgedCode = (c: string): c is UiJudgedCode => (UI_JUDGED_CODES as readonly string[]).includes(c);

/**
 * Jev に聞かないコード(機能の欠陥)。uiQuality.ts にコードを足したら、聞くか聞かないかを
 * どちらかの表に必ず書くこと(uiJudge.test.ts が「どちらにも無いコード」で落ちる)。
 */
export const UI_NOT_ASKED = [
  "COLLAPSED_RECT", "SMALL_HIT_TARGET", "TEXT_CLIPPED_HEIGHT", "RICH_WRAP_CONFLICT", "INPUT_BLOCKER",
  "INTERACTIVE_OVERLAP", "BUTTON_NO_EVENT", "SMALL_TEXT", "TEXT_OVERFLOW_RISK", "DEEP_HIERARCHY",
  "SIBLING_MISALIGNMENT", "OFF_GRID_SPACING",
] as const;

/**
 * state に入れる指摘文。uiQuality の message は「文字サイズが 7 種類」のように数値入りなので使わない
 * (数値の大小は Jev の弱点。量は facts.ui の語で渡してある)。
 */
export const UI_ISSUE_TEXT: Record<UiJudgedCode, string> = {
  CENTERED_MONOTONY: "ほとんどのボタンと文字が画面の水平中央に並んでいる(左右対称の中央構図)",
  FONT_SIZE_SPRAWL: "文字の大きさの種類が多く、見出し・本文・補助の段が絞られていない",
  PALETTE_SPRAWL: "パネルや画像の面の色の系統が多く、配色が絞られていない",
  OVER_DECORATED: "グラデーション・枠線・影・特殊な形を同時に重ねたパネルがある",
  BUSY_GLOSS: "光沢が速く流れるアニメーションが付いた要素がある",
  EFFECT_STACKING: "一文字ずつの演出に縁取りや影まで重ねた文字がある",
  OUT_OF_CANVAS: "画面の端からはみ出している要素がある",
};

export const UI_SCREENS = ["title", "hud", "inventory", "settings", "result", "dialog", "other"] as const;
export type UiScreen = (typeof UI_SCREENS)[number];
export const SCREEN_WORD: Record<UiScreen, string> = {
  title: "タイトル画面", hud: "プレイ中の HUD", inventory: "持ち物画面", settings: "設定画面",
  result: "リザルト画面", dialog: "会話・ダイアログ", other: "その他の画面",
};

const SEVERITY_WORD: Record<UiIssue["severity"], string> = { error: "エラー", warning: "注意", suggestion: "提案" };

// ────────────────────────────────────────────────────────────────
//  UI ツリー → 言葉
// ────────────────────────────────────────────────────────────────

type Node = any;

function visibleNodes(tree: any): { node: Node; cv: { refWidth: number; refHeight: number } }[] {
  const out: { node: Node; cv: { refWidth: number; refHeight: number } }[] = [];
  for (const canvas of tree?.canvases ?? []) {
    const cv = canvas?.uiCanvas ?? { refWidth: 1920, refHeight: 1080 };
    const visit = (n: Node, parentHidden: boolean) => {
      const hidden = parentHidden || n?.uiRect?.visible === false;
      if (!hidden && Array.isArray(n?.resolvedRect)) out.push({ node: n, cv });
      for (const c of n?.children ?? []) visit(c, hidden);
    };
    visit(canvas, false);
  }
  return out;
}

const isInteractive = (n: Node) =>
  (n?.components?.includes("uiButton") && n?.uiButton?.interactable !== false)
  || n?.components?.includes("uiSlider") || n?.components?.includes("uiToggle");

function decorationCount(img: any): number {
  return Number((img?.gradientDir ?? 0) !== 0) + Number((img?.outlineWidth ?? 0) > 0)
    + Number((img?.shadowAlpha ?? 0) > 0) + Number((img?.shape ?? 0) !== 0);
}

/** 横の偏り。中心 x が画面幅の 4 割未満 = 左 / 6 割超 = 右 / その間 = 中央。 */
function horizontalWord(xs: number[]): string | undefined {
  if (xs.length === 0) return undefined;
  const n = xs.length;
  const left = xs.filter((x) => x < 0.4).length / n;
  const right = xs.filter((x) => x > 0.6).length / n;
  const mid = 1 - left - right;
  if (mid >= 0.6) return "中央に集まっている";
  if (left >= 0.6) return "左に寄っている";
  if (right >= 0.6) return "右に寄っている";
  if (left >= 0.25 && right >= 0.25) return "左右に分かれている";
  return "ばらけている";
}

function verticalWord(ys: number[]): string | undefined {
  if (ys.length === 0) return undefined;
  const n = ys.length;
  const top = ys.filter((y) => y < 1 / 3).length / n;
  const bottom = ys.filter((y) => y > 2 / 3).length / n;
  const mid = 1 - top - bottom;
  if (top >= 0.6) return "上に寄っている";
  if (bottom >= 0.6) return "下に寄っている";
  if (mid >= 0.6) return "中段に集まっている";
  return "上下に散っている";
}

export type UiFacts = {
  screen?: string;
  interactiveElements?: string;
  textElements?: string;
  /** 画面に出ている文言(数字は # に潰す)。何の画面かを Jev が掴むため。 */
  labels?: string[];
  horizontalLayout?: string;
  verticalLayout?: string;
  centeredShare?: string;
  fontSizeKinds?: string;
  colorFamilies?: string;
  heavilyDecoratedPanels?: string;
  animatedGloss?: string;
  textEffects?: string;
  issues: { code: UiJudgedCode; issue: string; severity: string; targets?: string[] }[];
};

/**
 * UI ツリー + 監査結果 → Jev に渡す言葉(ui)と、人とログ用の元の数値(raw)。
 * ★ui には数値を入れない(名前の連番・文言の数字も落とす)。読めなかった項目は落とす。
 */
export function wordifyUi(tree: any, audit: { issues: UiIssue[]; metrics?: any }, screen?: UiScreen | string):
  { ui: UiFacts; raw: Record<string, unknown> } {
  const nodes = visibleNodes(tree);
  const interactive = nodes.filter(({ node }) => isInteractive(node));
  const texts = nodes.filter(({ node }) => node?.uiText);
  const targets = nodes.filter(({ node }) => isInteractive(node) || node?.uiText);
  const ui: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};

  if (screen) ui.screen = (SCREEN_WORD as Record<string, string>)[screen] ?? undefined;
  ui.interactiveElements = wordOf("count", interactive.length);
  ui.textElements = wordOf("count", texts.length);
  const labels: string[] = [];
  for (const { node } of texts) {
    const t = maskDigits(String(node?.text ?? "").replace(/\[[^\]]+\]/g, "").trim()).slice(0, 24);
    if (t && !labels.includes(t)) labels.push(t);
    if (labels.length >= 8) break;
  }
  if (labels.length) ui.labels = labels;

  const xs = targets.map(({ node, cv }) => (node.resolvedRect[0] + node.resolvedRect[2] / 2) / Math.max(1, cv.refWidth));
  const ys = targets.map(({ node, cv }) => (node.resolvedRect[1] + node.resolvedRect[3] / 2) / Math.max(1, cv.refHeight));
  ui.horizontalLayout = horizontalWord(xs);
  ui.verticalLayout = verticalWord(ys);
  if (targets.length > 0 && typeof audit.metrics?.centeredRatio === "number") {
    ui.centeredShare = wordOf("centered", audit.metrics.centeredRatio);
    raw.centeredRatio = audit.metrics.centeredRatio;
  }
  const fontKinds = Array.isArray(audit.metrics?.fontSizes) ? audit.metrics.fontSizes.length : undefined;
  if (fontKinds !== undefined && texts.length > 0) { ui.fontSizeKinds = wordOf("kinds", fontKinds); raw.fontSizeKinds = fontKinds; }

  // 面色の系統: PALETTE_SPRAWL と同じ量子化(1/16)で数える。metrics.colorGroups は 1/8 刻みなので使わない。
  const colors = new Set(nodes.map(({ node }) => node?.uiImage?.color).filter(Array.isArray)
    .map((c: number[]) => c.slice(0, 3).map((v) => Math.round(v * 16)).join(",")));
  if (nodes.some(({ node }) => node?.uiImage)) { ui.colorFamilies = wordOf("palette", colors.size); raw.colorFamilies = colors.size; }

  const images = nodes.filter(({ node }) => node?.uiImage);
  if (images.length) {
    const heavy = images.filter(({ node }) => decorationCount(node.uiImage) >= 2).length;
    ui.heavilyDecoratedPanels = wordOf("count", heavy);
    const gloss = images.filter(({ node }) => (node.uiImage?.gradientScrollSpeed ?? 0) > 0).length;
    ui.animatedGloss = wordOf("count", gloss);
    Object.assign(raw, { heavilyDecoratedPanels: heavy, animatedGloss: gloss });
  }
  if (texts.length) {
    const fx = texts.filter(({ node }) => node.uiText?.charAnim || (node.uiText?.outlineWidth ?? 0) > 0
      || (node.uiText?.shadowAlpha ?? 0) > 0).length;
    ui.textEffects = wordOf("count", fx);
    raw.textEffects = fx;
  }
  Object.assign(raw, { interactive: interactive.length, texts: texts.length });

  const byCode = new Map<UiJudgedCode, UiIssue[]>();
  for (const is of audit.issues) {
    if (!isUiJudgedCode(is.code)) continue;
    byCode.set(is.code, [...(byCode.get(is.code) ?? []), is]);
  }
  ui.issues = [...byCode.entries()].map(([code, list]) => {
    const names = [...new Set(list.map((i) => stripSerial(i.name)).filter(Boolean))].slice(0, 3);
    return { code, issue: UI_ISSUE_TEXT[code], severity: SEVERITY_WORD[list[0].severity], ...(names.length ? { targets: names } : {}) };
  });

  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ui)) if (v !== undefined) clean[k] = v;
  return { ui: clean as UiFacts, raw };
}

/** facts.ui の語彙(評価ケースの手書きが本番とずれていないかの検査用)。 */
export const UI_VOCAB: Record<string, readonly string[]> = {
  screen: Object.values(SCREEN_WORD),
  interactiveElements: BINS.count.words,
  textElements: BINS.count.words,
  horizontalLayout: ["中央に集まっている", "左に寄っている", "右に寄っている", "左右に分かれている", "ばらけている"],
  verticalLayout: ["上に寄っている", "下に寄っている", "中段に集まっている", "上下に散っている"],
  centeredShare: BINS.centered.words,
  fontSizeKinds: BINS.kinds.words,
  colorFamilies: BINS.palette.words,
  heavilyDecoratedPanels: BINS.count.words,
  animatedGloss: BINS.count.words,
  textEffects: BINS.count.words,
};

export function isUiWord(key: string, word: unknown): boolean {
  if (key === "labels") return Array.isArray(word) && word.every((w) => typeof w === "string" && !/[0-9０-９]/.test(w));
  if (key === "issues") return Array.isArray(word);
  return typeof word === "string" && (UI_VOCAB[key] ?? []).includes(word);
}

// ────────────────────────────────────────────────────────────────
//  plan → ask → interpret
// ────────────────────────────────────────────────────────────────

export const UI_BRIEF_FIT_LEVELS = ["Brief と逆", "ほぼ外れ", "どちらでもない", "だいたい合う", "よく合う"] as const;

export type UiJudgeInput = {
  brief: Brief | null | undefined;
  tree: any;
  audit: { issues: UiIssue[]; metrics?: any };
  strictness?: "balanced" | "strict";
  screen?: UiScreen | string;
};

export type UiJudge = JudgeBase & {
  briefFit: { value: number; level: string; outOf: number; confidence?: number; decided?: unknown } | null;
  /** 意図どおり(keep)と判断した指摘を除いて数え直した結果。 */
  passExcludingKept: boolean;
  scoreExcludingKept: number;
  gradeExcludingKept: string;
  /** 指摘があったが Jev に聞かないコード(機能の欠陥。ルールのまま)。 */
  notAsked: string[];
  next?: string;
};

export const UI_LOOK: LookHint = { tool: "dx12_ui_screenshot", args: {} };

export function planUi(input: UiJudgeInput): JudgePlan & { codes: UiJudgedCode[] } {
  const { ui } = wordifyUi(input.tree, input.audit, input.screen);
  const codes = ui.issues.map((i) => i.code);
  const refs: QuestionRef[] = ["ui.brief_fit", ...codes.map((code) => ({ id: "ui.finding_intended", vars: { code } }))];
  return { facts: { ui }, refs, codes };
}

function excluding(input: UiJudgeInput, kept: Set<string>) {
  const rest = input.audit.issues.filter((i) => !kept.has(i.code));
  return scoreUiIssues(rest, input.strictness ?? "balanced");
}

/** ルールだけの judge(鍵なし・Brief なし・Jev 失敗)。指摘は全部採る(＝従来どおり)。 */
export function rulesUiJudge(input: UiJudgeInput, reason: string, briefMissing?: boolean): UiJudge {
  const s = excluding(input, new Set());
  const codes = [...new Set(input.audit.issues.map((i) => i.code))];
  return {
    source: "rules", ...(briefMissing ? { briefMissing: true } : {}), reason,
    briefFit: null,
    findings: codes.filter(isUiJudgedCode).map((code) => ({ code, intended: null, keep: false })),
    uncertain: [],
    passExcludingKept: s.pass, scoreExcludingKept: s.score, gradeExcludingKept: s.grade,
    notAsked: codes.filter((c) => !isUiJudgedCode(c)),
    cost: { requests: 0, tokens: 0, usd: 0, ms: 0 },
  };
}

/**
 * ask の答え(plan.refs と同じ順)→ judge。out は費用と Brief の有無のため(ゲートでは束ねた 1 往復の値)。
 * 例外は投げない。
 */
export function interpretUi(input: UiJudgeInput, plan: ReturnType<typeof planUi>, results: JevResult[],
                            out: Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms" | "briefMissing" | "results"> | null): UiJudge {
  const [fitRes, ...findRes] = results;
  if (![fitRes, ...findRes].some(live)) {
    return { ...rulesUiJudge(input, rulesReason(out ? { ...out, results } : null), out?.briefMissing), cost: costOf(out) };
  }
  const uncertain: UncertainItem[] = [];
  const briefFit = live(fitRes) && typeof fitRes.value === "number"
    ? {
        value: Number(fitRes.value.toFixed(2)),
        level: UI_BRIEF_FIT_LEVELS[Math.max(0, Math.min(UI_BRIEF_FIT_LEVELS.length - 1, Math.round(fitRes.value)))],
        outOf: UI_BRIEF_FIT_LEVELS.length - 1,
        confidence: fitRes.confidence, decided: fitRes.decided,
      }
    : null;
  if (live(fitRes) && fitRes.uncertain) uncertain.push({ id: fitRes.id, why: fitRes.reason ?? "境界付近", look: UI_LOOK });

  const findings = plan.codes.map((code, i) => {
    const r = findRes[i];
    if (!live(r)) return { code, intended: null, keep: false };
    if (r.uncertain) uncertain.push({ id: r.id, why: r.reason ?? "境界付近", look: UI_LOOK });
    return { code, intended: typeof r.value === "number" ? Number(r.value.toFixed(3)) : null,
             keep: r.decided === true, ...(r.uncertain ? { uncertain: true } : {}) };
  });
  const kept = new Set(findings.filter((f) => f.keep).map((f) => f.code));
  const s = excluding(input, kept);
  const allCodes = [...new Set(input.audit.issues.map((i) => i.code))];
  return {
    source: sourceOf([fitRes, ...findRes]),
    briefFit, findings, uncertain,
    passExcludingKept: s.pass, scoreExcludingKept: s.score, gradeExcludingKept: s.grade,
    notAsked: allCodes.filter((c) => !isUiJudgedCode(c)),
    cost: costOf(out),
    next: uncertain.length
      ? "uncertain がある。dx12_ui_screenshot で画面を自分の目で見て、そこだけは Claude が判断すること"
      : kept.size
        ? "keep:true の指摘は Brief に照らすと意図どおり＝直さない。残りの issues の fix を上から直す"
        : "issues の fix を上から直す(判断段はどれも意図どおりとは見ていない)",
  };
}

export const UI_RULES = {} as const;

/** 判断段の本体。例外は投げない。 */
export async function judgeUi(input: UiJudgeInput & { askOptions?: AskOptions }): Promise<UiJudge> {
  const plan = planUi(input);
  const out = await ask(plan.refs, { brief: input.brief ?? null, facts: plan.facts }, input.askOptions ?? {});
  return interpretUi(input, plan, out.results, out);
}
