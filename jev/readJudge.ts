// 読みやすさの判断段。知覚層(エンジンの perceive → perceive.ts の perceptionFacts)が出した
// 「プレイヤーの目から見た事実」を Brief と一緒に Jev へ渡し、対象ごとに
//   read.noticeable   (noul)  … 初見のプレイヤーがこの視点から数秒で対象に気づき、それが何か読み取れるか
//   read.main_problem (choice)… 読みにくい主な原因(perceive の指標で区別できるものだけ)
// を聞く。
//
// ★なぜ要るか: JUNCTION では机上検査(配置・到達性)が全部通るのに、焦点に立って撮ると
//   「破片が真っ黒な板に見える」「深さが見えない」「仕掛けが画面を埋める」が 1 日で見つかった(2026-09-08)。
//   どれも数字には出ていなかった。知覚層がそれを数値にし、ここで「気づけるか」の判断にする。
//
// ★原因の選択肢は perceive の指標で区別できるものだけ:
//   too_dark(brightness)/ unlit_side(lit_side・main_light・back_face)/ blends_in(contrast)/
//   no_shape(texture)/ too_small(screen_share)/ occluded(occluded・visibility)/
//   fills_view(screen_share + fits_in_view)/ out_of_view(visibility)/ fine。
//   ★litFacing(lit_side)はカスタムシェーダの照明を見ていない(JUNCTION の Unbuilt.hlsl は点光源を読まない)。
//   「照らされている」でも暗いことがあるので、質問文で「brightness / contrast と食い違ったらそちらを信じる」と書き、
//   state には必ず brightness / contrast と並べて渡す(perceive.ts の targetFacts がそうしている)。
//
// ★1 視点 = 1 state: facts.read に視点・画面全体・対象(ref A, B, …)を並べ、対象ごとの 2 問を 1 リクエストに束ねる。
//   名前は識別子なので数字を # に潰し(C6_p0 → C#_p#)、何の物かは role(呼ぶ側が書く「見つけてほしい破片」など)で伝える。

import { perceptionFacts, type PerceiveRaw } from "../perceive.ts";
import { ask, type AskOptions, type AskOutcome, type JevResult, type QuestionRef, type RuleFn } from "./library.ts";
import {
  costOf, live, maskDigits, rulesReason, sourceOf,
  type JudgeBase, type JudgePlan, type LookHint, type UncertainItem,
} from "./judgeCommon.ts";
import type { Brief } from "./brief.ts";

export type ReadCamera = "editor" | "game" | { position: number[]; target: number[]; fovDeg?: number };
export type ReadTarget = { name: string; role?: string };
export type ReadViewpoint = { label?: string; camera?: ReadCamera; targets: (string | ReadTarget)[] };

export const MAX_READ_TARGETS = 12;
const REFS = "ABCDEFGHIJKL".split("");

/** 原因 → 人向けの名前と次の一手。キーは read.main_problem.jevq.json の criteria と一致(テストで突き合わせる)。 */
export const READ_PROBLEMS: Record<string, { label: string; hint: string }> = {
  fine: { label: "問題なし", hint: "この視点から初見で読める" },
  too_dark: { label: "暗すぎる", hint: "対象かその周りに灯りを足すか、露出を上げる(litFacing ではなく brightness で確かめる)" },
  unlit_side: { label: "灯りが裏から当たっている(黒い板に見える)", hint: "灯りを見る側へ回すか、手前にフィルを置く" },
  blends_in: { label: "周囲に溶ける", hint: "対象か背景の明るさ・色を変えて差をつける" },
  no_shape: { label: "のっぺりで形・奥行きが読めない", hint: "横や下から陰影を作る灯りを足すか、模様・縁を足す" },
  too_small: { label: "小さすぎる", hint: "近づける・大きくする・視点を寄せる" },
  occluded: { label: "手前の物に遮られている", hint: "手前の物をどけるか、視点を変える" },
  fills_view: { label: "画面を埋めて全体が見えない", hint: "視点を引くか、対象を小さくする" },
  out_of_view: { label: "視野の外", hint: "視点の向きを変えるか、対象を視野へ入れる" },
};

export type ReadFacts = {
  viewpoint?: string;
  scene: Record<string, string>;
  targets: ({ ref: string; name: string; role?: string } & Record<string, string>)[];
};

const targetOf = (t: string | ReadTarget): ReadTarget => (typeof t === "string" ? { name: t } : t);

