// tools/list の表面(公開ツール)のテスト。エンジン不要。設計書 §5.2 M3 の合否基準(tools/list のサイズ・lint・alias 網羅)。
//   [1] legacy 面  = M0 のスナップショットと完全一致(旧 220 ツールが 1 バイトも変わっていない回帰基準)
//   [2] full 面(既定)= shell 5 本が先頭 + 旧 220 本が「意味的に同一」(outputSchema を削り、guarded に destructiveHint を足しただけ)。サイズは M0 基準以下
//   [3] core 面   = shell 5 本 + Core 28 本(dx12_sequence・dx12_editor_command / state を含む)+ フリート 2 + ジョブ 3 + dx12_batch + dx12_call_guarded(計 40 本 ≤ 40 本、≤ 120 KB)。説明テンプレ・名前規約の lint
//   [4] shell 面  = shell 5 本だけ
//   [5] alias 網羅 = 旧 220 名がすべて dx12_call で解決できる(旧名の呼び方は変わらない)。統合ツールの往復変換
// 実行: node toolSurface.test.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listTools, semanticView, sha, M3_DESTRUCTIVE_HINT_ADDED } from "./scripts/gen_legacy_snapshot.mjs";
import {
  CONSOLIDATED, CORE_28, CORE_DESCRIPTION_MAX, CORE_ENGINE_DIRECT, CORE_FLEET, CORE_GUARDED_TOOL, CORE_JOBS, CORE_LEGACY, CORE_ORDER, EDITOR_TOOLS, EDITOR_TOOL_SET, FLEET_TOOLS, FLEET_TOOL_SET, JOB_TOOLS, JOB_TOOL_SET, NAME_EXCEPTIONS, SCENE_SPEC_TOOLS, SCENE_SPEC_TOOL_SET, SHELL_TOOLS,
  aliasStats, buildAliasTable, routeConsolidated, toCoreCall, verbOf,
} from "./coreSpec.ts";
import { DIALECT_PATTERN } from "./errors.ts";
import { INSTRUCTIONS, INSTRUCTIONS_CORE } from "./instructions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const snap = JSON.parse(fs.readFileSync(path.join(here, "legacy-tools.snapshot.json"), "utf8"));
const SNAP_BY_NAME = new Map<string, any>(snap.tools.map((t: any) => [t.name, t]));
const LEGACY_NAMES: string[] = snap.tools.map((t: any) => t.name);
const M0_BYTES: number = snap.totalBytes;
const CORE_MAX_BYTES = 120 * 1024;   // 設計書 §5.2 M3 (d)① / §4.1.7

// DXR パストレーサー(Q1a)。toolset/pathTracer.ts が full / core / shell 面の末尾へ足す(legacy 面には出さない)。
const PT_TOOLS = ["dx12_render_reference", "dx12_render_reference_status", "dx12_render_reference_cancel"];
const VG_TOOLS = ["dx12_vg_stats", "dx12_set_virtual_geometry"];
const LUA_STEP_TOOLS = ["dx12_lua_step"];   // toolset/luaStep.ts(eval_lua → step_frames → eval_lua を 1 回に束ねた guarded な合成ツール)
console.log("[1] legacy 面: M0 のスナップショットと一致");
const legacy = await listTools("legacy");
check(`tools/list の総バイト数が M0 と同一(${snap.totalBytes})`, legacy.bytes === snap.totalBytes, `${legacy.bytes} != ${snap.totalBytes}`);
check("ツール数と並び(名前の列)が同一", eq(legacy.tools.map((t: any) => t.name), LEGACY_NAMES), legacy.tools.length);
const changed = legacy.tools.filter((t: any, i: number) => sha(t) !== snap.tools[i]?.sha256).map((t: any) => t.name);
check("全ツールのスキーマ(説明・引数・annotations・outputSchema)が同一", changed.length === 0, changed.slice(0, 10));
check("shell ツールは出ない(legacy)", !legacy.tools.some((t: any) => SHELL_TOOLS.includes(t.name)));
check("legacy 面は outputSchema を残す(M0 と同一の回帰基準)", legacy.tools.some((t: any) => t.outputSchema));

