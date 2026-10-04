// dx12_sequence(Core ツール)の純ロジック: op の振り分け・op ごとの引数検査・dryRun の扱い・エラーの整形。
// MCP にもエンジンにも依存しない(単体テストは sequenceCore.test.ts。登録は toolset/sequenceCore.ts)。
//
//   dx12_sequence {op, …}  →  エンジンの method sequence_<op>(edit だけ sequence_apply_op)へ、引数をそのまま渡す。
//   .dxseq(時間軸の演出: カメラワーク・カット・イベント)の編集・評価・再生。エンジン側は src/core/mcp/ApplicationMcpSequence.cpp。
//
// ★旧ツール dx12_sequence_author / dx12_sequence_preview(台本 JSON → Lua を生成する旧方式)とは別物。旧ツールは名前・引数・返り値を変えない。
//   新しい .dxseq 形式は dx12_sequence を使う。
//
// ★autoplay の下位操作(list|set|add|remove|clear)は、統合の都合で引数名を `action` にしている(dx12_sequence の op と衝突するため)。
//   エンジンへは `op` として渡す。

import { nearest, type ErrorBody, type Fix } from "./errors.ts";
import type { EffectName } from "./manifest.ts";

export const SEQUENCE_TOOL = "dx12_sequence";

export const SEQUENCE_OPS = ["list", "load", "save", "get", "eval", "scrub", "play", "stop", "edit", "autoplay"] as const;
export type SequenceOp = (typeof SEQUENCE_OPS)[number];

/** dryRun:true の扱い。engine = エンジンのプレビュー表(dryRun:"preview")へ渡す / static = 実行せず TS が影響を返す / read = 読み取りなので dryRun を無視して実行する。 */
export type DryRunKind = "engine" | "static" | "read";

export type OpSpec = {
  /** 呼ぶエンジン method。 */
  method: string;
  /** 副作用の分類(catalog の effect)。 */
  effect: EffectName;
  /** 必須の引数(scrub の name と edit の ops は条件つき。requiredUnless 参照)。 */
  required: string[];
  optional: string[];
  dryRun: DryRunKind;
  timeoutMs: number;
  summary: string;
};

/** 引数の一覧(型は zod 側 toolset/sequenceCore.ts が持つ。ここは「どの op がどのキーを受けるか」の表)。 */
export const SEQUENCE_OP_SPECS: Record<SequenceOp, OpSpec> = {
  list: { method: "sequence_list", effect: "read", required: [], optional: [], dryRun: "read", timeoutMs: 8000, summary: "assets/sequences/ のファイルと開いている文書の一覧(スクラブ状態・Play 中の再生も)" },
  load: { method: "sequence_load", effect: "runtime", required: ["name"], optional: ["create", "fps", "reload"], dryRun: "static", timeoutMs: 10000, summary: "シーケンスをメモリへ読む(create:true で無ければ空の文書を作る)。バインディングの解決状況を返す" },
  save: { method: "sequence_save", effect: "write_file", required: ["name"], optional: ["path"], dryRun: "engine", timeoutMs: 10000, summary: "assets/sequences/<name>.dxseq へ保存する(path で別名保存)" },
  get: { method: "sequence_get", effect: "read", required: ["name"], optional: ["detail"], dryRun: "read", timeoutMs: 10000, summary: "中身の要約(バインディング・トラック・カット・マーカーと解決状況)。detail:'full' で全文" },
  eval: { method: "sequence_eval", effect: "read", required: ["name"], optional: ["t", "tick", "frame"], dryRun: "read", timeoutMs: 10000, summary: "【非破壊】時刻 t の値・カット・有効クリップを返す(何も書かない)" },
  scrub: { method: "sequence_scrub", effect: "runtime", required: [], optional: ["name", "t", "tick", "frame", "end"], dryRun: "engine", timeoutMs: 10000, summary: "エディタ上で時刻 t に適用する(保存・Play・end:true で自動的に元へ戻る)。Editor 限定" },
  play: { method: "sequence_play", effect: "runtime", required: ["name"], optional: ["loop", "rate", "from", "clock", "restoreOnEnd", "delay"], dryRun: "engine", timeoutMs: 10000, summary: "再生する(Play 中 = 実時間で流す・イベント発火 / Editor 中 = プレビュー再生)" },
  stop: { method: "sequence_stop", effect: "runtime", required: [], optional: ["name", "restore"], dryRun: "static", timeoutMs: 8000, summary: "再生を止める(Editor のプレビューは元の値へ戻す)" },
  edit: { method: "sequence_apply_op", effect: "write_file", required: ["name"], optional: ["ops", "label", "undo", "redo"], dryRun: "engine", timeoutMs: 15000, summary: "SeqOp の JSON 配列で宣言的に編集する(1 回 = Undo 1 ステップ)。undo / redo も" },
  autoplay: { method: "sequence_autoplay", effect: "write_scene", required: [], optional: ["action", "sequence", "loop", "rate", "startDelay", "clock", "players"], dryRun: "static", timeoutMs: 8000, summary: "シーンの自動再生設定(Play 開始時に流すシーケンス)。action: list / set / add / remove / clear" },
};

