// shell 5 本(dx12_tool_search / describe / call / doctor / guide)のテスト。偽エンジンだけを使う(実エンジン不要)。
//   [1] 検索/describe/call/dryRun/guarded/doctor/guide(プロセス内)
//   [2] 全ツールの callTemplate がそのまま事前検証を通る(100%)
//   [3] stdio の MCP クライアントで一巡(initialize → tools/list → search → describe → call → 誤った呼び出し → doctor)
// 実行: node shell.test.ts

import "./testEnv.ts";   // フリートのレジストリを一時フォルダへ隔離(実ユーザーの %LOCALAPPDATA% を触らない)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startMockEngine } from "./mockEngine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`); }
}
const parse = (r: any) => JSON.parse(r.content[r.content.length - 1].text);

// ── [1] プロセス内 ───────────────────────────────────────────────────
const mock = await startMockEngine({
  methods: [{
    name: "mock_spin", category: "test", summary: "テスト用: 回転させる", keywords: "spin rotate 回転", effect: "write_scene", mode: "any",
    timeoutMs: 5000, params: [{ name: "name", type: "string", required: true }, { name: "speed", type: "number", min: 0, max: 10, default: 1 }],
    examples: [{ args: { name: "Player", speed: 2 }, note: "Player を回す" }], source: "meta",
    handler: (p: any) => ({ spinning: p.name, speed: p.speed ?? 1 }),
  } as any],
});
process.env.DX12_MCP_PORT = String(mock.port);
await import("./toolset/all.ts");
const { shell, manifestStore } = await import("./toolset/shell.ts");
const { TOOL_REGISTRY } = await import("./toolRuntime.ts");
const { validateAgainstShape, validateAgainstParams } = await import("./validate.ts");
const { INSTRUCTIONS } = await import("./instructions.ts");

