// 判断段どうしで共有する型と小道具。polish_audit / ui_audit / validate_layout / プレイテスト /
// quality_gate の judge が同じ形になるよう、共通フィールドはここで 1 回だけ定義する。
//
// ★共通フィールド: { source, briefMissing?, reason?, findings[{code, intended, keep}], uncertain[], cost }
//   呼ぶ側(Claude)が「judge が付いたツール」をどれも同じ読み方で扱えるようにするため。
//   ツール固有のもの(briefFit / nextFix / confusion / cause …)はその外側に足す。
//
// ★各判断は「plan(聞く質問と材料を作る) → ask(1 往復) → interpret(答えを judge にする)」の 3 段に分けてある。
//   単体のツールは 3 段を続けて呼ぶだけだが、dx12_quality_gate は全部の plan を集めてから
//   ask を 1 回だけ撃ち、答えを各 interpret へ配り直す(＝検査が何本あっても Jev は 1 往復)。

import type { AskOutcome, JevResult, QuestionRef } from "./library.ts";

export type JudgeSource = "jev" | "cache" | "rules";

/** Claude が「自分の目で見る」ためのツール呼び出し。そのまま撃てる形で返す。 */
export type LookHint = { tool: string; args: Record<string, unknown> };

export type UncertainItem = {
  /** 質問のインスタンス id(例 "ui.finding_intended#BUSY_GLOSS")。 */
  id: string;
  why: string;
  /** 見るためのツール呼び出し例。 */
  look?: LookHint;
};

/** 指摘 1 件への判断。intended は noul の yes 確率(ルールのときは null)。 */
export type JudgedFinding = {
  code: string;
  intended: number | null;
  keep: boolean;
  uncertain?: boolean;
  /** 同じ code が複数あるときの見分け(配置の指摘は 1 件ずつ聞くので ref が付く)。 */
  ref?: string;
  entityId?: number;
  name?: string;
};

export type JudgeCost = { requests: number; tokens: number; usd: number; ms: number };

export type JudgeBase = {
  source: JudgeSource;
  briefMissing?: boolean;
  reason?: string;
  findings: JudgedFinding[];
  uncertain: UncertainItem[];
  cost: JudgeCost;
};

/** plan の結果。context は ask に渡す材料(brief は呼ぶ側が足す)、refs は聞く質問。 */
export type JudgePlan = {
  /** context.facts の下に入れる部分({ui:…} / {layout:…} / {play:…} / {look, findings})。 */
  facts: Record<string, unknown>;
  refs: QuestionRef[];
};

export const live = (r: JevResult | undefined): r is JevResult =>
  !!r && (r.source === "jev" || r.source === "cache");

/** 1 つでも本物の Jev の答えがあれば jev、キャッシュだけなら cache、それ以外は rules。 */
export function sourceOf(results: (JevResult | undefined)[]): JudgeSource {
  if (results.some((r) => r?.source === "jev")) return "jev";
  if (results.some((r) => r?.source === "cache")) return "cache";
  return "rules";
}

export const ZERO_COST: JudgeCost = Object.freeze({ requests: 0, tokens: 0, usd: 0, ms: 0 });

export function costOf(out: Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms"> | null | undefined): JudgeCost {
  if (!out) return { ...ZERO_COST };
  return { requests: out.requests.length, tokens: out.inputTokens, usd: out.usd, ms: out.ms };
}

/** ルールへ落ちた理由の言い方を揃える(Brief が無い / 鍵が無い / 失敗)。 */
export function rulesReason(out: Pick<AskOutcome, "briefMissing" | "results"> | null, fallback = "ルールで判断した"): string {
  if (!out) return fallback;
  if (out.briefMissing) return "Brief が無いのでルールで判断した(dx12_brief で作品の意図を書くと Jev が使われる)";
  const withError = out.results.find((r) => r?.error);
  if (withError) return `Jev に聞けなかった: ${withError.error}`;
  return out.results.find((r) => r?.reason)?.reason ?? fallback;
}

/** 名前の末尾の連番を落とす(ENV_Rock_03 → ENV_Rock)。Jev に数字を渡さないため。人向けの出力には元の名前を使う。 */
export function stripSerial(name: string | undefined | null): string {
  const s = String(name ?? "").trim();
  const t = s.replace(/[\s_\-.]*\(?\d+\)?$/, "");
  return t || s.replace(/\d+/g, "#");
}

/** 画面の文言の数字を # に潰す(「SCORE 00120」→「SCORE #」)。量の比較を Jev にさせないため。 */
export function maskDigits(text: string): string {
  return text.replace(/[0-9０-９]+(?:[.,][0-9]+)?/g, "#");
}
