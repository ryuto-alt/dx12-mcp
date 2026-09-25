// プレイテストの判断段。到達判定(autoplay の cleared)・リプレイ比較(compareReplay の合否)は
// ルールのまま触らず、「なぜ・どれくらい困っているか」の説明だけを Jev に聞く。
//
// ★なぜ要るか: 今の結果は「t=4.20s で経路が 6.10m ずれた。そこで引っかかったか落ちた可能性」のような
//   固定文で、何が悪いのかは AI が軌跡の数字を読んで推測していた。しかも同じ「止まって見回した」が
//   ホラーでは狙いどおりの慎重さ、明るいパズルでは迷子、と作品しだいで意味が変わる。
//
// ★流れ: 軌跡(10Hz の位置と向き)+ 入力 → 区間ごとの事実(止まっていた割合・進もうとして動けない割合・
//   行き来・落下・戻された回数・見回し・その場ジャンプ・ゴールへの進み)を TS で数える → 言葉のビンへ →
//   play.confusion(score: Brief が狙っていない迷い・苛立ちの度合い)と play.cause(choice: 主な原因)を 1 往復で聞く。
//   Jev は数を数えられないので、数えるのは全部ここ。区間は最大 4 つ(長い state は精度が落ちる)。
//
// ★原因の選択肢は「ここで数えた事実で区別できるものだけ」: 道が分からない(見回し + 行き来)/
//   目的が分からない(ゴールへ一度も近づかない)/ 跳躍が難しすぎる(落下・その場ジャンプ・静的解析の届かない隙間)/
//   地形に引っかかる(進もうとしているのに動けない)/ 落下以外でやられる(戻されたのに直前に落ちていない)/ 問題なし。
//   「カメラ・操作が悪い」は入れていない: 10Hz のカメラ角度だけでは「カメラが暴れている」と
//   「プレイヤーが見回している」を区別できない(区別できない選択肢は Jev の当て推量になる)。
//
// ★誰の軌跡か: 人のプレイ(get_play_session / record_playtest)は confusion と cause の両方を聞く。
//   機械の軌跡(autoplay = ナビメッシュを機械がなぞる / replay = 記録した入力の再生)は cause だけ聞く。
//   機械は迷わないので「迷いの度合い」を聞いても意味が無い。facts.play.player で誰の軌跡かを Jev に伝える。

import { ask, loadLibrary, type AskOptions, type AskOutcome, type JevResult, type QuestionRef, type RuleFn } from "./library.ts";
import {
  costOf, live, rulesReason, sourceOf,
  type JudgeBase, type JudgePlan, type LookHint, type UncertainItem,
} from "./judgeCommon.ts";
import { BINS, wordOf } from "./wordify.ts";
import type { Brief } from "./brief.ts";

export type Vec3 = [number, number, number];
export type PlayPoint = { t: number; pos: Vec3; yaw?: number };
export type PlayEvent = { t: number; kind: string; detail: string };
export type PlayKind = "human" | "autoplay" | "replay";

export type PlayInput = {
  kind: PlayKind;
  points: PlayPoint[];
  /** 入力とログ(人のプレイ / 再生した記録の入力)。 */
  events?: PlayEvent[];
  goal?: Vec3 | null;
  /** autoplay の到達判定(ルールの結論をそのまま渡す)。 */
  cleared?: boolean;
  /** replay の比較結果(ルールの結論)。 */
  deviation?: { pass: boolean; maxDeviationAt: number; maxDeviation: number } | null;
  /** check_reachable(analyzePath)の静的な指摘。 */
  staticIssues?: { reason: string }[];
};

