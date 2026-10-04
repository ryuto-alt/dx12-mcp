// 宣言的シーン生成(M11)のツール 2 本: dx12_apply_scene_spec(core)と dx12_scene_spec_export(長尾 = dx12_call)。
// 本体は ../sceneSpec/(純ロジック + 注入された engine)。ここは MCP への登録・引数検証・承認(prune)・進捗通知・構造化エラーの変換・ジョブへの橋渡しだけ。
//
//   ・失敗(仕様の検証・配置・適用・自動検証)は必ず E_VALIDATION_FAILED(または E_OUT_OF_RANGE)+ issues[{path(JSON Pointer), code, message, specPatch}]
//     + details.specPatch(全部まとめた RFC 6902 の差分)+ fix[0] = そのまま撃ち直せる {specRef, patch}。エンジンは検証の失敗では 1 つも書かず、
//     適用中/適用後の失敗ではロールバック済み(部分適用を残さない)。
//   ・prune:true(いまの仕様に無い物を消す)は削除 = guarded。core 面は dx12_call_guarded、full / shell 面は dx12_call {confirm:true} の経由でだけ実行できる。
//   ・legacy 面(旧 220 本のスナップショット)には出さない。core 面は dx12_apply_scene_spec だけ tools/list に出る(export は dx12_call)。
//
// ★all.ts で editorTools.ts の後に import する。
import { z } from "zod";
import { server, engine, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY, callContext, recordError } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS, CORE_GUARDED_TOOL, CORE_SCENE_SPEC, SCENE_SPEC_TOOLS } from "../coreSpec.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { bodyFromIssues, unknownKeyIssues } from "../validate.ts";
import { isGuardApproved } from "../guardCtx.ts";
import { LOOK_IDS } from "../lookDev.ts";
import { runSceneSpec, SpecCache, type SpecResult } from "../sceneSpec/index.ts";
import { exportScene } from "../sceneSpec/export.ts";
import type { PatchOp } from "../sceneSpec/types.ts";
import { getJobs } from "../jobs/runtime.ts";
import { isTerminal } from "../jobs/types.ts";

export const APPLY_SPEC_TOOL = "dx12_apply_scene_spec";
export const EXPORT_SPEC_TOOL = "dx12_scene_spec_export";

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}
function okResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: (data ?? null) as any } };
}

const patchOp = z.object({
  op: z.enum(["add", "replace", "remove", "move", "copy", "test"]).describe("RFC 6902 の操作。"),
  path: z.string().describe("仕様のルートからの JSON Pointer(例 /entities/2/model)。"),
  value: z.any().optional().describe("add / replace / test の値。"),
  from: z.string().optional().describe("move / copy の元の path。"),
});

export const APPLY_SPEC_SHAPE: Record<string, z.ZodTypeAny> = {
  spec: z.union([z.record(z.any()), z.string()]).optional().describe(
    "シーン仕様(SceneSpec v1)。{version:1, name?, entities:[{name, kind, at, rotation, scale|size, color, material, place, pattern, components, script, tags, data, group, parent}], lighting?, look?, sun?, scene?, navmesh?, verify?}。単位はメートル。書き方・例は dx12_guide {topic:'scene_spec'}。省略して specRef + patch で撃ち直せる。"),
  specRef: z.string().optional().describe("直前に送った仕様の参照(結果の specRef。サーバのメモリに最大 16 件)。patch と組み合わせて撃ち直す。"),
  patch: z.array(patchOp).optional().describe("仕様への差分(RFC 6902)。失敗結果の specPatch / fix[0].args.patch をそのまま渡す。spec と併用すると spec に適用してから実行する。"),
  mode: z.enum(["plan", "apply"]).optional().describe("plan=差分計画だけ(エンジンに何も書かない。作成/更新/削除/変更なしと理由・影響・コスト)/ apply=適用して検証(既定)。"),
  dryRun: z.boolean().optional().describe("true で mode:'plan' と同じ(dx12_call の dryRun 用)。"),
  verify: z.union([z.boolean(), z.object({
    layout: z.enum(["error", "warn", "off"]).optional().describe("配置検査(埋まり・浮き・重なり・当たり判定・スケール異常)。error(既定)= この仕様が作った物の error はロールバック。"),
    naming: z.enum(["error", "warn", "off"]).optional().describe("命名規約(<PREFIX>_<Kind>_<NN>・グループ)。既定 warn。"),
    scene: z.boolean().optional().describe("true で validate_scene(参照グラフ)も走らせる。"),
    reachable: z.union([z.object({ from: z.string(), to: z.string() }), z.array(z.object({ from: z.string(), to: z.string() }))]).optional().describe("到達性: {from, to}(エンティティ名)。ナビメッシュが無ければ spec.navmesh.build:true で焼く。"),
  }).passthrough()]).optional().describe("自動検証。false で全部省く。仕様の verify より優先。"),
  prune: z.boolean().optional().describe("true で、この仕様(同じ name)が前に作ったが今の仕様に無いエンティティを消す。手で置いた物・他の仕様の物は消さない。削除なので承認が要る(dx12_call_guarded / confirm:true)。"),
  detail: z.number().int().min(1).max(500).optional().describe("plan に各 action を何件まで載せるか(既定 60。件数の多い仕様の応答を小さくする)。"),
  async: z.boolean().optional().describe("true で大規模な仕様をジョブ(dx12_job_start kind:'scene_spec')として非同期に実行し、job id を返す(進捗は dx12_job_status)。上限は 5,000 体。"),
};

