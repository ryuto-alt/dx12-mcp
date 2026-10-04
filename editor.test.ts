// エディタ操作(M7)のテスト。エンジン不要(偽エンジン mockEditor.ts + stdio の MCP サーバ)。
//   [1] 純ロジック(editorOps.ts): op の正規化・引数検査・エラーの面別書き換え(guarded / モーダル / 未知 id / OS ダイアログ)・助言
//   [2] ツール面: core = command / state の 2 本だけ、full = 末尾に 4 本、legacy = 出ない。shape のキーと op 表の一致・説明・annotations
//   [3] 偽エンジンとの一巡(core 面): list → describe → run(window 開閉・create・undo)→ state の各 scope → notify → toasts → select
//   [4] guarded: core は E_GUARDED + fix(dx12_call_guarded)→ 承認の経路で実行 / dryRun は guarded でも通る / full は dx12_call {confirm:true}
//   [5] モーダル: 開くコマンド → state.modal.blocking → 他のコマンドは E_MODAL_OPEN → 閉じて復帰 / OS ダイアログ(file.open)は E_UNSUPPORTED
//   [6] dx12_call 経由(alias・dryRun・meta.effect)・長尾へ移した dx12_play_script / dx12_engine_list が旧名のまま動く
// 実行: node editor.test.ts

