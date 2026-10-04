// ジョブ種別 perf_gate(スタブ。実装で置き換える)。
import { z } from "zod";
import { jobFail, type InprocOutcome, type KindDef } from "../jobs/manager.ts";
import type { KindEnv } from "../jobs/env.ts";

export function perfGateKind(env: KindEnv): KindDef {
  return {
    kind: "perf_gate", executor: "inproc",
    describe: "(実装中)",
    group: () => "perf_gate", timeoutSec: env.cfg.timeoutSec.perf_gate,
    shape: { engine: z.string().optional() },
    async run(): Promise<InprocOutcome> { return jobFail({ code: "E_UNSUPPORTED", message: "perf_gate: 未実装", retryable: false }); },
  };
}
