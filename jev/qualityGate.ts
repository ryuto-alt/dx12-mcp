// dx12_quality_gate の本体。作業の区切りで 1 回撃てば、壊れていないか(ルール)と、
// 作品の意図に照らして直すべきか(Jev)をまとめて返す。
//
// ★なぜ要るか: 検査の道具(validate_scene / diagnose / validate_layout / polish_audit / ui_audit /
//   run_playtests)は揃っているが、AI は自分で思いつかない限り撃たないし、撃っても結果がばらばらの形で
//   「どれを直せばいいか」「どれは意図どおりか」を毎回自分で突き合わせていた。ゲートは
//     pass / blocking[](直すまで先へ進まない)/ keep[](Brief に照らすと意図どおり＝直さない)/
//     suggestions[](次の一手)/ uncertain[](Claude が自分の目で見るもの。見るためのツール呼び出し付き)/ cost
//   の 1 つの形に畳む。
//
// ★合否の規則: ルールの error は blocking。Jev が keep と判断したものは blocking から外す(判断結果と確信度を
//   keep に残す)。uncertain は合否に影響させず列挙するだけ。Jev は「直すか」を決めるだけで、壊れているかは
//   ルールが決める(Z_FIGHT / 参照切れ / 押せないボタン / 再生の失敗は Jev に聞かない)。
//
// ★Jev は 1 往復: 各検査は「plan(聞く質問と言葉の事実)」を返すだけで自分では聞かない。ゲートが全部の plan を
//   1 つの context(brief + facts.{look, findings, ui, layout, play})に集めて ask を 1 回撃ち、答えを各検査の
//   interpret へ配り直す。facts のキーがぶつかる plan(落ちたプレイテストが 2 本)だけは別の束に分ける。
//   ・bundle:"perDomain"(既定)… 質問ごとの射影のまま。検査ごとに 1 リクエストで、全部を並列に撃つ(待ち時間は 1 往復ぶん)
//   ・bundle:"one" … library の stateUnion で全質問の state を揃えて本当に 1 リクエストにする
//   ★既定を perDomain にした理由(2026-09-25 実測、各ケースに他の検査の事実を足して和集合の state で評価):
//     noul(指摘ごとの keep)は劣化しない(finding.intended margin +0.11→+0.19、ui.finding_intended +0.52→+0.64、
//     layout.* も同等以上)が、score / choice は関係ない事実に引っ張られる: ui.brief_fit の合否 margin 0.78→0.26
//     (分布ごと下へずれる)、play.confusion は困っている線をまたいでずれる、play.cause 0.98→0.875、look.next_fix 0.79→0.74。
//     閾値は検査ごとの state で測ってあるので、既定はそちらに合わせた。Brief のトークンを検査の数だけ払うが 1 回 $0.0002 前後の差。
//
// ★検査を足す口: GATE_CHECKS(下の配列)。検査は { id, title, enabled(opts), run(ctx) } で、run は
//   ルールの結論(items)と、聞くなら judges[{plan, interpret}] を返す。知覚層(perceive)の読みやすさの検査も
//   ここへ 1 つ足すだけで、束ね・合否・keep・uncertain の組み立てはゲートがやる(読みやすさの検査 READABILITY_CHECK がその例)。

import fs from "node:fs";
import path from "node:path";
import { auditUiTree } from "../uiQuality.ts";
import { auditScene, polishScore } from "../polish.ts";
import { collectSceneFacts, type EngineCall } from "../polishCollect.ts";
import { fastDiagnoseOnly } from "../sceneTools.ts";
import { playtestDir, safeName, validatePlaytest, type PlaytestFile, type ReplayVerdict } from "../playtestStore.ts";
import { ask, type AskOptions, type AskOutcome, type JevResult } from "./library.ts";
import { costOf, type JudgeCost, type JudgePlan, type LookHint, type UncertainItem } from "./judgeCommon.ts";
import { UI_LOOK, interpretUi, planUi } from "./uiJudge.ts";
import { collectLayoutContext, interpretLayout, planLayout, type LayoutIssue } from "./layoutJudge.ts";
import { interpretPolish, planPolish } from "./polishJudge.ts";
import { eventsFromSteps, interpretPlay, planPlay, pointsFromTrace } from "./playJudge.ts";
import { READ_PROBLEMS, interpretRead, planRead, ruleProblem, wordifyRead, type ReadViewpoint } from "./readJudge.ts";
import { JEV_RULES } from "./rules.ts";
import type { Brief } from "./brief.ts";

// ────────────────────────────────────────────────────────────────
//  型
// ────────────────────────────────────────────────────────────────

export type GateLevel = "error" | "warning" | "suggestion";

/** ルールの結論 1 件。blocking はその検査のルールが「直すまで先へ進むな」と言っているもの。 */
export type GateItem = {
  check: string;
  code: string;
  level: GateLevel;
  blocking: boolean;
  text: string;
  entityId?: number;
  name?: string;
  fix?: string;
};

