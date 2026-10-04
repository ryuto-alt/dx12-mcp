// inproc 型のジョブ種別: bench / playtest / screenshot_batch。MCP サーバ内でエンジンを呼ぶ(エンジンの接続は単一クライアントなので、別プロセスにはできない)。
// キャンセルは AbortSignal + エンジン側の cancel(benchmark / step_frames の残りを切り詰める。無いエンジンでは無視して待つ)。
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildContactSheet } from "../../contactSheet.ts";
import { playtestDir } from "../../playtestStore.ts";
import { jobFail, type InprocCtx, type InprocOutcome, type KindDef } from "../manager.ts";
import type { KindEnv } from "../env.ts";
import { runSceneSpec, SpecCache } from "../../sceneSpec/index.ts";
import { LOOK_IDS } from "../../lookDev.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^A-Za-z0-9_\-.]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "x";
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

class Aborted extends Error { constructor() { super("aborted"); this.name = "Aborted"; } }

/** promise を待つ。signal が abort されたら onAbort(エンジンへの cancel など)を呼んで、promise の決着を(上限つきで)待ってから Aborted を投げる。 */
async function raceAbort<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => Promise<void>, settleMs = 8000): Promise<T> {
  if (signal.aborted) { await onAbort().catch(() => {}); throw new Aborted(); }
  let abortHandler: (() => void) | null = null;
  const aborted = new Promise<never>((_, rej) => { abortHandler = () => rej(new Aborted()); signal.addEventListener("abort", abortHandler, { once: true }); });
  try { return await Promise.race([p, aborted]); }
  catch (e) {
    if (e instanceof Aborted) { await onAbort().catch(() => {}); await Promise.race([p.catch(() => {}), sleep(settleMs)]); }
    throw e;
  } finally { if (abortHandler) signal.removeEventListener("abort", abortHandler); }
}

// ── bench ───────────────────────────────────────────────────────────────────
export function benchKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "bench", executor: "inproc",
    describe: "エンジンの benchmark を runs 回繰り返し、fps / フレーム時間(avg・p95)/ 1% low の中央値とばらつきを返す。カメラ・シーンは事前に整えるか camera / scene で指定。",
    group: (a) => `engine:${env.resolveEngineId(a.engine as string | undefined) ?? "default"}`, timeoutSec: cfg.timeoutSec.bench,
    shape: {
      frames: z.number().int().min(30).max(3600).optional().describe("1 回の計測フレーム数(既定 300)。"),
      runs: z.number().int().min(1).max(10).optional().describe("繰り返し回数(既定 3)。中央値と最小・最大を返す。"),
      uncap: z.boolean().optional().describe("計測中だけ FPS 上限と VSync を外す(既定 true)。"),
      scene: z.string().optional().describe("計測前に開くシーン(assets 相対)。"),
      camera: z.object({ position: z.array(z.number()).length(3), target: z.array(z.number()).length(3) }).optional().describe("計測前にエディタカメラを置く視点。"),
      engine: z.string().optional().describe("使うエンジン(id / name / port)。省略で束縛中。"),
    },
    normalize(a) { return { frames: 300, runs: 3, uncap: true, ...a }; },
    async run(a, ctx): Promise<InprocOutcome> {
      const engine = a.engine as string | undefined;
      const id = env.resolveEngineId(engine);
      ctx.setEngine(id ?? "default");
      const frames = a.frames as number, runs = a.runs as number;
      const ref = id ?? engine;
      const call = (m: string, p: Record<string, unknown>, o?: { timeout?: number }) => env.callEngine(ref, m, p, o);
      ctx.progress({ phase: "preparing", pct: 0, message: "エンジンへ接続" });
      const ping = await call("ping", {}, { timeout: 5000 });
      if (typeof a.scene === "string") { ctx.progress({ phase: "preparing", message: `シーンを開く: ${a.scene}` }); await call("open_scene", { path: a.scene }, { timeout: 60000 }); }
      const cam = a.camera as { position: number[]; target: number[] } | undefined;
      if (cam) await call("set_editor_camera", { position: cam.position, target: cam.target });
      const results: any[] = [];
      for (let r = 0; r < runs; r++) {
        ctx.progress({ phase: "benchmark", pct: Math.round((r * 100) / runs), message: `計測 ${r + 1}/${runs}(${frames} フレーム)` });
        ctx.log(`run ${r + 1}/${runs}: benchmark frames=${frames}`);
        const pending = call("benchmark", { frames, uncap: a.uncap }, { timeout: Math.max(60_000, frames * 60 + 30_000) });
        const res = await raceAbort(pending, ctx.signal, async () => { await call("cancel", { target: "benchmark" }, { timeout: 4000, retry: false }); });
        results.push(res);
        ctx.log(`run ${r + 1}: fps=${res?.fps} avg=${res?.frameMs?.avg}ms p95=${res?.frameMs?.p95}ms low1%=${res?.fps1PercentLow}`);
      }
      ctx.progress({ phase: "summarizing", pct: 95, message: "集計" });
      const col = (f: (x: any) => number | undefined) => results.map(f).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const stat = (v: number[]) => ({ median: round2(median(v)), min: round2(v.length ? Math.min(...v) : null), max: round2(v.length ? Math.max(...v) : null) });
      const summary = {
        runs, frames, engine: id ?? "default", mode: ping?.mode ?? null, scene: ping?.currentScene ?? null,
        fps: stat(col((x) => x?.fps)), frameMsAvg: stat(col((x) => x?.frameMs?.avg)), frameMsP95: stat(col((x) => x?.frameMs?.p95)), fps1PercentLow: stat(col((x) => x?.fps1PercentLow)),
        renderResolution: results[0]?.renderResolution ?? null, uncapped: !!results[0]?.uncapped,
        note: "中央値で比較する。runs 間のばらつき(min〜max)が大きいときは、他のプロセス(ビルドなど)が動いていた可能性がある",
      };
      return { summary, result: { summary, runs: results } };
    },
  };
}