/** perceive の結果 → facts.read(数値を含まない言葉。名前の数字は # に潰す)。 */
export function wordifyRead(raw: PerceiveRaw, vp: ReadViewpoint): { read: ReadFacts; refs: { ref: string; name: string; role?: string }[] } {
  const pf = perceptionFacts(raw, { top: 3 });
  const scene: Record<string, string> = { ...pf.scene };
  if (scene.dominant) scene.dominant = maskDigits(scene.dominant);
  const wanted = vp.targets.map(targetOf).slice(0, MAX_READ_TARGETS);
  const refs: { ref: string; name: string; role?: string }[] = [];
  const targets: ReadFacts["targets"] = [];
  wanted.forEach((t, i) => {
    const tf = pf.targets.find((x) => x.name === t.name);
    const facts: Record<string, string> = { ...(tf?.facts ?? { visibility: "見えていない" }) };
    if (facts.main_light) facts.main_light = maskDigits(facts.main_light);
    refs.push({ ref: REFS[i], name: t.name, ...(t.role ? { role: t.role } : {}) });
    targets.push({ ref: REFS[i], name: maskDigits(t.name), ...(t.role ? { role: t.role } : {}), ...facts });
  });
  const viewpoint = vp.label ? `${vp.label}${pf.viewpoint ? `(${pf.viewpoint})` : ""}` : pf.viewpoint;
  return { read: { ...(viewpoint ? { viewpoint } : {}), scene, targets }, refs };
}

// ────────────────────────────────────────────────────────────────
//  ルール(フォールバック): 言葉の事実から Brief を見ずに決める
// ────────────────────────────────────────────────────────────────

/**
 * ルールの主な原因。★Brief も役割も見ないので「暗闇に潜ませたい物」も too_dark と言う。
 * litFacing の癖(カスタムシェーダ)があるので、明るさが「とても暗い」以下なら lit_side より暗さを先に見る。
 */
export function ruleProblem(t: Record<string, string> | undefined): string {
  if (!t) return "out_of_view";
  const v = t.visibility ?? "";
  if (v === "視野の外") return "out_of_view";
  if (/隠れている/.test(v) || /大半が隠れている|ほぼ全部隠れている/.test(t.occluded ?? "")) return "occluded";
  if (v !== "見えている") return "out_of_view";
  if (t.screen_share === "画面の大半" && /収まらない/.test(t.fits_in_view ?? "")) return "fills_view";
  if (t.screen_share === "ほぼ見えない" || t.screen_share === "ごく小さい") return "too_small";
  if (t.brightness === "ほぼ真っ暗" || t.brightness === "とても暗い") return "too_dark";
  if (/^影|^ほぼ影/.test(t.lit_side ?? "") || /裏側から/.test(t.main_light ?? "") || /^はい/.test(t.back_face ?? "")) return "unlit_side";
  if (/^ほぼ同じ/.test(t.contrast ?? "")) return "blends_in";
  if (/^のっぺり/.test(t.texture ?? "") || (t.texture === "模様・陰影が少ない" && t.brightness === "暗い")) return "no_shape";
  return "fine";
}

export const READ_RULES: Record<string, RuleFn> = {
  "read.noticeableRules": ({ context, vars }) => {
    const t = (context?.facts?.read?.targets ?? []).find((x: any) => x?.ref === vars.ref);
    const p = ruleProblem(t);
    const ok = p === "fine";
    return { value: ok ? 1 : 0, decided: ok, reason: ok ? "ルール: 読みにくさの印が無い" : `ルール: ${p}` };
  },
  "read.mainProblemRules": ({ context, vars }) => {
    const t = (context?.facts?.read?.targets ?? []).find((x: any) => x?.ref === vars.ref);
    const p = ruleProblem(t);
    return { value: p, decided: p, reason: `ルール: 事実の印から ${p}` };
  },
};

// ────────────────────────────────────────────────────────────────
//  plan → ask → interpret
// ────────────────────────────────────────────────────────────────

export type ReadJudgeInput = { brief: Brief | null | undefined; raw: PerceiveRaw; viewpoint: ReadViewpoint };

export type ReadJudge = JudgeBase & {
  viewpoint?: string;
  targets: {
    ref: string; name: string; role?: string;
    noticeable: { value: number | null; decided: boolean | null; uncertain?: boolean };
    mainProblem: { id: string; label: string; hint: string; confidence: number | null } | null;
  }[];
  /** 初見で気づけない対象(名指し)。 */
  unreadable: string[];
  next?: string;
};

/** 見に行くためのツール呼び出し(指定視点なら同じ視点から撮る)。 */
export function lookForRead(vp: ReadViewpoint): LookHint {
  const c = vp.camera;
  if (c && typeof c === "object") return { tool: "dx12_screenshot_from", args: { position: c.position, target: c.target } };
  if (c === "game") return { tool: "dx12_screenshot_game_view", args: {} };
  return { tool: "dx12_screenshot_final", args: {} };
}

