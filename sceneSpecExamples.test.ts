// 宣言的シーン生成(M11)の例 5 本(sceneSpec/examples/*.json)の検証。偽エンジン(sceneSim)で:
//   ・検証(validate)が通る・plan・apply・verify(layout errors 0・reachable)・冪等(2 回目は何も変えない)・往復(export → 空のシーンへ適用 → 同じ)
//   ・guide(guides/scene_spec.md)が 5 本の例を載せていて、載っている JSON が examples/ と一致する
// 実行: node sceneSpecExamples.test.ts
import "./testEnv.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockEngine } from "./mockEngine.ts";
import { createSceneSim } from "./sceneSim.ts";
import { EngineClient } from "./engineClient.ts";
import { runSceneSpec, SpecCache } from "./sceneSpec/index.ts";
import { exportScene } from "./sceneSpec/export.ts";
import { digestScene } from "./sceneSpec/digest.ts";
import { validateSpec } from "./sceneSpec/schema.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1400)}` : ""}`); }
}

export const EXAMPLE_NAMES = ["fps_arena", "room", "garden", "showcase", "horror_corridor"];
const load = (n: string) => JSON.parse(fs.readFileSync(path.join(here, "sceneSpec", "examples", `${n}.json`), "utf8"));

async function env() {
  const sim = createSceneSim({ assets: {}, scripts: [], textures: [], prefabs: [] });
  const mock = await startMockEngine({ methods: sim.methods });
  const engine: any = new EngineClient("127.0.0.1", mock.port);
  // check_reachable の代役: navmesh_path が到達可能を返す偽エンジン(sim の navmesh_info / navmesh_path)を、TS ツールを介さず直接呼ぶ
  const callTool = async (name: string, a: Record<string, unknown>) => {
    if (name !== "dx12_check_reachable") return { ok: false, error: `${name} は未対応` };
    const from = await engine.call("get_bounds", { name: a.fromName }), to = await engine.call("get_bounds", { name: a.toName });
    const info = await engine.call("navmesh_info", {});
    if (!(info?.stats?.built)) return { ok: true, data: { reachable: false, reason: "ナビメッシュが焼かれていない。先に dx12_navmesh_build を撃つこと" } };
    const p = await engine.call("navmesh_path", { from: from.center, to: to.center });
    return { ok: true, data: { reachable: (p?.points ?? []).length > 0 && p?.reached !== false } };
  };
  return { sim, engine, deps: { engine, cache: new SpecCache(), callTool } as any };
}

console.log("[1] 例 5 本の検証・plan・apply・冪等・往復(sceneSim)");
for (const n of EXAMPLE_NAMES) {
  const spec = load(n);
  const v = validateSpec(spec, { assets: { models: [], prefabs: [], scripts: [], textures: [] } });
  check(`${n}: 仕様の検証が通る(error 0・warn 0)`, v.issues.length === 0, v.issues.slice(0, 3));
  const t = await env();
  const pl = await runSceneSpec(t.deps, { spec, mode: "plan" });
  check(`${n}: plan が作れる(create > 0・エンジンに書かない)`, pl.ok && (pl.data as any).plan.summary.create > 0 && t.sim.state.calls.every((c: any) => !/^(create_|spawn_|set_|delete_|transaction_)/.test(c.method)), pl.ok ? (pl.data as any).plan.summary : [pl.stage, pl.message]);
  const r = await runSceneSpec(t.deps, { spec });
  const d: any = r.ok ? r.data : null;
  check(`${n}: apply が通る(layout errors 0・verify pass・commit)`, r.ok && d.verify.pass && d.transaction.committed === true, r.ok ? "" : [r.stage, r.message, r.issues.slice(0, 3).map((i) => i.message)]);
  if (r.ok && spec.verify?.reachable) check(`${n}: 到達性の検証が通る`, d.verify.checks.some((c: any) => c.id === "reachable" && c.pass), d.verify.checks);
  if (r.ok) check(`${n}: verify の warning が無い(規約どおりの名前・接地・重なりなし)`, d.verify.warnings.every((w: any) => w.code === "E_LAYOUT_NO_COLLIDER"), d.verify.warnings.map((w: any) => `${w.code}:${w.entity ?? w.path}`));
  const dg1 = await digestScene(t.engine);
  const r2 = await runSceneSpec(t.deps, { spec });
  const dg2 = await digestScene(t.engine);
  check(`${n}: 冪等(再適用は created 0 / updated 0・ダイジェスト不変)`, r2.ok && (r2.data as any).result.created === 0 && (r2.data as any).result.updated === 0 && dg1.hash === dg2.hash, r2.ok ? (r2.data as any).result : [r2.stage, r2.message]);
  const ex = await exportScene(t.engine, { owned: true });
  const t2 = await env();
  const r3 = await runSceneSpec(t2.deps, { spec: ex.spec as any, verify: false });
  const dg3 = await digestScene(t2.engine);
  check(`${n}: 往復(export → 空のシーンへ適用 → ダイジェストが一致)`, r3.ok && dg3.hash === dg1.hash, r3.ok ? [dg1.entities, dg3.entities, [...dg1.byName.keys()].filter((k) => dg1.byName.get(k) !== dg3.byName.get(k)).slice(0, 3)] : [r3.stage, r3.message]);
}

console.log("[2] guide(dx12_guide {topic:'scene_spec'})");
{
  const g = fs.readFileSync(path.join(here, "guides", "scene_spec.md"), "utf8");
  check("guide が存在し、仕様の書き方・よくある失敗・小さな例を含む", /^# /m.test(g) && /よくある失敗/.test(g) && /place/.test(g) && /specPatch/.test(g));
  for (const n of EXAMPLE_NAMES) {
    const spec = load(n);
    const inGuide = g.includes(`\`${n}.json\``) || g.includes(`### ${n}`);
    check(`guide に例 ${n} が載っている`, inGuide);
    // 載っている JSON はテスト側で正規化して examples/ と一致していること(コメントは除く)
    const m = new RegExp("```json\\s*\\n([\\s\\S]*?)```", "g");
    let found = false;
    for (const mm of g.matchAll(m)) { try { const j = JSON.parse(mm[1]); if (j?.name === spec.name && JSON.stringify({ ...j, comment: undefined }) === JSON.stringify({ ...spec, comment: undefined })) found = true; } catch { /* 例以外のブロック */ } }
    check(`guide の ${n} の JSON が examples/${n}.json と一致`, found);
  }
  check("guide の長さ(AI が 1 回で読める。20 KB 以内)", Buffer.byteLength(g) <= 20 * 1024, Buffer.byteLength(g));
}

console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