export const EXPORT_SPEC_SHAPE: Record<string, z.ZodTypeAny> = {
  owned: z.boolean().optional().describe("true で、仕様が作った物(所有者の印 __spec があるもの)だけ書き出す。既定 false(シーン全体。エディタ内部のグリッドとグループの根は除く)。"),
  name: z.string().optional().describe("仕様の name(省略で、所有者の印が 1 種類ならそれ、無ければ 'exported')。"),
  only: z.array(z.string()).optional().describe("名前の一覧に絞る。"),
  prefix: z.string().optional().describe("名前の接頭辞で絞る(例 'LVL_')。"),
};

const TITLES: Record<string, string> = { [APPLY_SPEC_TOOL]: "シーン仕様(JSON)を差分適用して検証", [EXPORT_SPEC_TOOL]: "現在のシーンを仕様 JSON に書き出す" };
const ANNOTATIONS: Record<string, Record<string, unknown>> = {
  [APPLY_SPEC_TOOL]: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  [EXPORT_SPEC_TOOL]: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};
const KEYWORDS: Record<string, string> = {
  [APPLY_SPEC_TOOL]: "scene spec declarative apply plan diff generate build level room stage arena street town garden corridor showcase layout place relative grid ring scatter pattern one shot idempotent 仕様 宣言的 シーン生成 ステージを作って 街を並べて 部屋を作って 廊下 庭 アリーナ ショーケース 一括配置 一括生成 相対配置 右に 上に載せる 円形に 格子状に 壁に沿って 散らす 差分 適用 冪等 検証つき まとめて作る レベル 街並み 並べる ステージ一式 部屋一式 JSON で作る",
  [EXPORT_SPEC_TOOL]: "scene spec export dump current scene to json declarative round trip 現在のシーンを仕様に 書き出す 仕様 JSON エクスポート シーンを仕様にする 往復 今のシーンを JSON にして 仕様に起こす",
};
const EXAMPLES: Record<string, { args: Record<string, unknown>; note: string }[]> = {
  [APPLY_SPEC_TOOL]: [
    { args: { spec: { version: 1, name: "room", entities: [{ name: "LVL_Floor", kind: "plane", size: [8, 8], group: "LVL" }, { name: "LVL_Crate", kind: "box", size: 1, group: "LVL", at: [2, null, 1], place: { on: "LVL_Floor" } }] } }, note: "床と、床の上に載る箱(y は AABB の実測で決まる)。同じ仕様をもう一度撃っても何も変わらない" },
    { args: { spec: { version: 1, name: "room", entities: [{ name: "LVL_Floor", kind: "plane", size: [8, 8], group: "LVL" }] }, mode: "plan" }, note: "差分計画だけ(何も書かない)" },
    { args: { specRef: "<前回の specRef>", patch: [{ op: "replace", path: "/entities/1/model", value: "models/crate.glb" }] }, note: "失敗結果の specPatch をそのまま撃ち直す" },
  ],
  [EXPORT_SPEC_TOOL]: [{ args: { owned: true }, note: "仕様が作った物だけを仕様に書き出す(往復)" }],
};

function textOf(res: ToolResult): { ok: boolean; data?: any; error?: string } {
  const last = res.content?.[res.content.length - 1] as any;
  const t = typeof last?.text === "string" ? last.text : "";
  try { const d = JSON.parse(t); return { ok: !res.isError && d?.ok !== false, data: d?.result ?? d, error: res.isError ? String(d?.error ?? t).slice(0, 300) : undefined }; }
  catch { return { ok: !res.isError, error: t.slice(0, 300) }; }
}

/** TS ツール(look_apply / check_reachable)を、登録表から呼ぶ。 */
async function callRegistryTool(name: string, args: Record<string, unknown>) {
  const e = TOOL_REGISTRY.get(name);
  if (!e) return { ok: false, error: `${name} が登録されていない` };
  try { return textOf(await e.invoke(args)); } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; }
}

