// フリートのテスト用「偽エンジン」プロセス。実エンジン(DX12Engine.exe)と同じ起動引数の契約を話す:
//   --background | --headless / --virtual-input / --project <dir> / --mcp-port <n> / --owner-pid <pid> / --idle-exit <分(小数可)> / --instance-id <id> /
//   --dpi-scale <x> / --scene <rel>
//   ・ping に pid / instanceId / uptimeSec / idleSec / idleExitMin / ownerPid / vramUsedMB / vramBudgetMB を載せる(C++ の FleetGuard と同じ意味)
//   ・owner の pid が消えたら自分で終了する(--owner-pid)。ping と describe_mcp_manifest 以外の呼び出しが --idle-exit 分無ければ終了する
//   ・DX12E_DATA_DIR に mock_marker.json を書く(データ領域が分離されている証拠)。cwd に dx12_engine.log を書く
//   ・テスト用の環境変数: MOCK_ENGINE_STARTUP_MS(起動を遅らせる)/ MOCK_ENGINE_FAIL_START=1(すぐ異常終了)/ MOCK_ENGINE_NO_PING=1(接続は受けるが応答しない)
// 実行: node mockEngineProc.ts --mcp-port 8899 ...(テストからは DX12_FLEET_ENGINE_CMD=["node","<このファイル>"] で起動させる)
import fs from "node:fs";
import path from "node:path";
import { startMockEngine } from "./mockEngine.ts";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(name);

const port = Number(opt("--mcp-port") ?? 0);
const ownerPid = Number(opt("--owner-pid") ?? 0);
const idleExitMin = Number(opt("--idle-exit") ?? 0);
const instanceId = opt("--instance-id") ?? "";
const project = opt("--project") ?? "";
const dpiScale = Number(opt("--dpi-scale") ?? 1);
const mode = has("--headless") ? "headless" : has("--background") ? "offscreen" : "none";
const startedAt = Date.now();
let lastActivity = Date.now();

const log = (msg: string) => { try { fs.appendFileSync(path.join(process.cwd(), "dx12_engine.log"), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* 無視 */ } };
log(`mock engine start pid=${process.pid} argv=${JSON.stringify(argv)}`);

if (process.env.MOCK_ENGINE_FAIL_START === "1") { console.error("mock engine: 異常終了(MOCK_ENGINE_FAIL_START)"); process.exit(3); }

const delay = Number(process.env.MOCK_ENGINE_STARTUP_MS ?? 0);
if (delay > 0) await new Promise((r) => setTimeout(r, delay));

if (process.env.DX12E_DATA_DIR) {
  try {
    fs.mkdirSync(process.env.DX12E_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.DX12E_DATA_DIR, "mock_marker.json"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv, dataDir: process.env.DX12E_DATA_DIR, startedAt }));
  } catch { /* 無視 */ }
}

const noPing = process.env.MOCK_ENGINE_NO_PING === "1";
const eng = await startMockEngine({
  port,
  onRequest: (m) => { if (m !== "ping" && m !== "describe_mcp_manifest" && m !== "describe_mcp_params") lastActivity = Date.now(); },
  ...(noPing ? { hang: new Set(["ping"]) } : {}),
  pingExtra: () => ({
    pid: process.pid, instanceId, uptimeSec: (Date.now() - startedAt) / 1000, idleSec: (Date.now() - lastActivity) / 1000, idleExitMin, ownerPid,
    vramUsedMB: 300, vramBudgetMB: 7000, dpiScale, background: mode, baseDir: project, cwd: process.cwd(), dataDir: process.env.DX12E_DATA_DIR ?? "",
  }),
});
log(`listening ${eng.port}`);

const quit = (why: string) => { log(`exit: ${why}`); process.exit(0); };
setInterval(() => {
  if (ownerPid > 0) { try { process.kill(ownerPid, 0); } catch (e: any) { if (e?.code !== "EPERM") quit("owner-gone"); } }
  if (idleExitMin > 0 && Date.now() - lastActivity > idleExitMin * 60_000) quit("idle");
}, 250);