/** op → 効果分類(catalog の effect)。 */
export const SEQUENCE_OP_EFFECT: Record<SequenceOp, EffectName> = Object.fromEntries(SEQUENCE_OPS.map((o) => [o, SEQUENCE_OP_SPECS[o].effect])) as Record<SequenceOp, EffectName>;
/** エンジン method → op(エラーの fix を dx12_sequence の呼び方へ書き直すのに使う)。 */
export const SEQUENCE_METHOD_TO_OP: Record<string, SequenceOp> = Object.fromEntries(SEQUENCE_OPS.map((o) => [SEQUENCE_OP_SPECS[o].method, o]));

/** dx12_sequence 全体の代表の副作用(catalog / tool_describe / dx12_call の meta に使う)。op ごとの正確な値は SEQUENCE_OP_EFFECT。 */
export const SEQUENCE_TOOL_EFFECT: EffectName = "write_scene";

/** 全 op が受ける引数キーの和集合(zod の shape のキーと一致させる。sequenceCore.test.ts が突き合わせる)。 */
export const SEQUENCE_ALL_KEYS: string[] = [...new Set(["op", "dryRun", ...SEQUENCE_OPS.flatMap((o) => [...SEQUENCE_OP_SPECS[o].required, ...SEQUENCE_OP_SPECS[o].optional])])];

/** どの method でもエンジンが読む共通キー(paramGuard.ts の GLOBAL_PARAM_KEYS と同じ)。そのままエンジンへ渡す。 */
const GLOBAL_KEYS = ["idempotency_key", "expectGeneration"];
const CLOCKS = ["real", "game"];
const DETAILS = ["summary", "full"];
const AUTOPLAY_ACTIONS = ["list", "set", "add", "remove", "clear"];
const PLAY_LOOPS = ["once", "loop", "pingpong"];

/** 別名(打ち間違いではなく「別の言い方」)。近い綴りの提案より先に効かせる。 */
const OP_ALIASES: Record<string, SequenceOp> = {
  apply_op: "edit", applyop: "edit", apply: "edit", modify: "edit", update: "edit",
  evaluate: "eval", sample: "eval", seek: "scrub", open: "load", pause: "stop",
};

export function normalizeOp(raw: unknown): SequenceOp | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  s = s.replace(/^dx12_/, "").replace(/^sequence_/, "");
  if ((SEQUENCE_OPS as readonly string[]).includes(s)) return s as SequenceOp;
  return OP_ALIASES[s] ?? null;
}

// ── 計画(検証 + 引数の写像) ───────────────────────────────────────────────────

