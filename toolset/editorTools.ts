// エディタ操作(M7)のツール 4 本: dx12_editor_command / dx12_editor_state(core)と dx12_editor_notify / dx12_editor_select(長尾 = dx12_call)。
// 純ロジック(op の振り分け・引数検査・エラーの面別書き換え・助言)は ../editorOps.ts(単体テストは editor.test.ts)。ここは MCP への登録と、エンジンへの中継だけ。
//
//   ・コマンド表(何のコマンドがあるか)はエンジンが唯一の源。TS には 1 件も書かない(list / describe はエンジンの editor_command_list を引く)。
//   ・エラーはエンジンの構造化フィールド(error_name / error_fix / error_did_you_mean)を活かし、TS が足すのは面ごとの撃ち直しだけ(E_GUARDED → dx12_call_guarded など)。
//   ・guarded なコマンド(削除・保存の上書き・ファイルダイアログ・プロジェクトを閉じる)は、editor_command_run が E_GUARDED で断る。
//     承認つきの実行は editor_command_run_guarded(dx12_call_guarded / dx12_call {confirm:true} 経由。トークンは EngineClient が付ける)。
//   ・legacy 面(旧 220 本のスナップショット)には出さない。full 面では旧 220 本 + フリート + ジョブの後ろ(末尾)、core 面は command / state だけ、shell 面は dx12_call で使う。
//
// ★all.ts で jobs.ts の後に import する。
import { z } from "zod";
import { server, engine, type ToolResult } from "./core.ts";
import { manifestStore } from "./shell.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY, callContext, recordError } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS } from "../coreSpec.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { structureError } from "../structure.ts";
import { bodyFromIssues, unknownKeyIssues } from "../validate.ts";
import {
  COMMAND_KINDS, CORE_EDITOR, EDITOR_COMMAND_KEYS, EDITOR_COMMAND_TOOL, EDITOR_METHODS, EDITOR_NOTIFY_TOOL, EDITOR_OPS, EDITOR_OP_SPECS, EDITOR_SELECT_TOOL,
  EDITOR_STATE_TOOL, EDITOR_TOOLS, EDITOR_MODAL_TOOL, MODAL_ACTIONS, finishEditorModalError, planEditorModal, NOTIFY_LEVELS, SELECT_MODES, STATE_SCOPES, finalizeRunResult, finishEditorCommandError, finishEditorSelectError,
  planEditorCommand, planEditorNotify, planEditorSelect, stateAdvice, unwrapDescribe, normalizeOp, type EditorOp,
} from "../editorOps.ts";

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}
function okResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: (data ?? null) as any } };
}

// ── zod の shape(単体テスト editor.test.ts が EDITOR_COMMAND_KEYS と突き合わせる) ──────────────
export const EDITOR_COMMAND_SHAPE: Record<string, z.ZodTypeAny> = {
  op: z.enum(EDITOR_OPS as unknown as [string, ...string[]]).describe(
    "操作。list=コマンド表の一覧(いま実行できるか・理由つき)/ describe=1 件の詳細と引数(id が要る)/ run=実行(id が要る。メニュー・キーと同じ経路)。"),
  id: z.string().optional().describe("[run|describe] コマンド id(例 window.postProcess / create.box / edit.undo / play.toggle)。list の結果の id をそのまま使う(推測しない)。"),
  args: z.record(z.any()).optional().describe("[run] コマンドごとの引数。window.*: {state:'open'|'close'|'toggle'}(既定 open)/ create.*: {position:[x,y,z], name}(既定はカメラ前・床との交点)/ トグル系(view.fill など): {state:'on'|'off'|'toggle'}。他は引数なし。describe で確認。"),
  query: z.string().optional().describe("[list] 絞り込みの語(id・表示名・英名・キー表記を曖昧検索。日本語も英語も可)。"),
  category: z.string().optional().describe("[list] カテゴリで絞る(ファイル・編集・表示・再生・ワークスペース・レンダリング・制作ツール・基本・ライト …。list の categories を参照)。"),
  kind: z.enum(COMMAND_KINDS as unknown as [string, ...string[]]).optional().describe("[list] command=表のコマンド / window=ツール窓の開閉(window.*)/ create=エンティティ作成(create.*)。"),
  enabledOnly: z.boolean().optional().describe("[list] true でいま実行できるコマンドだけ。"),
  guardedOnly: z.boolean().optional().describe("[list] true で guarded(確認が要る危険なコマンド)だけ。"),
  detail: z.boolean().optional().describe("[list] true でラベル英名・説明・効果・引数まで返す(件数が多いときは query / category で絞る)。"),
  dryRun: z.boolean().optional().describe("[run] true で実行せず影響(対象・件数・戻せるか・いま実行できるか)だけ返す。guarded なコマンドでも通る。"),
  idempotency_key: z.string().optional().describe("[run] 再送で二重に実行しないためのキー(同じキーは前回の結果を返す)。"),
};

