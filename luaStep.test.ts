// dx12_lua_step(Lua で仕掛け → N フレーム進め → Lua で読む を 1 回で行う合成ツール)のテスト。偽エンジン(mockEngine)相手。
//   [1] 束ねた順番: before → key_down → step_frames → key_up → after。eval_lua には毎回 confirm_token が付く(直接呼び出し = 承認)
//   [2] every: フレームを塊に分けて、塊ごとに after を読み samples に並べる
//   [3] 失敗: before が失敗したら進めない / 途中で失敗してもキーは必ず離す / stage が分かる
//   [4] ゲート: dx12_call 経由は confirm が要る(eval_lua と同じ扱い)。core 面は tools/list に出ない
import path from "node:path";
import "./testEnv.ts";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { startMockEngine } from "./mockEngine.ts";
import { stepChunks } from "./toolset/luaStep.ts";
import { tmpDir, rmTree } from "./fleetTestKit.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("[0] stepChunks");
check("every 無し = 1 塊", JSON.stringify(stepChunks(60)) === "[60]");
check("60 を 25 ごと = 25,25,10(端数は最後)", JSON.stringify(stepChunks(60, 25)) === "[25,25,10]");
check("every >= frames = 1 塊", JSON.stringify(stepChunks(10, 30)) === "[10]");

const dirs: string[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };
const M = (name: string, effect: string) => ({ name, category: "test", summary: name, effect, mode: "any", timeoutMs: 8000, params: [], source: "meta" }) as any;
let luaCalls = 0;
const mock = await startMockEngine({
  safety: true,
  methods: [
    // 呼ばれた順に連番を返す eval_lua。code に "boom" を含むと Lua エラー。
    { ...M("eval_lua", "guarded"), handler: (p: any) => { if (String(p.code).includes("boom")) throw new Error("Lua error: boom"); return { result: `${p.code}#${++luaCalls}` }; } },
    { ...M("step_frames", "runtime"), handler: (p: any) => ({ stepped: true, frames: p.frames, deterministic: p.deterministic ?? false }) },
    { ...M("key_down", "runtime"), handler: (p: any) => ({ key: p.key, down: true }) },
    { ...M("key_up", "runtime"), handler: (p: any) => ({ key: p.key, down: false }) },
  ],
});
const clients: McpClient[] = [];
function server(surface: "full" | "core"): McpClient {
  const c = startMcp({ DX12_MCP_SURFACE: surface, DX12_MCP_PORT: String(mock.port), DX12_MCP_PORT_FILE: path.join(mk("pf"), "none.port"), DX12_JOBS_DIR: mk("jobs") });
  clients.push(c);
  return c;
}
const reset = () => { mock.received.length = 0; mock.state.exec = {}; mock.state.tokens.clear(); mock.state.idem.clear(); luaCalls = 0; };
const seq = () => mock.received.map((r) => r.method).filter((m) => ["eval_lua", "key_down", "key_up", "step_frames"].includes(m));
const evalParams = () => mock.received.filter((r) => r.method === "eval_lua").map((r) => r.params);

const full = server("full");
await full.initialize();

console.log("[1] 束ねた順番と承認");
{
  reset();
  const r = await full.call("dx12_lua_step", { before: "setup", frames: 30, keys: ["D", "SPACE"], deterministic: true, after: "read" });
  check("before → key_down×2 → step_frames → key_up×2 → after の順にエンジンへ届く",
    JSON.stringify(seq()) === JSON.stringify(["eval_lua", "key_down", "key_down", "step_frames", "key_up", "key_up", "eval_lua"]), seq());
  check("返り値に before / after / step / frames が入る", r.before === "setup#1" && r.after === "read#2" && r.step?.frames === 30 && r.frames === 30, r);
  check("step_frames に deterministic が渡る", mock.received.find((x) => x.method === "step_frames")?.params.deterministic === true);
  check("eval_lua は毎回 confirm_token 付き(直接呼び出し = 承認)", evalParams().length === 2 && evalParams().every((p) => typeof p.confirm_token === "string"), evalParams());
  check("Lua は 2 回とも実行された(エンジンの guarded ゲートを通った)", mock.state.exec.eval_lua === 2, mock.state.exec);
}

console.log("[2] every(軌跡)");
{
  reset();
  const r = await full.call("dx12_lua_step", { frames: 25, every: 10, after: "y" });
  check("10,10,5 の 3 塊で進め、塊ごとに after を読む", JSON.stringify(seq()) === JSON.stringify(["step_frames", "eval_lua", "step_frames", "eval_lua", "step_frames", "eval_lua"]), seq());
  check("samples に {frame, result} が累積フレームで並ぶ", JSON.stringify(r.samples?.map((s: any) => s.frame)) === "[10,20,25]" && r.samples?.[2]?.result === "y#3" && r.after === undefined, r);
  reset();
  const e1 = await full.call("dx12_lua_step", { frames: 10, every: 2 });
  check("every だけで after が無いとエラー(エンジンへ何も撃たない)", e1.ok === false || e1.error_code !== undefined || /after/.test(JSON.stringify(e1)), e1);
  check("…エンジンには何も届いていない", seq().length === 0, seq());
  reset();
  const e2 = await full.call("dx12_lua_step", { frames: 600, every: 1, after: "y" });
  check("読む回数が上限(60)を超える every はエラー", /every/.test(JSON.stringify(e2)) && seq().length === 0, e2);
}

console.log("[3] 失敗の扱い");
{
  reset();
  const e = await full.call("dx12_lua_step", { before: "boom", frames: 5, keys: ["D"], after: "read" });
  check("before が失敗したら進めない(step_frames もキーも撃たない)", JSON.stringify(seq()) === JSON.stringify(["eval_lua"]), seq());
  check("エラーに stage:before が分かる", /before/.test(JSON.stringify(e)), e);
  reset();
  const e2 = await full.call("dx12_lua_step", { frames: 20, every: 10, keys: ["W"], after: "boom" });
  check("途中の after が失敗しても、押したキーは必ず離す", seq().includes("key_up") && seq().lastIndexOf("key_up") > seq().indexOf("key_down"), seq());
  check("エラーに何フレーム目の after か分かる", /after\(frame 10\)/.test(JSON.stringify(e2)), e2);
}

console.log("[4] ゲート");
{
  reset();
  const g0 = await full.call("dx12_call", { name: "dx12_lua_step", args: { before: "x", frames: 1 } });
  check("dx12_call 経由で confirm 無し → E_GUARDED(エンジンへ届かない)", g0.error_code === "E_GUARDED" && seq().length === 0, g0);
  const g1 = await full.call("dx12_call", { name: "dx12_lua_step", args: { before: "x", frames: 1 }, confirm: true });
  check("dx12_call {confirm:true} なら実行される", g1.ok === true && mock.state.exec.eval_lua === 1, g1);
  const core = server("core");
  await core.initialize();
  const names = (await core.rpc("tools/list")).result.tools.map((t: any) => t.name);
  check("core 面: tools/list には出ない(dx12_call_guarded で使う長尾)", !names.includes("dx12_lua_step"), names.length);
  const d = await core.call("dx12_tool_describe", { name: "dx12_lua_step" });
  check("core 面: describe で引けて、副作用は guarded", JSON.stringify(d).includes("guarded"), d);
}

for (const c of clients) { try { c.proc.stdin!.end(); } catch { /* 無視 */ } }
await sleep(300);
for (const c of clients) { try { c.close(); } catch { /* 無視 */ } }
await mock.close();
for (const d of dirs) rmTree(d);
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: lua_step テスト ${total} 項目すべて通過`);
process.exit(0);
