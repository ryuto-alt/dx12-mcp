// エディタ操作(M7)の偽エンジン側。mockEngine.ts の `methods` に渡して使う(既定では入れない = 他のテストの method 数を変えない)。
//   const ed = createEditorMock(); const mock = await startMockEngine({ methods: ed.methods, safety: true, guardedMethods: ed.guardedMethods });
// 実エンジン(C++ の EditorCommandTable.h / ToolWindows.h / EditorCreateTable.h から生成する editor_* method)の契約を、小さな決め打ちの表で再現する。
//   editor_command_list / editor_command_run / editor_command_run_guarded / editor_state / editor_notify / editor_select
// 再現するもの: 表の検索・詳細・guarded(E_GUARDED)・モーダル中の拒否(E_MODAL_OPEN)・モード衝突(E_MODE_CONFLICT)・OS ダイアログの拒否(E_UNSUPPORTED)・
//   未知 id の近い候補(E_NOT_FOUND_COMMAND)・dryRun・引数の検証・トースト・選択。契約の正は docs/MCP.md「エディタ操作」。

import type { MockMethod, MockCtx } from "./mockEngine.ts";
import type { ManifestMethod, ManifestParam } from "./manifest.ts";

type Cmd = {
  id: string; label: string; labelEn: string; category: string; kind: "command" | "window" | "create"; chord?: string;
  scope: "editor" | "always"; guarded?: boolean; osDialog?: boolean; opensModal?: string; effect: string; needsSelection?: boolean; toggle?: boolean; help: string;
};

export const MOCK_COMMANDS: Cmd[] = [
  { id: "file.new", label: "新規シーン", labelEn: "New Scene", category: "ファイル", kind: "command", chord: "Ctrl+N", scope: "editor", opensModal: "new_scene", effect: "write_scene", help: "新規シーンを作る(名前入力のダイアログが開く)" },
  { id: "file.open", label: "シーンを開く", labelEn: "Open Scene", category: "ファイル", kind: "command", chord: "Ctrl+O", scope: "editor", guarded: true, osDialog: true, effect: "write_scene", help: "シーンを開く(OS のファイルダイアログ)" },
  { id: "file.save", label: "保存", labelEn: "Save", category: "ファイル", kind: "command", chord: "Ctrl+S", scope: "always", guarded: true, effect: "write_file", help: "シーンを上書き保存" },
  { id: "edit.undo", label: "元に戻す", labelEn: "Undo", category: "編集", kind: "command", chord: "Ctrl+Z", scope: "editor", effect: "write_scene", help: "元に戻す" },
  { id: "edit.redo", label: "やり直す", labelEn: "Redo", category: "編集", kind: "command", chord: "Ctrl+Y", scope: "editor", effect: "write_scene", help: "やり直す" },
  { id: "edit.delete", label: "削除", labelEn: "Delete", category: "編集", kind: "command", chord: "Del", scope: "editor", guarded: true, needsSelection: true, effect: "write_scene", help: "選択を削除" },
  { id: "edit.selectNone", label: "選択を解除", labelEn: "Deselect", category: "編集", kind: "command", chord: "Esc", scope: "always", effect: "write_setting", help: "選択解除" },
  { id: "view.fill", label: "編集用の照らし込み", labelEn: "Viewport Fill Light", category: "表示", kind: "command", chord: "Shift+F2", scope: "editor", toggle: true, effect: "write_setting", help: "暗いシーンを見るための光" },
  { id: "play.toggle", label: "再生 / 停止", labelEn: "Play Stop", category: "再生", kind: "command", chord: "F5", scope: "always", effect: "runtime", help: "Play の開始 / 停止" },
  { id: "palette.commands", label: "コマンドパレット", labelEn: "Command Palette", category: "コマンド", kind: "command", chord: "Ctrl+K", scope: "editor", opensModal: "palette", effect: "write_setting", help: "コマンドを検索して実行" },
  { id: "window.postProcess", label: "Post Process", labelEn: "Post Process bloom tonemap ポストプロセス", category: "レンダリング", kind: "window", scope: "always", toggle: true, effect: "write_setting", help: "ツール窓の開閉" },
  { id: "window.lighting", label: "ライティング", labelEn: "Lighting sun shadow 太陽 影", category: "レンダリング", kind: "window", scope: "always", toggle: true, effect: "write_setting", help: "ツール窓の開閉" },
  { id: "window.terrain", label: "地形ツール", labelEn: "Terrain heightfield 山 地面", category: "制作ツール", kind: "window", scope: "always", toggle: true, effect: "write_setting", help: "ツール窓の開閉" },
  { id: "create.box", label: "Box", labelEn: "Cube", category: "基本", kind: "create", scope: "editor", effect: "write_scene", help: "Box を作る" },
  { id: "create.sphere", label: "Sphere", labelEn: "Ball", category: "基本", kind: "create", scope: "editor", effect: "write_scene", help: "Sphere を作る" },
];