import { startMockEngine } from "./mockEngine.ts";
import { createEditorMock } from "./mockEditor.ts";
import { startMcp } from "./stdioClient.ts";
import {
  EDITOR_COMMAND_KEYS, EDITOR_OPS, modalDismissFix, planEditorModal, finishEditorModalError, EDITOR_OP_SPECS, EDITOR_OP_EFFECT, EDITOR_TOOLS, CORE_EDITOR, guardedRunFix, escKeyFix,
  finalizeRunResult, finishEditorCommandError, finishEditorSelectError, normalizeOp, planEditorCommand, planEditorNotify, planEditorSelect, stateAdvice, unwrapDescribe,
} from "./editorOps.ts";
import { CORE_ORDER, CORE_DESCRIPTIONS, CORE_DESCRIPTION_MAX } from "./coreSpec.ts";
import { ERROR_CODES } from "./errors.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ─────────────────────────────────────────────────────────────────────────────
console.log("[1] 純ロジック(editorOps.ts)");
{
  check("op の別名(exec / execute → run、ls / commands → list、info → describe)と正準名", normalizeOp("exec") === "run" && normalizeOp("execute") === "run" && normalizeOp("ls") === "list" && normalizeOp("commands") === "list" && normalizeOp("info") === "describe" && normalizeOp("RUN") === "run" && normalizeOp("zzz") === null && normalizeOp(3) === null);
  const noOp = planEditorCommand({});
  check("op が無い → E_MISSING_PARAM + validValues + 撃ち直しは list", !noOp.ok && noOp.body.code === "E_MISSING_PARAM" && eq(noOp.body.validValues, ["list", "run", "describe"]) && noOp.body.fix?.[0]?.args?.op === "list", noOp);
  const badOp = planEditorCommand({ op: "runn" });
  check("op の打ち間違い → E_BAD_ENUM + didYouMean(run)+ 撃ち直し", !badOp.ok && badOp.body.code === "E_BAD_ENUM" && badOp.body.didYouMean?.[0] === "run" && badOp.body.fix?.[0]?.args?.op === "run", badOp);
  const noId = planEditorCommand({ op: "run" });
  check("run で id が無い → E_MISSING_PARAM + fix は list(コマンド id は表の中身なので TS に書かない)", !noId.ok && noId.body.code === "E_MISSING_PARAM" && noId.body.fix?.[0]?.args?.op === "list", noId);
  const noId2 = planEditorCommand({ op: "describe", id: "  " });
  check("describe で id が空白だけ → E_MISSING_PARAM", !noId2.ok && noId2.body.code === "E_MISSING_PARAM", noId2);
  const badArgs = planEditorCommand({ op: "run", id: "create.box", args: [1, 2] });
  check("args が配列 → E_BAD_TYPE + fix は describe", !badArgs.ok && badArgs.body.code === "E_BAD_TYPE" && badArgs.body.fix?.[0]?.args?.op === "describe", badArgs);
  const list = planEditorCommand({ op: "list", query: "窓", kind: "window", enabledOnly: true, id: undefined, args: { ignored: 1 } });
  check("list → editor_command_list へ絞り込みだけ渡す(args は渡さない)", list.ok && list.method === "editor_command_list" && eq(list.params, { query: "窓", kind: "window", enabledOnly: true }), list);
  const desc = planEditorCommand({ op: "describe", id: " window.postProcess " });
  check("describe → editor_command_list {id, detail:true}", desc.ok && desc.method === "editor_command_list" && eq(desc.params, { id: "window.postProcess", detail: true }), desc);
  const run = planEditorCommand({ op: "run", id: "create.box", args: { position: [0, 0, 1] }, dryRun: true, idempotency_key: "k1" });
  check("run → editor_command_run {id, args, dryRun, idempotency_key}・timeout 15 秒", run.ok && run.method === "editor_command_run" && eq(run.params, { id: "create.box", args: { position: [0, 0, 1] }, dryRun: true, idempotency_key: "k1" }) && run.timeoutMs === 15000, run);
  check("op 表: list / describe は read、run は write_setting(dx12_call の meta.effect)", EDITOR_OP_EFFECT.list === "read" && EDITOR_OP_EFFECT.describe === "read" && EDITOR_OP_EFFECT.run === "write_setting");
  check("全 op が受ける引数キーの和集合が EDITOR_COMMAND_KEYS(zod の shape と同じ集合になることは [2] で確認)", EDITOR_COMMAND_KEYS.includes("op") && EDITOR_COMMAND_KEYS.includes("dryRun") && EDITOR_COMMAND_KEYS.includes("guardedOnly") && EDITOR_OPS.every((o) => EDITOR_OP_SPECS[o].summary.length > 10));

  // エラーの面別書き換え
  const guardedEngine = { code: "E_GUARDED" as const, message: "edit.delete is guarded", fix: [{ tool: "editor_command_run_guarded", args: { id: "edit.delete" }, why: "確認つき" }], details: { id: "edit.delete", gate: "command" } };
  const gCore = finishEditorCommandError(guardedEngine, "run", { op: "run", id: "edit.delete" }, "core");
  check("E_GUARDED(core 面): fix は dryRun の確認 → dx12_call_guarded {name:editor_command_run_guarded, args:{id}}", gCore.fix?.[0]?.args?.dryRun === true && gCore.fix?.[1]?.tool === "dx12_call_guarded" && gCore.fix?.[1]?.args?.name === "editor_command_run_guarded" && eq(gCore.fix?.[1]?.args?.args, { id: "edit.delete" }) && !("confirm" in (gCore.fix?.[1]?.args ?? {})), gCore.fix);
  const gFull = finishEditorCommandError(guardedEngine, "run", { op: "run", id: "edit.delete" }, "full");
  check("E_GUARDED(full 面): fix は dx12_call {name:editor_command_run_guarded, args, confirm:true}", gFull.fix?.[1]?.tool === "dx12_call" && gFull.fix?.[1]?.args?.confirm === true && gFull.fix?.[1]?.args?.name === "editor_command_run_guarded", gFull.fix);
  check("E_GUARDED の details に guardedCommand・経路が入る / 元の engine の fix は捨てる", (gCore.details as any)?.guardedCommand === true && !gCore.fix?.some((f) => f.tool === "editor_command_run_guarded"), gCore);
  const gArgs = guardedRunFix("core", "file.save", { x: 1 }, true);
  check("guardedRunFix(dryRun)は args と dryRun:true を含む", gArgs.args?.dryRun === true && eq((gArgs.args as any).args, { id: "file.save", args: { x: 1 } }), gArgs);
  const modal = finishEditorCommandError({ code: "E_MODAL_OPEN", message: "modal", details: { modals: [{ kind: "editor-dialog", id: "new_scene" }] }, fix: [{ tool: "editor_state", args: { scope: "modal" } }, { tool: "editor_modal", args: { action: "dismiss" } }, { tool: "imgui_key", args: { key: "Esc" } }] }, "run", { op: "run", id: "view.fill" }, "core");
  check("E_MODAL_OPEN(ダイアログ): fix は editor_state {scope:modal} → dx12_editor_modal {action:dismiss}(Esc では閉じない)。エンジンの fix は重複させない", modal.fix?.[0]?.tool === "dx12_editor_state" && modal.fix?.[1]?.tool === "dx12_editor_modal" && modal.fix?.[1]?.args?.action === "dismiss" && modal.fix?.[1]?.thenRetry === true && !modal.fix.some((f) => f.tool === "editor_state" || f.tool === "imgui_key" || f.tool === "editor_modal" || f.tool === "dx12_imgui_key") && modal.fix.length === 2, modal.fix);
  const modalP = finishEditorCommandError({ code: "E_MODAL_OPEN", message: "m", details: { modals: [{ kind: "palette", id: "palette" }] } }, "run", { op: "run", id: "x" }, "core");
  check("E_MODAL_OPEN(コマンドパレット): Esc(core は dx12_imgui {op:key}、full は dx12_imgui_key)", modalP.fix?.[1]?.tool === "dx12_imgui" && modalP.fix?.[1]?.args?.key === "Esc" && finishEditorCommandError({ code: "E_MODAL_OPEN", message: "m", details: { modals: [{ kind: "palette" }] } }, "run", { op: "run", id: "x" }, "full").fix?.[1]?.tool === "dx12_imgui_key" && escKeyFix("shell", "").tool === "dx12_imgui");
  check("modalDismissFix: ダイアログは editor_modal、パレットだけ Esc", modalDismissFix("core", "editor-dialog").tool === "dx12_editor_modal" && modalDismissFix("core", "palette").tool === "dx12_imgui" && modalDismissFix("full", undefined).args?.action === "dismiss");
  const mp0 = planEditorModal({});
  check("modal: action 省略は get・打ち間違いは E_BAD_ENUM + didYouMean", mp0.ok && eq(mp0.params, { action: "get" }) && !planEditorModal({ action: "dismis" }).ok && (planEditorModal({ action: "dismis" }) as any).body.didYouMean?.[0] === "dismiss");
  const mu = finishEditorModalError({ code: "E_UNSUPPORTED", message: "cannot", details: { id: "unsaved_confirm" } }, "core");
  check("modal: 閉じられないモーダル(E_UNSUPPORTED)→ fix は state と find(ボタンを押す)", mu.fix?.[0]?.tool === "dx12_editor_state" && mu.fix?.[1]?.tool === "dx12_imgui" && mu.fix?.[1]?.args?.op === "find" && mu.fix?.[1]?.args?.label === "unsaved_confirm", mu.fix);
  check("modal: モーダルが無い(E_NOT_FOUND)→ fix は state の確認", finishEditorModalError({ code: "E_NOT_FOUND", message: "none" }, "core").fix?.[0]?.tool === "dx12_editor_state");
  const nf = finishEditorCommandError({ code: "E_NOT_FOUND_COMMAND", message: "no such", didYouMean: ["window.postProcess"], fix: [{ tool: "editor_command_list", args: { query: "postProces" } }] }, "run", { op: "run", id: "window.postProces" }, "core");
  check("E_NOT_FOUND_COMMAND: 先頭の fix は最も近い id で撃ち直し、次に list", nf.fix?.[0]?.args?.id === "window.postProcess" && nf.fix?.[1]?.args?.op === "list", nf.fix);
  const os = finishEditorCommandError({ code: "E_UNSUPPORTED", message: "os dialog", details: { reason: "os-dialog", id: "file.open" }, fix: [{ tool: "open_scene", args: {} }] }, "run", { op: "run", id: "file.open" }, "core");
  check("E_UNSUPPORTED(os-dialog): fix は dx12_open_scene(path 指定)", os.fix?.[0]?.tool === "dx12_open_scene" && !os.fix?.some((f) => f.tool === "open_scene"), os.fix);
  const mc = finishEditorCommandError({ code: "E_MODE_CONFLICT", message: "not available", details: { reason: "Play 中は使えない", id: "edit.undo" } }, "run", { op: "run", id: "edit.undo" }, "core");
  check("E_MODE_CONFLICT: 末尾の fix は describe(いま実行できない理由と引数を確認)", mc.fix?.at(-1)?.args?.op === "describe" && mc.fix?.at(-1)?.args?.id === "edit.undo", mc.fix);
  check("E_NOT_FOUND_COMMAND はエラーコード表にある", "E_NOT_FOUND_COMMAND" in ERROR_CODES);

  // 結果の整形
  const opened = finalizeRunResult({ id: "file.new", executed: true, effects: { modalsOpened: [{ kind: "editor-dialog", title: "新規シーン" }] } }, "core");
  check("run の結果にモーダルが開いたとき next(state → dx12_editor_modal dismiss)と note を足す", opened.next?.length === 2 && opened.next[0].tool === "dx12_editor_state" && opened.next[1].tool === "dx12_editor_modal" && opened.next[1].args.action === "dismiss" && /モーダル/.test(opened.note), opened);
  check("run の結果: パレットが開いたときは next が Esc", finalizeRunResult({ effects: { modalsOpened: [{ kind: "palette" }] } }, "core").next[1].tool === "dx12_imgui");
  check("モーダルが開いていない run の結果は変えない", eq(finalizeRunResult({ id: "x", effects: { modalsOpened: [] } }, "core"), { id: "x", effects: { modalsOpened: [] } }));
  check("describe: list の結果から 1 件を取り出す", eq(unwrapDescribe({ commands: [{ id: "a" }, { id: "b" }], context: { playing: false } }, "b"), { command: { id: "b" }, context: { playing: false } }));
  const adv = stateAdvice({ scope: "all", modal: { blocking: true, modals: [{ kind: "editor-dialog", id: "new_scene", title: "新規シーン", canDismiss: true }] } }, "core");
  check("state: modal.blocking(canDismiss:true)のとき advice(Esc では閉じない旨)と next(dx12_editor_modal dismiss)を足す", Array.isArray(adv.advice) && adv.advice.length === 2 && /新規シーン/.test(adv.advice[0]) && /Esc では閉じない/.test(adv.advice[1]) && adv.next[0].tool === "dx12_editor_modal" && adv.next[1].tool === "dx12_editor_state", adv);
  const advB = stateAdvice({ modal: { blocking: true, modals: [{ kind: "editor-dialog", id: "unsaved_confirm", title: "未保存", canDismiss: false }] } }, "core");
  check("state: canDismiss:false(未保存の確認など)は next が find(ボタンを押す)", advB.next[0].tool === "dx12_imgui" && advB.next[0].args.op === "find", advB.next);
  const advP = stateAdvice({ modal: { blocking: true, modals: [{ kind: "palette", id: "palette", title: "パレット", canDismiss: true }] } }, "full");
  check("state: パレットは next が Esc(full は dx12_imgui_key)", advP.next[0].tool === "dx12_imgui_key");
  check("state: blocking でなければ何も足さない", !("advice" in stateAdvice({ modal: { blocking: false } }, "core")));

  // notify / select
  const n0 = planEditorNotify({});
  check("notify: message が無い → E_MISSING_PARAM", !n0.ok && n0.body.code === "E_MISSING_PARAM", n0);
  const n1 = planEditorNotify({ message: "x".repeat(401) });
  check("notify: 401 字 → E_OUT_OF_RANGE + 切り詰めた撃ち直し", !n1.ok && n1.body.code === "E_OUT_OF_RANGE" && (n1.body.fix?.[0]?.args?.message as string).length === 398, n1);
  const n2 = planEditorNotify({ message: "完了", level: "success", seconds: 5 });
  check("notify: そのまま渡す", n2.ok && eq(n2.params, { message: "完了", level: "success", seconds: 5 }));
  const s0 = planEditorSelect({});
  check("select: 対象が無い → E_MISSING_PARAM + fix(names / clear)", !s0.ok && s0.body.code === "E_MISSING_PARAM" && s0.body.fix?.length === 2, s0);
  check("select: mode:clear は対象不要", planEditorSelect({ mode: "clear" }).ok);
  check("select: 空配列 / 空文字だけは対象なし扱い", !planEditorSelect({ names: [], query: " " }).ok);
  const s1 = planEditorSelect({ names: ["Wall_01"], mode: "add", focus: true });
  check("select: そのまま渡す", s1.ok && eq(s1.params, { mode: "add", names: ["Wall_01"], focus: true }));
  const sf = finishEditorSelectError({ code: "E_NOT_FOUND_ENTITY", message: "no entity", didYouMean: ["Wall_01"], details: { notFound: ["Wal_01"] } }, { names: ["Wall_02", "Wal_01"] });
  check("select: E_NOT_FOUND_ENTITY → 見つからない名前だけ近い名前に替えた撃ち直し", eq(sf.fix?.[0]?.args?.names, ["Wall_02", "Wall_01"]) && sf.fix?.[1]?.tool === "dx12_list_entities", sf.fix);
}

