/**
 * ヘッドレスのエンジンへ直接つないでシーンを検証する CI クライアント。
 *
 * なぜ MCP サーバー(index.ts)を経由しないのか:
 *   MCP は「AI が対話しながら 1 手ずつ操作する」ための口で、stdio 越しの 1 クライアント専用。
 *   CI は「窓も AI も無い所で、何十シーンかをまとめて検証して終了コードを返す」用途なので、
 *   エンジンの TCP を直接叩く方が素直（並列にも走らせられる）。
 *   検証ロジック本体（配置検査・到達性・台本）はエンジンと playtest.ts に入っているので、
 *   ここはその呼び出しと集計だけを持つ。
 *
 * 使い方（どちらでもよい）:
 *   ① 自分で起動する
 *      node ciClient.ts --launch <projectDir> --scenes scenes/main.json,scenes/title.json
 *      → 空きポートを選んでヘッドレスで起動し、検査して、終了コードを返して engine も落とす
 *   ② 既に動いているエンジンへ繋ぐ（対話中のエディタでもよい）
 *      node ciClient.ts --port 8850 --scenes scenes/main.json
 *   --playtests を足すと、保存済みの .playtest（人が遊んだ記録）も再生して突き合わせる
 *
 * 終了コード: 0 = 全シーン合格 / 1 = どれかに errors か到達不能があった
 */

import net from "node:net";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzePath, compileTimeline, danglingKeys, mouseDeltaForYaw, wrapDeg,
  type MovementCapability, type ScriptStep, type TraceSample,
} from "./playtest.ts";
import {
  compareReplay, playtestDir, validatePlaytest, type PlaytestFile,
} from "./playtestStore.ts";

// ─── エンジンへの生接続（行 JSON） ───────────────────────────────────────

export interface EngineConn {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  close(): void;
}

export async function connect(port: number, host = "127.0.0.1"): Promise<EngineConn> {
  const sock = net.createConnection(port, host);
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", rej);
  });
  sock.setNoDelay(true);

  let buf = "";
  const waiters: ((v: any) => void)[] = [];
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });

  let seq = 0;
  return {
    call(method, params = {}, timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
        waiters.push((r: any) => {
          clearTimeout(timer);
          if (r.ok === false) {
            const e: any = new Error(`${method}: ${r.error}`);
            e.code = r.error_code;
            reject(e);
          } else resolve(r.result ?? {});
        });
        sock.write(JSON.stringify({ id: ++seq, method, params }) + "\n");
      });
    },
    close() { sock.end(); },
  };
}

/** エンジンが自分で書いたポート（--mcp-port を指定していないインスタンス用）。 */
export function defaultPort(): number {
  return Number(fs.readFileSync(path.join(os.tmpdir(), "dx12_mcp.port"), "utf8").trim());
}

// ─── 検証（純粋な集計部分はテストできるよう分けてある） ──────────────────

export interface SceneReport {
  scene: string;
  errors: number;
  warnings: number;
  checked: number;
  issues: { kind: string; name?: string; text: string; level: string }[];
  reachability?: { pass: boolean; detail: string }[];
  failed: boolean;
}

/** 1 シーンぶんの結果から「CI を落とすか」を決める。errors だけを落とす条件にする。 */
export function shouldFail(reports: SceneReport[]): boolean {
  return reports.some((r) => r.failed);
}

/** 人が読む 1 行にまとめる。 */
export function formatReport(r: SceneReport): string {
  const head = `${r.failed ? "FAIL" : "ok  "} ${r.scene}  ` +
               `検査${r.checked} エラー${r.errors} 注意${r.warnings}`;
  const body = r.issues
    .filter((i) => i.level === "error")
    .slice(0, 10)
    .map((i) => `       [${i.kind}] ${i.text}`);
  const reach = (r.reachability ?? [])
    .filter((x) => !x.pass)
    .map((x) => `       [UNREACHABLE] ${x.detail}`);
  return [head, ...body, ...reach].join("\n");
}

/**
 * 1 シーンを開いて検査する。
 * goals が渡されていれば、プレイヤーからそこまでの到達性も見る（ナビメッシュを焼いてから）。
 */
