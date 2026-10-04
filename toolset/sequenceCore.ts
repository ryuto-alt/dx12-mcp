// dx12_sequence: シーケンサー(.dxseq。時間軸の演出 = カメラワーク・カット・イベント)の Core ツール。
//   dx12_sequence {op, …} → エンジン method sequence_<op>(edit だけ sequence_apply_op)へ、引数をそのまま渡す。
//   純ロジック(op の振り分け・引数検査・dryRun・エラー整形)は ../sequenceOps.ts(単体テストは sequenceCore.test.ts)。ここは MCP への登録と、エンジンへの中継だけ。
//
//   ・旧ツール(routes)を持たない「エンジン直結」の Core ツール。旧 dx12_sequence_author / dx12_sequence_preview / dx12_camera_path は別物で、名前・引数・返り値は不変。
//   ・core 面だけ tools/list に出る(full / shell 面は登録表にだけ入り、dx12_tool_describe / dx12_call で使える。full 面の旧 220 本の並びは変えない)。
//   ・エラーは ErrorBody を最初から組んで返す(ERROR_BODY)。dx12_call 経由でも組み直さない。fix はそのまま撃ち直せる dx12_sequence の呼び出し。
//   ・dryRun:true は shape に持つ(dx12_call が native dryRun として dryRun:true を渡す)。edit / save / scrub / play はエンジンのプレビュー表、
//     load / stop / autoplay は実行せず静的に答える、読み取りの op は無視して実行する。
//
// ★all.ts で coreTools.ts の後に import する。
import { z } from "zod";
import { server, engine, type ToolResult } from "./core.ts";
import { manifestStore } from "./shell.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY, callContext, recordError } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS } from "../coreSpec.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { structureError } from "../structure.ts";
import {
  SEQUENCE_OPS, SEQUENCE_OP_SPECS, SEQUENCE_TOOL, finalizeSequenceResult, finishSequenceError, isSequenceNotFound,
  normalizeOp, planSequenceCall, sequenceNotFoundBody, staticPreview,
} from "../sequenceOps.ts";

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}

function okResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: (data ?? null) as any } };
}

// [op] を先頭に付けて、どの op の引数かを説明文から分かるようにする(dx12_tool_describe {target:'<op>'} はその op の引数だけを返す)。
export const SEQUENCE_SHAPE: Record<string, z.ZodTypeAny> = {
  op: z.enum(SEQUENCE_OPS as unknown as [string, ...string[]]).describe(
    "操作(エンジンの method sequence_<op> に対応)。list=一覧 / load=メモリへ読む・作る / get=中身 / eval=非破壊で時刻の値を読む / edit=編集(sequence_apply_op)/ save=保存 / scrub=エディタ上に適用 / play=再生 / stop=停止 / autoplay=Play 開始時の自動再生設定。"),
  name: z.string().optional().describe("シーケンス名(assets/sequences/<name>.dxseq)または assets 相対パス。list / stop / autoplay 以外の op で必要(scrub は end:true なら不要)。"),
  t: z.number().optional().describe("[eval|scrub] 時刻(秒)。tick / frame でも指定できる(優先: tick > frame > t)。"),
  tick: z.number().int().optional().describe("[eval|scrub] 時刻(ティック。既定 6000/秒)。"),
  frame: z.number().int().optional().describe("[eval|scrub] 時刻(フレーム番号。シーケンスの fps)。"),
  detail: z.enum(["summary", "full"]).optional().describe("[get] summary(既定)= 構成の要約と解決状況 / full = 正準形の全文(dxseq)と JSON。"),
  create: z.boolean().optional().describe("[load] true: 無ければ空の文書を作る(ファイルは save まで作らない)。既定 false。"),
  fps: z.number().int().min(1).max(1000).optional().describe("[load] create のときのフレームレート(整数。既定 30。23.976 / 29.97 は 24 / 30 で編集する)。"),
  reload: z.boolean().optional().describe("[load] true: 開いている文書をディスクから読み直す(未保存の編集は失う)。"),
  path: z.string().optional().describe("[save] 別名保存の名前(assets/sequences/<path>.dxseq)または assets 相対パス。以後その名前になる。"),
  ops: z.array(z.any()).optional().describe("[edit] SeqOp の配列。各要素 {\"op\":\"addKey\", …}。1 回の呼び出し = Undo 1 ステップ(全部成功か全部巻き戻し)。ID は省略可。addBinding は entity:\"名前\" で対象を指せる。名前とフィールドは docs/DXSEQ_FORMAT.md。undo / redo のときは不要。"),
  label: z.string().optional().describe("[edit] Undo の表示名。"),
  undo: z.boolean().optional().describe("[edit] true: 直前の編集を取り消す(ops は不要)。"),
  redo: z.boolean().optional().describe("[edit] true: 取り消した編集をやり直す。"),
  end: z.boolean().optional().describe("[scrub] true: スクラブを終えて退避していた値を元へ戻す(name は不要)。"),
  loop: z.any().optional().describe("[play] once | loop | pingpong(省略 = シーケンスの meta.loop)。[autoplay] true / false(add のループ)。"),
  rate: z.number().optional().describe("[play|autoplay] 再生速度(既定 1。負 = 逆再生)。"),
  from: z.number().optional().describe("[play] 開始位置(秒。既定 0)。"),
  clock: z.enum(["real", "game"]).optional().describe("[play|autoplay] real = 実時間(既定)/ game = ゲーム時間(タイムスケール適用)。"),
  restoreOnEnd: z.boolean().optional().describe("[play] 終了時にタイムスケール・カットの選択を戻す(既定 true)。"),
  delay: z.number().optional().describe("[play] 開始までの待ち(秒。既定 0)。"),
  restore: z.boolean().optional().describe("[stop] Editor のとき: 元の値へ戻す(既定 true。false でプレビュー位置に留める)。"),
  action: z.enum(["list", "set", "add", "remove", "clear"]).optional().describe("[autoplay] 下位操作(既定 list)。エンジンの sequence_autoplay の op に当たる(dx12_sequence の op と衝突するので action)。"),
  sequence: z.string().optional().describe("[autoplay] add / remove の対象のシーケンス名。"),
  startDelay: z.number().optional().describe("[autoplay] add: Play 開始からの待ち(秒)。"),
  players: z.array(z.any()).optional().describe("[autoplay] action:set で全置換する [{sequence, loop?, rate?, startDelay?, clock?}, …]。"),
  dryRun: z.boolean().optional().describe("true で実行せず影響だけ返す。edit / save / scrub / play はエンジンが実際の影響を返す。load / stop / autoplay は静的な予測。list / get / eval は読み取りなので無視して実行する。"),
};