console.log("[1] shell 5 本(プロセス内・偽エンジン)");
{
  const r = parse(await shell.search({ query: "spin" }));
  check("search: 新しいエンジン method(mock_spin)が旧ツールと同じ一覧に出る(TS 無改修)", r.hits.some((h: any) => h.name === "mock_spin"), r.hits.map((h: any) => h.name));
  check("search: hits に name/summary/category/effect/mode/example/score", r.hits[0] && ["name", "summary", "category", "effect", "mode", "example", "score"].every((k) => k in r.hits[0]), r.hits[0]);
  check("search: catalog に manifest の取得元が出る", r.catalog?.source === "live" && r.catalog.engineMethods > 20, r.catalog);
  const eff = parse(await shell.search({ query: "screenshot", effect: "read" }));
  check("search: effect フィルタ(read)", eff.hits.length > 0 && eff.hits.every((h: any) => h.effect === "read"), eff.hits.map((h: any) => `${h.name}:${h.effect}`));
  const none = parse(await shell.search({ query: "zzzqqq" }));
  check("search: 0 件のときは didYouMean/categories/hint を返す", none.hits.length === 0 && Array.isArray(none.categories) && !!none.hint, none);
  const old = parse(await shell.search({ query: "set_ssao" }));
  check("search: 旧ツール名でもヒット(先頭)", old.hits[0]?.name === "dx12_set_ssao", old.hits.map((h: any) => h.name));
  const cat = parse(await shell.search({ query: "ライト", category: "lighting" }));
  check("search: category フィルタ", cat.hits.length > 0 && cat.hits.every((h: any) => h.category === "lighting"), cat.hits.map((h: any) => `${h.name}:${h.category}`));
}
{
  const d = parse(await shell.describe({ name: "dx12_set_transform" }));
  check("describe: 旧ツールの引数・副作用・callTemplate", d.name === "dx12_set_transform" && Array.isArray(d.params) && d.callTemplate?.name === "dx12_set_transform" && d.effect && d.timeoutMs, d);
  const d2 = parse(await shell.describe({ name: "set_transform" }));
  check("describe: dx12_ 無しの名前でも引ける", d2.name === "dx12_set_transform");
  const d3 = parse(await shell.describe({ name: "mock_spin" }));
  check("describe: TS ラッパの無いエンジン method(型・必須・範囲・例・callTemplate)", d3.kind === "method" && d3.params.find((p: any) => p.name === "speed")?.max === 10 && d3.examples[0]?.args?.name === "Player" && d3.callTemplate.args.name, d3);
  const big = parse(await shell.describe({ name: "dx12_set_post_process" }));
  check("describe: 引数が多いツールは名前:型だけ、target で説明つきに絞れる", Array.isArray(big.params) && typeof big.params[0] === "string" && big.note?.includes("target"), big.params?.slice(0, 2));
  const bl = parse(await shell.describe({ name: "dx12_set_post_process", target: "bloom" }));
  check("describe: target 絞り込み", bl.params.length > 0 && bl.params.length < 20 && bl.params.every((p: any) => typeof p === "object"), bl.params?.length);
  const unk = await shell.describe({ name: "dx12_set_ssoa" });
  const ub = parse(unk);
  check("describe: 未知の名前は E_UNKNOWN_TOOL + didYouMean(dx12_set_ssao) + fix", (unk as any).isError && ub.error_code === "E_UNKNOWN_TOOL" && ub.didYouMean?.[0] === "dx12_set_ssao" && ub.fix?.length > 0, ub);
}
{
  const r = parse(await shell.call({ name: "dx12_get_entity", args: { name: "Player" } }));
  check("call: 旧ツール名で実行 → {ok:true, result, meta}", r.ok === true && r.result?.name === "Player" && r.meta?.tool === "dx12_get_entity" && typeof r.meta.tookMs === "number", r);
  const r2 = parse(await shell.call({ name: "get_entity", args: { name: "Player" } }));
  check("call: dx12_ 無しでも実行できる", r2.ok === true);
  const r3 = parse(await shell.call({ name: "mock_spin", args: { name: "Player", speed: 3 } }));
  check("call: TS ラッパの無い新 method を再起動なしで実行", r3.ok === true && r3.result.spinning === "Player" && r3.result.speed === 3, r3);
  const bad = await shell.call({ name: "mock_spin", args: { name: "Player", speed: 99 } });
  const bb = parse(bad);
  check("call: 範囲外は往復せず E_OUT_OF_RANGE(マニフェストの max)+ 直した引数", (bad as any).isError && bb.error_code === "E_OUT_OF_RANGE" && bb.fix?.[0]?.args?.speed === 10, bb);
  const before = mock.received.length;
  const bad2 = parse(await shell.call({ name: "mock_spin", args: { speed: 2 } }));
  check("call: 必須引数の欠落 E_MISSING_PARAM(エンジンへは送らない)", bad2.error_code === "E_MISSING_PARAM" && mock.received.length === before, bad2);
  const unk = parse(await shell.call({ name: "dx12_screnshot_final", args: {} }));
  check("call: 未知ツール名は didYouMean[0] が正解", unk.error_code === "E_UNKNOWN_TOOL" && unk.didYouMean?.[0] === "dx12_screenshot_final", unk);
  const j = parse(await shell.call({ name: "dx12_find_entity", args: JSON.stringify({ name: "Floor" }) as any }));
  check("call: args が JSON 文字列でも受ける", j.ok === true, j);
}
{
  const before = mock.received.filter((x) => x.method === "set_transform").length;
  const r = parse(await shell.call({ name: "dx12_set_transform", args: { name: "Wall_01", position: [0, 1, 0] }, dryRun: true }));
  const after = mock.received.filter((x) => x.method === "set_transform").length;
  check("dryRun: 書き込み系は実行しない(エンジンに set_transform が届かない)", r.ok === true && r.dryRun === true && r.executed === false && before === after, r);
  check("dryRun: 対象の存在・Undo 可否・破壊性を返す", r.preview?.targets?.[0]?.exists === true && /Undo/.test(r.preview.undoable) && r.preview.destructive === false && r.preview.supported, r.preview);
  const miss = parse(await shell.call({ name: "dx12_delete_entity", args: { name: "Wal_01" }, dryRun: true }));
  check("dryRun: 存在しない対象は exists:false + didYouMean + 警告", miss.preview?.targets?.[0]?.exists === false && miss.preview.targets[0].didYouMean?.[0] === "Wall_01" && miss.preview.destructive === true, miss);
  const rd = parse(await shell.call({ name: "dx12_list_entities", args: {}, dryRun: true }));
  check("dryRun: 読み取り系はそのまま実行される(dryRun:ignored を明示)", rd.ok === true && String(rd.dryRun).includes("ignored"), rd.dryRun);
}
{
  const g = await shell.call({ name: "dx12_git_push", args: {} });
  const gb = parse(g);
  check("guarded: confirm 無しは E_GUARDED(エンジンへ送らない)+ dryRun/confirm の fix", (g as any).isError && gb.error_code === "E_GUARDED" && gb.fix?.some((f: any) => f.args?.confirm === true) && !mock.received.some((x) => x.method === "git_push"), gb);
  const gd = parse(await shell.call({ name: "dx12_git_push", args: {}, dryRun: true }));
  check("guarded: dryRun は実行せず影響を返す", gd.ok === true && gd.executed === false && gd.preview?.destructive === true && !mock.received.some((x) => x.method === "git_push"), gd);
  const gc = parse(await shell.call({ name: "dx12_git_push", args: {}, confirm: true }));
  check("guarded: confirm:true で実行", gc.ok === true && mock.received.some((x) => x.method === "git_push"), gc);
  const ev = parse(await shell.call({ name: "dx12_eval_lua", args: { code: "return 1" } }));
  check("guarded: eval_lua も confirm が要る", ev.error_code === "E_GUARDED", ev);
}
{
  mock.state.sceneDirty = true;
  const w = parse(await shell.call({ name: "dx12_open_scene", args: { path: "scenes/level1.json" } }));
  check("警告: 未保存の変更を消す操作(open_scene)は meta.warnings に sceneDirty を出す", w.ok === true && /未保存/.test(w.meta?.warnings?.[0] ?? ""), w.meta);
  mock.state.sceneDirty = false;
}
{
  // shell ツール自身の未知キーは黙って捨てない(dry_run の打ち間違いで書き込みが実行される事故を防ぐ)
  const before = mock.received.length;
  const entry = TOOL_REGISTRY.get("dx12_call")!;
  const r = await entry.invoke({ name: "dx12_set_transform", args: { name: "Floor", position: [0, 0, 0] }, dry_run: true });
  const rb = JSON.parse(r.content[0].text);
  check("shell: 未知キー(dry_run)は E_UNKNOWN_PARAM + didYouMean(dryRun)で、エンジンには何も送らない", r.isError === true && rb.error_code === "E_UNKNOWN_PARAM" && rb.didYouMean?.[0] === "dryRun" && mock.received.length === before, rb);
  const idem = parse(await shell.call({ name: "dx12_spawn_model", args: { path: "models/tree.glb" }, idempotency_key: "k-123" }));
  check("call: idempotency_key を旧ツール(宣言あり)にも渡す", idem.ok === true && mock.received.some((x) => x.method === "spawn_model" && x.params.idempotency_key === "k-123"), idem);
}
{
  const s = await shell.call({ name: "dx12_tool_search", args: { query: "x" } });
  check("call: shell ツールは dx12_call 経由で呼べない(理由つき)", (s as any).isError && parse(s).error_code === "E_INVALID_PARAM");
  const g = shell.guide({});
  const gj = parse(g);
  check("guide: トピック一覧(9 件)", gj.topics.length >= 9 && ["build_scene", "test", "lighting", "ui", "editor", "safety", "errors", "perf", "engine_dev"].every((t) => gj.topics.some((x: any) => x.id === t)), gj.topics.map((t: any) => t.id));
  const gb = shell.guide({ topic: "safety" });
  const text = (gb.content[0] as any).text as string;
  check("guide: 本文 Markdown(6 KB 以内・仮想入力/危険操作の記述)", text.startsWith("#") && Buffer.byteLength(text) <= 6144 && /--background/.test(text) && /confirm/.test(text), Buffer.byteLength(text));
  const gs = shell.guide({ topic: "safty" });
  check("guide: 未知トピックは validValues + didYouMean", (gs as any).isError && parse(gs).didYouMean?.[0] === "safety", parse(gs));
  for (const t of gj.topics) {
    const b = Buffer.byteLength((shell.guide({ topic: t.id }).content[0] as any).text);
    // scene_spec だけは例 5 本(実際に適用して確かめた仕様)を載せるので 24 KB まで(他のトピックは 6 KB)。
    if (b > (t.id === "scene_spec" ? 24 * 1024 : 6144)) check(`guide: ${t.id} が ${t.id === "scene_spec" ? "24" : "6"} KB を超えない`, false, b);
  }
  check("instructions: 2,048 字以内・shell 5 本と最重要ルールを含む", INSTRUCTIONS.length <= 2048 && ["dx12_tool_search", "dx12_tool_describe", "dx12_call", "dx12_doctor", "dx12_guide", "--background", "confirm"].every((k) => INSTRUCTIONS.includes(k)), INSTRUCTIONS.length);
}
{
  const d = parse(await shell.doctor({}));
  check("doctor: 接続できているとき ok:true・エンジン情報・版・マニフェスト", d.ok === true && d.engine.connected === true && d.engine.manifestHash === mock.manifestHash() && d.versions.manifestSource === "live" && d.versions.hashMatch === true, d);
  check("doctor: ports / process / tsServer / issues を返す", d.ports?.target === mock.port && Array.isArray(d.issues) && d.tsServer?.tools?.total > 200, d.tsServer);
}

