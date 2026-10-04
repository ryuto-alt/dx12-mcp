// フリート(複数エンジンの管理)の設定。環境変数を 1 か所で読む。設計は docs/MCP_FLEET_DESIGN.md。
import os from "node:os";
import path from "node:path";

export type FleetConfig = {
  /** レジストリ・インスタンス・使い捨てプロジェクトを置く場所。 */
  dir: string;
  /** 全セッション合計の同時起動数の上限。 */
  max: number;
  /** この分数、呼び出しが無いエンジンを自動で止める(小数可)。 */
  idleMin: number;
  /** 空き VRAM がこれ未満なら起動を断る(MB)。 */
  minFreeVramMB: number;
  /** 空き RAM がこれ未満なら起動を断る(MB)。 */
  minFreeRamMB: number;
  portRange: [number, number];
  /** exe の元(ビルド出力)。未指定ならリポジトリの build\release → %LOCALAPPDATA%\DX12Engine の順に探す。 */
  buildDir?: string;
  /** visible(窓を画面に出す起動)を許可する環境変数が立っているか。呼び出しの confirm:true も別に要る。 */
  allowVisible: boolean;
  /** 束縛が無く従来の探索も繋がらないとき、最初のエンジン呼び出しで専用エンジンを起動する。 */
  autolaunch: boolean;
  /** true でフリートのツールと監視を止める。 */
  disabled: boolean;
  /** テスト用: エンジン起動コマンドの差し替え(["node", "mockEngineProc.ts"] など)。 */
  engineCmd?: string[];
  /** テスト用: 資源の観測値の差し替え。 */
  fakeResources?: { vramFreeMB?: number; vramTotalMB?: number; ramFreeMB?: number } | null;
  /** dx12_engine_list {discover:true} が connect だけで探す、手動起動の候補ポート。 */
  discoverPorts: number[];
  /** レジストリのハートビート間隔と、これより古いと owner を死んだとみなす時間(ms)。 */
  heartbeatMs: number;
  heartbeatStaleMs: number;
  /** 監視タイマーの間隔(ms)。 */
  monitorMs: number;
};

export const DEFAULT_MAX = 3;
export const DEFAULT_IDLE_MIN = 10;
export const DEFAULT_MIN_FREE_VRAM_MB = 2048;
export const DEFAULT_MIN_FREE_RAM_MB = 3072;
export const DEFAULT_PORT_RANGE: [number, number] = [8860, 8899];

function num(v: string | undefined, dflt: number, min = 0): number {
  if (v === undefined || v.trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
}
function flag(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function parsePortRange(v: string | undefined): [number, number] {
  const m = /^\s*(\d{2,5})\s*[-:]\s*(\d{2,5})\s*$/.exec(v ?? "");
  if (!m) return DEFAULT_PORT_RANGE;
  const lo = Number(m[1]), hi = Number(m[2]);
  return lo >= 1024 && hi <= 65535 && lo <= hi ? [lo, hi] : DEFAULT_PORT_RANGE;
}

/** "8787,8850-8859" 形式のポート一覧。 */
export function parsePortList(v: string | undefined, dflt: number[]): number[] {
  if (!v || !v.trim()) return dflt;
  const out: number[] = [];
  for (const part of v.split(",")) {
    const m = /^\s*(\d{2,5})\s*(?:-\s*(\d{2,5}))?\s*$/.exec(part);
    if (!m) continue;
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
    for (let p = lo; p <= hi && p <= 65535 && out.length < 200; p++) out.push(p);
  }
  return out.length ? [...new Set(out)] : dflt;
}
export const DEFAULT_DISCOVER_PORTS: number[] = [8787, 8850, 8851, 8852, 8853, 8854, 8855, 8856, 8857, 8858, 8859];

export function defaultFleetDir(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".local", "share"));
  return path.join(local, "UnoEngine", "fleet");
}

export function loadFleetConfig(env: NodeJS.ProcessEnv = process.env): FleetConfig {
  let fake: FleetConfig["fakeResources"] = null;
  if (env.DX12_FLEET_FAKE_RESOURCES) {
    try { fake = JSON.parse(env.DX12_FLEET_FAKE_RESOURCES); } catch { fake = null; }
  }
  let engineCmd: string[] | undefined;
  if (env.DX12_FLEET_ENGINE_CMD) {
    try { const v = JSON.parse(env.DX12_FLEET_ENGINE_CMD); if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) engineCmd = v; } catch { /* 無視 */ }
  }
  return {
    dir: env.DX12_FLEET_DIR || defaultFleetDir(env),
    max: Math.max(1, Math.floor(num(env.DX12_FLEET_MAX, DEFAULT_MAX, 1))),
    idleMin: num(env.DX12_FLEET_IDLE_MIN, DEFAULT_IDLE_MIN, 0),
    minFreeVramMB: num(env.DX12_FLEET_MIN_FREE_VRAM_MB, DEFAULT_MIN_FREE_VRAM_MB),
    minFreeRamMB: num(env.DX12_FLEET_MIN_FREE_RAM_MB, DEFAULT_MIN_FREE_RAM_MB),
    portRange: parsePortRange(env.DX12_FLEET_PORT_RANGE),
    discoverPorts: parsePortList(env.DX12_FLEET_DISCOVER_PORTS, DEFAULT_DISCOVER_PORTS),
    buildDir: env.DX12_FLEET_BUILD_DIR || undefined,
    allowVisible: flag(env.DX12_MCP_ALLOW_VISIBLE),
    autolaunch: flag(env.DX12_FLEET_AUTOLAUNCH),
    disabled: flag(env.DX12_FLEET_DISABLE),
    engineCmd,
    fakeResources: fake,
    heartbeatMs: num(env.DX12_FLEET_HEARTBEAT_MS, 30_000, 50),
    heartbeatStaleMs: num(env.DX12_FLEET_HEARTBEAT_STALE_MS, 5 * 60_000, 100),
    monitorMs: num(env.DX12_FLEET_MONITOR_MS, 5_000, 20),
  };
}