console.log("[2] full 面(既定): shell 5 本 + 旧 220 本(意味的に同一)");
const full = await listTools("full");
check("先頭 5 本が shell", eq(full.tools.slice(0, 5).map((t: any) => t.name), SHELL_TOOLS), full.tools.slice(0, 5).map((t: any) => t.name));
const restAll = full.tools.slice(5);
const rest = restAll.slice(0, 220);
check("旧 220 本の名前と並びが同一のまま続く", rest.length === 220 && eq(rest.map((t: any) => t.name), LEGACY_NAMES), rest.length);
check("旧 220 本の後ろ(末尾)にパストレーサーの 3 本と仮想ジオメトリの 2 本と lua_step の 1 本とフリートの 6 本とジョブの 6 本とエディタ操作の 4 本とシーン仕様の 2 本だけが足される", eq(restAll.slice(220).map((t: any) => t.name), [...PT_TOOLS, ...VG_TOOLS, ...LUA_STEP_TOOLS, ...FLEET_TOOLS, ...JOB_TOOLS, ...EDITOR_TOOLS, ...SCENE_SPEC_TOOLS]), restAll.slice(220).map((t: any) => t.name));
const semDiff = rest.filter((t: any) => sha(semanticView(t)) !== SNAP_BY_NAME.get(t.name)?.semSha256).map((t: any) => t.name);
check("旧 220 本の name / title / 説明 / inputSchema / annotations / _meta が意味的に同一(outputSchema と destructiveHint 以外は 1 バイトも変わらない)", semDiff.length === 0, semDiff.slice(0, 10));
const inputDiff = rest.filter((t: any, i: number) => sha(t.inputSchema) !== sha(legacy.tools[i].inputSchema) || t.description !== legacy.tools[i].description).map((t: any) => t.name);
check("旧 220 本の inputSchema と description は完全一致", inputDiff.length === 0, inputDiff.slice(0, 10));
check("full 面に outputSchema は 1 つも出ない(情報の無い共通 {result:any} を削除)", full.tools.every((t: any) => !t.outputSchema));
{
  const annDiff = rest.filter((t: any, i: number) => !eq(t.annotations, legacy.tools[i].annotations)).map((t: any) => t.name);
  check("annotations が変わったのは guarded な 8 本(destructiveHint:true を足しただけ)に限る", eq([...annDiff].sort(), [...M3_DESTRUCTIVE_HINT_ADDED].sort()), annDiff);
  check("その 8 本の destructiveHint は true、readOnlyHint は付いていない", M3_DESTRUCTIVE_HINT_ADDED.every((n) => { const a = rest.find((t: any) => t.name === n)?.annotations; return a?.destructiveHint === true && a?.readOnlyHint !== true; }));
}
check(`full の tools/list(${full.bytes} B)が M0 基準(${M0_BYTES} B)以下`, full.bytes <= M0_BYTES, `${full.bytes} > ${M0_BYTES}`);
const shellBytes = full.tools.slice(0, 5).reduce((a: number, t: any) => a + Buffer.byteLength(JSON.stringify(t)), 0);
console.log(`      full = ${full.bytes} B(旧 220 部分 ${full.bytes - shellBytes} B + shell 5 本 ${shellBytes} B)。M0 ${M0_BYTES} B 比 ${((full.bytes / M0_BYTES) * 100).toFixed(1)}%。outputSchema 削除 ${snap.outputSchemaBytesTotal} B(${snap.tools.filter((t: any) => t.outputSchemaBytes > 0).length} 本)`);