export type GateKeep = GateItem & {
  /** keep にした判断。noul の confidence は yes の確率そのもの(ルールで決めたときは null)。 */
  judge: { question: string; value: number | null; threshold: number | null; confidence: number | null; source: string };
  why: string;
};

export type GateSuggestion = { check: string; text: string; tool?: string; args?: Record<string, unknown> };
export type GateUncertain = { check: string; id: string; why: string; look: LookHint };

type OutLike = Pick<AskOutcome, "requests" | "inputTokens" | "usd" | "ms" | "briefMissing" | "results">;

/** 判断の結果を、ゲートの keep / uncertain / suggestions の言葉へ直したもの。 */
export type CheckJudgment = {
  /** 各ツール(ui_audit / validate_layout / polish_audit / プレイ)の judge と同じ形。 */
  judge: unknown;
  keep: { index: number; question: string; value: number | null; threshold: number | null; source: string; why: string }[];
  uncertain: UncertainItem[];
  suggestions: GateSuggestion[];
};

export type JudgeUnit = { plan: JudgePlan; interpret: (results: JevResult[], out: OutLike | null) => CheckJudgment };

export type Collected = {
  /** 走らなかった理由(対象が無い / Playing 中 / 失敗)。 */
  skipped?: string;
  summary?: Record<string, unknown>;
  items: GateItem[];
  /** 判断が無くても出す次の一手(ルールの結論)。判断があればそちらの suggestions に置き換わる。 */
  suggestions?: GateSuggestion[];
  judges?: JudgeUnit[];
};

export type GateOptions = {
  /** 走らせる検査の id。省略で「既定で走るもの」全部(playtests は指定したときだけ)。 */
  checks?: string[];
  /** diagnose の重い検査(textures / models = assets 全走査で数十秒)も入れる。既定 false。 */
  heavy?: boolean;
  /** polish の最終画を撮って画素で判定する。既定 true。 */
  screenshot?: boolean;
  /** UI の warning も blocking にするか。既定 balanced(error だけ)。 */
  strictness?: "balanced" | "strict";
  /** UI の画面の役割(判断段へ渡す)。 */
  screen?: string;
  /** 保存済みプレイテストを再生する(true = 全部 / 名前の配列)。既定は再生しない。 */
  playtests?: boolean | string[];
  /** false で Jev を使わない(ルールだけ)。 */
  judge?: boolean;
  /**
   * 読みやすさの検査(知覚層 perceive)。視点(焦点)と対象を渡したときだけ走る(最大 4 視点)。
   * 例 [{label:"継ぎ目6 の焦点", camera:{position:[14,5.1,122], target:[14,5,126], fovDeg:72}, targets:[{name:"C6_p0", role:"見つけてほしい破片"}]}]
   */
  readability?: ReadViewpoint[];
  /** "perDomain"(既定)= 検査ごとの state で並列に聞く / "one" = 全質問を 1 リクエストに束ねる(精度が落ちる。上の解説)。 */
  bundle?: "one" | "perDomain";
};

export type ReplayFn = (pt: PlaytestFile) => Promise<{ verdict: ReplayVerdict; trace: { t: number; pos: number[] }[] }>;

export type GateContext = {
  call: EngineCall;
  baseDir: string | null;
  brief: Brief | null;
  /** get_mode の mode("Editor" / "Playing")。読めなければ null。 */
  mode: string | null;
  opts: GateOptions;
  /** 保存済みプレイテストを 1 本再生する(index.ts の replayPlaytest)。無ければ playtests は走らない。 */
  replay?: ReplayFn;
};

export type GateCheck = {
  id: string;
  title: string;
  /** opts を見て、既定で走らせるか(opts.checks で名指しされたら enabled に関係なく走る)。 */
  enabled: (opts: GateOptions) => boolean;
  run: (ctx: GateContext) => Promise<Collected>;
};

// ────────────────────────────────────────────────────────────────
//  検査
// ────────────────────────────────────────────────────────────────

const DIAG_LEVEL_ERROR = 2;

