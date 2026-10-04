// ジョブの runner: 子プロセスを 1 つ走らせ、出力をログへ落とし、進捗を live.json へ書く小さなプロセス。
//   node runner.ts <spec.json>
//
//   なぜ別プロセスか: MCP サーバ(Node)が再起動しても、走っているビルドや cook を巻き込まず、終わった結果も失わないため。
//   runner は MCP サーバから切り離して(detached)起動される。書くのは live.json / log.txt / result.json だけで、state.json は書かない
//   (state.json の書き手は manager だけ。live.json の書き手は runner だけ = 競合しない)。
//   止めるときは manager が runner のプロセスツリーごと taskkill /T /F する(子も孫も一緒に落ちる)。
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { LiveInfo, RunnerSpec } from "./types.ts";
import { makeParser, parseJUnit, type LineParser, type ProgressUpdate } from "./parsers.ts";
import { writeJsonAtomic } from "./store.ts";

function killTreeSync(pid: number) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 8000 });
    else process.kill(-pid, "SIGKILL");
  } catch { /* 既に終了 */ }
}

export async function runJob(specFile: string): Promise<number> {
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8")) as RunnerSpec;
  const startedAt = Date.now();
  const live: LiveInfo = { runnerPid: process.pid, startedAt, updatedAt: startedAt };
  const parser: LineParser = makeParser(spec.parser);
  let logFd: number | null = null;
  let logBytes = 0;
  let logTruncated = false;
  const tail: string[] = [];
  let lastFlush = 0;
  let dirty = false;
  let child: ReturnType<typeof spawn> | null = null;
  let timedOut = false;
  let finished = false;

  try { logFd = fs.openSync(spec.logFile, "a"); } catch { logFd = null; }

  const flushLive = (force = false) => {
    const now = Date.now();
    if (!force && (!dirty || now - lastFlush < 250)) return;
    lastFlush = now; dirty = false;
    live.updatedAt = now;
    try { writeJsonAtomic(spec.liveFile, live); } catch { /* 書けなくても走り続ける */ }
  };

  const apply = (u: ProgressUpdate | null) => {
    if (!u) return;
    const cur = live.progress ?? { phase: "starting", pct: null, message: "" };
    const next = {
      phase: u.phase ?? cur.phase,
      pct: u.pct !== undefined ? u.pct : cur.pct,
      message: u.message ?? cur.message,
      ...(u.estimated ? { estimated: true } : {}),
    };
    // pct は単調に増やす(ninja の合計が途中で増えても、進捗バーが後退して見えないように)。phase が変わって null を明示したときだけ戻す。
    if (typeof next.pct === "number" && typeof cur.pct === "number" && u.pct !== null && next.pct < cur.pct && next.phase === cur.phase) next.pct = cur.pct;
    live.progress = next;
    dirty = true;
    flushLive();
  };

  const pushLine = (line: string) => {
    if (logFd !== null) {
      if (logBytes < spec.logMaxBytes) {
        const b = Buffer.from(line + "\n", "utf8");
        try { fs.writeSync(logFd, b); logBytes += b.length; } catch { /* ログが書けなくても続ける */ }
      } else if (!logTruncated) {
        logTruncated = true;
        try { fs.writeSync(logFd, Buffer.from(`\n[job] ログが上限(${spec.logMaxBytes} バイト)に達したので、以降は記録しない(進捗の解析は続く)\n`)); } catch { /* 無視 */ }
      }
    }
    tail.push(line);
    if (tail.length > 200) tail.shift();
    apply(parser.feed(line, Date.now()));
  };

  // 行の組み立て( 区切りの進捗表示も 1 行として扱う)。バイト列のまま改行で切り、1 行ずつ復号する:
  // UTF-8 として正しければ UTF-8、そうでなければ既定のコードページ(日本語 Windows の MSVC の診断は cp932)として読む。
  const strict = new TextDecoder("utf-8", { fatal: true });
  const fallback = (() => { try { return new TextDecoder(process.env.DX12_JOBS_FALLBACK_ENCODING || "shift_jis"); } catch { return new TextDecoder("utf-8"); } })();
  const decodeLine = (b: Buffer): string => { try { return strict.decode(b); } catch { return fallback.decode(b); } };
  const makeSplitter = () => {
    let buf: Buffer = Buffer.alloc(0);
    return {
      write(chunk: Buffer | string) {
        buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
        for (;;) {
          let i = -1;
          for (let k = 0; k < buf.length; k++) { const c = buf[k]; if (c === 0x0a || c === 0x0d) { i = k; break; } }
          if (i < 0) break;
          const line = buf.subarray(0, i);
          let skip = 1;
          if (buf[i] === 0x0d && buf[i + 1] === 0x0a) skip = 2;
          buf = buf.subarray(i + skip);
          if (line.length) pushLine(decodeLine(line));
        }
        if (buf.length > 65536) { pushLine(decodeLine(buf)); buf = Buffer.alloc(0); }   // 改行の無い巨大な出力の保険
      },
      flush() { if (buf.length) { pushLine(decodeLine(buf)); buf = Buffer.alloc(0); } },
    };
  };

  live.progress = { phase: "starting", pct: null, message: "起動中" };
  flushLive(true);

  const stdoutSplit = makeSplitter();
  const stderrSplit = makeSplitter();
  const tailSplit = makeSplitter();

  if (spec.belowNormal) { try { os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 権限が無ければそのまま */ } }

  let exitCode: number | null = null;
  let signal: string | null = null;
  let spawnError: { code?: string; message: string } | undefined;

  await new Promise<void>((resolve) => {
    try {
      child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      spawnError = { code: e?.code, message: String(e?.message ?? e) };
      resolve();
      return;
    }
    const c = child;
    c.on("error", (e: any) => { spawnError = { code: e?.code, message: String(e?.message ?? e) }; resolve(); });
    if (c.pid) {
      live.childPid = c.pid;
      if (spec.belowNormal) { try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 無視 */ } }
      flushLive(true);
    }
    c.stdout?.on("data", (d: Buffer) => stdoutSplit.write(d));
    c.stderr?.on("data", (d: Buffer) => stderrSplit.write(d));
    c.on("close", (code, sig) => { exitCode = code; signal = sig ?? null; resolve(); });

    // 子が書くログファイル(標準出力に進捗を出さない処理)を読み進める
    let tailPos = 0;
    const readTail = () => {
      if (!spec.tailFile) return;
      try {
        const st = fs.statSync(spec.tailFile);
        if (st.size < tailPos) tailPos = 0;   // 作り直された
        if (st.size > tailPos) {
          const fd = fs.openSync(spec.tailFile, "r");
          try {
            const len = Math.min(st.size - tailPos, 1024 * 1024);
            const b = Buffer.alloc(len);
            fs.readSync(fd, b, 0, len, tailPos);
            tailPos += len;
            tailSplit.write(b);
          } finally { fs.closeSync(fd); }
        }
      } catch { /* まだ無い */ }
    };
    const timers: ReturnType<typeof setInterval>[] = [];
    timers.push(setInterval(() => { readTail(); apply(parser.tick?.(Date.now()) ?? null); flushLive(); }, 500));
    // 心拍: 進捗が変わらなくても 5 秒ごとに live.json を更新する(manager が「runner が生きているか」を pid の再利用に騙されずに判定できるように)
    timers.push(setInterval(() => { dirty = true; flushLive(true); }, 5000));
    const to = setTimeout(() => { timedOut = true; pushLine(`[job] タイムアウト(${Math.round(spec.timeoutMs / 1000)} 秒)。プロセスツリーを終了する`); if (c.pid) killTreeSync(c.pid); }, spec.timeoutMs);
    c.on("close", () => { for (const t of timers) clearInterval(t); clearTimeout(to); readTail(); });
  });

  stdoutSplit.flush(); stderrSplit.flush(); tailSplit.flush();
  finished = true;
  void finished;

  const summary = parser.finish(exitCode);
  let junit: unknown = undefined;
  if (spec.junit) {
    try { const j = parseJUnit(fs.readFileSync(spec.junit, "utf8")); junit = { tests: j.tests, failures: j.failures, errors: j.errors, skipped: j.skipped, failed: j.failed.slice(0, 100) }; }
    catch { /* JUnit が無い(起動できなかった等) */ }
  }
  try {
    writeJsonAtomic(spec.resultFile, { kind: "process", jobId: spec.jobId, exitCode, signal, timedOut, summary, ...(junit ? { junit } : {}), tail: tail.slice(-60), ...(spawnError ? { spawnError } : {}), finishedAt: Date.now() });
  } catch { /* 無視 */ }
  live.exitCode = exitCode;
  live.signal = signal;
  live.timedOut = timedOut;
  if (spawnError) live.spawnError = spawnError;
  live.finishedAt = Date.now();
  if (exitCode === 0 && live.progress && live.progress.pct !== null) live.progress = { ...live.progress, phase: "done", pct: 100 };
  flushLive(true);
  if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* 無視 */ } }
  return 0;
}

// 直接実行されたときだけ走る(テストは runJob を import して使うことも、子として起動することもできる)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const specFile = process.argv[2];
  if (!specFile) { process.stderr.write("usage: node runner.ts <spec.json>\n"); process.exit(2); }
  runJob(specFile).then((c) => process.exit(c), (e) => { process.stderr.write(`runner: ${e?.stack ?? e}\n`); process.exit(1); });
}
