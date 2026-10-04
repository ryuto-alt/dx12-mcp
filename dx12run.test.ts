// scripts/dx12run.ts(コードモード: AI が書いたスクリプトを 1 回で流す)のテスト。偽エンジン(mockEngine)相手。
//   [1] ファイルのスクリプト: dx.call / dx.lua / dx.step / dx.log が使え、result だけが 1 行の JSON で出る
//   [2] -e の本体
//   [3] 承認: eval_lua は confirm_token 付きで通る / それ以外の guarded は --allow-guarded が無ければ拒否
//   [4] 失敗と切り詰め: スクリプトの例外は ok:false / 大きな result は truncated
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./testEnv.ts";
import { startMockEngine } from "./mockEngine.ts";
import { tmpDir, rmTree } from "./fleetTestKit.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}

const M = (name: string, effect: string) => ({ name, category: "test", summary: name, effect, mode: "any", timeoutMs: 8000, params: [], source: "meta" }) as any;
let n = 0;
const mock = await startMockEngine({
  safety: true,
  methods: [
    { ...M("eval_lua", "guarded"), handler: (p: any) => ({ result: `${p.code}#${++n}` }) },
    { ...M("step_frames", "runtime"), handler: (p: any) => ({ stepped: true, frames: p.frames }) },
    M("git_push", "guarded"),
  ],
});
const dir = tmpDir("dx12run");
// ★非同期で走らせる(偽エンジンはこのプロセスの中で動くので、spawnSync で待つと返事できずにタイムアウトする)。
const run = (args: string[]) => new Promise<{ code: number | null; json: any; stderr: string }>((resolve) => {
  const p = spawn(process.execPath, [path.join(here, "scripts", "dx12run.ts"), ...args, "--port", String(mock.port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => out += d);
  p.stderr.on("data", (d) => err += d);
  p.on("close", (code) => {
    let json: any = null;
    try { json = JSON.parse(out.trim().split("\n").pop() ?? ""); } catch { /* 下で落とす */ }
    resolve({ code, json, stderr: err });
  });
});
const reset = () => { mock.received.length = 0; mock.state.tokens.clear(); mock.state.exec = {}; n = 0; };

console.log("[1] ファイルのスクリプト");
{
  reset();
  const f = path.join(dir, "a.mjs");
  fs.writeFileSync(f, "export default async (dx) => { await dx.call('ping'); const a = await dx.lua('A'); await dx.step(30, {deterministic:true}); dx.log('done', {x:1}); return { a, port: typeof dx.port }; };\n");
  const r = await run([f]);
  check("終了コード 0 で ok:true", r.code === 0 && r.json?.ok === true, r);
  check("result はスクリプトの戻り値だけ", r.json?.result?.a === "A#1" && r.json?.result?.port === "number", r.json);
  check("logs と calls が付く", r.json?.logs?.[0] === 'done {"x":1}' && r.json?.calls === 3, r.json);
  check("step_frames に引数が渡る", mock.received.some((x) => x.method === "step_frames" && x.params.frames === 30 && x.params.deterministic === true));
}

console.log("[2] -e の本体");
{
  reset();
  const r = await run(["-e", "const ys = []; for (let i = 0; i < 3; i++) ys.push(await dx.lua('y' + i)); return ys;"]);
  check("ループの結果がまとめて返る", JSON.stringify(r.json?.result) === JSON.stringify(["y0#1", "y1#2", "y2#3"]), r.json);
}

console.log("[3] 承認");
{
  reset();
  await run(["-e", "return await dx.lua('x');"]);
  const ev = mock.received.filter((x) => x.method === "eval_lua");
  check("eval_lua は confirm_token 付きで実行された", ev.length === 1 && typeof ev[0].params.confirm_token === "string" && mock.state.exec.eval_lua === 1, mock.received.map((x) => x.method));
  reset();
  const g = await run(["-e", "return await dx.call('git_push', {});"]);
  check("git_push は --allow-guarded 無しなら拒否(エンジンへ届かない)", g.code === 1 && g.json?.errName === "E_GUARDED" && !mock.received.some((x) => x.method === "git_push" || x.method === "guard_token"), g.json);
  reset();
  const g2 = await run(["-e", "return await dx.call('git_push', {});", "--allow-guarded"]);
  check("--allow-guarded なら実行される", g2.code === 0 && mock.state.exec.git_push === 1, g2.json);
}

console.log("[4] 失敗と切り詰め");
{
  reset();
  const e = await run(["-e", "throw new Error('boom');"]);
  check("スクリプトの例外は ok:false と終了コード 1", e.code === 1 && e.json?.ok === false && /boom/.test(e.json?.error), e.json);
  const big = await run(["-e", "return 'x'.repeat(50000);", "--max-output", "2000"]);
  check("大きな result は切り詰めて truncated", big.json?.truncated === true && JSON.stringify(big.json).length < 3000, big.json && JSON.stringify(big.json).length);
  const bad = await run([path.join(dir, "missing.mjs")]);
  check("無いファイルは ok:false", bad.code === 1 && bad.json?.ok === false, bad);
}

await mock.close();
rmTree(dir);
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: dx12run テスト ${total} 項目すべて通過`);
process.exit(0);