// ── playtest ────────────────────────────────────────────────────────────────
export function playtestKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "playtest", executor: "inproc",
    describe: "保存済みの .playtest を 1 本ずつ再生して回帰確認する(dx12_run_playtests と同じ判定)。進捗はテスト本数。落ちたものは『いつ・どれだけ』ずれたかを返す。",
    group: (a) => `engine:${env.resolveEngineId(a.engine as string | undefined) ?? "default"}`, timeoutSec: cfg.timeoutSec.playtest,
    shape: {
      name: z.string().optional().describe("走らせるテスト名。省略で全部。"),
      judge: z.boolean().optional().describe("true=落ちた原因を外部の判断段(Jev)に聞く(既定 false。ジョブでは鍵と外部通信を避ける)。"),
      engine: z.string().optional().describe("使うエンジン(id / name / port)。省略で束縛中。"),
    },
    normalize(a) { return { judge: false, ...a }; },
    async run(a, ctx): Promise<InprocOutcome> {
      const engine = a.engine as string | undefined;
      const id = env.resolveEngineId(engine);
      ctx.setEngine(id ?? "default");
      ctx.progress({ phase: "preparing", pct: 0, message: "プレイテストの一覧を取得" });
      const ref = id ?? engine;
      const ping = await env.callEngine(ref, "ping", {}, { timeout: 5000 });
      const dir = playtestDir(String(ping?.baseDir ?? ""));
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { /* 無し */ }
      if (typeof a.name === "string") files = files.filter((f) => f === `${safe(a.name as string)}.json`);
      if (files.length === 0) return { summary: { ran: 0, passed: 0, failed: 0, note: `該当する .playtest が無い(${dir})` }, ok: typeof a.name !== "string" };
      const results: any[] = [];
      for (let i = 0; i < files.length; i++) {
        if (ctx.signal.aborted) throw new Aborted();
        const name = files[i].replace(/\.json$/, "");
        ctx.progress({ phase: "playing", pct: Math.round((i * 100) / files.length), message: `[${i + 1}/${files.length}] ${name}` });
        const call = env.callTool("dx12_run_playtests", { name, judge: a.judge === true }, ref);
        const r = await raceAbort(call, ctx.signal, async () => { await env.callEngine(ref, "cancel", { target: "step_frames" }, { timeout: 4000, retry: false }); });
        let parsed: any = null;
        try { parsed = JSON.parse(r.text); } catch { /* 文字列のまま */ }
        if (r.isError || !parsed) { results.push({ name, pass: false, reasons: [`実行に失敗: ${r.text.slice(0, 300)}`] }); ctx.log(`${name}: ERROR ${r.text.slice(0, 200)}`); continue; }
        for (const x of parsed.results ?? []) results.push(x);
        ctx.log(`${name}: ${parsed.failed ? "FAIL" : "pass"}`);
      }
      const failed = results.filter((x) => !x.pass);
      const summary = { ran: results.length, passed: results.length - failed.length, failed: failed.length, failedTests: failed.map((x) => ({ name: x.name, reasons: (x.reasons ?? []).slice(0, 3), endDistance: x.endDistance, maxDeviation: x.maxDeviation, maxDeviationAt: x.maxDeviationAt })).slice(0, 30) };
      return { summary, result: { summary, results }, ok: failed.length === 0, ...(failed.length ? { error: { code: "E_JOB_FAILED", message: `${failed.length}/${results.length} 本のプレイテストが落ちた` } } : {}) };
    },
  };
}