/** (a) シーンの検証: 参照切れ(validate_scene)と軽い診断(diagnose。重い textures / models は既定で外す)。 */
export const SCENE_CHECK: GateCheck = {
  id: "scene",
  title: "シーンの検証(参照切れ + 軽い診断)",
  enabled: () => true,
  async run(ctx) {
    const items: GateItem[] = [];
    const summary: Record<string, unknown> = {};
    const suggestions: GateSuggestion[] = [];
    const vs = await ctx.call("validate_scene", {}).catch((e: any) => ({ __error: String(e?.message ?? e) }));
    if (vs?.__error) summary.validateScene = { skipped: vs.__error };
    else {
      summary.validateScene = { pass: vs?.pass, exitCode: vs?.exitCode, scenePath: vs?.scenePath };
      if (vs?.pass === false) {
        const lines = String(vs.report ?? "").split(/\r?\n/).filter((l) => /\[ERROR\]/.test(l));
        for (const l of lines.slice(0, 20)) {
          items.push({ check: "scene", code: "SCENE_REFERENCE", level: "error", blocking: true,
                       text: l.replace(/^\s*\[ERROR\]\s*/, "").trim(), fix: "参照先の名前・パスを直してから dx12_validate_scene で確かめる" });
        }
        if (lines.length === 0) {
          items.push({ check: "scene", code: "SCENE_VALIDATE_FAILED", level: "error", blocking: true,
                       text: `validate_scene が失敗した(exitCode ${vs.exitCode})`, fix: "dx12_validate_scene の report を読む" });
        }
      }
    }
    const only = ctx.opts.heavy ? "" : fastDiagnoseOnly();
    const dg = await ctx.call("diagnose", { only }).catch((e: any) => ({ __error: String(e?.message ?? e) }));
    if (dg?.__error) summary.diagnose = { skipped: dg.__error };
    else {
      let warnings = 0;
      for (const c of dg?.checks ?? []) {
        for (const is of c?.issues ?? []) {
          if (Number(is?.level) >= DIAG_LEVEL_ERROR) {
            items.push({ check: "scene", code: `DIAG_${String(c.id ?? "").toUpperCase()}`, level: "error", blocking: true,
                         text: String(is.text ?? ""), fix: "文中の次の一手に従う(dx12_diagnose で再確認)" });
          } else if (Number(is?.level) === 1) warnings++;
        }
      }
      summary.diagnose = { errors: dg?.summary?.errors ?? null, warnings: dg?.summary?.warnings ?? warnings,
                           only: only || "(全部)" };
      if (warnings > 0) suggestions.push({ check: "scene", text: `dx12_diagnose に注意が ${warnings} 件ある(失敗ではない)。時間のあるときに読む`,
                                           tool: "dx12_diagnose", args: { fast: true } });
    }
    return { items, summary, suggestions };
  },
};

const SAFE_FIX_KINDS = new Set(["BURIED", "FLOATING", "Z_FIGHT", "COLLIDER_WITHOUT_BODY"]);

/** 配置の次の一手。keep にした BURIED / FLOATING があるときは fix:"safe" を勧めない(種類ごと全部動かしてしまう)。 */
function layoutSuggestions(items: GateItem[], kept: Set<number>): GateSuggestion[] {
  const open = items.map((it, i) => ({ it, i })).filter(({ i }) => !kept.has(i));
  const keptMovable = [...kept].some((i) => items[i].code === "BURIED" || items[i].code === "FLOATING");
  const out: GateSuggestion[] = [];
  const safe = open.filter(({ it }) => SAFE_FIX_KINDS.has(it.code));
  if (safe.length && !keptMovable) {
    out.push({ check: "layout", text: `自動で直せる指摘が ${safe.length} 件(接地・ちらつき・rigidBody 付与)`, tool: "dx12_validate_layout", args: { fix: "safe" } });
  } else {
    for (const { it } of safe.filter(({ it }) => it.code === "BURIED" || it.code === "FLOATING").slice(0, 4)) {
      out.push({ check: "layout", text: `${it.name} を接地させる(keep にした物があるので fix:"safe" ではなく 1 体ずつ)`,
                 tool: "dx12_snap_to_ground", args: it.entityId !== undefined ? { entity: it.entityId } : { name: it.name } });
    }
    for (const { it } of safe.filter(({ it }) => it.code === "COLLIDER_WITHOUT_BODY").slice(0, 4)) {
      out.push({ check: "layout", text: `${it.name} に静的 rigidBody を足す(無いと当たり判定が効かない)`, tool: "dx12_set_component",
                 args: { ...(it.entityId !== undefined ? { entity: it.entityId } : { name: it.name }), component: "rigidBody", data: { motionType: 0, mass: 0 } } });
    }
  }
  for (const { it } of open.filter(({ it }) => it.code === "DUPLICATE").slice(0, 3)) {
    out.push({ check: "layout", text: `${it.name} は二重配置。片方を消す`, tool: "dx12_delete_entity",
               args: it.entityId !== undefined ? { entity: it.entityId } : { name: it.name } });
  }
  const overlaps = open.filter(({ it }) => it.code === "OVERLAP");
  if (overlaps.length) out.push({ check: "layout", text: `めり込み ${overlaps.length} 件(${overlaps.slice(0, 3).map(({ it }) => it.name).join(", ")})はずらすか片方を消す` });
  const noCol = open.filter(({ it }) => it.code === "NO_COLLIDER");
  if (noCol.length) out.push({ check: "layout", text: `当たり判定の無い大きな物 ${noCol.length} 件(${noCol.slice(0, 3).map(({ it }) => it.name).join(", ")})。床・壁・足場なら boxCollider と静的 rigidBody を付ける` });
  return out.slice(0, 6);
}

