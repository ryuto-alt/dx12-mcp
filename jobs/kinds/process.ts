// process 型のジョブ種別: build / ctest / ui_tests / external(+ プリセット vg_cook / ue_import)。
// どれも「コマンドを 1 つ組んで runner に渡す」だけ。進捗の解析は parsers.ts、実行は runner.ts。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { Fix } from "../../errors.ts";
import { locateBuild, materializeBin, createDisposableProject, rmRetry } from "../../fleet/instance.ts";
import { jobFail, type KindDef, type PrepareCtx, type ProcessPlan } from "../manager.ts";
import type { KindEnv } from "../env.ts";
import type { JobsConfig } from "../config.ts";

// ── 共通ヘルパ ───────────────────────────────────────────────────────────────
/** PATH から実行ファイルを探す(Windows は .exe / .cmd / .bat も)。 */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, name + e);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* 次へ */ }
  }
  return null;
}

export function toolMissing(what: string, cause: string, fix: Fix[], details: Record<string, unknown> = {}): never {
  return jobFail({ code: "E_JOB_TOOL_MISSING", message: `${what} が見つからない`, cause, retryable: false, fix, details });
}

const noDotDot = (s: string) => !s.split(/[\\/]/).includes("..");

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
/** 上限側から空きポートを探す(フリートの割当は下限側から取るので、ぶつかりにくい)。 */
export async function pickFreePortDescending(hi: number, lo: number): Promise<number> {
  for (let p = hi; p >= lo; p--) if (await portFree(p)) return p;
  return jobFail({ code: "E_INTERNAL", message: `空きポートが無い(${lo}〜${hi})`, retryable: true });
}

/** exe に UTF-16LE の文字列(wcscmp のリテラル)が入っているか。--ui-tests-skip 対応の検出に使う。 */
export function exeHasWideString(exe: string, needle: string): boolean {
  try { return fs.readFileSync(exe).includes(Buffer.from(needle, "utf16le")); } catch { return false; }
}