export function planRead(input: ReadJudgeInput): JudgePlan & { refs2: { ref: string; name: string; role?: string }[]; words: ReadFacts } {
  const w = wordifyRead(input.raw, input.viewpoint);
  const tag = input.viewpoint.label ?? "view";
  const refs: QuestionRef[] = w.refs.flatMap((r) => [
    { id: "read.noticeable", vars: { ref: r.ref }, key: `read.noticeable#${tag}#${r.name}` },
    { id: "read.main_problem", vars: { ref: r.ref }, key: `read.main_problem#${tag}#${r.name}` },
  ]);
  return { facts: { read: w.read }, refs, refs2: w.refs, words: w.read };
}

export function interpretRead(input: ReadJudgeInput, plan: ReturnType<typeof planRead>, results: JevResult[],
                              out: Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms" | "briefMissing" | "results"> | null): ReadJudge {
  const look = lookForRead(input.viewpoint);
  const uncertain: UncertainItem[] = [];
  const targets: ReadJudge["targets"] = plan.refs2.map((r, i) => {
    const n = results[2 * i], m = results[2 * i + 1];
    const noticeable = {
      value: n && typeof n.value === "number" ? Number(n.value.toFixed(3)) : null,
      decided: n && typeof n.decided === "boolean" ? n.decided : null,
      ...(live(n) && n.uncertain ? { uncertain: true } : {}),
    };
    if (live(n) && n.uncertain) uncertain.push({ id: n.id, why: n.reason ?? "境界付近", look });
    let mainProblem: ReadJudge["targets"][number]["mainProblem"] = null;
    if (m && typeof m.value === "string" && READ_PROBLEMS[m.value]) {
      mainProblem = { id: m.value, ...READ_PROBLEMS[m.value], confidence: live(m) ? m.confidence ?? null : null };
      if (live(m) && m.uncertain) uncertain.push({ id: m.id, why: m.reason ?? "confidence が低い", look });
      // ★2 つの判断の食い違い: 気づけないのに原因が「問題なし」/ 気づけるのに原因がある(はっきり気づけるときは除く)
      if (live(n) && live(m)) {
        if (noticeable.decided === false && m.value === "fine") uncertain.push({ id: m.id, why: "気づけないと判断したのに原因が「問題なし」", look });
        if (noticeable.decided === true && m.value !== "fine" && (noticeable.value ?? 1) < 0.9) {
          uncertain.push({ id: m.id, why: `気づけると判断したのに原因が ${m.value}`, look });
        }
      }
    }
    return { ref: r.ref, name: r.name, ...(r.role ? { role: r.role } : {}), noticeable, mainProblem };
  });
  const all = results.filter(Boolean);
  const unreadable = targets.filter((t) => t.noticeable.decided === false).map((t) => t.name);
  return {
    source: sourceOf(all),
    ...(out?.briefMissing ? { briefMissing: true } : {}),
    ...(!all.some(live) ? { reason: plan.refs.length ? rulesReason(out ? { ...out, results } : null) : "対象が無い" } : {}),
    // 読みやすさは keep を出さない(対象ごとの判断そのものが結論)。findings には対象ごとの結論を載せる
    findings: targets.map((t) => ({ code: "READ_NOTICEABLE", ref: t.ref, name: t.name, intended: t.noticeable.value,
                                    keep: t.noticeable.decided === true, ...(t.noticeable.uncertain ? { uncertain: true } : {}) })),
    uncertain, targets, unreadable,
    ...(plan.words.viewpoint ? { viewpoint: plan.words.viewpoint } : {}),
    cost: costOf(out),
    next: unreadable.length
      ? `初見で気づけない: ${unreadable.join(", ")}。mainProblem の hint に従って直し、dx12_perceive で測り直す`
      : uncertain.length ? `uncertain がある。${look.tool} で同じ視点から見て自分で決めること` : undefined,
  };
}

/** 判断段の本体。例外は投げない。 */
export async function judgeRead(input: ReadJudgeInput & { askOptions?: AskOptions }): Promise<ReadJudge> {
  const plan = planRead(input);
  if (plan.refs.length === 0) return interpretRead(input, plan, [], null);
  const out = await ask(plan.refs, { brief: input.brief ?? null, facts: plan.facts },
    { ...input.askOptions, rules: { ...READ_RULES, ...input.askOptions?.rules } });
  return interpretRead(input, plan, out.results, out);
}