/** (b) 配置検査 + 判断段。 */
export const LAYOUT_CHECK: GateCheck = {
  id: "layout",
  title: "配置検査(validate_layout)+ 判断段",
  enabled: () => true,
  async run(ctx) {
    if (ctx.mode === "Playing") {
      return { skipped: "Playing 中は配置を測れない(物理が動かした後の位置になる)。dx12_stop してから回す", items: [] };
    }
    const report = await ctx.call("validate_layout", { fix: "none" });
    const open: LayoutIssue[] = (report?.issues ?? []).filter((i: LayoutIssue) => !i.fixed);
    const items: GateItem[] = open.map((i) => ({
      check: "layout", code: i.kind, level: i.level === "error" ? "error" : "warning", blocking: i.level === "error",
      text: i.text, ...(i.entityId !== undefined ? { entityId: i.entityId } : {}), ...(i.name ? { name: i.name } : {}),
    }));
    const lctx = await collectLayoutContext(ctx.call, open);
    const input = { brief: ctx.brief, report: { ...report, issues: open }, ctx: lctx };
    const plan = planLayout(input);
    return {
      items,
      summary: { checked: report?.checked ?? null, errors: report?.errors ?? null, warnings: report?.warnings ?? null },
      suggestions: layoutSuggestions(items, new Set()),
      judges: plan.refs.length === 0 ? [] : [{
        plan,
        interpret: (results, out) => {
          const j = interpretLayout(input, plan, results, out);
          const keep: CheckJudgment["keep"] = [];
          plan.picked.forEach((is, k) => {
            const f = j.findings[k];
            if (!f?.keep) return;
            const r = results[k];
            keep.push({
              index: open.indexOf(is), question: r?.question ?? "layout", value: f.intended,
              threshold: null, source: r?.source ?? "rules",
              why: r && (r.source === "jev" || r.source === "cache")
                ? `名前・グループ・大きさと Brief から意図的な配置と判断(${is.kind})`
                : (r?.reason ?? "ルールの規約"),
            });
          });
          return {
            judge: j, keep,
            uncertain: j.uncertain.map((u) => ({ ...u, look: u.look ?? { tool: "dx12_screenshot_final", args: {} } })),
            suggestions: layoutSuggestions(items, new Set(keep.map((k) => k.index))),
          };
        },
      }],
    };
  },
};

/** (c) 絵の仕上がり + 判断段。polish の指摘は「作りかけに見える理由」で壊れてはいないので blocking にしない。 */
export const POLISH_CHECK: GateCheck = {
  id: "polish",
  title: "絵の仕上がり(polish_audit)+ 判断段",
  enabled: () => true,
  async run(ctx) {
    const { facts } = await collectSceneFacts(ctx.call, { screenshot: ctx.opts.screenshot });
    const findings = auditScene(facts);
    const items: GateItem[] = findings.map((f) => ({ check: "polish", code: f.code, level: "suggestion", blocking: false, text: f.what, fix: f.fix }));
    const input = { brief: ctx.brief, facts, findings };
    const plan = planPolish(input);
    const LOOK: LookHint = { tool: "dx12_screenshot_final", args: {} };
    return {
      items,
      summary: { score: polishScore(findings), findings: findings.length, screenshot: !!facts.image },
      suggestions: findings[0] ? [{ check: "polish", text: `${findings[0].what}(効く順の先頭)`, ...fixToTool(findings[0].fix) }] : [],
      judges: [{
        plan,
        interpret: (results, out) => {
          const j = interpretPolish(input, plan, results, out ?? { usd: 0, ms: 0, briefMissing: false });
          const keep: CheckJudgment["keep"] = [];
          j.findings.forEach((f, k) => {
            if (!f.keep) return;
            const r = results[2 + k];
            items.forEach((it, i) => {
              if (it.code === f.code) keep.push({ index: i, question: "finding.intended", value: f.intended, threshold: null,
                                                  source: r?.source ?? "jev", why: "Brief に照らすと意図どおり(直さない)" });
            });
          });
          const nf = j.nextFix;
          const suggestions: GateSuggestion[] = nf && nf.tool
            ? [{ check: "polish", text: nf.what, tool: nf.tool, args: nf.args }]
            : nf?.id === "keep_as_is" ? [{ check: "polish", text: "絵は Brief に照らして今のままでよい(次の一手は無し)" }] : [];
          return { judge: j, keep, uncertain: j.uncertain.map((u) => ({ ...u, look: LOOK })), suggestions };
        },
      }],
    };
  },
};

/** polish の fix 文("dx12_xxx(...)")からツール名だけ拾う(引数は文のまま渡す)。 */
function fixToTool(fix: string): { tool?: string } {
  const m = String(fix ?? "").match(/\b(dx12_[a-z0-9_]+)/);
  return m ? { tool: m[1] } : {};
}

