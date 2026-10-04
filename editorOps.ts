// エディタ操作(M7)の純ロジック: dx12_editor_command の op 振り分け・引数検査・エラーの面別書き換え、dx12_editor_state の助言、
// dx12_editor_notify / dx12_editor_select の引数検査。MCP にもエンジンにも依存しない(単体テストは editor.test.ts。登録は toolset/editorTools.ts)。
//
//   dx12_editor_command {op:"list"|"run"|"describe", id?, args?, …}
//       list     → エンジン method editor_command_list(コマンド表の一覧。表はエンジンが唯一の源。ここには 1 件も書かない)
//       describe → editor_command_list {id, detail:true} の 1 件
//       run      → editor_command_run(メニュー / ショートカット / パレットと同じ経路で実行)
//       guarded なコマンド(削除・保存上書き・ファイルダイアログなど)は run が E_GUARDED で断る。実行は editor_command_run_guarded
//       (core 面 = dx12_call_guarded / full・shell 面 = dx12_call {confirm:true})。dryRun:true の preview は guarded でも通る。
//   dx12_editor_state {scope, limit}      → editor_state(選択・窓・レイアウト・モーダル・モード・Undo・トースト・性能。読み取り専用)
//   dx12_editor_notify {message, level}   → editor_notify(人のエディタ画面の右下にトースト)
//   dx12_editor_select {mode, …}          → editor_select(名前 / id / guid / クエリで選択。dx12_select_entity の上位互換)
//
// 契約(エンジン method の引数・結果・エラー名)は docs/MCP.md「エディタ操作」と dx12_guide {topic:"editor"}。

import { nearest, type ErrorBody, type Fix } from "./errors.ts";
import type { EffectName } from "./manifest.ts";
import type { Surface } from "./toolRuntime.ts";

export const EDITOR_COMMAND_TOOL = "dx12_editor_command";
export const EDITOR_STATE_TOOL = "dx12_editor_state";
export const EDITOR_NOTIFY_TOOL = "dx12_editor_notify";
export const EDITOR_MODAL_TOOL = "dx12_editor_modal";
export const EDITOR_SELECT_TOOL = "dx12_editor_select";

/** エディタ操作のツール 4 本(登録順)。core 面に出るのは command / state の 2 本(CORE_EDITOR)。定義は coreSpec.ts(Core の一覧と同じ場所)。 */
export { EDITOR_TOOLS, CORE_EDITOR, EDITOR_TOOL_SET } from "./coreSpec.ts";

/** エンジンの method 名(dx12_ 接頭辞なし)。 */
export const EDITOR_METHODS = {
  list: "editor_command_list",
  run: "editor_command_run",
  runGuarded: "editor_command_run_guarded",
  state: "editor_state",
  notify: "editor_notify",
  modal: "editor_modal",
  select: "editor_select",
} as const;

export const EDITOR_OPS = ["list", "run", "describe"] as const;
export type EditorOp = (typeof EDITOR_OPS)[number];

/** op の別名(AI が言いがちな言い方)。正準の op へ寄せる。 */
const OP_ALIASES: Record<string, EditorOp> = {
  ls: "list", commands: "list", search: "list", find: "list",
  execute: "run", exec: "run", call: "run", invoke: "run", do: "run",
  info: "describe", get: "describe", show: "describe", help: "describe",
};