/** 簡易コマンドライン分割(空白区切り。"" と '' で囲めば空白を含められる)。shell は使わない。 */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ── build ───────────────────────────────────────────────────────────────────
export function buildKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "build", executor: "process",
    describe: "tools\\build.ps1 を実行する。ビルドは全セッションで直列化される(排他ロック)。進捗は ninja の [n/m]。",
    group: () => "build", timeoutSec: cfg.timeoutSec.build,
    shape: {
      target: z.union([z.string(), z.array(z.string())]).optional().describe("ビルドするターゲット 1 つ(例 DX12Engine / GameRuntime / McpSafetyTests)。省略で DX12Engine。1 回に 1 ターゲット(複数なら別々にジョブを作る。順番に処理される)。"),
      tests: z.boolean().optional().describe("true=テスト exe も全部ビルドする(build.ps1 -Tests)。ctest の前に必要。target とは併用しない。"),
      jobs: z.number().int().min(1).max(32).optional().describe("並列数(既定は論理コアの半分・最大 12)。"),
      dir: z.string().optional().describe("ビルドディレクトリ(リポジトリ相対。既定 build\\release)。"),
      refreshEngines: z.boolean().optional().describe("true=成功後に、自分の専用エンジンのうち exe コピーが古いものを最新へ入れ替えて再起動する(entityId は失効。dx12_engine_refresh と同じ)。既定 false。"),
    },
    normalize(a) {
      if (Array.isArray(a.target) && a.target.length === 1) a.target = a.target[0];
      return a;
    },
    check(a) {
      if (Array.isArray(a.target)) {
        return jobFail({
          code: "E_BAD_TYPE", message: "dx12_job_start build: target は 1 つだけ(1 回に 1 ターゲット)", retryable: false,
          cause: "build.ps1 は 1 回に 1 ターゲットが約束。複数ならジョブを別々に作れば順番に処理される(ビルドは常に 1 本ずつ)",
          fix: (a.target as string[]).slice(0, 4).map((t) => ({ tool: "dx12_job_start", args: { kind: "build", args: { target: t } }, why: `${t} をビルドする(順番待ちになる)` })),
        });
      }
      if (a.tests === true && a.target) return jobFail({ code: "E_BAD_TYPE", message: "dx12_job_start build: tests:true と target は併用できない", retryable: false, fix: [{ tool: "dx12_job_start", args: { kind: "build", args: { tests: true } }, why: "全ターゲット(テスト含む)をビルドする" }] });
      if (typeof a.dir === "string" && (!noDotDot(a.dir) || path.isAbsolute(a.dir))) return jobFail({ code: "E_BAD_TYPE", message: "dx12_job_start build: dir はリポジトリ相対(.. なし)", retryable: false });
    },
    prepare(a, ctx) {
      const extra: string[] = [];
      if (typeof a.target === "string" && a.target) extra.push("-Target", a.target);
      if (a.tests === true) extra.push("-Tests");
      if (typeof a.jobs === "number") extra.push("-Jobs", String(a.jobs));
      if (typeof a.dir === "string" && a.dir) extra.push("-Dir", a.dir);
      let cmd: string; let args: string[];
      if (cfg.buildCmd) { cmd = cfg.buildCmd[0]; args = [...cfg.buildCmd.slice(1), ...extra]; }
      else {
        const script = path.join(cfg.repoDir, "tools", "build.ps1");
        if (!fs.existsSync(script)) return toolMissing("tools\\build.ps1", `リポジトリのルート(${cfg.repoDir})に tools\\build.ps1 が無い。配布リポジトリ(dx12-mcp)にはビルドスクリプトが入っていない`, [{ command: "$env:DX12_REPO_DIR = 'C:\\Users\\ryuto\\Documents\\dx12'", why: "MCP サーバの環境にリポジトリのルートを設定して再起動する" }], { repoDir: cfg.repoDir });
        cmd = cfg.pwsh; args = ["-NoProfile", "-File", script, ...extra];
      }
      const plan: ProcessPlan = {
        cmd, args, cwd: cfg.repoDir, parser: { type: "build" },
        notes: [`コマンド: ${[cmd, ...args].join(" ")}`, "他のセッションがビルド中なら、その終了を待つ(phase=waiting_lock)"],
      };
      if (a.refreshEngines === true) {
        plan.post = async () => {
          const fleet = env.fleet();
          if (!fleet) return { refreshedEngines: [], refreshNote: "フリートが無効なので更新しなかった" };
          const list = await fleet.list();
          const stale = (list.engines ?? []).filter((e: any) => e.ownedByMe && e.exe?.stale);
          const refreshed: unknown[] = [];
          for (const e of stale) {
            try { const r = await fleet.refresh({ engine: e.id }); refreshed.push({ engine: e.id, pid: r?.pid ?? null, ok: true }); }
            catch (err: any) { refreshed.push({ engine: e.id, ok: false, error: String(err?.message ?? err).slice(0, 200) }); }
          }
          return { refreshedEngines: refreshed };
        };
      }
      return plan;
    },
  };
}

// ── ctest ───────────────────────────────────────────────────────────────────
export function findCtest(cfg: JobsConfig): string | null {
  if (cfg.ctestCmd) return cfg.ctestCmd[0];
  const p = onPath("ctest");
  if (p) return p;
  for (const c of ["C:\\Program Files\\CMake\\bin\\ctest.exe", "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\ctest.exe"]) if (fs.existsSync(c)) return c;
  return null;
}

