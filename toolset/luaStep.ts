// dx12_lua_step: 「Lua で仕掛ける → (キーを押したまま) N フレーム進める → Lua で読む」を 1 回の呼び出しで行う合成ツール。
//
// ★なぜ要るか(2026-10-04 の実測): 過去 13 セッション・2,791 回の dx12 呼び出しのうち、
//   eval_lua → step_frames → eval_lua の並びが最頻(168 回)で、eval_lua だけで 762 回。エンジンの往復は 1 回 17ms なのに、
//   1 手ごとにモデルのターン(中央値 3.7 秒)が挟まるので、待ち時間のほぼ全部がこの「細切れの往復」だった。
//   eval_lua は guarded なので dx12_batch には入れられず、束ねる手段が無かった。
//
// 承認: 任意の Lua を走らせる = dx12_eval_lua と同じ扱い(catalog.ts GUARDED_COMPOSITE_NAMES)。
//   直接呼ぶ = その呼び出し自体が承認(full 面ではクライアントの権限確認が、core / shell 面では dx12_call_guarded / confirm がゲート)。
//
// 登録の作法は virtualGeometry.ts と同じ:
//   ・legacy 面(旧 220 本のスナップショット)には出さない
//   ・full 面: tools/list の末尾 / core・shell 面: tools/list には出さず dx12_call_guarded / dx12_call {confirm:true} で使う
import { z } from "zod";
import { engine, errResult, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY } from "../toolRuntime.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope } from "../errors.ts";
import { guardApproval } from "../guardCtx.ts";

export const LUA_STEP_TOOLS = ["dx12_lua_step"];

const MAX_FRAMES = 600;   // エンジンの step_frames の上限と同じ(~10 秒)
const MAX_SAMPLES = 60;   // every で読む回数の上限(結果がコンテキストを食い過ぎないように)

const SHAPE: Record<string, z.ZodTypeAny> = {
  before: z.string().optional().describe("最初に 1 回実行する Lua(仕掛け: 位置を置く・力を加える・状態を作る)。グローバルは after と共有される。"),
  frames: z.number().int().min(1).max(MAX_FRAMES).optional().describe(`進めるフレーム数(既定 1, 最大 ${MAX_FRAMES})。`),
  after: z.string().optional().describe("進めた後に実行する Lua(読む: return した値が結果に入る)。every を付けると途中でも読む。"),
  every: z.number().int().min(1).optional().describe(`after を every フレームごとに実行して samples に並べる(軌跡を 1 回で取る)。最大 ${MAX_SAMPLES} 回。`),
  keys: z.array(z.union([z.number().int(), z.string()])).optional().describe("進めている間押し続けるキー(\"D\",\"SPACE\" 等。dx12_key_down と同じ)。終わったら必ず離す。"),
  deterministic: z.boolean().optional().describe("dt を固定して再現するステップにする(dx12_step_frames と同じ)。"),
  dt: z.number().optional().describe("固定 dt(秒)。deterministic:true のときだけ有効。"),
  hold: z.boolean().optional().describe("進めた後に時間を止めるか(既定 true)。deterministic:true のときだけ有効。"),
};

const DESCRIPTION =
  "Lua で仕掛ける → (キーを押したまま) N フレーム進める → Lua で読む、を 1 回で行う。dx12_eval_lua → dx12_step_frames → dx12_eval_lua の往復を束ねたもの(往復のたびにターンを使わない)。"
  + "例: {before:\"P=scene:findEntity('Player'); P.transform.position.y=5\", frames:60, deterministic:true, after:\"return P.transform.position.y\"}。"
  + "keys:[\"D\"] で押しっぱなし、every:10 で 10 フレームごとに after を実行して samples に並べる(軌跡)。"
  + "返り値: {before, after | samples:[{frame, result}], step, frames}。Lua の失敗は stage(before/after)付きのエラーで返り、before が失敗したら進めない。"
  + "任意の Lua を走らせるので dx12_eval_lua と同じく承認が要る(guarded)。";

