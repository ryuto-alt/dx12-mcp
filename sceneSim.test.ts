// sceneSim.ts(シーン状態を持つ偽エンジン)の単体テスト。実エンジンのプローブ値(会話の実測)を写せているかを、TCP 越しの pipelined 呼び出しで確認する。
//   [1] 生成 / 同名の連番 / get_entity の形 / list_entities / get_hierarchy
//   [2] get_bounds(回転 + スケール + 親子)/ モデル / 平面 / 非メッシュ
//   [3] set_component(data のマージ・tags の配列・空 data の拒否・既定値とのマージ・未知の component)
//   [4] set_parent(ローカル解釈・循環・無効 id)/ delete_entity(子ごと)/ look_at / snap_to_ground
//   [5] validate_layout(DUPLICATE / OVERLAP / FLOATING / BURIED)と fix:"safe"
//   [6] トランザクション(rollback で hash 一致・設定は戻らない・二重 begin)
//   [7] 設定系(lighting preset / set_sun / scene settings / navmesh)
//   [8] failNext / 呼び出しの記録 / Playing 中の拒否
// 実行: node sceneSim.test.ts
import "./testEnv.ts";
import net from "node:net";
import { startMockEngine } from "./mockEngine.ts";
import { createSceneSim } from "./sceneSim.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
const nearV = (a: number[] | undefined, b: number[], eps = 1e-3) => !!a && a.length === b.length && a.every((v, i) => near(v, b[i], eps));

const sim = createSceneSim({
  assets: { "models/cube1m.glb": { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }, "models/tall.glb": { min: [-0.5, 0, -0.5], max: [0.5, 3, 0.5] } },
  scripts: ["components/Spin.lua"], textures: ["textures/wood.png"], prefabs: ["prefabs/crate.prefab"],
});
const mock = await startMockEngine({ methods: sim.methods });

// 最小のクライアント: id 別に pipelined で送る
const sock = net.connect(mock.port, "127.0.0.1");
let buf = ""; let nextId = 1; const pending = new Map<number, (m: any) => void>();
sock.setEncoding("utf8");
sock.on("data", (d: string) => {
  buf += d; let i: number;
  while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); pending.get(m.id)?.(m); pending.delete(m.id); } catch { /* 無視 */ } }
});
await new Promise<void>((r) => sock.once("connect", () => r()));
const raw = (method: string, params: any = {}) => new Promise<any>((res) => { const id = nextId++; pending.set(id, res); sock.write(JSON.stringify({ id, method, params }) + "\n"); });
const call = async (method: string, params: any = {}) => { const m = await raw(method, params); if (!m.ok) throw Object.assign(new Error(m.error), { resp: m }); return m.result; };
const fail = async (method: string, params: any = {}) => { const m = await raw(method, params); return m.ok ? null : m; };
const par = (calls: [string, any?][]) => Promise.all(calls.map(([m, p]) => raw(m, p ?? {})));