/** 使い方の例(dx12_tool_search / dx12_tool_describe に出る。sequenceCore.test.ts が全部 planSequenceCall を通ることを確かめる)。 */
export const SEQUENCE_EXAMPLES: { args: Record<string, unknown>; note: string }[] = [
  { args: { op: "list" }, note: "シーケンスの一覧(assets/sequences/ と開いている文書)" },
  { args: { op: "load", name: "Intro", create: true, fps: 30 }, note: "空のシーケンス Intro を作る(ファイルは save まで作らない)" },
  {
    args: { op: "edit", name: "Intro", ops: [{ op: "addBinding", binding: { id: "b_cam", entity: "Camera", tracks: [{ id: "t_tr", type: "transform", channels: { "position.x": { keys: [[0, 0, "a"], [30000, 10, "a"]] } } }] } }] },
    note: "Camera にバインディングと位置トラックを足す(時刻はティック。6000/秒)",
  },
  { args: { op: "eval", name: "Intro", t: 2.5 }, note: "2.5 秒の値を非破壊で読む" },
  { args: { op: "scrub", name: "Intro", t: 2.5 }, note: "エディタ上で 2.5 秒に適用する(見た目は dx12_capture {view:'game'})" },
  { args: { op: "scrub", end: true }, note: "スクラブを終えて元の値へ戻す" },
  { args: { op: "save", name: "Intro", dryRun: true }, note: "書く先と大きさだけ確かめる" },
  { args: { op: "autoplay", action: "add", sequence: "Intro" }, note: "Play 開始時に Intro を自動再生する" },
];

async function invoke(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const plan = planSequenceCall(args);
  if (!plan.ok) {
    recordError({ at: Date.now(), tool: SEQUENCE_TOOL, code: plan.body.code, message: plan.body.message });
    return errorResult(plan.body);
  }
  if (plan.dryRunMode === "static") return okResult(staticPreview(plan, args));
  try {
    const timeout = manifestStore.get(plan.method)?.timeoutMs ?? plan.spec.timeoutMs;
    const raw = await engine.call(plan.method, plan.params, { timeout });
    return okResult(finalizeSequenceResult(plan, raw));
  } catch (e: any) {
    let body: ErrorBody;
    try {
      body = isSequenceNotFound(e) ? sequenceNotFoundBody(e, plan.op, args) : await structureError(e, { tool: SEQUENCE_TOOL, args, engine });
      body = finishSequenceError(body, plan.op, args);
    } catch {
      body = { code: "E_INTERNAL", message: `dx12_sequence {op:'${plan.op}'}: ${e?.message ?? e}`, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と版を確認する" }] };
    }
    recordError({ at: Date.now(), tool: SEQUENCE_TOOL, code: body.code, message: body.message });
    return errorResult(body);
  }
}

function register() {
  const title = "シーケンス(.dxseq)を編集・評価・再生";
  const description = CORE_DESCRIPTIONS[SEQUENCE_TOOL];
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
  let registered: { enable(): void; disable(): void; remove(): void } | undefined;
  // core 面だけ MCP の tools/list に出す。それ以外は登録表にだけ入れる(dx12_tool_describe / dx12_call が引く)。
  if (SURFACE === "core") {
    registered = server.registerTool(
      SEQUENCE_TOOL,
      { title, description, inputSchema: z.object(SEQUENCE_SHAPE).passthrough() as any, annotations: { title, openWorldHint: false, ...annotations } },
      async (args: any) => callContext.run({ tool: SEQUENCE_TOOL, args, mode: "direct" }, () => invoke(args)),
    );
  }
  TOOL_REGISTRY.set(SEQUENCE_TOOL, {
    name: SEQUENCE_TOOL, title, description, shape: SEQUENCE_SHAPE, annotations,
    tier: "core", core: true, coreDescription: description,
    opTable: {
      param: "op", normalize: (raw) => normalizeOp(raw),
      ops: Object.fromEntries(SEQUENCE_OPS.map((o) => {
        const s = SEQUENCE_OP_SPECS[o];
        return [o, { method: s.method, effect: s.effect, required: s.required, optional: s.optional, dryRun: s.dryRun === "engine" ? "preview" : s.dryRun, summary: s.summary }];
      })),
    },
    examples: SEQUENCE_EXAMPLES,
    invoke: async (args: any) => invoke(args), listed: SURFACE === "core", registered,
  });
}

if (ENHANCED) register();