export function ctestKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "ctest", executor: "process",
    describe: "ctest(ヘッドレス単体テスト)を実行する。進捗は n/N、失敗したテスト名の一覧を返す。テスト exe は先に build {tests:true} で用意する。",
    group: () => "ctest", timeoutSec: cfg.timeoutSec.ctest,
    shape: {
      dir: z.string().optional().describe("テストのビルドディレクトリ(リポジトリ相対。既定 build\\release)。"),
      filter: z.string().optional().describe("実行するテスト名の正規表現(ctest -R)。"),
      exclude: z.string().optional().describe("除外するテスト名の正規表現(ctest -E)。"),
      jobs: z.number().int().min(1).max(8).optional().describe("並列数(既定 2。PC を固めないため上限 8)。"),
      testTimeoutSec: z.number().int().min(10).max(3600).optional().describe("1 テストごとのタイムアウト(既定 300 秒)。"),
      rerunFailed: z.boolean().optional().describe("true=前回失敗したテストだけ再実行(ctest --rerun-failed)。"),
    },
    check(a) {
      if (typeof a.dir === "string" && (!noDotDot(a.dir) || path.isAbsolute(a.dir))) return jobFail({ code: "E_BAD_TYPE", message: "dx12_job_start ctest: dir はリポジトリ相対(.. なし)", retryable: false });
    },
    prepare(a, ctx) {
      const exe = findCtest(cfg);
      if (!exe) return toolMissing("ctest", "cmake / ctest が PATH に無い", [{ command: "$env:PATH = 'C:\\Program Files\\CMake\\bin;' + $env:PATH", why: "CMake の bin を PATH へ足して MCP サーバを再起動する" }]);
      const dirRel = typeof a.dir === "string" && a.dir ? a.dir : "build\\release";
      const dirAbs = path.resolve(cfg.repoDir, dirRel);
      if (!cfg.ctestCmd && !fs.existsSync(path.join(dirAbs, "CTestTestfile.cmake"))) {
        return toolMissing(`ctest のテスト定義(${dirRel}\\CTestTestfile.cmake)`, "そのビルドディレクトリが未構成、またはテストが未ビルド", [{ tool: "dx12_job_start", args: { kind: "build", args: { tests: true } }, why: "テスト exe を含めて全部ビルドする" }], { dir: dirAbs });
      }
      const junit = path.join(ctx.jobDir, "junit.xml");
      const args: string[] = cfg.ctestCmd ? [...cfg.ctestCmd.slice(1)] : ["--test-dir", dirAbs, "-j", String(a.jobs ?? 2), "--output-on-failure", "--output-junit", junit, "--timeout", String(a.testTimeoutSec ?? 300)];
      if (!cfg.ctestCmd) {
        if (typeof a.filter === "string" && a.filter) args.push("-R", a.filter);
        if (typeof a.exclude === "string" && a.exclude) args.push("-E", a.exclude);
        if (a.rerunFailed === true) args.push("--rerun-failed");
      }
      return { cmd: exe, args, cwd: cfg.repoDir, parser: { type: "ctest" }, ...(cfg.ctestCmd ? {} : { junit }), notes: [`コマンド: ${[exe, ...args].join(" ")}`], artifacts: cfg.ctestCmd ? [] : [{ path: junit, kind: "junit" }] };
    },
  };
}

// ── ui_tests ────────────────────────────────────────────────────────────────
const UI_SKIP_FLAG = "--ui-tests-skip";