/** MCP サーバ全体で 1 つの仕様キャッシュ。 */
export const SPEC_CACHE = new SpecCache();

function progressFromExtra(extra: any): ((p: { phase: string; pct: number; message: string }) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if ((typeof token !== "string" && typeof token !== "number") || typeof send !== "function") return undefined;
  let last = 0;
  return (p) => {
    if (last >= 100) return;
    const progress = Math.min(100, Math.max(last + 0.001, p.pct));
    last = progress;
    try { void Promise.resolve(send({ method: "notifications/progress", params: { progressToken: token, progress, total: 100, message: `[scene_spec] ${p.message}`.slice(0, 300) } })).catch(() => { /* ベストエフォート */ }); } catch { /* 同上 */ }
  };
}

/** 失敗結果 → 構造化エラー。specPatch と、そのまま撃ち直せる fix を付ける。 */
export function bodyFromFailure(r: Extract<SpecResult, { ok: false }>, args: Record<string, unknown>): ErrorBody {
  const main = r.issues.find((i) => i.severity === "error") ?? r.issues[0];
  const MAX = 40;
  const issues = r.issues.slice(0, MAX);
  const retryArgs: Record<string, unknown> = { specRef: r.specRef, patch: r.specPatch };
  for (const k of ["mode", "verify", "prune", "detail", "async"]) if (args[k] !== undefined) retryArgs[k] = args[k];
  const fix: ErrorBody["fix"] = [];
  if (r.specRef && r.specPatch.length) fix.push({ tool: APPLY_SPEC_TOOL, args: retryArgs, why: `specPatch(${r.specPatch.length} 操作。機械的に直せる分)を仕様に当てて撃ち直す` });
  else if (!r.specRef && main?.fix) fix.push(...(main.fix as any[]));
  if (r.code === "E_MODE_CONFLICT") fix.unshift({ tool: "dx12_stop", args: {}, thenRetry: true, why: "Editor モードへ戻してから同じ呼び出しを撃ち直す" });
  fix.push({ tool: "dx12_guide", args: { topic: "scene_spec" }, why: "仕様の書き方・よくある失敗・例" });
  return {
    code: r.code,
    message: `${APPLY_SPEC_TOOL}: ${r.message}`,
    cause: main?.cause ?? main?.message,
    retryable: false,
    didYouMean: main?.didYouMean?.length ? main.didYouMean : undefined,
    validValues: main?.validValues as string[] | undefined,
    fix,
    issues,
    details: { stage: r.stage, specRef: r.specRef, specPatch: r.specPatch, ...(r.issues.length > MAX ? { issuesOmitted: r.issues.length - MAX } : {}), ...r.data },
    docs: "dx12_guide {topic:'scene_spec'}",
  };
}

