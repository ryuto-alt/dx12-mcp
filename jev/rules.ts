// 判断段のルール(フォールバック)を 1 か所に集めた表。質問ファイルの fallback に名前で書かれた規則を引く。
//
// ★dx12_jev_ask / dx12_jev_eval / runEval.ts は「どの質問が来ても」ルールで答えられないといけない
//   (評価の rulesAccuracy はここを通した答え)。判断段を足したらここへ足すこと。

import type { RuleFn } from "./library.ts";
import { POLISH_RULES } from "./polishJudge.ts";
import { LAYOUT_RULES } from "./layoutJudge.ts";
import { PLAY_RULES } from "./playJudge.ts";
import { READ_RULES } from "./readJudge.ts";

export const JEV_RULES: Record<string, RuleFn> = { ...POLISH_RULES, ...LAYOUT_RULES, ...PLAY_RULES, ...READ_RULES };