export async function validateScene(
  eng: EngineConn,
  scene: string,
  opts: { goals?: string[]; capability?: MovementCapability } = {},
): Promise<SceneReport> {
  await eng.call("stop", {});                       // 念のため Editor へ
  await eng.call("open_scene", { path: scene });

  const v = await eng.call("validate_layout", {});
  const report: SceneReport = {
    scene,
    errors: v.errors ?? 0,
    warnings: v.warnings ?? 0,
    checked: v.checked ?? 0,
    issues: (v.issues ?? []).map((i: any) => ({
      kind: i.kind, name: i.name, text: i.text, level: i.level,
    })),
    failed: (v.errors ?? 0) > 0,
  };

  if (opts.goals?.length) {
    const cap: MovementCapability = opts.capability ??
      { walkSpeed: 4, jumpHeight: 1.0, jumpDistance: 3.0, stepHeight: 0.3, maxSlopeDeg: 50 };
    report.reachability = [];
    try {
      await eng.call("navmesh_build", {});
      // ★このシーンに存在する目標だけを見る。タイトル画面やクリア画面には
      //   ゴールもプレイヤーも無いのが正しいので、無いことを不合格にしてはいけない
      //   （実際に title.json が「プレイヤーが居ない」で落ちた）。
      const all = await eng.call("list_entities", {});
      const present = new Set((all?.entities ?? []).map((e: any) => e.name));
      const applicable = opts.goals.filter((g) => present.has(g));
      if (applicable.length === 0) {
        report.reachability.push({ pass: true, detail: "このシーンに対象の目標が無いので到達性は見ない" });
        return report;
      }

      const cc = await eng.call("list_entities", { component_type: "characterController" });
      const playerName = cc?.entities?.[0]?.name;
      if (!playerName) {
        report.reachability.push({
          pass: false,
          detail: `目標(${applicable.join(", ")})はあるのにプレイヤー(characterController)が居ない`,
        });
        report.failed = true;
      } else {
        const from = (await eng.call("get_bounds", { name: playerName, includeChildren: true })).center;
        for (const g of applicable) {
          try {
            const to = (await eng.call("get_bounds", { name: g, includeChildren: true })).center;
            const pr = await eng.call("navmesh_path", { from, to });
            const pts = (pr.points ?? []).map((p: number[]) => [p[0], p[1], p[2]] as [number, number, number]);
            if (!pts.length || pr.reached === false) {
              report.reachability.push({ pass: false, detail: `${g} へ到達できない（経路が繋がっていない）` });
              report.failed = true;
              continue;
            }
            const gaps = analyzePath(pts, cap);
            if (gaps.length) {
              report.reachability.push({ pass: false, detail: `${g}: ${gaps[0].reason}` });
              report.failed = true;
            } else {
              report.reachability.push({ pass: true, detail: `${g} へ到達できる（${pr.length?.toFixed?.(1)}m）` });
            }
          } catch (e) {
            report.reachability.push({ pass: false, detail: `${g}: ${(e as Error).message}` });
            report.failed = true;
          }
        }
      }
    } catch (e) {
      report.reachability.push({ pass: false, detail: `ナビメッシュ: ${(e as Error).message}` });
      report.failed = true;
    }
  }
  return report;
}

// ─── 回帰テスト（.playtest の再生） ──────────────────────────────────────

export interface PlaytestResult {
  name: string;
  scene: string;
  pass: boolean;
  endDistance: number;
  maxDeviation: number;
  maxDeviationAt: number;
  reasons: string[];
}

/** アクティブなカメラの yaw（度）。向きを合わせる閉ループの入力。 */
async function cameraYaw(eng: EngineConn): Promise<number | null> {
  const cams = await eng.call("list_entities", { component_type: "camera" });
  for (const c of cams?.entities ?? []) {
    const e = await eng.call("get_entity", { name: c.name });
    if (e?.camera && e.camera.isActive === false) continue;
    if (Array.isArray(e?.transform?.rotation)) return e.transform.rotation[1];
  }
  return null;
}

/**
 * .playtest を 1 本再生する。
 * ★向きはマウス注入の閉ループで合わせる。記録にあるのは 10Hz の角度であって
 *   毎フレームのマウス移動量ではないし、感度もゲームごとに違う。
 */