// ── 数え方の定数(区間の事実の定義。変えたら評価ケースも作り直すこと) ──
export const STILL_SPEED = 0.4;        // m/s 未満 = 止まっている
export const TELEPORT_M = 4;           // 1 サンプルでこれ以上動いたら「戻された(ワープ)」
export const TELEPORT_SPEED = 15;      // m/s。これを超える移動もワープ扱い(歩き・落下では出ない)
export const FALL_DROP_M = 3;          // この高さ以上を
export const FALL_SPEED = 3;           // この速さ(m/s)以上で下ったら落下(ジャンプの着地や階段は入らない)
export const REVISIT_NEAR_M = 2;       // 前に居た点のこの距離まで戻ったら
export const REVISIT_AWAY_M = 5;       // 途中でこれだけ離れていて
export const REVISIT_GAP_S = 5;        // これだけ時間が経っていれば「行き来」
export const JUMP_IN_PLACE_M = 1.5;    // ジャンプの前後 ±1 秒でこれ未満しか動いていない = その場ジャンプ
export const SECTION_S = 15;           // 区間の目安の長さ(最大 4 区間)
const MOVE_KEYS = new Set(["W", "A", "S", "D", "UP", "DOWN", "LEFT", "RIGHT"]);
const JUMP_KEYS = new Set(["SPACE"]);

const hdist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrapDeg = (a: number) => { let d = ((a + 180) % 360 + 360) % 360 - 180; if (d === -180) d = 180; return d; };

export const SECTION_LABELS: Record<number, string[]> = {
  1: ["全体"], 2: ["前半", "後半"], 3: ["序盤", "中盤", "終盤"], 4: ["序盤", "中盤の前", "中盤の後", "終盤"],
};

export type SectionMetrics = {
  label: string; t0: number; t1: number;
  stillShare: number;
  /** 移動キーを押しているのに動いていない割合(入力が分からなければ null)。 */
  pushStuckShare: number | null;
  revisits: number;
  falls: number;
  sentBackAfterFall: number;
  sentBackOther: number;
  /**
   * 見回しの速さ = 立ち止まっている間のカメラの振り(度/秒)。向きが無ければ null。
   * ★歩きながらの向き変えは「舵取り」なので数えない(数えると、よく曲がるコースを歩くだけで「見回している」になる)。
   */
  lookRate: number | null;
  /** その場ジャンプの回数(入力が分からなければ null)。 */
  jumpsInPlace: number | null;
  goalStart: number | null;
  goalEnd: number | null;
  errors: number | null;
  /** その区間で一番長く止まっていた場所(見に行く視点の目安)。 */
  stuckSpot: Vec3 | null;
};

/** 押しっぱなしの移動キーの区間 [t0, t1)。 */
function heldIntervals(events: PlayEvent[], keys: Set<string>, tEnd: number): [number, number][] {
  const out: [number, number][] = [];
  const down = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const k = String(e.detail ?? "").toUpperCase();
    if (!keys.has(k)) continue;
    if (e.kind === "key_down" && !down.has(k)) down.set(k, e.t);
    else if (e.kind === "key_up" && down.has(k)) { out.push([down.get(k)!, e.t]); down.delete(k); }
  }
  for (const t0 of down.values()) out.push([t0, tEnd]);
  return out;
}

const inAny = (t: number, iv: [number, number][]) => iv.some(([a, b]) => t >= a && t < b);

/**
 * 軌跡 → 区間ごとの事実(数値)。純関数。
 * ★落下とワープは先に全体で見つけてから区間へ振る(区間の境目で 1 回の落下が 2 回に割れないように)。
 */
