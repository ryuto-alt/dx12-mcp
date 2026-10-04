// 宣言的シーン生成(M11)の実エンジン検証スクリプト(手動。npm test には入れない)。
//   使い方: 専用インスタンスを engine_instance.ps1 で起動してから
//     node scripts/sceneSpecReal.ts --port 8829 [--only bounds,idem,rollback,verify,prune,roundtrip,speed,id,script,settings,reach,repair]
//   ★必ず使い捨てプロジェクトで(シーンを new_scene で作り直す。実プロジェクトに繋がない)。仮想入力・前面化は一切使わない(MCP のメソッドだけ)。
//   プロジェクトの assets に models/cube1m.glb と components/Spinner.lua が要る(README の手順)。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const args = process.argv.slice(2);
const argVal = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = argVal("port", process.env.DX12_MCP_PORT ?? "8829")!;
const only = (argVal("only", "") ?? "").split(",").filter(Boolean);
process.env.DX12_MCP_PORT = port;
process.env.DX12_MCP_PORT_FILE = path.join(os.tmpdir(), `sceneSpecReal-none-${process.pid}.port`);
process.env.DX12_MCP_SURFACE = process.env.DX12_MCP_SURFACE ?? "full";
process.env.DX12_FLEET_DISABLE = "1";

await import("../toolset/all.ts");
const { TOOL_REGISTRY } = await import("../toolRuntime.ts");
const { engine } = await import("../toolset/core.ts");
const { digestScene } = await import("../sceneSpec/digest.ts");
const { exportScene } = await import("../sceneSpec/export.ts");
const { guardApproval } = await import("../guardCtx.ts");
const { runSceneSpec, SpecCache } = await import("../sceneSpec/index.ts");

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1400)}` : ""}`); }
}
const near = (a: number, b: number, eps = 2e-3) => Math.abs(a - b) <= eps;
const nearV = (a: number[] | undefined, b: number[], eps = 2e-3) => !!a && a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const want = (k: string) => only.length === 0 || only.includes(k);

async function tool(name: string, a: Record<string, unknown>, approved = false): Promise<{ ok: boolean; data: any; body: any }> {
  const e = TOOL_REGISTRY.get(name)!;
  const run = () => e.invoke(a);
  const res: any = approved ? await guardApproval.run({ approved: true, via: "test" }, run) : await run();
  const text = res.content?.[res.content.length - 1]?.text ?? "";
  let d: any = null; try { d = JSON.parse(text); } catch { /* 文字列 */ }
  return { ok: !res.isError, data: res.isError ? null : d, body: res.isError ? d : null };
}
const apply = (a: Record<string, unknown>, approved = false) => tool("dx12_apply_scene_spec", a, approved);
const ent = async (name: string) => engine.call("get_entity", { name });

async function reset() {
  await engine.call("new_scene", {});
  await sleep(400);
  const l = await engine.call("list_entities", {});
  for (const e of l.entities) if (e.name !== "Grid") await engine.call("delete_entity", { entity: e.entityId }).catch(() => { /* 既に消えた */ });
  await sleep(100);
}

const ping = await engine.call("ping", {});
console.log(`エンジン: ${ping.engineVersion} pid=${ping.pid} project=${ping.baseDir} mode=${ping.mode} manifest=${ping.manifestHash}`);
if (!/scratchpad|Temp|temp|agent-instances/i.test(String(ping.baseDir))) { console.log("使い捨てプロジェクトではなさそう。中止する"); process.exit(3); }

