// dx12_sequence(シーケンサー .dxseq の Core ツール)のテスト。エンジンは起動しない(偽エンジン = mockEngine.ts)。
//   [1] 純ロジック(sequenceOps.ts): op の振り分け・引数の写像・必須/未知キー/型の検査・dryRun の種別・エラーの fix が撃ち直せること
//   [2] Core 面のサイズ・説明文の lint(600 字以内・標準語・テンプレ)・スキーマ(op の enum・引数キー)・旧ツール(dx12_sequence_author / preview / camera_path)が不変
//   [3] stdio 一巡(core 面): op → エンジン method の振り分け / dryRun の渡し方(エンジンのプレビュー・静的・読み取りは無視)/ M2 の封筒(cause・fix・didYouMean)
//       / 検索(シーケンス・タイムライン等)/ dx12_call 経由(meta.effect が op ごと・native dryRun)/ 古いエンジン(E_ENGINE_TOO_OLD)
// 実行: node sequenceCore.test.ts

import { startMockEngine, type MockMethod } from "./mockEngine.ts";
import { startMcp } from "./stdioClient.ts";
import {
  SEQUENCE_ALL_KEYS, SEQUENCE_OPS, SEQUENCE_OP_EFFECT, SEQUENCE_OP_SPECS, SEQUENCE_TOOL_EFFECT, enrichEditError, finishSequenceError, normalizeOp, planSequenceCall, rewriteSequenceFixes, staticPreview,
  type SequenceOp,
} from "./sequenceOps.ts";
import { CORE_DESCRIPTIONS, CORE_DESCRIPTION_MAX, CORE_ORDER } from "./coreSpec.ts";
import { DIALECT_PATTERN, type ErrorBody } from "./errors.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plan = (a: Record<string, unknown>) => planSequenceCall(a);
const okPlan = (a: Record<string, unknown>) => { const p = plan(a); if (!p.ok) throw new Error("plan failed: " + JSON.stringify(p.body)); return p; };
const errBody = (a: Record<string, unknown>): ErrorBody => { const p = plan(a); if (p.ok) throw new Error("plan should fail: " + JSON.stringify(a)); return p.body; };

