// ファイル書き込みジャーナル(TS 側の書き手)。エンジンの journal(src/core/mcp/McpJournal.h・docs/MCP.md §13-5)と同じフォルダ形式で、
// Node がファイルを書く操作(dx12_scene_write)の「上書き前の内容」を退避する。エンジンの journal_restore がそのまま復元できる。
//
//   <project>/.dx12/journal/<seq 6 桁>-<method>/manifest.json
//   <project>/.dx12/journal/<seq 6 桁>-<method>/files/<n>.bin
//   manifest.json = {version:1, id, method, label, createdAt(ms), state:"committed", txLabel:null, complete, files:[{path, existed, backup|null, bytes, skipped:null|"too_large"}]}
//   path は project 相対('/' 区切り)。project の外は絶対パス。
import fs from "node:fs";
import path from "node:path";

export const JOURNAL_MAX_FILE_BYTES = 64 * 1024 * 1024;

export type JournalFileInput = { absPath: string; /** 書く前の内容。無ければ(新規作成)null。 */ prev: Buffer | null };
export type JournalEntryInfo = { id: string; dir: string; complete: boolean; files: number };

function relPath(baseDir: string, abs: string): string {
  const b = path.resolve(baseDir);
  const a = path.resolve(abs);
  const rel = path.relative(b, a);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  return a.split(path.sep).join("/");
}

function nextSeq(root: string): number {
  let max = 0;
  try {
    for (const n of fs.readdirSync(root)) { const m = /^(\d{6})-/.exec(n); if (m) max = Math.max(max, Number(m[1])); }
  } catch { /* まだ無い */ }
  return max + 1;
}

/** 1 エントリを書く。書き込みに失敗したら null(ジャーナルが書けないことで本来の操作は止めない)。 */
export function writeJournalEntry(baseDir: string, method: string, label: string, files: JournalFileInput[], now = Date.now()): JournalEntryInfo | null {
  try {
    const root = path.join(baseDir, ".dx12", "journal");
    fs.mkdirSync(root, { recursive: true });
    // 同時に別の書き手(エンジン)が同じ seq を取ることがある。mkdir が失敗したら次の seq へ。
    let seq = nextSeq(root);
    let id = "";
    let dir = "";
    for (let i = 0; i < 20; i++, seq++) {
      id = `${String(seq).padStart(6, "0")}-${method}`;
      dir = path.join(root, id);
      try { fs.mkdirSync(dir); break; } catch (e: any) { if (e?.code !== "EEXIST" || i === 19) throw e; }
    }
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    let complete = true;
    const entries: Record<string, unknown>[] = [];
    let n = 0;
    for (const f of files) {
      const p = relPath(baseDir, f.absPath);
      if (f.prev === null) { entries.push({ path: p, existed: false, backup: null, bytes: 0, skipped: null }); continue; }
      if (f.prev.length > JOURNAL_MAX_FILE_BYTES) { complete = false; entries.push({ path: p, existed: true, backup: null, bytes: f.prev.length, skipped: "too_large" }); continue; }
      const backup = `files/${n++}.bin`;
      fs.writeFileSync(path.join(dir, backup), f.prev);
      entries.push({ path: p, existed: true, backup, bytes: f.prev.length, skipped: null });
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, id, method, label, createdAt: now, state: "committed", txLabel: null, complete, files: entries }, null, 2), "utf8");
    return { id, dir, complete, files: entries.length };
  } catch {
    return null;
  }
}