// ─────────────────────────────────────────────────────────────────────────────
const ed = createEditorMock();
const mock = await startMockEngine({ methods: ed.methods, safety: true, guardedMethods: ed.guardedMethods, previewMethods: new Set(["editor_command_run", "editor_command_run_guarded"]) });
const env = { DX12_MCP_PORT: String(mock.port) };
const core = startMcp({ ...env, DX12_MCP_SURFACE: "core" });
const full = startMcp({ ...env, DX12_MCP_SURFACE: "full" });
const legacy = startMcp({ ...env, DX12_MCP_SURFACE: "legacy" });
const shellOnly = startMcp({ ...env, DX12_MCP_SURFACE: "shell" });
const last = (r: any) => JSON.parse(r.content[r.content.length - 1].text);
const sent = (m: string) => mock.received.filter((r) => r.method === m);

try {
  console.log("[2] ツール面");
  await core.initialize(); await full.initialize(); await legacy.initialize(); await shellOnly.initialize();
  const coreTools: any[] = (await core.rpc("tools/list")).result.tools;
  const fullTools: any[] = (await full.rpc("tools/list")).result.tools;
  const legacyTools: any[] = (await legacy.rpc("tools/list")).result.tools;
  const shellTools: any[] = (await shellOnly.rpc("tools/list")).result.tools;
  const coreNames = coreTools.map((t) => t.name);
  check("core 面はちょうど 40 本・dx12_editor_command / dx12_editor_state が並びどおり(dx12_imgui の直後)", coreTools.length === 40 && eq(coreNames.slice(5), CORE_ORDER) && coreNames.indexOf("dx12_editor_command") === coreNames.indexOf("dx12_imgui") + 1 && coreNames.indexOf("dx12_editor_state") === coreNames.indexOf("dx12_imgui") + 2, { n: coreTools.length });
  check("core 面に dx12_editor_notify / dx12_editor_select / 長尾へ移した dx12_play_script / dx12_engine_list は出ない", !["dx12_editor_notify", "dx12_editor_select", "dx12_editor_modal", "dx12_play_script", "dx12_engine_list"].some((n) => coreNames.includes(n)));
  check("full 面の末尾 7 本がエディタ操作 5 本(command / state / notify / select / modal)+ シーン仕様 2 本", eq(fullTools.slice(-7, -2).map((t) => t.name), EDITOR_TOOLS) && fullTools.some((t) => t.name === "dx12_select_entity"), fullTools.slice(-7, -2).map((t) => t.name));
  check("legacy 面にはエディタ操作が出ない(旧 220 本のスナップショットを守る)", !legacyTools.some((t) => t.name.startsWith("dx12_editor_")) && legacyTools.length === 220, legacyTools.length);
  check("shell 面にもエディタ操作は出ない(dx12_call で使う)", shellTools.length === 5);
  const byName = new Map<string, any>(fullTools.map((t) => [t.name, t]));
  const cmdTool = byName.get("dx12_editor_command"), stateTool = byName.get("dx12_editor_state");
  check("dx12_editor_state は readOnlyHint:true・dx12_editor_command は書き込み(destructive ではない)", stateTool.annotations.readOnlyHint === true && cmdTool.annotations.readOnlyHint === false && cmdTool.annotations.destructiveHint === false && !cmdTool._meta?.["anthropic/requiresUserInteraction"], [stateTool.annotations, cmdTool.annotations]);
  check("dx12_editor_command の inputSchema のキーが op 表の和集合と一致(op 必須・他は任意)", eq(Object.keys(cmdTool.inputSchema.properties).sort(), [...EDITOR_COMMAND_KEYS].sort()) && eq(cmdTool.inputSchema.required, ["op"]) && eq(cmdTool.inputSchema.properties.op.enum, ["list", "run", "describe"]), cmdTool.inputSchema);
  check("説明は Core テンプレ(使う / 使わない / 副作用 / 注意)・600 字以内・日本語", EDITOR_TOOLS.every((n) => { const d = byName.get(n).description as string; return d.length <= CORE_DESCRIPTION_MAX && /使う/.test(d) && /使わない/.test(d) && /副作用/.test(d) && /注意|次/.test(d) && d === CORE_DESCRIPTIONS[n]; }), EDITOR_TOOLS.map((n) => byName.get(n).description.length));
  check("core 面の dx12_editor_command / state の説明は full 面と同じ(Core テンプレ)", CORE_EDITOR.every((n) => coreTools.find((t) => t.name === n).description === CORE_DESCRIPTIONS[n]));

  console.log("[3] 偽エンジンとの一巡(core 面)");
  const l1 = await core.call("dx12_editor_command", { op: "list" });
  check("list: 表の全件・カテゴリ・context・compact な各コマンド(guarded / osDialog / 理由つきの実行可否)", l1.total === l1.count && l1.count >= 10 && l1.categories.length > 3 && l1.context.playing === false && l1.commands.find((c: any) => c.id === "edit.delete")?.guarded === true && l1.commands.find((c: any) => c.id === "edit.delete")?.disabledReason === "選択が無い" && l1.commands.find((c: any) => c.id === "file.open")?.osDialog === true && !("help" in l1.commands[0]), l1.commands?.slice(0, 2));
  const l2 = await core.call("dx12_editor_command", { op: "list", query: "ポスト", kind: "window" });
  check("list {query, kind}: 絞り込み(日本語の別名でも当たる)", l2.count === 1 && l2.commands[0].id === "window.postProcess", l2);
  const l3 = await core.call("dx12_editor_command", { op: "list", guardedOnly: true, detail: true });
  check("list {guardedOnly, detail}: guarded だけ・詳細(effect / help)つき", l3.commands.length >= 3 && l3.commands.every((c: any) => c.guarded === true && typeof c.effect === "string" && typeof c.help === "string"), l3.commands?.map((c: any) => c.id));
  const d1 = await core.call("dx12_editor_command", { op: "describe", id: "create.box" });
  check("describe: 1 件の詳細(引数 position / name・例)", d1.command?.id === "create.box" && d1.command.args?.some((a: any) => a.name === "position") && d1.command.example?.id === "create.box", d1);
  const w1 = await core.call("dx12_editor_command", { op: "run", id: "window.postProcess" });
  check("run window.postProcess → windowsOpened に postProcess(既定 open)", w1.executed === true && w1.changed === true && eq(w1.effects.windowsOpened, ["postProcess"]), w1);
  const w2 = await core.call("dx12_editor_command", { op: "run", id: "window.postProcess" });
  check("もう一度 run → 既に開いているので changed:false(トグルで閉じない)", w2.changed === false && w2.effects.windowsOpened.length === 0, w2);
  const s1 = await core.call("dx12_editor_state", { scope: "windows" });
  check("state {scope:windows} → open に postProcess・他のセクションは含まない", s1.windows.open.includes("postProcess") && s1.windows.tools.find((t: any) => t.id === "postProcess")?.open === true && !("selection" in s1) && s1.scope === "windows", s1);
  const w3 = await core.call("dx12_editor_command", { op: "run", id: "window.postProcess", args: { state: "close" } });
  check("run window.postProcess {state:'close'} → windowsClosed", eq(w3.effects.windowsClosed, ["postProcess"]), w3);
  const c1 = await core.call("dx12_editor_command", { op: "run", id: "create.box", args: { name: "Crate" } });
  check("run create.box {name} → entityCount +1・created に Crate・selection が新しい物・dirty:true", c1.effects.entityCount.delta === 1 && c1.effects.created?.[0]?.name === "Crate" && c1.effects.dirty.after === true && c1.effects.selection.after.length === 1 && c1.effects.undo.canUndo === true, c1);
  const st = await core.call("dx12_editor_state", {});
  check("state(all): 全セクション(selection / windows / layout / modal / mode / undo / toasts / perf)・選択は Crate", ["selection", "windows", "layout", "modal", "mode", "undo", "toasts", "perf"].every((k) => k in st) && st.selection.primary?.name === "Crate" && st.mode.scene.dirty === true && st.mode.playing === false && st.undo.canUndo === true && st.modal.blocking === false, Object.keys(st));
  const u1 = await core.call("dx12_editor_command", { op: "run", id: "edit.undo" });
  check("run edit.undo → entityCount -1・canRedo:true(create.box の Undo)", u1.effects.entityCount.delta === -1 && u1.effects.undo.canRedo === true, u1);
  const u2 = await core.call("dx12_editor_command", { op: "run", id: "edit.undo" });
  check("履歴が無いとき edit.undo → E_MODE_CONFLICT + reason + fix(describe)", u2.error_code === "E_MODE_CONFLICT" && /履歴/.test(u2.details?.reason) && u2.fix?.at(-1)?.args?.op === "describe", u2);
  const bad1 = await core.call("dx12_editor_command", { op: "run", id: "window.postProcess", args: { state: "maybe" } });
  check("引数違い → E_INVALID_PARAM + details.args", bad1.error_code === "E_INVALID_PARAM" && bad1.details?.args?.[0]?.name === "state", bad1);
  const bad2 = await core.call("dx12_editor_command", { op: "run", id: "window.postProces" });
  check("未知の id → E_NOT_FOUND_COMMAND + didYouMean(近い id)+ 先頭の fix は撃ち直し", bad2.error_code === "E_NOT_FOUND_COMMAND" && bad2.didYouMean?.[0] === "window.postProcess" && bad2.fix?.[0]?.args?.id === "window.postProcess" && bad2.fix?.[0]?.tool === "dx12_editor_command", bad2);
  const bad3 = await core.call("dx12_editor_command", { op: "describe", id: "nope.nothing" });
  check("describe の未知 id も E_NOT_FOUND_COMMAND", bad3.error_code === "E_NOT_FOUND_COMMAND", bad3);
  const bad4 = await core.raw("dx12_editor_command", { op: "list", queryy: "x" });
  check("未知の引数キー → E_UNKNOWN_PARAM + 近い正解(query)", bad4.isError && last(bad4).error_code === "E_UNKNOWN_PARAM" && last(bad4).didYouMean?.[0] === "query", last(bad4));
  const bad5 = await core.raw("dx12_editor_command", {});
  check("op 無し(SDK の必須検査)→ isError", bad5.isError === true);
  const bad6 = await core.raw("dx12_editor_command", { op: "runn", id: "edit.undo" });
  check("op の打ち間違い(SDK の enum 検証)→ isError", bad6.isError === true);
  await core.call("dx12_editor_command", { op: "run", id: "play.toggle" });
  const st2 = await core.call("dx12_editor_state", { scope: "mode" });
  check("play.toggle → state {scope:mode}.playing:true・Play 中の Editor 専用コマンド(create.box)は E_MODE_CONFLICT + reason", st2.mode.playing === true && (await core.call("dx12_editor_command", { op: "run", id: "create.box" })).error_code === "E_MODE_CONFLICT", st2);
  await core.call("dx12_editor_command", { op: "run", id: "play.toggle" });
  const n1 = await core.call("dx12_call", { name: "dx12_editor_notify", args: { message: "生成が終わりました", level: "success" } });
  check("notify(dx12_call 経由。長尾)→ notified:true・level・live", n1.ok === true && n1.result.notified === true && n1.result.level === "success", n1);
  const tstate = await core.call("dx12_editor_state", { scope: "toasts", limit: 5 });
  check("state {scope:toasts} → 直近のトーストに通知が出る(新しい順)", tstate.toasts.recent[0]?.text === "生成が終わりました" && tstate.toasts.recent[0].kind === "success", tstate);
  const n2 = await core.call("dx12_call", { name: "dx12_editor_notify", args: { message: "" } });
  check("notify: 空の message → 事前検証で拒否(E_OUT_OF_RANGE / E_MISSING_PARAM。エンジンには届かない)", n2.ok === false && ["E_OUT_OF_RANGE", "E_MISSING_PARAM"].includes(n2.error_code) && sent("editor_notify").length === 1, n2);
  const sel = await core.call("dx12_call", { name: "dx12_editor_select", args: { names: ["Wall_01", "Wall_02"] } });
  check("select(長尾)→ 2 体を選択", sel.ok === true && sel.result.selection.count === 2 && sel.result.matched === 2, sel);
  const sel2 = await core.call("dx12_call", { name: "dx12_editor_select", args: { query: "wall_0*", mode: "add" } });
  check("select {query:'wall_0*', mode:add} → 重複せず 2 体のまま", sel2.result.selection.count === 2, sel2);
  const sel3 = await core.call("dx12_call", { name: "dx12_editor_select", args: { names: ["Wall_01"], mode: "remove" } });
  check("select {mode:remove} → 1 体に", sel3.result.selection.count === 1 && sel3.result.selection.primary.name === "Wall_02", sel3);
  const sel4 = await core.call("dx12_call", { name: "dx12_editor_select", args: { names: ["Wal_09"] } });
  check("select: 見つからない名前 → E_NOT_FOUND_ENTITY + didYouMean + 撃ち直し", sel4.ok === false && sel4.error_code === "E_NOT_FOUND_ENTITY" && sel4.didYouMean?.length > 0 && sel4.fix?.[0]?.tool === "dx12_editor_select" && sel4.fix?.some((f: any) => f.tool === "dx12_list_entities"), sel4);
  const sel5 = await core.call("dx12_call", { name: "dx12_editor_select", args: {} });
  check("select: 対象なし → E_MISSING_PARAM", sel5.ok === false && sel5.error_code === "E_MISSING_PARAM", sel5);
  await core.call("dx12_call", { name: "dx12_editor_select", args: { mode: "clear" } });
  check("select {mode:clear} → 選択 0", (await core.call("dx12_editor_state", { scope: "selection" })).selection.count === 0);

  console.log("[4] guarded(削除・保存の上書き)");
  await core.call("dx12_call", { name: "dx12_editor_select", args: { names: ["Wall_01"] } });
  const g1 = await core.call("dx12_editor_command", { op: "run", id: "edit.delete" });
  check("core: edit.delete → E_GUARDED(実行されない)・fix[1] は dx12_call_guarded", g1.error_code === "E_GUARDED" && g1.fix?.[1]?.tool === "dx12_call_guarded" && g1.fix[1].args.name === "editor_command_run_guarded" && mock.state.entities.includes("Wall_01") && (mock.state.exec.editor_command_run_guarded ?? 0) === 0, g1);
  const gd = await core.call("dx12_editor_command", { op: "run", id: "edit.delete", dryRun: true });
  check("dryRun:true は guarded でも通る(何が消えるか・実行されない)", gd.dryRun === true && gd.executed === false && mock.state.entities.includes("Wall_01"), gd);
  const gcall = await core.call("dx12_call", { name: "editor_command_run", args: { id: "file.save" } });
  check("dx12_call {name:editor_command_run} の guarded も E_GUARDED(エンジンが断る)", gcall.ok === false && gcall.error_code === "E_GUARDED", gcall);
  const g2 = await core.call("dx12_call", { name: "editor_command_run_guarded", args: { id: "edit.delete" } });
  check("core: dx12_call {name:editor_command_run_guarded} は E_GUARDED(dx12_call では実行しない)", g2.ok === false && g2.error_code === "E_GUARDED" && g2.fix?.some((f: any) => f.tool === "dx12_call_guarded"), g2);
  const g3 = await core.call("dx12_call_guarded", { name: "editor_command_run_guarded", args: { id: "edit.delete" } });
  check("core: dx12_call_guarded で実行 → 確認トークン付きで削除が走り Wall_01 が消える(effects.entityCount -1)", g3.ok === true && g3.result.effects.entityCount.delta === -1 && !mock.state.entities.includes("Wall_01") && sent("guard_token").length >= 1 && typeof sent("editor_command_run_guarded").at(-1)?.params.confirm_token === "string", g3);
  const g3d = await core.call("dx12_call_guarded", { name: "editor_command_run_guarded", args: { id: "file.save" }, dryRun: true });
  check("dx12_call_guarded {dryRun:true} → プレビュー(保存先のファイル・上書き)・実行されない", g3d.ok === true && (g3d.result?.dryRun === true || g3d.dryRun === true) && (mock.state.exec.editor_command_run_guarded ?? 0) === 1, g3d);
  const gF = await full.call("dx12_editor_command", { op: "run", id: "file.save" });
  check("full: file.save → E_GUARDED・fix[1] は dx12_call {…confirm:true}", gF.error_code === "E_GUARDED" && gF.fix?.[1]?.tool === "dx12_call" && gF.fix[1].args.confirm === true, gF);
  const gF2 = await full.call("dx12_call", { name: "editor_command_run_guarded", args: { id: "file.save" }, confirm: true });
  check("full: dx12_call {confirm:true} で実行 → 保存(dirty:false)・トースト", gF2.ok === true && gF2.result.effects.dirty.after === false && gF2.result.effects.toasts[0]?.text === "保存しました", gF2);

  console.log("[5] モーダル・OS ダイアログ");
  const m1 = await core.call("dx12_editor_command", { op: "run", id: "file.new" });
  check("file.new → effects.modalsOpened に新規シーンのダイアログ・next に state / dx12_editor_modal", m1.executed === true && m1.effects.modalsOpened.length === 1 && m1.next?.some((n: any) => n.tool === "dx12_editor_state") && m1.next?.some((n: any) => n.tool === "dx12_editor_modal"), m1);
  const ms = await core.call("dx12_editor_state", { scope: "modal" });
  check("state {scope:modal} → blocking:true・modals[0] に id / title / canDismiss / dismissHint・advice と next(dx12_editor_modal)", ms.modal.blocking === true && ms.modal.modals[0].id === "new_scene" && typeof ms.modal.modals[0].dismissHint === "string" && ms.modal.modals[0].canDismiss === true && ms.advice?.length === 2 && ms.next?.[0]?.tool === "dx12_editor_modal", ms);
  const m2 = await core.call("dx12_editor_command", { op: "run", id: "view.fill" });
  check("モーダル中のコマンドは E_MODAL_OPEN + details.modals + fix(state → dx12_editor_modal dismiss)", m2.error_code === "E_MODAL_OPEN" && m2.details?.modals?.[0]?.id === "new_scene" && m2.fix?.[0]?.tool === "dx12_editor_state" && m2.fix?.[1]?.tool === "dx12_editor_modal" && m2.fix[1].thenRetry === true && !m2.fix.some((f: any) => f.tool === "imgui_key"), m2);
  const ml = await core.call("dx12_editor_command", { op: "list", enabledOnly: true });
  check("list はモーダル中も読める(context.modalOpen:true・各コマンドに blockedNow)", ml.context.modalOpen === true && ml.commands.every((c: any) => typeof c.blockedNow === "string"), ml.context);
  const mg = await core.call("dx12_call", { name: "dx12_editor_modal", args: {} });
  check("dx12_editor_modal {get}(既定)→ editor_state の modal と同じ形(blocking:true)", mg.ok === true && mg.result.blocking === true && mg.result.modals[0].id === "new_scene", mg);
  const mdEsc = await core.call("dx12_call", { name: "editor_modal", args: { action: "dismiss" } });
  check("dx12_call {name:editor_modal} で method 名のままでも撃てる(dismiss → dismissed:true・id・modal.blocking:false)", mdEsc.ok === true && mdEsc.result.dismissed === true && mdEsc.result.id === "new_scene" && mdEsc.result.modal.blocking === false, mdEsc);
  const mNone = await core.call("dx12_call", { name: "dx12_editor_modal", args: { action: "dismiss" } });
  check("閉じるものが無いとき dismiss → E_NOT_FOUND + fix(state の確認)", mNone.ok === false && mNone.error_code === "E_NOT_FOUND" && mNone.fix?.[0]?.tool === "dx12_editor_state", mNone);
  ed.openModal("unsaved_confirm", "editor-dialog", "未保存の変更");
  const mUn = await core.call("dx12_call", { name: "dx12_editor_modal", args: { action: "dismiss" } });
  check("未保存の確認は dismiss できない → E_UNSUPPORTED + details.id + fix(find でボタンを探す)", mUn.ok === false && mUn.error_code === "E_UNSUPPORTED" && mUn.details?.id === "unsaved_confirm" && mUn.fix?.[1]?.args?.op === "find", mUn);
  const msUn = await core.call("dx12_editor_state", { scope: "modal" });
  check("未保存の確認は state で canDismiss:false・next は find(ボタンを押す)", msUn.modal.modals[0].canDismiss === false && msUn.next?.[0]?.tool === "dx12_imgui" && msUn.next[0].args.op === "find", msUn);
  ed.openModal("palette", "palette", "コマンドパレット");
  const mPal = await core.call("dx12_editor_command", { op: "run", id: "view.fill" });
  check("コマンドパレットが開いているときの E_MODAL_OPEN は fix が Esc(dx12_imgui {op:key})", mPal.error_code === "E_MODAL_OPEN" && mPal.fix?.[1]?.tool === "dx12_imgui" && mPal.fix[1].args.key === "Esc", mPal.fix);
  ed.closeModal();
  const mBad = await core.call("dx12_call", { name: "dx12_editor_modal", args: { action: "dismis" } });
  check("action の打ち間違い → E_BAD_ENUM + didYouMean(dismiss)", mBad.ok === false && mBad.error_code === "E_BAD_ENUM" && mBad.didYouMean?.[0] === "dismiss", mBad);
  const m3 = await core.call("dx12_editor_command", { op: "run", id: "view.fill", args: { state: "on" } });
  check("閉じた後は復帰して実行できる(view.fill {state:on})", m3.executed === true && m3.changed === true, m3);
  const os1 = await core.call("dx12_call_guarded", { name: "editor_command_run_guarded", args: { id: "file.open" } });
  check("OS ダイアログ(file.open)は仮想入力 / 背景モードでは承認しても E_UNSUPPORTED(os-dialog)+ fix は dx12_open_scene", os1.ok === false && os1.error_code === "E_UNSUPPORTED" && os1.details?.reason === "os-dialog", os1);
  const osl = await core.call("dx12_editor_command", { op: "list", query: "file.open", detail: true });
  check("list でも file.open は guarded / osDialog / blockedNow(いま実行拒否になる理由)が分かる", osl.commands[0].guarded === true && osl.commands[0].osDialog === true && /OS/.test(osl.commands[0].blockedNow), osl.commands[0]);

  console.log("[6] dx12_call 経由・長尾へ移した 2 本");
  const cl = await core.call("dx12_call", { name: "dx12_editor_command", args: { op: "list", query: "元に戻す" } });
  check("dx12_call {name:dx12_editor_command}: 結果は result・meta.effect は op ごと(list = read)", cl.ok === true && cl.result.commands[0].id === "edit.undo" && cl.meta.effect === "read" && cl.meta.op === "list" && cl.meta.engineMethod === "editor_command_list", cl.meta);
  const cr = await core.call("dx12_call", { name: "dx12_editor_command", args: { op: "run", id: "window.lighting" } });
  check("dx12_call の run は meta.effect:write_setting", cr.ok === true && cr.meta.effect === "write_setting" && cr.meta.op === "run", cr.meta);
  const crd = await core.call("dx12_call", { name: "dx12_editor_command", args: { op: "run", id: "window.terrain" }, dryRun: true });
  check("dx12_call {dryRun:true}: 実行されない(native dryRun)・ウィンドウは開かない", crd.ok === true && crd.executed === false && !(await core.call("dx12_editor_state", { scope: "windows" })).windows.open.includes("terrain"), crd);
  const cd = await core.call("dx12_tool_describe", { name: "dx12_editor_command", target: "run" });
  check("dx12_tool_describe {target:run}: run の引数(id 必須)と effect", cd.callTemplate?.args?.op === "run" && cd.effect === "write_setting" && cd.params?.some((p: any) => p.name === "id" && p.required === true), cd);
  const ds = await core.call("dx12_tool_describe", { name: "dx12_editor_state" });
  check("dx12_tool_describe dx12_editor_state: tier:core・effect:read", ds.tier === "core" && ds.effect === "read", { tier: ds.tier, effect: ds.effect });
  const dselOld = await core.call("dx12_tool_describe", { name: "dx12_select_entity" });
  check("旧 dx12_select_entity は無傷(tier:legacy)で、複数選択・クエリは dx12_editor_select へ案内する(next)", dselOld.tier === "legacy" && dselOld.name === "dx12_select_entity" && dselOld.next?.some((n: any) => n.tool === "dx12_editor_select"), { tier: dselOld.tier, next: dselOld.next });
  const ps = await core.call("dx12_call", { name: "dx12_play_script", args: { steps: [{ t: 0.1, press: "W" }], expect: [] } });
  const ps2 = await core.call("dx12_tool_describe", { name: "dx12_play_script" });
  check("長尾へ移した dx12_play_script は旧名のまま解決(tier:legacy)・dx12_call で名前・引数そのまま撃てる", ps2.tier === "legacy" && ps2.name === "dx12_play_script" && typeof ps === "object", ps2.tier);
  const el = await core.call("dx12_call", { name: "dx12_engine_list", args: {} });
  check("長尾へ移した dx12_engine_list は dx12_call で使える(ok・engines 配列)", el.ok === true && Array.isArray(el.result.engines), el);
  const srch = await core.call("dx12_tool_search", { query: "ポストプロセスの窓を開く" });
  check("dx12_tool_search でエディタ操作が見つかる(dx12_editor_command が上位 3 件)", srch.hits.slice(0, 3).some((h: any) => h.name === "dx12_editor_command"), srch.hits?.slice(0, 3).map((h: any) => h.name));
  const doc = await core.call("dx12_guide", { topic: "editor" });
  check("dx12_guide {topic:editor} に dx12_editor_command と禁止事項(computer-use / 前面化しない)・モーダル・guarded がある", /dx12_editor_command/.test(doc._text ?? "") && /computer-use/.test(doc._text ?? "") && /モーダル/.test(doc._text ?? "") && /guarded/.test(doc._text ?? "") && /dx12_editor_state/.test(doc._text ?? ""), (doc._text ?? "").slice(0, 200));
} finally {
  for (const c of [core, full, legacy, shellOnly]) { try { c.proc.stdin!.end(); c.proc.kill(); } catch { /* 無視 */ } }
  await mock.close();
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: エディタ操作テスト ${total} 項目すべて通過`);
process.exit(0);