try {
  // ── [1] ──
  console.log("[1] 生成・同名の連番・読み取り");
  {
    const l0 = await call("list_entities", { verbose: true });
    check("初期状態は内部の Grid だけ(gridPlane 付き)", l0.count === 1 && l0.entities[0].name === "Grid" && l0.entities[0].componentTypes.includes("gridPlane"), l0);
    const rs = await par([["create_entity", { type: "box", name: "A", position: [1, 2, 3] }], ["create_entity", { type: "sphere", name: "B" }], ["create_entity", { type: "plane", name: "P" }],
      ["spawn_model", { path: "models/cube1m.glb", name: "M" }], ["create_entity", { type: "light_point", name: "L" }], ["create_entity", { type: "camera", name: "C" }], ["create_entity", { type: "empty", name: "E" }]]);
    check("7 体を pipelined で作れた(全部 ok・name が要求どおり)", rs.every((r) => r.ok) && rs.map((r) => r.result.name).join() === "A,B,P,M,L,C,E", rs);
    const dup = await call("create_entity", { type: "box", name: "A" });
    check("同名は連番 'A (1)' になる", dup.name === "A (1)", dup);
    const a = await call("get_entity", { name: "A" });
    check("get_entity(box): componentTypes / primitive / transform / guid", a.componentTypes.join() === "transform,meshRenderer" && a.primitive === "box" && nearV(a.transform.position, [1, 2, 3]) && !!a.guid && a.color === undefined, a);
    const b = await call("get_entity", { name: "B" }), p = await call("get_entity", { name: "P" });
    check("primitiveSize: sphere 0.5 / plane 50", b.primitiveSize === 0.5 && p.primitiveSize === 50);
    const m = await call("get_entity", { name: "M" });
    check("get_entity(model): meshRenderer.modelPath と既定 material {metallic:1,roughness:1}", m.meshRenderer?.modelPath === "models/cube1m.glb" && m.material?.metallic === 1 && m.material?.roughness === 1, m);
    const l = await call("get_entity", { name: "L" }), c = await call("get_entity", { name: "C" });
    check("point light の既定値", l.pointLight?.intensity === 1 && l.pointLight?.range === 10 && l.pointLight?.castShadows === false, l);
    check("camera は isActive:true で作られる", c.camera?.isActive === true && c.camera?.fovDegrees === 60, c);
    const sun = await call("create_entity", { type: "light_directional", name: "Sun" });
    const s = await call("get_entity", { entity: sun.entityId });
    check("directional light: rotation[-30,0,0] / entityId 指定でも引ける", nearV(s.transform.rotation, [-30, 0, 0]) && s.directionalLight?.ambient === 0.25, s);
    const e404 = await fail("get_entity", { name: "Nope" });
    check("無い名前は code 1 + E_NOT_FOUND_ENTITY + didYouMean", e404?.error_code === 1 && e404.error_name === "E_NOT_FOUND_ENTITY" && Array.isArray(e404.error_did_you_mean), e404);
    const e404b = await fail("get_entity", { name: "A(1)" });
    check("近い名前が didYouMean に入る", (e404b?.error_did_you_mean ?? []).includes("A (1)") || (e404b?.error_did_you_mean ?? []).includes("A"), e404b);
    const cf = await fail("create_entity", { type: "sphre" });
    check("未知の type は code 2 + E_BAD_ENUM + didYouMean", cf?.error_code === 2 && cf.error_name === "E_BAD_ENUM" && cf.error_did_you_mean?.includes("sphere"), cf);
    const f = await call("find_entity", { name: "Sun" });
    check("find_entity は {entityId,name} / 無ければ null", f?.name === "Sun" && (await call("find_entity", { name: "zzz" })) === null);
    const lv = await call("list_entities", { verbose: false, name_prefix: "A" });
    check("name_prefix / verbose:false(componentTypes 無し)", lv.count === 2 && lv.entities[0].componentTypes === undefined, lv);
    const ui = await call("create_entity", { type: "ui_text", name: "Hud" });
    const uh = await call("get_hierarchy");
    const canvas = uh.roots.find((r: any) => r.name === "UICanvas");
    check("ui_text は Canvas を自動生成してその子になる", ui.name === "Hud" && canvas?.children?.[0]?.name === "Hud", uh);
    const ap = await call("spawn_prefab", { path: "prefabs/crate.prefab", name: "Crate", position: [5, 0, 5] });
    check("spawn_prefab: root + body の 2 体", ap.entityIds.length === 2 && ap.rootEntityId === ap.entityId, ap);
    const nm = await fail("spawn_model", { path: "models/cube1.glb" });
    check("存在しないモデルは E_NOT_FOUND_ASSET + didYouMean", nm?.error_name === "E_NOT_FOUND_ASSET" && nm.error_did_you_mean?.includes("models/cube1m.glb"), nm);
    const la = await call("list_assets", { type: "model" });
    check("list_assets{type:'model'}", la.length === 2 && la.every((x: any) => x.type === "model"), la);
    const ai = await call("asset_info", { path: "models/tall.glb" });
    check("asset_info: aabbMin/aabbMax", nearV(ai.aabbMax, [0.5, 3, 0.5]) && nearV(ai.aabbMin, [-0.5, 0, -0.5]), ai);
  }

  // ── [2] ──
  console.log("[2] get_bounds");
  {
    await call("set_transform", { name: "A", rotation: [0, 45, 0], scale: [2, 3, 4] });
    const [ba, bb, bp, bm, bl, be] = (await par([["get_bounds", { name: "A" }], ["get_bounds", { name: "B" }], ["get_bounds", { name: "P" }], ["get_bounds", { name: "M" }], ["get_bounds", { name: "L" }], ["get_bounds", { name: "E" }]])).map((r) => r.result);
    check("回転 box: min[-1.1213,0.5,0.8787] max[3.1213,3.5,5.1213](実エンジンのプローブ値)", nearV(ba.min, [-1.1213, 0.5, 0.8787]) && nearV(ba.max, [3.1213, 3.5, 5.1213]) && ba.hasMesh === true, ba);
    check("sphere ±0.5 / plane ±25 で y 厚み 0 / model は assets の実寸", nearV(bb.max, [0.5, 0.5, 0.5]) && nearV(bp.min, [-25, 0, -25]) && nearV(bp.max, [25, 0, 25]) && nearV(bm.size, [1, 1, 1]), { bb, bp, bm });
    check("非メッシュは hasMesh:false・点(ワールド位置)", bl.hasMesh === false && bl.size.every((v: number) => v === 0) && be.hasMesh === false);
    // 親子: 親の scale/位置がローカルに掛かる
    const rs = await par([["create_entity", { type: "empty", name: "Grp", position: [10, 0, 0] }], ["create_entity", { type: "box", name: "Kid" }]]);
    const gid = rs[0].result.entityId;
    await call("set_transform", { name: "Grp", scale: [2, 2, 2] });
    await call("set_parent", { name: "Kid", parent: gid });
    await call("set_transform", { name: "Kid", position: [1, 0.25, 0] });
    const kb = await call("get_bounds", { name: "Kid" });
    check("親の変換込み: 子 box(local [1,.25,0])→ world center [12,0.5,0] size[2,2,2]", nearV(kb.center, [12, 0.5, 0]) && nearV(kb.size, [2, 2, 2]), kb);
    const gb = await call("get_bounds", { name: "Grp", includeChildren: true });
    check("includeChildren:true は子孫のメッシュを含める", gb.hasMesh === true && nearV(gb.center, [12, 0.5, 0]), gb);
  }

  // ── [3] ──
  console.log("[3] set_component / 色 / PBR / テクスチャ");
  {
    await call("set_color", { name: "B", color: [0.2, 0.4, 0.6] });
    await call("set_pbr", { name: "B", metallic: 0.3, roughness: 0.7, emissiveColor: [1, 0, 0], emissiveIntensity: 2, opacity: 0.5 });
    const b = await call("get_entity", { name: "B" });
    check("color / material が float32 丸めで読める", near(b.color[0], 0.2, 1e-6) && b.color[0] !== 0.2 && near(b.material.roughness, 0.7, 1e-6) && b.material.emissiveIntensity === 2, b);
    check("プリミティブの material は指定したキーだけ", Object.keys(b.material).sort().join() === "emissiveColor,emissiveIntensity,metallic,opacity,roughness", b.material);
    await call("set_component", { name: "B", component: "data", data: { specOwner: { t: "string", v: "arena" } } });
    await call("set_component", { name: "B", component: "data", data: { n: { t: "number", v: 3 } } });
    await call("set_component", { name: "B", component: "rigidBody", data: { motionType: 0 } });
    await call("set_component", { name: "B", component: "boxCollider", data: { halfExtents: [1, 1, 1] } });
    await call("set_component", { name: "B", component: "tags", data: ["spec", "x"] });
    const b2 = await call("get_entity", { name: "B" });
    check("data は {key:{t,v}} をマージ(2 回の set が両方残る)", b2.data.specOwner.v === "arena" && b2.data.n.v === 3, b2.data);
    check("rigidBody は既定値とマージ(motionType だけ変更)", b2.rigidBody.motionType === 0 && near(b2.rigidBody.friction, 0.3) && b2.rigidBody.useGravity === true, b2.rigidBody);
    check("tags は文字列配列で置換できる", JSON.stringify(b2.tags) === JSON.stringify(["spec", "x"]));
    check("componentTypes の並び(実エンジンの順: … rigidBody, boxCollider, tags, data)", b2.componentTypes.join() === "transform,meshRenderer,rigidBody,boxCollider,tags,data", b2.componentTypes);
    const eEmpty = await fail("set_component", { name: "B", component: "pointLight", data: {} });
    check("空 data は code 2 'missing component fields'", eEmpty?.error_code === 2 && /non-empty 'data'/.test(eEmpty.error), eEmpty);
    const eUnk = await fail("set_component", { name: "B", component: "rigidbody", data: { mass: 1 } });
    check("未知の component は code 6 + E_NOT_FOUND_COMPONENT + didYouMean(rigidBody)", eUnk?.error_code === 6 && eUnk.error_name === "E_NOT_FOUND_COMPONENT" && eUnk.error_did_you_mean?.includes("rigidBody"), eUnk);
    const eMesh = await fail("set_component", { name: "B", component: "meshRenderer", data: { modelPath: "x" } });
    check("meshRenderer は設定できない(code 6)", eMesh?.error_code === 6);
    const eTags = await fail("set_component", { name: "B", component: "tags", data: [1] });
    check("tags に文字列以外が入ると code 2", eTags?.error_code === 2, eTags);
    await call("set_component", { name: "B", component: "tags", data: [] });
    check("tags: [] で全消し", (await call("get_entity", { name: "B" })).tags === undefined);
    await call("attach_lua_component", { name: "B", script: "components/Spin.lua" });
    const eScript = await fail("attach_lua_component", { name: "B", script: "components/Nope.lua" });
    check("attach_lua_component: 実在は luaScript が付き、無いスクリプトは E_NOT_FOUND_ASSET", (await call("get_entity", { name: "B" })).luaScript?.scriptPath === "components/Spin.lua" && eScript?.error_name === "E_NOT_FOUND_ASSET");
    await call("set_texture", { name: "M", path: "textures/wood.png" });
    check("set_texture: materialTextureOverrides に載る / 無いテクスチャは E_NOT_FOUND_ASSET", (await call("get_entity", { name: "M" })).materialTextureOverrides?.albedo === "textures/wood.png" && (await fail("set_texture", { name: "M", path: "textures/none.png" }))?.error_name === "E_NOT_FOUND_ASSET");
    await call("remove_component", { name: "B", component: "boxCollider" });
    check("remove_component", !(await call("get_entity", { name: "B" })).boxCollider && (await fail("remove_component", { name: "B", component: "transform" }))?.error_code === 2);
    const q = await call("set_transform", { name: "B", quaternion: [0, 0.7071068, 0, 0.7071068] });
    check("quaternion → euler(yaw 90)", nearV((await call("get_entity", { name: "B" })).transform.rotation, [0, 90, 0], 0.01) && q.entityId > 0);
    const badPos = await fail("set_transform", { name: "B", position: [1, 2] });
    check("position が 3 要素でなければ code 2", badPos?.error_code === 2, badPos);
  }

  // ── [4] ──
  console.log("[4] 親子・削除・look_at・snap_to_ground");
  {
    const bad = await fail("set_parent", { name: "E", parent: 99999 });
    check("無効な親 id は code 2 'invalid parent id'", bad?.error_code === 2 && bad.error === "invalid parent id", bad);
    const eid = (await call("find_entity", { name: "E" })).entityId, kid = (await call("find_entity", { name: "Kid" })).entityId;
    await call("set_parent", { name: "E", parent: kid });
    const cyc = await fail("set_parent", { name: "Kid", parent: eid });
    check("循環は拒否される", cyc?.error_code === 2 && /cycle/.test(cyc.error), cyc);
    const kids = (await call("get_hierarchy")).roots.find((r: any) => r.name === "Grp")?.children?.[0];
    check("get_hierarchy: Grp > Kid > E", kids?.name === "Kid" && kids.children?.[0]?.name === "E");
    const del = await call("delete_entity", { name: "Grp" });
    const gone = await fail("get_entity", { name: "E" });
    check("delete_entity は子孫ごと(deletedCount 3)", del.deletedCount === 3 && gone?.error_code === 1, del);
    // look_at
    await call("create_entity", { type: "box", name: "Lk" });
    const lk = async (t: number[]) => (await call("look_at", { name: "Lk", target: t })).rotation;
    check("look_at (0,5,5) → [-45,0,0]", nearV(await lk([0, 5, 5]), [-45, 0, 0], 0.01));
    check("look_at (3,0,-3) → [0,135,0]", nearV(await lk([3, 0, -3]), [0, 135, 0], 0.01));
    check("look_at (0,0,-1) → [0,180,0]", nearV(await lk([0, 0, -1]), [0, 180, 0], 0.01));
    check("look_at (0,-4,4) → [45,0,0]", nearV(await lk([0, -4, 4]), [45, 0, 0], 0.01));
    const lkn = await call("look_at", { name: "Lk", targetName: "L" });
    check("look_at targetName", Array.isArray(lkn.rotation));
    await call("delete_entity", { name: "Lk" });
  }

  // ── [5] ──
  console.log("[5] validate_layout(実エンジンのプローブと同じ 4 種)");
  {
    // 新しいシーン相当: 既存を全部消して組み直す
    for (const n of ["A", "A (1)", "B", "P", "M", "L", "C", "E", "Sun", "Hud", "UICanvas", "Crate"]) await raw("delete_entity", { name: n });
    await par([["create_entity", { type: "plane", name: "Floor" }], ["create_entity", { type: "box", name: "F1", position: [0, 3, 0] }], ["create_entity", { type: "box", name: "D1", position: [10, 0.5, 0] }],
      ["create_entity", { type: "box", name: "D2", position: [10, 0.5, 0] }], ["create_entity", { type: "box", name: "O1", position: [-10, 0.5, 0] }], ["create_entity", { type: "box", name: "O2", position: [-10.3, 0.5, 0] }],
      ["create_entity", { type: "box", name: "Bur", position: [5, -0.2, 5] }]]);
    const v = await call("validate_layout");
    const kinds = Object.fromEntries(v.issues.map((i: any) => [i.name + ":" + i.kind, i]));
    check("checked 7 / errors 2 / warnings 2 / pass false", v.checked === 7 && v.errors === 2 && v.warnings === 2 && v.pass === false, { c: v.checked, e: v.errors, w: v.warnings, issues: v.issues.map((i: any) => i.name + ":" + i.kind) });
    check("DUPLICATE(D2 が D1 と): error", kinds["D2:DUPLICATE"]?.level === "error" || kinds["D1:DUPLICATE"]?.level === "error", v.issues);
    check("OVERLAP(O2 が O1 に体積比 70%): warning", kinds["O2:OVERLAP"]?.level === "warning" && /70%/.test(kinds["O2:OVERLAP"].text), kinds["O2:OVERLAP"]);
    check("FLOATING(F1 が 2.50m 浮き): warning", kinds["F1:FLOATING"]?.level === "warning" && /2\.50m/.test(kinds["F1:FLOATING"].text), kinds["F1:FLOATING"]);
    check("BURIED(Bur が 0.70m 埋まり): error", kinds["Bur:BURIED"]?.level === "error" && /0\.70m/.test(kinds["Bur:BURIED"].text), kinds["Bur:BURIED"]);
    check("next の案内が付く", /fix:"safe"/.test(v.next ?? ""));
    const snap = await call("snap_to_ground", { name: "F1" });
    check("snap_to_ground: movedBy -2.5 / position[0,0.5,0] / ground = Floor", near(snap.movedBy, -2.5) && nearV(snap.position, [0, 0.5, 0]) && snap.groundEntityId === (await call("find_entity", { name: "Floor" })).entityId, snap);
    const fx = await call("validate_layout", { fix: "safe" });
    check("fix:'safe' で BURIED が直る(fixed>=1)・Bur は y=0.5", fx.fixed >= 1 && nearV((await call("get_entity", { name: "Bur" })).transform.position, [5, 0.5, 5]), fx);
    await par([["set_transform", { name: "D2", position: [20, 0.5, 0] }], ["set_transform", { name: "O2", position: [-13, 0.5, 0] }]]);
    const clean = await call("validate_layout");
    check("直した後は pass:true・errors 0 warnings 0", clean.pass === true && clean.errors === 0 && clean.warnings === 0, clean.issues);
    // Z_FIGHT(絨毯を床と同一面に)・COLLIDER_WITHOUT_BODY・ローカル: 同じ床に薄い箱を重ねる
    await call("create_entity", { type: "box", name: "Rug", position: [30, 0.0005, 30] });
    await call("set_transform", { name: "Rug", scale: [2, 0.001, 2] });
    await call("set_component", { name: "F1", component: "boxCollider", data: { halfExtents: [0.5, 0.5, 0.5] } });
    const z = await call("validate_layout");
    check("COLLIDER_WITHOUT_BODY(F1)が error", z.issues.some((i: any) => i.kind === "COLLIDER_WITHOUT_BODY" && i.name === "F1"), z.issues);
    const zf = await call("validate_layout", { fix: "safe" });
    check("safe で rigidBody(static)が付き fixed になる", (await call("get_entity", { name: "F1" })).rigidBody?.motionType === 0 && zf.issues.find((i: any) => i.kind === "COLLIDER_WITHOUT_BODY")?.fixed === true, zf.issues);
    const badFix = await fail("validate_layout", { fix: "x" });
    check("不正な fix は E_BAD_ENUM", badFix?.error_name === "E_BAD_ENUM");
    await par([["delete_entity", { name: "Rug" }]]);
  }

  // ── [6] ──
  console.log("[6] トランザクション");
  {
    const h0 = sim.hash();
    const n0 = (await call("list_entities")).count;
    await call("apply_lighting_preset", { preset: "day" });   // 太陽が無いので sun:null。post は settings に残る
    await call("transaction_begin", { label: "spec:t1" });
    const dupBegin = await fail("transaction_begin", { label: "x" });
    check("二重 begin は code 3", dupBegin?.error_code === 3, dupBegin);
    await par([["create_entity", { type: "box", name: "T1" }], ["create_entity", { type: "box", name: "T2" }], ["create_entity", { type: "light_directional", name: "Sun" }]]);
    await call("set_transform", { name: "T1", position: [1, 1, 1] });
    await call("delete_entity", { name: "Floor" });
    await call("set_component", { name: "Sun", component: "directionalLight", data: { intensity: 5 } });
    await call("apply_lighting_preset", { preset: "horror" });
    await call("set_scene_settings", { skybox: { skyboxIntensity: 0.3 } });
    const st = await call("transaction_status");
    check("tx 中の書き込み回数(calls)が数えられる(create×3 + transform + delete + component + preset = 7。設定系の scene_settings は数えない)", st.open === true && st.calls === 7, st);
    const rb = await call("transaction_rollback");
    check("rollback: rolledBack:true・calls 7", rb.rolledBack === true && rb.calls === 7, rb);
    check("rollback でシーンの hash が begin 前と一致・件数も戻る", sim.hash() === h0 && (await call("list_entities")).count === n0, { h0, now: sim.hash() });
    check("設定系は rollback で戻らない(lighting preset は horror のまま・skyboxIntensity 0.3)", sim.state.settings.lighting === "horror" && near((await call("get_scene_settings")).skybox.skyboxIntensity, 0.3, 1e-6), sim.state.settings);
    const noTx = await fail("transaction_commit");
    check("tx が無いときの commit は code 3", noTx?.error_code === 3);
    await call("transaction_begin", { label: "spec:t2" });
    await call("create_entity", { type: "box", name: "Keep" });
    const cm = await call("transaction_commit");
    check("commit: committed:true・変更が残る", cm.committed === true && cm.calls === 1 && !!(await call("find_entity", { name: "Keep" })));
    await call("delete_entity", { name: "Keep" });
  }

  // ── [7] ──
  console.log("[7] 設定系");
  {
    await call("create_entity", { type: "light_directional", name: "Sun2" });
    const pr = await call("apply_lighting_preset", { preset: "horror" });
    check("horror: sun.intensity 0.25 / ambient 0.02(プローブ値)・post.vignette 0.75", near(pr.sun.intensity, 0.25) && near(pr.sun.ambient, 0.02) && pr.post.vignette === 0.75 && pr.preset === "horror", pr);
    const bad = await fail("apply_lighting_preset", { preset: "hrror" });
    check("不正な preset は E_BAD_ENUM + error_values + didYouMean", bad?.error_name === "E_BAD_ENUM" && bad.error_values.includes("horror") && bad.error_did_you_mean?.includes("horror"), bad);
    const s = await call("set_sun", { elevation: 10 });
    check("set_sun: elevation 10 が返る・intensity は preset のまま", near(s.elevationDeg, 10, 0.01) && near(s.intensity, 0.25) && s.name === "Sun2", s);
    const s2 = await call("set_sun", { timeOfDay: 12 });
    check("set_sun timeOfDay:12 は高い太陽", s2.elevationDeg > 60, s2);
    await call("set_scene_settings", { skybox: { skyboxIntensity: 0.5 }, decalAtlasPath: "textures/decals/atlas.png" });
    const gs = await call("get_scene_settings");
    check("set_scene_settings が get_scene_settings に反映", near(gs.skybox.skyboxIntensity, 0.5) && gs.decalAtlasPath === "textures/decals/atlas.png", gs);
    const nb0 = await call("navmesh_info");
    check("navmesh 未ビルド: stats.built false・path は到達不能", nb0.stats.built === false && (await call("navmesh_path", { from: [0, 0, 0], to: [0, 0, 5] })).reached === false);
    await call("navmesh_build", {});
    const nb = await call("navmesh_info");
    const path = await call("navmesh_path", { from: [0, 0, 0], to: [0, 0, 5] });
    check("navmesh_build 後: built・path は直線・reached:true", nb.stats.built === true && nb.stats.polyCount > 0 && path.reached === true && path.points.length === 2, { nb, path });
    sim.state.blockedPairs.push({ from: [0, 0, 0], to: [0, 0, 5] });
    const blocked = await call("navmesh_path", { from: [0.2, 0, 0], to: [0, 0, 5.3] });
    check("blockedPairs(近傍一致)で到達不能", blocked.reached === false && blocked.points.length === 0);
    sim.state.blockedPairs.length = 0; sim.state.navBlocked = true;
    check("navBlocked:true で常に到達不能", (await call("navmesh_path", { from: [0, 0, 0], to: [1, 0, 1] })).reached === false);
    sim.state.navBlocked = false;
    await call("delete_entity", { name: "Sun2" });
    check("validate_scene は常に PASS", (await call("validate_scene", {})).pass === true);
  }

  // ── [8] ──
  console.log("[8] failNext / 記録 / モード");
  {
    await call("create_entity", { type: "box", name: "F" });
    const h = sim.hash();
    sim.failNext("set_component", { name: "F" });
    const f1 = await fail("set_component", { name: "F", component: "rigidBody", data: { mass: 2 } });
    check("failNext: 次の該当呼び出しが失敗(code 7・simulated failure)", f1?.error_code === 7 && f1.error === "simulated failure", f1);
    check("失敗した呼び出しは何も変更していない", sim.hash() === h);
    const ok1 = await raw("set_component", { name: "F", component: "rigidBody", data: { mass: 2 } });
    check("その次は成功する(1 回きり)", ok1.ok === true);
    sim.failNext("set_transform", { name: "Other" });
    check("name が違う呼び出しでは発火しない", (await raw("set_transform", { name: "F", position: [1, 0, 0] })).ok === true);
    sim.clearFailures();
    sim.failNext("set_color", { nth: 3, message: "third", code: 9 });
    const r = [await raw("set_color", { name: "F", color: [1, 0, 0] }), await raw("set_color", { name: "F", color: [0, 1, 0] }), await raw("set_color", { name: "F", color: [0, 0, 1] }), await raw("set_color", { name: "F", color: [1, 1, 1] })];
    check("nth:3 は 3 回目だけ失敗", r.map((x) => x.ok).join() === "true,true,false,true" && r[2].error_code === 9 && r[2].error === "third", r);
    check("state.calls に read も含めて記録される", sim.state.calls.some((c) => c.method === "get_entity") && sim.state.calls.some((c) => c.method === "set_color" && c.params.name === "F"));
    mock.state.mode = "Playing";
    const pc = await fail("create_entity", { type: "box", name: "Z" });
    const pv = await fail("validate_layout");
    check("Playing 中は生成・検査が code 3(E_MODE_CONFLICT)", pc?.error_code === 3 && pc.error_name === "E_MODE_CONFLICT" && pv?.error_code === 3, { pc, pv });
    mock.state.mode = "Editor";
    check("get_mode は mock の mode を返す", (await call("get_mode")).mode === "Editor");
    check("snapshot() は entities / settings を含む複製", sim.snapshot().entities.length === sim.state.entities.length && sim.snapshot().entities !== sim.state.entities);
    check("hash は entityId / guid に依存しない(同じ内容を別 id で作っても同じ)", (() => { const a = createSceneSim(); return a.hash() === createSceneSim().hash(); })());
  }
} finally {
  sock.destroy();
  await mock.close();
}

console.log(`\n${failed === 0 ? "全部通過" : "失敗あり"}: ${total - failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