const P = (name: string, type: string, desc: string, extra: Partial<ManifestParam> = {}): ManifestParam => ({ name, type, required: false, desc, ...extra });

const META: Record<string, Partial<ManifestMethod>> = {
  editor_command_list: {
    category: "editor_ui", summary: "エディタのコマンド表(メニュー・ショートカット・パレットと同じ)を返す。いま実行できるか・guarded・引数の有無つき", effect: "read", timeoutMs: 8000, idempotent: true,
    keywords: "editor command list コマンド一覧 メニュー ショートカット パレット ウィンドウを開く",
    params: [P("id", "string", "1 件(完全一致)"), P("query", "string", "曖昧検索"), P("category", "string", "カテゴリ"), P("kind", "enum", "種別", { enum: ["command", "window", "create"] }),
      P("enabledOnly", "bool", "いま実行できるものだけ"), P("guardedOnly", "bool", "guarded だけ"), P("detail", "bool", "詳細")],
  },
  editor_command_run: {
    category: "editor_ui", summary: "エディタのコマンドを id で実行する(メニュー・ショートカットと同じ経路)。guarded は E_GUARDED", effect: "write_setting", timeoutMs: 15000, deferred: true, dryRun: "preview",
    keywords: "editor command run 実行 ウィンドウを開く 元に戻す 作成", params: [P("id", "string", "コマンド id", { required: true }), P("args", "object", "コマンドごとの引数")],
  },
  editor_command_run_guarded: {
    category: "editor_ui", summary: "guarded なエディタコマンド(削除・保存の上書き・ファイルダイアログなど)を確認トークンつきで実行する", effect: "guarded", timeoutMs: 15000, deferred: true, dryRun: "preview",
    keywords: "editor command guarded 削除 保存 上書き 承認", params: [P("id", "string", "コマンド id", { required: true }), P("args", "object", "コマンドごとの引数")],
  },
  editor_state: {
    category: "editor_ui", summary: "エディタの今の状態(選択・窓・レイアウト・モーダル・モード・Undo・トースト・性能)を読む", effect: "read", timeoutMs: 8000, idempotent: true,
    keywords: "editor state 状態 モーダル 選択 未保存", params: [P("scope", "enum", "範囲", { enum: ["all", "selection", "windows", "layout", "modal", "mode", "undo", "toasts", "perf"] }), P("limit", "int", "toasts の件数", { min: 1, max: 50 })],
  },
  editor_notify: {
    category: "editor_ui", summary: "エディタ画面の右下にトースト通知を出す(AI から人へ)", effect: "write_setting", timeoutMs: 5000, keywords: "editor notify toast 通知",
    params: [P("message", "string", "文", { required: true }), P("level", "enum", "種別", { enum: ["info", "success", "warn", "error"] }), P("seconds", "number", "秒数", { min: 0.5, max: 30 })],
  },
  editor_modal: {
    category: "editor_ui", summary: "開いているモーダルを読む / 安全に閉じられるものをキャンセルと同じに閉じる(ImGui のモーダルは Esc では閉じない)", effect: "write_setting", timeoutMs: 8000,
    keywords: "editor modal dismiss close モーダルを閉じる ダイアログを閉じる キャンセル", params: [P("action", "enum", "get / dismiss", { enum: ["get", "dismiss"] })],
  },
  editor_select: {
    category: "editor_ui", summary: "エンティティの選択を名前 / id / guid / クエリで変える(複数選択・追加・解除・全解除)", effect: "write_setting", timeoutMs: 8000, keywords: "editor select 選択 複数選択",
    params: [P("mode", "enum", "モード", { enum: ["set", "add", "remove", "toggle", "clear"] }), P("entities", "array", "id"), P("names", "array", "名前"), P("query", "string", "部分一致"),
      P("tag", "string", "タグ"), P("guids", "array", "guid"), P("limit", "int", "上限", { min: 1, max: 2000 }), P("focus", "bool", "カメラを寄せる")],
  },
};