export type SequencePlan =
  | {
      ok: true; op: SequenceOp; spec: OpSpec; method: string; params: Record<string, unknown>;
      /** dryRun:true が指定されたか。 */
      dryRun: boolean;
      /** dryRun のとき: none = dryRun 指定なし / engine = エンジンのプレビューへ(params に dryRun:true が入る)/ static = 実行しない(TS が影響を返す)/ read-ignored = 読み取りなので実行した。 */
      dryRunMode: "none" | "engine" | "static" | "read-ignored";
      /** この呼び出しの実際の副作用(dryRun のときは "read" 相当にはしない。予定される効果)。 */
      effect: EffectName;
    }
  | { ok: false; body: ErrorBody };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isPresent = (v: unknown) => v !== undefined && v !== null;

function describeFix(op?: string): Fix {
  return { tool: "dx12_tool_describe", args: op ? { name: SEQUENCE_TOOL, target: op } : { name: SEQUENCE_TOOL }, why: op ? `op:'${op}' の引数を確認する` : "op の一覧と引数を確認する" };
}

const listFix = (why = "存在するシーケンス名を確認する"): Fix => ({ tool: SEQUENCE_TOOL, args: { op: "list" }, why });

function fail(body: ErrorBody): { ok: false; body: ErrorBody } { return { ok: false, body }; }

/** enum の検査。外れていたら E_BAD_ENUM(近い値つき)。 */
function enumProblem(op: SequenceOp, args: Record<string, unknown>, key: string, values: string[], value: unknown = args[key]): ErrorBody | null {
  if (typeof value === "string" && values.includes(value)) return null;
  const dym = typeof value === "string" ? nearest(value, values, 3, { liberal: true }) : [];
  return {
    code: "E_BAD_ENUM", message: `dx12_sequence {op:'${op}'}: '${key}' に ${JSON.stringify(value)} は使えない(有効な値: ${values.join(", ")})`,
    cause: `'${key}' は ${values.join(" / ")} のどれか`, validValues: values, didYouMean: dym.length ? dym : undefined,
    fix: [...(dym[0] ? [{ tool: SEQUENCE_TOOL, args: { ...args, [key]: dym[0] }, why: `'${key}' に最も近い値で撃ち直す` }] : []), describeFix(op)],
  };
}