/** (d) ゲーム内 UI(あれば)+ 判断段。 */
export const UI_CHECK: GateCheck = {
  id: "ui",
  title: "ゲーム内 UI(ui_audit)+ 判断段",
  enabled: () => true,
  async run(ctx) {
    const tree = await ctx.call("ui_tree", {}).catch(() => null);
    if (!tree?.canvases?.length) return { skipped: "UI(uiCanvas)が無い", items: [] };
    const strictness = ctx.opts.strictness ?? "balanced";
    const audit = auditUiTree(tree, strictness);
    const items: GateItem[] = audit.issues.map((i) => ({
      check: "ui", code: i.code, level: i.severity, blocking: i.severity === "error" || (strictness === "strict" && i.severity === "warning"),
      text: i.message, fix: i.fix, ...(i.entityId !== undefined ? { entityId: i.entityId } : {}), ...(i.name ? { name: i.name } : {}),
    }));
    const input = { brief: ctx.brief, tree, audit, strictness, screen: ctx.opts.screen };
    const plan = planUi(input);
    const uiSuggestions = (kept: Set<string>): GateSuggestion[] => items
      .filter((it) => !it.blocking && !kept.has(it.code)).slice(0, 3)
      .map((it) => ({ check: "ui", text: `${it.name ? `${it.name}: ` : ""}${it.fix}` }));
    return {
      items,
      summary: { pass: audit.pass, score: audit.score, grade: audit.grade, ...audit.summary },
      suggestions: uiSuggestions(new Set()),
      judges: [{
        plan,
        interpret: (results, out) => {
          const j = interpretUi(input, plan, results, out);
          const keptCodes = new Set(j.findings.filter((f) => f.keep).map((f) => f.code));
          const keep: CheckJudgment["keep"] = [];
          items.forEach((it, i) => {
            if (!keptCodes.has(it.code)) return;
            const f = j.findings.find((x) => x.code === it.code)!;
            keep.push({ index: i, question: "ui.finding_intended", value: f.intended, threshold: null, source: j.source,
                        why: "Brief の UI の方向性に照らすと意図どおり(直さない)" });
          });
          return { judge: j, keep, uncertain: j.uncertain.map((u) => ({ ...u, look: u.look ?? UI_LOOK })), suggestions: uiSuggestions(keptCodes) };
        },
      }],
    };
  },
};

/** (e) 保存済みプレイテストの再生 + 判断段(落ちたものの原因)。指定したときだけ走る(シーンを開き直すので)。 */
export const PLAYTEST_CHECK: GateCheck = {
  id: "playtests",
  title: "保存済みプレイテストの再生 + 判断段",
  enabled: (o) => o.playtests === true || (Array.isArray(o.playtests) && o.playtests.length > 0),
  async run(ctx) {
    if (!ctx.replay) return { skipped: "再生の口が無い", items: [] };
    if (!ctx.baseDir) return { skipped: "プロジェクトの場所(baseDir)が分からない", items: [] };
    const dir = playtestDir(ctx.baseDir);
    const want = Array.isArray(ctx.opts.playtests) ? new Set(ctx.opts.playtests.map((n) => `${safeName(n)}.json`)) : null;
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && (!want || want.has(f))).sort(); } catch { /* 無い */ }
    if (files.length === 0) return { skipped: `.playtest が無い(${dir})`, items: [] };
    const items: GateItem[] = [];
    const judges: JudgeUnit[] = [];
    const results: Record<string, unknown>[] = [];
    for (const f of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const bad = validatePlaytest(raw);
      if (bad.length) {
        items.push({ check: "playtests", code: "PLAYTEST_INVALID", level: "error", blocking: true, text: `${f}: ${bad.join(" / ")}`,
                     fix: "dx12_record_playtest で録り直す" });
        continue;
      }
      const pt = raw as PlaytestFile;
      const { verdict, trace } = await ctx.replay(pt);
      results.push({ name: pt.name, pass: verdict.pass, endDistance: verdict.endDistance, maxDeviation: verdict.maxDeviation });
      if (verdict.pass) continue;
      items.push({ check: "playtests", code: "PLAYTEST_FAILED", level: "error", blocking: true, name: pt.name,
                   text: `${pt.name}: ${verdict.reasons.join(" / ")}`, fix: "dx12_run_playtests で詳細を見る" });
      const input = { kind: "replay" as const, points: pointsFromTrace(trace as any), events: eventsFromSteps(pt.steps as any),
                      deviation: verdict, brief: ctx.brief };
      const plan = planPlay(input);
      if (plan.refs.length) {
        judges.push({
          plan,
          interpret: (res, out) => {
            const j = interpretPlay(input, plan, res, out);
            const hint = j.cause && j.cause.id !== "none" ? [{ check: "playtests", text: `${pt.name}: ${j.cause.label} → ${j.cause.hint}` }] : [];
            return { judge: { name: pt.name, ...j }, keep: [], uncertain: j.uncertain.map((u) => ({ ...u, id: `${u.id}@${pt.name}` })), suggestions: hint };
          },
        });
      }
    }
    return { items, summary: { ran: results.length, failed: results.filter((r) => !r.pass).length, results }, judges };
  },
};