export function playMetrics(input: PlayInput): { sections: SectionMetrics[]; duration: number; goalMin: number | null } {
  const pts = [...input.points].filter((p) => Number.isFinite(p.t) && p.pos.every(Number.isFinite)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return { sections: [], duration: 0, goalMin: null };
  const T0 = pts[0].t, T1 = pts[pts.length - 1].t;
  const duration = Math.max(0, T1 - T0);
  const events = input.events ?? [];
  const hasInput = input.kind === "autoplay" || events.some((e) => e.kind === "key_down");
  const moveHeld = input.kind === "autoplay" ? [[T0, T1 + 1] as [number, number]] : heldIntervals(events, MOVE_KEYS, T1 + 1);

  // ── ワープ(戻された)と落下 ──
  const teleports: { t: number; i: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(1e-3, pts[i].t - pts[i - 1].t);
    const d = dist3(pts[i].pos, pts[i - 1].pos);
    if (d > TELEPORT_M && d / dt > TELEPORT_SPEED) teleports.push({ t: pts[i].t, i });
  }
  const isTeleportStep = new Set(teleports.map((x) => x.i));
  const falls: { tEnd: number }[] = [];
  {
    let start = 0;
    for (let i = 1; i <= pts.length; i++) {
      // ★実際に下っている段だけを繋ぐ(平らな所まで繋ぐと、歩いた時間で割って落下が遅く見える)
      const descending = i < pts.length && !isTeleportStep.has(i) && pts[i].pos[1] < pts[i - 1].pos[1] - 0.005;
      if (descending) continue;
      const end = i - 1;
      const drop = pts[start].pos[1] - pts[end].pos[1];
      const dur = Math.max(1e-3, pts[end].t - pts[start].t);
      if (drop >= FALL_DROP_M && drop / dur >= FALL_SPEED) falls.push({ tEnd: pts[end].t });
      start = i;
    }
  }
  const sentBack = teleports.map((tp) => ({
    t: tp.t,
    // 直前 3 秒以内に落下が終わっている(または落下の途中でワープした) = 落ちて戻された
    afterFall: falls.some((f) => f.tEnd <= tp.t && tp.t - f.tEnd <= 3),
  }));

  // ── 行き来(前に居た所へ戻ってきた回数) ──
  const leaveIdx = new Array<number>(pts.length).fill(-1);
  for (let j = 0; j < pts.length; j++) {
    for (let k = j + 1; k < pts.length; k++) if (hdist(pts[k].pos, pts[j].pos) >= REVISIT_AWAY_M) { leaveIdx[j] = k; break; }
  }
  const revisitTimes: number[] = [];
  let cooldownUntil = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].t < cooldownUntil) continue;
    for (let j = 0; j < i; j++) {
      if (pts[i].t - pts[j].t < REVISIT_GAP_S) break;
      if (leaveIdx[j] < 0 || leaveIdx[j] >= i) continue;
      if (hdist(pts[i].pos, pts[j].pos) < REVISIT_NEAR_M) {
        // ワープで戻されたのは行き来に数えない(それは sentBack)
        if (teleports.some((tp) => tp.t > pts[j].t && tp.t <= pts[i].t)) continue;
        revisitTimes.push(pts[i].t);
        cooldownUntil = pts[i].t + 3;
        break;
      }
    }
  }

  // ── その場ジャンプ ──
  const posAt = (t: number): Vec3 => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best.pos;
  };
  const jumpTimes = input.kind === "autoplay" ? null : events
    .filter((e) => e.kind === "key_down" && JUMP_KEYS.has(String(e.detail ?? "").toUpperCase()))
    .map((e) => e.t)
    .filter((t) => hdist(posAt(t - 1), posAt(t + 1)) < JUMP_IN_PLACE_M);

  const goal = input.goal ?? null;
  const goalMin = goal ? Math.min(...pts.map((p) => hdist(p.pos, goal))) : null;
  const K = Math.max(1, Math.min(4, Math.ceil(duration / SECTION_S)));
  const labels = SECTION_LABELS[K];
  const sections: SectionMetrics[] = [];
  for (let s = 0; s < K; s++) {
    const t0 = T0 + (duration * s) / K, t1 = T0 + (duration * (s + 1)) / K;
    const last = s === K - 1;
    const inSec = (t: number) => t >= t0 && (last ? t <= t1 : t < t1);
    let still = 0, push = 0, lookStill = 0, span = 0, runStart = -1, bestRun = 0, bestSpot: Vec3 | null = null, run = 0;
    let lookSeen = false;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!inSec(a.t)) continue;
      const dt = b.t - a.t;
      if (dt <= 0 || isTeleportStep.has(i)) continue;
      span += dt;
      const v = hdist(a.pos, b.pos) / dt;
      const turn = a.yaw !== undefined && b.yaw !== undefined ? Math.abs(wrapDeg(b.yaw - a.yaw)) : null;
      if (turn !== null) lookSeen = true;
      if (v < STILL_SPEED) {
        still += dt;
        if (turn !== null) lookStill += turn;
        if (inAny(a.t, moveHeld)) push += dt;
        if (runStart < 0) runStart = i - 1;
        run += dt;
        if (run > bestRun) { bestRun = run; bestSpot = pts[runStart].pos; }
      } else { runStart = -1; run = 0; }
    }
    const dur = Math.max(1e-3, span);
    const secPts = pts.filter((p) => inSec(p.t));
    sections.push({
      label: labels[s], t0, t1,
      stillShare: Math.min(1, still / dur),
      pushStuckShare: hasInput ? Math.min(1, push / dur) : null,
      revisits: revisitTimes.filter(inSec).length,
      falls: falls.filter((f) => inSec(f.tEnd)).length,
      sentBackAfterFall: sentBack.filter((x) => x.afterFall && inSec(x.t)).length,
      sentBackOther: sentBack.filter((x) => !x.afterFall && inSec(x.t)).length,
      // 立ち止まりが 0.5 秒未満なら「見回していない」(ほんの一瞬の停止で割ると値が暴れる)
      lookRate: lookSeen ? (still >= 0.5 ? lookStill / still : 0) : null,
      jumpsInPlace: jumpTimes ? jumpTimes.filter(inSec).length : null,
      goalStart: goal && secPts.length ? hdist(secPts[0].pos, goal) : null,
      goalEnd: goal && secPts.length ? hdist(secPts[secPts.length - 1].pos, goal) : null,
      errors: input.kind === "human" ? events.filter((e) => e.kind === "error" && inSec(e.t)).length : null,
      stuckSpot: bestRun >= 1 ? bestSpot : null,
    });
  }
  return { sections, duration, goalMin };
}