/** dx12_sequence の引数を検証し、エンジンへ渡す method と引数を決める。エンジンには何も送らない。 */
export function planSequenceCall(input: Record<string, unknown>): SequencePlan {
  const args: Record<string, unknown> = { ...(input ?? {}) };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];

  // 1) op
  if (!isPresent(args.op) || args.op === "") {
    return fail({
      code: "E_MISSING_PARAM", message: `dx12_sequence: 必須の引数 'op' が無い(${SEQUENCE_OPS.join(" | ")})`,
      cause: "dx12_sequence は op で操作を選ぶ。まず list で存在するシーケンスを確かめる", validValues: [...SEQUENCE_OPS],
      fix: [{ tool: SEQUENCE_TOOL, args: { op: "list" }, why: "一覧から始める" }, describeFix()],
    });
  }
  const op = normalizeOp(args.op);
  if (!op) {
    const raw = args.op;
    if (typeof raw !== "string") {
      return fail({ code: "E_BAD_TYPE", message: `dx12_sequence: 'op' は文字列でなければならない(${SEQUENCE_OPS.join(" | ")})`, validValues: [...SEQUENCE_OPS], fix: [listFix("op を文字列で渡す"), describeFix()] });
    }
    const dym = nearest(raw.replace(/^dx12_/, "").replace(/^sequence_/, ""), [...SEQUENCE_OPS], 3, { liberal: true });
    return fail({
      code: "E_BAD_ENUM", message: `dx12_sequence: 'op' に ${JSON.stringify(raw)} は使えない(有効な値: ${SEQUENCE_OPS.join(", ")})`,
      cause: `op は ${SEQUENCE_OPS.join(" / ")} のどれか。編集は 'edit'(エンジンの sequence_apply_op)`, validValues: [...SEQUENCE_OPS], didYouMean: dym.length ? dym : undefined,
      fix: [...(dym[0] ? [{ tool: SEQUENCE_TOOL, args: { ...args, op: dym[0] }, why: "'op' に最も近い値で撃ち直す" }] : []), describeFix()],
    });
  }
  const spec = SEQUENCE_OP_SPECS[op];
  args.op = op;   // 別名を正準名へ

  // 2) この op が受けないキー(黙って捨てない)。別の op の引数なら、そう伝える
  const own = new Set<string>([...spec.required, ...spec.optional]);
  const unknown = Object.keys(args).filter((k) => k !== "op" && k !== "dryRun" && !GLOBAL_KEYS.includes(k) && !own.has(k));
  if (unknown.length) {
    const cands = [...own];
    // 1〜2 文字の引数名(t)は前方一致で何にでも当たるので、3 文字以上の打ち間違いには 3 文字以上の候補だけを提案する
    const longCands = cands.filter((c) => c.length >= 3);
    const rename: Record<string, string> = {};
    const others: Record<string, SequenceOp[]> = {};
    for (const k of unknown) {
      const d = nearest(k, k.length >= 3 && longCands.length ? longCands : cands, 1, { liberal: false })[0];
      if (d && !(d in args)) rename[k] = d;
      others[k] = SEQUENCE_OPS.filter((o) => o !== op && [...SEQUENCE_OP_SPECS[o].required, ...SEQUENCE_OP_SPECS[o].optional].includes(k));
    }
    const fixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) { if (unknown.includes(k)) { if (rename[k]) fixed[rename[k]] = v; } else fixed[k] = v; }
    const fixes: Fix[] = [{ tool: SEQUENCE_TOOL, args: fixed, why: `op:'${op}' が受けない引数を${Object.keys(rename).length ? "直す/" : ""}外して撃ち直す` }];
    const first = unknown.find((k) => others[k].length);
    if (first) fixes.push({ tool: SEQUENCE_TOOL, args: { ...args, op: others[first][0] }, why: `'${first}' は op:'${others[first][0]}' の引数。その op で撃つ` });
    fixes.push(describeFix(op));
    return fail({
      code: "E_UNKNOWN_PARAM",
      message: `dx12_sequence {op:'${op}'}: 知らない引数 ${unknown.map((k) => `'${k}'`).join(", ")}${Object.keys(rename).length ? `(→ ${Object.entries(rename).map(([k, v]) => `'${k}' は '${v}'`).join("、")} のことか?)` : ""}`,
      cause: `op:'${op}' が受ける引数は ${cands.length ? cands.join(", ") : "(なし)"}` + (first ? `。'${first}' は op:'${others[first].join(" / ")}' の引数` : "") + (op === "autoplay" ? "。autoplay の下位操作(list|set|add|remove|clear)は 'action' で渡す" : ""),
      validValues: cands.length ? cands : undefined, didYouMean: Object.values(rename).length ? Object.values(rename) : undefined,
      fix: fixes,
    });
  }

  // 3) 必須(name は scrub の end:true / edit の undo・redo では不要 = ops も同様)
  const missing: string[] = [];
  for (const r of spec.required) if (!isPresent(args[r]) || args[r] === "") missing.push(r);
  if (op === "scrub" && args.end !== true && (!isPresent(args.name) || args.name === "")) missing.push("name");
  if (op === "edit" && args.undo !== true && args.redo !== true && !isPresent(args.ops)) missing.push("ops");
  if (op === "autoplay") {
    const act = isPresent(args.action) ? args.action : "list";
    if (act === "add" && (!isPresent(args.sequence) || args.sequence === "")) missing.push("sequence");
    if (act === "remove" && (!isPresent(args.sequence) || args.sequence === "")) missing.push("sequence");
    if (act === "set" && !isPresent(args.players)) missing.push("players");
  }
  if (missing.length) {
    const m = missing[0];
    const fixes: Fix[] = [];
    if (m === "name" || m === "sequence") fixes.push(listFix());
    if (m === "ops" && isPresent(args.name)) fixes.push({ tool: SEQUENCE_TOOL, args: { op: "get", name: args.name }, why: "構成(バインディング・トラックの id)を確認してから ops を組む" });
    if (m === "players") fixes.push({ tool: SEQUENCE_TOOL, args: { op: "autoplay", action: "list" }, why: "現在の設定を確認する" });
    fixes.push(describeFix(op));
    return fail({
      code: "E_MISSING_PARAM", message: `dx12_sequence {op:'${op}'}: 必須の引数 ${missing.map((k) => `'${k}'`).join(", ")} が無い`,
      cause: op === "edit" && m === "ops" ? "edit は ops(SeqOp の配列)が要る。取り消しは undo:true、やり直しは redo:true" : `op:'${op}' には ${m} が要る`,
      fix: fixes, docs: `dx12_tool_describe {name:'${SEQUENCE_TOOL}', target:'${op}'}`,
    });
  }

  // 4) 型・値の検査(zod が通した後の、op 固有の意味検査)
  if (isPresent(args.name) && typeof args.name !== "string") return fail({ code: "E_BAD_TYPE", message: `dx12_sequence {op:'${op}'}: 'name' は文字列(シーケンス名)でなければならない`, fix: [listFix(), describeFix(op)] });
  if (isPresent(args.detail)) { const p = enumProblem(op, args, "detail", DETAILS); if (p) return fail(p); }
  if (isPresent(args.clock)) { const p = enumProblem(op, args, "clock", CLOCKS); if (p) return fail(p); }
  if (op === "autoplay" && isPresent(args.action)) { const p = enumProblem(op, args, "action", AUTOPLAY_ACTIONS); if (p) return fail(p); }
  if (op === "edit" && isPresent(args.ops)) {
    if (!Array.isArray(args.ops)) return fail({ code: "E_BAD_TYPE", message: "dx12_sequence {op:'edit'}: 'ops' は配列でなければならない(例 [{\"op\":\"addKey\",…}])", fix: [describeFix("edit")] });
    if (args.ops.length === 0) return fail({ code: "E_MISSING_PARAM", message: "dx12_sequence {op:'edit'}: 'ops' が空(1 つ以上の SeqOp が要る)", cause: "何も編集しない呼び出し。取り消しは undo:true", fix: [{ tool: SEQUENCE_TOOL, args: { op: "get", name: args.name }, why: "構成を確認してから ops を組む" }, describeFix("edit")] });
    const bad = args.ops.findIndex((o) => !isObj(o));
    if (bad >= 0) return fail({ code: "E_BAD_TYPE", message: `dx12_sequence {op:'edit'}: ops[${bad}] はオブジェクトでなければならない({"op":"<名前>", …})`, fix: [describeFix("edit")] });
    const noName = args.ops.findIndex((o) => !isObj(o) || typeof (o as Record<string, unknown>).op !== "string");
    if (noName >= 0) return fail({ code: "E_MISSING_PARAM", message: `dx12_sequence {op:'edit'}: ops[${noName}] に 'op'(SeqOp の名前。例 "addKey")が無い`, cause: "各要素は {\"op\":\"addKey\", …フィールド}(名前とフィールドは docs/DXSEQ_FORMAT.md)", fix: [describeFix("edit")] });
  }
  if (op === "autoplay" && isPresent(args.players) && !Array.isArray(args.players)) return fail({ code: "E_BAD_TYPE", message: "dx12_sequence {op:'autoplay'}: 'players' は配列でなければならない([{sequence, loop?, rate?, startDelay?, clock?}, …])", fix: [describeFix("autoplay")] });

  // 5) 引数の写像。loop は op ごとに意味が違う(play = once|loop|pingpong / autoplay = bool)ので、相互に読み替える
  const params: Record<string, unknown> = {};
  for (const k of [...spec.required, ...spec.optional]) {
    if (!isPresent(args[k])) continue;
    if (op === "autoplay" && k === "action") { params.op = args[k]; continue; }
    params[k] = args[k];
  }
  for (const g of GLOBAL_KEYS) if (isPresent(args[g])) params[g] = args[g];
  if (isPresent(args.loop)) {
    const lv = args.loop;
    if (op === "play") {
      if (lv === true) params.loop = "loop";
      else if (lv === false) params.loop = "once";
      else { const p = enumProblem(op, args, "loop", PLAY_LOOPS, lv); if (p) return fail(p); }
    } else if (op === "autoplay") {
      if (typeof lv === "string") {
        if (lv === "loop" || lv === "pingpong") params.loop = true;
        else if (lv === "once") params.loop = false;
        else { const p = enumProblem(op, args, "loop", PLAY_LOOPS, lv); if (p) return fail(p); }
      } else if (typeof lv !== "boolean") return fail({ code: "E_BAD_TYPE", message: "dx12_sequence {op:'autoplay'}: 'loop' は true / false", fix: [describeFix("autoplay")] });
    }
  }

  // 6) dryRun
  const dryRun = args.dryRun === true;
  let dryRunMode: "none" | "engine" | "static" | "read-ignored" = "none";
  if (dryRun) {
    if (spec.dryRun === "read") dryRunMode = "read-ignored";
    else if (spec.dryRun === "static") dryRunMode = "static";
    else {
      // エンジンのプレビューが引ける形だけ engine。scrub {end:true} と edit {undo|redo} は「名前で文書を引く」プレビューに乗らないので静的に答える。
      const staticOnly = (op === "scrub" && args.end === true) || (op === "edit" && (args.undo === true || args.redo === true));
      dryRunMode = staticOnly ? "static" : "engine";
    }
    if (dryRunMode === "engine") params.dryRun = true;
  }
  return { ok: true, op, spec, method: spec.method, params, dryRun, dryRunMode, effect: spec.effect };
}