export function uiTestsKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "ui_tests", executor: "process",
    describe: "エンジンの UI 自動テスト(--ui-tests-run-all)を、exe のコピー・使い捨てデータ領域・背景起動で走らせる。既定は build_game を除外する(Game.exe を前面起動して人の操作を奪うため)。",
    group: () => "ui_tests", timeoutSec: cfg.timeoutSec.ui_tests,
    shape: {
      skip: z.array(z.string()).optional().describe("除外するテスト名(--ui-tests-skip)。既定 [\"build_game\"]。exe が --ui-tests-skip に未対応の間は使えない(E_UNSUPPORTED)。"),
      includeBuildGame: z.boolean().optional().describe("true=build_game も走らせる(Game.exe を約 6 秒、前面の通常窓で起動して人の操作を奪う)。人が席を離れているときだけ。"),
      project: z.string().optional().describe("テストに使うプロジェクトのフォルダ(実プロジェクトは複製して使い、原本には触れない)。省略で最小の使い捨てプロジェクト。"),
      deep: z.boolean().optional().describe("true=超詳細診断だけ(--ui-tests-deep)。"),
      speed: z.number().int().min(0).max(2).optional().describe("0=Fast(既定) 1=Normal 2=Cinematic(--ui-tests-speed)。"),
      dpiScale: z.number().min(0.75).max(3).optional().describe("表示倍率(--dpi-scale)。"),
    },
    normalize(a) {
      if (!Array.isArray(a.skip) && a.includeBuildGame !== true) a.skip = ["build_game"];
      return a;
    },
    check(a) {
      if (a.includeBuildGame === true && Array.isArray(a.skip) && a.skip.includes("build_game")) return jobFail({ code: "E_BAD_TYPE", message: "dx12_job_start ui_tests: includeBuildGame:true と skip:[build_game] は矛盾する", retryable: false });
      for (const s of (a.skip as string[] | undefined) ?? []) if (!/^[A-Za-z0-9_.\- ]{1,80}$/.test(s)) return jobFail({ code: "E_BAD_TYPE", message: `dx12_job_start ui_tests: skip の名前 '${s}' が不正(英数字と _ . - のみ)`, retryable: false });
    },
    async prepare(a, ctx) {
      const { build, tried } = locateBuild({ buildDir: cfg.buildDir });
      if (!build) return toolMissing("DX12Engine.exe", "エンジンの exe(ビルド出力)が無い", [{ tool: "dx12_job_start", args: { kind: "build", args: {} }, why: "DX12Engine をビルドする" }], { tried });
      const skip: string[] = Array.isArray(a.skip) ? (a.skip as string[]) : [];
      const supportsSkip = exeHasWideString(build.exe, UI_SKIP_FLAG);
      if (skip.length > 0 && !supportsSkip) {
        return jobFail({
          code: "E_UNSUPPORTED", message: "この DX12Engine.exe は --ui-tests-skip に未対応(UI テストの除外機構が入る前のビルド)", retryable: false,
          cause: "build_game テストが Game.exe を前面で起動して人の操作を奪う。除外できない exe では UI テストを走らせない",
          fix: [{ tool: "dx12_job_start", args: { kind: "build", args: {} }, why: "最新のソース(UiTestHarness の除外機構を含む)で DX12Engine をビルドしてから再実行する" }],
          details: { exe: build.exe, skip },
        });
      }
      const bin = path.join(ctx.jobDir, "bin");
      const data = path.join(ctx.jobDir, "data");
      const proj = path.join(ctx.jobDir, "project");
      materializeBin(build, bin);
      fs.mkdirSync(data, { recursive: true });
      if (typeof a.project === "string" && a.project) copyProject(a.project, proj);
      else createDisposableProject(proj, "uitests");
      const port = await pickFreePortDescending(8899, 8880);
      const args = ["--background", "--no-splash-sound", "--project", proj, "--mcp-port", String(port), "--ui-tests-run-all"];
      if (a.deep === true) args.splice(args.indexOf("--ui-tests-run-all"), 1, "--ui-tests-deep");
      if (typeof a.speed === "number") args.push(`--ui-tests-speed=${a.speed}`);
      if (typeof a.dpiScale === "number") args.push("--dpi-scale", String(a.dpiScale));
      if (skip.length > 0) args.push(UI_SKIP_FLAG, skip.join(","));
      const notes = [`exe コピー: ${path.join(bin, "DX12Engine.exe")}(元: ${build.exe}。元の exe は直接起動しない)`, `プロジェクト: ${proj}${a.project ? `(${a.project} の複製)` : "(使い捨て)"}`, `除外: ${skip.length ? skip.join(",") : "なし"}`];
      if (a.includeBuildGame === true) notes.push("build_game を含む: Game.exe が約 6 秒、前面に出る");
      return {
        cmd: path.join(bin, "DX12Engine.exe"), args, cwd: bin,
        env: { DX12E_DATA_DIR: data, DX12E_NO_SPLASH: "1" },
        parser: { type: "uitests", expectedSec: ctx.typicalSec && ctx.typicalSec > 20 ? Math.round(ctx.typicalSec * 0.85) : 120 },
        tailFile: path.join(bin, "dx12_engine.log"),
        junit: path.join(bin, "ui_test_results.xml"),
        notes,
        cleanup: () => {
          // 結果とログの末尾だけ残し、exe コピー・データ領域・プロジェクトは消す(約 30 MB + プロジェクト)
          try {
            const j = path.join(bin, "ui_test_results.xml");
            if (fs.existsSync(j)) fs.copyFileSync(j, path.join(ctx.jobDir, "ui_test_results.xml"));
            const l = path.join(bin, "dx12_engine.log");
            if (fs.existsSync(l)) { const b = fs.readFileSync(l); fs.writeFileSync(path.join(ctx.jobDir, "engine.log"), b.subarray(Math.max(0, b.length - 512 * 1024))); }
          } catch { /* 無視 */ }
          for (const d of [bin, data, proj]) rmRetry(d, 8);
        },
        artifacts: [{ path: path.join(ctx.jobDir, "ui_test_results.xml"), kind: "junit" }, { path: path.join(ctx.jobDir, "engine.log"), kind: "log" }],
      };
    },
  };
}