export async function runPlaytest(
  eng: EngineConn, pt: PlaytestFile, dt = 1 / 60,
): Promise<PlaytestResult> {
  await eng.call("stop", {});
  await eng.call("open_scene", { path: pt.scene });
  await eng.call("play", {});
  await eng.call("step_frames", { frames: 30, deterministic: true, dt });

  const cc = await eng.call("list_entities", { component_type: "characterController" });
  const player = cc?.entities?.[0]?.name;
  if (!player)
    return { name: pt.name, scene: pt.scene, pass: false, endDistance: Infinity,
             maxDeviation: Infinity, maxDeviationAt: 0,
             reasons: ["プレイヤー(characterController)が居ない"] };

  // ★測るのは【カメラ位置】。基準（PlaySession の camPos）がカメラなので、
  //   プレイヤー本体を測ると目線オフセット（既定 0.6m）ぶん常にずれて、
  //   何も壊れていないのに毎回落ちる（実際に落ちた）。比べる量は揃えること。
  const camName = await (async () => {
    const cams = await eng.call("list_entities", { component_type: "camera" });
    for (const c of cams?.entities ?? []) {
      const e = await eng.call("get_entity", { name: c.name });
      if (e?.camera && e.camera.isActive === false) continue;
      return c.name as string;
    }
    return null;
  })();
  if (!camName)
    return { name: pt.name, scene: pt.scene, pass: false, endDistance: Infinity,
             maxDeviation: Infinity, maxDeviationAt: 0,
             reasons: ["アクティブなカメラが居ない（記録の基準がカメラ位置なので比べられない）"] };

  const sample = async (t: number): Promise<TraceSample> => {
    const e = await eng.call("get_entity", { name: camName });
    const p = e?.transform?.position ?? [0, 0, 0];
    const s: TraceSample = { t, pos: [p[0], p[1], p[2]] };
    try {
      const ph = await eng.call("get_physics_state", { name: player });
      if (typeof ph?.isGrounded === "boolean") s.grounded = ph.isGrounded;
    } catch { /* 位置だけで続ける */ }
    return s;
  };

  let degPerPixel: number | null = null;
  // ★向きを合わせるのに使ったフレーム数を返す。呼び出し側でこれも数えないと、
  //   マウスを振った回数ぶんだけシミュレーション時間が余計に進み、
  //   同じ入力なのに記録より遠くまで行ってしまう（記録との突き合わせが必ずずれる）。
  const faceYaw = async (target: number): Promise<number> => {
    let used = 0;
    for (let i = 0; i < 4; i++) {
      const cur = await cameraYaw(eng);
      if (cur == null) return used;
      if (Math.abs(wrapDeg(target - cur)) <= 3) return used;
      const dx = mouseDeltaForYaw(cur, target, degPerPixel);
      await eng.call("mouse_move", { dx, dy: 0 });
      await eng.call("step_frames", { frames: 1, deterministic: true, dt });
      used++;
      const nx = await cameraYaw(eng);
      if (nx != null && Math.abs(dx) > 1e-3) degPerPixel = wrapDeg(nx - cur) / dx;
    }
    return used;
  };

  const events = compileTimeline(pt.steps as ScriptStep[], dt);
  // ★記録した長さ「ちょうど」で止める。余韻を足すと、記録が空中で終わっている
  //   ジャンプが再生では着地してしまい、終点が必ずずれる（実際に 3m ずれた）。
  const totalFrames = Math.ceil(pt.durationSec / dt);
  const sampleFrames = Math.max(1, Math.round(0.1 / dt));
  const trace: TraceSample[] = [await sample(0)];
  let frame = 0, ei = 0, li = 0;

  while (frame < totalFrames) {
    const t = frame * dt;
    while (ei < events.length && events[ei].frame <= frame) {
      const ev = events[ei++];
      for (const k of ev.downs) await eng.call("key_down", { key: k });
      for (const k of ev.ups) await eng.call("key_up", { key: k });
      for (const k of ev.presses) await eng.call("key_press", { key: k });
    }
    while (li + 1 < pt.look.length && pt.look[li + 1].t <= t) li++;
    if (li < pt.look.length) frame += await faceYaw(pt.look[li].yaw);
    if (frame >= totalFrames) break;

    const nextEvent = ei < events.length ? events[ei].frame : totalFrames;
    const to = Math.min(nextEvent, frame + sampleFrames, totalFrames);
    const n = Math.max(1, to - frame);
    await eng.call("step_frames", { frames: n, deterministic: true, dt });
    frame += n;
    trace.push(await sample(frame * dt));
  }

  for (const k of danglingKeys(pt.steps as ScriptStep[])) {
    try { await eng.call("key_up", { key: k }); } catch { /* 無視 */ }
  }
  let scriptErrors = 0;
  try { scriptErrors = (await eng.call("get_script_errors", {}))?.count ?? 0; } catch { /* 無視 */ }
  await eng.call("stop", {});

  const v = compareReplay(pt, trace, scriptErrors);
  return {
    name: pt.name, scene: pt.scene, pass: v.pass,
    endDistance: v.endDistance, maxDeviation: v.maxDeviation,
    maxDeviationAt: v.maxDeviationAt, reasons: v.reasons,
  };
}

/** プロジェクトに保存されている .playtest を全部走らせる。 */
export async function runAllPlaytests(
  eng: EngineConn, baseDir: string,
): Promise<PlaytestResult[]> {
  const dir = playtestDir(baseDir);
  let files: string[];
  try { files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json")); }
  catch { return []; }

  const out: PlaytestResult[] = [];
  for (const f of files) {
    const raw = JSON.parse(await fs.promises.readFile(path.join(dir, f), "utf8"));
    const bad = validatePlaytest(raw);
    if (bad.length) {
      out.push({ name: f, scene: "?", pass: false, endDistance: 0, maxDeviation: 0,
                 maxDeviationAt: 0, reasons: bad });
      continue;
    }
    out.push(await runPlaytest(eng, raw as PlaytestFile));
  }
  return out;
}

export function formatPlaytest(r: PlaytestResult): string {
  const head = `${r.pass ? "ok  " : "FAIL"} playtest:${r.name}  (${r.scene})`;
  return [head, ...r.reasons.map((x) => `       ${x}`)].join("\n");
}

// ─── ヘッドレス起動 ──────────────────────────────────────────────────────

/** そのポートに誰か居るか。起動待ちに使う。 */
export function portOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (v: boolean) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => fin(true));
    sock.once("timeout", () => fin(false));
    sock.once("error", () => fin(false));
    sock.connect(port, "127.0.0.1");
  });
}

