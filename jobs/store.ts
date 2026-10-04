// ジョブの永続化(ファイル)。%LOCALAPPDATA%\UnoEngine\jobs\<id>\ に置く。
//
//   state.json   … manager(MCP サーバ)だけが書く。ジョブの状態・引数・要約
//   spec.json    … manager が書く runner への実行計画(process 型のみ)
//   live.json    … runner だけが書く。実行中の進捗・子の pid・終了コード(process 型のみ)
//   log.txt      … 子の標準出力/標準エラー(process 型)、または inproc ジョブの行ログ
//   result.json  … 終了時の全文の結果(dx12_job_result)
//   artifacts\   … 成果物(スクショのバッチなど)
//   書き込みは同じフォルダの一時ファイル → rename(原子的)。読み取りはロック無しで、途中の破損・一時的な EBUSY は短く再試行する。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { JobRecord, LiveInfo } from "./types.ts";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number) { if (ms > 0) Atomics.wait(sleeper, 0, 0, ms); }

export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
      return;
    } catch (e: any) {
      lastErr = e;
      // Windows: 読み手が開いている間の rename は EPERM / EBUSY になる。少し待って取り直す。
      if (e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "EACCES") sleepSync(5 + attempt * 8);
      else break;
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* 無視 */ }
  throw lastErr;
}

export function readJsonFile<T>(file: string): T | null {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
    catch (e: any) {
      if (e?.code === "ENOENT") return null;
      sleepSync(5 + attempt * 5);   // 書き込み途中(EBUSY / 破損)を待つ
    }
  }
  return null;
}

/** ソート可能なジョブ id: j-YYYYMMDD-HHMMSS-xxxx(UTC)。 */
export function newJobId(now = Date.now()): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `j-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${crypto.randomBytes(2).toString("hex")}`;
}

export const JOB_ID_RE = /^j-\d{8}-\d{6}-[0-9a-f]{4}$/;

export type JobPaths = { dir: string; state: string; spec: string; live: string; log: string; result: string; artifacts: string };

export type History = Record<string, { durationsSec: number[] }>;

export class JobStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  pathsOf(id: string): JobPaths {
    const d = path.join(this.dir, id);
    return { dir: d, state: path.join(d, "state.json"), spec: path.join(d, "spec.json"), live: path.join(d, "live.json"), log: path.join(d, "log.txt"), result: path.join(d, "result.json"), artifacts: path.join(d, "artifacts") };
  }

  create(rec: JobRecord) {
    const p = this.pathsOf(rec.id);
    fs.mkdirSync(p.dir, { recursive: true });
    writeJsonAtomic(p.state, rec);
  }
  save(rec: JobRecord) { writeJsonAtomic(this.pathsOf(rec.id).state, rec); }
  load(id: string): JobRecord | null {
    if (!JOB_ID_RE.test(id)) return null;   // パス走査の防止(id は必ずこの形)
    const r = readJsonFile<JobRecord>(this.pathsOf(id).state);
    return r && r.id === id ? r : null;
  }
  ids(): string[] {
    try { return fs.readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && JOB_ID_RE.test(e.name)).map((e) => e.name).sort(); }
    catch { return []; }
  }
  all(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const id of this.ids()) { const r = this.load(id); if (r) out.push(r); }
    return out;
  }
  readLive(id: string): LiveInfo | null { return readJsonFile<LiveInfo>(this.pathsOf(id).live); }
  readResult<T = unknown>(id: string): T | null { return readJsonFile<T>(this.pathsOf(id).result); }

  /** ログの末尾 n 行(最大 maxBytes を読む)。 */
  tailLog(id: string, n: number, maxBytes = 256 * 1024): { lines: string[]; totalBytes: number; truncatedHead: boolean } {
    const f = this.pathsOf(id).log;
    try {
      const st = fs.statSync(f);
      const size = Math.min(st.size, maxBytes);
      const fd = fs.openSync(f, "r");
      try {
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, st.size - size);
        let text = buf.toString("utf8");
        const cut = st.size > size;
        if (cut) text = text.slice(text.indexOf("\n") + 1);   // 途中から読んだ先頭の欠けた行を捨てる
        const lines = text.split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        return { lines: lines.slice(-n), totalBytes: st.size, truncatedHead: cut || lines.length > n };
      } finally { fs.closeSync(fd); }
    } catch { return { lines: [], totalBytes: 0, truncatedHead: false }; }
  }

  // ── 種類ごとの所要時間の履歴(ETA の目安) ──────────────────────────
  private historyFile() { return path.join(this.dir, "history.json"); }
  readHistory(): History { return readJsonFile<History>(this.historyFile()) ?? {}; }
  recordDuration(kind: string, sec: number) {
    const h = this.readHistory();
    const cur = h[kind]?.durationsSec ?? [];
    cur.push(Math.round(sec * 10) / 10);
    h[kind] = { durationsSec: cur.slice(-10) };
    try { writeJsonAtomic(this.historyFile(), h); } catch { /* 履歴は無くても動く */ }
  }
  typicalSec(kind: string): number | null {
    const d = this.readHistory()[kind]?.durationsSec ?? [];
    if (!d.length) return null;
    const s = [...d].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** 終わって古い / 多すぎるジョブのフォルダを消す(動いているもの・protect は消さない)。 */
  gc(opts: { keepDays: number; keepMax: number; protect?: Set<string>; now?: number; terminal: (r: JobRecord) => boolean }): string[] {
    const now = opts.now ?? Date.now();
    const removed: string[] = [];
    const recs = this.all().filter((r) => opts.terminal(r) && !opts.protect?.has(r.id));
    recs.sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));   // 古い順
    const tooOld = new Set(recs.filter((r) => now - (r.finishedAt ?? r.createdAt) > opts.keepDays * 86400_000).map((r) => r.id));
    const extra = Math.max(0, recs.length - opts.keepMax);
    for (let i = 0; i < extra; i++) tooOld.add(recs[i].id);
    for (const id of tooOld) {
      try { fs.rmSync(this.pathsOf(id).dir, { recursive: true, force: true }); removed.push(id); } catch { /* 使用中。次回 */ }
    }
    return removed;
  }
}