// ─────────────────────────────────────────────────────────────────────────────
console.log("[1] 純ロジック(sequenceOps.ts)");
{
  check("op は 10 個(list / load / save / get / eval / scrub / play / stop / edit / autoplay)", eq([...SEQUENCE_OPS], ["list", "load", "save", "get", "eval", "scrub", "play", "stop", "edit", "autoplay"]));
  check("op → エンジン method(edit だけ sequence_apply_op)", SEQUENCE_OPS.every((o) => SEQUENCE_OP_SPECS[o].method === (o === "edit" ? "sequence_apply_op" : `sequence_${o}`)));
  const E = SEQUENCE_OP_EFFECT;
  check("効果分類: list / get / eval = read", E.list === "read" && E.get === "read" && E.eval === "read", E);
  check("効果分類: load / scrub / play / stop = runtime", E.load === "runtime" && E.scrub === "runtime" && E.play === "runtime" && E.stop === "runtime", E);
  check("効果分類: save / edit = write_file、autoplay = write_scene", E.save === "write_file" && E.edit === "write_file" && E.autoplay === "write_scene", E);
  check("ツール全体の代表 effect は最も重い write_scene", SEQUENCE_TOOL_EFFECT === "write_scene");
  check("dryRun が有効な op は edit / save / scrub / play(エンジンのプレビュー表)", eq(SEQUENCE_OPS.filter((o) => SEQUENCE_OP_SPECS[o].dryRun === "engine"), ["save", "scrub", "play", "edit"]));

  // 振り分けと引数の写像(そのまま渡す)
  const p1 = okPlan({ op: "eval", name: "Intro", t: 2.5 });
  check("eval → sequence_eval、name / t をそのまま渡し op は渡さない", p1.method === "sequence_eval" && eq(p1.params, { name: "Intro", t: 2.5 }), p1.params);
  const p2 = okPlan({ op: "edit", name: "Intro", ops: [{ op: "addKey", trackId: "t", channel: "position.x", key: { sec: 1, v: 2 } }], label: "キー追加" });
  check("edit → sequence_apply_op(ops / label を渡す)", p2.method === "sequence_apply_op" && Array.isArray(p2.params.ops) && p2.params.label === "キー追加" && !("op" in p2.params), p2.params);
  const p3 = okPlan({ op: "autoplay", action: "add", sequence: "Intro", loop: true, startDelay: 1 });
  check("autoplay の下位操作 action はエンジンの op として渡す", p3.method === "sequence_autoplay" && p3.params.op === "add" && p3.params.sequence === "Intro" && p3.params.loop === true && !("action" in p3.params), p3.params);
  check("loop の読み替え: play は bool → once|loop、autoplay は once|loop|pingpong → bool", okPlan({ op: "play", name: "I", loop: true }).params.loop === "loop" && okPlan({ op: "play", name: "I", loop: false }).params.loop === "once"
    && okPlan({ op: "autoplay", action: "add", sequence: "I", loop: "pingpong" }).params.loop === true && okPlan({ op: "autoplay", action: "add", sequence: "I", loop: "once" }).params.loop === false);
  check("scrub {end:true} は name 不要 / edit {undo:true} は ops 不要", plan({ op: "scrub", end: true }).ok && plan({ op: "edit", name: "I", undo: true }).ok && plan({ op: "edit", name: "I", redo: true }).ok);
  check("別名(apply_op / sequence_list / DX12_SEQUENCE_EVAL 形)は正準の op へ", normalizeOp("apply_op") === "edit" && normalizeOp("sequence_list") === "list" && normalizeOp("dx12_sequence_eval") === "eval" && normalizeOp("Scrub") === "scrub" && normalizeOp("nope") === null && normalizeOp(3) === null);
  check("idempotency_key / expectGeneration は捨てずにエンジンへ渡す", okPlan({ op: "save", name: "I", idempotency_key: "k1" }).params.idempotency_key === "k1");

  // dryRun の種別
  const dk = (a: Record<string, unknown>) => { const p = okPlan({ ...a, dryRun: true }); return p.dryRunMode; };
  check("dryRun: edit / save / scrub / play = engine(エンジンのプレビュー。params に dryRun:true)", dk({ op: "edit", name: "I", ops: [{ op: "addMarker" }] }) === "engine" && dk({ op: "save", name: "I" }) === "engine" && dk({ op: "scrub", name: "I", t: 1 }) === "engine" && dk({ op: "play", name: "I" }) === "engine");
  check("dryRun のとき engine の params にだけ dryRun:true が入る(静的・読み取りには入れない)", okPlan({ op: "save", name: "I", dryRun: true }).params.dryRun === true && !("dryRun" in okPlan({ op: "eval", name: "I", dryRun: true }).params) && !("dryRun" in okPlan({ op: "stop", dryRun: true }).params));
  check("dryRun: load / stop / autoplay = static(実行しない)", dk({ op: "load", name: "I", create: true }) === "static" && dk({ op: "stop" }) === "static" && dk({ op: "autoplay", action: "clear" }) === "static");
  check("dryRun: list / get / eval = read-ignored(読み取りなので実行する)", dk({ op: "list" }) === "read-ignored" && dk({ op: "get", name: "I" }) === "read-ignored" && dk({ op: "eval", name: "I" }) === "read-ignored");
  check("dryRun: scrub {end:true} と edit {undo|redo} はエンジンの表に乗らないので static", dk({ op: "scrub", end: true }) === "static" && dk({ op: "edit", name: "I", undo: true }) === "static");
  check("dryRun 無しは none", okPlan({ op: "save", name: "I" }).dryRunMode === "none" && okPlan({ op: "save", name: "I", dryRun: false }).dryRunMode === "none");
  {
    const sp = staticPreview(okPlan({ op: "stop", dryRun: true }), { op: "stop", dryRun: true }) as any;
    check("静的プレビューはエンジンのプレビューと同じ形 {dryRun, executed:false, method, effect, preview}", sp.dryRun === true && sp.executed === false && sp.method === "sequence_stop" && sp.effect === "runtime" && sp.preview?.op === "stop" && typeof sp.preview?.wouldDo === "string", sp);
    const sl = staticPreview(okPlan({ op: "load", name: "Intro", create: true, dryRun: true }), { op: "load", name: "Intro", create: true, dryRun: true }) as any;
    check("load {create:true} のプレビューは『ファイルは save まで作らない』を言う", /save/.test(sl.preview.wouldDo), sl);
  }

  // エラー: 必須・未知キー・型・enum
  const missOp = errBody({});
  check("op が無い → E_MISSING_PARAM + validValues(op の一覧)+ 撃ち直しは list", missOp.code === "E_MISSING_PARAM" && eq(missOp.validValues, [...SEQUENCE_OPS]) && missOp.fix?.[0]?.tool === "dx12_sequence" && eq(missOp.fix[0].args, { op: "list" }), missOp);
  const badOp = errBody({ op: "evl", name: "I" });
  check("op の打ち間違い → E_BAD_ENUM + didYouMean(eval)+ fix は op だけ直した呼び出し", badOp.code === "E_BAD_ENUM" && badOp.didYouMean?.[0] === "eval" && eq(badOp.fix?.[0]?.args, { op: "eval", name: "I" }), badOp);
  const badOp2 = errBody({ op: "apply_ops", name: "I" });
  check("op に編集を意味する名前(apply_ops)→ 近い op は edit ではなく…でも op 一覧と edit の説明を返す", badOp2.code === "E_BAD_ENUM" && /edit/.test(badOp2.cause ?? "") && (badOp2.validValues ?? []).includes("edit"), badOp2);
  const noName = errBody({ op: "eval" });
  check("name が無い → E_MISSING_PARAM + 撃ち直しは list(名前の確認)", noName.code === "E_MISSING_PARAM" && /'name'/.test(noName.message) && noName.fix?.[0]?.tool === "dx12_sequence" && noName.fix[0].args?.op === "list", noName);
  const noOps = errBody({ op: "edit", name: "Intro" });
  check("edit で ops が無い → E_MISSING_PARAM + 撃ち直しは get(構成を見てから ops を組む)+ undo / redo の案内", noOps.code === "E_MISSING_PARAM" && /ops/.test(noOps.message) && noOps.fix?.[0]?.args?.op === "get" && /undo/.test(noOps.cause ?? ""), noOps);
  const noScrub = errBody({ op: "scrub", t: 1 });
  check("scrub は end:true でなければ name が要る", noScrub.code === "E_MISSING_PARAM" && /'name'/.test(noScrub.message), noScrub);
  check("autoplay: add / remove は sequence、set は players が要る", errBody({ op: "autoplay", action: "add" }).code === "E_MISSING_PARAM" && errBody({ op: "autoplay", action: "remove" }).code === "E_MISSING_PARAM" && errBody({ op: "autoplay", action: "set" }).code === "E_MISSING_PARAM" && plan({ op: "autoplay" }).ok && plan({ op: "autoplay", action: "clear" }).ok);
  const typo = errBody({ op: "eval", name: "I", tik: 3 });
  check("未知キー(打ち間違い tik)→ E_UNKNOWN_PARAM + didYouMean(tick)+ fix は直した呼び出し", typo.code === "E_UNKNOWN_PARAM" && typo.didYouMean?.[0] === "tick" && eq(typo.fix?.[0]?.args, { op: "eval", name: "I", tick: 3 }), typo);
  const cross = errBody({ op: "eval", name: "I", ops: [{ op: "addMarker" }] });
  check("別の op の引数(eval に ops)→ どの op の引数かを言い、その op で撃ち直す fix を出す", cross.code === "E_UNKNOWN_PARAM" && /edit/.test(cross.cause ?? "") && cross.fix?.some((f) => f.args?.op === "edit"), cross);
  const loopKey = errBody({ op: "autoplay", op2: 1 } as any);
  check("autoplay の下位操作を op で書くと衝突する旨を案内する(action)", loopKey.code === "E_UNKNOWN_PARAM" && /action/.test(loopKey.cause ?? ""), loopKey);
  check("detail / clock / action / loop の enum 外 → E_BAD_ENUM + didYouMean", errBody({ op: "get", name: "I", detail: "ful" }).didYouMean?.[0] === "full" && errBody({ op: "play", name: "I", clock: "rael" }).didYouMean?.[0] === "real" && errBody({ op: "autoplay", action: "ad" }).code === "E_BAD_ENUM" && errBody({ op: "play", name: "I", loop: "loopp" }).didYouMean?.[0] === "loop");
  check("ops の型: 配列でない / 空 / 要素がオブジェクトでない / 要素に op が無い", errBody({ op: "edit", name: "I", ops: "x" as any }).code === "E_BAD_TYPE" && errBody({ op: "edit", name: "I", ops: [] }).code === "E_MISSING_PARAM" && errBody({ op: "edit", name: "I", ops: [1 as any] }).code === "E_BAD_TYPE" && errBody({ op: "edit", name: "I", ops: [{ key: 1 }] }).code === "E_MISSING_PARAM");

  // 出したエラーの fix は、そのまま撃てる(dx12_sequence の呼び出しなら plan が通る)。文体は標準語。
  const bodies: ErrorBody[] = [missOp, badOp, badOp2, noName, noOps, noScrub, typo, cross, loopKey,
    errBody({ op: "get", name: "I", detail: "ful" }), errBody({ op: "autoplay", action: "add" }), errBody({ op: "edit", name: "I", ops: [] })];
  const unrunnable = bodies.flatMap((b) => (b.fix ?? []).filter((f) => f.tool === "dx12_sequence" && !planSequenceCall(f.args ?? {}).ok).map((f) => JSON.stringify(f.args)));
  check("エラーの fix のうち dx12_sequence の呼び出しは、すべてそのまま検証を通る(撃ち直せる)", unrunnable.length === 0, unrunnable);
  check("エラー文に方言・命令口調が無い(標準語)", bodies.every((b) => !DIALECT_PATTERN.test(`${b.message} ${b.cause ?? ""} ${(b.fix ?? []).map((f) => f.why).join(" ")}`)));
  check("エラーは cause か fix を必ず持つ(M2 の封筒)", bodies.every((b) => (b.cause || b.fix?.length) && b.fix?.length), bodies.filter((b) => !b.fix?.length).map((b) => b.message));

  // エンジンのエラーの整形
  const ed = enrichEditError(
    { code: "E_INVALID_PARAM", message: "sequence_apply_op: ops[1] addKeey: 知らない op: addKeey(有効: SetName, AddKey, AddTrack, AddBinding)" },
    { op: "edit", name: "Intro", ops: [{ op: "addMarker" }, { op: "addKeey", trackId: "t" }] });
  check("edit の『知らない op』→ E_BAD_ENUM + didYouMean(AddKey)+ ops[1].op だけ直した撃ち直し", ed.code === "E_BAD_ENUM" && ed.didYouMean?.[0] === "AddKey" && (ed.fix?.[0]?.args?.ops as any)?.[1]?.op === "AddKey" && (ed.fix?.[0]?.args?.ops as any)?.[0]?.op === "addMarker" && (ed.validValues ?? []).includes("AddTrack"), ed);
  const ed2 = enrichEditError({ code: "E_INVALID_PARAM", message: "sequence_apply_op: ops[0] addKey: key: 値が無い" }, { op: "edit", name: "Intro", ops: [{ op: "addKey" }] });
  check("edit のそれ以外の失敗 → 何も変更していないと伝え、構成を見る get を最初の fix にする", /変更されていない|変更していない/.test(ed2.cause ?? "") && ed2.fix?.[0]?.args?.op === "get", ed2);
  const rw = rewriteSequenceFixes([{ tool: "sequence_load", args: { name: "X", create: true }, why: "w" }, { tool: "sequence_autoplay", args: { op: "add", sequence: "X" } }, { tool: "dx12_stop", args: {} }, { tool: "dx12_sequence_author", args: {} }]);
  check("fix のエンジン method 名を dx12_sequence {op} へ書き直す(autoplay の下位 op は action)/ 他は触らない", rw?.[0].tool === "dx12_sequence" && eq(rw[0].args, { op: "load", name: "X", create: true }) && eq(rw[1].args, { op: "autoplay", action: "add", sequence: "X" }) && rw[2].tool === "dx12_stop" && rw[3].tool === "dx12_sequence_author");
  const old = finishSequenceError({ code: "E_UNKNOWN_TOOL", message: "unknown method: sequence_list", didYouMean: ["ping"], fix: [] }, "list", { op: "list" });
  check("エンジンが method を持たない → E_ENGINE_TOO_OLD(打ち間違いの案内ではなく更新の案内)", old.code === "E_ENGINE_TOO_OLD" && !old.didYouMean && old.fix?.[0]?.tool === "dx12_doctor", old);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] Core 面のサイズ・説明文の lint・旧ツールの不変");