export const MAX_READ_VIEWPOINTS = 4;

/**
 * (f) 読みやすさ(知覚層)+ 判断段。視点(焦点)ごとに perceive を 1 回撃ち、対象ごとに
 * 「初見で数秒のうちに気づいて何か読めるか」(read.noticeable)と主な原因(read.main_problem)を聞く。
 * ★壊れているわけではないので blocking にしない。気づけない対象は suggestions で名指しし、原因と直し方を添える。
 *   ルールの印(暗い・小さい・遮られている…)が付いたのに Jev が「気づける」と言ったものは keep に残す。
 */
export const READABILITY_CHECK: GateCheck = {
  id: "readability",
  title: "読みやすさ(知覚層 perceive)+ 判断段",
  enabled: (o) => Array.isArray(o.readability) && o.readability.length > 0,
  async run(ctx) {
    const vps = (ctx.opts.readability ?? []).slice(0, MAX_READ_VIEWPOINTS);
    if (vps.length === 0) return { skipped: "視点(readability)が指定されていない", items: [] };
    const items: GateItem[] = [];
    const suggestions: GateSuggestion[] = [];
    const judges: JudgeUnit[] = [];
    const summary: Record<string, unknown>[] = [];
    for (const vp of vps) {
      const names = vp.targets.map((t) => (typeof t === "string" ? t : t.name));
      const raw = await ctx.call("perceive", { ...(vp.camera ? { camera: vp.camera } : {}), targets: names, top: 3 });
      const w = wordifyRead(raw, vp);
      const base = items.length;
      // ルールの印(Brief を見ない)。読みにくいと言った対象だけ item にする(keep の対象)。
      w.read.targets.forEach((t, i) => {
        const p = ruleProblem(t);
        if (p === "fine") return;
        const name = w.refs[i].name;
        items.push({ check: "readability", code: "READ_HARD", level: "warning", blocking: false, name,
                     text: `${vp.label ?? "視点"}: ${name}${w.refs[i].role ? `(${w.refs[i].role})` : ""} が読みにくい(${READ_PROBLEMS[p].label})`,
                     fix: READ_PROBLEMS[p].hint });
        suggestions.push({ check: "readability", text: `${name}: ${READ_PROBLEMS[p].label} → ${READ_PROBLEMS[p].hint}` });
      });
      summary.push({ viewpoint: w.read.viewpoint, targets: w.read.targets.map((t) => ({ name: t.name, ...(t.role ? { role: t.role } : {}), problem: ruleProblem(t) })) });
      const input = { brief: ctx.brief, raw, viewpoint: vp };
      const plan = planRead(input);
      if (plan.refs.length === 0) continue;
      judges.push({
        plan,
        interpret: (res, out) => {
          const j = interpretRead(input, plan, res, out);
          const keep: CheckJudgment["keep"] = [];
          const sugg: GateSuggestion[] = [];
          j.targets.forEach((t) => {
            const idx = items.findIndex((it, k) => k >= base && it.name === t.name);
            if (t.noticeable.decided === true && idx >= 0) {
              keep.push({ index: idx, question: "read.noticeable", value: t.noticeable.value, threshold: null,
                          source: j.source, why: "ルールの印は付いたが、Jev は初見で気づけると判断" });
            }
            if (t.noticeable.decided === false) {
              const mp = t.mainProblem;
              sugg.push({ check: "readability",
                          text: `${vp.label ?? "視点"}: ${t.name}${t.role ? `(${t.role})` : ""} は初見で気づけない`
                            + (mp && mp.id !== "fine" ? `(${mp.label})→ ${mp.hint}` : "(原因は絵を見て決める)"),
                          tool: "dx12_perceive", args: { ...(vp.camera ? { camera: vp.camera } : {}), targets: [t.name] } });
            }
          });
          return { judge: j, keep, uncertain: j.uncertain, suggestions: sugg };
        },
      });
    }
    return { items, summary: { viewpoints: summary }, suggestions, judges };
  },
};

/** ★検査を足す口。順番がそのまま実行順(シーンを開き直す playtests は最後)。 */
export const GATE_CHECKS: GateCheck[] = [SCENE_CHECK, LAYOUT_CHECK, POLISH_CHECK, UI_CHECK, READABILITY_CHECK, PLAYTEST_CHECK];

// ────────────────────────────────────────────────────────────────
//  本体
// ────────────────────────────────────────────────────────────────

