// フリートのセッション内シングルトン(遅延生成)。使われるまで何も作らない = フリートを使わない運用は従来と同じ。
import { router } from "../toolset/core.ts";
import { loadFleetConfig, type FleetConfig } from "./config.ts";
import { Fleet } from "./fleet.ts";

let instance: Fleet | null = null;
let hooksInstalled = false;

export function fleetConfig(): FleetConfig { return instance?.cfg ?? loadFleetConfig(); }
export function fleetIfCreated(): Fleet | null { return instance; }

/**
 * MCP サーバが終わるときに自分のエンジンを全部止める。
 *   stdio クローズ(クライアント終了)/ SIGINT / SIGTERM / SIGBREAK / SIGHUP / 未捕捉例外 / exit。
 *   強制終了(TerminateProcess)ではハンドラが走らない → エンジン側の --owner-pid と次回起動時の孤児スイープが受け持つ。
 */
export function installProcessHooks(fleet: Fleet) {
  if (hooksInstalled) return;
  hooksInstalled = true;
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { fleet.shutdownSync(); } catch { /* 終了処理の失敗で落とさない */ } };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
    try { process.on(sig, () => { cleanup(); process.exit(0); }); } catch { /* このプラットフォームに無い信号 */ }
  }
  process.on("uncaughtException", (e: any) => {
    process.stderr.write(`[dx12-mcp] uncaughtException: ${e?.stack ?? e}\n`);
    cleanup(); process.exit(1);
  });
  process.stdin.on("end", () => { cleanup(); process.exit(0); });
  process.stdin.on("close", () => { cleanup(); process.exit(0); });
}

/** 初回に呼ばれたときだけフリートを作る(レジストリのフォルダを作り、終了フックを入れる)。 */
export function getFleet(): Fleet {
  if (!instance) {
    const cfg = loadFleetConfig();
    instance = new Fleet({ cfg, router });
    installProcessHooks(instance);
    instance.startMonitor();
  }
  return instance;
}