// ── scene_spec(宣言的シーン生成。仕様 JSON の差分適用 + 自動検証。大規模な仕様の非同期実行と進捗)────────────────────
export function sceneSpecKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "scene_spec", executor: "inproc",
    describe: "シーン仕様(SceneSpec v1)を dx12_apply_scene_spec と同じ流れ(検証 → 差分計画 → 1 トランザクションで適用 → 自動検証)で非同期に実行する。大規模な仕様(数百〜5,000 体)向け。進捗は生成の段階ごと。失敗は全体をロールバックし、結果に specPatch が入る。",
    group: (a) => `engine:${env.resolveEngineId(a.engine as string | undefined) ?? "default"}`, timeoutSec: cfg.timeoutSec.scene_spec,
    shape: {
      spec: z.record(z.any()).describe("シーン仕様(SceneSpec v1)のオブジェクト。"),
      patch: z.array(z.record(z.any())).optional().describe("spec に当ててから実行する JSON Patch(RFC 6902)。"),
      mode: z.enum(["plan", "apply"]).optional().describe("plan=差分計画だけ / apply=適用(既定)。"),
      verify: z.any().optional().describe("自動検証の指定(dx12_apply_scene_spec の verify と同じ)。"),
      prune: z.boolean().optional().describe("仕様に無い(この仕様が作った)エンティティを消す。削除なので承認が要る。"),
      detail: z.number().int().min(1).max(500).optional().describe("plan に各 action を何件まで載せるか。"),
      engine: z.string().optional().describe("使うエンジン(id / name / port)。省略で束縛中。"),
    },
    check(a, c) {
      if (a.prune === true && (a.mode ?? "apply") === "apply" && !c.approved) {
        jobFail({ code: "E_GUARDED", message: "scene_spec {prune:true} は仕様に無いエンティティを削除する(guarded)。ユーザーの承認が要る", retryable: false,
          fix: [{ tool: "dx12_call_guarded", args: { name: "dx12_job_start", args: { kind: "scene_spec", args: a } }, why: "承認を得たあとで実行する(core 面。full 面は dx12_call {confirm:true})" }] });
      }
    },
    normalize(a) { return { mode: "apply", ...a }; },
    async run(a, ctx): Promise<InprocOutcome> {
      const engine = a.engine as string | undefined;
      const id = env.resolveEngineId(engine);
      ctx.setEngine(id ?? "default");
      const ref = id ?? engine;
      const call = (m: string, p?: Record<string, unknown>, o?: { timeout?: number; retry?: boolean }) => env.callEngine(ref, m, p ?? {}, o);
      ctx.progress({ phase: "preparing", pct: 0, message: "エンジンへ接続" });
      const r = await runSceneSpec({
        engine: { call: (m, p, o) => call(m, p, o) }, cache: new SpecCache(), looks: LOOK_IDS, signal: ctx.signal,
        onProgress: (p) => { ctx.progress({ phase: p.phase, pct: p.pct, message: p.message }); ctx.log(`[${p.pct}%] ${p.phase}: ${p.message}`); },
        callTool: async (name, args) => { const t = await env.callTool(name, args, ref); try { const d = JSON.parse(t.text); return { ok: !t.isError && d?.ok !== false, data: d?.result ?? d, error: t.isError ? String(d?.error ?? t.text).slice(0, 300) : undefined }; } catch { return { ok: !t.isError, error: t.text.slice(0, 300) }; } },
      }, { spec: a.spec, patch: a.patch as any, mode: a.mode as any, verify: a.verify, prune: a.prune === true, detail: a.detail as number | undefined });
      if (r.ok) {
        const d: any = r.data;
        const summary = { mode: d.mode, name: d.name, entityCount: d.entityCount, ...(d.result ?? {}), plan: d.plan?.summary, verifyPass: d.verify?.pass, idempotent: d.idempotent, tookMs: d.timing?.totalMs ?? d.tookMs, specRef: d.specRef };
        return { summary, result: d };
      }
      const summary = { stage: r.stage, code: r.code, issues: r.issues.length, specPatchOps: r.specPatch.length, message: r.message.slice(0, 300) };
      return { summary, result: { ok: false, stage: r.stage, message: r.message, issues: r.issues.slice(0, 60), specPatch: r.specPatch, specRef: r.specRef, ...r.data }, ok: false, error: { code: r.code, message: r.message, details: { stage: r.stage, specPatch: r.specPatch.slice(0, 200), issues: r.issues.slice(0, 20) } } };
    },
  };
}