/** dryRun:true を実行せずに答える(static のとき)。エンジンのプレビューと同じ形 {dryRun, executed:false, method, effect, preview}。 */
export function staticPreview(plan: Extract<SequencePlan, { ok: true }>, args: Record<string, unknown>): Record<string, unknown> {
  const { op, spec } = plan;
  const name = typeof args.name === "string" ? args.name : undefined;
  let wouldDo = spec.summary;
  const notes: string[] = ["実行はしていない(エンジンへは何も送っていない)"];
  let undoable: string | undefined;
  switch (op) {
    case "load":
      wouldDo = args.create === true ? `'${name}' が無ければ空の文書(fps ${args.fps ?? 30})を作ってメモリへ置く。ファイルは op:'save' まで作らない` : `'${name}' をメモリへ読む${args.reload === true ? "(開いている文書は読み直す。未保存の編集は失う)" : ""}`;
      undoable = "ディスクは変えない";
      break;
    case "stop":
      wouldDo = "再生を止める(Play 中は名前の再生を止める・値は戻さない。Editor 中はプレビューを止めて元の値へ戻す)";
      undoable = "Play 中の再生は Stop でシーンごと復元される";
      break;
    case "scrub":
      wouldDo = "スクラブを終えて、退避していた値を元へ戻す";
      break;
    case "edit":
      wouldDo = args.undo === true ? "直前の編集を取り消す" : "取り消した編集をやり直す";
      undoable = "Undo / Redo の履歴が動く。ファイルは op:'save' まで書かない";
      break;
    case "autoplay": {
      const act = typeof args.action === "string" ? args.action : "list";
      wouldDo = act === "list" ? "現在の自動再生設定を返す(変更なし)" : `シーンの自動再生設定(sequencePlayers)を ${act} する`;
      if (act !== "list") { undoable = "エディタの Undo 対象(シーン保存で sequencePlayers に書かれる)"; notes.push("Editor モード限定"); }
      break;
    }
    default: break;
  }
  return {
    dryRun: true, executed: false, method: spec.method, effect: spec.effect,
    preview: { tool: SEQUENCE_TOOL, op, wouldDo, ...(undoable ? { undoable } : {}), args, supported: `static(op:'${op}' はエンジンのプレビューを持たない。影響の予測まで)`, notes },
  };
}