console.log("[2] 全ツールの callTemplate が事前検証を通る");
{
  await shell.refresh(true);
  const docs = shell.catalog.docs.filter((d) => d.kind !== "shell");
  const { templateArgs } = await import("./shellRuntime.ts");
  const bad: string[] = [];
  for (const doc of docs) {
    const args = templateArgs(doc.params);
    const entry = TOOL_REGISTRY.get(doc.id);
    const v = entry ? validateAgainstShape(entry.name, entry.shape, args)
      : validateAgainstParams(doc.method ?? doc.id, manifestStore.get(doc.method ?? doc.id)?.params ?? [], args);
    if (!v.ok) bad.push(`${doc.id}: ${(v as any).body.message}`);
  }
  check(`callTemplate: ${docs.length} 件すべて事前検証を通る`, bad.length === 0, bad.slice(0, 8));
  check("カタログ: 旧 220 ツールが全部引ける", TOOL_REGISTRY.size >= 225 && shell.catalog.docs.filter((d) => d.tier === "legacy").length === 220, shell.catalog.docs.filter((d) => d.tier === "legacy").length);
}

// ── [3] stdio e2e ─────────────────────────────────────────────────────
console.log("[3] stdio の MCP クライアントで一巡");
{
  const proc = spawn(process.execPath, [path.join(here, "index.ts")], { env: { ...process.env, DX12_MCP_PORT: String(mock.port) }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; let nid = 1; const pend = new Map<number, (m: any) => void>();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; const m = JSON.parse(l); pend.get(m.id)?.(m); } });
  const rpc = (method: string, params: any = {}) => new Promise<any>((res, rej) => { const id = nid++; const t = setTimeout(() => rej(new Error("timeout " + method)), 30000); pend.set(id, (m) => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shell.test", version: "0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    check("initialize: instructions が載る(2,048 字以内)", typeof init.result.instructions === "string" && init.result.instructions.length <= 2048 && init.result.instructions.includes("dx12_tool_search"), init.result.instructions?.length);
    const list = (await rpc("tools/list")).result.tools;
    const names = list.map((t: any) => t.name);
    check("tools/list: 先頭 5 本が shell(alwaysLoad)で、旧 220 本が続く", JSON.stringify(names.slice(0, 5)) === JSON.stringify(["dx12_tool_search", "dx12_tool_describe", "dx12_call", "dx12_doctor", "dx12_guide"]) && list.slice(0, 5).every((t: any) => t._meta?.["anthropic/alwaysLoad"] === true) && list.length === 252 /* shell 5 + 旧 220 + フリート 6 + ジョブ 6 + パストレーサー 3 + 仮想ジオメトリ 2 + lua_step 1 + oracle 1 + blender_place 1 + エディタ操作 5 + シーン仕様 2 */, { n: list.length });
    check("tools/list: shell の outputSchema が無い/alwaysLoad は shell だけ", list.slice(0, 5).every((t: any) => !t.outputSchema) && list.slice(5).every((t: any) => !t._meta), null);
    const call = async (name: string, args: any) => (await rpc("tools/call", { name, arguments: args })).result;
    const sr = await call("dx12_tool_search", { query: "元に戻す" });
    check("e2e: dx12_tool_search", JSON.parse(sr.content[0].text).hits[0]?.name === "dx12_undo", sr.content[0].text.slice(0, 200));
    const dr = await call("dx12_tool_describe", { name: "dx12_undo" });
    check("e2e: dx12_tool_describe", JSON.parse(dr.content[0].text).callTemplate?.name === "dx12_undo");
    const cr = await call("dx12_call", { name: "dx12_get_entity", args: { name: "Floor" } });
    check("e2e: dx12_call(read)", JSON.parse(cr.content[0].text).ok === true);
    const dry = await call("dx12_call", { name: "dx12_set_transform", args: { name: "Floor", position: [0, 0, 0] }, dryRun: true });
    check("e2e: dx12_call(write の dryRun)は実行しない", JSON.parse(dry.content[0].text).executed === false);
    const wrong = await call("dx12_call", { name: "dx12_set_transform", args: { name: "Floor", postion: [0, 0, 0] } });
    const wb = JSON.parse(wrong.content[0].text);
    check("e2e: わざと間違えた呼び出し → E_UNKNOWN_PARAM + didYouMean + fix(そのまま撃ち直せる)", wrong.isError === true && wb.error_code === "E_UNKNOWN_PARAM" && wb.didYouMean?.[0] === "position" && wb.fix?.[0]?.args?.position, wb);
    const fixed = await call("dx12_call", { name: wb.fix[0].tool, args: wb.fix[0].args });
    check("e2e: fix[0] をそのまま dx12_call に渡すと成功", JSON.parse(fixed.content[0].text).ok === true, fixed.content[0].text.slice(0, 200));
    // 旧ツールを直接呼んだときの型エラー(SDK が返す文言 + 構造化 JSON の 2 ブロック)
    const direct = await call("dx12_set_transform", { name: "Floor", position: "1,2,3" });
    const dt = direct.content.map((c: any) => c.text);
    check("e2e: 旧ツール直接呼び出しの型エラーは SDK の本文 + 構造化 JSON(E_BAD_TYPE)", direct.isError === true && dt.length === 2 && JSON.parse(dt[1]).error_code === "E_BAD_TYPE", dt);
    const dirunk = await call("dx12_no_such_tool", {});
    check("e2e: 未知ツールを直接呼ぶと構造化 JSON(E_UNKNOWN_TOOL)が付く", dirunk.isError === true && JSON.parse(dirunk.content[dirunk.content.length - 1].text).error_code === "E_UNKNOWN_TOOL", dirunk.content);
    const unkey = await call("dx12_set_transform", { name: "Floor", postion: [0, 0, 0] });
    check("e2e: 旧ツールの未知キーは従来の本文 + 構造化 JSON(E_UNKNOWN_PARAM)", unkey.isError === true && unkey.content.length === 2 && JSON.parse(unkey.content[1].text).didYouMean?.[0] === "position", unkey.content);
    const doc = await call("dx12_doctor", {});
    check("e2e: dx12_doctor", JSON.parse(doc.content[0].text).ok === true);
  } finally { proc.kill(); }
}

await mock.close();
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: shell テスト ${total} 項目すべて通過`);
process.exit(0);