console.log("[3] core 面: shell 5 本 + Core 28 本 + フリート 5 本 + dx12_batch + dx12_call_guarded");
const core = await listTools("core");
const coreNames: string[] = core.tools.map((t: any) => t.name);
check("並びは shell 5 本 → Core の固定順(決定的)", eq(coreNames, [...SHELL_TOOLS, ...CORE_ORDER]), coreNames);
check(`ツール数 ${core.tools.length} 本 ≤ 40 本`, core.tools.length <= 40);
check(`tools/list ${core.bytes} B ≤ 120 KB(${CORE_MAX_BYTES} B)かつ M0 の 30% 以下`, core.bytes <= CORE_MAX_BYTES && core.bytes <= M0_BYTES * 0.3, core.bytes);
console.log(`      core = ${core.tools.length} 本 / ${core.bytes} B(M0 比 ${((core.bytes / M0_BYTES) * 100).toFixed(1)}%、120 KB の ${((core.bytes / CORE_MAX_BYTES) * 100).toFixed(0)}%)`);
{
  const core2 = await listTools("core");
  check("決定論: 2 回起動して tools/list が完全に同一", eq(core.tools, core2.tools));
}
check("Core 28 本(エディタ操作 2 を含む)+ フリート 2 本 + ジョブ 3 本 + dx12_batch + dx12_call_guarded = 35(shell を足して 40)", CORE_28.length === 28 && CORE_FLEET.length === 2 && CORE_JOBS.length === 3 && CORE_ORDER.length === 35, { c28: CORE_28.length, f: CORE_FLEET.length, j: CORE_JOBS.length, o: CORE_ORDER.length });
check("core 面はちょうど 40 本(上限。増やすなら選定理由を docs/MCP_FLEET_DESIGN.md §9 に書く)", core.tools.length === 40, core.tools.length);
check("core 面に outputSchema が無い", core.tools.every((t: any) => !t.outputSchema));
check("shell の alwaysLoad は 5 本ちょうど(増やさない)", core.tools.filter((t: any) => t._meta?.["anthropic/alwaysLoad"] === true).length === 5 && core.tools.slice(0, 5).every((t: any) => t._meta?.["anthropic/alwaysLoad"] === true));
{
  const g = core.tools.find((t: any) => t.name === CORE_GUARDED_TOOL);
  check("dx12_call_guarded は requiresUserInteraction:true / destructiveHint:true / alwaysLoad ではない", g?._meta?.["anthropic/requiresUserInteraction"] === true && g?.annotations?.destructiveHint === true && g?._meta?.["anthropic/alwaysLoad"] !== true, g?._meta);
}
{
  const bad = core.tools.filter((t: any) => t.name !== "dx12_call_guarded" && t._meta?.["anthropic/requiresUserInteraction"]).map((t: any) => t.name);
  check("requiresUserInteraction は dx12_call_guarded だけ", bad.length === 0, bad);
}
{
  const cores = core.tools.slice(5);
  const over = cores.filter((t: any) => t.description.length > CORE_DESCRIPTION_MAX).map((t: any) => `${t.name}:${t.description.length}`);
  check(`Core の説明は ${CORE_DESCRIPTION_MAX} 字以内`, over.length === 0, over);
  const noTpl = cores.filter((t: any) => t.name !== CORE_GUARDED_TOOL ? !(/(使う|副作用)/.test(t.description) && /注意|次|返り値/.test(t.description)) : false).map((t: any) => t.name);
  check("Core の説明はテンプレ(使う / 副作用 / 注意・次・返り値)を含む", noTpl.length === 0, noTpl);
  const noWhenNot = cores.filter((t: any) => !/使わない/.test(t.description) && !["dx12_stop", "dx12_play"].includes(t.name) ).map((t: any) => t.name);
  check("Core の説明は『使わない』(代わりのツール)を書いている(play / stop を除く)", noWhenNot.length === 0, noWhenNot);
  const firstLine = cores.filter((t: any) => t.description.split("\n")[0].length > 260).map((t: any) => t.name);
  check("先頭 1 行(要点)が 260 字以内", firstLine.length === 0, firstLine);
  const dialect = cores.filter((t: any) => DIALECT_PATTERN.test(t.description)).map((t: any) => t.name);
  check("Core の説明に方言・命令口調が無い", dialect.length === 0, dialect);
  const cjk = cores.every((t: any) => /[぀-ヿ一-鿿]/.test(t.description));
  check("Core の説明は日本語(標準語)", cjk);
}
{
  // 旧ツールのまま Core に入るもの: 名前・inputSchema・annotations は旧ツールと同一(説明だけテンプレに差し替わる)
  const same = CORE_LEGACY.filter((n) => {
    const c = core.tools.find((t: any) => t.name === n);
    const l = legacy.tools.find((t: any) => t.name === n);
    return c && l && sha(c.inputSchema) === sha(l.inputSchema) && eq(c.annotations, l.annotations);
  });
  check(`旧ツールのまま Core に入る ${CORE_LEGACY.length} 本は inputSchema と annotations が旧ツールと同一`, same.length === CORE_LEGACY.length, CORE_LEGACY.filter((n) => !same.includes(n)));
}
{
  const cores = core.tools;
  check("全ツール名が ^[A-Za-z0-9_-]{1,64}$ で dx12_ 接頭辞・32 字以内", cores.every((t: any) => /^[A-Za-z0-9_-]{1,64}$/.test(t.name) && t.name.startsWith("dx12_") && t.name.length <= 32));
  const badArgs = cores.flatMap((t: any) => Object.keys(t.inputSchema?.properties ?? {}).filter((k) => !/^[A-Za-z0-9_.-]{1,64}$/.test(k)).map((k) => `${t.name}.${k}`));
  check("引数名は 1〜64 字の英数字・_ . - だけ", badArgs.length === 0, badArgs.slice(0, 5));
  check("ルートに oneOf/anyOf/allOf が無い(Claude Code が平坦化する)", cores.every((t: any) => !t.inputSchema?.oneOf && !t.inputSchema?.anyOf && !t.inputSchema?.allOf));
  check("shell の説明は 1 本 1,200 字以内(先頭に要点)", cores.slice(0, 5).every((t: any) => t.description.length <= 1200), cores.slice(0, 5).map((t: any) => t.description.length));
  check("全ツールの説明が Claude Code の切り詰め上限(2,048 字)以内", cores.every((t: any) => t.description.length <= 2048));
  // 名前規約: 動詞(先頭語または末尾語)が副作用クラスを決める。動詞で判定できない名前は明示の例外表(NAME_EXCEPTIONS)だけ。
  const unknownVerb = cores.map((t: any) => t.name).filter((n: string) => !verbOf(n) && !NAME_EXCEPTIONS.has(n));
  check("Core の名前は動詞規約(dx12_<動詞>_<対象>)に従うか、明示の例外表にある", unknownVerb.length === 0, unknownVerb);
  const inconsistent: string[] = [];
  for (const t of cores) {
    const v = verbOf(t.name);
    if (!v) continue;
    const a = t.annotations ?? {};
    if (v.cls === "read" && a.readOnlyHint !== true) inconsistent.push(`${t.name}: 読み取り動詞なのに readOnlyHint が true でない`);
    if ((v.cls === "write" || v.cls === "runtime") && a.readOnlyHint === true) inconsistent.push(`${t.name}: 書き込み/実行動詞なのに readOnlyHint:true`);
    if (v.cls === "guarded" && a.destructiveHint !== true) inconsistent.push(`${t.name}: guarded 動詞なのに destructiveHint が true でない`);
  }
  check("動詞と annotations(readOnlyHint / destructiveHint)が整合", inconsistent.length === 0, inconsistent);
  const roCore = cores.filter((t: any) => t.annotations?.readOnlyHint === true).map((t: any) => t.name);
  check("読み取り専用ツールは dx12_get_* / dx12_list_* / shell の読み取り(1 行の許可ルールで書ける)", roCore.every((n: string) => /^dx12_(get|list|engine_list|editor_state|job_(status|list|result|logs)|tool_search|tool_describe|doctor|guide)/.test(n)), roCore);
  check("instructions(core)が 2,048 字以内で Core の主要ツールと dx12_call_guarded を挙げている", INSTRUCTIONS_CORE.length <= 2048 && ["dx12_capture", "dx12_apply_scene_spec", "dx12_call_guarded", "dx12_tool_search", "--background"].every((k) => INSTRUCTIONS_CORE.includes(k)), INSTRUCTIONS_CORE.length);
  check("instructions(full / shell)が 2,048 字以内", INSTRUCTIONS.length <= 2048);
  // instructions が挙げた dx12_ 名は core 面に実在するか shell の別名で引ける名前であること
  const named = [...INSTRUCTIONS_CORE.matchAll(/dx12_[a-z_]+/g)].map((m) => m[0]);
  const listedSet = new Set(coreNames);
  const legacySet = new Set(LEGACY_NAMES);
  const unresolved = [...new Set(named)].filter((n) => !listedSet.has(n) && !legacySet.has(n) && !FLEET_TOOL_SET.has(n) && !JOB_TOOL_SET.has(n) && !EDITOR_TOOL_SET.has(n) && !SCENE_SPEC_TOOL_SET.has(n) && !LUA_STEP_TOOLS.includes(n) && !/^dx12_(get|set|list)_?$/.test(n) && !["dx12_"].includes(n));
  check("instructions(core)が挙げる dx12_ 名は tools/list か旧ツールに実在(省略記法を除く)", unresolved.length === 0, unresolved);
}