export function normalizeOp(raw: unknown): EditorOp | null {
  if (typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase();
  if ((EDITOR_OPS as readonly string[]).includes(k)) return k as EditorOp;
  return OP_ALIASES[k] ?? null;
}

export const STATE_SCOPES = ["all", "selection", "windows", "layout", "modal", "mode", "undo", "toasts", "perf"] as const;
export const NOTIFY_LEVELS = ["info", "success", "warn", "error"] as const;
export const SELECT_MODES = ["set", "add", "remove", "toggle", "clear"] as const;
export const COMMAND_KINDS = ["command", "window", "create"] as const;

/** op ごとの引数表(dx12_tool_describe {target:'<op>'} と dx12_call の meta.effect が使う。型は toolset/editorTools.ts の zod)。 */
export type EditorOpSpec = { method: string; effect: EffectName; required: string[]; optional: string[]; dryRun: "engine" | "read"; timeoutMs: number; summary: string };
export const EDITOR_OP_SPECS: Record<EditorOp, EditorOpSpec> = {
  list: {
    method: EDITOR_METHODS.list, effect: "read", required: [], optional: ["query", "category", "kind", "enabledOnly", "guardedOnly", "detail"], dryRun: "read", timeoutMs: 8000,
    summary: "エディタのコマンド表(メニュー・ショートカット・パレットと同じ)を返す。id・表示名・キー・カテゴリ・いま実行できるか(理由つき)・guarded・引数の有無",
  },
  describe: {
    method: EDITOR_METHODS.list, effect: "read", required: ["id"], optional: [], dryRun: "read", timeoutMs: 8000,
    summary: "1 コマンドの詳細(引数・効果・guarded の理由・OS ダイアログの有無・いま実行できない理由・例)",
  },
  run: {
    method: EDITOR_METHODS.run, effect: "write_setting", required: ["id"], optional: ["args", "dryRun", "idempotency_key"], dryRun: "engine", timeoutMs: 15000,
    summary: "コマンド id を実行する(メニュー・キーと同じ経路)。guarded なコマンドは E_GUARDED で断り、承認つきの実行口を fix に返す。dryRun:true で影響だけ返す",
  },
};

export const EDITOR_OP_EFFECT: Record<EditorOp, EffectName> = Object.fromEntries(EDITOR_OPS.map((o) => [o, EDITOR_OP_SPECS[o].effect])) as Record<EditorOp, EffectName>;
/** dx12_editor_command 全体の代表の副作用(catalog / dx12_tool_describe)。op ごとの正確な値は EDITOR_OP_EFFECT。 */
export const EDITOR_COMMAND_EFFECT: EffectName = "write_setting";

/** 全 op が受ける引数キーの和集合(zod の shape のキーと一致させる。editor.test.ts が突き合わせる)。 */
export const EDITOR_COMMAND_KEYS: string[] = [...new Set(["op", ...EDITOR_OPS.flatMap((o) => [...EDITOR_OP_SPECS[o].required, ...EDITOR_OP_SPECS[o].optional])])];

type Args = Record<string, unknown>;

export type EditorPlan =
  | { ok: true; op: EditorOp; method: string; params: Args; timeoutMs: number }
  | { ok: false; body: ErrorBody };

function bad(body: ErrorBody): { ok: false; body: ErrorBody } { return { ok: false, body }; }

/** dx12_editor_command の呼び出し計画(op の正規化・必須の検査・エンジンへ渡す引数)。エンジンには 1 往復も使わない。 */
export function planEditorCommand(args: Args): EditorPlan {
  const rawOp = args.op;
  if (rawOp === undefined || rawOp === null || rawOp === "") {
    return bad({
      code: "E_MISSING_PARAM", message: "dx12_editor_command: 必須の引数 'op' が無い(list | run | describe)", validValues: [...EDITOR_OPS],
      cause: "op でやりたいことを選ぶ。コマンドを探すなら list、実行するなら run(id が要る)、1 件の詳細なら describe(id が要る)",
      fix: [{ tool: EDITOR_COMMAND_TOOL, args: { op: "list", query: "窓" }, why: "コマンドを検索する(id を知る)" }],
      docs: "dx12_guide {topic:'editor'}",
    });
  }
  const op = normalizeOp(rawOp);
  if (!op) {
    const dym = typeof rawOp === "string" ? nearest(rawOp, EDITOR_OPS as unknown as string[], 3, { liberal: true }) : [];
    return bad({
      code: "E_BAD_ENUM", message: `dx12_editor_command: 'op' に ${JSON.stringify(rawOp)} は使えない(有効な値: ${EDITOR_OPS.join(", ")})`,
      validValues: [...EDITOR_OPS], didYouMean: dym,
      fix: [{ tool: EDITOR_COMMAND_TOOL, args: { ...args, op: dym[0] ?? "list" }, why: `'op' に最も近い '${dym[0] ?? "list"}' で撃ち直す` }],
    });
  }
  const spec = EDITOR_OP_SPECS[op];
  const id = args.id;
  if ((op === "run" || op === "describe") && (typeof id !== "string" || id.trim() === "")) {
    return bad({
      code: "E_MISSING_PARAM", message: `dx12_editor_command {op:'${op}'}: 必須の引数 'id' が無い(コマンド id。例 window.postProcess / create.box / edit.undo)`,
      cause: "コマンド id は表の中身で、エンジンが持っている。list で調べる(query に日本語・英語のどちらでも可)",
      fix: [{ tool: EDITOR_COMMAND_TOOL, args: { op: "list", query: "元に戻す" }, why: "コマンドを検索して id を得る" }],
      docs: "dx12_guide {topic:'editor'}",
    });
  }
  if (args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) {
    return bad({
      code: "E_BAD_TYPE", message: "dx12_editor_command: 'args' はオブジェクトでなければならない(コマンドごとの引数。例 {position:[0,0,0]} / {state:'close'})",
      fix: [{ tool: EDITOR_COMMAND_TOOL, args: { op: "describe", id: typeof id === "string" ? id : undefined }, why: "そのコマンドが受ける引数を確認する" }],
    });
  }
  const params: Args = {};
  if (op === "list") {
    for (const k of ["id", "query", "category", "kind", "enabledOnly", "guardedOnly", "detail"]) if (args[k] !== undefined) params[k] = args[k];
  } else if (op === "describe") {
    params.id = String(id).trim();
    params.detail = true;
  } else {
    params.id = String(id).trim();
    if (args.args !== undefined) params.args = args.args;
    if (args.dryRun === true) params.dryRun = true;
    const key = args.idempotency_key ?? args.idempotencyKey;
    if (typeof key === "string" && key) params.idempotency_key = key;
  }
  return { ok: true, op, method: spec.method, params, timeoutMs: spec.timeoutMs };
}

// ── エラーの面別書き換え ──────────────────────────────────────────────────

/** モーダルを閉じる呼び方。ダイアログ = dx12_editor_modal {action:"dismiss"}(キャンセルと同じ)。コマンドパレットだけ Esc。 */
export function modalDismissFix(surface: Surface, topKind?: string, why = "モーダルを閉じる(キャンセルと同じ)。閉じたら同じ呼び出しを撃ち直す"): Fix {
  if (topKind === "palette") return escKeyFix(surface, "コマンドパレットは Esc で閉じる。閉じたら同じ呼び出しを撃ち直す");
  return { tool: EDITOR_MODAL_TOOL, args: { action: "dismiss" }, thenRetry: true, why };
}

/** editor_state / E_MODAL_OPEN の modals[] から、いちばん上(先頭)のモーダルの種類。 */
function topModal(modals: unknown): { kind?: string; canDismiss?: boolean; id?: string } {
  return Array.isArray(modals) && modals.length > 0 && modals[0] && typeof modals[0] === "object" ? (modals[0] as any) : {};
}

/**
 * 面に応じた Esc キーの送り方(core / shell は dx12_imgui、full は旧ツール名)。
 * ★ImGui のモーダルは Esc では閉じない(実測)。Esc で閉じるのはコマンドパレット(kind:"palette")だけ。他は modalDismissFix(dx12_editor_modal)。
 */
export function escKeyFix(surface: Surface, why: string): Fix {   // パレット専用
  return surface === "full" || surface === "legacy"
    ? { tool: "dx12_imgui_key", args: { key: "Esc" }, thenRetry: true, why }
    : { tool: "dx12_imgui", args: { op: "key", key: "Esc" }, thenRetry: true, why };
}

/** guarded なコマンドを承認つきで実行する呼び方(面ごと)。core = dx12_call_guarded / full・shell = dx12_call {confirm:true}。 */
export function guardedRunFix(surface: Surface, id: string, cmdArgs: unknown, dryRun = false): Fix {
  const inner: Args = { id, ...(cmdArgs && typeof cmdArgs === "object" ? { args: cmdArgs } : {}) };
  if (surface === "core") {
    return { tool: "dx12_call_guarded", args: { name: EDITOR_METHODS.runGuarded, args: inner, ...(dryRun ? { dryRun: true } : {}) }, why: dryRun ? "実行せず影響だけ確認する" : "ユーザーの承認を得たあとで実行する(承認ダイアログが毎回出る)" };
  }
  return { tool: "dx12_call", args: { name: EDITOR_METHODS.runGuarded, args: inner, confirm: true, ...(dryRun ? { dryRun: true } : {}) }, why: dryRun ? "実行せず影響だけ確認する" : "ユーザーの承認を得たあとで実行する" };
}

/**
 * エンジンのエラー(構造化済み)を、この面・この呼び出しの形に直す。エンジンの error_* をそのまま活かし、足すのは面ごとの撃ち直しだけ。
 *   E_GUARDED          → 面に応じた承認つきの実行口(dryRun で先に影響を見る fix つき)
 *   E_MODAL_OPEN       → editor_state {scope:"modal"} と Esc(閉じてから撃ち直す)
 *   E_NOT_FOUND_COMMAND→ 最も近い id で撃ち直す + list で探す
 *   E_UNSUPPORTED      → OS ダイアログ経路(file.open)は dx12_open_scene / dx12_save_scene へ
 *   E_MODE_CONFLICT / E_INVALID_PARAM → そのコマンドの describe
 */
export function finishEditorCommandError(body: ErrorBody, op: EditorOp, args: Args, surface: Surface): ErrorBody {
  const out: ErrorBody = { ...body, fix: [...(body.fix ?? [])] };
  const id = typeof args.id === "string" ? args.id : undefined;
  const cmdArgs = args.args;
  const details = (out.details ?? {}) as Record<string, unknown>;
  const cmdId = (typeof details.id === "string" ? details.id : undefined) ?? id;
  const describeFix = (why: string): Fix => ({ tool: EDITOR_COMMAND_TOOL, args: { op: "describe", id: cmdId }, why });
  switch (out.code) {
    case "E_GUARDED": {
      if (op !== "run" || !cmdId) break;
      out.message = `dx12_editor_command: コマンド ${cmdId} は取り返しの付かない/確認が要る操作(guarded)。承認つきの実行口から実行する`;
      out.cause = out.cause ?? "削除・保存の上書き・ファイルダイアログ・プロジェクトを閉じるなどは、メニューでは 1 回のクリックでも、AI が選択を見ずに実行すると危険なので確認が要る";
      out.fix = [
        { tool: EDITOR_COMMAND_TOOL, args: { op: "run", id: cmdId, ...(cmdArgs ? { args: cmdArgs } : {}), dryRun: true }, why: "まず dryRun:true で何が起こるか(対象・件数・戻せるか)を確認する" },
        guardedRunFix(surface, cmdId, cmdArgs),
      ];
      out.details = { ...details, id: cmdId, guardedCommand: true, via: surface === "core" ? "dx12_call_guarded" : "dx12_call {confirm:true}" };
      break;
    }
    case "E_MODAL_OPEN": {
      // ★ImGui のモーダルは Esc では閉じない。dx12_editor_modal {action:"dismiss"} で閉じる(閉じられないもの = 未保存の確認などはボタンを押す)。パレットだけ Esc。
      const top = topModal((out.details as any)?.modals);
      out.fix = [
        { tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, why: "開いているモーダル / ダイアログの種類と閉じ方(canDismiss / dismissHint)を確認する" },
        modalDismissFix(surface, top.kind),
        ...out.fix!.filter((f) => !["editor_state", "editor_modal", EDITOR_STATE_TOOL, EDITOR_MODAL_TOOL, "dx12_imgui", "dx12_imgui_key", "imgui_key"].includes(f.tool ?? "")),
      ];
      break;
    }
    case "E_NOT_FOUND_COMMAND": {
      const dym = out.didYouMean ?? [];
      const fixes: Fix[] = [];
      if (dym[0] && op !== "list") fixes.push({ tool: EDITOR_COMMAND_TOOL, args: { ...args, id: dym[0] }, why: `'${id}' に最も近い '${dym[0]}' で撃ち直す` });
      fixes.push({ tool: EDITOR_COMMAND_TOOL, args: { op: "list", query: id ? id.split(".").pop() : undefined }, why: "コマンド表を検索して正しい id を探す" });
      out.fix = [...fixes, ...out.fix!.filter((f) => f.tool !== "editor_command_list")];
      break;
    }
    case "E_UNSUPPORTED": {
      const reason = details.reason;
      if (reason === "os-dialog" || (cmdId && /^file\.(open|save|saveAs)$/.test(cmdId))) {
        const alt = cmdId === "file.open"
          ? { tool: "dx12_open_scene", args: { path: "scenes/<name>.json" }, why: "OS のファイル選択ダイアログは仮想入力 / 背景モードでは開けない。シーンは path を指定して開く" }
          : { tool: "dx12_save_scene", args: { path: "scenes/<name>.json" }, why: "名前を付けて保存は path を指定する" };
        out.fix = [alt, ...out.fix!.filter((f) => f.tool !== "open_scene" && f.tool !== "save_scene")];
      }
      break;
    }
    case "E_MODE_CONFLICT":
    case "E_INVALID_PARAM":
    case "E_BAD_TYPE":
    case "E_UNKNOWN_PARAM":
      if (op === "run" && cmdId) out.fix = [...out.fix!, describeFix("そのコマンドが受ける引数と、いま実行できない理由を確認する")];
      break;
    default:
      break;
  }
  return out;
}

// ── 結果の整形(助言) ───────────────────────────────────────────────────

/** run の結果に、開いたモーダルがあれば次の一手を添える。 */
export function finalizeRunResult(result: any, surface: Surface): any {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const opened = result.effects?.modalsOpened;
  if (Array.isArray(opened) && opened.length > 0) {
    const kind = (opened[0] as any)?.kind;
    const close = modalDismissFix(surface, kind);
    const next = [
      { tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, when: "開いたモーダル / ダイアログの種類と閉じ方を確認する" },
      { tool: close.tool, args: close.args, when: kind === "palette" ? "コマンドパレットを閉じる(Esc)" : "モーダルを閉じる(キャンセルと同じ。入力欄のあるダイアログは名前を入れて確定してもよい)" },
    ];
    return { ...result, next: [...(Array.isArray(result.next) ? result.next : []), ...next], note: result.note ?? "モーダルが開いた。閉じるまで他のエディタ操作は E_MODAL_OPEN で断られる" };
  }
  return result;
}

/** describe: list {id, detail:true} の結果から 1 件を取り出す。 */
export function unwrapDescribe(raw: any, id: string): any {
  const list = Array.isArray(raw?.commands) ? raw.commands : [];
  const one = list.find((c: any) => c?.id === id) ?? list[0] ?? null;
  return one ? { command: one, context: raw?.context } : raw;
}

/** editor_state の結果に、モーダルが塞いでいるときの助言(次の一手)を足す。 */
export function stateAdvice(result: any, surface: Surface): any {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const modal = result.modal;
  if (modal?.blocking === true) {
    const titles = Array.isArray(modal.modals) ? modal.modals.map((m: any) => m?.title || m?.id).filter(Boolean).join(" / ") : "";
    const top = topModal(modal.modals);
    const close = modalDismissFix(surface, top.kind);
    const esc = escKeyFix(surface, "");
    const byButton = top.kind !== "palette" && top.canDismiss === false;
    return {
      ...result,
      advice: [
        `モーダル${titles ? `(${titles})` : ""}が開いていて、エディタのコマンド(dx12_editor_command)は E_MODAL_OPEN で断られる。まず閉じる`,
        "★ImGui のモーダルは Esc では閉じない。canDismiss:true のダイアログは dx12_editor_modal {action:'dismiss'}(キャンセルと同じ)、"
          + "canDismiss:false(未保存の確認・自動保存の復旧など)は dx12_imgui {op:'find'} でボタンの位置を探して pointer で押す。コマンドパレット(kind:'palette')だけ "
          + (esc.tool === "dx12_imgui" ? "dx12_imgui {op:'key', key:'Esc'}" : "dx12_imgui_key {key:'Esc'}") + " で閉じる",
      ],
      next: byButton
        ? [{ tool: "dx12_imgui", args: { op: "find", label: top.id ?? "" }, when: "ボタンの位置を探して pointer で押す(dismiss では閉じられない)" }, { tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, when: "閉じたか確認する" }]
        : [{ tool: close.tool, args: close.args, when: top.kind === "palette" ? "コマンドパレットを閉じる(Esc)" : "モーダルを閉じる(キャンセルと同じ)" }, { tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, when: "閉じたか確認する" }],
    };
  }
  return result;
}

// ── modal の引数検査・エラー ──

export const MODAL_ACTIONS = ["get", "dismiss"] as const;

export function planEditorModal(args: Args): { ok: true; params: Args } | { ok: false; body: ErrorBody } {
  const action = args.action ?? "get";
  if (typeof action !== "string" || !(MODAL_ACTIONS as readonly string[]).includes(action)) {
    const dym = typeof action === "string" ? nearest(action, MODAL_ACTIONS as unknown as string[], 2, { liberal: true }) : [];
    return bad({
      code: "E_BAD_ENUM", message: `dx12_editor_modal: 'action' に ${JSON.stringify(action)} は使えない(有効な値: ${MODAL_ACTIONS.join(", ")})`,
      validValues: [...MODAL_ACTIONS], didYouMean: dym,
      fix: [{ tool: EDITOR_MODAL_TOOL, args: { action: dym[0] ?? "get" }, why: "有効な action で撃ち直す" }],
    });
  }
  return { ok: true, params: { action } };
}

/** editor_modal のエラー: 閉じられないモーダル(E_UNSUPPORTED)はボタンを押す道へ、閉じるものが無いとき(E_NOT_FOUND)は状態の確認へ。 */
export function finishEditorModalError(body: ErrorBody, surface: Surface): ErrorBody {
  const details = (body.details ?? {}) as Record<string, unknown>;
  if (body.code === "E_UNSUPPORTED") {
    return {
      ...body,
      cause: body.cause ?? "このモーダルは安全に閉じられない(未保存の確認・自動保存の復旧・マテリアルグラフのダイアログ・コマンドパレットなど)。ボタンで選ぶ",
      fix: [
        { tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, why: "開いているモーダルのボタンと dismissHint を確認する" },
        { tool: "dx12_imgui", args: { op: "find", label: typeof details.id === "string" ? details.id : "" }, why: "ボタンの位置を探して dx12_imgui {op:'pointer'} で押す(コマンドパレットだけ Esc)" },
        ...(body.fix ?? []).filter((f) => f.tool !== "editor_state"),
      ],
    };
  }
  if (body.code === "E_NOT_FOUND" || body.code === "E_NOT_FOUND_ENTITY") {
    return { ...body, code: "E_NOT_FOUND", fix: [{ tool: EDITOR_STATE_TOOL, args: { scope: "modal" }, why: "モーダルが無い(既に閉じた)。状態を確認する" }, ...(body.fix ?? []).filter((f) => f.tool !== "editor_state")] };
  }
  void surface;
  return body;
}

// ── notify / select の引数検査 ──────────────────────────────────────────

export function planEditorNotify(args: Args): { ok: true; params: Args } | { ok: false; body: ErrorBody } {
  const message = args.message;
  if (typeof message !== "string" || message.trim() === "") {
    return bad({
      code: "E_MISSING_PARAM", message: "dx12_editor_notify: 必須の引数 'message' が無い(人に見せる 1〜400 字の文)",
      fix: [{ tool: EDITOR_NOTIFY_TOOL, args: { message: "生成が終わった。確認をお願いします", level: "success" }, why: "message に人へ伝える文を入れる" }],
    });
  }
  if (message.length > 400) {
    return bad({ code: "E_OUT_OF_RANGE", message: `dx12_editor_notify: 'message' が長すぎる(${message.length} 字。上限 400 字)`, fix: [{ tool: EDITOR_NOTIFY_TOOL, args: { ...args, message: message.slice(0, 397) + "…" }, why: "400 字に切り詰めて撃ち直す" }] });
  }
  const params: Args = { message };
  if (args.level !== undefined) params.level = args.level;
  if (args.seconds !== undefined) params.seconds = args.seconds;
  return { ok: true, params };
}

export function planEditorSelect(args: Args): { ok: true; params: Args } | { ok: false; body: ErrorBody } {
  const mode = args.mode ?? "set";
  const has = (k: string) => {
    const v = args[k];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null;
  };
  const targets = ["entities", "names", "query", "tag", "guids"].filter(has);
  if (mode !== "clear" && targets.length === 0) {
    return bad({
      code: "E_MISSING_PARAM", message: "dx12_editor_select: 選択の対象が無い(names / entities / query / tag / guids のどれか。全解除は mode:'clear')",
      validValues: ["names", "entities", "query", "tag", "guids"],
      fix: [
        { tool: EDITOR_SELECT_TOOL, args: { names: ["Player"] }, why: "名前(完全一致)で選ぶ" },
        { tool: EDITOR_SELECT_TOOL, args: { mode: "clear" }, why: "選択を全部解除する" },
      ],
    });
  }
  const params: Args = {};
  for (const k of ["mode", "entities", "names", "query", "tag", "guids", "limit", "focus"]) if (args[k] !== undefined) params[k] = args[k];
  return { ok: true, params };
}

/** editor_select の E_NOT_FOUND_ENTITY: didYouMean の先頭で names を置き換えた撃ち直しを作る。 */
export function finishEditorSelectError(body: ErrorBody, args: Args): ErrorBody {
  if (body.code !== "E_NOT_FOUND_ENTITY") return body;
  const dym = body.didYouMean ?? [];
  const fixes: Fix[] = [];
  const names = Array.isArray(args.names) ? (args.names as unknown[]).map(String) : [];
  if (dym[0] && names.length > 0) {
    const missing = (body.details as any)?.notFound as string[] | undefined;
    const replaced = names.map((n) => (missing ? (missing.includes(n) ? dym[0] : n) : names.length === 1 ? dym[0] : n));
    fixes.push({ tool: EDITOR_SELECT_TOOL, args: { ...args, names: replaced }, why: `見つからない名前を最も近い '${dym[0]}' に替えて撃ち直す` });
  }
  fixes.push({ tool: "dx12_list_entities", args: {}, why: "存在する名前を一覧で確認する" });
  return { ...body, fix: [...fixes, ...(body.fix ?? []).filter((f) => f.tool !== "list_entities")] };
}
