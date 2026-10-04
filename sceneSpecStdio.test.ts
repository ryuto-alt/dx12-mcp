// 宣言的シーン生成(M11)の MCP 面のテスト。MCP サーバを別プロセスで起動(stdio)し、偽エンジン(sceneSim)へ繋ぐ。
//   [1] Core 面(40 本のまま)に dx12_apply_scene_spec が入り、dx12_scene_write が長尾へ移った / dx12_scene_spec_export は長尾(dx12_call)
//   [2] plan / apply / 冪等 / dryRun(dx12_call の native dryRun = plan)
//   [3] 失敗の構造化エラー(issues[].specPatch・details.specPatch・fix[0] = {specRef, patch})と、その撃ち直し
//   [4] prune の承認(core: dx12_call_guarded / full: dx12_call {confirm:true})
//   [5] ジョブ(async:true → dx12_job_status → dx12_job_result)
//   [6] export の往復 / guide / 検索(「ステージを作って」)
// 実行: node sceneSpecStdio.test.ts
import "./testEnv.ts";
import path from "node:path";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { startMockEngine } from "./mockEngine.ts";
import { createSceneSim } from "./sceneSim.ts";
import { tmpDir } from "./fleetTestKit.ts";
import { loadExample } from "./sceneSpecCorpus.ts";
import { digestScene } from "./sceneSpec/digest.ts";
import { EngineClient } from "./engineClient.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1200)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sim = createSceneSim({ assets: { "models/cube1m.glb": { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], type: "model" } }, scripts: ["components/Spinner.lua"], textures: [] });
const mock = await startMockEngine({ methods: sim.methods, safety: true, pingExtra: () => ({ baseDir: tmpDir("proj") }) });
const engine = new EngineClient("127.0.0.1", mock.port, 5000, { backoffMs: [] });
const clients: McpClient[] = [];
function server(surface: "full" | "core"): McpClient {
  const c = startMcp({ DX12_MCP_SURFACE: surface, DX12_MCP_PORT: String(mock.port), DX12_MCP_PORT_FILE: path.join(tmpDir("pf"), "none.port"), DX12_JOBS_DIR: tmpDir("jobs") });
  clients.push(c);
  return c;
}
const reset = () => { sim.state.entities = sim.state.entities.filter((e: any) => e.internal); sim.state.calls.length = 0; mock.received.length = 0; mock.state.tokens.clear(); mock.state.idem.clear(); mock.state.exec = {}; };
const SHOW = loadExample("showcase");
const ROOM = loadExample("room");

const core = server("core");
await core.initialize();
const full = server("full");
await full.initialize();

console.log("[1] 面と検索");
{
  const tl = (await core.rpc("tools/list")).result.tools as any[];
  const names = tl.map((t) => t.name);
  check("core 面は 40 本ちょうど(上限を維持)", names.length === 40, names.length);
  check("core 面に dx12_apply_scene_spec がある・dx12_scene_write は無い(長尾へ移した)", names.includes("dx12_apply_scene_spec") && !names.includes("dx12_scene_write") && !names.includes("dx12_scene_spec_export"), names);
  const desc = tl.find((t) => t.name === "dx12_apply_scene_spec").description as string;
  check("Core の説明は 600 字以内・使う / 使わない / 副作用 / 注意を含む", desc.length <= 600 && /使う/.test(desc) && /使わない/.test(desc) && /副作用/.test(desc) && /注意/.test(desc), desc.length);
  const ftl = (await full.rpc("tools/list")).result.tools as any[];
  check("full 面には dx12_apply_scene_spec と dx12_scene_spec_export の両方(末尾)", ftl.some((t) => t.name === "dx12_apply_scene_spec") && ftl.some((t) => t.name === "dx12_scene_spec_export") && ftl.some((t) => t.name === "dx12_scene_write"));
  const dsc = await core.call("dx12_tool_describe", { name: "dx12_scene_write" });
  check("dx12_scene_write は core 面でも dx12_tool_describe で引ける(名前・引数互換の長尾)", dsc.name === "dx12_scene_write" && dsc.callTemplate?.name === "dx12_scene_write", dsc.name);
  const dsx = await core.call("dx12_tool_describe", { name: "dx12_scene_spec_export" });
  check("dx12_scene_spec_export は長尾として dx12_tool_describe で引ける(effect:read)", dsx.name === "dx12_scene_spec_export" && dsx.effect === "read", dsx);
  const q = async (query: string) => (await core.call("dx12_tool_search", { query, limit: 3 })).hits.map((h: any) => h.name);
  for (const query of ["ステージを作って", "街を並べて", "部屋を JSON で一括生成", "円形に柱を 8 本並べる", "create a level from a declarative spec"]) {
    const hits = await q(query);
    check(`検索「${query}」の上位 3 件に dx12_apply_scene_spec`, hits.includes("dx12_apply_scene_spec"), hits);
  }
  const hs = await q("シーン JSON を直接ファイルへ書く");
  check("検索「シーン JSON を直接ファイルへ書く」は dx12_scene_write も上位 3 件に残る", hs.includes("dx12_scene_write"), hs);
  const g = await core.call("dx12_guide", { topic: "scene_spec" });
  check("dx12_guide {topic:'scene_spec'} が本文(Markdown)を返す", typeof g._text === "string" && /specPatch/.test(g._text) && /fps_arena/.test(g._text) && /horror_corridor/.test(g._text), String(g._text).slice(0, 80));
}