/** 実プロジェクトを複製する(.git / build / バックアップ / .autosave は除く。500 MB を超えるなら断る)。 */
export function copyProject(src: string, dst: string) {
  const abs = path.resolve(src);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return jobFail({ code: "E_NOT_FOUND", message: `dx12_job_start ui_tests: project '${src}' が無い(フォルダ)`, retryable: false });
  const skipName = (n: string) => n === ".git" || n === "build" || n === "node_modules" || n === "backups" || n.startsWith(".autosave") || n.endsWith(".autosave");
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skipName(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { total += fs.statSync(p).size; } catch { /* 無視 */ } }
      if (total > 500 * 1024 * 1024) return;
    }
  };
  walk(abs);
  if (total > 500 * 1024 * 1024) return jobFail({ code: "E_VALIDATION_FAILED", message: `dx12_job_start ui_tests: project が大きすぎる(500 MB 超)。複製せず、小さなテスト用プロジェクトを指定する`, retryable: false });
  fs.cpSync(abs, dst, { recursive: true, filter: (s) => !skipName(path.basename(s)) });
}

// ── external / vg_cook / ue_import ─────────────────────────────────────────────
const progressProto = z.enum(["protocol", "percent", "none"]);

export function externalKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "external", executor: "process",
    describe: "任意の外部プロセスをジョブとして走らせる(guarded: 承認が要る)。標準出力の 1 行 JSON `@progress {\"pct\":42,\"phase\":\"cook\",\"msg\":\"…\",\"eta\":30}` と `@result {…}` を進捗・結果として読む。",
    group: () => "external", timeoutSec: cfg.timeoutSec.external,
    shape: {
      command: z.union([z.string(), z.array(z.string())]).describe("実行するコマンド。配列(推奨: [exe, ...引数])か 1 行の文字列(空白区切り。\"\" で囲める)。shell は使わない。"),
      cwd: z.string().optional().describe("作業ディレクトリ(既定 リポジトリのルート)。"),
      env: z.record(z.string()).optional().describe("追加の環境変数(文字列のみ)。"),
      progress: progressProto.optional().describe("protocol(既定)=@progress 行 / percent=@progress に加えて「NN%」を含む行も進捗に使う / none=進捗なし。"),
      artifacts: z.array(z.string()).optional().describe("成功したら成果物として記録するファイル/フォルダのパス。"),
    },
    check(a, ctx) {
      if (!ctx.approved) {
        return jobFail({
          code: "E_GUARDED", message: "dx12_job_start external: 任意の外部プロセスの実行は承認が要る(guarded)", retryable: false,
          cause: "任意のコマンドを走らせる操作なので、eval_lua / build_game と同じ扱い。ユーザーが承認したときだけ実行する。決まった道具だけなら kind:'vg_cook' / 'ue_import' / 'build' を使う(承認不要)",
          fix: [{ tool: "dx12_call_guarded", args: { name: "dx12_job_start", args: { kind: "external", args: a } }, why: "ユーザーの承認を得て実行する(core 面。full 面は dx12_call {confirm:true})" }],
        });
      }
      const c = a.command;
      const list = typeof c === "string" ? splitCommand(c) : (c as string[]);
      if (!list.length || !list[0]) return jobFail({ code: "E_MISSING_PARAM", message: "dx12_job_start external: command が空", retryable: false });
    },
    prepare(a, ctx) {
      const list = typeof a.command === "string" ? splitCommand(a.command) : (a.command as string[]);
      const cwd = typeof a.cwd === "string" && a.cwd ? path.resolve(cfg.repoDir, a.cwd) : cfg.repoDir;
      if (!fs.existsSync(cwd)) return jobFail({ code: "E_NOT_FOUND", message: `dx12_job_start external: cwd '${cwd}' が無い`, retryable: false });
      const envVars: Record<string, string> = { ...((a.env as Record<string, string>) ?? {}) };
      const eng = ctx.job.engine;
      const port = eng ? env.enginePort(eng) : undefined;
      if (port) envVars.DX12_MCP_PORT = String(port);
      const prog = (a.progress as string | undefined) ?? "protocol";
      const arts = ((a.artifacts as string[] | undefined) ?? []).map((p) => ({ path: path.resolve(cwd, p), kind: "artifact" }));
      return {
        cmd: list[0], args: list.slice(1), cwd, env: envVars,
        parser: prog === "none" ? { type: "none" } : { type: "protocol", fallbackPercent: prog === "percent" },
        notes: [`コマンド: ${list.join(" ")}`, ...(port ? [`エンジン ${eng}(port ${port})を DX12_MCP_PORT で渡した`] : [])],
        artifacts: arts,
      };
    },
  };
}