const ARENA: any = {
  version: 1, name: "arena",
  entities: [
    { name: "LVL_Floor", kind: "plane", size: [20, 20], group: "LVL", at: [0, 0, 0], color: "#444444" },
    { name: "LVL_Wall_N", kind: "box", size: [20, 3, 0.4], group: "LVL", at: [0, null, 10], place: { on: "LVL_Floor" }, components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
    { name: "ENV_Pillar", kind: "box", size: [0.6, 3, 0.6], group: "ENV", pattern: { type: "ring", count: 6, radius: 4, origin: [0, 0, 0] }, place: { on: "LVL_Floor" }, tags: ["pillar"], components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
    { name: "LGT_Sun", kind: "light", light: "directional", group: "LGT", rotation: [-50, 30, 0], components: { directionalLight: { intensity: 1.5 } } },
    { name: "GP_Player", kind: "fps_player", group: "GP", at: [0, null, -8] },
    { name: "ENV_Crate", kind: "model", model: "models/cube1m.glb", group: "ENV", at: [3, null, 3], place: { ground: true }, script: { path: "components/Spinner.lua", props: { speed: 45 } }, components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
  ],
};

// ── 幾何: 解析の AABB が get_bounds と一致(親子・回転・モデル・平面・球) ──
if (want("bounds")) {
  console.log("[bounds] 解析の AABB(仕様の展開)と実エンジンの get_bounds");
  await reset();
  const spec: any = { version: 1, name: "bnd", entities: [
    { name: "LVL_Floor", kind: "plane", size: [30, 30], group: "LVL", at: [0, 0, 0], components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [15, 0.5, 15], offset: [0, -0.5, 0] } } },
    { name: "GP_Pivot", kind: "empty", group: "GP", at: [10, 0, 5], rotation: [0, 90, 0], scale: 2 },
    { name: "LVL_Child", kind: "box", size: [1, 2, 3], parent: "GP_Pivot", at: [1, 1, 0], rotation: [0, 30, 0] },
    { name: "ENV_Model", kind: "model", model: "models/cube1m.glb", group: "ENV", at: [-5, null, 2], rotation: [10, 20, 30], scale: [1, 2, 3], place: { ground: true } },
    { name: "ENV_Ball", kind: "sphere", size: 2, group: "ENV", place: { relativeTo: "ENV_Model", side: "right", gap: 0.5 } },
    { name: "ENV_Crate", kind: "box", size: 1, group: "ENV", place: { on: "LVL_Child" } },
  ] };
  const rr = await runSceneSpec({ engine: engine as any, cache: new SpecCache() }, { spec, returnResolved: true, verify: false });
  check("適用できる", rr.ok, rr.ok ? "" : [rr.stage, rr.message]);
  const resolved: any[] = (rr as any).data?.resolved ?? [];
  for (const q of resolved) {
    if (q.kind === "empty") continue;
    const b = await engine.call("get_bounds", { name: q.name });
    check(`${q.name}: 解析の AABB = get_bounds(min/max とも 2mm 以内)`, nearV(b.min, q.worldBounds.min) && nearV(b.max, q.worldBounds.max), { analytic: q.worldBounds, engine: { min: b.min, max: b.max } });
  }
  const ch = await ent("LVL_Child");
  check("親付きの子の transform はローカル値(仕様の at そのまま)", nearV(ch.transform.position, [1, 1, 0]) && nearV(ch.transform.rotation, [0, 30, 0]), ch.transform);
}

// ── 適用 / 冪等 / ダイジェスト ──
if (want("idem")) {
  console.log("[idem] 適用・冪等・所有者の印・タグ");
  await reset();
  const t0 = Date.now();
  const r = await apply({ spec: ARENA });
  const ms = Date.now() - t0;
  check("適用: 成功・created 12・layout errors 0・commit", r.ok && r.data.result.created === 12 && r.data.verify.pass === true && r.data.transaction.committed === true, r.body ?? r.data?.result);
  console.log(`      apply ${ms} ms(エンジン呼び出し ${r.data?.timing?.engineCalls} 回)`);
  const d1 = await digestScene(engine);
  const p = await ent("ENV_Pillar_03");
  check("タグ(C++ の tags 配列対応)と所有者の印・安定 ID が入る", p.tags?.[0] === "pillar" && p.data?.__spec?.v === "arena" && p.data?.__id?.v === "ENV_Pillar_03", p);
  const c = await ent("ENV_Crate");
  check("Lua スクリプト + props(set_lua_property)が入る", c.luaScript?.scriptPath === "components/Spinner.lua", c.luaScript);
  const r2 = await apply({ spec: ARENA });
  const d2 = await digestScene(engine);
  check("冪等: 再適用は created 0 / updated 0 / unchanged 12・シーンのダイジェスト不変", r2.ok && r2.data.result.created === 0 && r2.data.result.updated === 0 && r2.data.result.unchanged === 12 && d1.hash === d2.hash, [r2.data?.result, d1.hash, d2.hash]);
  const spec2 = JSON.parse(JSON.stringify(ARENA)); spec2.entities[3].components.directionalLight.intensity = 2.5; spec2.entities[0].color = "#ff0000";
  const pl = await apply({ spec: spec2, mode: "plan" });
  check("1 行直すと update 2 体・unchanged 10", pl.ok && pl.data.plan.summary.update === 2 && pl.data.plan.summary.unchanged === 10, pl.data?.plan?.summary);
  const d3 = await digestScene(engine);
  check("plan はシーンを変えない(ダイジェスト不変)", d3.hash === d2.hash);
  const r3 = await apply({ spec: spec2 });
  const sun = await ent("LGT_Sun");
  check("update を適用: 太陽の intensity 2.5", r3.ok && near(sun.directionalLight.intensity, 2.5), r3.body);
}

// ── ロールバック ──
if (want("rollback")) {
  console.log("[rollback] 途中失敗で全体が戻る(実エンジン)");
  await reset();
  await apply({ spec: { version: 1, name: "pre", entities: [{ name: "GP_Keep", kind: "box", at: [7, 0.5, 7] }] }, verify: false });
  const before = await digestScene(engine);
  // 壊れたモデル(glb ではないファイル)は spawn_model が実際に失敗する。同じ波で他のエンティティは作られている = 本当の「途中失敗」
  const brokenPath = path.join(String(ping.baseDir), "assets", "models", "broken.glb");
  fs.writeFileSync(brokenPath, "this is not a glb");
  await sleep(200);
  const bad: any = { version: 1, name: "boom", entities: [{ name: "LVL_A", kind: "box", at: [0, 0.5, 0] }, { name: "LVL_B", kind: "box", at: [3, 0.5, 0] }, { name: "LVL_Broken", kind: "model", model: "models/broken.glb", at: [6, 0.5, 0] }, { name: "LVL_C", kind: "box", at: [9, 0.5, 0], color: "#ff0000" }] };
  const r = await apply({ spec: bad });
  try { fs.unlinkSync(brokenPath); } catch { /* 無くてよい */ }
  const after = await digestScene(engine);
  check("途中失敗 → stage:apply・rolledBack・ダイジェストが元と一致(変更ゼロ)", !r.ok && r.body?.details?.stage === "apply" && r.body?.details?.transaction?.rolledBack === true && before.hash === after.hash, [r.body?.details?.stage, r.body?.details?.transaction, before.hash, after.hash]);
  const st = await engine.call("transaction_status", {});
  check("トランザクションは閉じている", !st?.open, st);
}

// ── 検証失敗(DUPLICATE)→ ロールバック → specPatch で通る ──
if (want("verify")) {
  console.log("[verify] 検証失敗 → ロールバック → specPatch を撃ち直す");
  await reset();
  const bad: any = { version: 1, name: "bad", entities: [{ name: "LVL_Floor", kind: "plane", size: [10, 10], group: "LVL", components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [5, 0.5, 5], offset: [0, -0.5, 0] } } }, { name: "LVL_A", kind: "box", size: 1, group: "LVL", at: [0, 0.5, 0] }, { name: "LVL_B", kind: "box", size: 1, group: "LVL", at: [0, 0.5, 0] }] };
  const before = await digestScene(engine);
  const r = await apply({ spec: bad });
  const after = await digestScene(engine);
  check("同位置の 2 個 → 検証(layout)で DUPLICATE → ロールバック(ダイジェスト不変)", !r.ok && r.body?.details?.stage === "verify" && before.hash === after.hash, [r.body?.details?.stage, r.body?.message]);
  const fx = r.body?.fix?.[0];
  check("fix[0] は {specRef, patch} の撃ち直し", fx?.tool === "dx12_apply_scene_spec" && typeof fx.args.specRef === "string" && Array.isArray(fx.args.patch) && fx.args.patch.length >= 1, fx);
  const r2 = await apply(fx.args);
  const hasA = !!(await engine.call("find_entity", { name: "LVL_A" })), hasB = !!(await engine.call("find_entity", { name: "LVL_B" }));
  check("specPatch を撃ち直すと通る(重なった 2 個のうち片方が仕様から消え、もう片方は残る)", r2.ok && r2.data.verify.pass && hasA !== hasB, [r2.body, hasA, hasB]);
  // 浮き → warn → snap
  await reset();
  const fl: any = { version: 1, name: "fl", entities: [{ name: "LVL_Floor", kind: "plane", size: [10, 10], group: "LVL" }, { name: "ENV_Box", kind: "box", size: 1, group: "ENV", at: [0, 3, 0] }] };
  const f1 = await apply({ spec: fl });
  check("浮いた箱は warning(FLOATING)で適用は通り、place.snap の specPatch が付く", f1.ok && f1.data.verify.warnings.some((w: any) => w.code === "E_LAYOUT_FLOATING" && w.specPatch?.[0]?.value?.snap === true), f1.data?.verify?.warnings);
  const f2 = await apply({ specRef: f1.data.specRef, patch: f1.data.verify.specPatch });
  const bx = await ent("ENV_Box");
  check("その specPatch で snap_to_ground(実エンジンの精密レイキャスト)が掛かり、床の上(y=0.5)に載る", f2.ok && near(bx.transform.position[1], 0.5, 5e-3), bx.transform.position);
  const f3 = await apply({ specRef: f2.data.specRef });
  check("snap 後の再適用は冪等(update 0)", f3.ok && f3.data.result.updated === 0 && f3.data.result.created === 0, f3.data?.result);
}