export type GateReport = {
  pass: boolean;
  blocking: GateItem[];
  keep: GateKeep[];
  suggestions: GateSuggestion[];
  uncertain: GateUncertain[];
  /** 全件の数(blocking / keep / uncertain は MAX_LISTED 件までしか並べない)。 */
  counts: { blocking: number; keep: number; uncertain: number; suggestions: number };
  /** blocking を「検査:コード」ごとに数えたもの(並べきれなくても何が何件あるか分かる)。 */
  blockingByCode: Record<string, number>;
  /** 並べきれずに省いたものがあるか。 */
  truncated: boolean;
  cost: JudgeCost;
  checks: { id: string; title: string; ran: boolean; skipped?: string; ms: number; summary?: Record<string, unknown>; judge?: unknown }[];
  judge: { used: boolean; source: string; briefMissing?: boolean; bundle: "one" | "perDomain"; bundles: number };
  elapsedMs: number;
  next: string;
};

/**
 * 返り値に並べる件数の上限。★実機の JUNCTION(ステージ丸ごと)では blocking が 307 件(ほとんど Z_FIGHT)になり、
 * 全部並べると応答が 60KB を超えて読めなかった。件数は counts / blockingByCode に全部残す。
 */
export const MAX_LISTED = 30;

/**
 * 「検査:コード」ごとに順繰りに取り出して max 件まで並べる。先頭から切ると 300 件の Z_FIGHT で
 * UI のエラーや参照切れが見えなくなるので、種類ごとに 1 件ずつ回して、どの種類も最低 1 件は見えるようにする。
 */
export function listByKind<T extends { check: string; code?: string }>(items: T[], max = MAX_LISTED): T[] {
  if (items.length <= max) return items;
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = `${it.check}:${it.code ?? ""}`;
    const g = groups.get(k) ?? [];
    g.push(it);
    groups.set(k, g);
  }
  const out: T[] = [];
  for (let round = 0; out.length < max; round++) {
    let took = false;
    for (const g of groups.values()) {
      if (round < g.length && out.length < max) { out.push(g[round]); took = true; }
    }
    if (!took) break;
  }
  return out;
}

/** facts のキーがぶつからない plan どうしを 1 束にする(ぶつかるものは別の束 = 別のリクエスト)。 */
function bundleUnits<T extends { plan: JudgePlan }>(units: T[]): T[][] {
  const bundles: T[][] = [];
  for (const u of units) {
    const keys = Object.keys(u.plan.facts);
    let b = bundles.find((bb) => bb.every((x) => Object.keys(x.plan.facts).every((k) => !keys.includes(k))));
    if (!b) { b = []; bundles.push(b); }
    b.push(u);
  }
  return bundles;
}