// ────────────────────────────────────────────────────────────────
//  数値 → 言葉
// ────────────────────────────────────────────────────────────────

export const PLAYER_WORD: Record<PlayKind, string> = {
  human: "人のプレイ",
  autoplay: "自動操縦(ナビメッシュの経路を機械がなぞった。迷うことはない)",
  replay: "記録した人の入力を機械が再生した(入力は記録どおりで、迷うことはない)",
};

export type PlaySectionWords = {
  section: string;
  standingStill?: string;
  pushingWithoutMoving?: string;
  backtracking?: string;
  falls?: string;
  sentBackAfterFall?: string;
  sentBackWithoutFall?: string;
  lookingAround?: string;
  jumpsInPlace?: string;
  towardGoal?: string;
  goalDistance?: string;
  scriptErrors?: string;
};

export type PlayFacts = {
  player: string;
  length?: string;
  outcome: string;
  sections: PlaySectionWords[];
  hardestSection?: string;
  deviation?: string;
  staticCheck?: string[];
};

/** 区間の「困りごとの強さ」。一番困っている区間を名指しするためだけに使う(Jev には渡さない)。 */
export function troubleOf(s: SectionMetrics): number {
  return s.stillShare + (s.pushStuckShare ?? 0) + 0.5 * s.revisits + s.falls + s.sentBackAfterFall + s.sentBackOther
    + ((s.lookRate ?? 0) >= 45 ? 0.5 : 0) + 0.3 * (s.jumpsInPlace ?? 0);
}

function towardWord(s: SectionMetrics): string | undefined {
  if (s.goalStart === null || s.goalEnd === null) return undefined;
  if (s.goalEnd < s.goalStart - 2) return "近づいた";
  if (s.goalEnd > s.goalStart + 2) return "遠ざかった";
  return "変わらない";
}

/** 静的解析(analyzePath)の理由文 → 数値を含まない言葉。 */
export function staticWords(issues: { reason: string }[] | undefined): string[] | undefined {
  if (!issues?.length) return undefined;
  const out = new Set<string>();
  for (const i of issues) {
    if (/跳び越し/.test(i.reason)) out.add("実測のジャンプ距離では届かない隙間がある");
    else if (/登り/.test(i.reason)) out.add("実測のジャンプ高では登れない段差がある");
    else if (/落下/.test(i.reason)) out.add("落ちたら自力で戻れない区間がある");
  }
  return out.size ? [...out] : undefined;
}