/** 成功結果の整形。read の dryRun は「実行した」と正直に書く。それ以外はエンジンの結果のまま。 */
export function finalizeSequenceResult(plan: Extract<SequencePlan, { ok: true }>, raw: unknown): unknown {
  if (plan.dryRunMode === "read-ignored" && isObj(raw)) return { ...raw, dryRunNote: `op:'${plan.op}' は読み取りなので dryRun は無視して実行した(何も変更していない)` };
  return raw;
}

// ── エンジンのエラー → 構造化エラー(dx12_sequence の呼び方で撃ち直せる fix) ─────────────────────────

/** エンジンが返したエラー(EngineCallError と同じ形の必要な部分だけ)。 */
export type EngineErrorLike = { message?: string; code?: number; errName?: string; errCause?: string; hint?: string; didYouMean?: string[]; errDetails?: Record<string, unknown> };

/** シーケンス名が引けなかったエラー(engine: E_NOT_FOUND「sequence 'X' not found」/「is not loaded」)か。 */
export function isSequenceNotFound(e: EngineErrorLike): boolean {
  const m = String(e?.message ?? "");
  return (e?.code === 1 || e?.errName === "E_NOT_FOUND") && /sequence '/.test(m);
}

export function sequenceNotFoundBody(e: EngineErrorLike, op: SequenceOp, args: Record<string, unknown>): ErrorBody {
  const name = typeof args.name === "string" ? args.name : "";
  const msg = String(e.message ?? `sequence '${name}' not found`);
  const notLoaded = /is not loaded/.test(msg);
  const dym = (e.didYouMean ?? []).filter((x) => x && x !== name);
  const fixes: Fix[] = [];
  if (dym[0]) fixes.push({ tool: SEQUENCE_TOOL, args: { ...args, name: dym[0] }, why: `'${name}' に最も近い '${dym[0]}' で撃ち直す` });
  if (notLoaded) fixes.push({ tool: SEQUENCE_TOOL, args: { op: "load", name }, thenRetry: true, why: "先にメモリへ読んでから、同じ呼び出しを撃ち直す" });
  else if (op === "load" || op === "get" || op === "eval" || op === "scrub" || op === "play" || op === "edit") fixes.push({ tool: SEQUENCE_TOOL, args: { op: "load", name, create: true }, why: `新しく作る(空のシーケンス '${name}'。ファイルは op:'save' まで作らない)` });
  fixes.push(listFix());
  return {
    code: "E_NOT_FOUND", message: `dx12_sequence {op:'${op}'}: ${msg.replace(/^sequence_[a-z_]+:\s*/, "")}`,
    cause: e.errCause ?? (notLoaded ? "この名前の文書は開いていない" : "このシーケンスは assets/sequences/ にも開いている文書にも無い"),
    didYouMean: dym.length ? dym : undefined, retryable: false, fix: fixes,
  };
}