async function invokeApply(rawArgs: Record<string, unknown> | undefined, extra?: any): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const mode = args.dryRun === true ? "plan" : ((args.mode as "plan" | "apply" | undefined) ?? "apply");
  // 削除(prune)は guarded: 承認済みの経路(dx12_call_guarded / dx12_call {confirm:true})でだけ実行する。plan は誰でも撃てる(何を消すかが見える)。
  if (args.prune === true && mode === "apply" && !isGuardApproved()) {
    const split = SURFACE === "core";
    const via = split ? CORE_GUARDED_TOOL : "dx12_call";
    const body: ErrorBody = {
      code: "E_GUARDED", message: `${APPLY_SPEC_TOOL} {prune:true} は仕様に無いエンティティを削除する(guarded)。ユーザーの承認が要る`,
      cause: split ? `削除を伴う適用は ${CORE_GUARDED_TOOL} から実行する(ユーザーが毎回承認する)` : "削除を伴う適用は dx12_call {confirm:true} から実行する(ユーザーの承認を得てから)",
      fix: [
        { tool: APPLY_SPEC_TOOL, args: { ...args, mode: "plan" }, why: "まず mode:'plan' で何が消えるか(plan.delete)を確認する" },
        { tool: via, args: split ? { name: APPLY_SPEC_TOOL, args } : { name: APPLY_SPEC_TOOL, args, confirm: true }, why: "承認を得たあとで実行する" },
      ],
      details: { effect: "guarded", via },
    };
    recordError({ at: Date.now(), tool: APPLY_SPEC_TOOL, code: body.code, message: body.message });
    return errorResult(body);
  }
  try {
    // 大規模はジョブ(進捗つき・非同期)
    if (args.async === true) {
      const spec = args.spec ?? (typeof args.specRef === "string" ? SPEC_CACHE.get(args.specRef) : undefined);
      if (spec === undefined) return errorResult({ code: "E_MISSING_PARAM", message: `${APPLY_SPEC_TOOL} {async:true} には spec(または保存済みの specRef)が要る`, fix: [{ tool: "dx12_guide", args: { topic: "scene_spec" }, why: "仕様の書き方" }] });
      const mgr = getJobs();
      const view = await mgr.start({ kind: "scene_spec", args: { spec: spec as any, ...(args.patch ? { patch: args.patch } : {}), mode, verify: args.verify, prune: args.prune === true, detail: args.detail }, approved: isGuardApproved() });
      return okResult({ ok: true, async: true, job: { id: view.id, state: view.state }, next: [{ tool: "dx12_job_status", args: { id: view.id, waitSec: 30 }, when: "進捗を待つ(終わるまで最大 30 秒ずつ)" }, { tool: "dx12_job_result", args: { id: view.id }, when: "終わったら plan / verify / 失敗時の specPatch の全文を読む" }] });
    }
    const r = await runSceneSpec({
      engine, cache: SPEC_CACHE, looks: LOOK_IDS, onProgress: progressFromExtra(extra),
      callTool: (name, a) => callRegistryTool(name, a),
    }, { spec: args.spec, specRef: args.specRef as string | undefined, patch: args.patch as PatchOp[] | undefined, mode, verify: args.verify, prune: args.prune === true, detail: args.detail as number | undefined });
    if (r.ok) return okResult(r.data);
    const body = bodyFromFailure(r, args);
    recordError({ at: Date.now(), tool: APPLY_SPEC_TOOL, code: body.code, message: body.message });
    return errorResult(body);
  } catch (e: any) {
    const body: ErrorBody = e?.errName ? { code: e.errName, message: `${APPLY_SPEC_TOOL}: ${e.message}`, retryable: !!e.retryable, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と状態を診断する" }] }
      : { code: "E_INTERNAL", message: `${APPLY_SPEC_TOOL}: ${String(e?.message ?? e)}`, retryable: false, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と状態を診断する" }] };
    recordError({ at: Date.now(), tool: APPLY_SPEC_TOOL, code: body.code, message: body.message });
    return errorResult(body);
  }
}

async function invokeExport(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const a = rawArgs ?? {};
  try {
    const r = await exportScene(engine, { owned: a.owned === true, name: a.name as string | undefined, only: a.only as string[] | undefined, prefix: a.prefix as string | undefined });
    return okResult({ ok: true, entityCount: r.entityCount, spec: r.spec, skipped: r.skipped.slice(0, 20), notes: r.notes, next: "この仕様は dx12_apply_scene_spec {spec} でそのまま適用できる(同じ name なら差分適用)。相対配置・パターンは平らな座標になっている" });
  } catch (e: any) {
    const body: ErrorBody = { code: e?.errName ?? "E_INTERNAL", message: `${EXPORT_SPEC_TOOL}: ${String(e?.message ?? e)}`, retryable: false, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と状態を診断する" }] };
    recordError({ at: Date.now(), tool: EXPORT_SPEC_TOOL, code: body.code, message: body.message });
    return errorResult(body);
  }
}

const SHAPES: Record<string, Record<string, z.ZodTypeAny>> = { [APPLY_SPEC_TOOL]: APPLY_SPEC_SHAPE, [EXPORT_SPEC_TOOL]: EXPORT_SPEC_SHAPE };

function wrapped(name: string) {
  const declared = Object.keys(SHAPES[name]);
  return async (args: any, extra?: any): Promise<ToolResult> => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) return errorResult(bodyFromIssues(name, args ?? {}, issues, declared));
    return name === APPLY_SPEC_TOOL ? invokeApply(args ?? {}, extra) : invokeExport(args ?? {});
  };
}

function register() {
  for (const name of SCENE_SPEC_TOOLS) {
    const shape = SHAPES[name];
    const title = TITLES[name];
    const description = CORE_DESCRIPTIONS[name];
    const invoke = wrapped(name);
    const inCore = CORE_SCENE_SPEC.includes(name);
    const hidden = SURFACE === "shell" || (SURFACE === "core" && !inCore);
    const registered = server.registerTool(
      name,
      { title, description, inputSchema: z.object(shape).passthrough() as any, annotations: { title, ...ANNOTATIONS[name] } },
      async (args: any, extra: any) => callContext.run({ tool: name, args, mode: "direct" }, () => invoke(args, extra)),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title, description, shape, annotations: ANNOTATIONS[name], tier: "core", core: inCore, coreDescription: description,
      extraKeywords: KEYWORDS[name], examples: EXAMPLES[name],
      invoke: async (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}

if (ENHANCED && SURFACE !== "legacy") register();

// ジョブ(inproc)から呼べるように、TS ツールの呼び出し口を公開する。
export { callRegistryTool, isTerminal };
