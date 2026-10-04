// 全ジョブ種別。並びは dx12_job_start の kind の列挙順(build が先頭)。
import type { KindDef } from "../manager.ts";
import type { KindEnv } from "../env.ts";
import { buildKind, ctestKind, externalKind, uiTestsKind, ueImportKind, vgCookKind } from "./process.ts";
import { visualRegressionKind } from "../../testing/visualKind.ts";
import { perfGateKind } from "../../testing/perfGateKind.ts";
import { ciSuiteKind } from "../../testing/ciSuiteKind.ts";
import { benchKind, playtestKind, sceneSpecKind, screenshotBatchKind } from "./engine.ts";

export function allKinds(env: KindEnv): KindDef[] {
  return [buildKind(env), ctestKind(env), uiTestsKind(env), screenshotBatchKind(env), benchKind(env), playtestKind(env), externalKind(env), vgCookKind(env), ueImportKind(env), sceneSpecKind(env), visualRegressionKind(env), perfGateKind(env), ciSuiteKind(env)];
}