// ── screenshot_batch ────────────────────────────────────────────────────────
export type ShotCamera = { name?: string; position?: number[]; target?: number[] };
export type ShotVariant = { name?: string; calls?: { method: string; params?: Record<string, unknown> }[]; launchArgs?: string[] };
export type ShotItem = { index: number; camera: string; cameraPose?: { position: number[]; target?: number[] }; variant: string; calls: { method: string; params?: Record<string, unknown> }[]; dpiScale: number | null; file: string };
export type ShotGroup = { key: string; dpiScale: number | null; launchArgs: string[]; items: ShotItem[] };

/** カメラ × DPI 倍率 × バリアントのマトリクスを、エンジンの起動条件(dpiScale + launchArgs)ごとのグループに分ける。純関数。 */
export function planShots(a: { cameras?: ShotCamera[]; dpiScales?: number[]; variants?: ShotVariant[] }, baseDpi?: number | null): { groups: ShotGroup[]; total: number } {
  const cameras: ShotCamera[] = a.cameras?.length ? a.cameras : [{ name: "current" }];
  const variants: ShotVariant[] = a.variants?.length ? a.variants : [{ name: "base" }];
  const dpis: (number | null)[] = a.dpiScales?.length ? a.dpiScales : [null];
  const groups = new Map<string, ShotGroup>();
  let idx = 0;
  const namesSeen = new Map<string, number>();
  const uniq = (kind: string, n: string) => { const k = `${kind}:${n}`; const c = namesSeen.get(k) ?? 0; namesSeen.set(k, c + 1); return c ? `${n}-${c + 1}` : n; };
  const camNames = cameras.map((c, i) => uniq("cam", safe(c.name ?? `cam${i + 1}`)));
  const varNames = variants.map((v, i) => uniq("var", safe(v.name ?? `v${i + 1}`)));
  for (const dpi of dpis) {
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const launchArgs = v.launchArgs ?? [];
      // 起動条件が「いまのエンジン」と同じなら(dpi 未指定 or baseDpi と同じ、launchArgs 無し)ベースのエンジンを使う = key "base"
      const isBase = launchArgs.length === 0 && (dpi === null || (baseDpi != null && Math.abs(dpi - baseDpi) < 0.01));
      const key = isBase ? "base" : `dpi=${dpi ?? "default"}|${launchArgs.join(" ")}`;
      if (!groups.has(key)) groups.set(key, { key, dpiScale: isBase ? null : dpi, launchArgs, items: [] });
      for (let ci = 0; ci < cameras.length; ci++) {
        const c = cameras[ci];
        const dpiLabel = dpi === null ? (baseDpi ?? "base") : dpi;
        groups.get(key)!.items.push({
          index: idx++, camera: camNames[ci], variant: varNames[vi], calls: v.calls ?? [], dpiScale: dpi ?? (baseDpi ?? null),
          ...(c.position ? { cameraPose: { position: c.position, ...(c.target ? { target: c.target } : {}) } } : {}),
          file: `${camNames[ci]}__${varNames[vi]}__dpi${dpiLabel}.png`,
        });
      }
    }
  }
  return { groups: [...groups.values()], total: idx };
}