/** 使われていないポートを探す（複数の CI を同時に走らせても衝突しないように）。 */
export async function findFreePort(start = 8850, tries = 40): Promise<number> {
  for (let p = start; p < start + tries; p++) if (!(await portOpen(p, 200))) return p;
  throw new Error(`空きポートが ${start}..${start + tries} に無い`);
}

/**
 * ヘッドレスでエンジンを起動し、MCP ポートが開くまで待つ。
 * ★--mcp-port を明示するので %TEMP%/dx12_mcp.port は書き換わらない
 *   ＝人が開いているエディタの接続を奪わない（CI を回しながら作業できる）。
 */
export async function launchHeadless(opts: {
  projectDir: string; enginePath?: string; scene?: string; port?: number; timeoutMs?: number;
}): Promise<{ port: number; kill: () => void }> {
  const { spawn } = await import("node:child_process");
  const exe = opts.enginePath ??
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")),
                 "../../build/release/DX12Engine.exe");
  const port = opts.port ?? (await findFreePort());
  const args = ["--headless", "--project", opts.projectDir, "--mcp-port", String(port)];
  if (opts.scene) args.push("--scene", opts.scene);

  const child = spawn(exe, args, {
    cwd: path.dirname(exe),      // ★CWD がここでないとスクショが WIC で開けない（既知の罠）
    detached: false,
    stdio: "ignore",
  });
  // ★Windows の GUI プロセス（隠し窓でも GUI サブシステム）は SIGTERM で死なない。
  //   child.kill() だけだと CI が終わってもエンジンが残り続ける（実測で残った）。
  //   taskkill /T /F で子ごと確実に落とす。
  const kill = () => {
    if (child.exitCode != null) return;
    try {
      if (process.platform === "win32" && child.pid != null) {
        const { spawnSync } = createRequire(import.meta.url)("node:child_process");
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else child.kill("SIGKILL");
    } catch { /* もう死んでいる */ }
  };

  const limit = opts.timeoutMs ?? 90_000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    if (await portOpen(port)) return { port, kill };
    if (child.exitCode != null) throw new Error(`エンジンが起動直後に終了した（code=${child.exitCode}）`);
    await new Promise((r) => setTimeout(r, 500));
  }
  kill();
  throw new Error(`ヘッドレス起動が ${limit}ms でポート ${port} を開けなかった`);
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] == null
      ? "true" : argv[++i];
  }
  return out;
}

// import されたときは走らせない（テストから純関数だけ使えるように）
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const scenes = (args.scenes ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const goals = (args.goals ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  let port: number;
  let kill: (() => void) | null = null;
  if (args.launch && args.launch !== "true") {
    const started = await launchHeadless({
      projectDir: path.resolve(args.launch),
      enginePath: args.engine,
      scene: scenes[0],
    });
    port = started.port;
    kill = started.kill;
    console.log(`ヘッドレス起動: port ${port}`);
  } else {
    port = args.port ? Number(args.port) : defaultPort();
  }

  const reports: SceneReport[] = [];
  let playtestFailures = 0;
  try {
    const eng = await connect(port);
    const ping = await eng.call("ping", {});
    console.log(`接続: ${ping.currentScene}（${ping.entityCount} エンティティ / port ${port}）`);

    const targets = scenes.length ? scenes : [ping.currentScene];
    for (const s of targets) {
      const r = await validateScene(eng, s, { goals });
      reports.push(r);
      console.log(formatReport(r));
    }

    // 保存済みの回帰テスト（人が遊んだ記録）を再生する
    if (args.playtests === "true" || args.playtests) {
      const results = await runAllPlaytests(eng, ping.baseDir);
      if (results.length === 0) console.log("(.playtest はまだ 1 本も無い)");
      for (const r of results) {
        console.log(formatPlaytest(r));
        if (!r.pass) playtestFailures++;
      }
    }
    eng.close();
  } finally {
    if (kill) kill();
  }

  const failed = shouldFail(reports) || playtestFailures > 0;
  console.log(`\n${reports.length} シーン中 ${reports.filter((r) => r.failed).length} 件が不合格` +
              (playtestFailures ? ` / 回帰テスト ${playtestFailures} 件が不合格` : ""));
  process.exit(failed ? 1 : 0);
}
