// ジョブ種別 ci_suite(スタブ。実装で置き換える)。
import { z } from "zod";
import { jobFail, type InprocOutcome, type KindDef } from "../jobs/manager.ts";
import type { KindEnv } from "../jobs/env.ts";

export function ciSuiteKind(env: KindEnv): KindDef {
  return {
    kind: "ci_suite", executor: "inproc",
    describe: "(実装中)",
    group: () => "ci_suite", timeoutSec: env.cfg.timeoutSec.ci_suite,
    shape: { engine: z.string().optional() },
    async run(): Promise<InprocOutcome> { return jobFail({ code: "E_UNSUPPORTED", message: "ci_suite: 未実装", retryable: false }); },
  };
}
