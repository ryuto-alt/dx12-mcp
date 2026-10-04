// dx12_oracle: 「書き換えられない正解」(金画像・性能予算・封印したプレイテスト)を作る/照合する/封印するツール。Q2。
//
// ★なぜ要るか: AI が作る側のとき、テストや採点器を書き換えて通すことがある(METR 2025)。正解のハッシュを
//   プロジェクトの外の台帳に封印し、dx12_quality_gate の oracles 検査が改ざんを blocking で検出する。
//   封印(seal)できるのは人の承認(confirm)を通った呼び出しだけ。AI が自分で封印し直してはいけない。
//
// 登録の作法は luaStep.ts / virtualGeometry.ts と同じ:
//   ・legacy 面(旧 220 本のスナップショット)には出さない
//   ・full 面: tools/list の末尾 / core・shell 面: tools/list には出さず dx12_call で使う
//   ・seal だけ引数しだいで guarded(catalog.ts CONDITIONAL_GUARDED)
import fs from "node:fs";
import { z } from "zod";
import { engine, errResult, jevProjectBaseDir, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY, recordError } from "../toolRuntime.ts";
import { CORE_GUARDED_TOOL } from "../coreSpec.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { isGuardApproved } from "../guardCtx.ts";
import {
  SEAL_FIX, captureView, collectOracleItems, emptyManifest, goldenPath, ledgerPath, manifestPath, readManifest, sceneMatches,
  unlockFile, validateManifest, verifyLedger, writeLedger, writeManifest,
  type OracleCamera, type OraclePerf, type OracleView, type PerfMax,
} from "../oracles.ts";

export const ORACLE_TOOLS = ["dx12_oracle"];

// ★呼ぶたびに新しい zod インスタンスを返す(同じインスタンスを 2 か所で使うと JSON Schema が $ref に畳まれ、$ref を解決しないクライアントで誤判定される。toolset/core.ts の注意書き)。
const vec3 = () => z.array(z.number()).length(3);
const SHAPE: Record<string, z.ZodTypeAny> = {
  op: z.enum(["status", "add_view", "capture", "add_perf", "check", "seal"])
    .describe("status = 正解の一覧と封印の照合(エンジン不要) / add_view = 固定カメラの金画像を追加して撮る / capture = 金画像を撮り直す(封印は壊れる) / add_perf = 性能予算を追加 / check = 照合だけ走らせる / seal = 封印(人の承認が要る)"),
  name: z.string().optional().describe("view / perf の名前(英数字・_・-)。capture は省略で全部。"),
  camera: z.object({ position: vec3(), target: vec3() }).optional().describe("固定カメラ。add_view は省略で今のエディタのカメラ。"),
  width: z.number().int().min(16).max(8192).optional().describe("金画像の幅(height と両方。既定 640x360)。"),
  height: z.number().int().min(16).max(8192).optional().describe("金画像の高さ。"),
  tolerance: z.object({ lsb: z.number().min(0).optional(), maxDiffPct: z.number().min(0).optional() }).optional()
    .describe("許容。lsb = 1 画素の許容差(既定 8)、maxDiffPct = 許容を超えた画素の割合 %(既定 0.5)。"),
  frames: z.number().int().min(30).max(3600).optional().describe("add_perf: 計測フレーム数(既定 120)。"),
  max: z.object({ frameMsP95: z.number().optional(), frameMsAvg: z.number().optional(), drawCalls: z.number().optional(), gpuMsTotal: z.number().optional() })
    .optional().describe("add_perf: 性能予算の上限(frameMsP95 / frameMsAvg / drawCalls / gpuMsTotal のどれか 1 つ以上)。"),
  scene: z.string().optional().describe("この正解が対象とするシーン(省略 = 今開いているシーン)。違うシーンが開いているときは検査を飛ばす。"),
};

const DESCRIPTION =
  "書き換えられない正解(金画像・性能予算・封印したプレイテスト)。AI が正解を書き換えて通すのを防ぐ。"
  + "流れ: add_view(固定カメラで金画像を撮る)/ add_perf(予算) → 人が金画像と予算を確認 → seal(人の承認。dx12_call {confirm:true}) → dx12_quality_gate の oracles 検査が毎回照合。"
  + "封印後に金画像・予算・封印したプレイテストが変わると ORACLE_TAMPERED で blocking。★AI は seal も金画像の撮り直しも『通すため』にやってはいけない。"
  + "台帳はプロジェクトの外(%LOCALAPPDATA%/UnoEngine/oracles)。status はエンジン不要で、封印の状態と一覧を返す。"
  + "例: {op:\"add_view\", name:\"hall\", camera:{position:[0,3,8], target:[0,1,0]}} / {op:\"add_perf\", name:\"hall\", max:{frameMsP95:16.6}} / {op:\"check\"}。";