console.log("[2] plan / apply / 冪等 / dryRun");
{
  reset();
  const h0 = sim.hash();
  const pl = await core.call("dx12_apply_scene_spec", { spec: SHOW, mode: "plan" });
  check("plan: 何も書かない・plan.summary と cost と specRef を返す", pl.mode === "plan" && pl.plan.summary.create > 0 && pl.plan.cost.engineCalls > 0 && typeof pl.specRef === "string" && sim.hash() === h0, pl.plan?.summary);
  const dr = await core.call("dx12_call", { name: "dx12_apply_scene_spec", args: { spec: SHOW }, dryRun: true });
  check("dx12_call {dryRun:true} は native dryRun = plan(executed:false・書かない)", dr.executed === false && dr.dryRunMode === "native" && dr.result?.mode === "plan" && sim.hash() === h0, dr);
  const ap = await core.call("dx12_apply_scene_spec", { spec: SHOW });
  check("apply: 成功・commit・verify.pass", ap.ok === true && ap.applied === true && ap.transaction.committed === true && ap.verify.pass === true, ap.error ?? ap.result);
  const h1 = sim.hash();
  const ap2 = await core.call("dx12_apply_scene_spec", { spec: SHOW });
  check("再適用は冪等(created 0 / updated 0・hash 不変・トランザクションを開かない)", ap2.idempotent === true && ap2.result.created === 0 && ap2.result.updated === 0 && sim.hash() === h1 && mock.received.filter((r) => r.method === "transaction_begin").length === 1, ap2.result);
  const viaCall = await core.call("dx12_call", { name: "dx12_apply_scene_spec", args: { spec: SHOW } });
  check("dx12_call {name:'dx12_apply_scene_spec'} でも同じ(result に ok・meta)", viaCall.ok === true && (viaCall.result?.idempotent === true || viaCall.idempotent === true), viaCall);
  const specStr = await core.call("dx12_apply_scene_spec", { spec: JSON.stringify(SHOW), mode: "plan" });
  check("spec は JSON 文字列でも受け付ける", specStr.mode === "plan" && specStr.plan.summary.unchanged > 0, specStr);
  const unk = await core.call("dx12_apply_scene_spec", { spec: SHOW, mod: "plan" });
  check("未知の引数(mod)は E_UNKNOWN_PARAM + didYouMean(mode)", unk.error_code === "E_UNKNOWN_PARAM" && unk.didYouMean?.[0] === "mode", unk);
}