const UNKNOWN_OP_RE = /ops\[(\d+)\][^:]*:\s*知らない op:\s*([^\s(（]+)\s*[（(]有効:\s*([^）)]*)[）)]/;

/** edit の失敗(E_INVALID_OP)を、近い op 名つきで直せる形にする。 */
export function enrichEditError(body: ErrorBody, args: Record<string, unknown>): ErrorBody {
  const m = UNKNOWN_OP_RE.exec(body.message);
  if (m) {
    const idx = Number(m[1]);
    const bad = m[2];
    const names = m[3].split(/[,、]\s*/).map((s) => s.trim()).filter(Boolean);
    const dym = nearest(bad, names, 3, { liberal: true });
    body.code = "E_BAD_ENUM";
    body.validValues = names;
    body.didYouMean = dym.length ? dym : undefined;
    body.cause = `ops[${idx}] の op '${bad}' は SeqOp に無い。何も変更していない(全部成功か全部巻き戻し)`;
    const fixes: Fix[] = [];
    if (dym[0] && Array.isArray(args.ops) && isObj(args.ops[idx])) {
      const ops = (args.ops as Record<string, unknown>[]).map((o, i) => (i === idx ? { ...o, op: dym[0] } : o));
      fixes.push({ tool: SEQUENCE_TOOL, args: { ...args, ops }, why: `ops[${idx}] の op を最も近い '${dym[0]}' に直して撃ち直す` });
    }
    body.fix = [...fixes, ...(body.fix ?? []).filter((f) => f.tool !== SEQUENCE_TOOL || f.args?.op !== "edit")];
    return body;
  }
  // 位置つきの一般エラー: 何も変更していない。構成を見直して直す
  body.cause = body.cause ?? "op を適用できなかった。シーケンスは変更されていない(全部成功か全部巻き戻し)";
  const has = (body.fix ?? []).some((f) => f.tool === SEQUENCE_TOOL && f.args?.op === "get");
  if (!has && typeof args.name === "string") {
    body.fix = [{ tool: SEQUENCE_TOOL, args: { op: "get", name: args.name }, why: "構成(バインディング・トラック・チャンネルの id)を確認して、エラー文の位置(ops[i])を直す" }, ...(body.fix ?? [])];
  }
  body.docs = body.docs ?? "docs/DXSEQ_FORMAT.md(SeqOp の名前とフィールド)";
  return body;
}