// ── prune / 所有者 ──
if (want("prune")) {
  console.log("[prune] 所有者の印(手で置いた物・別の仕様は消さない)+ 承認");
  await reset();
  await apply({ spec: ARENA, verify: false });
  await engine.call("create_entity", { type: "box", name: "HandMade", position: [50, 0.5, 50] });
  const s3 = JSON.parse(JSON.stringify(ARENA)); s3.entities.splice(1, 1); s3.entities[1].pattern.count = 4;
  const guard = await apply({ spec: s3, prune: true });
  check("prune:true の適用は承認なしだと E_GUARDED(fix に plan と承認つきの実行)", !guard.ok && guard.body?.error_code === "E_GUARDED" && guard.body.fix?.length === 2, guard.body);
  const pl = await apply({ spec: s3, prune: true, mode: "plan" });
  check("plan は承認なしで撃てる: delete 3(壁 + 柱 2)・HandMade は対象外", pl.ok && pl.data.plan.summary.delete === 3 && !pl.data.plan.delete.some((x: any) => x.name === "HandMade"), pl.data?.plan?.delete);
  const ap = await apply({ spec: s3, prune: true }, true);
  const names = (await engine.call("list_entities", {})).entities.map((e: any) => e.name);
  check("承認つきの適用: 壁・柱 05/06 が消え、HandMade は残る", ap.ok && !names.includes("LVL_Wall_N") && !names.includes("ENV_Pillar_05") && names.includes("HandMade") && names.includes("ENV_Pillar_04"), [ap.body, names]);
  const undo = await engine.call("undo", {});
  const names2 = (await engine.call("list_entities", {})).entities.map((e: any) => e.name);
  check("Undo 1 回で prune の削除も戻る(1 トランザクション)", names2.includes("LVL_Wall_N") && names2.includes("ENV_Pillar_05"), [undo, names2]);
}

