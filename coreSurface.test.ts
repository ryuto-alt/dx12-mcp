// core 面(DX12_MCP_SURFACE=core)の stdio 一巡テスト。偽エンジン(TCP)に繋ぎ、実際の MCP クライアントと同じ経路で確かめる。
//   [1] initialize / tools/list(instructions・capabilities・40 本)
//   [2] Core ツールの直接呼び出し(旧ツールのまま入るもの)と、統合ツール(描画設定 / 地形 / imgui / capture の振り分け)
//   [3] 旧ツール名の alias(dx12_call で旧名・引数のまま動く。full 面の直接呼び出しと返り値が同一)
//   [4] guarded: dx12_call は E_GUARDED(confirm:true でも通らない)/ dx12_call_guarded は dryRun と実行 / batch は guarded を通さない
//   [5] 動的登録: エンジンに expose:"core" の method を足すと、再起動なしで tools/list に出て list_changed が飛ぶ(消すと外れる)。
//       DX12_MCP_LIST_CHANGED=0 では出ない(それでも dx12_call では使える)
// 実行: node coreSurface.test.ts

import { startMockEngine, type MockMethod } from "./mockEngine.ts";
import { startMcp } from "./stdioClient.ts";

let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const simple = (name: string, effect: MockMethod["effect"], result: unknown = { ok: true }, params: MockMethod["params"] = []): MockMethod =>
  ({ name, category: "test", summary: `mock ${name}`, keywords: name, effect, mode: "any", timeoutMs: 8000, params, source: "meta", handler: () => result } as MockMethod);

const RENDER = ["post_process", "ssao", "ssr", "ssgi", "taa", "volumetric_fog", "shadow_pcss", "dxr", "contact_shadow", "occlusion", "depth_prepass", "normal_filter", "render_scale", "scene_settings"];
const methods: MockMethod[] = [
  ...RENDER.filter((t) => t !== "ssao").flatMap((t) => [simple(`get_${t}`, "read", { target: t, enabled: true }), simple(`set_${t}`, "write_setting", { applied: true })]),
  simple("perf_stats", "read", { fps: 144, frameMs: { avg: 6.9 } }, [{ name: "window", type: "int" }]),
  simple("benchmark", "runtime", { frames: 300, fps: 143 }, [{ name: "frames", type: "int" }, { name: "uncap", type: "bool" }]),
  simple("terrain_sculpt", "write_file", { sculpted: true }),
  simple("imgui_find", "read", { windows: [] }),
];

const mock = await startMockEngine({ methods });
const env = { DX12_MCP_PORT: String(mock.port) };
const core = startMcp({ ...env, DX12_MCP_SURFACE: "core" });
const full = startMcp({ ...env, DX12_MCP_SURFACE: "full" });