const desc = CORE_DESCRIPTIONS["dx12_sequence"];
{
  check(`説明文は ${CORE_DESCRIPTION_MAX} 字以内(${desc.length} 字)`, desc.length <= CORE_DESCRIPTION_MAX, desc.length);
  check("説明文はテンプレ(使う / 使わない / 副作用 / 注意 / 次)と日本語・標準語", /使う/.test(desc) && /使わない/.test(desc) && /副作用/.test(desc) && /注意/.test(desc) && /次/.test(desc) && /[぀-ヿ一-鿿]/.test(desc) && !DIALECT_PATTERN.test(desc));
  check("説明文は .dxseq・カメラワーク・カット・イベント・非破壊・scrub の戻り方を言う", /\.dxseq/.test(desc) && /カメラワーク/.test(desc) && /カット/.test(desc) && /イベント/.test(desc) && /scrub/.test(desc) && /元へ戻る/.test(desc));
  check("説明文は全 op と旧方式(dx12_sequence_author)への案内を含む", SEQUENCE_OPS.every((o) => desc.includes(o)) && /dx12_sequence_author/.test(desc));
  check("先頭 1 行(要点)が 260 字以内", desc.split("\n")[0].length <= 260, desc.split("\n")[0].length);
  check("Core の並びに dx12_sequence が 1 つだけあり、dx12_get_script_errors は Core から外れている(長尾へ)", CORE_ORDER.filter((n) => n === "dx12_sequence").length === 1 && !CORE_ORDER.includes("dx12_get_script_errors"));
  check("Core は shell 5 本 + 35 本 = 40 本ちょうど(上限を超えない)", 5 + CORE_ORDER.length === 40, 5 + CORE_ORDER.length);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] stdio 一巡(core 面 + 偽エンジン)");