/** fix の tool / args がエンジン method 名(sequence_list …)なら dx12_sequence の呼び方へ書き直す。 */
export function rewriteSequenceFixes(fix: Fix[] | undefined): Fix[] | undefined {
  if (!fix) return fix;
  return fix.map((f) => {
    const bare = String(f.tool ?? "").replace(/^dx12_/, "");
    const op = SEQUENCE_METHOD_TO_OP[bare];
    if (!op) return f;
    const { op: sub, ...rest } = (f.args ?? {}) as Record<string, unknown>;
    // エンジンの autoplay の下位操作 op は、こちらでは action(op は "autoplay")
    return { ...f, tool: SEQUENCE_TOOL, args: op === "autoplay" && sub !== undefined ? { op, action: sub, ...rest } : { op, ...rest } };
  });
}

/**
 * 構造化済みの ErrorBody(structureError の結果など)を dx12_sequence 向けに仕上げる。
 *   ・fix の sequence_* を dx12_sequence {op} に書き直す
 *   ・エンジンが method を持たない(古い)なら E_ENGINE_TOO_OLD
 *   ・scrub が Play 中で断られたら、Play 中に流す op:'play' も案内する
 *   ・edit の失敗は近い op 名つきに
 */
export function finishSequenceError(body: ErrorBody, op: SequenceOp, args: Record<string, unknown>): ErrorBody {
  const spec = SEQUENCE_OP_SPECS[op];
  if (body.code === "E_UNKNOWN_TOOL" && /unknown method/i.test(body.message)) {
    body.code = "E_ENGINE_TOO_OLD";
    body.message = `エンジンが method '${spec.method}' を持たない(dx12_sequence {op:'${op}'} が呼ぶ method)`;
    body.cause = "エンジンが古いか、シーケンサーを含まないビルド。名前の打ち間違いではない";
    body.retryable = false;
    body.didYouMean = undefined;
    body.fix = [{ tool: "dx12_doctor", args: {}, why: "エンジンの版とマニフェストを確認する" }, { why: "エンジンを更新(最新をビルド)して再起動する。MCP サーバ(Node)の再起動は要らない" }];
    return body;
  }
  if (op === "edit" && (body.code === "E_INVALID_PARAM" || body.code === "E_BAD_ENUM" || body.code === "E_MISSING_PARAM" || /sequence_apply_op:/.test(body.message))) body = enrichEditError(body, args);
  body.fix = rewriteSequenceFixes(body.fix);
  if (op === "scrub" && body.code === "E_MODE_CONFLICT" && typeof args.name === "string") {
    const f: Fix = { tool: SEQUENCE_TOOL, args: { op: "play", name: args.name }, why: "Play 中に流すなら op:'play'(スクラブは Editor 限定)" };
    body.fix = [...(body.fix ?? []), f];
  }
  body.message = body.message.replace(/^sequence_[a-z_]+:\s*/, `dx12_sequence {op:'${op}'}: `);
  return body;
}
