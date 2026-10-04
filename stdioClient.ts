// テスト用の最小 MCP stdio クライアント(index.ts を子プロセスで起動し、JSON-RPC を話す)。
// 通知(id 無しのメッセージ。notifications/tools/list_changed など)も溜める。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

export type McpClient = {
  proc: ChildProcess;
  rpc: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
  /** tools/call の最後の text ブロックを JSON として返す(エラーも本文の JSON)。 */
  call: (name: string, args?: any) => Promise<any>;
  /** tools/call の生の result。 */
  raw: (name: string, args?: any) => Promise<any>;
  /** 受け取った通知(id 無し)。 */
  notifications: { method: string; params?: any; at: number }[];
  waitForNotification: (method: string, sinceIndex: number, timeoutMs?: number) => Promise<boolean>;
  stderr: () => string;
  initialize: () => Promise<any>;
  close: () => void;
};

// フリートのレジストリはテストごとの一時フォルダ(実ユーザーの %LOCALAPPDATA%/UnoEngine/fleet を触らない)。テストの終了時に消す。
const TEST_FLEET_DIR = path.join(os.tmpdir(), `dx12-fleet-test-${process.pid}`);
process.on("exit", () => { try { fs.rmSync(TEST_FLEET_DIR, { recursive: true, force: true }); } catch { /* 無視 */ } });

export function startMcp(env: Record<string, string>, opts: { cwd?: string } = {}): McpClient {
  const proc = spawn(process.execPath, [path.join(here, "index.ts")], {
    // フリートのレジストリはテストごとの一時フォルダ(実ユーザーの %LOCALAPPDATA%/UnoEngine/fleet を触らない)。
    cwd: opts.cwd ?? here, env: { ...process.env, DX12_MCP_CONNECT_BACKOFF_MS: "0", DX12_FLEET_DIR: TEST_FLEET_DIR, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nid = 1;
  let err = "";
  const pend = new Map<number, (m: any) => void>();
  const notifications: McpClient["notifications"] = [];
  proc.stdout!.setEncoding("utf8");
  proc.stderr!.setEncoding("utf8");
  proc.stderr!.on("data", (d: string) => { err += d; });
  proc.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      const m = JSON.parse(l);
      if (m.id === undefined) notifications.push({ method: m.method, params: m.params, at: Date.now() });
      else pend.get(m.id)?.(m);
    }
  });
  const rpc = (method: string, params: any = {}, timeoutMs = 30000) => new Promise<any>((res, rej) => {
    const id = nid++;
    const t = setTimeout(() => rej(new Error("timeout " + method)), timeoutMs);
    pend.set(id, (m) => { clearTimeout(t); res(m); });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const raw = async (name: string, args: any = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const call = async (name: string, args: any = {}) => {
    const r = await raw(name, args);
    const last = r.content[r.content.length - 1];
    try { return JSON.parse(last.text); } catch { return { _text: last.text, isError: r.isError }; }
  };
  return {
    proc, rpc, call, raw, notifications, stderr: () => err,
    async waitForNotification(method, sinceIndex, timeoutMs = 4000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (notifications.slice(sinceIndex).some((n) => n.method === method)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    async initialize() {
      const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    close() { try { proc.kill(); } catch { /* 既に終了 */ } },
  };
}