export function wordifyPlay(input: PlayInput): { play: PlayFacts; metrics: ReturnType<typeof playMetrics> } {
  const m = playMetrics(input);
  const sections: PlaySectionWords[] = m.sections.map((s) => {
    const w: PlaySectionWords = {
      section: s.label,
      standingStill: wordOf("ratio", s.stillShare),
      pushingWithoutMoving: s.pushStuckShare === null ? undefined : wordOf("ratio", s.pushStuckShare),
      backtracking: wordOf("count", s.revisits),
      falls: wordOf("count", s.falls),
      sentBackAfterFall: wordOf("count", s.sentBackAfterFall),
      sentBackWithoutFall: wordOf("count", s.sentBackOther),
      lookingAround: s.lookRate === null ? undefined : wordOf("lookRate", s.lookRate),
      jumpsInPlace: s.jumpsInPlace === null ? undefined : wordOf("count", s.jumpsInPlace),
      towardGoal: towardWord(s),
      goalDistance: s.goalEnd === null ? undefined : wordOf("goalDistance", s.goalEnd),
      scriptErrors: s.errors === null || s.errors === 0 ? undefined : wordOf("count", s.errors),
    };
    for (const k of Object.keys(w) as (keyof PlaySectionWords)[]) if (w[k] === undefined) delete w[k];
    return w;
  });
  let outcome = "ゴールは指定されていない";
  if (input.kind === "autoplay" && input.cleared !== undefined) outcome = input.cleared ? "ゴールに着いた" : "ゴールに着かなかった";
  else if (m.goalMin !== null) outcome = m.goalMin < 2.5 ? "ゴールに着いた" : "ゴールに着かなかった";
  const play: PlayFacts = {
    player: PLAYER_WORD[input.kind],
    ...(m.duration > 0 ? { length: wordOf("playLength", m.duration) } : {}),
    outcome,
    sections,
  };
  if (m.sections.length > 1) {
    const worst = [...m.sections].sort((a, b) => troubleOf(b) - troubleOf(a))[0];
    if (troubleOf(worst) >= 0.5) play.hardestSection = worst.label;
  }
  if (input.deviation && !input.deviation.pass) {
    const sec = m.sections.find((s) => input.deviation!.maxDeviationAt >= s.t0 && input.deviation!.maxDeviationAt <= s.t1);
    play.deviation = `${sec?.label ?? "途中"}で記録の経路から大きく外れた`;
  }
  const st = staticWords(input.staticIssues);
  if (st) play.staticCheck = st;
  return { play, metrics: m };
}

export const PLAY_VOCAB: Record<string, readonly string[]> = {
  player: Object.values(PLAYER_WORD),
  length: BINS.playLength.words,
  outcome: ["ゴールに着いた", "ゴールに着かなかった", "ゴールは指定されていない"],
  section: [...new Set(Object.values(SECTION_LABELS).flat())],
  hardestSection: [...new Set(Object.values(SECTION_LABELS).flat())],
  standingStill: BINS.ratio.words,
  pushingWithoutMoving: BINS.ratio.words,
  backtracking: BINS.count.words,
  falls: BINS.count.words,
  sentBackAfterFall: BINS.count.words,
  sentBackWithoutFall: BINS.count.words,
  lookingAround: BINS.lookRate.words,
  jumpsInPlace: BINS.count.words,
  towardGoal: ["近づいた", "変わらない", "遠ざかった"],
  goalDistance: BINS.goalDistance.words,
  scriptErrors: BINS.count.words,
  staticCheck: ["実測のジャンプ距離では届かない隙間がある", "実測のジャンプ高では登れない段差がある", "落ちたら自力で戻れない区間がある"],
};

export function isPlayWord(key: string, word: unknown): boolean {
  if (key === "deviation") return typeof word === "string" && /で記録の経路から大きく外れた$/.test(word) && !/[0-9]/.test(word);
  if (key === "staticCheck") return Array.isArray(word) && word.every((w) => PLAY_VOCAB.staticCheck.includes(w));
  if (key === "sections") return Array.isArray(word) && word.every((s: any) => Object.entries(s).every(([k, v]) => isPlayWord(k, v)));
  return typeof word === "string" && (PLAY_VOCAB[key] ?? []).includes(word);
}

// ────────────────────────────────────────────────────────────────
//  ルール(フォールバック)
// ────────────────────────────────────────────────────────────────

const atLeast = (bin: readonly string[], w: string | undefined, min: string) =>
  w !== undefined && bin.indexOf(w) >= bin.indexOf(min);