type Args = Record<string, any>;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function bad(message: string, fix: string): never {
  throw Object.assign(new Error(message), { errName: "E_INVALID_PARAM", hint: fix });
}
function needName(a: Args): string {
  if (typeof a.name !== "string" || !NAME_RE.test(a.name)) bad("name が要る(英数字・_・- の 1〜64 文字)", "name を渡す");
  return a.name;
}

async function currentScene(): Promise<string | null> {
  const p = await engine.call("ping", {}).catch(() => null);
  return typeof p?.currentScene === "string" ? p.currentScene : (typeof p?.currentScenePath === "string" ? p.currentScenePath : null);
}
async function editorCamera(): Promise<OracleCamera> {
  const c = await engine.call("get_editor_camera", {});
  if (!Array.isArray(c?.position) || !Array.isArray(c?.target)) throw new Error("get_editor_camera が position/target を返さなかった。camera を渡す");
  return { position: c.position as OracleCamera["position"], target: c.target as OracleCamera["target"] };
}
const call = (m: string, p: Record<string, unknown>) => engine.call(m, p);

const BREAK_NOTE = "金画像/予算を変えたので封印は壊れた(次の dx12_quality_gate は ORACLE_TAMPERED になる)。人が確認してから " + SEAL_FIX + " で封印し直す";

function summarize(baseDir: string) {
  const m = (() => { try { return readManifest(baseDir); } catch (e: any) { return { error: String(e?.message ?? e) } as any; } })();
  const ledger = verifyLedger(baseDir);
  return {
    manifest: manifestPath(baseDir), exists: !!m && !m.error, ...(m?.error ? { error: m.error } : {}),
    views: (m?.views ?? []).map((v: OracleView) => ({ name: v.name, scene: v.scene, golden: fs.existsSync(goldenPath(baseDir, v.name)) })),
    perf: (m?.perf ?? []).map((p: OraclePerf) => ({ name: p.name, scene: p.scene, max: p.max, frames: p.frames })),
    playtests: m?.playtests ?? [],
    ledger: { path: ledgerPath(baseDir), ...ledger },
    ...(ledger.sealed ? {} : { next: "未封印。人が金画像と予算を確認してから " + SEAL_FIX }),
  };
}