try {
  console.log("[1] initialize / tools/list");
  const init = await core.initialize();
  await full.initialize();
  check("initialize: instructions に dx12_call_guarded と Core の主要ツール", typeof init.instructions === "string" && init.instructions.includes("dx12_call_guarded") && init.instructions.includes("dx12_capture") && init.instructions.length <= 2048, init.instructions?.length);
  check("capabilities.tools.listChanged が true(動的登録の前提)", init.capabilities?.tools?.listChanged === true, init.capabilities);
  const doc = await core.call("dx12_doctor", {});
  check("dx12_doctor が surface:core・listChanged:true・core ツール数を報告", doc.tsServer?.surface === "core" && doc.tsServer?.listChanged === true && doc.tsServer?.toolset === "core" && doc.tsServer?.tools?.core >= 29, doc.tsServer);
  const tools = (await core.rpc("tools/list")).result.tools;
  check("tools/list は 40 本(shell 5 + フリート 5 + Core 28 + batch + call_guarded)", tools.length === 40, tools.length);
  const byName = new Map<string, any>(tools.map((t: any) => [t.name, t]));

  console.log("[2] Core ツールの直接呼び出し");
  const le = await core.call("dx12_list_entities", {});
  check("dx12_list_entities(旧ツールのまま Core)", le.count === 5 && le.entities[0].name === "Player", le);
  const st = await core.call("dx12_set_transform", { name: "Player", position: [0, 1, 0] });
  check("dx12_set_transform", st.applied === true, st);
  const badName = await core.raw("dx12_get_entity", { name: "Plyer" });
  check("直接呼びのエラーは従来の本文(1 ブロック目)+ 構造化 JSON(2 ブロック目)", badName.isError === true && badName.content.length === 2 && /Plyer/.test(badName.content[0].text) && JSON.parse(badName.content[1].text).error_code === "E_NOT_FOUND_ENTITY" && JSON.parse(badName.content[1].text).didYouMean?.[0] === "Player", badName.content.map((c: any) => c.text?.slice(0, 120)));

  // 統合ツール
  const setSsao = await core.call("dx12_set_render_settings", { target: "ssao", values: { intensity: 0.5 } });
  check("dx12_set_render_settings {target:'ssao', values} → 旧 dx12_set_ssao と同じ返り値(applied / current)", setSsao.applied !== undefined && setSsao.requestedKeys?.[0] === "intensity", setSsao);
  check("その呼び出しはエンジンの set_ssao → get_ssao(読み返し)で実行された", mock.received.some((r) => r.method === "set_ssao" && r.params.intensity === 0.5) && mock.received.some((r) => r.method === "get_ssao"));
  const getFog = await core.call("dx12_get_render_settings", { target: "volumetric_fog" });
  check("dx12_get_render_settings {target} → 旧 dx12_get_volumetric_fog", getFog.target === "volumetric_fog", getFog);
  const all = await core.call("dx12_get_render_settings", {});
  check("target 省略 → 14 target をまとめて読む(1 つ失敗しても残りは返る)", Object.keys(all.targets ?? {}).length + Object.keys(all.errors ?? {}).length === 14 && all.targets.ssr?.target === "ssr", all);
  const badTarget = await core.raw("dx12_set_render_settings", { target: "ssoa", values: {} });
  const bt = JSON.parse(badTarget.content[badTarget.content.length - 1].text);   // SDK の enum 検証エラーは本文の後ろに構造化 JSON が付く
  check("target の打ち間違い → E_BAD_ENUM + didYouMean + 撃ち直し(統合ツールの形)", badTarget.isError && bt.error_code === "E_BAD_ENUM" && bt.didYouMean?.[0] === "ssao" && bt.fix?.[0]?.tool === "dx12_set_render_settings" && bt.fix[0].args.target === "ssao", bt);
  const badKey = await core.raw("dx12_set_render_settings", { target: "ssao", values: { intensty: 1 } });
  const bk = JSON.parse(badKey.content[0].text);
  check("values の打ち間違い → E_UNKNOWN_PARAM(旧ツールの検証)+ fix は統合ツールの形", badKey.isError && bk.error_code === "E_UNKNOWN_PARAM" && bk.fix?.[0]?.tool === "dx12_set_render_settings" && bk.fix[0].args.values?.intensity === 1, bk);
  const flat = await core.call("dx12_set_render_settings", { target: "ssao", intensity: 0.7 });
  check("values を省略して旧引数をフラットに渡しても通る(往復を無駄にしない)", flat.applied !== undefined, flat);
  const perf = await core.call("dx12_get_perf", {});
  check("dx12_get_perf(既定 snapshot)→ 旧 dx12_perf_stats", perf.fps === 144, perf);
  const bench = await core.call("dx12_get_perf", { frames: 300 });
  check("dx12_get_perf {frames} → benchmark に振り分け(mode 省略時の推測)", bench.frames === 300, bench);
  const terr = await core.call("dx12_edit_terrain", { op: "generate", preset: "hills" });
  check("dx12_edit_terrain {op:'generate'} → 旧 dx12_terrain_generate", terr.generated === true, terr);
  const terr2 = await core.raw("dx12_edit_terrain", { op: "generate", presett: "hills" });
  const t2 = JSON.parse(terr2.content[0].text);
  check("op の引数の打ち間違い → E_UNKNOWN_PARAM + fix は dx12_edit_terrain {op, …} の形", terr2.isError && t2.error_code === "E_UNKNOWN_PARAM" && t2.fix?.[0]?.tool === "dx12_edit_terrain" && t2.fix[0].args.op === "generate" && t2.fix[0].args.preset === "hills", t2);
  const terr3 = await core.raw("dx12_edit_terrain", {});
  check("op が無い → E_MISSING_PARAM", JSON.parse(terr3.content[terr3.content.length - 1].text).error_code === "E_MISSING_PARAM", terr3.content.map((c: any) => c.text?.slice(0, 200)));
  const ig = await core.call("dx12_imgui", { op: "pointer", action: "click", x: 10, y: 20 });
  check("dx12_imgui {op:'pointer'} → 旧 dx12_imgui_pointer(仮想入力モードのエンジンへ)", ig.ok === true && mock.received.some((r) => r.method === "imgui_pointer" && r.params.x === 10), ig);
  const capBad = await core.raw("dx12_capture", { view: "finl" });
  const cb = JSON.parse(capBad.content[capBad.content.length - 1].text);
  check("dx12_capture {view:'finl'} → E_BAD_ENUM + didYouMean final", cb.error_code === "E_BAD_ENUM" && cb.didYouMean?.[0] === "final", cb);
  const descCap = await core.call("dx12_tool_describe", { name: "dx12_capture", target: "from" });
  check("dx12_tool_describe {dx12_capture, target:'from'} → 振り分け先(dx12_screenshot_from)の引数と callTemplate", descCap.routedTo === "dx12_screenshot_from" && descCap.callTemplate.args.view === "from" && descCap.params.some((p: any) => p.name === "position"), descCap);
  const descSet = await core.call("dx12_tool_describe", { name: "dx12_set_render_settings", target: "ssao" });
  check("dx12_tool_describe {dx12_set_render_settings, target:'ssao'} → set_ssao の引数(values に入れる)", descSet.routedTo === "dx12_set_ssao" && descSet.params.some((p: any) => p.name === "intensity") && descSet.callTemplate.args.values !== undefined, descSet);
  const descOld = await core.call("dx12_tool_describe", { name: "dx12_set_ssao" });
  check("旧名の describe は replacedBy(統合ツールでの呼び方)を案内する", descOld.replacedBy?.tool === "dx12_set_render_settings" && descOld.replacedBy.call?.args?.target === "ssao" && descOld.tier === "legacy", descOld.replacedBy);

  console.log("[3] 旧ツール名の alias(core 面でも dx12_call で旧名・旧引数のまま)");
  const viaCall = await core.call("dx12_call", { name: "dx12_get_entity", args: { name: "Player" } });
  const directFull = await full.call("dx12_get_entity", { name: "Player" });
  check("dx12_call {dx12_get_entity}(core 面)の result が full 面の直接呼びと同一", viaCall.ok === true && JSON.stringify(viaCall.result) === JSON.stringify(directFull), { viaCall, directFull });
  const viaCall2 = await core.call("dx12_call", { name: "dx12_set_ssao", args: { intensity: 0.4 } });
  const directFull2 = await full.call("dx12_set_ssao", { intensity: 0.4 });
  check("dx12_call {dx12_set_ssao}(core 面・隠れた旧ツール)の result が full 面の直接呼びと同一", viaCall2.ok === true && JSON.stringify(viaCall2.result) === JSON.stringify(directFull2), { viaCall2, directFull2 });
  const viaConsolidated = await core.call("dx12_call", { name: "dx12_set_render_settings", args: { target: "ssao", values: { intensity: 0.4 } } });
  check("dx12_call {dx12_set_render_settings} も同じ結果(meta.via に統合ツール名)", viaConsolidated.ok === true && JSON.stringify(viaConsolidated.result) === JSON.stringify(directFull2) && viaConsolidated.meta.via === "dx12_set_render_settings", viaConsolidated);
  const undo = await core.call("dx12_call", { name: "dx12_undo", args: {} });
  check("長尾の旧ツール(dx12_undo)も dx12_call で動く", undo.ok === true, undo);
  const legacyNames: string[] = (await import("./legacy-tools.snapshot.json", { with: { type: "json" } })).default.tools.map((t: any) => t.name);
  let described = 0; const undescribed: string[] = [];
  for (const n of legacyNames) { const d = await core.call("dx12_tool_describe", { name: n }); if (d.name === n && d.callTemplate?.name === n && d.tier === "legacy") described++; else undescribed.push(n); }
  check(`旧 220 名すべてが core 面の dx12_tool_describe で引け、callTemplate が同名(${described}/220)`, described === 220, undescribed.slice(0, 10));
  const hidden = legacyNames.filter((n) => !byName.has(n));
  check("core 面の tools/list に出ない旧名は 201 本(それでも上の通り解決できる。Core に同名で入る旧ツールは 19 本。dx12_play_script は M7 で、dx12_scene_write は M11 で長尾へ)", hidden.length === 220 - 19, hidden.length);

  console.log("[4] guarded");
  const g1 = await core.call("dx12_call", { name: "dx12_git_push", args: {}, confirm: true });
  check("dx12_call {dx12_git_push, confirm:true} は core 面では E_GUARDED(dx12_call_guarded を案内)", g1.error_code === "E_GUARDED" && g1.fix?.some((f: any) => f.tool === "dx12_call_guarded") && !mock.received.some((r) => r.method === "git_push"), g1);
  const g2 = await core.call("dx12_call_guarded", { name: "dx12_git_push", args: {}, dryRun: true });
  check("dx12_call_guarded {dryRun:true} は実行せず影響だけ返す", g2.dryRun === true && g2.executed === false && !mock.received.some((r) => r.method === "git_push"), g2);
  const g3 = await core.call("dx12_call_guarded", { name: "dx12_git_push", args: {} });
  check("dx12_call_guarded は guarded を実行する(承認はクライアント側の requiresUserInteraction)", g3.ok === true && mock.received.some((r) => r.method === "git_push"), g3);
  const g4 = await core.call("dx12_call_guarded", { name: "dx12_set_transform", args: { name: "Player" } });
  check("dx12_call_guarded は guarded でない操作を実行しない(dx12_call へ誘導)", g4.error_code === "E_INVALID_PARAM" && g4.fix?.[0]?.tool === "dx12_call", g4);
  const before = mock.received.length;
  const g5 = await core.call("dx12_batch", { ops: [{ method: "set_transform", params: { name: "Player", position: [1, 1, 1] } }, { method: "eval_lua", params: { code: "print(1)" } }] });
  check("dx12_batch は guarded な op(eval_lua)が混じると 1 つも実行せず E_GUARDED", g5.error_code === "E_GUARDED" && !mock.received.slice(before).some((r) => ["eval_lua", "set_transform", "transaction_begin"].includes(r.method)), g5);
  const g6 = await full.call("dx12_call", { name: "dx12_git_push", args: {}, confirm: true });
  check("full 面の dx12_call は従来どおり confirm:true で通る(互換)", g6.ok === true, g6);
  const vl = await core.call("dx12_call", { name: "dx12_validate_layout", args: { fix: "safe" }, dryRun: true });
  check("dryRun は validate_layout {fix:'safe'}(書き込む)を実行しない", vl.dryRun === true && vl.executed === false && !mock.received.some((r) => r.method === "validate_layout"), vl);

  console.log("[5] 動的登録(expose:'core')");
  let idx = core.notifications.length;
  const t0 = (await core.rpc("tools/list")).result.tools.length;
  mock.addMethod({
    name: "make_fog_bank", category: "render", summary: "霧の塊を置く(テスト用の新 method)", keywords: "fog bank mist 霧", effect: "write_scene", mode: "any", timeoutMs: 4000,
    idempotent: true, expose: "core",
    params: [{ name: "name", type: "string", required: true, desc: "作る霧の名前" }, { name: "density", type: "number", min: 0, max: 5, default: 1, desc: "濃さ" }],
    examples: [{ args: { name: "Fog1" } }], source: "meta",
    handler: (p: any) => ({ created: p.name, density: p.density ?? 1 }),
  } as any);
  mock.addMethod({ name: "wipe_everything", category: "meta", summary: "guarded なのに expose:core(昇格してはいけない)", effect: "guarded", expose: "core", params: [], source: "meta", handler: () => ({ wiped: true }) } as any);
  mock.dropConnections();   // エンジンを再ビルド・再起動した状態(次の呼び出しで再接続 → マニフェストを取り直す)
  await sleep(100);
  const ping = await core.call("dx12_ping", {}).catch(() => null);   // core 面では隠れた旧ツール。直接は呼べない(未知ツール)ので dx12_call から
  await core.call("dx12_call", { name: "dx12_ping", args: {} });
  const gotNote = await core.waitForNotification("notifications/tools/list_changed", idx, 4000);
  check("再接続だけで notifications/tools/list_changed が飛ぶ(MCP サーバは再起動していない)", gotNote, core.notifications.slice(idx));
  const tools2 = (await core.rpc("tools/list")).result.tools;
  const fb = tools2.find((t: any) => t.name === "dx12_make_fog_bank");
  check(`tools/list に dx12_make_fog_bank が増える(${t0} → ${tools2.length} 本)`, !!fb && tools2.length === t0 + 1, tools2.map((t: any) => t.name).slice(-3));
  check("動的ツールの説明は Core テンプレ(600 字以内・副作用・次)で、inputSchema はマニフェストから生成(必須・範囲)", !!fb && fb.description.length <= 600 && /副作用/.test(fb.description) && fb.inputSchema.required?.includes("name") && fb.inputSchema.properties.density.maximum === 5, fb);
  check("guarded な method は expose:'core' でも昇格しない", !tools2.some((t: any) => t.name === "dx12_wipe_everything"));
  const dyn = await core.call("dx12_make_fog_bank", { name: "Fog1", density: 3 });
  check("動的ツールを直接呼べる(返り値はエンジンの result)", dyn.created === "Fog1" && dyn.density === 3, dyn);
  const dynBad = await core.raw("dx12_make_fog_bank", { name: "Fog1", density: 9 });
  check("動的ツールも zod で範囲検証される(density>5 は弾く)", dynBad.isError === true);
  const viaCallDyn = await core.call("dx12_call", { name: "make_fog_bank", args: { name: "Fog2" } });
  check("dx12_call {make_fog_bank} でも動く(list_changed に依存しない主経路)", viaCallDyn.ok === true && viaCallDyn.result.created === "Fog2", viaCallDyn);
  const s = await core.call("dx12_tool_search", { query: "霧の塊", tier: "core" });
  check("dx12_tool_search {tier:'core'} が動的ツールを Core として返す", s.hits[0]?.name === "dx12_make_fog_bank" && s.hits[0].tier === "core", s.hits?.map((h: any) => `${h.name}:${h.tier}`));
  idx = core.notifications.length;
  mock.removeMethod("make_fog_bank");
  mock.dropConnections();
  await sleep(100);
  await core.call("dx12_call", { name: "dx12_ping", args: {} });
  const gotNote2 = await core.waitForNotification("notifications/tools/list_changed", idx, 4000);
  const tools3 = (await core.rpc("tools/list")).result.tools;
  check("エンジンから method が消えたら tools/list からも外れ、再び list_changed が飛ぶ", gotNote2 && !tools3.some((t: any) => t.name === "dx12_make_fog_bank") && tools3.length === t0, tools3.length);
  check("同じ MCP サーバのプロセスのまま(再起動していない)", core.proc.exitCode === null);
  check("tools/list の並びは決定的(shell → Core の固定順 → 動的は名前順)", JSON.stringify(tools3.map((t: any) => t.name).slice(0, 5)) === JSON.stringify(["dx12_tool_search", "dx12_tool_describe", "dx12_call", "dx12_doctor", "dx12_guide"]));
  void ping;

  console.log("[5b] 既存の(core 面では隠れている)旧ツールを expose:'core' で昇格する");
  {
    const i0 = core.notifications.length;
    mock.addMethod({ ...simple("get_taa", "read", { target: "taa", enabled: true }), expose: "core" } as any);
    mock.dropConnections();
    await sleep(100);
    await core.call("dx12_call", { name: "dx12_ping", args: {} });
    const noted3 = await core.waitForNotification("notifications/tools/list_changed", i0, 4000);
    const l1 = (await core.rpc("tools/list")).result.tools;
    const taa = l1.find((t: any) => t.name === "dx12_get_taa");
    check("旧ツール dx12_get_taa(TS ラッパあり)が tools/list に出る(旧ツールのスキーマのまま)+ list_changed", noted3 && !!taa && taa.annotations?.readOnlyHint === true && l1.length === t0 + 1, l1.length);
    const i1 = core.notifications.length;
    mock.addMethod(simple("get_taa", "read", { target: "taa", enabled: true }));   // expose を外す
    mock.dropConnections();
    await sleep(100);
    await core.call("dx12_call", { name: "dx12_ping", args: {} });
    const noted4 = await core.waitForNotification("notifications/tools/list_changed", i1, 4000);
    const l2 = (await core.rpc("tools/list")).result.tools;
    check("expose を外すと再び隠れる(dx12_call では引き続き使える)", noted4 && !l2.some((t: any) => t.name === "dx12_get_taa") && l2.length === t0, l2.length);
    const viaCall = await core.call("dx12_call", { name: "dx12_get_taa", args: {} });
    check("隠れた後も dx12_call {dx12_get_taa} は動く", viaCall.ok === true, viaCall);
  }

  console.log("[6] DX12_MCP_LIST_CHANGED=0: 動的登録を止める(dx12_call の主経路は動く)");
  const off = startMcp({ ...env, DX12_MCP_SURFACE: "core", DX12_MCP_LIST_CHANGED: "0" });
  try {
    await off.initialize();
    const n0 = (await off.rpc("tools/list")).result.tools.length;
    mock.addMethod({ name: "make_mist", category: "render", summary: "霧(2 個目のテスト method)", effect: "write_scene", expose: "core", params: [], source: "meta", handler: () => ({ made: true }) } as any);
    mock.dropConnections();
    await sleep(100);
    const i0 = off.notifications.length;
    await off.call("dx12_call", { name: "dx12_ping", args: {} });
    const noNote = !(await off.waitForNotification("notifications/tools/list_changed", i0, 1500));
    const n1 = (await off.rpc("tools/list")).result.tools.length;
    check("list_changed を送らず tools/list も変えない", noNote && n1 === n0, { n0, n1 });
    const d = await off.call("dx12_tool_describe", { name: "make_mist" });
    const r = await off.call("dx12_call", { name: "make_mist", args: {} });
    check("それでも dx12_tool_describe / dx12_call で使える(再起動不要)", d.kind === "method" && r.ok === true && r.result.made === true, { d: d.kind, r });
  } finally { off.close(); }
} finally {
  core.close(); full.close();
  await mock.close();
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: core 面の stdio テスト ${total} 項目すべて通過`);
process.exit(0);