const cw = BINS.count.words, rw = BINS.ratio.words, lw = BINS.lookRate.words;
const sumCount = (secs: PlaySectionWords[], key: keyof PlaySectionWords) =>
  secs.reduce((a, s) => a + Math.max(0, cw.indexOf(String(s[key] ?? "なし"))), 0);   // なし=0 / ひとつ=1 / 少し以上=2+

/**
 * ルールの原因(言葉の事実から、Brief を見ずに決める)。
 * ★Brief を読まないので、ホラーの慎重な歩き(止まって見回す)を「道が分からない」と言う、のような誤りをする。
 */
export function ruleCause(play: PlayFacts | undefined): string {
  const secs = play?.sections ?? [];
  const machine = !!play && play.player !== PLAYER_WORD.human;
  if (sumCount(secs, "sentBackWithoutFall") >= 2) return "unfair_hazard";
  if (sumCount(secs, "falls") >= 2 || secs.some((s) => atLeast(cw, s.jumpsInPlace, "いくつも"))
      || (play?.staticCheck ?? []).some((w) => /届かない|登れない/.test(w))) return "jump_too_hard";
  if (secs.some((s) => atLeast(rw, s.pushingWithoutMoving, "半分くらい"))) return "stuck_geometry";
  if (!machine && sumCount(secs, "backtracking") >= 2 && secs.some((s) => atLeast(lw, s.lookingAround, "よく見回す"))) return "lost_way";
  if (!machine && play?.outcome === "ゴールに着かなかった" && secs.length > 0 && secs.every((s) => s.towardGoal !== "近づいた")) return "unclear_goal";
  return "none";
}

/** ルールの困り度: 困りごとの印の数(0..4)。 */
export function ruleConfusion(play: PlayFacts | undefined): number {
  const secs = play?.sections ?? [];
  let n = 0;
  if (secs.some((s) => atLeast(rw, s.standingStill, "大半"))) n++;
  if (sumCount(secs, "backtracking") >= 2) n++;
  if (sumCount(secs, "falls") >= 2) n++;
  if (sumCount(secs, "sentBackAfterFall") + sumCount(secs, "sentBackWithoutFall") >= 1) n++;
  if (secs.some((s) => atLeast(lw, s.lookingAround, "激しく見回す"))) n++;
  if (secs.some((s) => atLeast(rw, s.pushingWithoutMoving, "半分くらい"))) n++;
  if (play?.outcome === "ゴールに着かなかった") n++;
  return Math.min(4, n);
}

export const PLAY_RULES: Record<string, RuleFn> = {
  "play.causeRules": ({ context }) => {
    const c = ruleCause(context?.facts?.play);
    return { value: c, decided: c, reason: `ルール: 事実の印から ${c}` };
  },
  "play.confusionRules": ({ context }) => {
    const v = ruleConfusion(context?.facts?.play);
    return { value: v, decided: v, reason: `ルール: 困りごとの印が ${v} つ` };
  },
};

// ────────────────────────────────────────────────────────────────
//  plan → ask → interpret
// ────────────────────────────────────────────────────────────────

export const CONFUSION_LEVELS = ["迷い・苛立ちは無い", "少し迷っている", "はっきり困っている", "強く困っている", "行き詰まっている"] as const;

/** 原因 → 人向けの名前と次の一手。キーは play.cause.jevq.json の criteria と一致(テストで突き合わせる)。 */
export const CAUSES: Record<string, { label: string; hint: string }> = {
  none: { label: "問題なし(Brief どおりの遊び方)", hint: "Brief に照らして想定内。直さなくてよい" },
  lost_way: { label: "道が分からない", hint: "迷った区間に道しるべ(光・色・開けた出口)を足すか分岐を減らす。その場所を dx12_screenshot_from で見る" },
  unclear_goal: { label: "目的が分からない", hint: "最初の数秒でゴールが視界か UI に入るようにする(何をすればいいかを見せる)" },
  jump_too_hard: { label: "跳躍が難しすぎる", hint: "足場の間隔を詰めるか高さを下げる。dx12_check_reachable で区間の隙間と登りを実測と比べる" },
  stuck_geometry: { label: "地形に引っかかる", hint: "動けなかった場所の当たり判定を見る(見えない壁・段差・狭い隙間)。dx12_validate_layout と dx12_screenshot_from" },
  unfair_hazard: { label: "落下以外でやられる(敵・罠)", hint: "やられた場所の敵・罠の配置と強さを見直す(予兆が見えるか・避けられるか)" },
};