async function runOracle(a: Args): Promise<Record<string, unknown>> {
  const baseDir = await jevProjectBaseDir();
  if (!baseDir) bad("プロジェクトの場所(baseDir)が分からない", "dx12_ping で接続を確認する(DX12_PROJECT_DIR でも指定できる)");
  const dir = baseDir as string;
  switch (a.op) {
    case "status": return summarize(dir);
    case "add_view": {
      const name = needName(a);
      const scene = a.scene ?? (await currentScene()) ?? undefined;
      const camera: OracleCamera = a.camera ?? (await editorCamera());
      const view: OracleView = { name, ...(scene ? { scene } : {}), camera,
        ...(a.width !== undefined || a.height !== undefined ? { width: a.width, height: a.height } : {}), ...(a.tolerance ? { tolerance: a.tolerance } : {}) };
      const m = readManifest(dir) ?? emptyManifest();
      m.views = [...m.views.filter((v) => v.name !== name), view];
      const badM = validateManifest(m);
      if (badM.length) bad(badM.join(" / "), "引数を直す");
      writeManifest(dir, m);
      const shot = await captureView(call, view, goldenPath(dir, name));
      return { added: view, golden: goldenPath(dir, name), size: { width: shot.width, height: shot.height }, note: BREAK_NOTE };
    }
    case "capture": {
      const m = readManifest(dir);
      if (!m || m.views.length === 0) bad("撮り直す view が無い", "先に dx12_oracle {op:\"add_view\"}");
      const targets = a.name ? m!.views.filter((v) => v.name === a.name) : m!.views;
      if (targets.length === 0) bad(`view "${a.name}" は無い`, `有効: ${m!.views.map((v) => v.name).join(", ")}`);
      const scene = await currentScene();
      const captured: string[] = [], skipped: string[] = [];
      for (const v of targets) {
        if (!sceneMatches(v.scene, scene)) { skipped.push(`${v.name}(シーン ${v.scene} が開いていない)`); continue; }
        unlockFile(goldenPath(dir, v.name));
        await captureView(call, v, goldenPath(dir, v.name));
        captured.push(v.name);
      }
      return { captured, ...(skipped.length ? { skipped } : {}), note: BREAK_NOTE };
    }
    case "add_perf": {
      const name = needName(a);
      if (!a.max || Object.keys(a.max).length === 0) bad("max(frameMsP95 / frameMsAvg / drawCalls / gpuMsTotal)が要る", "予算を 1 つ以上渡す");
      const scene = a.scene ?? (await currentScene()) ?? undefined;
      const perf: OraclePerf = { name, ...(scene ? { scene } : {}), ...(a.camera ? { camera: a.camera } : {}), ...(a.frames ? { frames: a.frames } : {}), max: a.max as PerfMax };
      const m = readManifest(dir) ?? emptyManifest();
      m.perf = [...m.perf.filter((p) => p.name !== name), perf];
      const badM = validateManifest(m);
      if (badM.length) bad(badM.join(" / "), "引数を直す");
      writeManifest(dir, m);
      return { added: perf, note: BREAK_NOTE };
    }
    case "check": {
      let mode: string | null = null;
      try { mode = (await engine.call("get_mode", {}))?.mode ?? null; } catch { /* 無視 */ }
      const r = await collectOracleItems(call, dir, mode);
      return { pass: !r.items.some((i) => i.blocking), ...(r.skipped ? { skipped: r.skipped } : {}), summary: r.summary, items: r.items };
    }
    case "seal": {
      const r = writeLedger(dir);
      return { sealedAt: r.sealedAt, files: r.files, ledger: ledgerPath(dir), ...(r.missingPlaytests.length ? { missingPlaytests: r.missingPlaytests } : {}) };
    }
    default: bad(`知らない op: ${a.op}`, "status / add_view / capture / add_perf / check / seal");
  }
}

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}

if (ENHANCED && SURFACE !== "legacy") {
  const name = "dx12_oracle";
  const title = "書き換えられない正解";
  const declared = Object.keys(SHAPE);
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const invoke = async (args: any): Promise<ToolResult> => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) return errorResult(bodyFromIssues(name, args ?? {}, issues, declared));
    // 封印は人の承認が要る(承認済みの経路 = dx12_call {confirm:true} / dx12_call_guarded だけ)。AI が自分で封印し直せないのが要。
    if (args?.op === "seal" && !isGuardApproved()) {
      const split = SURFACE === "core";
      const via = split ? CORE_GUARDED_TOOL : "dx12_call";
      const body: ErrorBody = {
        code: "E_GUARDED",
        message: "dx12_oracle {op:\"seal\"} は正解(金画像・予算・プレイテスト)を封印する。人が金画像と予算を確認してから、人の承認で実行する",
        cause: "AI が正解を書き換えて通す事故を防ぐため、封印は承認済みの経路でしか通らない",
        fix: [{ tool: via, args: split ? { name, args: { op: "seal" } } : { name, args: { op: "seal" }, confirm: true }, why: "人が金画像と性能予算を確認し、承認したうえで実行する" }],
        details: { effect: "guarded", via, fixCall: SEAL_FIX },
      };
      recordError({ at: Date.now(), tool: name, code: body.code, message: body.message });
      return errorResult(body);
    }
    try {
      const data = await runOracle(args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
    } catch (e: any) {
      return errResult(e);
    }
  };
  const hidden = SURFACE === "shell" || SURFACE === "core";
  const registered = server.registerTool(
    name,
    { title, description: DESCRIPTION, inputSchema: z.object(SHAPE).passthrough() as any, annotations: { title, ...annotations } },
    async (args: any) => invoke(args),
  );
  if (hidden) registered.disable();
  TOOL_REGISTRY.set(name, {
    name, title, description: DESCRIPTION, shape: SHAPE, annotations, tier: "core", core: false, coreDescription: DESCRIPTION,
    extraKeywords: "oracle 正解 金画像 ゴールデン golden 封印 seal 性能予算 perf budget 改ざん 書き換え 視覚回帰 回帰 品質ゲート", invoke: (args: any) => invoke(args), listed: !hidden, registered,
  });
}
