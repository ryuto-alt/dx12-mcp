// フリート本体: 専用エンジンの起動・一覧・停止・attach・更新・監視・後始末。設計は docs/MCP_FLEET_DESIGN.md。
//
//   ・1 セッション(= 1 つの MCP サーバプロセス)が owner。エンジンは owner だけが操作する。
//   ・台数の上限・ポート割当・エントリ追加は 1 つのレジストリ・トランザクション(排他)の中で行う。
//   ・殺すのはレジストリに載っている pid だけ。イメージ名が記録と一致するのを確かめてから(名前で全部殺さない)。
//   ・エンジンは常に --background(既定)か --headless。visible は既定で拒否(環境変数 + confirm の両方が要る)。
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { ErrorBody, Fix } from "../errors.ts";
import { nearest } from "../errors.ts";
import { type FleetConfig } from "./config.ts";
import { Registry, sleepSync, FleetLockTimeout, type Entry, type EngineMode, type RegistryData } from "./registry.ts";
import { pidAlive, isProcessOf, killTree, killTreeSync, sleep } from "./proc.ts";
import { sampleResources, checkResources, type ResourceSnapshot } from "./resources.ts";
import {
  locateBuild, materializeBin, isStale, createDisposableProject, normalizeProjectDir, dirSizeBytes, rmRetry, BuildInProgress, ENGINE_EXE, type SourceBuild,
} from "./instance.ts";
import { EngineRouter, PASSIVE_METHODS } from "./router.ts";

/** ツールが構造化エラーとして返す失敗。 */
export class FleetFailure extends Error {
  readonly body: ErrorBody;
  constructor(body: ErrorBody) { super(body.message); this.name = "FleetFailure"; this.body = body; }
}

const fail = (body: ErrorBody): never => { throw new FleetFailure(body); };

export type LaunchInput = {
  name?: string;
  project?: string;
  mode?: EngineMode;
  scene?: string;
  dpiScale?: number;
  args?: string[];
  waitReadyMs?: number;
  confirm?: boolean;
  /** true=起動しても既定エンジンに束縛しない(ジョブ API が専用エンジンを一時的に使うとき。ツールの引数ではない)。 */
  noBind?: boolean;
};

/** args で渡してはいけない(フリートが管理する)起動引数。 */
const MANAGED_FLAGS = ["--mcp-port", "--owner-pid", "--idle-exit", "--instance-id", "--project", "--headless", "--background", "--virtual-input", "--net-client", "--build", "--allow-autosave-off"];

const VISIBLE_WARNING = "visible は実マウス・フォーカス・前面ウィンドウを奪い得る(人の PC 操作を妨げる)。必要な間だけにして、終わったらすぐ dx12_engine_stop する";

export type EngineView = {
  id: string; name: string; state: string; status: "ready" | "starting" | "orphan" | "dead";
  mode: EngineMode; port: number; pid: number;
  project: { dir: string; disposable: boolean };
  owner: { pid: number; alive: boolean; mine: boolean; heartbeatAgeSec: number };
  exe: { path: string; stale: boolean; copiedAt: number; sizeMB: number };
  startedAt: number; uptimeSec: number; idleSec: number; idleExitMin: number;
  bound: boolean; ownedByMe: boolean;
};

export type FleetDeps = {
  cfg: FleetConfig;
  router: EngineRouter;
  ownerPid?: number;
  now?: () => number;
};

function rand4(): string { return crypto.randomBytes(2).toString("hex"); }

/** 1 回だけ ping を撃つ(接続 → 1 行送る → 1 行受ける → 閉じる)。EngineClient を作らない軽い版(起動待ち用)。 */
export function rawPing(port: number, timeoutMs = 1500, host = "127.0.0.1"): Promise<any | null> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let buf = "";
    let done = false;
    const finish = (v: any | null) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    s.setEncoding("utf8");
    s.on("error", () => finish(null));
    s.on("connect", () => s.write(JSON.stringify({ id: 1, method: "ping", params: {} }) + "\n"));
    s.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { const m = JSON.parse(buf.slice(0, i)); finish(m?.ok === false ? null : (m?.result ?? null)); } catch { finish(null); }
    });
  });
}

/** OS がそのポートを空けているか(一瞬 listen して閉じる)。 */
export function portIsFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

export class Fleet {
  readonly cfg: FleetConfig;
  readonly router: EngineRouter;
  readonly registry: Registry;
  readonly owner: { pid: number; startMs: number };
  private now: () => number;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private lastSweepAt = 0;
  /** 監視タイマーが最後に動いた時刻。大きく空いた(PC のスリープ等)ら、全セッションの心拍が古くなるので一定時間は心拍で孤児判定しない。 */
  private lastTickAt = 0;
  private heartbeatGraceUntil = 0;
  /** テスト用の差し込み口(本番では空)。refresh の「殺した直後」に時間を空けて、競合の窓を広げる。 */
  readonly testHooks: { afterKill?: () => Promise<void> } = {};
  private children = new Map<string, ChildProcess>();
  private shuttingDown = false;
  /** 直近の出来事(doctor が読む)。 */
  readonly events: { at: number; kind: string; engine?: string; message: string }[] = [];

  constructor(deps: FleetDeps) {
    this.cfg = deps.cfg;
    this.router = deps.router;
    this.now = deps.now ?? Date.now;
    this.owner = { pid: deps.ownerPid ?? process.pid, startMs: this.now() - Math.round(process.uptime() * 1000) };
    this.registry = new Registry(this.cfg.dir);
    fs.mkdirSync(path.join(this.cfg.dir, "instances"), { recursive: true });
    fs.mkdirSync(path.join(this.cfg.dir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(this.cfg.dir, "launch"), { recursive: true });
  }

  private log(kind: string, message: string, engine?: string) {
    this.events.push({ at: this.now(), kind, message, ...(engine ? { engine } : {}) });
    if (this.events.length > 50) this.events.shift();
    process.stderr.write(`[dx12-fleet] ${kind}${engine ? " " + engine : ""}: ${message}\n`);
  }

  instanceDir(id: string) { return path.join(this.cfg.dir, "instances", id); }
  binDir(id: string) { return path.join(this.instanceDir(id), "bin"); }
  dataDir(id: string) { return path.join(this.instanceDir(id), "data"); }
  projectDir(id: string) { return path.join(this.cfg.dir, "projects", id); }
  launchLog(id: string) { return path.join(this.cfg.dir, "launch", `${id}.log`); }

  // ── 生死の分類・掃除 ─────────────────────────────────────────────────
  private ownerAlive(e: Entry): boolean {
    if (e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs) return true;   // 自分
    if (!pidAlive(e.owner.pid)) return false;
    // PC のスリープ明けなど、こちらの監視が長く止まっていた直後は、他のセッションも心拍を更新できていない。猶予の間は死んだとみなさない。
    if (this.now() < this.heartbeatGraceUntil) return true;
    // pid の使い回し・止まっているセッション: ハートビートが長く止まっていたら死んだとみなす
    return this.now() - e.owner.heartbeatAt < this.cfg.heartbeatStaleMs;
  }
  private engineAlive(e: Entry): boolean {
    if (e.state === "starting" && !e.pid) return this.now() - e.startedAt < 90_000;   // 予約だけ(起動前)。90 秒で期限切れ
    return pidAlive(e.pid);
  }

  /**
   * 孤児(owner が死んでいる)と死んだエンジン(プロセスが無い)を片付ける。
   * 生きている孤児のエンジンは kill する(イメージ名が記録と一致するときだけ)。
   */
  async sweep(): Promise<{ removed: { id: string; reason: string }[]; killed: number[] }> {
    this.lastSweepAt = this.now();
    const removed: { id: string; reason: string }[] = [];
    const victims: { id: string; pid: number; image: string }[] = [];
    this.registry.transaction((data) => {
      for (const e of Object.values(data.engines)) {
        const mine = e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs;
        if (!this.engineAlive(e)) {
          delete data.engines[e.id];
          removed.push({ id: e.id, reason: e.state === "starting" && !e.pid ? "expired-reservation" : "engine-dead" });
        } else if (!mine && !this.ownerAlive(e)) {
          if (e.pid) victims.push({ id: e.id, pid: e.pid, image: e.imageName });
          delete data.engines[e.id];
          removed.push({ id: e.id, reason: "orphan" });
        }
      }
    });
    const killed: number[] = [];
    for (const v of victims) {
      if (isProcessOf(v.pid, v.image)) { await killTree(v.pid); killed.push(v.pid); }
    }
    for (const r of removed) {
      this.router.removeSlot(r.id);
      this.removeInstanceDir(r.id);
      this.log("sweep", `${r.reason}`, r.id);
    }
    this.gcDirs();
    return { removed, killed };
  }

  /** インスタンスフォルダを消す(1 回だけ試す。残ったら gcDirs が後で消す)。 */
  private removeInstanceDir(id: string, blocking = false) {
    const d = this.instanceDir(id);
    if (!fs.existsSync(d)) return;
    if (blocking) rmRetry(d, 6);
    else { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 使用中。後で */ } }
  }