export const EDITOR_STATE_SHAPE: Record<string, z.ZodTypeAny> = {
  scope: z.enum(STATE_SCOPES as unknown as [string, ...string[]]).optional().describe(
    "読む範囲(既定 all)。selection=選択 / windows=開いているツール窓・ドック・フォーカス / layout=ワークスペース・分割比・ドックのノード構造 / modal=モーダル・ダイアログ(blocking か・種類・閉じ方)/ mode=Play・未保存・カメラ・ビューモード・背景/仮想入力・DPI / undo=履歴 / toasts=直近の通知 / perf=fps など。"),
  limit: z.number().int().min(1).max(50).optional().describe("[toasts] 返す通知の件数(既定 20・最大 50)。"),
};

export const EDITOR_NOTIFY_SHAPE: Record<string, z.ZodTypeAny> = {
  message: z.string().min(1).max(400).describe("人に見せる文(1〜400 字)。"),
  level: z.enum(NOTIFY_LEVELS as unknown as [string, ...string[]]).optional().describe("info(既定)/ success / warn / error。error は既定で長め(6 秒)に出る。"),
  seconds: z.number().min(0.5).max(30).optional().describe("表示する秒数(0.5〜30。省略で種別ごとの既定)。"),
};

export const EDITOR_SELECT_SHAPE: Record<string, z.ZodTypeAny> = {
  mode: z.enum(SELECT_MODES as unknown as [string, ...string[]]).optional().describe("set=置き換え(既定)/ add=追加 / remove=解除 / toggle=反転 / clear=全解除(対象の指定は不要)。"),
  entities: z.array(z.number().int()).optional().describe("エンティティ id の配列。Stop / シーン切り替えで変わるので、安定して指すなら names。"),
  names: z.array(z.string()).optional().describe("エンティティ名(完全一致)の配列。"),
  query: z.string().optional().describe("名前の部分一致(大文字小文字を区別しない。* ? の簡易ワイルドカードも可)。例 'Wall' / 'Wall_0*'。"),
  tag: z.string().optional().describe("タグで選ぶ(Scene のタグ)。"),
  guids: z.array(z.string()).optional().describe("EntityGuid(16 進)の配列。"),
  limit: z.number().int().min(1).max(2000).optional().describe("query / tag で選ぶ最大件数(既定 200)。"),
  focus: z.boolean().optional().describe("true で選択後にカメラを寄せる(edit.focus と同じ)。"),
};

export const EDITOR_EXAMPLES: Record<string, { args: Record<string, unknown>; note: string }[]> = {
  [EDITOR_COMMAND_TOOL]: [
    { args: { op: "list", query: "ポストプロセス" }, note: "コマンドを検索して id(window.postProcess)を知る" },
    { args: { op: "run", id: "window.postProcess" }, note: "Post Process 窓を開く(state:'close' で閉じる)" },
    { args: { op: "run", id: "create.box", args: { position: [0, 0.5, 3], name: "Crate" } }, note: "Box を作る(Undo 1 回で戻る)" },
    { args: { op: "run", id: "edit.undo" }, note: "元に戻す(Ctrl+Z と同じ)" },
    { args: { op: "run", id: "edit.delete", dryRun: true }, note: "guarded なコマンドは dryRun で影響だけ確認できる" },
    { args: { op: "describe", id: "create.box" }, note: "引数と例を確認する" },
  ],
  [EDITOR_STATE_TOOL]: [
    { args: {}, note: "全部(選択・窓・モーダル・モード・Undo・通知)" },
    { args: { scope: "modal" }, note: "モーダルが開いているか(コマンドが E_MODAL_OPEN で断られたとき)" },
    { args: { scope: "toasts", limit: 5 }, note: "直近の通知 5 件" },
  ],
  [EDITOR_NOTIFY_TOOL]: [{ args: { message: "シーンの生成が終わりました。確認をお願いします", level: "success" }, note: "人のエディタの右下にトーストを出す" }],
  [EDITOR_MODAL_TOOL]: [
    { args: {}, note: "開いているモーダルを読む(dx12_editor_state {scope:'modal'} と同じ)" },
    { args: { action: "dismiss" }, note: "新規シーン等のダイアログをキャンセルと同じに閉じる(Esc では閉じない)" },
  ],
  [EDITOR_SELECT_TOOL]: [
    { args: { names: ["Wall_01", "Wall_02"] }, note: "名前で複数選択" },
    { args: { query: "Wall*", mode: "add" }, note: "パターンに合うものを選択へ追加" },
    { args: { mode: "clear" }, note: "選択を全部解除" },
  ],
};

