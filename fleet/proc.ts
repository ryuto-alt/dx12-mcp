// プロセスの生死・イメージ名の確認・プロセスツリーごとの終了(Windows: taskkill /T /F)。
// ★殺すのは呼び出し側が渡した pid だけで、イメージ名が記録と一致するときに限る(名前で全部殺さない)。
import { spawn, spawnSync } from "node:child_process";

/** pid のプロセスが生きているか(権限が無くて信号を送れない場合も「生きている」)。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; }
}

/** pid のイメージ名(例 "DX12Engine.exe")。存在しなければ null。tasklist の CSV を読む。 */
export function imageOf(pid: number): string | null {
  if (!pidAlive(pid)) return null;
  if (process.platform !== "win32") {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 });
    const s = (r.stdout ?? "").trim();
    return s ? s.split("/").pop()! : null;
  }
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1];
  }
  return null;
}

/** pid が生きていて、イメージ名が expected と(大文字小文字を無視して)一致するか。 */
export function isProcessOf(pid: number, expectedImage: string): boolean {
  const img = imageOf(pid);
  return img !== null && img.toLowerCase() === expectedImage.toLowerCase();
}

/** プロセスツリーごと強制終了(同期。exit ハンドラからも使える)。生きていなければ何もしない。 */
export function killTreeSync(pid: number): boolean {
  if (!pidAlive(pid)) return true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 8000, windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 既に終了 */ } }
  }
  return !pidAlive(pid);
}

/** 非同期版(MCP サーバの本線を塞がない)。終了を最大 timeoutMs 待つ。 */
export async function killTree(pid: number, timeoutMs = 8000): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const c = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      c.on("exit", () => resolve());
      c.on("error", () => resolve());
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 既に終了 */ } }
  }
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 50));
  return !pidAlive(pid);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
