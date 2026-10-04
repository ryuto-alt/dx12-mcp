// フリート・レジストリ: 複数の MCP サーバ(=複数エージェント)が同時に読み書きしても壊れないファイル。
//
//   ・排他: registry.lock を open(..., "wx")(原子的な排他作成)で取る。中身は {pid, startMs, token}。
//   ・古いロックの回収: 保持者の pid が死んでいる / mtime が staleLockMs より古いロックは rename で自分専用の名前へ移して消す
//     (rename は原子的なので、回収を試みる複数のプロセスのうち 1 つだけが成功する)。
//   ・原子的な置換: 同じフォルダの一時ファイルへ書いてから rename で置換。読み取りはロック無し(ENOENT/破損は短く再試行)。
//   ・変更は必ず transaction(fn) の中で行う(ロック → 読む → fn → 書く → 解放)。台数の上限判定・ポート割当・追加を 1 つの
//     トランザクションにすれば、同時に来た複数の launch でも上限を超えない。
//
// 全部同期 API(短いトランザクション)。exit ハンドラからも使える。スリープは Atomics.wait。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pidAlive } from "./proc.ts";

export type EngineMode = "background" | "headless" | "visible";

export type Entry = {
  id: string;
  name: string;
  /** starting=予約済みで起動中 / ready=ping に応答した */
  state: "starting" | "ready";
  owner: { pid: number; startMs: number; heartbeatAt: number };
  pid: number;
  /** プロセスのイメージ名(kill の前に一致を確認する)。 */
  imageName: string;
  port: number;
  mode: EngineMode;
  project: { dir: string; disposable: boolean };
  exe: { path: string; sourcePath: string; sourceMtimeMs: number; sizeBytes: number; copiedAt: number };
  startedAt: number;
  lastActivityAt: number;
  idleExitMin: number;
  args: string[];
};

export type RegistryData = { version: 1; updatedAt: number; engines: Record<string, Entry> };

export type RegistryOptions = {
  staleLockMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
};

const sab = new SharedArrayBuffer(4);
const sleeper = new Int32Array(sab);
export function sleepSync(ms: number) { if (ms > 0) Atomics.wait(sleeper, 0, 0, ms); }

export const emptyRegistry = (): RegistryData => ({ version: 1, updatedAt: 0, engines: {} });

export class FleetLockTimeout extends Error {
  readonly holder: unknown;
  constructor(msg: string, holder: unknown) { super(msg); this.name = "FleetLockTimeout"; this.holder = holder; }
}

export class Registry {
  readonly dir: string;
  readonly file: string;
  readonly lockFile: string;
  private staleLockMs: number;
  private lockTimeoutMs: number;
  private now: () => number;

  constructor(dir: string, opts: RegistryOptions = {}) {
    this.dir = dir;
    this.file = path.join(dir, "registry.json");
    this.lockFile = path.join(dir, "registry.lock");
    this.staleLockMs = opts.staleLockMs ?? 15_000;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── 読み取り(ロック無し) ────────────────────────────────────────────
  read(): RegistryData {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const txt = fs.readFileSync(this.file, "utf8");
        const j = JSON.parse(txt);
        if (j && typeof j === "object" && j.engines && typeof j.engines === "object") return { version: 1, updatedAt: Number(j.updatedAt) || 0, engines: j.engines };
        return emptyRegistry();
      } catch (e: any) {
        if (e?.code === "ENOENT") return emptyRegistry();
        // JSON 破損・EPERM/EBUSY(置換の瞬間)は短く再試行
        sleepSync(5 + attempt * 5);
      }
    }
    return emptyRegistry();
  }

  // ── ロック ─────────────────────────────────────────────────────────
  private tryCreateLock(token: string): boolean {
    try {
      const fd = fs.openSync(this.lockFile, "wx");
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, startMs: this.now(), token })); } finally { fs.closeSync(fd); }
      return true;
    } catch (e: any) {
      if (e?.code === "EEXIST" || e?.code === "EPERM" || e?.code === "EACCES" || e?.code === "EBUSY") return false;
      throw e;
    }
  }

  /** 古い(保持者が死んでいる/古すぎる)ロックを回収する。回収した(または既に無かった)なら true。 */
  private reclaimIfStale(): boolean {
    let holder: { pid?: number; token?: string } | null = null;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.lockFile).mtimeMs;
      try { holder = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { holder = null; }
    } catch (e: any) {
      return e?.code === "ENOENT";
    }
    const dead = holder?.pid ? !pidAlive(holder.pid) : this.now() - mtimeMs > 1000;   // 中身が読めない = 書きかけ。1 秒待って古ければ回収
    const tooOld = this.now() - mtimeMs > this.staleLockMs;
    if (!dead && !tooOld) return false;
    const grave = `${this.lockFile}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    try { fs.renameSync(this.lockFile, grave); } catch { return true; }   // 他のプロセスが先に回収した
    // 回収したのが、読んだ時と別の(生きている)ロックだったら戻す(link は既に在れば失敗する=他人のロックを壊さない)
    try {
      const g = JSON.parse(fs.readFileSync(grave, "utf8"));
      if (holder?.token && g?.token !== holder.token && g?.pid && pidAlive(g.pid)) {
        try { fs.linkSync(grave, this.lockFile); } catch { /* 別のプロセスが取った。諦める */ }
      }
    } catch { /* 読めない = 書きかけの残骸。捨てる */ }
    try { fs.rmSync(grave, { force: true }); } catch { /* 無視 */ }
    return true;
  }

  private acquire(): string {
    const token = crypto.randomBytes(8).toString("hex");
    const deadline = this.now() + this.lockTimeoutMs;
    let spins = 0;
    for (;;) {
      if (this.tryCreateLock(token)) return token;
      if (this.reclaimIfStale()) { if (this.tryCreateLock(token)) return token; }
      if (this.now() > deadline) {
        let holder: unknown = null;
        try { holder = JSON.parse(fs.readFileSync(this.lockFile, "utf8")); } catch { /* 無視 */ }
        throw new FleetLockTimeout(`フリートのレジストリのロックを ${this.lockTimeoutMs}ms 待っても取れなかった`, holder);
      }
      spins++;
      sleepSync(3 + Math.floor(Math.random() * Math.min(40, 5 + spins)));
    }
  }

  private release(token: string) {
    try {
      const cur = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      if (cur?.token !== token) return;   // 回収されて別の人のロックになっている。消さない
    } catch { return; }
    try { fs.rmSync(this.lockFile, { force: true }); } catch { /* 無視 */ }
  }

  // ── 書き込み(原子的な置換) ─────────────────────────────────────────
  private write(data: RegistryData) {
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { fs.renameSync(tmp, this.file); return; }
      catch (e: any) {
        lastErr = e;
        if (e?.code !== "EPERM" && e?.code !== "EBUSY" && e?.code !== "EACCES") break;
        sleepSync(5 + attempt * 5);
      }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 無視 */ }
    throw lastErr;
  }

  /** ロック → 読む → fn(data を直接書き換えてよい)→ 変化があれば書く → 解放。fn の戻り値を返す。 */
  transaction<T>(fn: (data: RegistryData) => T): T {
    const token = this.acquire();
    try {
      const data = this.read();
      const before = JSON.stringify(data.engines);
      const result = fn(data);
      if (JSON.stringify(data.engines) !== before) {
        data.updatedAt = this.now();
        this.write(data);
      }
      return result;
    } finally {
      this.release(token);
    }
  }
}