export function screenshotBatchKind(env: KindEnv): KindDef {
  const cfg = env.cfg;
  return {
    kind: "screenshot_batch", executor: "inproc",
    describe: "カメラ × DPI 倍率 × バリアントのマトリクスを順に撮影し、画像・マニフェスト・コンタクトシートを返す。--dpi-scale は起動引数なので、倍率ごとに専用エンジンを起動して撮り、終わったら止める。",
    group: (a) => `engine:${env.resolveEngineId(a.engine as string | undefined) ?? "shots"}`, timeoutSec: cfg.timeoutSec.screenshot_batch,
    shape: {
      cameras: z.array(z.object({ name: z.string().optional(), position: z.array(z.number()).length(3).optional(), target: z.array(z.number()).length(3).optional() })).max(48).optional().describe("撮影する視点(省略でいまのカメラで 1 枚)。position を渡すとエディタカメラをそこへ置く。"),
      dpiScales: z.array(z.number().min(0.75).max(3)).max(6).optional().describe("UI の表示倍率(0.75〜3.0)。いまのエンジンと違う倍率は専用エンジンを起動して撮る(フリートの上限内。1 台ずつ)。"),
      variants: z.array(z.object({
        name: z.string().optional(),
        calls: z.array(z.object({ method: z.string(), params: z.record(z.any()).optional() })).max(30).optional().describe("撮る前に実行するエンジン呼び出し(例 set_scene_settings)。既定 revert:true でトランザクションごと巻き戻す。"),
        launchArgs: z.array(z.string()).max(8).optional().describe("専用エンジンの追加起動引数(例 [\"--theme-variant\",\"b\"])。管理対象フラグ(--mcp-port 等)は指定できない。"),
      })).max(12).optional().describe("バリアント(比較したい状態)。"),
      view: z.enum(["final", "imgui", "scene"]).optional().describe("final(既定)=ポスト適用後の最終画 / imgui=エディタ UI 込み(DPI の比較はこれ)/ scene=ポスト前。"),
      deterministic: z.boolean().optional().describe("final のとき、決定論撮影(時間を固定して settleFrames 進めてから撮る)。"),
      settleFrames: z.number().int().min(1).max(240).optional().describe("deterministic のときの落ち着かせるフレーム数。"),
      gizmos: z.boolean().optional().describe("false でエディタのデバッグ描画を止めて撮る(final のみ)。"),
      revert: z.boolean().optional().describe("バリアントの calls をトランザクションで巻き戻す(既定 true)。false だと変更が残る。"),
      scene: z.string().optional().describe("撮影前に開くシーン(assets 相対)。"),
      project: z.string().optional().describe("専用エンジンで開くプロジェクトのフォルダ。省略で使い捨てプロジェクト(中身は空の最小シーン)。実プロジェクトを指すと MCP の自動保存で書き込まれ得る。"),
      settleMs: z.number().int().min(0).max(30000).optional().describe("専用エンジンを起動した直後に、撮影前に待つ時間(ms、既定 1200。step_frames 40 の後)。起動直後は UI が崩れる。"),
      contactSheet: z.boolean().optional().describe("コンタクトシート(全画像の格子)を作る(既定 true)。"),
      columns: z.number().int().min(1).max(8).optional().describe("コンタクトシートの列数(既定 = カメラ数、最大 6)。"),
      engine: z.string().optional().describe("基準にするエンジン(id / name / port)。省略で束縛中。"),
    },
    normalize(a) { return { view: "final", revert: true, contactSheet: true, ...a }; },
    check(a) {
      const total = (a.cameras as any[] | undefined)?.length ?? 1;
      const nv = (a.variants as any[] | undefined)?.length ?? 1;
      const nd = (a.dpiScales as any[] | undefined)?.length ?? 1;
      if (total * nv * nd > 200) return jobFail({ code: "E_OUT_OF_RANGE", message: `dx12_job_start screenshot_batch: 撮影枚数が多すぎる(${total}×${nv}×${nd}=${total * nv * nd} 枚。上限 200)`, retryable: false });
      const bad = ["--mcp-port", "--owner-pid", "--idle-exit", "--instance-id", "--project", "--headless", "--background", "--virtual-input", "--net-client", "--build"];
      for (const v of (a.variants as ShotVariant[] | undefined) ?? []) for (const x of v.launchArgs ?? []) if (bad.includes(x)) return jobFail({ code: "E_BAD_ENUM", message: `dx12_job_start screenshot_batch: launchArgs に管理対象フラグ ${x} は渡せない`, retryable: false });
    },
    async run(a, ctx): Promise<InprocOutcome> {
      const baseRef = env.resolveEngineId(a.engine as string | undefined) ?? (a.engine as string | undefined);
      const view = a.view as "final" | "imgui" | "scene";
      const revert = a.revert !== false;
      const method = view === "imgui" ? "imgui_screenshot" : view === "scene" ? "screenshot" : "screenshot_final";
      // 基準エンジンの倍率を知る(専用エンジンが要るか判断するため。繋がらなければ null = 全部専用エンジンで撮る)
      let baseDpi: number | null = null;
      let baseAvailable = true;
      try { const p = await env.callEngine(baseRef, "ping", {}, { timeout: 4000, retry: false }); baseDpi = typeof p?.dpiScale === "number" ? p.dpiScale : null; }
      catch { baseAvailable = false; }
      const plan = planShots(a as any, baseDpi);
      const needsBase = plan.groups.some((g) => g.key === "base");
      if (needsBase && !baseAvailable) {
        return jobFail({ code: "E_ENGINE_UNREACHABLE", message: "screenshot_batch: 基準のエンジンに繋がらない(いまの倍率で撮るグループがある)", retryable: true, fix: [{ tool: "dx12_engine_launch", args: {}, why: "自分専用のエンジンを起動して束縛する" }] });
      }
      const outDir = ctx.artifactsDir;
      fs.mkdirSync(outDir, { recursive: true });
      const manifest: any[] = [];
      const pngs: { buf: Buffer; item: ShotItem }[] = [];
      let done = 0;
      let consecutiveFail = 0;
      const total = plan.total;
      const engineIds: string[] = [];
      ctx.log(`plan: ${plan.groups.length} グループ / ${total} 枚 / view=${view} / baseDpi=${baseDpi}`);

      for (let gi = 0; gi < plan.groups.length; gi++) {
        const g = plan.groups[gi];
        let ref: string | undefined = baseRef;
        let launched: string | null = null;
        const fleet = env.fleet();
        try {
          if (g.key !== "base") {
            if (!fleet) return jobFail({ code: "E_FLEET_DISABLED", message: "screenshot_batch: 別の倍率で撮るには専用エンジンの起動が要るが、フリートが無効(DX12_FLEET_DISABLE=1)", retryable: false });
            ctx.progress({ phase: "launching", pct: Math.round((done * 100) / total), message: `専用エンジンを起動(倍率 ${g.dpiScale ?? "既定"}${g.launchArgs.length ? ` ${g.launchArgs.join(" ")}` : ""})` });
            const r = await fleet.launch({ name: `shots-${ctx.job.id.slice(-6)}-${gi + 1}`, mode: "background", ...(g.dpiScale !== null ? { dpiScale: g.dpiScale } : {}), ...(g.launchArgs.length ? { args: g.launchArgs } : {}), ...(a.project ? { project: a.project } : {}), noBind: true });
            launched = String(r.engineId);
            ref = launched;
            engineIds.push(launched);
            ctx.setEngine(launched);
            ctx.log(`launched ${launched} port=${r.port}`);
          } else if (env.resolveEngineId(baseRef)) ctx.setEngine(env.resolveEngineId(baseRef)!);
          const call = (m: string, p: Record<string, unknown>, o?: { timeout?: number }) => env.callEngine(ref, m, p, o);
          if (typeof a.scene === "string") await call("open_scene", { path: a.scene }, { timeout: 60000 });
          if (launched) {
            // 起動直後は ImGui のフォント再構築・初回描画の途中で、撮ると UI が崩れた絵になる(実機で確認)。数十フレーム回して落ち着かせる。
            try { await call("step_frames", { frames: 40 }, { timeout: 30000 }); } catch { /* 無くても撮る */ }
            await sleep(Math.max(0, (a.settleMs as number | undefined) ?? 1200));
          }
          for (const item of g.items) {
            if (ctx.signal.aborted) throw new Aborted();
            ctx.progress({ phase: "capturing", pct: Math.round((done * 100) / total), message: `[${done + 1}/${total}] ${item.camera} / ${item.variant} / dpi ${item.dpiScale ?? "既定"}` });
            const file = path.join(outDir, item.file);
            const entry: any = { index: item.index, camera: item.camera, variant: item.variant, dpiScale: item.dpiScale, view, path: file, engine: ref ?? "default" };
            const t0 = Date.now();
            let txOpen = false;
            try {
              if (item.calls.length && revert) { await call("transaction_begin", { label: `screenshot_batch ${item.variant}` }, { timeout: 8000 }); txOpen = true; }
              for (const c of item.calls) await call(c.method, c.params ?? {}, { timeout: 30000 });
              if (item.cameraPose) await call("set_editor_camera", { position: item.cameraPose.position, ...(item.cameraPose.target ? { target: item.cameraPose.target } : {}) });
              const params: Record<string, unknown> = { path: file };
              if (view === "final") { if (a.deterministic) { params.deterministic = true; if (a.settleFrames) params.settleFrames = a.settleFrames; } if (a.gizmos === false) params.gizmos = false; }
              const shot = await raceAbort(call(method, params, { timeout: 90000 }), ctx.signal, async () => { /* 撮影は 1 フレームで返る。待つだけ */ });
              entry.width = shot?.width; entry.height = shot?.height; entry.tookMs = Date.now() - t0;
              const buf = fs.readFileSync(shot?.path ?? file);
              entry.bytes = buf.length; entry.path = shot?.path ?? file;
              pngs.push({ buf, item });
              ctx.addArtifact({ path: entry.path, kind: "screenshot", bytes: buf.length });
              consecutiveFail = 0;
            } catch (e: any) {
              if (e instanceof Aborted) throw e;
              entry.error = String(e?.message ?? e).slice(0, 300);
              consecutiveFail++;
              ctx.log(`FAIL ${item.file}: ${entry.error}`);
            } finally {
              if (txOpen) { try { await call("transaction_rollback", {}, { timeout: 45000 }); } catch (e: any) { entry.rollbackError = String(e?.message ?? e).slice(0, 200); } }
            }
            manifest.push(entry);
            done++;
            if (consecutiveFail >= 3) return jobFail({ code: "E_JOB_FAILED", message: `screenshot_batch: 3 枚連続で撮影に失敗したので中断した(最後: ${manifest[manifest.length - 1]?.error})`, retryable: true, details: { done, total } });
          }
        } finally {
          if (launched && fleet) { try { await fleet.stop({ engine: launched }); } catch { /* 停止に失敗しても結果は返す(アイドルで自動終了する) */ } }
        }
      }

      ctx.progress({ phase: "finishing", pct: 97, message: "マニフェストとコンタクトシートを作成" });
      manifest.sort((x, y) => x.index - y.index);
      const manifestPath = path.join(outDir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify({ jobId: ctx.job.id, view, total, plan: plan.groups.map((g) => ({ key: g.key, dpiScale: g.dpiScale, launchArgs: g.launchArgs, count: g.items.length })), shots: manifest }, null, 2));
      ctx.addArtifact({ path: manifestPath, kind: "manifest" });
      let sheetPath: string | null = null;
      let sheetInfo: any = null;
      if (a.contactSheet !== false && pngs.length > 0) {
        try {
          pngs.sort((x, y) => x.item.index - y.item.index);
          const cols = Math.max(1, Math.min(6, (a.columns as number | undefined) ?? Math.min(6, (a.cameras as any[] | undefined)?.length ?? 3)));
          const sheet = buildContactSheet(pngs.map((p) => p.buf), { columns: cols, tileWidth: 320 });
          sheetPath = path.join(outDir, "contact_sheet.png");
          fs.writeFileSync(sheetPath, sheet.sheetPng);
          ctx.addArtifact({ path: sheetPath, kind: "contact_sheet", bytes: sheet.sheetPng.length });
          sheetInfo = { columns: sheet.columns, rows: sheet.rows, tile: sheet.tile, order: pngs.map((p, i) => ({ n: i + 1, file: p.item.file })) };
        } catch (e: any) { ctx.log(`コンタクトシートの作成に失敗: ${e?.message ?? e}`); }
      }
      const ok = manifest.filter((m) => !m.error).length;
      const summary = { total, captured: ok, failed: total - ok, groups: plan.groups.length, dedicatedEngines: engineIds, dir: outDir, manifest: manifestPath, contactSheet: sheetPath, view, revert };
      return { summary, result: { summary, shots: manifest, contactSheet: sheetInfo }, ok: ok > 0 && ok === total, ...(ok === total ? {} : { error: { code: "E_JOB_FAILED", message: `${total - ok}/${total} 枚の撮影に失敗した`, details: { failed: manifest.filter((m) => m.error).slice(0, 5) } } }) };
    },
  };
}
