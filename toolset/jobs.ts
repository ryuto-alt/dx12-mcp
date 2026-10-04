// ジョブ API のツール 6 本: dx12_job_start / status / cancel(core)と list / result / logs(長尾 = dx12_call)。
// 中身は jobs/manager.ts。ここは MCP への登録・引数検証・進捗通知(notifications/progress)・構造化エラーの変換だけ。
//
//   ・進捗の主経路はポーリング(dx12_job_status。waitSec を付けると long-poll)。progressToken が付いた呼び出しが待っている間だけ
//     notifications/progress も送る(ベストエフォート。Claude Code / Codex が受け取るかは未確認)。
//   ・external(任意の外部プロセス)は guarded。dx12_call_guarded / dx12_call {confirm:true} の経由でだけ実行できる(guardCtx.ts)。
import { z } from "zod";
import { server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, recordError, ERROR_BODY } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS, CORE_JOBS, JOB_TOOLS } from "../coreSpec.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { bodyFromIssues, unknownKeyIssues, validateAgainstShape } from "../validate.ts";
import { isGuardApproved } from "../guardCtx.ts";
import { getJobs, jobsConfig } from "../jobs/runtime.ts";
import { JobFailure } from "../jobs/manager.ts";
import { JOB_KINDS, isTerminal, type JobView } from "../jobs/types.ts";

const cfg0 = jobsConfig();

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}

/** 進捗通知(notifications/progress)を送る関数を作る。progressToken が無ければ何もしない。 */
export function progressNotifier(extra: any): ((v: JobView) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if ((typeof token !== "string" && typeof token !== "number") || typeof send !== "function") return undefined;
  let last = 0;
  return (v) => {
    const pct = typeof v.progress.pct === "number" ? v.progress.pct : null;
    // progress は通知ごとに増える必要がある(MCP の約束)。pct が無い/戻ったときも小さく足す。
    if (last >= 100) return;   // total を超える値は送らない(100 に達したら以後は通知しない)
    const progress = Math.min(100, Math.max(last + 0.001, pct ?? last));
    last = progress;
    const msg = `[${v.kind}] ${v.state === "queued" ? `順番待ち(${v.queuePosition ?? "?"} 番目)` : v.progress.message || v.progress.phase}${v.progress.etaSec != null ? `(残り約 ${v.progress.etaSec} 秒)` : ""}`;
    try { void Promise.resolve(send({ method: "notifications/progress", params: { progressToken: token, progress, total: 100, message: msg.slice(0, 300) } })).catch(() => { /* 通知はベストエフォート */ }); }
    catch { /* 同上 */ }
  };
}

/** status / start の返り値に「次の一手」を足す。 */
export function presentView(v: JobView): Record<string, unknown> {
  const next: { tool: string; args: Record<string, unknown>; when: string }[] = [];
  let hint: string;
  if (v.state === "queued") {
    hint = `順番待ち(${v.queuePosition ?? "?"} 番目)。別の作業を続けてよい。終わるまで待つなら dx12_job_status {id, waitSec:30}`;
    next.push({ tool: "dx12_job_status", args: { id: v.id, waitSec: 30 }, when: "進捗を待つ(最大 30 秒ずつ)" }, { tool: "dx12_job_cancel", args: { id: v.id }, when: "取りやめる" });
  } else if (v.state === "running") {
    hint = "実行中。別の作業と並行してよい。終わるまで待つなら dx12_job_status {id, waitSec:30}(変化のたびに進捗も届く)";
    next.push({ tool: "dx12_job_status", args: { id: v.id, waitSec: 30 }, when: "進捗を待つ(最大 30 秒ずつ)" }, { tool: "dx12_job_cancel", args: { id: v.id }, when: "止める(プロセスツリーごと終了)" });
  } else if (v.state === "succeeded") {
    hint = "成功。summary に要点、全文は dx12_job_result。";
    next.push({ tool: "dx12_job_result", args: { id: v.id }, when: "結果の全文を読む" });
  } else {
    hint = v.state === "cancelled" ? "キャンセルされた。" : v.state === "timeout" ? "タイムアウトで打ち切られた。timeoutSec を延ばすか、ログで止まった場所を確認する。" : "失敗。error と summary(errors / failedTests)を読み、ログで詳細を確認する。";
    next.push({ tool: "dx12_job_logs", args: { id: v.id, tail: 100 }, when: "出力の末尾を読む" }, { tool: "dx12_job_result", args: { id: v.id }, when: "結果の全文(失敗の詳細)を読む" });
  }
  return { ...v, hint, next };
}

