// ジョブ API のセッション内シングルトン(遅延生成)。使われるまで何も作らない = ジョブを使わない運用は従来と同じ。
// EngineRouter・フリート・TS ツール登録表を KindEnv として束ねる。
import fs from "node:fs";
import { router } from "../toolset/core.ts";
import { TOOL_REGISTRY, callContext } from "../toolRuntime.ts";
import { fleetToolsEnabled } from "../fleet/enabled.ts";
import { getFleet } from "../fleet/runtime.ts";
import { nearest } from "../errors.ts";
import { loadJobsConfig, type JobsConfig } from "./config.ts";
import type { KindEnv } from "./env.ts";
import { allKinds } from "./kinds/index.ts";
import { JobManager, jobFail } from "./manager.ts";

let instance: JobManager | null = null;
let hooksInstalled = false;

export function jobsConfig(): JobsConfig { return instance?.cfg ?? loadJobsConfig(); }
export function jobsIfCreated(): JobManager | null { return instance; }

export function makeKindEnv(cfg: JobsConfig): KindEnv {
  const resolveEngineId = (ref?: string): string | undefined => {
    if (ref !== undefined && ref !== null && String(ref) !== "") {
      const s = router.find(ref);
      if (!s) {
        const cands = router.list().flatMap((x) => [x.id, x.name]);
        return jobFail({
          code: "E_FLEET_NOT_FOUND", message: `ジョブの engine '${ref}' は束縛できるエンジンに無い`, retryable: false, validValues: router.list().map((x) => x.id), didYouMean: nearest(String(ref), cands, 3, { liberal: true }),
          cause: "engine に指定できるのは、このセッションが起動(dx12_engine_launch)または attach したエンジンの id / name / port",
          fix: [{ tool: "dx12_engine_list", args: {}, why: "選べるエンジンを確認する" }],
        });
      }
      return s.id;
    }
    return router.boundId() ?? undefined;
  };
  return {
    cfg,
    now: () => Date.now(),
    resolveEngineId,
    enginePort: (ref) => (ref ? router.find(ref)?.port : router.current()?.port),
    callEngine: (engine, method, params, opts) => {
      const f = () => router.call(method, params, opts);
      return engine ? router.withEngine(engine, f) : f();
    },
    fleet: () => {
      if (!fleetToolsEnabled()) return null;
      const f = getFleet();
      return {
        launch: (i) => f.launch(i as any),
        stop: (i) => f.stop(i as any),
        list: (i) => f.list(i as any),
        refresh: (i) => f.refresh(i as any),
      };
    },
    callTool: async (name, args, engine) => {
      const entry = TOOL_REGISTRY.get(name);
      if (!entry) return { text: `ツール ${name} は登録されていない`, isError: true, images: 0 };
      const run = () => callContext.run({ tool: name, args, mode: "call" }, () => entry.invoke(args));
      const res: any = await (engine ? router.withEngine(engine, run) : run());
      const content: any[] = res?.content ?? [];
      const texts = content.filter((c) => c.type === "text").map((c) => c.text as string);
      return { text: texts[texts.length - 1] ?? "", isError: !!res?.isError, images: content.filter((c) => c.type === "image").length };
    },
  };
}

/** MCP サーバが終わるときの後始末(inproc ジョブを中断として記録する)。 */
function installHooks(m: JobManager) {
  if (hooksInstalled) return;
  hooksInstalled = true;
  let done = false;
  const cleanup = () => { if (done) return; done = true; try { m.shutdownSync(); } catch { /* 終了処理の失敗で落とさない */ } };
  process.on("exit", cleanup);
}

/** dx12_doctor 用の要約。ジョブを一度も使っていない(フォルダが無い)なら、フォルダも管理オブジェクトも作らない。 */
export function jobsSummary(): Record<string, unknown> | null {
  const cfg = jobsConfig();
  if (cfg.disabled) return { enabled: false, note: "DX12_JOBS_DISABLE=1" };
  if (!instance) {
    let any = false;
    try { any = fs.readdirSync(cfg.dir).some((n) => /^j-/.test(n)); } catch { any = false; }
    if (!any) return { enabled: true, dir: cfg.dir, counts: {}, active: [], limits: { maxRunning: cfg.maxRunning, groupCap: cfg.groupCap } };
  }
  return getJobs().summary();
}

export function getJobs(): JobManager {
  if (!instance) {
    const cfg = loadJobsConfig();
    const env = makeKindEnv(cfg);
    instance = new JobManager({
      cfg, kinds: allKinds(env),
      // 走っている engine 系ジョブがあるエンジンを、アイドル自動終了させない
      touchEngine: (id) => { const s = router.get(id); if (s) s.lastCallAt = Date.now(); },
      onEvent: (kind, message, id) => process.stderr.write(`[dx12-jobs] ${kind}${id ? " " + id : ""}: ${message}\n`),
    });
    installHooks(instance);
  }
  return instance;
}