  /** レジストリに無いインスタンス(60 秒以上前)と、古い使い捨てプロジェクト(24 時間)を消す。 */
  private gcDirs() {
    const data = this.registry.read();
    const nowMs = this.now();
    const inst = path.join(this.cfg.dir, "instances");
    try {
      for (const name of fs.readdirSync(inst)) {
        if (data.engines[name]) continue;
        const d = path.join(inst, name);
        const st = fs.statSync(d);
        if (nowMs - st.mtimeMs > 60_000) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 使用中 */ } }
      }
      const proj = path.join(this.cfg.dir, "projects");
      for (const name of fs.readdirSync(proj)) {
        if (data.engines[name]) continue;
        const d = path.join(proj, name);
        const st = fs.statSync(d);
        if (nowMs - st.mtimeMs > 24 * 3600_000) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 使用中 */ } }
      }
      const logs = path.join(this.cfg.dir, "launch");
      for (const name of fs.readdirSync(logs)) {
        const id = name.replace(/\.log$/, "");
        if (data.engines[id]) continue;
        const f = path.join(logs, name);
        if (nowMs - fs.statSync(f).mtimeMs > 24 * 3600_000) { try { fs.rmSync(f, { force: true }); } catch { /* 無視 */ } }
      }
    } catch { /* GC の失敗は無視 */ }
  }

  // ── 一覧 ───────────────────────────────────────────────────────────
  private view(e: Entry): EngineView {
    const nowMs = this.now();
    const mine = e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs;
    const alive = this.engineAlive(e);
    const ownerAlive = this.ownerAlive(e);
    const slot = this.router.get(e.id);
    const lastActive = mine && slot ? slot.lastCallAt : e.lastActivityAt;
    const stale = isStale(e.exe);
    return {
      id: e.id, name: e.name, state: e.state,
      status: !alive ? "dead" : !ownerAlive ? "orphan" : e.state === "ready" ? "ready" : "starting",
      mode: e.mode, port: e.port, pid: e.pid,
      project: e.project,
      owner: { pid: e.owner.pid, alive: ownerAlive, mine, heartbeatAgeSec: Math.round((nowMs - e.owner.heartbeatAt) / 1000) },
      exe: { path: e.exe.path, stale: stale.stale, copiedAt: e.exe.copiedAt, sizeMB: Math.round(e.exe.sizeBytes / 1048576) },
      startedAt: e.startedAt, uptimeSec: Math.round((nowMs - e.startedAt) / 1000), idleSec: Math.max(0, Math.round((nowMs - lastActive) / 1000)),
      idleExitMin: e.idleExitMin,
      bound: this.router.boundId() === e.id, ownedByMe: mine,
    };
  }

  async list(opts: { discover?: boolean } = {}): Promise<Record<string, unknown>> {
    await this.sweep();
    const data = this.registry.read();
    const engines = Object.values(data.engines).map((e) => this.view(e)).sort((a, b) => a.startedAt - b.startedAt);
    const attached = this.router.list().filter((s) => s.kind === "attached").map((s) => ({ id: s.id, port: s.port, readOnly: s.readOnly, bound: this.router.boundId() === s.id }));
    const out: Record<string, unknown> = {
      fleet: { dir: this.cfg.dir, count: engines.length, max: this.cfg.max, mine: engines.filter((e) => e.ownedByMe).length, portRange: this.cfg.portRange, idleMin: this.cfg.idleMin },
      bound: this.router.boundId(),
      engines, attached,
    };
    if (opts.discover) out.external = await this.discoverExternal(data);
    return out;
  }

  /** 手動起動の候補ポート(8787・8850〜8859・ポートファイル)を connect だけで探す(ping は送らない = 単一クライアントの枠を奪わない)。 */
  async discoverExternal(data: RegistryData = this.registry.read()): Promise<{ port: number; connect: string; source: string }[]> {
    const managed = new Set(Object.values(data.engines).map((e) => e.port));
    const cands = new Map<number, string>();
    for (const p of this.cfg.discoverPorts) cands.set(p, p === 8787 ? "default" : p >= 8850 && p <= 8859 ? "manual-range" : "configured");
    try {
      const pf = process.env.DX12_MCP_PORT_FILE || path.join(os.tmpdir(), "dx12_mcp.port");
      const n = Number(fs.readFileSync(pf, "utf8").trim());
      if (Number.isFinite(n) && n > 0) cands.set(n, "port-file");
    } catch { /* 無し */ }
    if (process.env.DX12_MCP_PORT && Number(process.env.DX12_MCP_PORT) > 0) cands.set(Number(process.env.DX12_MCP_PORT), "env");
    const out: { port: number; connect: string; source: string }[] = [];
    await Promise.all([...cands].filter(([p]) => !managed.has(p)).map(async ([port, source]) => {
      const r = await new Promise<string>((resolve) => {
        const s = net.connect(port, "127.0.0.1");
        const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 300);
        s.once("connect", () => { clearTimeout(t); s.destroy(); resolve("open"); });
        s.once("error", () => { clearTimeout(t); resolve("closed"); });
      });
      if (r === "open") out.push({ port, connect: r, source });
    }));
    return out.sort((a, b) => a.port - b.port);
  }

  resources(): ResourceSnapshot { return sampleResources(this.cfg); }

  /** doctor / list が使うフリート状態。 */
  async status(): Promise<Record<string, unknown>> {
    const sw = await this.sweep().catch(() => ({ removed: [] as { id: string; reason: string }[], killed: [] as number[] }));
    const data = this.registry.read();
    const engines = Object.values(data.engines).map((e) => this.view(e));
    const res = this.resources();
    const violations = checkResources(res, this.cfg);
    const staleExe = engines.filter((e) => e.exe.stale).map((e) => e.id);
    return {
      enabled: !this.cfg.disabled, dir: this.cfg.dir, count: engines.length, max: this.cfg.max,
      limits: { max: this.cfg.max, idleMin: this.cfg.idleMin, minFreeVramMB: this.cfg.minFreeVramMB, minFreeRamMB: this.cfg.minFreeRamMB, portRange: this.cfg.portRange, allowVisible: this.cfg.allowVisible },
      resources: { ...res, violations: violations.map((v) => v.message) },
      engines, staleExe, orphans: engines.filter((e) => e.status === "orphan").map((e) => e.id),
      swept: sw.removed, killedPids: sw.killed,
      bound: this.router.boundId(), events: this.events.slice(-10),
    };
  }

  // ── launch ─────────────────────────────────────────────────────────
  private validateLaunch(input: LaunchInput): { mode: EngineMode; name: string | undefined; extra: string[]; warnings: string[] } {
    const warnings: string[] = [];
    const mode = (input.mode ?? "background") as EngineMode;
    if (!["background", "headless", "visible"].includes(mode)) {
      fail({ code: "E_BAD_ENUM", message: `dx12_engine_launch: mode '${String(input.mode)}' は使えない`, validValues: ["background", "headless", "visible"], didYouMean: nearest(String(input.mode), ["background", "headless", "visible"], 2, { liberal: true }), fix: [{ tool: "dx12_engine_launch", args: { mode: "background" }, why: "通常は background(窓は画面外・前面化しない)" }] });
    }
    if (mode === "visible") {
      if (!this.cfg.allowVisible || !input.confirm) {
        const fixes: Fix[] = [{ tool: "dx12_engine_launch", args: { ...input, mode: "background", confirm: undefined }, why: "通常は background で足りる(窓は画面外・前面化しない。スクショ・UI 操作は仮想入力で行える)" }];
        if (!this.cfg.allowVisible) fixes.push({ command: "$env:DX12_MCP_ALLOW_VISIBLE = '1'", why: "どうしても窓が要るなら、ユーザーが MCP サーバの環境にこの変数を設定して再起動する(AI は勝手に設定しない)" });
        else fixes.push({ tool: "dx12_engine_launch", args: { ...input, mode: "visible", confirm: true }, why: "ユーザーの承認を得たあとで confirm:true を付けて撃ち直す" });
        fail({
          code: "E_FLEET_VISIBLE_DENIED",
          message: "mode:'visible'(窓を画面に出す起動)は既定で拒否している",
          cause: `実マウス・フォーカス・前面ウィンドウを奪い得るため。許可には環境変数 DX12_MCP_ALLOW_VISIBLE=1(${this.cfg.allowVisible ? "設定済み" : "未設定"})と、呼び出しの confirm:true(${input.confirm ? "指定済み" : "未指定"})の両方が要る`,
          fix: fixes, retryable: false, details: { allowVisibleEnv: this.cfg.allowVisible, confirm: !!input.confirm },
        });
      }
      warnings.push(VISIBLE_WARNING);
    }
    let name = input.name;
    if (name !== undefined) {
      name = String(name).trim();
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) fail({ code: "E_INVALID_PARAM", message: `dx12_engine_launch: name '${name}' は英数字・_ . - の 40 字以内`, fix: [{ tool: "dx12_engine_launch", args: { ...input, name: "agent-1" }, why: "使える文字だけの名前にする" }] });
    }
    const extra = (input.args ?? []).map(String);
    for (const a of extra) {
      const key = a.split("=")[0];
      if (MANAGED_FLAGS.includes(key)) {
        fail({ code: "E_INVALID_PARAM", message: `dx12_engine_launch: args に '${a}' は渡せない(フリートが管理する起動引数)`, validValues: MANAGED_FLAGS, cause: "ポート・owner・idle・プロジェクト・背景モードはフリートが決める。窓を出す起動は mode:'visible'(既定で拒否)だけ", fix: [{ tool: "dx12_engine_launch", args: { ...input, args: extra.filter((x) => !MANAGED_FLAGS.includes(x.split("=")[0])) }, why: "管理される引数を外す" }] });
      }
    }
    if (input.dpiScale !== undefined && !(Number(input.dpiScale) >= 0.75 && Number(input.dpiScale) <= 3)) {
      fail({ code: "E_OUT_OF_RANGE", message: `dx12_engine_launch: dpiScale ${input.dpiScale} は 0.75〜3.0 の範囲外`, fix: [{ tool: "dx12_engine_launch", args: { ...input, dpiScale: 1 }, why: "範囲内にする" }] });
    }
    return { mode, name, extra, warnings };
  }

  /** 上限・資源の超過で断るときの構造化エラー。止める候補を fix に載せる。 */
  private limitError(data: RegistryData, kind: "limit" | "resource", detail: string, extraDetails: Record<string, unknown> = {}): never {
    const views = Object.values(data.engines).map((e) => this.view(e));
    const mineIdle = views.filter((v) => v.ownedByMe).sort((a, b) => b.idleSec - a.idleSec);
    const others = views.filter((v) => !v.ownedByMe);
    const fix: Fix[] = mineIdle.map((v) => ({ tool: "dx12_engine_stop", args: { engine: v.id }, why: `自分のエンジン ${v.id}(${v.name}、idle ${v.idleSec} 秒、プロジェクト ${path.basename(v.project.dir)})を止めて枠を空ける` }));
    if (!mineIdle.length) fix.push({ tool: "dx12_engine_list", args: {}, why: "他のセッションのエンジンで埋まっている。止められるのは持ち主だけ(idle 10 分で自動終了する)。ユーザーに確認して、待つか持ち主のセッションで止めてもらう" });
    if (mineIdle.length) fix.push({ tool: "dx12_engine_use", args: { engine: mineIdle[mineIdle.length - 1].id }, why: "新しく起動せず、既に持っているエンジンを使い回す" });
    fail({
      code: kind === "limit" ? "E_FLEET_LIMIT" : "E_FLEET_RESOURCE",
      message: kind === "limit" ? `専用エンジンは全体で最大 ${this.cfg.max} 台まで(いま ${views.length} 台が起動中)` : `起動を断った: ${detail}`,
      cause: kind === "limit"
        ? `全セッション合計の上限(DX12_FLEET_MAX=${this.cfg.max})に達している。他のエージェントのものも数える。10 分操作の無いエンジンは自動終了する`
        : `${detail}。ユーザーのビルド・ゲームを圧迫しないための下限(DX12_FLEET_MIN_FREE_VRAM_MB / DX12_FLEET_MIN_FREE_RAM_MB で変更可)`,
      didYouMean: mineIdle.map((v) => v.id),
      fix, retryable: true,
      details: {
        engines: views.map((v) => ({ id: v.id, name: v.name, mine: v.ownedByMe, ownerPid: v.owner.pid, project: v.project.dir, idleSec: v.idleSec, mode: v.mode, port: v.port })),
        others: others.map((v) => ({ id: v.id, ownerPid: v.owner.pid, project: v.project.dir, idleSec: v.idleSec })),
        note: others.length ? "他のセッションのエンジンは、持ち主に無断で止めない(ユーザーに確認する)" : undefined,
        ...extraDetails,
      },
    });
  }

  async launch(input: LaunchInput = {}): Promise<Record<string, unknown>> {
    if (this.cfg.disabled) fail({ code: "E_FLEET_DISABLED", message: "フリートは無効(DX12_FLEET_DISABLE=1)", fix: [{ command: "Remove-Item Env:DX12_FLEET_DISABLE", why: "MCP サーバの環境からこの変数を外して再起動する" }] });
    const t0 = this.now();
    const { mode, name, extra, warnings } = this.validateLaunch(input);
    await this.sweep();

    // 元の exe
    const { build, tried } = locateBuild(this.cfg);
    if (!build) {
      fail({ code: "E_FLEET_EXE_MISSING", message: `${ENGINE_EXE} が見つからない`, cause: "ビルド出力(build\\release)にも、インストール先にも無い", details: { tried },
        fix: [{ command: "pwsh -NoProfile -File tools\\build.ps1", why: "リポジトリでビルドする" }, { command: "$env:DX12_FLEET_BUILD_DIR = '<DX12Engine.exe のフォルダ>'", why: "別の場所の exe を使うなら、その場所を指定する" }] });
    }

    // プロジェクト
    let projectDir = input.project ? path.resolve(input.project) : undefined;
    if (projectDir) {
      let ok = false;
      try { ok = fs.statSync(projectDir).isDirectory(); } catch { ok = false; }
      if (!ok) fail({ code: "E_INVALID_PARAM", message: `dx12_engine_launch: project '${input.project}' はフォルダではない`, cause: "project にはプロジェクトのルートフォルダを渡す(.dx12proj ファイルではない)", fix: [{ tool: "dx12_engine_launch", args: { ...input, project: undefined }, why: "project を省略すると使い捨てプロジェクトを自動で作る" }] });
    }

    // 資源(台数の判定は下のトランザクション。ここでは事前に軽く確認して、ダメならすぐ断る)
    const pre = this.registry.read();
    const preLive = Object.values(pre.engines).filter((e) => this.engineAlive(e));
    if (preLive.length >= this.cfg.max) this.limitError(pre, "limit", "");
    const res = this.resources();
    const viol = checkResources(res, this.cfg);
    if (viol.length) this.limitError(pre, "resource", viol.map((v) => v.message).join("・"), { resources: res, thresholds: { minFreeVramMB: this.cfg.minFreeVramMB, minFreeRamMB: this.cfg.minFreeRamMB } });
    if (res.vramFreeMB == null) warnings.push("空き VRAM を観測できなかった(nvidia-smi も PowerShell のカウンタも使えない)。VRAM の判定は行っていない");

    // 予約: 上限・同一プロジェクト・ポート割当を 1 つのトランザクションで
    const id = await this.reserve({ name, projectDir, mode, build, extra, input });
    return this.startEngine(id, { mode, build, extra, input, warnings, resources: res, t0, isRefresh: false });
  }

  /**
   * 台数の再判定・同一プロジェクト検査・ポート割当・エントリ追加(state:"starting")を排他の中で行い、id を返す。
   * ポートは「レジストリに載っていない最小」を予約してから、ロックの外で OS が空けているか(bind できるか)を確かめる。
   * 使えなければ予約を捨てて次の候補へ(他のプロセスが使っているポートを飛ばす)。予約中の候補は他のセッションが選ばないので、
   * セッション同士の bind 試験がぶつかって「空きが無い」と誤判定することは無い。
   */
  private async reserve(o: { name?: string; projectDir?: string; mode: EngineMode; build: SourceBuild; extra: string[]; input: LaunchInput }): Promise<string> {
    const [lo, hi] = this.cfg.portRange;
    const normProject = o.projectDir ? normalizeProjectDir(o.projectDir) : null;
    const skip = new Set<number>();
    for (let attempt = 0; attempt <= hi - lo; attempt++) {
      let id = "";
      let port = 0;
      let limitData: RegistryData | null = null;
      let inUse: Entry | null = null;
      let noPort = false;
      this.registry.transaction((data) => {
        const live = Object.values(data.engines).filter((e) => this.engineAlive(e));
        if (live.length >= this.cfg.max) { limitData = JSON.parse(JSON.stringify(data)); return; }
        if (normProject) {
          const clash = live.find((e) => normalizeProjectDir(e.project.dir) === normProject);
          if (clash) { inUse = clash; return; }
        }
        const used = new Set(Object.values(data.engines).map((e) => e.port));
        let p = lo;
        while (p <= hi && (used.has(p) || skip.has(p))) p++;
        if (p > hi) { noPort = true; return; }
        port = p;
        do { id = `e-${rand4()}`; } while (data.engines[id]);
        const nowMs = this.now();
        data.engines[id] = {
          id, name: o.name ?? id, state: "starting",
          owner: { pid: this.owner.pid, startMs: this.owner.startMs, heartbeatAt: nowMs },
          pid: 0, imageName: "", port, mode: o.mode,
          project: { dir: o.projectDir ?? this.projectDir(id), disposable: !o.projectDir },
          exe: { path: "", sourcePath: o.build.exe, sourceMtimeMs: o.build.mtimeMs, sizeBytes: o.build.sizeBytes, copiedAt: 0 },
          startedAt: nowMs, lastActivityAt: nowMs, idleExitMin: 0, args: [],
        };
      });
      if (limitData) this.limitError(limitData, "limit", "");
      if (inUse) {
        const c = inUse as Entry;
        fail({
          code: "E_FLEET_PROJECT_IN_USE", message: `プロジェクト '${o.projectDir}' は別のエンジン ${c.id}(${c.owner.pid === this.owner.pid ? "自分" : "他のセッション"})が使用中`,
          cause: "同じプロジェクトを 2 台のエンジンが開くと、MCP の自動保存が互いのシーンを上書きする",
          fix: [
            ...(c.owner.pid === this.owner.pid ? [{ tool: "dx12_engine_use", args: { engine: c.id }, why: "自分のエンジンをそのまま使う" }] : []),
            { tool: "dx12_engine_launch", args: { ...o.input, project: undefined }, why: "project を省略して使い捨てプロジェクトで起動する" },
          ], retryable: false, details: { engine: c.id, ownerPid: c.owner.pid },
        });
      }
      if (noPort) {
        fail({ code: "E_FLEET_LIMIT", message: `ポート範囲 ${lo}〜${hi} に空きが無い`, cause: "範囲内の全ポートが予約済みか、他のプロセスが使っている", fix: [{ tool: "dx12_engine_list", args: {}, why: "使っているエンジンを確認する" }, { command: "$env:DX12_FLEET_PORT_RANGE = '8860-8899'", why: "範囲を広げるなら MCP サーバの環境に設定して再起動する" }], retryable: true });
      }
      if (await portIsFree(port)) return id;
      // 別のプロセス(フリート外)が使っているポート。予約を捨てて次の候補へ。
      skip.add(port);
      this.registry.transaction((d) => { delete d.engines[id]; });
    }
    fail({ code: "E_FLEET_LIMIT", message: `ポート範囲 ${lo}〜${hi} に空きが無い`, cause: "範囲内の全ポートが他のプロセスに使われている", retryable: true, fix: [{ tool: "dx12_engine_list", args: {}, why: "使っているエンジンを確認する" }] });
  }

  private buildEngineArgs(e: { mode: EngineMode; project: string; port: number; id: string }, o: { idleExitMin: number; scene?: string; dpiScale?: number; extra: string[] }): string[] {
    const args: string[] = [];
    if (e.mode === "background") args.push("--background");
    else if (e.mode === "headless") args.push("--headless", "--virtual-input");   // --virtual-input を併用すると起動時の自動更新チェックが走らない
    args.push("--project", e.project, "--mcp-port", String(e.port), "--owner-pid", String(this.owner.pid),
      "--idle-exit", String(o.idleExitMin), "--instance-id", e.id);
    if (o.dpiScale !== undefined) args.push("--dpi-scale", String(o.dpiScale));
    if (o.scene) args.push("--scene", o.scene);
    args.push(...o.extra);
    return args;
  }

  /** 予約済みの id のエンジンを実際に起動する(コピー → spawn → ping 待ち → 登録 → 束縛)。launch と refresh が使う。 */
  private async startEngine(id: string, o: {
    mode: EngineMode; build: SourceBuild; extra: string[]; input: LaunchInput; warnings: string[]; resources: ResourceSnapshot | null; t0: number; isRefresh: boolean;
  }): Promise<Record<string, unknown>> {
    const entry0 = this.registry.read().engines[id];
    if (!entry0) fail({ code: "E_FLEET_LAUNCH_FAILED", message: `予約 ${id} が消えていた(別のセッションの掃除に巻き込まれた)`, fix: [{ tool: "dx12_engine_launch", args: o.input as Record<string, unknown>, why: "撃ち直す" }] });
    const port = entry0.port;
    const bin = this.binDir(id);
    const cleanupOnFail = () => {
      this.registry.transaction((d) => { delete d.engines[id]; });
      this.router.removeSlot(id);
      this.removeInstanceDir(id);
    };
    try {
      // プロジェクト(使い捨てなら生成)
      // ★refresh では作り直さない(作り直すと、自動保存された作業内容を初期シーンで上書きしてしまう。実エンジンの検証で見つけた)。
      if (entry0.project.disposable && !(fs.existsSync(entry0.project.dir) && fs.readdirSync(entry0.project.dir).some((f) => f.endsWith(".dx12proj")))) {
        createDisposableProject(entry0.project.dir, "fleet_" + id.replace(/[^A-Za-z0-9]/g, ""));
      }
      fs.mkdirSync(this.dataDir(id), { recursive: true });
      // exe コピー
      const tCopy0 = this.now();
      const mat = materializeBin(o.build, bin);
      const copyMs = this.now() - tCopy0;

      const idleExitMin = this.cfg.idleMin > 0 ? +(this.cfg.idleMin + Math.max(0.25, this.cfg.idleMin * 0.1)).toFixed(3) : 0;   // 本線は MCP サーバ側の監視。エンジン側は少し長い保険
      const engArgs = this.buildEngineArgs({ mode: o.mode, project: entry0.project.dir, port, id }, { idleExitMin, scene: o.input.scene, dpiScale: o.input.dpiScale, extra: o.extra });
      const cmd = this.cfg.engineCmd ? [...this.cfg.engineCmd, ...engArgs] : [mat.exePath, ...engArgs];
      const imageName = path.basename(cmd[0]);
      let child!: ChildProcess;
      let exited: { code: number | null; signal: string | null } | null = null;
      let spawnError: Error | null = null;
      let pid = 0;
      // ★ビルド直後の新しいハッシュの exe は、Smart App Control(アプリケーション制御)の評価が終わるまで起動できないことがある
      //   (CreateProcess が EACCES / UNKNOWN で失敗する)。数十秒で通るので、少し待って数回だけ再試行する。
      for (let attempt = 0; attempt < 3; attempt++) {
        exited = null; spawnError = null;
        const logFd = fs.openSync(this.launchLog(id), "a");
        try {
          child = spawn(cmd[0], cmd.slice(1), {
            cwd: bin, windowsHide: true, stdio: ["ignore", logFd, logFd],
            env: { ...process.env, DX12E_DATA_DIR: this.dataDir(id), DX12E_NO_SPLASH: "1" },   // 起動画面を前面へ出さない
          });
        } finally { fs.closeSync(logFd); }
        child.on("exit", (code, signal) => { exited = { code, signal }; });
        child.on("error", (e) => { spawnError = e; });
        pid = child.pid ?? 0;
        if (pid) break;
        await sleep(200);   // 'error' は非同期に届く
        const ec = (spawnError as any)?.code;
        if (attempt < 2 && ["EACCES", "EPERM", "UNKNOWN", "EBUSY"].includes(ec)) {
          this.log("launch", `プロセスを起動できない(${ec})。アプリケーション制御の評価待ちかもしれないので 4 秒待って再試行する`, id);
          await sleep(4000);
          continue;
        }
        break;
      }
      child.unref();
      this.children.set(id, child);
      if (!pid) {
        fail({
          code: "E_FLEET_LAUNCH_FAILED", message: `エンジンのプロセスを起動できない: ${(spawnError as Error | null)?.message ?? "pid が得られない"}`,
          cause: "ビルド直後の exe は、Smart App Control やウイルス対策の評価が終わるまで起動できないことがある。30〜60 秒待って撃ち直すと通る",
          retryable: true, details: { cmd: cmd[0] }, fix: [{ tool: "dx12_engine_launch", args: o.input as Record<string, unknown>, why: "30〜60 秒待って撃ち直す" }, { tool: "dx12_doctor", args: {}, why: "環境を診断する" }],
        });
      }
      try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 優先度を下げられなくても起動は続ける */ }
      this.registry.transaction((d) => {
        const e = d.engines[id]; if (!e) return;
        e.pid = pid; e.imageName = imageName; e.args = engArgs; e.idleExitMin = idleExitMin;
        e.exe = { path: mat.exePath, sourcePath: o.build.exe, sourceMtimeMs: mat.sourceMtimeMs, sizeBytes: mat.sizeBytes, copiedAt: this.now() };
      });

      // ping 待ち
      const waitMs = o.input.waitReadyMs ?? 60_000;
      const tReady0 = this.now();
      let pong: any = null;
      while (this.now() - tReady0 < waitMs) {
        if (exited || spawnError) break;
        pong = await rawPing(port, 1200);
        if (pong) break;
        await sleep(150);
      }
      if (!pong) {
        const tail = readTail(this.launchLog(id), 30);
        const engLog = readTail(path.join(bin, "dx12_engine.log"), 20);
        await killTree(pid);
        const e2 = exited as { code: number | null; signal: string | null } | null;
        fail({
          code: "E_FLEET_LAUNCH_FAILED",
          message: e2 || spawnError ? `エンジンが起動直後に終了した(code=${e2?.code ?? "?"}${spawnError ? ", " + (spawnError as Error).message : ""})` : `エンジンが ${waitMs}ms 以内に ping に応答しなかった(port ${port})`,
          cause: e2 ? "起動引数・プロジェクト・GPU/ドライバの問題。details.logTail を読む" : "起動が遅い(初回のシェーダ/アセット読み込み)か、ポートの bind に失敗した可能性",
          fix: [{ tool: "dx12_engine_launch", args: { ...o.input, waitReadyMs: Math.max(waitMs * 2, 120_000) } as Record<string, unknown>, why: "待ち時間を延ばして撃ち直す(遅いだけの場合)" }, { tool: "dx12_doctor", args: {}, why: "環境を診断する" }],
          retryable: true, details: { port, pid, exited: e2, logTail: tail, engineLogTail: engLog, cwd: bin },
        });
      }
      const readyMs = this.now() - o.t0;
      this.registry.transaction((d) => { const e = d.engines[id]; if (e) { e.state = "ready"; e.lastActivityAt = this.now(); } });

      // 束縛
      const cur = this.registry.read().engines[id];
      const slot = this.router.get(id) ?? this.router.addManaged(id, cur?.name ?? id, port);
      slot.lastCallAt = this.now();
      if (!o.input.noBind) this.router.setBound(id);
      this.startMonitor();
      this.log(o.isRefresh ? "refresh" : "launch", `port ${port} pid ${pid} mode ${o.mode}`, id);
      const entry = this.registry.read().engines[id]!;
      const view = this.view(entry);
      return {
        engineId: id, name: entry.name, port, pid, mode: o.mode, bound: !o.input.noBind,
        dir: { instance: this.instanceDir(id), bin, data: this.dataDir(id), project: entry.project.dir, log: path.join(bin, "dx12_engine.log"), launchLog: this.launchLog(id) },
        project: { dir: entry.project.dir, disposable: entry.project.disposable, note: entry.project.disposable ? "使い捨てプロジェクト。エンジン停止後も 24 時間は残る" : "指定されたプロジェクト。MCP 接続中は 2 秒アイドルで自動保存され、実ファイルに書き込まれる" },
        exe: { path: entry.exe.path, sourcePath: entry.exe.sourcePath, sizeMB: +(entry.exe.sizeBytes / 1048576).toFixed(1), stale: view.exe.stale, linked: mat.linked, copiedMB: +(mat.copiedBytes / 1048576).toFixed(1), copyMs },
        timing: { totalMs: this.now() - o.t0, readyMs, copyMs },
        idle: { idleMin: this.cfg.idleMin, engineIdleExitMin: idleExitMin, note: `${this.cfg.idleMin} 分、(ping 以外の)呼び出しが無いと自動終了する` },
        ping: pickPing(pong),
        ...(o.warnings.length ? { warnings: o.warnings } : {}),
        resources: o.resources ?? undefined,
        next: [
          { tool: "dx12_doctor", why: "接続と版を確認する" },
          { tool: "dx12_list_entities", why: "シーンの中身を見る(このエンジンに束縛済み。以後のツール呼び出しは全てここへ向かう)" },
          { tool: "dx12_engine_stop", why: "終わったら止める(閉じ忘れても 10 分で自動終了する)" },
        ],
      };
    } catch (e: any) {
      if (e instanceof FleetFailure) { cleanupOnFailSafe(cleanupOnFail); throw e; }
      cleanupOnFailSafe(cleanupOnFail);
      if (e instanceof BuildInProgress) {
        fail({ code: "E_FLEET_BUILD_IN_PROGRESS", message: `exe をコピーできない: ${e.message}`, cause: "ビルドが DX12Engine.exe を書き込んでいる最中。ビルドが終わればコピーできる(コピー済みのエンジンはビルドの影響を受けない)", fix: [{ tool: "dx12_engine_launch", args: o.input as Record<string, unknown>, why: "ビルドの完了を待って撃ち直す(数十秒)" }], retryable: true });
      }
      if (e instanceof FleetLockTimeout) fail({ code: "E_INTERNAL", message: e.message, details: { holder: e.holder }, retryable: true, fix: [{ tool: "dx12_engine_list", args: {}, why: "もう一度撃つ" }] });
      fail({ code: "E_FLEET_LAUNCH_FAILED", message: `起動の準備に失敗した: ${e?.message ?? e}`, retryable: true, fix: [{ tool: "dx12_doctor", args: {}, why: "環境を診断する" }] });
    }
  }

  // ── ref の解決 ─────────────────────────────────────────────────────
  private resolveRef(ref: unknown, data: RegistryData): Entry | null {
    const r = String(ref ?? "").trim();
    if (!r) return null;
    const all = Object.values(data.engines);
    const byId = data.engines[r]; if (byId) return byId;
    const mineFirst = [...all].sort((a, b) => Number(b.owner.pid === this.owner.pid) - Number(a.owner.pid === this.owner.pid));
    const byName = mineFirst.find((e) => e.name === r); if (byName) return byName;
    const m = /^(?:port:)?(\d{2,5})$/.exec(r);
    if (m) return all.find((e) => e.port === Number(m[1])) ?? null;
    return null;
  }

  private notFound(ref: unknown, data: RegistryData, tool: string): never {
    const all = Object.values(data.engines);
    const names = all.flatMap((e) => [e.id, e.name, String(e.port)]);
    const dym = nearest(String(ref ?? ""), [...new Set(names)], 3, { liberal: true });
    fail({
      code: "E_FLEET_NOT_FOUND", message: `エンジン '${String(ref)}' はフリートに無い`, didYouMean: dym,
      validValues: all.map((e) => e.id),
      fix: [...(dym[0] ? [{ tool, args: { engine: dym[0] }, why: `最も近い '${dym[0]}' で撃ち直す` }] : []), { tool: "dx12_engine_list", args: {}, why: "起動中のエンジンを確認する" }],
    });
  }

  // ── stop ───────────────────────────────────────────────────────────
  async stop(input: { engine?: string; all?: boolean; force?: boolean; confirm?: boolean } = {}, reason: "requested" | "idle" = "requested"): Promise<Record<string, unknown>> {
    await this.sweep();
    const data = this.registry.read();
    const mine = Object.values(data.engines).filter((e) => e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs);
    let targets: Entry[] = [];
    if (input.all) targets = mine;
    else if (input.engine !== undefined && input.engine !== null && String(input.engine) !== "") {
      const ref = String(input.engine);
      const e = this.resolveRef(ref, data);
      if (!e) {
        // 読み取り専用の attach(x-<port>)を外すだけの場合
        const slot = this.router.find(ref);
        if (slot && slot.kind === "attached") { this.router.removeSlot(slot.id); return { stopped: [], detached: [slot.id], note: "attach を外した(相手のエンジンは止めていない)", bound: this.router.boundId() }; }
        this.notFound(ref, data, "dx12_engine_stop");
      }
      const isMine = e!.owner.pid === this.owner.pid && e!.owner.startMs === this.owner.startMs;
      if (!isMine && this.ownerAlive(e!) && !(input.force && input.confirm)) {
        fail({
          code: "E_FLEET_NOT_OWNER", message: `エンジン ${e!.id} は他のセッション(owner pid ${e!.owner.pid})のもの。止められない`,
          cause: "他のエージェントが使っているエンジンを止めると、その作業が途切れる。持ち主が居なくなれば(または 10 分放置で)自動で回収される",
          fix: [{ tool: "dx12_engine_list", args: {}, why: "自分のエンジンを確認する" }, { tool: "dx12_engine_stop", args: { engine: e!.id, force: true, confirm: true }, why: "本当に止めるなら、ユーザーの承認を得たあとで force と confirm を付ける(最後の手段)" }],
          retryable: false, details: { engine: e!.id, ownerPid: e!.owner.pid, project: e!.project.dir },
        });
      }
      targets = [e!];
    } else {
      // engine も all も無い: 自分のエンジンが 1 台だけならそれ。複数あるときはどれか分からないので断る(束縛中のものを黙って止めない)。
      if (mine.length === 1) targets = mine;
      else if (mine.length === 0) return { stopped: [], note: "自分のエンジンは起動していない" };
      else fail({ code: "E_MISSING_PARAM", message: "dx12_engine_stop: どのエンジンを止めるか分からない(自分のエンジンが複数ある)", validValues: mine.map((m) => m.id), fix: mine.map((m) => ({ tool: "dx12_engine_stop", args: { engine: m.id }, why: `${m.id}(${m.name})を止める` })).concat([{ tool: "dx12_engine_stop", args: { all: true } as any, why: "自分のエンジンを全部止める" }]) });
    }
    const stopped: Record<string, unknown>[] = [];
    for (const e of targets) stopped.push(await this.stopEntry(e, reason));
    return { stopped, remaining: Object.keys(this.registry.read().engines).length, bound: this.router.boundId() };
  }

  private async stopEntry(e: Entry, reason: string): Promise<Record<string, unknown>> {
    const t0 = this.now();
    let killed = false;
    if (e.pid && pidAlive(e.pid)) {
      if (isProcessOf(e.pid, e.imageName || ENGINE_EXE)) killed = await killTree(e.pid);
      else killed = true;   // pid が別のプロセスに使い回されている。殺さない(既に終了済みとして扱う)
    } else killed = true;
    this.registry.transaction((d) => { delete d.engines[e.id]; });
    this.router.removeSlot(e.id);
    this.children.delete(e.id);
    this.removeInstanceDir(e.id, true);
    this.log("stop", `${reason} pid ${e.pid}`, e.id);
    return { engineId: e.id, name: e.name, pid: e.pid, port: e.port, reason, killed, tookMs: this.now() - t0, project: e.project.disposable ? { dir: e.project.dir, retained: true, note: "使い捨てプロジェクトは 24 時間残る" } : { dir: e.project.dir } };
  }

  // ── refresh ────────────────────────────────────────────────────────
  async refresh(input: { engine?: string; waitReadyMs?: number } = {}): Promise<Record<string, unknown>> {
    const t0 = this.now();
    await this.sweep();
    const data = this.registry.read();
    let e: Entry | null = null;
    if (input.engine) { e = this.resolveRef(input.engine, data); if (!e) this.notFound(input.engine, data, "dx12_engine_refresh"); }
    else {
      const b = this.router.boundId();
      e = b ? data.engines[b] ?? null : null;
      if (!e) {
        const mineAll = Object.values(data.engines).filter((x) => x.owner.pid === this.owner.pid && x.owner.startMs === this.owner.startMs);
        if (mineAll.length === 1) e = mineAll[0];
        else fail({ code: "E_MISSING_PARAM", message: "dx12_engine_refresh: 更新するエンジンが決まらない", validValues: mineAll.map((m) => m.id), fix: mineAll.map((m) => ({ tool: "dx12_engine_refresh", args: { engine: m.id }, why: `${m.id} を更新する` })) });
      }
    }
    const entry = e!;
    if (!(entry.owner.pid === this.owner.pid && entry.owner.startMs === this.owner.startMs)) {
      fail({ code: "E_FLEET_NOT_OWNER", message: `エンジン ${entry.id} は他のセッションのもの。更新できない`, fix: [{ tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動する" }], retryable: false });
    }
    const { build, tried } = locateBuild(this.cfg);
    if (!build) fail({ code: "E_FLEET_EXE_MISSING", message: `${ENGINE_EXE} が見つからない`, details: { tried }, fix: [{ command: "pwsh -NoProfile -File tools\\build.ps1", why: "ビルドする" }] });
    const before = isStale(entry.exe);
    // 元の exe がビルド中でないかを先に確かめる(止めてから失敗すると、動いていたエンジンを失う)
    const st1 = fs.statSync(build!.exe); sleepSync(300); const st2 = fs.statSync(build!.exe);
    if (st1.size !== st2.size || st1.mtimeMs !== st2.mtimeMs) fail({ code: "E_FLEET_BUILD_IN_PROGRESS", message: "元の exe がいま書き換えられている(ビルド中)", fix: [{ tool: "dx12_engine_refresh", args: { engine: entry.id }, why: "ビルドが終わってから撃ち直す(いまのエンジンは動いたまま)" }], retryable: true });
    // 止める → 同じ id・ポート・プロジェクトで起動し直す。
    // ★先にエントリを「起動中の予約(state:"starting"・pid:0)」へ切り替えてから殺す。順序が逆だと、殺してから書き換えるまでの間に
    //   監視(自分の 5 秒タイマーや他のセッションの孤児スイープ)が「エンジンが死んでいる」と判断してエントリとインスタンスを消してしまう
    //   (実エンジンの検証で踏んだ)。予約の間は engineAlive() が 90 秒生きているとみなす。
    const oldPid = entry.pid;
    this.registry.transaction((d) => { const x = d.engines[entry.id]; if (x) { x.state = "starting"; x.pid = 0; x.startedAt = this.now(); } });
    if (oldPid && pidAlive(oldPid) && isProcessOf(oldPid, entry.imageName || ENGINE_EXE)) await killTree(oldPid);
    await this.testHooks.afterKill?.();
    for (let i = 0; i < 30 && !(await portIsFree(entry.port)); i++) await sleep(100);
    this.router.get(entry.id)?.client.close();
    const argsExtra = entryExtraArgs(entry);
    const out = await this.startEngine(entry.id, {
      mode: entry.mode, build: build!, extra: argsExtra.extra, input: { scene: argsExtra.scene, dpiScale: argsExtra.dpiScale, waitReadyMs: input.waitReadyMs }, warnings: [], resources: null, t0, isRefresh: true,
    });
    return { ...out, refreshed: true, previous: { pid: entry.pid, wasStale: before.stale }, note: "エンジンを再起動した。シーンは(MCP 接続中の自動保存で)ディスクにあるものが開き直される。entityId は全て失効している" };
  }

  // ── attach / use ────────────────────────────────────────────────────
  async attach(input: { port?: number; engine?: string; readOnly?: boolean; confirm?: boolean } = {}): Promise<Record<string, unknown>> {
    const readOnly = input.readOnly !== false;
    if (!readOnly && !input.confirm) {
      fail({ code: "E_GUARDED", message: "dx12_engine_attach: 書き込み権つき(readOnly:false)の attach にはユーザーの承認(confirm:true)が要る", cause: "人が手で起動したエンジンや他のエージェントのエンジンを書き換えると、その作業を壊す。自分専用のエンジンを起動する方が安全", fix: [{ tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動する(推奨)" }, { tool: "dx12_engine_attach", args: { ...input, readOnly: false, confirm: true }, why: "承認を得たあとで confirm:true を付けて撃ち直す" }] });
    }
    const data = this.registry.read();
    let port = input.port;
    if (input.engine !== undefined) {
      const own = this.router.find(input.engine);
      if (own && own.kind === "managed") return this.use({ engine: own.id });
      const e = this.resolveRef(input.engine, data);
      if (!e) this.notFound(input.engine, data, "dx12_engine_attach");
      port = e!.port;
    }
    if (!port || !Number.isInteger(port) || port < 1024 || port > 65535) {
      fail({ code: "E_MISSING_PARAM", message: "dx12_engine_attach: port(1024〜65535)か engine を指定する", fix: [{ tool: "dx12_engine_list", args: { discover: true }, why: "見つかるエンジンとポートを確認する" }] });
    }
    const p = port as number;
    const ownManaged = this.router.list().find((s) => s.kind === "managed" && s.port === p);
    if (ownManaged) return this.use({ engine: ownManaged.id });
    const id = `x-${p}`;
    this.router.removeSlot(id);
    const slot = this.router.addAttached(id, p, readOnly);
    let pong: any;
    try {
      pong = await slot.client.call("ping", {}, { timeout: 2500, retry: false });
    } catch (e: any) {
      slot.client.close();
      this.router.removeSlot(id);
      const refused = e?.errName === "E_ENGINE_UNREACHABLE";
      fail(refused
        ? { code: "E_ENGINE_UNREACHABLE", message: `ポート ${p} に繋がらない(エンジンが居ない)`, fix: [{ tool: "dx12_engine_list", args: { discover: true }, why: "エンジンが待ち受けているポートを探す" }, { tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動する" }], retryable: true }
        : { code: "E_ENGINE_BUSY", message: `ポート ${p} は開いているが ping に応答が無い`, cause: "エンジンの接続枠は 1 つだけで、いまは持ち主(他のエージェントの MCP サーバや人が使っているスクリプト)が保持している。読み取り専用の attach でも、応答を得るには枠を一瞬借りる必要がある", fix: [{ why: "持ち主が接続を閉じるまで待つ。書き込みや撮影が要るなら dx12_engine_launch で自分専用のエンジンを起動する" }, { tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動する(推奨)" }], retryable: true, details: { port: p } });
    }
    // 読み取り許可の method をマニフェストから取る(取れなければ名前の前置で判定)
    if (readOnly) {
      try {
        const raw = await slot.client.call("describe_mcp_manifest", {}, { timeout: 6000, retry: false });
        const names = new Set<string>(["ping"]);
        for (const m of raw?.methods ?? []) if (m?.effect === "read" && typeof m.name === "string") names.add(m.name);
        if (names.size > 1) slot.readMethods = names;
      } catch { /* 前置判定のまま */ }
    }
    this.router.setBound(id);
    const reg = this.resolveRef(String(p), this.registry.read());
    return {
      engineId: id, port: p, bound: true, readOnly,
      ping: pickPing(pong),
      ...(reg ? { fleetEngine: { id: reg.id, ownerPid: reg.owner.pid, project: reg.project.dir } } : {}),
      notes: [
        readOnly ? "読み取り専用: effect:\"read\" の method だけ送れる(書き込み・撮影・Play は E_FLEET_READONLY)" : "書き込み権つきで繋いだ(承認済み)。持ち主の作業と衝突しないよう注意する",
        "接続は最後の応答から 1.5 秒で自動的に閉じる(持ち主が繋ぎ直せるよう枠を空ける)",
      ],
      next: readOnly ? [{ tool: "dx12_list_entities", why: "中身を見る" }, { tool: "dx12_engine_launch", why: "操作が要るなら自分専用のエンジンを起動する" }] : [],
    };
  }

  use(input: { engine?: string }): Record<string, unknown> {
    const ref = String(input.engine ?? "").trim();
    if (!ref) fail({ code: "E_MISSING_PARAM", message: "dx12_engine_use: engine が空", validValues: this.router.list().map((s) => s.id), fix: [{ tool: "dx12_engine_list", args: {}, why: "選べるエンジンを確認する" }] });
    if (ref === "none" || ref === "legacy") {
      this.router.setBound(null);
      return { bound: null, note: "束縛を外した。以後は従来の探索(DX12_MCP_PORT → ポートファイル → 8787)に戻る" };
    }
    const slot = this.router.find(ref);
    if (!slot) {
      const data = this.registry.read();
      const e = this.resolveRef(ref, data);
      if (e) fail({ code: "E_FLEET_NOT_OWNER", message: `エンジン ${e.id} は他のセッションのもの。use では束縛できない`, fix: [{ tool: "dx12_engine_attach", args: { engine: e.id }, why: "読み取り専用で見る" }, { tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動する" }], retryable: false });
      const ids = this.router.list().map((s) => s.id);
      const cands = [...new Set(this.router.list().flatMap((s) => [s.id, s.name]))];
      fail({ code: "E_FLEET_NOT_FOUND", message: `束縛できるエンジン '${ref}' が無い`, validValues: ids, didYouMean: nearest(ref, cands, 3, { liberal: true }), fix: [{ tool: "dx12_engine_list", args: {}, why: "選べるエンジンを確認する" }] });
    }
    this.router.setBound(slot!.id);
    return { bound: slot!.id, port: slot!.port, kind: slot!.kind, readOnly: slot!.readOnly, name: slot!.name };
  }

  // ── 監視・ハートビート・終了処理 ─────────────────────────────────────────
  startMonitor() {
    if (this.monitorTimer || this.cfg.disabled) return;
    this.monitorTimer = setInterval(() => { void this.tick().catch((e) => process.stderr.write(`[dx12-fleet] monitor: ${e?.message ?? e}\n`)); }, this.cfg.monitorMs);
    this.monitorTimer.unref?.();
  }

  stopMonitor() { if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; } }

  /** 5 秒ごと: 自分のエンジンの生死・アイドル・ハートビート・孤児スイープ。 */
  async tick(): Promise<void> {
    if (this.shuttingDown) return;
    const nowMs = this.now();
    const gap = this.lastTickAt ? nowMs - this.lastTickAt : 0;
    this.lastTickAt = nowMs;
    if (gap > Math.max(30_000, this.cfg.monitorMs * 6)) {
      // 監視が長く止まっていた(スリープ明け等)。すぐ心拍を打ち、60 秒は心拍の古さで孤児と判定しない。
      this.heartbeatGraceUntil = nowMs + 60_000;
      this.lastHeartbeatAt = 0;
      this.log("resume", `監視が ${Math.round(gap / 1000)} 秒止まっていた(スリープ明けなど)。心拍を打ち直し、60 秒は孤児判定を控える`);
    }
    const data = this.registry.read();
    const mine = Object.values(data.engines).filter((e) => e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs);
    // アイドル: 自分のエンジンに idleMin 分、(ping 以外の)呼び出しが無い
    if (this.cfg.idleMin > 0) {
      for (const e of mine) {
        if (e.state !== "ready") continue;
        const slot = this.router.get(e.id);
        const last = slot ? slot.lastCallAt : e.lastActivityAt;
        if (nowMs - last > this.cfg.idleMin * 60_000) {
          this.log("idle", `${Math.round((nowMs - last) / 1000)} 秒操作が無いので止める`, e.id);
          await this.stopEntry(e, "idle");
        }
      }
    }
    // ハートビート + アクティビティの記録(変化があるときと 30 秒ごと)
    if (nowMs - this.lastHeartbeatAt >= this.cfg.heartbeatMs) {
      this.lastHeartbeatAt = nowMs;
      this.registry.transaction((d) => {
        for (const e of Object.values(d.engines)) {
          if (e.owner.pid !== this.owner.pid || e.owner.startMs !== this.owner.startMs) continue;
          e.owner.heartbeatAt = nowMs;
          const slot = this.router.get(e.id);
          if (slot) e.lastActivityAt = slot.lastCallAt;
        }
      });
    }
    // 孤児スイープ(自分のエンジンが死んでいたらここで片付く)
    if (nowMs - this.lastSweepAt >= Math.max(this.cfg.monitorMs, 10_000)) await this.sweep();
    else {
      const dead = mine.filter((e) => e.state === "ready" && !pidAlive(e.pid));
      if (dead.length) await this.sweep();
    }
  }

  /** 終了時: 自分が owner のエンジンを全部止めて、エントリとインスタンスを消す(同期。exit ハンドラからも呼べる)。 */
  shutdownSync(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopMonitor();
    let mine: Entry[] = [];
    try {
      mine = Object.values(this.registry.read().engines).filter((e) => e.owner.pid === this.owner.pid && e.owner.startMs === this.owner.startMs);
    } catch { /* 読めなくても子プロセスは止める */ }
    const ids = new Set(mine.map((e) => e.id));
    // 自分が起動した子は、レジストリが読めなくても止める
    for (const [id, c] of this.children) if (c.pid && !ids.has(id) && pidAlive(c.pid)) { killTreeSync(c.pid); }
    for (const e of mine) {
      if (e.pid && pidAlive(e.pid) && isProcessOf(e.pid, e.imageName || ENGINE_EXE)) killTreeSync(e.pid);
    }
    try {
      this.registry.transaction((d) => { for (const e of mine) delete d.engines[e.id]; });
    } catch { /* 次回の孤児スイープが片付ける */ }
    // 殺した直後のプロセスは cwd(bin)のハンドルをまだ持っていることがある。短く再試行する(残っても gc が後で消す)。
    for (const e of mine) { try { rmRetry(this.instanceDir(e.id), 5); } catch { /* 使用中。gc が後で消す */ } }
  }

  /** 診断用: このセッションが持つエンジンの実サイズ(ディスク)。 */
  diskUsageMB(id: string): number { return +(dirSizeBytes(this.instanceDir(id)) / 1048576).toFixed(1); }
}

// ── 小道具 ───────────────────────────────────────────────────────────
function cleanupOnFailSafe(fn: () => void) { try { fn(); } catch { /* 掃除の失敗で元のエラーを隠さない */ } }

export function readTail(file: string, lines: number): string[] {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const size = Math.min(st.size, 32 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

/** ping の結果から、起動結果に載せる要点だけを取り出す。 */
export function pickPing(p: any): Record<string, unknown> {
  if (!p || typeof p !== "object") return {};
  const keys = ["mode", "currentScene", "baseDir", "background", "virtualInput", "dpiScale", "engineVersion", "manifestHash", "pid", "instanceId", "uptimeSec", "idleSec", "idleExitMin", "ownerPid", "vramUsedMB", "vramBudgetMB", "cwd"];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/** エントリの起動引数から、フリートが管理しない追加引数(--dpi-scale / --scene / 利用者の args)を取り戻す(refresh 用)。 */
function entryExtraArgs(e: Entry): { extra: string[]; scene?: string; dpiScale?: number } {
  const managedWithValue = new Set(["--project", "--mcp-port", "--owner-pid", "--idle-exit", "--instance-id"]);
  const managedBare = new Set(["--background", "--headless", "--virtual-input"]);
  const extra: string[] = [];
  let scene: string | undefined, dpiScale: number | undefined;
  const a = e.args;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (managedWithValue.has(x)) { i++; continue; }
    if (managedBare.has(x)) continue;
    if (x === "--scene" && i + 1 < a.length) { scene = a[++i]; continue; }
    if (x === "--dpi-scale" && i + 1 < a.length) { dpiScale = Number(a[++i]); continue; }
    extra.push(x);
  }
  return { extra, scene, dpiScale };
}

export { PASSIVE_METHODS };
