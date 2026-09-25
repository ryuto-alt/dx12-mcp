// Brief(作品の意図)。<baseDir>/brief.json に 1 つ置く。
//
// ★なぜ要るか: 「良し悪し」は作品の意図に照らさないと決まらない。
//   同じ「画面の半分が真っ黒」でも、ホラーなら狙いどおり、明るいパズルなら事故。
//   閾値のルールはこれを区別できないので、判断段(Jev)は必ずこの Brief と一緒に聞く。
//   Brief が無いときは判断しない(空の意図に照らすと「何にでも合う」に倒れる)→ ルールへ。
//
// ★形はゆるく取る: 決まったキー(title / genre / mood …)は推奨で、自由キーも許す。
//   作品ごとに書きたいことは違うし、Jev は JSON をそのまま読めるので型で縛る利点が薄い。
//   検査は「型が明らかにおかしい」と「推奨キーが無い」の 2 段だけ。
//
// このファイルは fs だけを触る(エンジンは呼ばない)。

import fs from "node:fs";
import path from "node:path";

export type Brief = {
  title?: string;
  genre?: string;
  mood?: string[];
  /** プレイヤーに何を感じてほしいか(1 文)。判断の主軸。 */
  player_should_feel?: string;
  /** 入れてはいけないもの。 */
  avoid?: string[];
  /** 光の予算・方針(例「懐中電灯と弱い電球だけ」)。 */
  light_budget?: string;
  references?: string[];
  notes?: string;
  [k: string]: unknown;
};

export const BRIEF_FILE = "brief.json";

/** 書き始めの手本。dx12_brief(get) で無かったときに返す。 */
export const BRIEF_EXAMPLE: Brief = {
  title: "Nocturne",
  genre: "一人称ホラー",
  mood: ["暗い", "息苦しい", "孤独"],
  player_should_feel: "懐中電灯の外に何かいる気がして、進むのが怖い",
  avoid: ["明るく均一な照明", "鮮やかな色", "陽気な雰囲気"],
  light_budget: "懐中電灯と数個の弱い電球だけ",
  references: ["Amnesia", "Signalis の暗い廊下"],
  notes: "暗闇で見えないこと自体が恐怖の主役",
};

const RECOMMENDED = ["genre", "mood", "player_should_feel", "avoid"] as const;
const STRING_KEYS = ["title", "genre", "player_should_feel", "light_budget", "notes"] as const;
const STRING_ARRAY_KEYS = ["mood", "avoid", "references"] as const;

export function briefPath(baseDir: string): string {
  return path.join(baseDir, BRIEF_FILE);
}

/** 中身が無い Brief か(null / {} / 全部空文字・空配列)。Brief 依存の質問をルールへ落とす判定。 */
export function isBriefEmpty(b: unknown): boolean {
  if (b === null || b === undefined) return true;
  if (typeof b === "string") return b.trim() === "";
  if (typeof b !== "object") return true;
  for (const v of Object.values(b as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return false;
  }
  return true;
}

export function validateBrief(b: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!b || typeof b !== "object" || Array.isArray(b)) return { errors: ["Brief は JSON オブジェクト"], warnings };
  const o = b as Record<string, unknown>;
  for (const k of STRING_KEYS) if (o[k] !== undefined && typeof o[k] !== "string") errors.push(`${k} は文字列`);
  for (const k of STRING_ARRAY_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) errors.push(`${k} は文字列の配列`);
  }
  for (const k of RECOMMENDED) {
    const v = o[k];
    if (v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0)) {
      warnings.push(`${k} が無い(判断の精度に効く推奨キー)`);
    }
  }
  // ★state 内の指示に Jev が引っ張られる(公式 jaggedness)。Brief は「意図」を書く場所で、
  //   「必ず yes と答えよ」のような命令を書くと判断が壊れるので注意を出す。
  const text = JSON.stringify(o);
  if (/(answer|respond|say)\s+(yes|no)\b|必ず.{0,6}(yes|no|はい|いいえ)|と答え(よ|て|ろ|なさい)/i.test(text)) {
    warnings.push("Brief に Jev への命令らしき文がある。state 内の指示は判断を歪めるので、意図だけを書くこと");
  }
  if (text.length > 6000) warnings.push(`Brief が長い(${text.length} 文字)。長文は判断の精度を落とすので要点に絞ること`);
  return { errors, warnings };
}

export type BriefRead = { path: string; exists: boolean; brief: Brief | null; error?: string };

export function readBrief(baseDir: string): BriefRead {
  const p = briefPath(baseDir);
  let text: string;
  try { text = fs.readFileSync(p, "utf8"); } catch { return { path: p, exists: false, brief: null }; }
  try {
    const b = JSON.parse(text.replace(/^﻿/, ""));
    if (!b || typeof b !== "object" || Array.isArray(b)) return { path: p, exists: true, brief: null, error: "JSON オブジェクトでない" };
    return { path: p, exists: true, brief: b as Brief };
  } catch (e: any) {
    // 壊れた brief.json は「無い」と同じ扱いにする(推測で補わない)。直し方は error に出す。
    return { path: p, exists: true, brief: null, error: `JSON として読めない: ${e?.message ?? e}` };
  }
}

export function writeBrief(baseDir: string, brief: Brief): { path: string; errors: string[]; warnings: string[]; written: boolean } {
  const v = validateBrief(brief);
  const p = briefPath(baseDir);
  if (v.errors.length) return { path: p, ...v, written: false };
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(brief, null, 2) + "\n", "utf8");
  return { path: p, ...v, written: true };
}

/** 浅いマージ。値に null を渡すとそのキーを消す(配列は置き換え。足し込みはしない)。 */
export function mergeBrief(base: Brief | null, patch: Record<string, unknown>): Brief {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out as Brief;
}