const P = (name: string, type: string, required = false, extra: Record<string, unknown> = {}) => ({ name, type, required, ...extra });
const seqMethod = (name: string, effect: MockMethod["effect"], params: MockMethod["params"], handler: MockMethod["handler"], extra: Record<string, unknown> = {}): MockMethod =>
  ({ name, category: "sequence", summary: `mock ${name}`, keywords: "sequence シーケンス", effect, mode: "any", timeoutMs: 8000, params, source: "meta", handler, ...extra } as MockMethod);

const KNOWN = ["Intro", "Outro"];
function notFound(name: string): never {
  const e: any = new Error(`sequence '${name}' not found: no such file`);
  e.code = 1;
  e.fields = { error_name: "E_NOT_FOUND", error_did_you_mean: KNOWN.filter((k) => k.toLowerCase().startsWith(name.toLowerCase().slice(0, 3))), error_cause: "このシーケンスは assets/sequences/ にも開いている文書にも無い" };
  throw e;
}
const needKnown = (p: any) => { if (!KNOWN.includes(p.name)) notFound(String(p.name)); };

const engineMethods: MockMethod[] = [
  seqMethod("sequence_list", "read", [], () => ({ sequences: [{ name: "Intro", loaded: true }, { name: "Outro", loaded: false }], editor: { active: false }, players: [] })),
  seqMethod("sequence_load", "runtime", [P("name", "string", true), P("create", "bool"), P("fps", "int"), P("reload", "bool")], (p) => { if (!p.create) needKnown(p); return { name: p.name, created: !!p.create }; }),
  seqMethod("sequence_save", "write_file", [P("name", "string", true), P("path", "string")], (p) => { needKnown(p); return { saved: true, name: p.name }; }, { dryRun: "preview" }),
  seqMethod("sequence_get", "read", [P("name", "string", true), P("detail", "enum", false, { enum: ["summary", "full"] })], (p) => { needKnown(p); return { name: p.name, bindings: 1 }; }),
  seqMethod("sequence_eval", "read", [P("name", "string", true), P("t", "number"), P("tick", "int"), P("frame", "int")], (p) => { needKnown(p); return { name: p.name, echo: p, nonDestructive: true }; }),
  seqMethod("sequence_scrub", "runtime", [P("name", "string"), P("t", "number"), P("tick", "int"), P("frame", "int"), P("end", "bool")], (p, ctx) => {
    if (ctx.state.mode === "Playing") { const e: any = new Error("sequence_scrub works in Editor mode only"); e.code = 3; e.fields = { error_name: "E_WRONG_MODE", error_hint: "dx12_stop で Editor に戻してから。Play 中に流すなら sequence_play" }; throw e; }
    if (!p.end) needKnown(p);
    return { scrubbed: !p.end, ended: !!p.end };
  }, { mode: "editor", dryRun: "preview" }),
  seqMethod("sequence_play", "runtime", [P("name", "string", true), P("loop", "enum", false, { enum: ["once", "loop", "pingpong"] }), P("rate", "number"), P("from", "number")], (p) => { needKnown(p); return { mode: "Editor", preview: true, params: p }; }, { dryRun: "preview" }),
  seqMethod("sequence_stop", "runtime", [P("name", "string"), P("restore", "bool")], () => ({ mode: "Editor", stopped: true })),
  seqMethod("sequence_apply_op", "write_file", [P("name", "string", true), P("ops", "array"), P("label", "string"), P("undo", "bool"), P("redo", "bool")], (p) => {
    needKnown(p);
    const bad = (p.ops ?? []).findIndex((o: any) => o.op === "addKeey");
    if (bad >= 0) { const e: any = new Error(`sequence_apply_op: ops[${bad}] addKeey: 知らない op: addKeey(有効: SetName, AddKey, AddTrack, AddBinding)`); e.code = 2; e.fields = { error_name: "E_INVALID_OP", error_hint: "エラー文の位置(ops[i])を直して撃ち直す" }; throw e; }
    return { applied: (p.ops ?? []).length, undo: !!p.undo };
  }, { dryRun: "preview" }),
  { name: "get_script_errors", category: "diag", summary: "mock", keywords: "script errors", effect: "read", mode: "any", timeoutMs: 8000, params: [], source: "meta", handler: () => ({ count: 0, errors: [] }) } as MockMethod,
  seqMethod("sequence_autoplay", "write_scene", [P("op", "enum", false, { enum: ["list", "set", "add", "remove", "clear"] }), P("sequence", "string"), P("loop", "bool"), P("rate", "number"), P("startDelay", "number"), P("clock", "enum", false, { enum: ["real", "game"] }), P("players", "array")], (p) => ({ players: [], echo: p }), { mode: "editor" }),
];