console.log("[4] shell 面: shell 5 本だけ");
const shellOnly = await listTools("shell");
check("shell 面は shell 5 本だけ", eq(shellOnly.tools.map((t: any) => t.name), SHELL_TOOLS), shellOnly.tools.map((t: any) => t.name));
console.log(`      shell だけの tools/list = ${shellOnly.bytes} バイト(旧 220 本の ${(shellOnly.bytes / M0_BYTES * 100).toFixed(1)}%)`);
check("shell だけなら旧 tools/list の 5% 未満", shellOnly.bytes < M0_BYTES * 0.05, shellOnly.bytes);
check("shell 面の dx12_call は confirm:true の従来仕様(dx12_call_guarded は出さない)", !shellOnly.tools.some((t: any) => t.name === CORE_GUARDED_TOOL) && /confirm:true/.test(shellOnly.tools.find((t: any) => t.name === "dx12_call").description));
check("core 面の dx12_call は guarded を実行できない旨を説明している", /dx12_call_guarded/.test(core.tools.find((t: any) => t.name === "dx12_call").description) && !/confirm:true が要る/.test(core.tools.find((t: any) => t.name === "dx12_call").description));

console.log("[5] alias 網羅: 旧 220 名がすべて dx12_call で解決できる");
process.env.DX12_MCP_PORT = "1";   // エンジンには繋がない(同梱スナップショット + 登録済みツールだけ)
await import("./toolset/all.ts");
const { shell } = await import("./toolset/shell.ts");
{
  const docs = shell.catalog.docs;
  const unresolved = LEGACY_NAMES.filter((n) => shell.catalog.resolve(n)?.id !== n);
  check("旧 220 名がすべて catalog.resolve で同名のツールに解決する", unresolved.length === 0, unresolved.slice(0, 10));
  const bare = LEGACY_NAMES.filter((n) => shell.catalog.resolve(n.replace(/^dx12_/, ""))?.id !== n);
  check("dx12_ を外した名前でも解決する", bare.length === 0, bare.slice(0, 10));
  const notLegacy = LEGACY_NAMES.filter((n) => shell.catalog.resolve(n)?.tier !== "legacy");
  check("旧名は旧ツール(tier:legacy)に解決する(統合ツールに乗っ取られない = 名前・引数・返り値は不変)", notLegacy.length === 0, notLegacy.slice(0, 10));
  const argDiff = LEGACY_NAMES.filter((n) => !eq(shell.catalog.resolve(n)?.params.map((p) => p.name), SNAP_BY_NAME.get(n).argKeys));
  check("旧 220 名の引数名が M0 のスナップショットと同一", argDiff.length === 0, argDiff.slice(0, 10));
  const table = buildAliasTable(LEGACY_NAMES);
  const st = aliasStats(table);
  console.log(`      alias 表: ${st.total} 名 = Core に同名で入る ${st.same} / 統合ツールが置換 ${st.consolidated} / 長尾(dx12_call で使う)${st.long_tail}`);
  check("alias 表は 220 名すべてを 1 回ずつ数える", st.total === 220 && st.same + st.consolidated + st.long_tail === 220);
  check("Core に同名で入る旧ツールは 19 本(Core 18 + dx12_batch。dx12_scene_write は M11 で dx12_apply_scene_spec を足すために、dx12_run_playtests は M6、dx12_get_script_errors は dx12_sequence を足すために、dx12_play_script は M7 でエディタ操作を足すために長尾へ)", st.same === 19, st.same);
  check("dx12_get_script_errors は長尾(旧名のまま dx12_call で使える)・dx12_sequence は Core(エンジン直結。旧ツールの routes を持たない)", table.find((e) => e.legacy === "dx12_get_script_errors")?.via === "long_tail" && !coreNames.includes("dx12_get_script_errors") && coreNames.includes("dx12_sequence") && CORE_ENGINE_DIRECT.includes("dx12_sequence") && shell.catalog.resolve("dx12_sequence")?.tier === "core" && shell.catalog.resolve("dx12_get_script_errors")?.tier === "legacy");
  const missingCore = table.filter((e) => e.via === "same" && !coreNames.includes(e.canonical)).map((e) => e.legacy);
  check("『Core に同名で入る』と分類した旧ツールが実際に core 面の tools/list に出る", missingCore.length === 0, missingCore);
  const badCanon = table.filter((e) => e.via === "consolidated" && !(shell.catalog.resolve(e.canonical)?.core && coreNames.includes(e.canonical))).map((e) => e.legacy);
  check("『統合ツールが置換』と分類した旧ツールの canonical が core 面に実在する", badCanon.length === 0, badCanon);
  check("統合ツール 6 本が置換する旧ツールの数", table.filter((e) => e.via === "consolidated").length === Object.values(CONSOLIDATED).reduce((a, s) => a + Object.keys(s.routes).length, 0));
  // 統合ツールの往復: 旧名 → 統合ツールの呼び方 → 振り分けると同じ旧名と同じ引数に戻る
  const roundTrip: string[] = [];
  for (const e of table.filter((x) => x.via === "consolidated")) {
    const sample = { entity: 1, name: "X" };
    const call = toCoreCall(e.legacy, sample);
    const spec = call ? CONSOLIDATED[call.tool] : null;
    const r = spec && call ? routeConsolidated(spec, call.args) : null;
    if (!r || !r.ok || r.legacy !== e.legacy || !eq(r.legacyArgs, sample)) roundTrip.push(e.legacy);
  }
  check("統合ツールへの変換が往復で元の旧名・旧引数に戻る(全置換対象)", roundTrip.length === 0, roundTrip);
  // Core 名はすべて catalog にあり core フラグが立つ
  const missing = CORE_ORDER.filter((n) => n !== CORE_GUARDED_TOOL).filter((n) => !shell.catalog.resolve(n)?.core);
  check("Core 一覧の全ツールが catalog で core 扱い(dx12_call_guarded は core 面のみ)", missing.length === 0, missing);
  check("catalog の core ツール数 = 28 + フリート 5 + dx12_batch", docs.filter((d) => d.core).length === 34, docs.filter((d) => d.core).length);
}

