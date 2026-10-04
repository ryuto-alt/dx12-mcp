// フリートのテスト共通部品: 偽ビルド出力・偽エンジン起動コマンド・設定・掃除。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { loadFleetConfig, type FleetConfig } from "./fleet/config.ts";
import { pidAlive, killTreeSync } from "./fleet/proc.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_ENGINE_SCRIPT = path.join(here, "mockEngineProc.ts");
export const MOCK_ENGINE_CMD = JSON.stringify([process.execPath, MOCK_ENGINE_SCRIPT]);

let counter = 0;
export function tmpDir(label: string): string {
  const d = path.join(os.tmpdir(), `dx12-fleet-${label}-${process.pid}-${Date.now().toString(36)}-${counter++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 偽のビルド出力(DX12Engine.exe・dll・dxil.dll(ハードリンク対象)・shaders・assets)を作る。 */
export function makeFakeBuild(dir: string, opts: { exeBytes?: number } = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "DX12Engine.exe"), Buffer.alloc(opts.exeBytes ?? 200_000, 7));
  fs.writeFileSync(path.join(dir, "fake.dll"), Buffer.alloc(20_000, 1));
  fs.writeFileSync(path.join(dir, "dxil.dll"), Buffer.alloc(50_000, 2));
  fs.writeFileSync(path.join(dir, "GameRuntime.exe"), Buffer.alloc(30_000, 3));
  fs.writeFileSync(path.join(dir, "DX12Engine.pdb"), "pdb");
  fs.mkdirSync(path.join(dir, "shaders"), { recursive: true });
  fs.writeFileSync(path.join(dir, "shaders", "a.cso"), "cso");
  fs.mkdirSync(path.join(dir, "assets", "editor"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "editor", "x.txt"), "x");
  return dir;
}

/** テスト用の環境変数一式(フリートの置き場・偽ビルド・偽エンジン起動コマンド・短い監視間隔)。 */
export function fleetEnv(fleetDir: string, buildDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DX12_FLEET_DIR: fleetDir, DX12_FLEET_BUILD_DIR: buildDir, DX12_FLEET_ENGINE_CMD: MOCK_ENGINE_CMD,
    DX12_FLEET_FAKE_RESOURCES: JSON.stringify({ vramFreeMB: 6000, vramTotalMB: 8000, ramFreeMB: 16000 }),
    DX12_FLEET_MONITOR_MS: "200", DX12_FLEET_PORT_RANGE: "8860-8899",
    // 手動起動の候補ポート(8850〜8859)には触れない(他のエージェントが使用中)。テストは 8860〜8899 だけを使う。
    DX12_FLEET_DISCOVER_PORTS: "8889", DX12_DOCTOR_PORTS: "8889",
    ...extra,
  };
}

export function fleetConfigFor(fleetDir: string, buildDir: string, extra: Record<string, string> = {}): FleetConfig {
  return loadFleetConfig({ ...process.env, ...fleetEnv(fleetDir, buildDir, extra) } as NodeJS.ProcessEnv);
}

/** 他のセッション(別プロセス)の代役: 生きている pid が欲しいときの寝ているプロセス。 */
export function spawnSleeper(ms = 60_000): ChildProcess {
  const c = spawn(process.execPath, ["-e", `setTimeout(()=>{}, ${ms})`], { stdio: "ignore", windowsHide: true });
  return c;
}

/** 終わるまで待つ(最大 ms)。 */
export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000, step = 50): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, step)); }
  return !!(await cond());
}

export async function waitDead(pid: number, ms = 6000): Promise<boolean> { return waitFor(() => !pidAlive(pid), ms); }

/** テストが起動した pid を必ず片付けるための台帳。 */
const spawned = new Set<number>();
export function track(pid: number | undefined) { if (pid) spawned.add(pid); return pid; }
export function killTracked() { for (const p of spawned) { try { killTreeSync(p); } catch { /* 無視 */ } } spawned.clear(); }
export function rmTree(d: string) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 無視 */ } }