function findVgeoCook(cfg: JobsConfig): string | null {
  const cands = [
    process.env.DX12_VGEO_COOK ?? "",
    path.join(cfg.repoDir, "build", "release", "tools", "vgeo_cook", "vgeo_cook.exe"),
    path.join(cfg.repoDir, "build", "release", "vgeo_cook.exe"),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return onPath("vgeo_cook");
}

export function vgCookKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "vg_cook", executor: "process",
    describe: "仮想ジオメトリの cooker(vgeo_cook)で VGSRC / OBJ を .vgeo へ cook する。ツールが無ければ build {target:'vgeo_cook'} を案内する。",
    group: () => "external", timeoutSec: cfg.timeoutSec.vg_cook,
    shape: {
      input: z.string().optional().describe("入力(.vgsrc / .obj)。genBench を使うなら不要。"),
      output: z.string().describe("出力の .vgeo パス。"),
      genBench: z.object({ kind: z.enum(["blob", "knot", "rock", "torus", "sphere", "grid"]), tris: z.number().int().min(1000).max(500_000_000), seed: z.number().int().optional() }).optional().describe("合成ベンチメッシュを生成してそのまま cook する。"),
      threads: z.number().int().min(1).max(64).optional().describe("スレッド数(既定は論理コア/4)。"),
      memLimitGb: z.number().min(0).max(64).optional().describe("作業メモリの上限(GB、既定 10。0=無効)。"),
      options: z.array(z.string()).optional().describe("vgeo_cook のその他のオプション(例 [\"--group-method\",\"meshopt\"])。--で始まる語と値のみ。"),
    },
    check(a) {
      if (!a.input && !a.genBench) return jobFail({ code: "E_MISSING_PARAM", message: "dx12_job_start vg_cook: input か genBench のどちらかが要る", retryable: false, fix: [{ tool: "dx12_job_start", args: { kind: "vg_cook", args: { genBench: { kind: "blob", tris: 1000000 }, output: "blob.vgeo" } }, why: "合成メッシュの例" }] });
      for (const o of (a.options as string[] | undefined) ?? []) if (!/^[A-Za-z0-9_.\-:=\\/]+$/.test(o)) return jobFail({ code: "E_BAD_TYPE", message: `dx12_job_start vg_cook: options に使えない文字がある('${o}')`, retryable: false });
    },
    prepare(a, ctx) {
      const exe = findVgeoCook(cfg);
      if (!exe) return toolMissing("vgeo_cook.exe", "cooker が未ビルド(build\\release\\tools\\vgeo_cook\\vgeo_cook.exe)", [{ tool: "dx12_job_start", args: { kind: "build", args: { target: "vgeo_cook" } }, why: "vgeo_cook をビルドする" }], { repoDir: cfg.repoDir });
      const out = path.resolve(String(a.output));
      const args: string[] = [];
      const gb = a.genBench as { kind: string; tris: number; seed?: number } | undefined;
      if (gb) { args.push("--gen-bench", gb.kind, "--tris", String(gb.tris)); if (gb.seed !== undefined) args.push("--seed", String(gb.seed)); args.push("--cook", out); }
      else args.push(path.resolve(String(a.input)), out);
      if (typeof a.threads === "number") args.push("--threads", String(a.threads));
      if (typeof a.memLimitGb === "number") args.push("--mem-limit-gb", String(a.memLimitGb));
      const json = path.join(ctx.jobDir, "cook.json");
      args.push("--json", json, ...((a.options as string[] | undefined) ?? []));
      return {
        cmd: exe, args, cwd: path.dirname(out), parser: { type: "protocol", fallbackPercent: true },
        notes: [`コマンド: ${exe} ${args.join(" ")}`],
        artifacts: [{ path: out, kind: "vgeo" }, { path: json, kind: "stats" }],
      };
    },
  };
}