// ── 往復 ──
if (want("roundtrip")) {
  console.log("[roundtrip] シーン → 仕様 → 適用で同じシーン");
  await reset();
  await apply({ spec: ARENA, verify: false });
  const dA = await digestScene(engine);
  const ex = await exportScene(engine as any, { owned: true });
  check("export: 12 体・仕様名 arena・group / script props が復元される", ex.spec.name === "arena" && ex.entityCount === 12 && ex.spec.entities!.find((e: any) => e.name === "ENV_Crate")?.script?.props?.speed === 45, [ex.spec.name, ex.entityCount]);
  await reset();
  const r = await apply({ spec: ex.spec, verify: false });
  const dB = await digestScene(engine);
  check("往復: 書き出した仕様を空のシーンへ適用 → ダイジェスト一致", r.ok && dA.hash === dB.hash, [r.body, dA.hash, dB.hash, [...dA.byName.keys()].filter((k) => dA.byName.get(k) !== dB.byName.get(k))]);
  const r2 = await apply({ spec: ex.spec, verify: false });
  check("往復した仕様の再適用も冪等", r2.ok && r2.data.result.created === 0 && r2.data.result.updated === 0, r2.data?.result);
}

// ── 速度 ──
if (want("speed")) {
  console.log("[speed] 200 体の適用と、create_entity + set_transform を 1 体ずつ 200 回");
  await reset();
  const N = 200;
  const spec: any = { version: 1, name: "speed", entities: [{ name: "LVL_Floor", kind: "plane", size: [80, 80], group: "LVL" }, { name: "ENV_Box", kind: "box", size: [0.5, 0.5, 0.5], group: "ENV", pattern: { type: "grid", count: [20, 10], spacing: [2, 2], origin: [0, 0, 0] }, place: { on: "LVL_Floor" }, color: "#88aa88" }] };
  const t0 = Date.now();
  const r = await apply({ spec, verify: false });
  const tApply = Date.now() - t0;
  check(`仕様の適用(200 体 + 床): ${tApply} ms`, r.ok && r.data.result.created === N + 1, r.body);
  await reset();
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    const c = await engine.call("create_entity", { type: "box", name: `Seq_${i}`, position: [i * 2, 0.25, 0] });
    await engine.call("set_transform", { entity: c.entityId, scale: [0.5, 0.5, 0.5] });
  }
  const tSeq = Date.now() - t1;
  console.log(`      逐次(create_entity + set_transform × ${N}): ${tSeq} ms / 仕様: ${tApply} ms = ${(tSeq / tApply).toFixed(1)} 倍`);
  check("仕様の適用は 1 体ずつの逐次より 5 倍以上速い", tSeq / tApply >= 5, { tSeq, tApply });
  const tPlan0 = Date.now();
  const pl = await apply({ spec, mode: "plan" });
  console.log(`      plan(読み取り + 解決): ${Date.now() - tPlan0} ms`);
  void pl;
}