export async function runQualityGate(ctx0: Omit<GateContext, "mode"> & { checks?: GateCheck[]; askOptions?: AskOptions; now?: () => number }): Promise<GateReport> {
  const now = ctx0.now ?? (() => Date.now());
  const t0 = now();
  const opts = ctx0.opts ?? {};
  const modeRes = await ctx0.call("get_mode", {}).catch(() => null);
  const ctx: GateContext = { ...ctx0, mode: typeof modeRes?.mode === "string" ? modeRes.mode : null, opts };
  const all = ctx0.checks ?? GATE_CHECKS;
  const unknown = (opts.checks ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) throw new Error(`知らない検査 ${unknown.join(", ")}(有効: ${all.map((c) => c.id).join(", ")})`);
  const selected = all.filter((c) => (opts.checks ? opts.checks.includes(c.id) : c.enabled(opts)));

  // ── ① 各検査を順に回す(エンジンは 1 本の接続なので並列にしない) ──
  const ran: { check: GateCheck; r: Collected; ms: number }[] = [];
  for (const c of selected) {
    const s = now();
    let r: Collected;
    try { r = await c.run(ctx); }
    catch (e: any) { r = { skipped: `失敗: ${String(e?.message ?? e).slice(0, 300)}`, items: [] }; }
    ran.push({ check: c, r, ms: now() - s });
  }

  // ── ② 判断段: 全部の plan を束ねて聞く ──
  const useJudge = opts.judge !== false;
  const bundleMode = opts.bundle ?? "perDomain";
  const units = useJudge ? ran.flatMap(({ check, r }) => (r.judges ?? []).filter((u) => u.plan.refs.length > 0).map((u) => ({ checkId: check.id, ...u }))) : [];
  const bundles = bundleUnits(units);
  const judgments = new Map<(typeof units)[number], CheckJudgment>();
  const outs: AskOutcome[] = await Promise.all(bundles.map((b) => ask(
    b.flatMap((u) => u.plan.refs),
    { brief: ctx.brief ?? null, facts: Object.assign({}, ...b.map((u) => u.plan.facts)) },
    { ...ctx0.askOptions, baseDir: ctx0.askOptions?.baseDir ?? ctx.baseDir, rules: { ...JEV_RULES, ...ctx0.askOptions?.rules },
      stateUnion: bundleMode === "one" },
  )));
  bundles.forEach((b, bi) => {
    let off = 0;
    for (const u of b) {
      const res = outs[bi].results.slice(off, off + u.plan.refs.length);
      off += u.plan.refs.length;
      try { judgments.set(u, u.interpret(res, outs[bi])); } catch { /* 解釈に失敗した検査はルールの結論のまま */ }
    }
  });

  // ── ③ 合否・keep・uncertain・次の一手を組む ──
  const blocking: GateItem[] = [];
  const keep: GateKeep[] = [];
  const suggestions: GateSuggestion[] = [];
  const uncertain: GateUncertain[] = [];
  const checks: GateReport["checks"] = [];
  for (const { check, r, ms } of ran) {
    const mine = units.filter((u) => u.checkId === check.id).map((u) => judgments.get(u)).filter(Boolean) as CheckJudgment[];
    const keptIdx = new Map<number, CheckJudgment["keep"][number]>();
    for (const j of mine) for (const k of j.keep) if (k.index >= 0) keptIdx.set(k.index, k);
    r.items.forEach((it, i) => {
      const k = keptIdx.get(i);
      if (k) {
        keep.push({ ...it, why: k.why,
                    judge: { question: k.question, value: k.value, threshold: k.threshold,
                             confidence: k.source === "jev" || k.source === "cache" ? k.value : null, source: k.source } });
      } else if (it.blocking) blocking.push(it);
    });
    for (const j of mine) for (const u of j.uncertain) uncertain.push({ check: check.id, id: u.id, why: u.why, look: u.look ?? { tool: "dx12_screenshot_final", args: {} } });
    suggestions.push(...(mine.length ? mine.flatMap((j) => j.suggestions) : r.suggestions ?? []));
    checks.push({
      id: check.id, title: check.title, ran: !r.skipped, ...(r.skipped ? { skipped: r.skipped } : {}), ms,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(mine.length ? { judge: mine.length === 1 ? mine[0].judge : mine.map((m) => m.judge) } : {}),
    });
  }

  const cost: JudgeCost = outs.reduce((a, o) => {
    const c = costOf(o);
    return { requests: a.requests + c.requests, tokens: a.tokens + c.tokens, usd: Number((a.usd + c.usd).toFixed(8)), ms: Math.max(a.ms, c.ms) };
  }, { requests: 0, tokens: 0, usd: 0, ms: 0 });
  const allResults = outs.flatMap((o) => o.results);
  const source = allResults.some((x) => x?.source === "jev") ? "jev" : allResults.some((x) => x?.source === "cache") ? "cache" : "rules";
  const briefMissing = outs.some((o) => o.briefMissing);
  const pass = blocking.length === 0;
  const blockingByCode: Record<string, number> = {};
  for (const b of blocking) blockingByCode[`${b.check}:${b.code}`] = (blockingByCode[`${b.check}:${b.code}`] ?? 0) + 1;
  const uncertainKinds = uncertain.map((u) => ({ ...u, code: u.id.split("#")[0] }));
  const listedBlocking = listByKind(blocking);
  const listedKeep = listByKind(keep);
  const listedUncertain = listByKind(uncertainKinds).map(({ code: _c, ...u }) => u);
  const truncated = listedBlocking.length < blocking.length || listedKeep.length < keep.length
    || listedUncertain.length < uncertain.length || suggestions.length > 20;
  const next = [
    blocking.length ? `blocking ${blocking.length} 件を上から直してから、もう一度 dx12_quality_gate を撃つ` : "blocking は無い",
    truncated ? `件数が多いので種類ごとに ${MAX_LISTED} 件まで並べた(全件の数は counts / blockingByCode)。個別の一覧は各ツール(dx12_validate_layout 等)で見る` : "",
    uncertain.length ? `uncertain ${uncertain.length} 件は look のツールで自分の目で見て決める(合否には入れていない)` : "",
    keep.length ? `keep ${keep.length} 件は Brief に照らして意図どおり＝直さない` : "",
    briefMissing ? "Brief が無いので判断はルールだけ。dx12_brief で作品の意図を書くと keep の判断が入る" : "",
  ].filter(Boolean).join("。");
  return {
    pass, blocking: listedBlocking, keep: listedKeep, suggestions: suggestions.slice(0, 20), uncertain: listedUncertain,
    counts: { blocking: blocking.length, keep: keep.length, uncertain: uncertain.length, suggestions: suggestions.length },
    blockingByCode, truncated, cost, checks,
    judge: { used: useJudge && units.length > 0, source, ...(briefMissing ? { briefMissing: true } : {}), bundle: bundleMode, bundles: bundles.length },
    elapsedMs: now() - t0,
    next,
  };
}