const mock = await startMockEngine({
  methods: engineMethods, safety: true,
  previewMethods: new Set(["sequence_save", "sequence_scrub", "sequence_play", "sequence_apply_op"]),
});
const core = startMcp({ DX12_MCP_PORT: String(mock.port), DX12_MCP_SURFACE: "core" });
const full = startMcp({ DX12_MCP_PORT: String(mock.port), DX12_MCP_SURFACE: "full" });
const last = () => mock.received[mock.received.length - 1];
const since = (n: number) => mock.received.slice(n).filter((r) => r.method.startsWith("sequence_"));
const lastBlock = (r: any) => JSON.parse(r.content[r.content.length - 1].text);

try {
  await core.initialize();
  await full.initialize();

  console.log("[3a] tools/list");
  const tools = (await core.rpc("tools/list")).result.tools as any[];
  const st = tools.find((t) => t.name === "dx12_sequence");
  check("core 面の tools/list は 40 本ちょうどで dx12_sequence を含む", tools.length === 40 && !!st, tools.length);
  check("tools/list の dx12_sequence の説明は CORE_DESCRIPTIONS と一致し 600 字以内", st?.description === desc && st.description.length <= 600);
  check("inputSchema: op は必須の enum(10 個)/ 全 op の引数キーが並ぶ / oneOf・anyOf・allOf がルートに無い", eq(st?.inputSchema?.required, ["op"]) && eq(st?.inputSchema?.properties?.op?.enum, [...SEQUENCE_OPS]) && eq(Object.keys(st?.inputSchema?.properties ?? {}).sort(), [...SEQUENCE_ALL_KEYS].sort()) && !st.inputSchema.oneOf && !st.inputSchema.anyOf && !st.inputSchema.allOf, Object.keys(st?.inputSchema?.properties ?? {}));
  check("annotations: readOnlyHint:false・destructiveHint:false(list / get / eval があるが save / edit も含むので読み取り専用ではない)", st?.annotations?.readOnlyHint === false && st.annotations.destructiveHint === false, st?.annotations);
  check("Core の並びは CORE_ORDER どおり(dx12_sequence は dx12_stop の次。dx12_play_script は M7 で長尾へ)", JSON.stringify(tools.slice(5).map((t) => t.name)) === JSON.stringify(CORE_ORDER) && tools.map((t) => t.name).indexOf("dx12_sequence") === tools.map((t) => t.name).indexOf("dx12_stop") + 1);
  check("dx12_get_script_errors は tools/list から消えた(長尾)", !tools.some((t) => t.name === "dx12_get_script_errors"));
  const fullTools = (await full.rpc("tools/list")).result.tools as any[];
  check("full 面の tools/list には出ない(旧 220 本の並びを変えない)", !fullTools.some((t) => t.name === "dx12_sequence"));

  console.log("[3b] op の振り分け(エンジンの method へ引数をそのまま渡す)");
  const cases: { args: Record<string, unknown>; method: string; expect: (p: any) => boolean; result?: (r: any) => boolean }[] = [
    { args: { op: "list" }, method: "sequence_list", expect: (p) => Object.keys(p).length === 0, result: (r) => r.sequences?.length === 2 },
    { args: { op: "load", name: "Intro" }, method: "sequence_load", expect: (p) => p.name === "Intro" && !("op" in p) },
    { args: { op: "load", name: "New", create: true, fps: 24 }, method: "sequence_load", expect: (p) => p.create === true && p.fps === 24, result: (r) => r.created === true },
    { args: { op: "save", name: "Intro", path: "Intro2" }, method: "sequence_save", expect: (p) => p.name === "Intro" && p.path === "Intro2" },
    { args: { op: "get", name: "Intro", detail: "full" }, method: "sequence_get", expect: (p) => p.detail === "full" },
    { args: { op: "eval", name: "Intro", t: 2.5 }, method: "sequence_eval", expect: (p) => p.t === 2.5, result: (r) => r.nonDestructive === true },
    { args: { op: "eval", name: "Intro", frame: 30 }, method: "sequence_eval", expect: (p) => p.frame === 30 && !("t" in p) },
    { args: { op: "scrub", name: "Intro", t: 1 }, method: "sequence_scrub", expect: (p) => p.name === "Intro" && p.t === 1 },
    { args: { op: "scrub", end: true }, method: "sequence_scrub", expect: (p) => p.end === true && !("name" in p), result: (r) => r.ended === true },
    { args: { op: "play", name: "Intro", loop: "pingpong", rate: 0.5, from: 1 }, method: "sequence_play", expect: (p) => p.loop === "pingpong" && p.rate === 0.5 && p.from === 1 },
    { args: { op: "stop" }, method: "sequence_stop", expect: (p) => Object.keys(p).length === 0 },
    { args: { op: "edit", name: "Intro", ops: [{ op: "addMarker", tSec: 1, name: "m" }], label: "マーカー" }, method: "sequence_apply_op", expect: (p) => p.ops.length === 1 && p.label === "マーカー" && !("op" in p), result: (r) => r.applied === 1 },
    { args: { op: "edit", name: "Intro", undo: true }, method: "sequence_apply_op", expect: (p) => p.undo === true && !("ops" in p) },
    { args: { op: "autoplay", action: "add", sequence: "Intro", loop: true, rate: 2, startDelay: 1, clock: "game" }, method: "sequence_autoplay", expect: (p) => p.op === "add" && p.sequence === "Intro" && p.loop === true && p.clock === "game" && !("action" in p) },
    { args: { op: "autoplay" }, method: "sequence_autoplay", expect: (p) => Object.keys(p).length === 0 },
  ];
  for (const c of cases) {
    const n = mock.received.length;
    const r = await core.call("dx12_sequence", c.args);
    const sent = since(n);
    check(`dx12_sequence ${JSON.stringify(c.args).slice(0, 70)} → ${c.method}`, sent.length === 1 && sent[0].method === c.method && c.expect(sent[0].params) && (!c.result || c.result(r)) && r.error_code === undefined, { sent, r });
  }
  {
    const n = mock.received.length;
    const r = await core.call("dx12_sequence", { op: "autoplay", action: "set", players: [{ sequence: "Intro", loop: true }] });
    check("autoplay {action:'set', players} → players をそのまま渡す", since(n)[0]?.params.op === "set" && since(n)[0].params.players?.[0]?.sequence === "Intro" && r.echo?.op === "set", r);
  }

  console.log("[3c] 検査(エンジンへ撃つ前に断る)");
  {
    const n = mock.received.length;
    const r1 = await core.raw("dx12_sequence", {});
    const b1 = lastBlock(r1);
    check("op 無し(SDK の必須検査)→ isError・E_MISSING_PARAM・fix は dx12_tool_describe {dx12_sequence}", r1.isError === true && b1.error_code === "E_MISSING_PARAM" && b1.fix?.[0]?.tool === "dx12_tool_describe" && b1.fix[0].args?.name === "dx12_sequence", b1);
    const r2 = await core.raw("dx12_sequence", { op: "evl", name: "Intro" });
    const b2 = lastBlock(r2);
    check("op の打ち間違い(SDK の enum 検査)→ E_BAD_ENUM + didYouMean eval + fix は dx12_sequence", r2.isError === true && b2.error_code === "E_BAD_ENUM" && b2.didYouMean?.[0] === "eval" && b2.fix?.[0]?.tool === "dx12_sequence" && b2.fix[0].args.op === "eval", b2);
    const r3 = await core.raw("dx12_sequence", { op: "eval" });
    const b3 = JSON.parse(r3.content[0].text);
    check("name 無し(直接呼び)→ 1 ブロックの封筒(cause / fix)・エンジンには撃たない", r3.isError === true && r3.content.length === 1 && b3.error_code === "E_MISSING_PARAM" && !!(b3.cause || b3.fix?.length) && since(n).length === 0, b3);
    const b4 = await core.call("dx12_sequence", { op: "eval", name: "Intro", tik: 2 });
    check("未知キー tik → E_UNKNOWN_PARAM + didYouMean tick + fix[0] は tick に直した呼び出し", b4.error_code === "E_UNKNOWN_PARAM" && b4.didYouMean?.[0] === "tick" && b4.fix?.[0]?.args?.tick === 2 && since(n).length === 0, b4);
    const b5 = await core.call("dx12_sequence", { op: "get", name: "Intro", ops: [] });
    check("別の op の引数 → どの op か言う", b5.error_code === "E_UNKNOWN_PARAM" && /edit/.test(b5.cause) && since(n).length === 0, b5);
  }

  console.log("[3d] エンジンのエラーの整形(cause / fix / didYouMean)");
  {
    const nf = await core.call("dx12_sequence", { op: "get", name: "Intr" });
    check("名前が引けない → E_NOT_FOUND(エンティティではない)+ didYouMean[0]='Intro' + fix[0] は name を直した dx12_sequence 呼び出し", nf.error_code === "E_NOT_FOUND" && nf.didYouMean?.[0] === "Intro" && nf.fix?.[0]?.tool === "dx12_sequence" && eq(nf.fix[0].args, { op: "get", name: "Intro" }) && !!nf.cause, nf);
    check("fix に『新しく作る(load create:true)』と『一覧(list)』がある", nf.fix?.some((f: any) => f.args?.op === "load" && f.args.create === true) && nf.fix?.some((f: any) => f.args?.op === "list"), nf.fix);
    const fixed = await core.call("dx12_sequence", nf.fix[0].args);
    check("その fix をそのまま撃つと通る", fixed.error_code === undefined && fixed.bindings === 1, fixed);
    const ld = await core.call("dx12_sequence", { op: "load", name: "Zzz" });
    check("load の失敗は『create:true で作る』を fix に持つ", ld.error_code === "E_NOT_FOUND" && ld.fix?.some((f: any) => f.args?.op === "load" && f.args.create === true), ld);
    const nfS = await core.call("dx12_sequence", { op: "save", name: "Zzz" });
    check("save で未読の名前 → E_NOT_FOUND(未読なら load を先に撃つ fix つき or 近い名前)", nfS.error_code === "E_NOT_FOUND" && nfS.fix?.length > 0, nfS);

    mock.state.mode = "Playing";
    const wm = await core.call("dx12_sequence", { op: "scrub", name: "Intro", t: 1 });
    check("scrub を Play 中に撃つ → E_MODE_CONFLICT + fix に dx12_stop(thenRetry)と op:'play'", wm.error_code === "E_MODE_CONFLICT" && wm.fix?.some((f: any) => f.tool === "dx12_stop" && f.thenRetry === true) && wm.fix?.some((f: any) => f.tool === "dx12_sequence" && f.args?.op === "play"), wm);
    mock.state.mode = "Editor";

    const bo = await core.call("dx12_sequence", { op: "edit", name: "Intro", ops: [{ op: "addMarker" }, { op: "addKeey", trackId: "t" }] });
    check("edit の『知らない op』→ E_BAD_ENUM + didYouMean AddKey + ops[1].op を直した fix", bo.error_code === "E_BAD_ENUM" && bo.didYouMean?.[0] === "AddKey" && bo.fix?.[0]?.args?.ops?.[1]?.op === "AddKey" && bo.validValues?.includes("AddTrack"), bo);
    const fixedEdit = await core.call("dx12_sequence", bo.fix[0].args);
    check("その fix をそのまま撃つと通る(何も適用されていなかった)", fixedEdit.applied === 2, fixedEdit);
  }

  console.log("[3e] dryRun");
  {
    const dr = (n: number) => since(n);
    let n = mock.received.length;
    const saveExec0 = mock.state.exec["sequence_save"] ?? 0;
    const s1 = await core.call("dx12_sequence", { op: "save", name: "Intro", dryRun: true });
    check("save {dryRun:true} → エンジンのプレビュー(sequence_save に dryRun:true)・実行しない(実行の数は増えない)", dr(n).length === 1 && dr(n)[0].params.dryRun === true && s1.dryRun === true && s1.executed === false && !!s1.preview && s1.method === "sequence_save" && (mock.state.exec["sequence_save"] ?? 0) === saveExec0, { s1, sent: dr(n) });
    const execBefore = { ...mock.state.exec };
    n = mock.received.length;
    for (const a of [{ op: "edit", name: "Intro", ops: [{ op: "addMarker" }] }, { op: "scrub", name: "Intro", t: 1 }, { op: "play", name: "Intro" }, { op: "save", name: "Intro" }]) {
      const r = await core.call("dx12_sequence", { ...a, dryRun: true });
      check(`${a.op} {dryRun:true} → プレビューが返り、実行の数は増えない`, r.dryRun === true && r.executed === false && !!r.preview && eq(mock.state.exec, execBefore), r);
    }
    check("edit / scrub / play / save の 4 回とも、エンジンへ渡した引数に dryRun:true が入っている", dr(n).length === 4 && dr(n).every((x) => x.params.dryRun === true), dr(n));
    n = mock.received.length;
    for (const a of [{ op: "load", name: "Intro" }, { op: "stop" }, { op: "autoplay", action: "add", sequence: "Intro" }, { op: "scrub", end: true }, { op: "edit", name: "Intro", undo: true }]) {
      const r = await core.call("dx12_sequence", { ...a, dryRun: true });
      check(`${a.op}${(a as any).action ? "/" + (a as any).action : ""} {dryRun:true} → 静的な予測(実行しない・エンジンへ撃たない)`, r.dryRun === true && r.executed === false && r.preview?.supported?.startsWith("static") && typeof r.preview.wouldDo === "string", r);
    }
    check("静的な dryRun はエンジンの sequence_* を 1 回も呼んでいない", dr(n).length === 0, dr(n));
    n = mock.received.length;
    const rd = await core.call("dx12_sequence", { op: "eval", name: "Intro", t: 1, dryRun: true });
    check("eval {dryRun:true} は読み取りなので実行する(dryRunNote で正直に言う)・dryRun はエンジンへ渡さない", rd.nonDestructive === true && /実行した/.test(rd.dryRunNote) && dr(n).length === 1 && !("dryRun" in dr(n)[0].params), { rd, sent: dr(n) });
    const execBeforeCall = { ...mock.state.exec };
    const viaCall = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "edit", name: "Intro", ops: [{ op: "addMarker" }] }, dryRun: true });
    check("dx12_call {dryRun:true} 経由(native dryRun の作法)→ executed:false・dryRunMode:native・エンジンのプレビュー・実行の数は増えない", viaCall.ok === true && viaCall.dryRunMode === "native" && viaCall.executed === false && viaCall.result?.dryRun === true && !!viaCall.result?.preview && eq(mock.state.exec, execBeforeCall), viaCall);
  }

  console.log("[3f] dx12_call 経由・catalog");
  {
    const c1 = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "list" } });
    check("dx12_call {dx12_sequence, op:list} が通り、meta.effect は op の値(read)・meta.op / engineMethod が入る", c1.ok === true && c1.meta?.effect === "read" && c1.meta.op === "list" && c1.meta.engineMethod === "sequence_list" && c1.meta.tool === "dx12_sequence", c1.meta);
    const c2 = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "edit", name: "Intro", ops: [{ op: "addMarker" }] } });
    const c3 = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "autoplay", action: "list" } });
    const c4 = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "scrub", end: true } });
    check("meta.effect: edit = write_file / autoplay = write_scene / scrub = runtime", c2.meta?.effect === "write_file" && c3.meta?.effect === "write_scene" && c4.meta?.effect === "runtime", [c2.meta, c3.meta, c4.meta]);
    const ce = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "get", name: "Intr" } });
    check("dx12_call 経由のエラーも同じ封筒(組み直されない)", ce.ok === false && ce.error_code === "E_NOT_FOUND" && ce.didYouMean?.[0] === "Intro" && ce.fix?.[0]?.tool === "dx12_sequence", ce);
    const ck = await core.call("dx12_call", { name: "dx12_sequence", args: { op: "eval", name: "Intro", tik: 1 } });
    check("dx12_call 経由の未知キー → E_UNKNOWN_PARAM(zod の検査 or 自前の検査。どちらでも tick を提案)", ck.ok === false && ck.error_code === "E_UNKNOWN_PARAM" && (ck.didYouMean?.[0] === "tick" || ck.fix?.some((f: any) => JSON.stringify(f.args).includes("tick"))), ck);
    const eng = await core.call("dx12_call", { name: "sequence_list", args: {} });
    check("エンジン method 名(sequence_list)を dx12_call で直接呼んでも動く(McpMeta 直渡しの経路)", eng.ok === true && eng.result?.sequences?.length === 2, eng);
    const legacy = await core.call("dx12_call", { name: "dx12_get_script_errors", args: {} });
    check("長尾へ移した dx12_get_script_errors は dx12_call で旧名のまま動く", legacy.ok === true && legacy.meta?.tool === "dx12_get_script_errors", legacy);

    const d = await core.call("dx12_tool_describe", { name: "dx12_sequence" });
    check("dx12_tool_describe: tier=core・effect(代表)=write_scene・ops 表(10 個。method / effect / required)・examples", d.tier === "core" && d.core === true && d.effect === "write_scene" && d.category === "sequence" && Object.keys(d.ops ?? {}).length === 10 && d.ops.edit.method === "sequence_apply_op" && d.ops.eval.effect === "read" && d.ops.autoplay.effect === "write_scene" && d.examples?.length >= 5, { tier: d.tier, effect: d.effect, category: d.category, ops: Object.keys(d.ops ?? {}) });
    const dEdit = await core.call("dx12_tool_describe", { name: "dx12_sequence", target: "edit" });
    check("dx12_tool_describe {target:'edit'} → edit の引数だけ(name は必須)・routedTo sequence_apply_op・effect write_file・callTemplate は op:'edit'", dEdit.routedTo === "sequence_apply_op" && dEdit.effect === "write_file" && dEdit.callTemplate?.args?.op === "edit" && dEdit.callTemplate.args.name !== undefined
      && dEdit.params.some((p: any) => p.name === "ops") && !dEdit.params.some((p: any) => p.name === "t") && dEdit.params.find((p: any) => p.name === "name")?.required === true, dEdit);
    const dAuto = await core.call("dx12_tool_describe", { name: "dx12_sequence", target: "autoplay" });
    check("dx12_tool_describe {target:'autoplay'} → action / players を含み、dryRun も出る", dAuto.params.some((p: any) => p.name === "action") && dAuto.params.some((p: any) => p.name === "players") && dAuto.params.some((p: any) => p.name === "dryRun"), dAuto.params?.map((p: any) => p.name));
    const dList = await core.call("dx12_tool_describe", { name: "dx12_sequence", target: "list" });
    check("dx12_tool_describe {target:'list'} → op だけ(読み取りなので dryRun も出さない)", eq(dList.params.map((p: any) => p.name), ["op"]), dList.params);
    const legacyDesc = await core.call("dx12_tool_describe", { name: "dx12_sequence_author" });
    check("旧 dx12_sequence_author は旧ツールのまま(tier=legacy・引数 name / tracks / camera / loop …)", legacyDesc.tier === "legacy" && legacyDesc.params.some((p: any) => p.name === "tracks") && legacyDesc.params.some((p: any) => p.name === "attachTo"), legacyDesc.tier);
    const snap = JSON.parse(fs.readFileSync(path.join(here, "legacy-tools.snapshot.json"), "utf8"));
    const argDiff: string[] = [];
    for (const n of ["dx12_sequence_author", "dx12_sequence_preview", "dx12_camera_path"]) {
      const dd = await core.call("dx12_tool_describe", { name: n });
      if (!eq(dd.params.map((p: any) => p.name), snap.tools.find((t: any) => t.name === n).argKeys)) argDiff.push(n);
    }
    check("旧 3 本(dx12_sequence_author / dx12_sequence_preview / dx12_camera_path)の引数名は M0 のスナップショットと同一", argDiff.length === 0, argDiff);
  }

  console.log("[3g] 検索");
  {
    const top = async (q: string, extra: Record<string, unknown> = {}) => (await core.call("dx12_tool_search", { query: q, limit: 3, ...extra })).hits.map((h: any) => h.name) as string[];
    const queries = ["シーケンスを編集したい", "タイムラインにキーフレームを打つ", "カットシーンを作る", "カメラワークを付ける", "sequence timeline editing", "cutscene keyframes", "sequencer dxseq scrub"];
    const miss: string[] = [];
    for (const q of queries) { const t = await top(q); if (!t.includes("dx12_sequence")) miss.push(`${q} → ${t.join(",")}`); }
    check("シーケンス / タイムライン / カットシーン / キーフレーム / カメラワーク / sequence / timeline / cutscene の検索で dx12_sequence が上位 3 件に入る", miss.length === 0, miss);
    const core1 = await core.call("dx12_tool_search", { query: "シーケンス タイムライン", tier: "core" });
    check("tier:'core' の検索で dx12_sequence が先頭(Core として返る)・category=sequence・effect・example が付く", core1.hits[0]?.name === "dx12_sequence" && core1.hits[0].tier === "core" && core1.hits[0].category === "sequence" && core1.hits[0].example?.args?.op === "list", core1.hits?.[0]);
    const oldTop = await top("台本から Lua を生成する演出");
    check("『台本から Lua』は従来どおり旧 dx12_sequence_author が先頭(旧方式の検索を奪わない)", oldTop[0] === "dx12_sequence_author", oldTop);
    const cat = await core.call("dx12_tool_search", { query: "sequence", category: "sequence", limit: 20 });
    check("category:'sequence' で dx12_sequence とエンジンの sequence_* が並ぶ", cat.hits.some((h: any) => h.name === "dx12_sequence") && cat.hits.some((h: any) => h.name === "sequence_apply_op"), cat.hits?.map((h: any) => h.name));
  }

  console.log("[3h] 古いエンジン(sequence_* を持たない)");
  {
    mock.removeMethod("sequence_list");
    mock.dropConnections();
    await new Promise((r) => setTimeout(r, 100));
    const old = await core.call("dx12_sequence", { op: "list" });
    check("エンジンに sequence_list が無い → E_ENGINE_TOO_OLD(dx12_doctor と更新の案内)", old.error_code === "E_ENGINE_TOO_OLD" && old.fix?.[0]?.tool === "dx12_doctor" && !old.didYouMean, old);
  }
} finally {
  core.close(); full.close();
  await mock.close();
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: dx12_sequence テスト ${total} 項目すべて通過`);
process.exit(0);