console.log("[3] 失敗の構造化エラーと specPatch の撃ち直し");
{
  reset();
  const bad = JSON.parse(JSON.stringify(SHOW));
  bad.entities.find((e: any) => e.name === "ENV_Cube").kind = "cube";
  bad.entities.find((e: any) => e.name === "CAM_Main").postion = [1, 1, 1];
  const r = await core.call("dx12_apply_scene_spec", { spec: bad });
  check("検証エラー: error_code E_VALIDATION_FAILED・issues に path / code / specPatch・エンジンに書かない", r.error_code === "E_VALIDATION_FAILED" && r.issues.length === 2 && r.issues.every((i: any) => i.path.startsWith("/entities/") && Array.isArray(i.specPatch)) && sim.state.calls.every((c: any) => !/^(create_|set_|transaction_)/.test(c.method)), r);
  check("details に stage:validate・全 issue の specPatch・specRef", r.details.stage === "validate" && r.details.specPatch.length === 2 && typeof r.details.specRef === "string");
  const fx = r.fix?.[0];
  check("fix[0] はそのまま撃ち直せる {tool:dx12_apply_scene_spec, args:{specRef, patch}}", fx?.tool === "dx12_apply_scene_spec" && fx.args.specRef === r.details.specRef && fx.args.patch.length === 2, fx);
  const retry = await core.call(fx.tool, fx.args);
  check("fix[0] をそのまま撃つと通る(spec の全文を再送していない)", retry.ok === true && retry.applied === true, retry.error ?? retry);
  // dx12_call 経由でも fix はそのまま撃てる
  reset();
  const r2 = await core.call("dx12_call", { name: "dx12_apply_scene_spec", args: { spec: bad } });
  check("dx12_call 経由のエラーも構造化(error_code・issues・fix)", r2.ok === false && r2.error_code === "E_VALIDATION_FAILED" && r2.fix?.[0]?.tool === "dx12_apply_scene_spec", r2);
  // 検証(layout)失敗 → ロールバック
  reset();
  const dup = JSON.parse(JSON.stringify(SHOW));
  dup.entities.push({ name: "ENV_PedestalTwin", kind: "box", size: [1.4, 0.9, 1.4], group: "ENV", at: [0, null, 0], place: { on: "LVL_Floor" } });
  const h = sim.hash();
  const r3 = await full.call("dx12_apply_scene_spec", { spec: dup });
  check("layout 検証の失敗はロールバック(hash 不変)・details.stage=verify・fix[0] の patch で通る", r3.error_code === "E_VALIDATION_FAILED" && r3.details.stage === "verify" && r3.details.transaction?.rolledBack === true && sim.hash() === h, r3.details);
  const r4 = await full.call(r3.fix[0].tool, r3.fix[0].args);
  check("そのまま撃ち直すと通る", r4.ok === true, r4.error ?? r4);
  // 直接引数のエラー
  const nospec = await core.call("dx12_apply_scene_spec", {});
  check("spec も specRef も無い → E_VALIDATION_FAILED(spec を渡す案内)", nospec.error_code === "E_VALIDATION_FAILED" && nospec.issues[0].code === "E_MISSING_PARAM", nospec);
}

console.log("[4] prune の承認");
{
  reset();
  await core.call("dx12_apply_scene_spec", { spec: ROOM });
  const room2 = JSON.parse(JSON.stringify(ROOM));
  room2.entities = room2.entities.filter((e: any) => e.name !== "ENV_ChairR");
  await engine.call("create_entity", { type: "box", name: "HandMade", position: [30, 0.5, 30] });
  const g0 = await core.call("dx12_apply_scene_spec", { spec: room2, prune: true });
  check("core 面: prune:true の適用は E_GUARDED(fix に plan と dx12_call_guarded)・何も消えない", g0.error_code === "E_GUARDED" && g0.fix.some((f: any) => f.tool === "dx12_call_guarded") && sim.state.entities.some((e: any) => e.name === "ENV_ChairR"), g0);
  const pl = await core.call("dx12_apply_scene_spec", { spec: room2, prune: true, mode: "plan" });
  check("plan は承認なしで撃てる(delete 1・HandMade は対象外)", pl.plan.summary.delete === 1 && pl.plan.delete[0].name === "ENV_ChairR", pl.plan);
  const dr = await core.call("dx12_call_guarded", { name: "dx12_apply_scene_spec", args: { spec: room2, prune: true }, dryRun: true });
  check("dx12_call_guarded {dryRun:true} は実行せずプレビュー", dr.executed === false && sim.state.entities.some((e: any) => e.name === "ENV_ChairR"), dr);
  const c1 = await core.call("dx12_call_guarded", { name: "dx12_apply_scene_spec", args: { spec: room2, prune: true } });
  check("core: dx12_call_guarded 経由の承認つき適用で ENV_ChairR だけ消える(HandMade は残る)", c1.ok === true && !sim.state.entities.some((e: any) => e.name === "ENV_ChairR") && sim.state.entities.some((e: any) => e.name === "HandMade"), c1);
  // full 面
  reset();
  await full.call("dx12_apply_scene_spec", { spec: ROOM });
  const f0 = await full.call("dx12_call", { name: "dx12_apply_scene_spec", args: { spec: room2, prune: true } });
  check("full 面: dx12_call は confirm 無しだと E_GUARDED", f0.error_code === "E_GUARDED", f0);
  const f1 = await full.call("dx12_call", { name: "dx12_apply_scene_spec", args: { spec: room2, prune: true }, confirm: true });
  check("full 面: dx12_call {confirm:true} なら消える", f1.ok === true && !sim.state.entities.some((e: any) => e.name === "ENV_ChairR"), f1);
  const f2 = await full.call("dx12_apply_scene_spec", { spec: room2, prune: true });
  check("full 面: 直接呼び出しの prune:true も E_GUARDED(承認済みの経路だけ)", f2.error_code === "E_GUARDED", f2);
}