const errObj = (code: number, message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), { code, fields });

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let prev = dp[0]; dp[0] = i; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return dp[b.length];
}
const nearestIds = (t: string, ids: string[], n = 5) => ids.map((x) => ({ x, d: editDistance(t.toLowerCase(), x.toLowerCase()) })).filter((o) => o.d <= Math.max(3, Math.floor(t.length / 2)) || o.x.toLowerCase().includes(t.toLowerCase())).sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.x);

export function createEditorMock() {
  const model = {
    windows: new Set<string>(),
    selection: [] as string[],
    modal: null as null | { id: string; title: string; kind: string },
    toasts: [] as { seq: number; kind: string; text: string; count: number; at: number }[],
    undoDepth: 0, redoDepth: 0, dirty: false, fill: false,
    created: 0,
  };
  let seq = 0;
  const pushToast = (kind: string, text: string) => { model.toasts.push({ seq: ++seq, kind, text, count: 1, at: Date.now() }); return seq; };

  const cmdMap = new Map(MOCK_COMMANDS.map((c) => [c.id, c]));
  const stateOf = (ctx: MockCtx) => ctx.state;

  const disabledReason = (c: Cmd, ctx: MockCtx): string | undefined => {
    const playing = stateOf(ctx).mode === "Playing";
    if (c.scope === "editor" && playing) return "Play 中は使えない(Editor 専用のコマンド)";
    if (c.needsSelection && model.selection.length === 0) return "選択が無い";
    if (c.id === "edit.undo" && model.undoDepth === 0) return "元に戻す履歴が無い";
    if (c.id === "edit.redo" && model.redoDepth === 0) return "やり直す履歴が無い";
    return undefined;
  };
  const argsOf = (c: Cmd) => c.kind === "window" ? [{ name: "state", type: "enum", required: false, enum: ["open", "close", "toggle"], desc: "既定 open" }]
    : c.kind === "create" ? [{ name: "position", type: "vec3", required: false, desc: "既定はカメラ前 / 床との交点" }, { name: "name", type: "string", required: false, desc: "エンティティ名" }]
    : c.toggle ? [{ name: "state", type: "enum", required: false, enum: ["on", "off", "toggle"], desc: "既定 toggle" }] : [];

  const brief = (c: Cmd, ctx: MockCtx, detail: boolean) => {
    const reason = disabledReason(c, ctx);
    const vi = stateOf(ctx).virtualInput;
    const o: any = { id: c.id, label: c.label, category: c.category, kind: c.kind, enabled: !reason };
    if (c.chord) o.chord = c.chord;
    if (reason) o.disabledReason = reason;
    if (c.guarded) o.guarded = true;
    if (c.osDialog) o.osDialog = true;
    if (c.opensModal) o.opensModal = true;
    if (c.osDialog && vi) o.blockedNow = "仮想入力 / 背景モード中は OS のダイアログを開けない";
    if (model.modal) o.blockedNow = o.blockedNow ?? "モーダルが開いている";
    if (argsOf(c).length) o.hasArgs = true;
    if (detail) {
      Object.assign(o, { labelEn: c.labelEn, help: c.help, scope: c.scope, keyMode: "Typing", effect: c.effect });
      if (c.kind === "window") o.open = model.windows.has(c.id.slice(7));
      if (c.toggle && c.id === "view.fill") o.checked = model.fill;
      if (c.guarded) o.guardReason = c.osDialog ? "OS のファイルダイアログを開く" : "取り返しの付かない / 上書きの操作";
      if (argsOf(c).length) o.args = argsOf(c);
      o.example = { id: c.id, args: c.kind === "window" ? { state: "open" } : {} };
    }
    return o;
  };

  const ctxBrief = (ctx: MockCtx) => ({ playing: stateOf(ctx).mode === "Playing", paused: false, virtualInput: stateOf(ctx).virtualInput, background: true, modalOpen: !!model.modal });

  const list = (p: any, ctx: MockCtx) => {
    if (p.id !== undefined) {
      const c = cmdMap.get(p.id);
      if (!c) throw errObj(1, `no such command: ${p.id}`, { error_name: "E_NOT_FOUND_COMMAND", error_did_you_mean: nearestIds(p.id, [...cmdMap.keys()]), error_fix: [{ tool: "editor_command_list", args: { query: String(p.id).split(".").pop() }, why: "コマンド表を検索する" }] });
      return { total: cmdMap.size, count: 1, categories: [], context: ctxBrief(ctx), commands: [brief(c, ctx, true)] };
    }
    const q = typeof p.query === "string" ? p.query.toLowerCase() : "";
    let cs = MOCK_COMMANDS.filter((c) => (!q || `${c.id} ${c.label} ${c.labelEn} ${c.chord ?? ""}`.toLowerCase().includes(q)) && (!p.category || c.category === p.category) && (!p.kind || c.kind === p.kind)
      && (!p.guardedOnly || c.guarded) && (!p.enabledOnly || !disabledReason(c, ctx)));
    const cats = new Map<string, number>();
    for (const c of MOCK_COMMANDS) cats.set(c.category, (cats.get(c.category) ?? 0) + 1);
    return { total: cmdMap.size, count: cs.length, categories: [...cats].map(([id, count]) => ({ id, count })), context: ctxBrief(ctx), commands: cs.map((c) => brief(c, ctx, p.detail === true)) };
  };

  // canDismiss: true = editor_modal dismiss で閉じられる(palette は Esc)/ false = ボタンで選ぶ。
  const SAFE = new Set(["new_scene", "save_as", "new_script", "new_shader", "shortcuts", "about"]);
  const modalList = () => model.modal ? [{ kind: model.modal.kind, id: model.modal.id, title: model.modal.title, source: "editor",
    canDismiss: SAFE.has(model.modal.id) || model.modal.kind === "palette",
    dismissHint: model.modal.kind === "palette" ? "Esc で閉じる" : SAFE.has(model.modal.id) ? "editor_modal {action:dismiss} で閉じる(キャンセルと同じ)" : "ボタンで選ぶ(dx12_imgui find → pointer)" }] : [];

  const modal = (p: any) => {
    const action = p.action ?? "get";
    const mm = modalList();
    if (action === "get") return { blocking: !!model.modal, count: mm.length, modals: mm, popupOpen: !!model.modal, note: "" };
    if (!model.modal) throw errObj(1, "no modal is open", { error_name: "E_NOT_FOUND" });
    if (!SAFE.has(model.modal.id)) throw errObj(10, `modal '${model.modal.id}' cannot be dismissed safely`, { error_name: "E_UNSUPPORTED", error_cause: "未保存の確認などはボタンで選ぶ", error_details: { id: model.modal.id } });
    const done = { dismissed: true, id: model.modal.id, title: model.modal.title };
    model.modal = null;
    return { ...done, modal: { blocking: false, count: 0, modals: [], popupOpen: false, note: "" } };
  };

  const checkArgs = (c: Cmd, a: any) => {
    const spec = argsOf(c);
    if (a === undefined) return;
    const allowed = spec.map((s) => s.name);
    for (const k of Object.keys(a)) {
      if (!allowed.includes(k)) throw errObj(2, `${c.id}: unknown arg '${k}'`, { error_name: "E_INVALID_PARAM", error_details: { args: spec } });
    }
    for (const s of spec) if (s.enum && a[s.name] !== undefined && !s.enum.includes(a[s.name])) throw errObj(2, `${c.id}: bad ${s.name}`, { error_name: "E_INVALID_PARAM", error_details: { args: spec } });
  };

  const run = (p: any, ctx: MockCtx, viaGuarded: boolean) => {
    const c = cmdMap.get(p.id);
    if (!c) throw errObj(1, `no such command: ${p.id}`, { error_name: "E_NOT_FOUND_COMMAND", error_did_you_mean: nearestIds(String(p.id), [...cmdMap.keys()]), error_fix: [{ tool: "editor_command_list", args: { query: String(p.id).split(".").pop() }, why: "コマンド表を検索する" }] });
    const reason = disabledReason(c, ctx);
    if (p.dryRun === true) {
      return { dryRun: true, executed: false, method: viaGuarded ? "editor_command_run_guarded" : "editor_command_run", effect: c.effect,
        preview: { summary: `${c.label}(${c.id})を実行する`, willFail: !!reason, ...(reason ? { reason } : {}), guarded: !!c.guarded, enabled: !reason, targets: c.needsSelection ? model.selection.map((n) => ({ kind: "entity", name: n })) : [], count: c.needsSelection ? model.selection.length : 1, destructive: !!c.guarded, undoable: c.kind === "window" ? "戻せない(表示だけ)" : "Undo 1 エントリ", files: c.id === "file.save" ? [{ path: "scenes/default.json", exists: true, action: "overwrite" }] : [], notes: [] } };
    }
    if (c.guarded && !viaGuarded) {
      throw errObj(11, `${c.id} is a guarded command`, { error_name: "E_GUARDED", error_cause: "guarded なコマンド", error_fix: [{ tool: "editor_command_run_guarded", args: { id: c.id }, why: "確認つきの実行口" }], error_details: { id: c.id, gate: "command" } });
    }
    if (model.modal) throw errObj(13, "a modal is open", { error_name: "E_MODAL_OPEN", error_details: { modals: modalList() }, error_fix: [{ tool: "editor_modal", args: { action: "dismiss" }, why: "モーダルを閉じる" }, { tool: "editor_state", args: { scope: "modal" }, why: "モーダルを確認" }] });
    if (c.osDialog && stateOf(ctx).virtualInput) throw errObj(10, `${c.id} opens an OS dialog`, { error_name: "E_UNSUPPORTED", error_details: { reason: "os-dialog", id: c.id }, error_fix: [{ tool: "open_scene", args: { path: "scenes/<name>.json" }, why: "path で開く" }] });
    if (reason) throw errObj(3, `${c.id} is not available: ${reason}`, { error_name: "E_MODE_CONFLICT", error_details: { reason, id: c.id } });
    checkArgs(c, p.args);

    const before = { sel: [...model.selection], count: stateOf(ctx).entities.length, dirty: model.dirty, windows: new Set(model.windows), toasts: model.toasts.length, mode: stateOf(ctx).mode };
    let changed = true;
    const st = stateOf(ctx);
    if (c.kind === "window") {
      const wid = c.id.slice(7);
      const want = p.args?.state ?? "open";
      const now = model.windows.has(wid);
      const target = want === "toggle" ? !now : want === "open";
      changed = target !== now;
      if (target) model.windows.add(wid); else model.windows.delete(wid);
    } else if (c.kind === "create") {
      model.created++;
      const nm = p.args?.name ?? `${c.label}${model.created > 1 ? ` (${model.created - 1})` : ""}`;
      st.entities.push(nm);
      model.selection = [nm]; model.dirty = true; model.undoDepth++; model.redoDepth = 0;
    } else switch (c.id) {
      case "edit.undo": model.undoDepth--; model.redoDepth++; if (st.entities.length > 0 && model.created > 0) { st.entities.pop(); model.created--; model.selection = []; } break;
      case "edit.redo": model.redoDepth--; model.undoDepth++; break;
      case "edit.delete": st.entities = st.entities.filter((e) => !model.selection.includes(e)); model.selection = []; model.dirty = true; model.undoDepth++; break;
      case "edit.selectNone": changed = model.selection.length > 0; model.selection = []; break;
      case "view.fill": { const want = p.args?.state ?? "toggle"; const t = want === "toggle" ? !model.fill : want === "on"; changed = t !== model.fill; model.fill = t; break; }
      case "play.toggle": st.mode = st.mode === "Playing" ? "Editor" : "Playing"; break;
      case "file.save": model.dirty = false; pushToast("success", "保存しました"); break;
      case "file.new": case "palette.commands": model.modal = { id: c.id === "file.new" ? "new_scene" : "palette", kind: c.id === "file.new" ? "editor-dialog" : "palette", title: c.label }; break;
      default: break;
    }
    const effects: any = {
      windowsOpened: [...model.windows].filter((w) => !before.windows.has(w)), windowsClosed: [...before.windows].filter((w) => !model.windows.has(w)),
      toasts: model.toasts.slice(before.toasts).map((t) => ({ kind: t.kind, text: t.text })),
      mode: { before: before.mode === "Playing" ? "playing" : "editor", after: st.mode === "Playing" ? "playing" : "editor" },
      selection: { before: before.sel.map((n) => st.entities.indexOf(n) + 1), after: model.selection.map((n) => st.entities.indexOf(n) + 1) },
      entityCount: { before: before.count, after: st.entities.length, delta: st.entities.length - before.count },
      dirty: { before: before.dirty, after: model.dirty },
      undo: { canUndo: model.undoDepth > 0, canRedo: model.redoDepth > 0 },
      modalsOpened: model.modal && c.opensModal ? [{ kind: model.modal.kind, title: model.modal.title }] : [],
    };
    if (effects.entityCount.delta > 0) effects.created = model.selection.map((n) => ({ entityId: st.entities.indexOf(n) + 1, name: n }));
    return { id: c.id, executed: true, changed, frames: 3, effects };
  };

  const state = (p: any, ctx: MockCtx) => {
    const st = stateOf(ctx);
    const scope = p.scope ?? "all";
    const want = (s: string) => scope === "all" || scope === s;
    const out: any = { scope, frame: 1234 };
    const ent = (n: string) => ({ entityId: st.entities.indexOf(n) + 1, name: n });
    if (want("selection")) out.selection = { count: model.selection.length, primary: model.selection.length ? ent(model.selection[model.selection.length - 1]) : null, entities: model.selection.map(ent) };
    if (want("windows")) out.windows = { open: [...model.windows], openCount: model.windows.size, tools: MOCK_COMMANDS.filter((c) => c.kind === "window").map((c) => ({ id: c.id.slice(7), title: c.label, open: model.windows.has(c.id.slice(7)), slot: "right_tab", menu: "view", category: c.category })), focusedWindow: "Viewport", hoveredWindow: "" };
    if (want("layout")) out.layout = { workspace: "level", savedLayouts: [], bottomDockMaximized: false, dockRatios: { left: 0.2, right: 0.24, bottom: 0.25, rightSplit: 0 }, display: { width: 1280, height: 720, dpiScale: 1 }, dockNodes: [], structureHash: "0000000000000000" };
    if (want("modal")) out.modal = { blocking: !!model.modal, count: model.modal ? 1 : 0, modals: modalList(), popupOpen: !!model.modal, note: "" };
    if (want("mode")) out.mode = { engineMode: st.mode === "Playing" ? "playing" : "editor", playing: st.mode === "Playing", paused: false, headless: false, background: { mode: "hidden", toolWindow: false }, virtualInput: st.virtualInput, dpiScale: 1, scene: { path: "scenes/default.json", dirty: model.dirty, generation: st.sceneGeneration, entityCount: st.entities.length }, aiTransaction: { open: false }, viewport: { camera: { position: [0, 2, -5], forward: [0, 0, 1] }, viewMode: "lit", view2D: false, flyMode: false, gizmo: { mode: "translate", space: "world" }, fill: model.fill, workspace: "level" } };
    if (want("undo")) out.undo = { canUndo: model.undoDepth > 0, canRedo: model.redoDepth > 0, undoDepth: model.undoDepth, redoDepth: model.redoDepth, recentUndo: [], recentRedo: [], dirty: model.dirty, editSeq: model.undoDepth, savedSeq: 0 };
    if (want("toasts")) { const lim = p.limit ?? 20; out.toasts = { live: model.toasts.length, recent: model.toasts.slice(-lim).reverse().map((t) => ({ seq: t.seq, kind: t.kind, text: t.text, count: t.count, ageSec: 0 })) }; }
    if (want("perf")) out.perf = { fps: 60, frameMs: 16.6, entityCount: st.entities.length };
    return out;
  };

  const notify = (p: any) => {
    const level = p.level ?? "info";
    const id = pushToast(level, String(p.message));
    return { notified: true, id, level, seconds: p.seconds ?? (level === "error" ? 6 : 3), live: model.toasts.length, note: "人のエディタ画面の右下に出る。--background ではオフスクリーンなので人の画面には出ない" };
  };

  const select = (p: any, ctx: MockCtx) => {
    const st = stateOf(ctx);
    const mode = p.mode ?? "set";
    const notFound: (string | number)[] = [];
    let hit: string[] = [];
    for (const n of p.names ?? []) { if (st.entities.includes(n)) hit.push(n); else notFound.push(n); }
    for (const id of p.entities ?? []) { const n = st.entities[id - 1]; if (n) hit.push(n); else notFound.push(id); }
    if (typeof p.query === "string") {
      const re = new RegExp(p.query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), "i");
      hit.push(...st.entities.filter((n) => re.test(n)));
    }
    hit = [...new Set(hit)];
    if (mode !== "clear" && hit.length === 0 && notFound.length > 0) {
      throw errObj(1, `no entity named '${notFound[0]}'`, { error_name: "E_NOT_FOUND_ENTITY", error_did_you_mean: nearestIds(String(notFound[0]), st.entities, 3), error_details: { notFound } });
    }
    if (mode === "clear") model.selection = [];
    else if (mode === "set") model.selection = hit;
    else if (mode === "add") model.selection = [...new Set([...model.selection, ...hit])];
    else if (mode === "remove") model.selection = model.selection.filter((n) => !hit.includes(n));
    else model.selection = [...model.selection.filter((n) => !hit.includes(n)), ...hit.filter((n) => !model.selection.includes(n))];
    const ent = (n: string) => ({ entityId: st.entities.indexOf(n) + 1, name: n });
    return { mode, selection: { count: model.selection.length, primary: model.selection.length ? ent(model.selection[model.selection.length - 1]) : null, entities: model.selection.map(ent) }, matched: hit.length, notFound };
  };

  const handlers: Record<string, (p: any, ctx: MockCtx) => unknown> = {
    editor_command_list: list, editor_command_run: (p, c) => run(p, c, false), editor_command_run_guarded: (p, c) => run(p, c, true),
    editor_state: state, editor_notify: (p) => notify(p), editor_select: select, editor_modal: modal,
  };
  const methods: MockMethod[] = Object.entries(META).map(([name, meta]) => ({
    name, category: "editor_ui", summary: "", effect: "read", mode: "any", params: [], source: "meta", ...meta, handler: handlers[name],
  } as MockMethod));
  return { methods, model, guardedMethods: new Set(["git_push", "eval_lua", "editor_command_run_guarded"]), closeModal: () => { model.modal = null; }, openModal: (id: string, kind = "editor-dialog", title = id) => { model.modal = { id, kind, title }; } };
}