function findDotnet(): string | null {
  const local = "C:\\Users\\ryuto\\.dotnet10\\dotnet.exe";
  if (fs.existsSync(local)) return local;
  return onPath("dotnet");
}

export function ueImportKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "ue_import", executor: "process",
    describe: "UE の cook 済み StaticMesh を VGSRC へ取り出す(tools/ue_cook。ファイルを読むだけ。UE もゲームも起動しない)。出力はリポジトリの外へ(PUBLIC のため実アセットをコミットさせない)。",
    group: () => "external", timeoutSec: cfg.timeoutSec.ue_import,
    shape: {
      command: z.enum(["list_nanite", "extract", "extract_all", "info"]).describe("list_nanite=StaticMesh の列挙 / info=1 メッシュの詳細 / extract=1 メッシュを VGSRC へ / extract_all=全部(または filter 一致)を DIR へ。"),
      paks: z.string().describe("cook 済みの Paks フォルダ(…\\Content\\Paks)。"),
      usmap: z.string().describe(".usmap ファイル(UE5.6 は必須)。"),
      ue: z.string().optional().describe("UE のバージョン(例 5.6)。"),
      package: z.string().optional().describe("extract / info の対象パッケージ(パスか一意な部分一致)。"),
      out: z.string().optional().describe("extract の出力 .vgsrc / extract_all の出力フォルダ。リポジトリの外(または tools/ue_cook/out)。"),
      filter: z.string().optional().describe("list_nanite / extract_all の絞り込み文字列。"),
      onlyNanite: z.boolean().optional().describe("Nanite メッシュだけ。"),
      maxTris: z.number().int().optional().describe("Nanite の入力三角形数の上限(既定 6,000,000)。"),
      force: z.boolean().optional().describe("maxTris を無視する。"),
      memLimitMb: z.number().int().min(512).max(16384).optional().describe("ワーキングセット上限(既定 8192)。"),
    },
    check(a) {
      const cmd = a.command as string;
      if ((cmd === "extract" || cmd === "info") && !a.package) return jobFail({ code: "E_MISSING_PARAM", message: `dx12_job_start ue_import: ${cmd} には package が要る`, retryable: false });
      if ((cmd === "extract" || cmd === "extract_all") && !a.out) return jobFail({ code: "E_MISSING_PARAM", message: `dx12_job_start ue_import: ${cmd} には out が要る`, retryable: false });
      if (typeof a.out === "string") {
        const outAbs = path.resolve(a.out).toLowerCase();
        const repo = cfg.repoDir.toLowerCase();
        const okInRepo = outAbs.startsWith(path.join(repo, "tools", "ue_cook", "out").toLowerCase());
        if (outAbs.startsWith(repo + path.sep) && !okInRepo) return jobFail({ code: "E_VALIDATION_FAILED", message: "dx12_job_start ue_import: out はリポジトリの外(または tools/ue_cook/out)にする", retryable: false, cause: "このリポジトリは PUBLIC。UE / Dreamcore 由来の実アセットをコミット対象の場所に出さない" });
      }
    },
    prepare(a, ctx) {
      const dotnet = findDotnet();
      if (!dotnet) return toolMissing("dotnet(.NET 10 SDK)", "ue_cook は C# 製", [{ command: "winget install Microsoft.DotNet.SDK.10", why: ".NET 10 SDK を入れる" }]);
      const dll = path.join(cfg.repoDir, "tools", "ue_cook", "bin", "Release", "net10.0", "ue_cook.dll");
      if (!fs.existsSync(dll)) return toolMissing("tools\\ue_cook のビルド(ue_cook.dll)", "ue_cook が未ビルド", [{ command: "cd tools\\ue_cook; dotnet build -c Release", why: "ue_cook をビルドする(README のとおり .NET 10 の PATH が要る)" }], { dll });
      const args = [dll, "--paks", String(a.paks), "--usmap", String(a.usmap)];
      if (a.ue) args.push("--ue", String(a.ue));
      const c = a.command as string;
      if (c === "list_nanite") { args.push("--list-nanite"); if (a.filter) args.push("--filter", String(a.filter)); if (a.onlyNanite) args.push("--only-nanite"); }
      else if (c === "info") args.push("--info", String(a.package));
      else if (c === "extract") { args.push("--extract", String(a.package), "--out", path.resolve(String(a.out))); if (a.maxTris !== undefined) args.push("--max-tris", String(a.maxTris)); if (a.force) args.push("--force"); }
      else { args.push("--extract-all", path.resolve(String(a.out))); if (a.filter) args.push("--filter", String(a.filter)); if (a.onlyNanite) args.push("--only-nanite"); }
      if (a.memLimitMb !== undefined) args.push("--mem-limit-mb", String(a.memLimitMb));
      const dotnetDir = path.dirname(dotnet);
      return {
        cmd: dotnet, args, cwd: ctx.jobDir, env: { PATH: `${dotnetDir}${path.delimiter}${process.env.PATH ?? ""}`, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
        parser: { type: "protocol", fallbackPercent: true },
        notes: [`コマンド: ${dotnet} ${args.join(" ")}`, "ファイルを読むだけ(UE もゲームも起動しない)"],
        artifacts: a.out ? [{ path: path.resolve(String(a.out)), kind: c === "extract_all" ? "dir" : "vgsrc" }] : [],
      };
    },
  };
}