/** frames を every ごとの塊に分ける(最後は端数)。every 無しなら 1 塊。 */
export function stepChunks(frames: number, every?: number): number[] {
  if (!every || every >= frames) return [frames];
  const out: number[] = [];
  for (let left = frames; left > 0; left -= every) out.push(Math.min(every, left));
  return out;
}

function stageError(stage: string, e: any): any {
  const err: any = new Error(`${stage}: ${e?.message ?? e}`);
  for (const k of ["code", "hint", "errName", "errCause", "didYouMean", "errFix", "errDetails", "method", "retryable"]) if (e?.[k] !== undefined) err[k] = e[k];
  err.errDetails = { ...(e?.errDetails ?? {}), stage };
  return err;
}

async function runLuaStep(a: any): Promise<Record<string, unknown>> {
  const frames: number = a.frames ?? 1;
  const chunks = stepChunks(frames, a.every);
  if (a.every && !a.after) throw Object.assign(new Error("every を使うときは after(読む Lua)も渡す"), { errName: "E_INVALID_PARAM", hint: "after に return で値を返す Lua を書く" });
  if (chunks.length > MAX_SAMPLES) throw Object.assign(new Error(`every が細かすぎる(${chunks.length} 回 > ${MAX_SAMPLES})`), { errName: "E_INVALID_PARAM", hint: `every を ${Math.ceil(frames / MAX_SAMPLES)} 以上にする` });
  const stepParams = { deterministic: a.deterministic, dt: a.dt, hold: a.hold };
  const out: Record<string, unknown> = { frames };

  if (a.before) {
    try { out.before = (await engine.call("eval_lua", { code: a.before }))?.result ?? ""; }
    catch (e) { throw stageError("before", e); }
  }
  const keys: (string | number)[] = a.keys ?? [];
  const pressed: (string | number)[] = [];
  const samples: { frame: number; result: unknown }[] = [];
  try {
    for (const key of keys) { await engine.call("key_down", { key }); pressed.push(key); }
    let done = 0;
    for (const n of chunks) {
      out.step = await engine.call("step_frames", { frames: n, ...stepParams });
      done += n;
      if (a.after && a.every) {
        try { samples.push({ frame: done, result: (await engine.call("eval_lua", { code: a.after }))?.result ?? "" }); }
        catch (e) { throw stageError(`after(frame ${done})`, e); }
      }
    }
  } finally {
    // 押したキーは失敗しても必ず離す(押しっぱなしで次の操作が狂うのを防ぐ)
    for (const key of pressed) { try { await engine.call("key_up", { key }); } catch { /* 接続断などは諦める */ } }
  }
  if (a.after && a.every) out.samples = samples;
  else if (a.after) {
    try { out.after = (await engine.call("eval_lua", { code: a.after }))?.result ?? ""; }
    catch (e) { throw stageError("after", e); }
  }
  return out;
}

if (ENHANCED && SURFACE !== "legacy") {
  const name = "dx12_lua_step";
  const title = "Lua で仕掛けて進めて読む";
  const declared = Object.keys(SHAPE);
  const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const invoke = async (args: any): Promise<ToolResult> => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) {
      const body = bodyFromIssues(name, args ?? {}, issues, declared);
      const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
      ERROR_BODY.set(res, body);
      return res;
    }
    // dx12_eval_lua と同じ: このツールの呼び出し自体が承認(core.ts regRaw の GUARDED と同じ扱い)。
    return guardApproval.run({ approved: true, via: `tool:${name}` }, async () => {
      try {
        const data = await runLuaStep(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
      } catch (e: any) {
        return errResult(e);
      }
    });
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
    extraKeywords: "lua eval step frames 進める 仕掛け 読む 軌跡 押しっぱなし 物理 確認 シミュレーション", invoke: (args: any) => invoke(args), listed: !hidden, registered,
  });
}