// ── 改名 ──
if (want("id")) {
  console.log("[id] 安定 ID: name を変えても複製にならず rename_entity で追従");
  await reset();
  const s: any = { version: 1, name: "ren", entities: [{ name: "Floor", id: "floor", kind: "plane", size: [10, 10], group: "LVL" }, { name: "Crate", id: "crate", kind: "box", size: 1, group: "ENV", place: { on: "Floor" } }] };
  await apply({ spec: s, verify: false });
  const g0 = (await ent("Crate")).guid;
  const s2 = JSON.parse(JSON.stringify(s)); s2.entities[0].name = "LVL_Floor"; s2.entities[1].name = "ENV_Crate"; s2.entities[1].place.on = "LVL_Floor";
  const pl = await apply({ spec: s2, mode: "plan" });
  check("plan: 作成 0・更新 2(名前が変わった)・削除 0・孤児 0", pl.ok && pl.data.plan.summary.create === 0 && pl.data.plan.summary.update === 2 && pl.data.plan.orphans.length === 0, pl.data?.plan);
  const r = await apply({ spec: s2 });
  const c = await engine.call("find_entity", { name: "ENV_Crate" });
  check("適用: 同じ実体(guid 不変)が改名される・旧名は残らない", r.ok && !!c && (await ent("ENV_Crate")).guid === g0 && (await engine.call("find_entity", { name: "Crate" })) === null, r.body);
}

// ── 設定(lighting)・ロールバックでは戻らない設定は検証後に撃つ ──
if (want("settings")) {
  console.log("[settings] lighting preset・navmesh は検証が通った後に適用");
  await reset();
  const s: any = { version: 1, name: "st", lighting: { preset: "horror" }, navmesh: { build: true }, entities: [{ name: "LVL_Floor", kind: "plane", size: [20, 20], group: "LVL" }, { name: "LGT_Sun", kind: "light", light: "directional", group: "LGT" }] };
  const before = await engine.call("get_post_process", {});
  const bad: any = JSON.parse(JSON.stringify(s)); bad.entities.push({ name: "LVL_Dup", kind: "plane", size: [20, 20], group: "LVL" });
  const rb = await apply({ spec: bad });
  const mid = await engine.call("get_post_process", {});
  check("検証失敗(床の重なり)ではポストの設定に触れない", !rb.ok && before.vignetteOn === mid.vignetteOn && before.exposure === mid.exposure, [rb.body?.message, before.vignetteOn, mid.vignetteOn]);
  const r = await apply({ spec: s });
  const after = await engine.call("get_post_process", {});
  check("成功時は lighting.preset(horror = ビネット ON)と navmesh が適用される", r.ok && after.vignetteOn === true && r.data.settings?.length === 2 && r.data.settings.every((x: any) => x.ok), [r.body, r.data?.settings]);
  const ni = await engine.call("navmesh_info", {});
  check("navmesh が焼かれている", ni?.stats?.built === true && (ni.stats.polyCount ?? 0) > 0, ni?.stats);
}