console.log("[5] ジョブ(async:true)");
{
  reset();
  const a = await core.call("dx12_apply_scene_spec", { spec: SHOW, async: true });
  check("async:true は即座に job id を返す(進捗は dx12_job_status)", a.async === true && typeof a.job?.id === "string" && a.next?.[0]?.tool === "dx12_job_status", a);
  const st = await core.call("dx12_job_status", { id: a.job.id, waitSec: 20 });
  check("ジョブが succeeded になる(kind:scene_spec)", st.state === "succeeded" && st.kind === "scene_spec", st);
  const resWrap = await core.call("dx12_call", { name: "dx12_job_result", args: { id: a.job.id } });
  const res = resWrap.result ?? resWrap;
  check("job_result(dx12_call 経由。長尾)に plan / verify(全文)が入る", res.result?.result?.applied === true && res.result?.result?.verify?.pass === true && res.result?.result?.plan?.summary?.create > 0, res.result && Object.keys(res.result));
  const jstart = await core.call("dx12_job_start", { kind: "scene_spec", args: { spec: SHOW, mode: "plan" } });
  const jst = await core.call("dx12_job_status", { id: jstart.id, waitSec: 20 });
  check("dx12_job_start {kind:'scene_spec'} でも実行できる(plan)", jst.state === "succeeded" && jst.summary?.mode === "plan", jst);
  reset();
  const bad = JSON.parse(JSON.stringify(SHOW)); bad.entities[3].kind = "cube";
  const fj = await core.call("dx12_apply_scene_spec", { spec: bad, async: true });
  const fst = await core.call("dx12_job_status", { id: fj.job.id, waitSec: 20 });
  const fresWrap = await core.call("dx12_call", { name: "dx12_job_result", args: { id: fj.job.id } });
  const fres = fresWrap.result ?? fresWrap;
  check("失敗するジョブは failed・結果に specPatch が入る(AI が撃ち直せる)", fst.state === "failed" && Array.isArray(fres.result?.result?.specPatch) && fres.result.result.specPatch.length >= 1, [fst.state, fres.result && Object.keys(fres.result)]);
  const pj = await core.call("dx12_job_start", { kind: "scene_spec", args: { spec: SHOW, prune: true } });
  check("scene_spec ジョブの prune:true は承認が要る(E_GUARDED)", pj.error_code === "E_GUARDED", pj);
}

console.log("[6] export の往復");
{
  reset();
  await core.call("dx12_apply_scene_spec", { spec: SHOW });
  const d1 = (await digestScene(engine as any)).hash;
  const ex = await core.call("dx12_call", { name: "dx12_scene_spec_export", args: { owned: true } });
  const spec = ex.result?.spec ?? ex.spec;
  check("export: 仕様(name は showcase・group / at / lookAt を含む)", spec?.name === "showcase" && spec.entities.length === ex.result?.entityCount && spec.entities.some((e: any) => e.lookAt === "ENV_Sphere"), ex);
  reset();
  const ap = await core.call("dx12_apply_scene_spec", { spec });
  const d2 = (await digestScene(engine as any)).hash;
  check("往復(MCP 経由): export → 空のシーンへ apply → ダイジェスト一致", ap.ok === true && d1 === d2, [ap.error, d1, d2]);
}

for (const c of clients) c.close();
await sleep(50);
console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
