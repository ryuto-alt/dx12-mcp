// ジョブ種別 visual_regression(スタブ。実装で置き換える)。
import { z } from "zod";
import { jobFail, type InprocOutcome, type KindDef } from "../jobs/manager.ts";
import type { KindEnv } from "../jobs/env.ts";

export function visualRegressionKind(env: KindEnv): KindDef {
  return {
    kind: "visual_regression", executor: "inproc",
    describe: "(実装中)",
    group: () => "visual_regression", timeoutSec: env.cfg.timeoutSec.visual_regression,
    shape: { engine: z.string().optional() },
    async run(): Promise<InprocOutcome> { return jobFail({ code: "E_UNSUPPORTED", message: "visual_regression: 未実装", retryable: false }); },
  };
}