export const EDITOR_MODAL_SHAPE: Record<string, z.ZodTypeAny> = {
  action: z.enum(MODAL_ACTIONS as unknown as [string, ...string[]]).optional().describe(
    "get=開いているモーダルを読む(既定。dx12_editor_state {scope:'modal'} と同じ)/ dismiss=いちばん上の安全に閉じられるモーダルをキャンセルと同じに閉じる(新規シーン・名前を付けて保存・新規スクリプト / シェーダー など)。未保存の確認などは閉じられない(E_UNSUPPORTED。ボタンを押す)。"),
};

const TITLES: Record<string, string> = {
  [EDITOR_COMMAND_TOOL]: "エディタのコマンドを実行・検索",
  [EDITOR_STATE_TOOL]: "エディタの今の状態を読む",
  [EDITOR_NOTIFY_TOOL]: "エディタに通知(トースト)を出す",
  [EDITOR_SELECT_TOOL]: "エンティティの選択を変える",
  [EDITOR_MODAL_TOOL]: "開いているモーダルを読む・閉じる",
};
const SHAPES: Record<string, Record<string, z.ZodTypeAny>> = {
  [EDITOR_COMMAND_TOOL]: EDITOR_COMMAND_SHAPE, [EDITOR_STATE_TOOL]: EDITOR_STATE_SHAPE, [EDITOR_NOTIFY_TOOL]: EDITOR_NOTIFY_SHAPE, [EDITOR_SELECT_TOOL]: EDITOR_SELECT_SHAPE, [EDITOR_MODAL_TOOL]: EDITOR_MODAL_SHAPE,
};
const ANNOTATIONS: Record<string, Record<string, unknown>> = {
  [EDITOR_COMMAND_TOOL]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  [EDITOR_STATE_TOOL]: { readOnlyHint: true, idempotentHint: true },
  [EDITOR_NOTIFY_TOOL]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  [EDITOR_SELECT_TOOL]: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  [EDITOR_MODAL_TOOL]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
const KEYWORDS: Record<string, string> = {
  [EDITOR_MODAL_TOOL]: "modal dialog close dismiss cancel popup unblock stuck editor モーダルを閉じる ダイアログを閉じる キャンセル ポップアップ 閉じる 塞がっている 詰まった E_MODAL_OPEN 新規シーンのダイアログ 名前を付けて保存 ダイアログが開いたまま",
  [EDITOR_COMMAND_TOOL]: "editor command menu shortcut palette window open close undo redo duplicate group create focus gizmo view play stop hierarchy エディタ コマンド 実行 メニュー ショートカット コマンドパレット ウィンドウを開く 窓を開く 窓を閉じる ツール窓 パネル ポスプロ ポストプロセス窓 ライティング窓 元に戻す やり直し 複製 グループ化 ギズモ ビュー 2D 3D 全画面 レイアウト ワークスペース コマンド一覧 何ができるか キー操作 Ctrl+Z 作成 追加 ボックスを置く",
  [EDITOR_STATE_TOOL]: "editor state status selection windows layout modal dialog popup mode undo toasts perf エディタの状態 状態を知りたい 今どうなっている 開いているウィンドウ モーダル ダイアログ 詰まった 固まった 入力できない ポップアップ 選択中 未保存 dirty 再生中 Play 中か 履歴 通知 トースト ドック レイアウト カメラ ビューモード",
  [EDITOR_NOTIFY_TOOL]: "notify notification toast message tell user 通知 トースト 人に知らせる ユーザーに伝える お知らせ 完了通知 確認してほしい 画面に出す メッセージを出す",
  [EDITOR_SELECT_TOOL]: "select several entities multiple objects at once multi-select selection add remove toggle clear query tag guid 選択 複数選択 選ぶ 選択を解除 全解除 追加選択 パターン ワイルドカード まとめて選択 エディタで選択 ハイライト",
};

// ── 呼び出し本体 ─────────────────────────────────────────────────────────────

async function toBody(e: any, tool: string, args: Record<string, unknown>): Promise<ErrorBody> {
  try { return await structureError(e, { tool, args, engine }); }
  catch { return { code: "E_INTERNAL", message: `${tool}: ${e?.message ?? e}`, fix: [{ tool: "dx12_doctor", args: {}, why: "接続と版を確認する" }] }; }
}

async function callEngine(tool: string, args: Record<string, unknown>, method: string, params: Record<string, unknown>, timeoutMs: number,
  post: (raw: any) => unknown, fixErr: (b: ErrorBody) => ErrorBody): Promise<ToolResult> {
  try {
    const timeout = manifestStore.get(method)?.timeoutMs ?? timeoutMs;
    const raw = await engine.call(method, params, { timeout });
    return okResult(post(raw));
  } catch (e: any) {
    const body = fixErr(await toBody(e, tool, args));
    recordError({ at: Date.now(), tool, code: body.code, message: body.message });
    return errorResult(body);
  }
}

async function invokeCommand(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const plan = planEditorCommand(args);
  if (!plan.ok) { recordError({ at: Date.now(), tool: EDITOR_COMMAND_TOOL, code: plan.body.code, message: plan.body.message }); return errorResult(plan.body); }
  const op: EditorOp = plan.op;
  return callEngine(EDITOR_COMMAND_TOOL, args, plan.method, plan.params, plan.timeoutMs,
    (raw) => op === "describe" ? unwrapDescribe(raw, String(plan.params.id)) : op === "run" ? finalizeRunResult(raw, SURFACE) : raw,
    (b) => finishEditorCommandError(b, op, args, SURFACE));
}

async function invokeState(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const params: Record<string, unknown> = {};
  if (args.scope !== undefined) params.scope = args.scope;
  if (args.limit !== undefined) params.limit = args.limit;
  return callEngine(EDITOR_STATE_TOOL, args, EDITOR_METHODS.state, params, 8000, (raw) => stateAdvice(raw, SURFACE), (b) => b);
}

async function invokeNotify(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const plan = planEditorNotify(args);
  if (!plan.ok) { recordError({ at: Date.now(), tool: EDITOR_NOTIFY_TOOL, code: plan.body.code, message: plan.body.message }); return errorResult(plan.body); }
  return callEngine(EDITOR_NOTIFY_TOOL, args, EDITOR_METHODS.notify, plan.params, 5000, (raw) => raw, (b) => b);
}

async function invokeSelect(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const plan = planEditorSelect(args);
  if (!plan.ok) { recordError({ at: Date.now(), tool: EDITOR_SELECT_TOOL, code: plan.body.code, message: plan.body.message }); return errorResult(plan.body); }
  return callEngine(EDITOR_SELECT_TOOL, args, EDITOR_METHODS.select, plan.params, 8000, (raw) => raw, (b) => finishEditorSelectError(b, args));
}

async function invokeModal(rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const plan = planEditorModal(args);
  if (!plan.ok) { recordError({ at: Date.now(), tool: EDITOR_MODAL_TOOL, code: plan.body.code, message: plan.body.message }); return errorResult(plan.body); }
  return callEngine(EDITOR_MODAL_TOOL, args, EDITOR_METHODS.modal, plan.params, 8000, (raw) => raw, (b) => finishEditorModalError(b, SURFACE));
}

const INVOKERS: Record<string, (a: Record<string, unknown> | undefined) => Promise<ToolResult>> = {
  [EDITOR_COMMAND_TOOL]: invokeCommand, [EDITOR_STATE_TOOL]: invokeState, [EDITOR_NOTIFY_TOOL]: invokeNotify, [EDITOR_SELECT_TOOL]: invokeSelect, [EDITOR_MODAL_TOOL]: invokeModal,
};

/** 未知キーは近い正解つきのエラーにしてからエンジンへ(SDK は passthrough で通す)。 */
function wrapped(name: string) {
  const declared = Object.keys(SHAPES[name]);
  return async (args: any): Promise<ToolResult> => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) return errorResult(bodyFromIssues(name, args ?? {}, issues, declared));
    return INVOKERS[name](args ?? {});
  };
}