type Def = { title: string; shape: Record<string, z.ZodTypeAny>; annotations: Record<string, unknown>; keywords: string; run: (a: any, extra: any) => Promise<unknown> | unknown };

const engineRef = z.union([z.string(), z.number().int()]);

const DEFS: Record<string, Def> = {
  dx12_job_start: {
    title: "長い処理をジョブで開始",
    shape: {
      kind: z.enum(JOB_KINDS as unknown as [string, ...string[]]).describe("build=tools\\build.ps1 / ctest / ui_tests / screenshot_batch / bench / playtest / scene_spec(シーン仕様の適用) / vg_cook / ue_import / external(承認が要る)。"),
      args: z.record(z.any()).optional().describe("kind ごとの引数。build {target?, tests?, refreshEngines?} / ctest {filter?, exclude?} / ui_tests {skip?, project?} / screenshot_batch {cameras, dpiScales, variants, view} / bench {frames, runs} / playtest {name?} / scene_spec {spec, mode?, verify?, prune?} / vg_cook {input|genBench, output} / ue_import {command, paks, usmap, …}。詳細は dx12_guide {topic:'jobs'}。"),
      engine: engineRef.optional().describe("使うエンジン(id / name / port)。省略で束縛中。bench / playtest / screenshot_batch が使う。"),
      idempotencyKey: z.string().optional().describe("再送で二重に開始しないためのキー。同じキーは前回のジョブを返す(24 時間)。"),
      timeoutSec: z.number().int().min(1).max(21600).optional().describe("タイムアウト(秒)。超えるとプロセスツリーを終了して timeout にする。kind ごとの既定あり。"),
      waitSec: z.number().int().min(0).max(300).optional().describe("最大この秒数だけ終了を待ってから返す(既定 0=待たずに id だけ返す)。待っている間は進捗通知も送る。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    keywords: "job start async background long running build ctest cook bench playtest screenshot batch ビルド ctest 単体テスト 失敗したテスト一覧 テストスイート 全部実行 cook 取り込み ベンチ 繰り返し 中央値 プレイテスト 回帰テスト 保存済みプレイテスト 全部回す スクショ バッチ 一括撮影 複数カメラ 表示倍率 DPI 非同期 バックグラウンド 長い処理 待たない 進捗 ジョブ開始 UI テスト UI 自動テスト 結果を待つ 視覚回帰 vg_cook ue_import run test suite as a job batch screenshots cameras dpi scales repeat benchmark median",
    run: async (a, extra) => {
      const mgr = getJobs();
      const kind = String(a.kind);
      const def = mgr.kindDef(kind);
      let args: Record<string, unknown> = (a.args ?? {}) as Record<string, unknown>;
      if (def) {
        const r = validateAgainstShape(`dx12_job_start(kind:${kind}).args`, def.shape, args);
        if (!r.ok) {
          const body: ErrorBody = { ...r.body };
          body.message = body.message.replace(/^dx12_job_start\(kind:[^)]*\)\.args:\s*/, `dx12_job_start ${kind}: `);
          body.fix = (body.fix ?? []).map((f) => (f.tool?.startsWith("dx12_job_start(") ? { ...f, tool: "dx12_job_start", args: { ...a, args: f.args } } : f.tool === "dx12_tool_describe" ? { ...f, args: { name: "dx12_job_start" } } : f));
          body.docs = "dx12_guide {topic:'jobs'}";
          throw new JobFailure(body);
        }
        args = r.data;
      }
      const key = (a.idempotencyKey ?? a.idempotency_key) as string | undefined;
      let v = await mgr.start({ kind, args, engine: a.engine !== undefined ? String(a.engine) : undefined, idempotencyKey: key, timeoutSec: a.timeoutSec, approved: isGuardApproved() });
      if (a.waitSec && !isTerminal(v.state)) v = await mgr.wait(v.id, { waitMs: a.waitSec * 1000, onProgress: progressNotifier(extra) });
      return presentView(v);
    },
  },
  dx12_job_status: {
    title: "ジョブの状態・進捗",
    shape: {
      id: z.string().optional().describe("ジョブ id(dx12_job_start の返り値)。省略で、動いているジョブの一覧。"),
      waitSec: z.number().int().min(0).max(300).optional().describe("最大この秒数だけ、終了(または until:'change' なら次の変化)を待ってから返す。既定 0=即答。待っている間は進捗通知も送る。"),
      until: z.enum(["done", "change"]).optional().describe("waitSec のとき、done(既定)=終わるまで / change=進捗が変わったら返す。"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "job status progress poll wait eta ジョブ 状態 進捗 ポーリング 待つ 終わった 何 % 残り時間 実行中 ビルドの様子 どうなった",
    run: async (a, extra) => {
      const mgr = getJobs();
      if (!a.id) return { ...mgr.list({ state: "active", limit: 20 }), hint: "id を渡すとそのジョブの進捗を返す(waitSec で待てる)。終わったものも含む一覧は dx12_job_list" };
      const v = await mgr.wait(String(a.id), { waitMs: (a.waitSec ?? 0) * 1000, until: a.until, onProgress: a.waitSec ? progressNotifier(extra) : undefined });
      return presentView(v);
    },
  },
  dx12_job_cancel: {
    title: "ジョブをキャンセル",
    shape: {
      id: z.string().describe("止めるジョブ id。"),
      force: z.boolean().optional().describe("他のセッションが起動した(生きている)ジョブを止める。ユーザーの承認を得たときだけ。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "job cancel stop kill abort ジョブ キャンセル 止める 中止 中断 終了 やめる 取り消し",
    run: async (a) => presentView(await getJobs().cancel(String(a.id), { force: a.force === true })),
  },
  dx12_job_list: {
    title: "ジョブの一覧",
    shape: {
      state: z.enum(["active", "queued", "running", "succeeded", "failed", "cancelled", "timeout"]).optional().describe("絞り込み。active=動いている(queued + running)。"),
      kind: z.enum(JOB_KINDS as unknown as [string, ...string[]]).optional().describe("種類で絞る。"),
      mine: z.boolean().optional().describe("true=このセッションが起動したものだけ。"),
      limit: z.number().int().min(1).max(200).optional().describe("最大件数(新しい順、既定 30)。"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "job list jobs history background jobs all running queued finished ジョブ 一覧 履歴 実行中 順番待ち 終わったジョブ 過去のビルド 再起動前のジョブ",
    run: async (a) => ({ ...getJobs().list({ state: a.state, kind: a.kind, mine: a.mine, limit: a.limit }), dir: getJobs().cfg.dir }),
  },
  dx12_job_result: {
    title: "ジョブの結果の全文",
    shape: { id: z.string().describe("終わったジョブの id。") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "job result output summary errors failed tests contact sheet manifest ジョブ 結果 全文 失敗したテスト ビルドエラー 撮影結果 マニフェスト コンタクトシート",
    run: (a) => { const r = getJobs().result(String(a.id)); return { ...presentView(r.view), result: r.result, resultTruncated: r.truncated }; },
  },
  dx12_job_logs: {
    title: "ジョブのログの末尾",
    shape: {
      id: z.string().describe("ジョブ id(実行中でも読める)。"),
      tail: z.number().int().min(1).max(500).optional().describe("末尾の行数(既定 100、最大 500)。"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "job log output tail console ジョブ ログ 出力 末尾 標準出力 ビルドログ 何が起きているか",
    run: (a) => { const r = getJobs().logs(String(a.id), a.tail ?? 100); return { id: r.view.id, state: r.view.state, lines: r.lines, totalBytes: r.totalBytes, truncatedHead: r.truncatedHead, logPath: r.view.logPath }; },
  },
};

async function jobToolRun(tool: string, fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
  } catch (e: any) {
    const body: ErrorBody = e instanceof JobFailure ? e.body : {
      code: "E_INTERNAL", message: `${tool}: ${e?.message ?? e}`, retryable: false,
      fix: [{ tool: "dx12_doctor", args: {}, why: "ジョブの状態と接続を診断する" }],
    };
    recordError({ at: Date.now(), tool, code: body.code, message: body.message });
    return errorResult(body);
  }
}

if (ENHANCED && SURFACE !== "legacy" && !cfg0.disabled) {
  for (const name of JOB_TOOLS) {
    const def = DEFS[name];
    const description = CORE_DESCRIPTIONS[name];
    const declared = Object.keys(def.shape);
    const invoke = async (args: any, extra?: any): Promise<ToolResult> => {
      const issues = unknownKeyIssues(args ?? {}, declared);
      if (issues.length > 0) return errorResult(bodyFromIssues(name, args ?? {}, issues, declared));
      return jobToolRun(name, () => def.run(args ?? {}, extra));
    };
    const inCore = CORE_JOBS.includes(name);
    const hidden = SURFACE === "shell" || (SURFACE === "core" && !inCore);
    const registered = server.registerTool(
      name,
      { title: def.title, description, inputSchema: z.object(def.shape).passthrough() as any, annotations: { title: def.title, ...def.annotations } },
      async (args: any, extra: any) => invoke(args, extra),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title: def.title, description, shape: def.shape, annotations: def.annotations, tier: "core", core: inCore, coreDescription: description,
      extraKeywords: def.keywords, invoke: (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}