// ── 到達性 ──
if (want("reach")) {
  console.log("[reach] verify.reachable(ナビメッシュ + check_reachable)");
  await reset();
  const s: any = { version: 1, name: "rc", navmesh: { build: true }, verify: { reachable: { from: "GP_Player", to: "GP_Goal" } }, entities: [
    { name: "LVL_Floor", kind: "box", size: [20, 1, 20], group: "LVL", at: [0, -0.5, 0], components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
    { name: "GP_Player", kind: "fps_player", group: "GP", at: [-8, null, 0] },
    { name: "GP_Goal", kind: "box", size: 1, group: "GP", at: [8, 0.5, 0], color: "#33ff66", components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
  ] };
  const r = await apply({ spec: s });
  check("到達できる配置は verify.reachable が通る", r.ok && r.data.verify.checks.some((c: any) => c.id === "reachable" && c.pass), r.body ?? r.data?.verify);
  const wall = JSON.parse(JSON.stringify(s));
  wall.entities.push({ name: "LVL_Wall", kind: "box", size: [1, 5, 30], group: "LVL", at: [0, 2.5, 0], components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } });
  const rw = await apply({ spec: wall });
  check("壁で塞ぐと到達不能 → ロールバック(壁は作られない)", !rw.ok && rw.body?.details?.stage === "verify" && (await engine.call("find_entity", { name: "LVL_Wall" })) === null, rw.body?.message);
}

// ── ルック(TS ツール dx12_look_apply)・設定の優先順位 ──
if (want("look")) {
  console.log("[look] spec.look(dx12_look_apply の TS ツール経由)+ 太陽の明示値の優先");
  await reset();
  const s: any = { version: 1, name: "lk", lighting: { preset: "day" }, look: { preset: "blue_hour", strength: 0.8 }, entities: [{ name: "LVL_Floor", kind: "box", size: [10, 0.4, 10], group: "LVL", at: [0, -0.2, 0] }, { name: "LGT_Sun", kind: "light", light: "directional", group: "LGT", rotation: [-35, 20, 0], components: { directionalLight: { intensity: 2.2 } } }] };
  const r = await apply({ spec: s });
  check("lighting + look + 明示した太陽を同時に指定できる", r.ok && r.data.settings?.every((x: any) => x.ok), r.body ?? r.data?.settings);
  const sun = await ent("LGT_Sun");
  check("太陽の明示値(intensity 2.2)が preset / look より優先される", near(sun.directionalLight.intensity, 2.2, 5e-3), sun.directionalLight);
  const d1 = await digestScene(engine);
  const r2 = await apply({ spec: s });
  const d2 = await digestScene(engine);
  check("再適用しても冪等(created 0 / updated 0・シーンのダイジェスト不変)", r2.ok && r2.data.result.created === 0 && r2.data.result.updated === 0 && d1.hash === d2.hash, [r2.data?.result, d1.hash, d2.hash]);
  const bad = JSON.parse(JSON.stringify(s)); bad.look.preset = "blue_hor";
  const rb = await apply({ spec: bad });
  check("look.preset の打ち間違いは didYouMean(blue_hour)+ specPatch", !rb.ok && rb.body?.issues?.[0]?.didYouMean?.[0] === "blue_hour" && rb.body.issues[0].specPatch?.[0]?.value === "blue_hour", rb.body?.issues?.[0]);
}

// ── ジョブ(async:true)と大規模 ──
if (want("job") || want("scale")) {
  console.log("[job/scale] 大規模な仕様をジョブで(進捗・上限・1 トランザクション)");
  await reset();
  const N = Number(argVal("n", "1500"));
  const spec: any = { version: 1, name: "big", entities: [{ name: "LVL_Floor", kind: "box", size: [200, 1, 200], group: "LVL", at: [0, -0.5, 0] }, { name: "ENV_Box", kind: "box", size: [0.8, 0.8, 0.8], group: "ENV", pattern: { type: "grid", count: [Math.ceil(N / 30), 30], spacing: [2.5, 2.5], origin: [0, 0, 0] }, place: { on: "LVL_Floor" }, color: "#88aa88" }] };
  const over: any = JSON.parse(JSON.stringify(spec)); over.entities[1].pattern.count = [100, 51];
  const ro = await apply({ spec: over, mode: "plan" });
  check("5,001 体は E_OUT_OF_RANGE(E_SPEC_LIMIT)+ ジョブの案内", !ro.ok && ro.body?.error_code === "E_OUT_OF_RANGE" && ro.body.issues?.[0]?.code === "E_SPEC_LIMIT", ro.body?.error_code);
  const t0 = Date.now();
  const j = await apply({ spec, async: true, verify: { layout: "off", naming: "off" } });
  check("async:true は即座に job id を返す", j.ok && typeof j.data?.job?.id === "string", j.body);
  const progress: string[] = [];
  let st: any = null;
  for (let i = 0; i < 300; i++) {
    const s2 = await tool("dx12_job_status", { id: j.data.job.id, waitSec: 2 });
    st = s2.data;
    const p = `${st?.progress?.phase}:${st?.progress?.pct}`;
    if (progress[progress.length - 1] !== p) progress.push(p);
    if (["succeeded", "failed", "cancelled", "timeout"].includes(st?.state)) break;
  }
  console.log(`      ジョブ ${N + 1} 体: ${Date.now() - t0} ms・進捗 ${progress.join(" → ")}`);
  const lg = await tool("dx12_job_logs", { id: j.data.job.id, tail: 100 });
  const phases = new Set((lg.data?.lines ?? []).map((l: string) => /] ([^:]+):/.exec(l)?.[1]).filter(Boolean));
  console.log(`      ジョブのログに残った段階: ${[...phases].join(" / ")}`);
  check("ジョブが succeeded・ログに複数の段階(読み取り・検証・配置・計画・適用…)が残る", st?.state === "succeeded" && phases.size >= 5, [st?.state, [...phases]]);
  const cnt = (await engine.call("list_entities", {})).count;
  check(`シーンのエンティティ数が期待どおり(${N + 1} + Grid + グループ根 2)`, cnt >= N + 1, cnt);
  const t1 = Date.now();
  const again = await apply({ spec, verify: { layout: "off", naming: "off" } });
  console.log(`      同じ仕様の再適用(冪等・読み取りと差分): ${Date.now() - t1} ms`);
  check("大規模でも再適用は unchanged(created 0 / updated 0)", again.ok && again.data.result.created === 0 && again.data.result.updated === 0, again.data?.result);
  await reset();
}