export type PlayJudgeInput = PlayInput & { brief: Brief | null | undefined };

export type PlayJudge = JudgeBase & {
  /** 人のプレイだけ。troubled = 合格線(threshold.pass)以上 = Brief が狙っていない迷い・苛立ちがある。 */
  confusion: { value: number; level: string; outOf: number; troubled: boolean; confidence?: number } | null;
  cause: { id: string; label: string; hint: string; confidence: number | null } | null;
  /** Jev に渡した言葉(人が根拠を追えるように)。 */
  words: PlayFacts;
  next?: string;
};

export function planPlay(input: PlayJudgeInput): JudgePlan & { askConfusion: boolean; wordsOut: ReturnType<typeof wordifyPlay> } {
  const w = wordifyPlay(input);
  const askConfusion = input.kind === "human";
  const refs: QuestionRef[] = [...(askConfusion ? ["play.confusion"] : []), "play.cause"];
  return { facts: { play: w.play }, refs: w.metrics.sections.length ? refs : [], askConfusion, wordsOut: w };
}

/** 一番困っている区間を見に行く視点(止まっていた場所の斜め上から)。 */
export function lookForPlay(m: ReturnType<typeof playMetrics>): LookHint {
  const worst = [...m.sections].sort((a, b) => troubleOf(b) - troubleOf(a))[0];
  const p = worst?.stuckSpot;
  if (!p) return { tool: "dx12_get_play_session", args: {} };
  return { tool: "dx12_screenshot_from", args: { position: [p[0] - 3, p[1] + 2.5, p[2] - 3], target: [p[0], p[1] + 0.5, p[2]] } };
}

export function interpretPlay(input: PlayJudgeInput, plan: ReturnType<typeof planPlay>, results: JevResult[],
                              out: Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms" | "briefMissing" | "results"> | null,
                              thresholds: { confusionPass?: number } = {}): PlayJudge {
  const words = plan.wordsOut.play;
  const look = lookForPlay(plan.wordsOut.metrics);
  const confRes = plan.askConfusion ? results[0] : undefined;
  const causeRes = plan.askConfusion ? results[1] : results[0];
  const uncertain: UncertainItem[] = [];
  const pass = thresholds.confusionPass ?? 2;
  let confusion: PlayJudge["confusion"] = null;
  if (confRes && typeof confRes.value === "number") {
    const v = Number(confRes.value);
    confusion = {
      value: Number(v.toFixed(2)),
      level: CONFUSION_LEVELS[Math.max(0, Math.min(4, Math.round(v)))],
      outOf: 4, troubled: v >= pass,
      ...(live(confRes) && confRes.confidence !== undefined ? { confidence: confRes.confidence } : {}),
    };
    if (live(confRes) && confRes.uncertain) uncertain.push({ id: confRes.id, why: confRes.reason ?? "境界付近", look });
  }
  let cause: PlayJudge["cause"] = null;
  if (causeRes && typeof causeRes.value === "string" && CAUSES[causeRes.value]) {
    cause = { id: causeRes.value, ...CAUSES[causeRes.value], confidence: live(causeRes) ? causeRes.confidence ?? null : null };
    if (live(causeRes) && causeRes.uncertain) uncertain.push({ id: causeRes.id, why: causeRes.reason ?? "confidence が低い", look });
    // ★2 つの判断の食い違い: 困っていると言うのに原因が「問題なし」/ 困っていないのに原因がある
    if (confusion && live(confRes) && live(causeRes)) {
      if (confusion.troubled && cause.id === "none") uncertain.push({ id: causeRes.id, why: "困っていると判断したのに原因が「問題なし」", look });
      if (!confusion.troubled && cause.id !== "none" && confusion.value < pass - 1) {
        uncertain.push({ id: causeRes.id, why: `困っていないと判断したのに原因が ${cause.id}`, look });
      }
    }
  }
  const anyLive = [confRes, causeRes].some(live);
  return {
    source: sourceOf([confRes, causeRes]),
    ...(out?.briefMissing ? { briefMissing: true } : {}),
    ...(!anyLive ? { reason: plan.refs.length ? rulesReason(out ? { ...out, results } : null) : "軌跡が短すぎて数えられない" } : {}),
    // プレイの判断は keep を出さない(到達・再生の合否はルールのまま。Jev は説明だけ)
    findings: [],
    uncertain,
    confusion, cause, words,
    cost: costOf(out),
    next: uncertain.length
      ? `uncertain がある。${look.tool} で困った場所を自分の目で見て決めること`
      : cause && cause.id !== "none" ? cause.hint : undefined,
  };
}

