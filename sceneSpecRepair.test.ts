// 宣言的シーン生成(M11)の自己修正率(偽エンジン = sceneSim)。
//   sceneSpecCorpus.ts の壊した仕様 27 件(必須の 20 件を超える)を dx12_apply_scene_spec へ撃ち、失敗結果の specPatch を
//   {specRef, patch} でそのまま撃ち直して(最大 3 回)成功に転じるかを数える。合格: 80% 以上。
//   機械では直せない 2 件(到達不能・仕様の外の既存物との重なり)も分母に入れる(正直な数字)。
//   実エンジン(専用インスタンス)での 10 件以上は scripts/sceneSpecReal.ts --only repair(MCP_M11_REPORT.md に結果)。
// 実行: node sceneSpecRepair.test.ts
import "./testEnv.ts";
import { startMockEngine } from "./mockEngine.ts";
import { createSceneSim } from "./sceneSim.ts";
import { EngineClient } from "./engineClient.ts";
import { runSceneSpec, SpecCache } from "./sceneSpec/index.ts";
import { digestScene } from "./sceneSpec/digest.ts";
import { CASES, loadExample, repairLoop, type RepairOutcome } from "./sceneSpecCorpus.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1200)}` : ""}`); }
}

const ASSETS = { "models/cube1m.glb": { min: [-0.5, -0.5, -0.5] as [number, number, number], max: [0.5, 0.5, 0.5] as [number, number, number], type: "model" } };

async function newEnv() {
  const sim = createSceneSim({ assets: ASSETS, scripts: ["components/Spinner.lua"], textures: ["textures/wood.png"] });
  const mock = await startMockEngine({ methods: sim.methods });
  const engine: any = new EngineClient("127.0.0.1", mock.port);
  const callTool = async (name: string, a: Record<string, unknown>) => {
    if (name !== "dx12_check_reachable") return { ok: false, error: `${name} は未対応` };
    const from = await engine.call("get_bounds", { name: a.fromName }), to = await engine.call("get_bounds", { name: a.toName });
    const info = await engine.call("navmesh_info", {});
    if (!info?.stats?.built) return { ok: true, data: { reachable: false, reason: "ナビメッシュが焼かれていない。先に dx12_navmesh_build を撃つこと" } };
    const p = await engine.call("navmesh_path", { from: from.center, to: to.center });
    return { ok: true, data: { reachable: (p?.points ?? []).length > 0 && p?.reached !== false } };
  };
  const cache = new SpecCache();
  const run = async (input: any) => {
    const r = await runSceneSpec({ engine, cache, callTool }, input);
    return r.ok ? { ok: true, ...(r.data as any) } : { ok: false, stage: r.stage, code: r.code, message: r.message, issues: r.issues, specPatch: r.specPatch, specRef: r.specRef, data: r.data };
  };
  return { sim, engine, run };
}

console.log(`[1] 壊した仕様 ${CASES.length} 件を機械適用して再送する`);
const outcomes: RepairOutcome[] = [];
const sameAsIntended: string[] = [];
for (const c of CASES) {
  const t = await newEnv();
  c.sim?.(t.sim);
  if (c.pre) await c.pre((m, p) => t.engine.call(m, p));
  const base = loadExample(c.base);
  const broken = c.mutate(JSON.parse(JSON.stringify(base)));
  const o = await repairLoop(c.id, t.run, broken, 3);
  outcomes.push(o);
  const good = c.repairable ? o.ok : !o.ok;
  check(`${c.id}: ${c.note}(最初の失敗: ${o.firstStage ?? "なし"} → ${o.ok ? `${o.retries} 回の撃ち直しで成功` : `失敗(${o.detail})`})`, o.firstFailed && (o.firstStage === c.firstStage) && (c.repairable ? o.ok : true), { attempts: o.attempts, detail: o.detail });
  void good;
  // 直った結果が「壊す前の意図」と同じシーンか(参考。直し方が意味を変える件 = 重複の削除・instance の skip・snap は差が出て当然)
  if (o.ok) {
    const t2 = await newEnv();
    if (c.pre) await c.pre((m, p) => t2.engine.call(m, p));
    await t2.run({ spec: base });
    const [a, b] = [await digestScene(t.engine), await digestScene(t2.engine)];
    if (a.hash === b.hash) sameAsIntended.push(c.id);
  }
}

console.log("[2] 集計");
const repairable = CASES.filter((c) => c.repairable);
const okAll = outcomes.filter((o) => o.ok);
const ok1 = outcomes.filter((o) => o.ok && o.retries <= 1);
const rate = (n: number, d: number) => `${n}/${d} = ${((n / d) * 100).toFixed(1)}%`;
console.log(`      全 ${outcomes.length} 件: 撃ち直し 1 回以内に成功 ${rate(ok1.length, outcomes.length)} / 3 回以内に成功 ${rate(okAll.length, outcomes.length)}`);
console.log(`      機械で直せる想定の ${repairable.length} 件: 3 回以内に成功 ${rate(okAll.filter((o) => repairable.some((c) => c.id === o.id)).length, repairable.length)}`);
console.log(`      直った結果が「壊す前の意図」と同じシーン: ${sameAsIntended.length}/${okAll.length}(${sameAsIntended.join(", ")})`);
const unfixable = outcomes.filter((o) => !o.ok).map((o) => `${o.id}(${o.detail})`);
console.log(`      直せなかった: ${unfixable.join(" / ") || "なし"}`);
check(`自己修正率 80% 以上(全 ${outcomes.length} 件・直せないと分かっている件を含む・3 回以内)`, okAll.length / outcomes.length >= 0.8, unfixable);
check("最初から成功した件は 0(全件が実際に壊れている)", outcomes.every((o) => o.firstFailed));
check("直せないと分かっている 2 件(到達不能・仕様の外との重なり)は失敗のまま・理由(fix)を返す", CASES.filter((c) => !c.repairable).every((c) => !outcomes.find((o) => o.id === c.id)!.ok));
{
  const t = await newEnv();
  const c = CASES.find((x) => x.id === "unreachable_wall")!;
  c.sim?.(t.sim);
  const before = (await digestScene(t.engine)).hash;
  const o = await repairLoop(c.id, t.run, c.mutate(loadExample(c.base)), 3);
  const after = (await digestScene(t.engine)).hash;
  const last = o.attempts[o.attempts.length - 1];
  check("到達不能は最終的に verify(E_UNREACHABLE)で落ち、ロールバックでシーンが元と同じ(specPatch は無い = 人か AI の判断が要る)", !o.ok && last.stage === "verify" && last.codes.includes("E_UNREACHABLE") && last.patchOps === 0 && before === after, [o.attempts, before, after]);
}

console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