// ── 自己修正ループ(壊した仕様を実エンジンで機械適用して再送)──
if (want("repair")) {
  console.log("[repair] 壊した仕様を実エンジンで撃ち、specPatch を撃ち直す(sceneSpecCorpus.ts の real:true)");
  const { CASES, loadExample, repairLoop } = await import("../sceneSpecCorpus.ts");
  const list = CASES.filter((c) => c.real);
  const results: any[] = [];
  for (const c of list) {
    await reset();
    if (c.pre) await c.pre((m, p) => engine.call(m, p));
    const run = async (input: any) => {
      const r = await apply(input);
      if (r.ok) return { ok: true, ...r.data };
      return { ok: false, stage: r.body?.details?.stage, message: r.body?.error ?? r.body?.message, issues: r.body?.issues ?? [], specPatch: r.body?.details?.specPatch ?? [], specRef: r.body?.details?.specRef, body: r.body };
    };
    const broken = c.mutate(JSON.parse(JSON.stringify(loadExample(c.base))));
    const o = await repairLoop(c.id, run, broken, 3);
    results.push({ c, o });
    check(`${c.id}: ${c.note} → ${o.ok ? `${o.retries} 回の撃ち直しで成功` : `失敗(${o.detail})`}`, o.firstFailed && o.firstStage === c.firstStage && (c.repairable ? o.ok : !o.ok), { attempts: o.attempts, detail: o.detail });
  }
  const ok = results.filter((x) => x.o.ok).length, ok1 = results.filter((x) => x.o.ok && x.o.retries <= 1).length;
  const rep = results.filter((x) => x.c.repairable);
  console.log(`      実エンジン ${results.length} 件: 撃ち直し 1 回以内 ${ok1}/${results.length} / 3 回以内 ${ok}/${results.length} = ${((ok / results.length) * 100).toFixed(1)}%(直せると期待した ${rep.length} 件では ${rep.filter((x) => x.o.ok).length}/${rep.length})`);
  check(`実エンジンの自己修正率 80% 以上(${results.length} 件・直せないと分かっている件を含む)`, ok / results.length >= 0.8);
  await reset();
}

console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