function register() {
  for (const name of EDITOR_TOOLS) {
    const shape = SHAPES[name];
    const title = TITLES[name];
    const description = CORE_DESCRIPTIONS[name];
    const annotations = ANNOTATIONS[name];
    const invoke = wrapped(name);
    const inCore = CORE_EDITOR.includes(name);
    const hidden = SURFACE === "shell" || (SURFACE === "core" && !inCore);
    const registered = server.registerTool(
      name,
      { title, description, inputSchema: z.object(shape).passthrough() as any, annotations: { title, openWorldHint: false, ...annotations } },
      async (args: any) => callContext.run({ tool: name, args, mode: "direct" }, () => invoke(args)),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title, description, shape, annotations, tier: "core", core: inCore, coreDescription: description,
      extraKeywords: KEYWORDS[name], examples: EDITOR_EXAMPLES[name],
      ...(name === EDITOR_COMMAND_TOOL ? {
        opTable: {
          param: "op", normalize: (raw: unknown) => normalizeOp(raw),
          ops: Object.fromEntries(EDITOR_OPS.map((o) => {
            const s = EDITOR_OP_SPECS[o];
            return [o, { method: s.method, effect: s.effect, required: s.required, optional: s.optional, dryRun: s.dryRun === "engine" ? "preview" : s.dryRun, summary: s.summary }];
          })),
        },
      } : {}),
      invoke: async (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}

if (ENHANCED && SURFACE !== "legacy") register();

// テストが shape を突き合わせるための再エクスポート。
export { EDITOR_COMMAND_KEYS };