/** 判断段の本体。例外は投げない。 */
export async function judgePlay(input: PlayJudgeInput & { askOptions?: AskOptions; confusionPass?: number }): Promise<PlayJudge> {
  const plan = planPlay(input);
  if (plan.refs.length === 0) return interpretPlay(input, plan, [], null);
  const out = await ask(plan.refs, { brief: input.brief ?? null, facts: plan.facts },
    { ...input.askOptions, rules: { ...PLAY_RULES, ...input.askOptions?.rules } });
  const lib = input.askOptions?.library;
  const pass = input.confusionPass ?? (lib?.questions.get("play.confusion")?.threshold?.pass
    ?? loadConfusionPass(input.askOptions?.baseDir));
  return interpretPlay(input, plan, out.results, out, { confusionPass: pass });
}

/** 質問ファイルの合格線(困っている線)。ライブラリを渡されなかったときだけ読む。 */
function loadConfusionPass(baseDir?: string | null): number | undefined {
  try { return loadLibrary({ baseDir }).questions.get("play.confusion")?.threshold?.pass; } catch { return undefined; }
}

// ────────────────────────────────────────────────────────────────
//  入力の作り方(エンジンの返り値 → PlayInput)
// ────────────────────────────────────────────────────────────────

/** get_play_session の生 JSON → 人のプレイ。camPos は視点の位置(一人称なら頭)。 */
export function fromSession(session: any, goal?: Vec3 | null): PlayInput {
  const points: PlayPoint[] = (session?.samples ?? [])
    .filter((s: any) => Array.isArray(s?.camPos))
    .map((s: any) => ({ t: Number(s.t), pos: [Number(s.camPos[0]), Number(s.camPos[1]), Number(s.camPos[2])] as Vec3,
                        ...(typeof s.camYaw === "number" ? { yaw: s.camYaw } : {}) }));
  const events: PlayEvent[] = (session?.events ?? []).map((e: any) => ({ t: Number(e.t), kind: String(e.kind), detail: String(e.detail ?? "") }));
  return { kind: "human", points, events, goal: goal ?? null };
}

/** 台本(.playtest の steps)→ 入力イベント(再生の「進もうとしていたか」「跳んだか」を数えるため)。 */
export function eventsFromSteps(steps: { t: number; down?: string | string[]; up?: string | string[]; press?: string | string[] }[]): PlayEvent[] {
  const arr = (v?: string | string[]) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const out: PlayEvent[] = [];
  for (const s of steps ?? []) {
    for (const k of arr(s.down)) out.push({ t: s.t, kind: "key_down", detail: k });
    for (const k of arr(s.up)) out.push({ t: s.t, kind: "key_up", detail: k });
    for (const k of arr(s.press)) { out.push({ t: s.t, kind: "key_down", detail: k }); out.push({ t: s.t + 1 / 60, kind: "key_up", detail: k }); }
  }
  return out;
}

/** TraceSample[](autoplay / replay の軌跡)→ PlayPoint[]。 */
export function pointsFromTrace(trace: { t: number; pos: number[]; yaw?: number }[]): PlayPoint[] {
  return (trace ?? []).map((s) => ({ t: s.t, pos: [s.pos[0], s.pos[1], s.pos[2]] as Vec3, ...(s.yaw !== undefined ? { yaw: s.yaw } : {}) }));
}