console.log("[6] effect の分類(M3 で見直した点)");
{
  const eff = (n: string) => shell.catalog.resolve(n)?.effect;
  check("look_at = write_scene(rotation を書く。同梱マニフェスト = エンジンの表を修正済み)", eff("dx12_look_at") === "write_scene", eff("dx12_look_at"));
  check("screenshot_from / focus_and_screenshot / camera_path = write_setting(エディタカメラを動かして撮るだけ)", ["dx12_screenshot_from", "dx12_focus_and_screenshot", "dx12_camera_path"].every((n) => eff(n) === "write_setting"), ["dx12_screenshot_from", "dx12_focus_and_screenshot", "dx12_camera_path"].map(eff));
  check("vfx_preview / sequence_preview = runtime", eff("dx12_vfx_preview") === "runtime" && eff("dx12_sequence_preview") === "runtime");
  check("guarded は 11 本(git 書き込み系 7 + eval_lua + delete_asset + build_game + net_launch_test_client)", shell.catalog.docs.filter((d) => d.tier === "legacy" && d.effectClass === "guarded").length === 11, shell.catalog.docs.filter((d) => d.effectClass === "guarded").map((d) => d.id));
  check("git_status / git_branches は read", eff("dx12_git_status") === "read" && eff("dx12_git_branches") === "read");
  const { CONDITIONAL_WRITE } = await import("./catalog.ts");
  check("validate_layout は fix:'safe' / 'all' のときだけ書く(dryRun で実行しない条件)", CONDITIONAL_WRITE.dx12_validate_layout({ fix: "safe" }) && CONDITIONAL_WRITE.dx12_validate_layout({ fix: "all" }) && !CONDITIONAL_WRITE.dx12_validate_layout({}) && !CONDITIONAL_WRITE.dx12_validate_layout({ fix: "none" }));
  // 統合ツールの副作用(代表)
  check("統合ツールの effect(代表): get_* = read / set_render_settings = write_setting / edit_terrain = write_file / imgui = runtime", eff("dx12_get_render_settings") === "read" && eff("dx12_set_render_settings") === "write_setting" && eff("dx12_edit_terrain") === "write_file" && eff("dx12_imgui") === "runtime" && eff("dx12_capture") === "read");
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: tools/list 表面テスト ${total} 項目すべて通過`);
process.exit(0);
