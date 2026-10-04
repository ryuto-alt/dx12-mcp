// 宣言的シーン生成(M11)の TS 単体テスト。偽エンジン = sceneSim.ts(シーン状態を持つ。実エンジンのプローブ値に合わせてある)。
//   [1] 幾何(get_bounds と同じ式・look_at・JSON Patch)
//   [2] スキーマ検証(issues の path / code / didYouMean / specPatch)
//   [3] 相対配置の解決(右 2m・上に載せる・地面・壁に沿って・円形・格子・散布の決定論)
//   [4] 差分計画と適用(冪等・最小差分・plan は何も書かない・prune の所有者判定・種別変更)
//   [5] ロールバック(途中失敗 / 検証失敗で hash が元に戻る)と検証の specPatch(撃ち直して通る)
//   [6] 往復(シーン → 仕様 → 適用で同じシーン)
// 実行: node sceneSpec.test.ts
import "./testEnv.ts";
import { startMockEngine } from "./mockEngine.ts";
import { createSceneSim } from "./sceneSim.ts";
import { EngineClient } from "./engineClient.ts";
import { runSceneSpec, SpecCache, type SpecDeps, type SpecResult } from "./sceneSpec/index.ts";
import { exportScene } from "./sceneSpec/export.ts";
import { applyPatch, mergePatches, PatchError } from "./sceneSpec/patch.ts";
import { aabbCenter, eulerToMat3, lookAtEuler, transformAabb, trs, primitiveLocalAabb, mulberry32 } from "./sceneSpec/geom.ts";
import { validateSpec, instanceNames } from "./sceneSpec/schema.ts";
import { resolveSpec } from "./sceneSpec/expand.ts";
import { digestScene } from "./sceneSpec/digest.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1200)}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
const nearV = (a: number[] | undefined, b: number[], eps = 1e-3) => !!a && a.length === b.length && a.every((v, i) => near(v, b[i], eps));
const j = (v: unknown) => JSON.stringify(v);

const ASSETS = {
  "models/cube1m.glb": { min: [-0.5, -0.5, -0.5] as [number, number, number], max: [0.5, 0.5, 0.5] as [number, number, number], type: "model" },
  "models/tall.glb": { min: [-0.5, 0, -0.5] as [number, number, number], max: [0.5, 3, 0.5] as [number, number, number], type: "model" },
};

async function env(opts: { assets?: any } = {}) {
  const sim = createSceneSim({ assets: opts.assets ?? ASSETS, scripts: ["components/Spin.lua"], textures: ["textures/wood.png"], prefabs: ["prefabs/crate.prefab"] });
  const mock = await startMockEngine({ methods: sim.methods });
  const engine = new EngineClient("127.0.0.1", mock.port);
  const cache = new SpecCache();
  const deps: SpecDeps = { engine: engine as any, cache };
  const run = (input: Parameters<typeof runSceneSpec>[1]) => runSceneSpec(deps, input);
  const writes = () => sim.state.calls.filter((c) => !/^(get_|list_|describe_|find_|asset_info|validate_|ping)/.test(c.method));
  return { sim, mock, engine, deps, run, cache, writes };
}
const data = (r: SpecResult): any => (r.ok ? r.data : r.data);
const issuesOf = (r: SpecResult) => (r.ok ? [] : r.issues);
const codes = (r: SpecResult) => issuesOf(r).map((i) => i.code);

// ── [1] 幾何 ─────────────────────────────────────────────────
console.log("[1] 幾何・JSON Patch");
{
  const b = transformAabb(primitiveLocalAabb("box"), trs([1, 2, 3], [0, 45, 0], [2, 3, 4]));
  check("回転 + スケールの box の AABB が実エンジンの実測と一致(min[-1.1213,0.5,0.8787] max[3.1213,3.5,5.1213])", nearV(b.min, [-1.1213, 0.5, 0.8787], 1e-3) && nearV(b.max, [3.1213, 3.5, 5.1213], 1e-3), b);
  check("plane は x,z ±25・厚み 0", j(primitiveLocalAabb("plane")) === j({ min: [-25, 0, -25], max: [25, 0, 25] }));
  check("lookAt: (0,5,5)→[-45,0,0] / (3,0,-3)→[0,135,0] / (0,0,-1)→[0,180,0] / (0,-4,4)→[45,0,0](実エンジンの look_at と同じ)",
    nearV(lookAtEuler([0, 0, 0], [0, 5, 5]), [-45, 0, 0]) && nearV(lookAtEuler([0, 0, 0], [3, 0, -3]), [0, 135, 0]) && nearV(lookAtEuler([0, 0, 0], [0, 0, -1]), [0, 180, 0]) && nearV(lookAtEuler([0, 0, 0], [0, -4, 4]), [45, 0, 0]));
  const R = eulerToMat3([0, 90, 0]);
  check("yaw 90 で +Z が +X を向く", near(R[0 * 3 + 2], 1) && near(R[2 * 3 + 2], 0, 1e-9));
  const r1 = mulberry32(7), r2 = mulberry32(7);
  check("mulberry32 は同じ seed で同じ並び", r1() === r2() && r1() === r2());
  const doc = { a: [1, 2, 3], o: { x: 1 } };
  check("JSON Patch: add / replace / remove / move / copy / test", j(applyPatch(doc, [{ op: "add", path: "/a/-", value: 4 }, { op: "replace", path: "/o/x", value: 9 }, { op: "remove", path: "/a/0" }, { op: "move", from: "/o/x", path: "/o/y" }, { op: "copy", from: "/o/y", path: "/o/z" }, { op: "test", path: "/o/z", value: 9 }])) === j({ a: [2, 3, 4], o: { y: 9, z: 9 } }));
  check("JSON Patch は元を変えない", j(doc) === j({ a: [1, 2, 3], o: { x: 1 } }));
  let err: any = null;
  try { applyPatch(doc, [{ op: "replace", path: "/nope/x", value: 1 }]); } catch (e) { err = e; }
  check("存在しない path は PatchError(どの op か分かる)", err instanceof PatchError && err.index === 0 && /存在しない/.test(err.message), err?.message);
  check("~ と / のエスケープ", j(applyPatch({ "a/b": 1 }, [{ op: "replace", path: "/a~1b", value: 2 }])) === j({ "a/b": 2 }));
  const merged = mergePatches([[{ op: "remove", path: "/entities/1" }, { op: "replace", path: "/entities/2/name", value: "X" }], [{ op: "remove", path: "/entities/3" }, { op: "replace", path: "/entities/2/name", value: "Y" }]]);
  check("mergePatches: 同じ path の重複は最初だけ・remove は添字の大きい方から最後に並ぶ", j(merged.map((o) => `${o.op}:${o.path}`)) === j(["replace:/entities/2/name", "remove:/entities/3", "remove:/entities/1"]), merged);
  check("instanceNames: 2 桁ゼロ埋め・100 件以上は 3 桁・skip を除く", instanceNames("P", 3).join() === "P_01,P_02,P_03" && instanceNames("P", 120)[0] === "P_001" && instanceNames("P", 4, [2]).join() === "P_01,P_03,P_04");
}

// ── [2] スキーマ検証 ────────────────────────────────────────────
console.log("[2] スキーマ検証(issues の path / code / didYouMean / specPatch)");
{
  const ctx = { assets: { models: ["models/cube1m.glb", "models/tall.glb"], prefabs: ["prefabs/crate.prefab"], scripts: ["components/Spin.lua"], textures: ["textures/wood.png"] }, sceneNames: ["Existing"], looks: ["golden_hour", "blue_hour"] };
  const v = (spec: any) => validateSpec(spec, ctx);
  const one = (spec: any, code: string) => v(spec).issues.find((i) => i.code === code);
  check("予約名 Grid(エディタ内部)は仕様に使えない → 改名の specPatch", validateSpec({ version: 1, entities: [{ name: "Grid", kind: "box" }] }, { ...ctx, reserved: ["Grid"] }).issues[0]?.specPatch?.[0]?.value === "Grid_01");
  const ok = v({ version: 1, entities: [{ name: "A", kind: "box", at: [0, 1, 0] }] });
  check("正しい仕様は issues 0", ok.issues.length === 0 && ok.entityCount === 1, ok.issues);
  check("ルートが配列 → E_BAD_TYPE", v([]).issues[0]?.code === "E_BAD_TYPE");
  const t1 = one({ version: 1, entites: [] }, "E_UNKNOWN_PARAM");
  check("ルートの打ち間違い entites → entities(move の specPatch)", t1?.didYouMean?.[0] === "entities" && t1.specPatch?.[0]?.op === "move" && t1.path === "/entites", t1);
  check("version が無い → add /version", one({ entities: [] }, "E_MISSING_PARAM")?.specPatch?.[0]?.path === "/version");
  const e1 = one({ version: 1, entities: [{ name: "A", kind: "cube" }] }, "E_BAD_ENUM");
  check("kind の別名 cube → box(path=/entities/0/kind・validValues・specPatch)", e1?.path === "/entities/0/kind" && e1.didYouMean?.[0] === "box" && e1.specPatch?.[0]?.value === "box" && (e1.validValues?.length ?? 0) > 10, e1);
  const e2 = v({ version: 1, entities: [{ name: "L", kind: "point_light" }] }).issues.find((i) => i.code === "E_BAD_ENUM");
  check("kind:'point_light' → kind:light + light:point の 2 操作", e2?.specPatch?.length === 2 && e2.specPatch[1].path === "/entities/0/light" && e2.specPatch[1].value === "point" || e2?.specPatch?.[0]?.value === "light", e2);
  const e3 = one({ version: 1, entities: [{ name: "A", kind: "box", postion: [0, 0, 0] }] }, "E_UNKNOWN_PARAM");
  check("キー postion → at(move)", e3?.path === "/entities/0/postion" && e3.specPatch?.[0]?.op === "move" && e3.specPatch[0].path === "/entities/0/at", e3);
  check("position は at の別名として提案される", one({ version: 1, entities: [{ name: "A", kind: "box", position: [0, 0, 0] }] }, "E_UNKNOWN_PARAM")?.didYouMean?.[0] === "at");
  const e4 = one({ version: 1, entities: [{ name: "M", kind: "model", model: "models/cube1.glb" }] }, "E_NOT_FOUND_ASSET");
  check("未知モデル → E_NOT_FOUND_ASSET + didYouMean + 置換の specPatch", e4?.didYouMean?.[0] === "models/cube1m.glb" && e4.specPatch?.[0]?.value === "models/cube1m.glb" && e4.path === "/entities/0/model", e4);
  check("model が無い → E_MISSING_PARAM", one({ version: 1, entities: [{ name: "M", kind: "model" }] }, "E_MISSING_PARAM")?.path === "/entities/0/model");
  const dup = one({ version: 1, entities: [{ name: "A", kind: "box" }, { name: "A", kind: "box" }] }, "E_SPEC_DUPLICATE_NAME");
  check("重複名 → E_SPEC_DUPLICATE_NAME(後ろの path・改名の specPatch)", dup?.path === "/entities/1/name" && dup.specPatch?.[0]?.value === "A_2", dup);
  const ref = one({ version: 1, entities: [{ name: "A", kind: "box" }, { name: "B", kind: "box", place: { relativeTo: "AA", side: "right" } }] }, "E_NOT_FOUND_ENTITY");
  check("参照切れ → E_NOT_FOUND_ENTITY + 近い名前 + 置換", ref?.path === "/entities/1/place/relativeTo" && ref.didYouMean?.[0] === "A" && ref.specPatch?.[0]?.value === "A", ref);
  check("シーンにある既存の名前は参照できる", v({ version: 1, entities: [{ name: "B", kind: "box", parent: "Existing" }] }).issues.length === 0);
  const cyc = v({ version: 1, entities: [{ name: "A", kind: "box", place: { relativeTo: "B", side: "right" } }, { name: "B", kind: "box", place: { relativeTo: "A", side: "right" } }] }).issues.find((i) => i.code === "E_SPEC_CYCLE");
  check("相対配置の循環 → E_SPEC_CYCLE(remove の specPatch)", !!cyc && cyc.specPatch?.[0]?.op === "remove", cyc);
  const pos = one({ version: 1, entities: [{ name: "A", kind: "box", at: "0,1,0" }] }, "E_BAD_TYPE");
  check("at が文字列 '0,1,0' → 配列へ直す specPatch", j(pos?.specPatch?.[0]?.value) === j([0, 1, 0]), pos);
  const col = one({ version: 1, entities: [{ name: "A", kind: "box", color: [255, 128, 0] }] }, "E_OUT_OF_RANGE");
  check("color が 0..255 → 255 で割る specPatch", nearV(col?.specPatch?.[0]?.value, [1, 0.502, 0], 1e-3), col);
  check("color '#ff8000' は通る", v({ version: 1, entities: [{ name: "A", kind: "box", color: "#ff8000" }] }).issues.length === 0);
  const mat = one({ version: 1, entities: [{ name: "A", kind: "box", material: { roughness: 5, metalic: 1 } }] }, "E_OUT_OF_RANGE");
  check("material.roughness が範囲外 → clamp の specPatch", mat?.specPatch?.[0]?.value === 1 && mat.path === "/entities/0/material/roughness", mat);
  check("material の typo metalic → metallic", one({ version: 1, entities: [{ name: "A", kind: "box", material: { metalic: 1 } }] }, "E_UNKNOWN_PARAM")?.didYouMean?.[0] === "metallic");
  const sz = one({ version: 1, entities: [{ name: "A", kind: "box", size: [1, 1, 1], scale: 2 }] }, "E_SPEC_CONFLICT");
  check("size と scale の併用 → E_SPEC_CONFLICT", !!sz);
  const unit = one({ version: 1, entities: [{ name: "Wall", kind: "box", size: [1200, 300, 20] }] }, "W_UNIT_SUSPECT");
  check("size 1200 → 単位の疑い(warn + 100 で割る specPatch)", unit?.severity === "warn" && nearV(unit.specPatch?.[0]?.value, [12, 3, 0.2]), unit);
  const comp = one({ version: 1, entities: [{ name: "A", kind: "box", components: { rigidbody: { motionType: 0 } } }] }, "E_NOT_FOUND_COMPONENT");
  check("components の jsonKey typo rigidbody → rigidBody(move)", comp?.didYouMean?.[0] === "rigidBody" && comp.specPatch?.[0]?.op === "move", comp);
  check("components.transform は仕様に書けない(at / rotation / scale)", !!one({ version: 1, entities: [{ name: "A", kind: "box", components: { transform: { position: [0, 0, 0] } } }] }, "E_SPEC_CONFLICT"));
  const scr = one({ version: 1, entities: [{ name: "A", kind: "box", script: "components/Spinn.lua" }] }, "E_NOT_FOUND_ASSET");
  check("script の実在確認 + didYouMean", scr?.didYouMean?.[0] === "components/Spin.lua", scr);
  const tex = one({ version: 1, entities: [{ name: "A", kind: "box", texture: { albedo: "textures/wod.png" } }] }, "E_NOT_FOUND_ASSET");
  check("texture の実在確認", tex?.didYouMean?.[0] === "textures/wood.png" && tex.path === "/entities/0/texture/albedo", tex);
  check("tags が文字列 → 配列へ直す", j(one({ version: 1, entities: [{ name: "A", kind: "box", tags: "enemy" }] }, "E_BAD_TYPE")?.specPatch?.[0]?.value) === j(["enemy"]));
  const sd = one({ version: 1, entities: [{ name: "A", kind: "box", place: { relativeTo: "A", side: "right" } }] }, "E_SPEC_CYCLE");
  check("自分自身を基準にすると E_SPEC_CYCLE", !!sd);
  const side = one({ version: 1, entities: [{ name: "A", kind: "box" }, { name: "B", kind: "box", place: { relativeTo: "A", side: "east" } }] }, "E_BAD_ENUM");
  check("place.side に east → right", side?.didYouMean?.[0] === "right" && side.path === "/entities/1/place/side");
  const pat = v({ version: 1, entities: [{ name: "P", kind: "box", pattern: { type: "ring", count: 6 } }] }).issues.map((i) => i.code);
  check("ring に radius と中心が無い → E_MISSING_PARAM 2 件", pat.filter((c) => c === "E_MISSING_PARAM").length === 2, pat);
  check("pattern.type の別名 circle → ring", one({ version: 1, entities: [{ name: "P", kind: "box", pattern: { type: "circle", count: 6, radius: 3, origin: [0, 0, 0] } }] }, "E_BAD_ENUM")?.didYouMean?.[0] === "ring");
  const big = one({ version: 1, entities: [{ name: "P", kind: "box", pattern: { type: "grid", count: [80, 80], spacing: [1, 1] } }] }, "E_SPEC_LIMIT");
  check("パターン展開後 6,400 体 → 上限 5,000 のエラー", !!big && v({ version: 1, entities: [{ name: "P", kind: "box", pattern: { type: "grid", count: [70, 70], spacing: [1, 1] } }] }).issues.length === 0);
  check("lighting.preset の typo → 近い値 + specPatch", v({ version: 1, lighting: { preset: "nite" } }).issues[0]?.didYouMean?.[0] === "night");
  check("look.preset は id 一覧と突き合わせる", v({ version: 1, look: { preset: "golden_hor" } }).issues[0]?.didYouMean?.[0] === "golden_hour");
  check("group の別名 LIGHT → LGT", v({ version: 1, entities: [{ name: "A", kind: "box", group: "LIGHT" }] }).issues[0]?.didYouMean?.[0] === "LGT");
  check("lookAt と rotation の併用は競合", !!one({ version: 1, entities: [{ name: "A", kind: "camera", rotation: [0, 0, 0], lookAt: [0, 0, 0] }] }, "E_SPEC_CONFLICT"));
  check("全 issue が path(JSON Pointer)を持つ", ["E_BAD_TYPE", "E_UNKNOWN_PARAM"].every((c) => /^(\/|$)/.test(v({ version: 1, entites: 1, entities: [{ name: 1 }] }).issues.find((i) => i.code === c)?.path ?? "/")));
}

// ── [3] 相対配置 ────────────────────────────────────────────────
console.log("[3] 相対配置の解決(AABB の実測で決まる)");
{
  const solve = (entities: any[], extra: any = {}) => resolveSpec({ version: 1, entities, ...extra } as any, { assetBounds: (p) => (ASSETS as any)[p] && { min: (ASSETS as any)[p].min, max: (ASSETS as any)[p].max } });
  const at = (r: any, n: string) => r.entities.find((e: any) => e.name === n)?.position;
  const wb = (r: any, n: string) => r.entities.find((e: any) => e.name === n)?.worldBounds;
  const base = [{ name: "A", kind: "box", size: [2, 1, 2], at: [0, 0.5, 0] }];
  let r = solve([...base, { name: "R", kind: "box", size: 1, place: { relativeTo: "A", side: "right", gap: 2 } }]);
  check("右 2m: 面と面のすき間が 2m(A の +X 面 1.0 → R の -X 面 3.0 → 中心 3.5)・y は底面を揃える(0.5)・z は中心揃え", nearV(at(r, "R"), [3.5, 0.5, 0]), at(r, "R"));
  r = solve([...base, { name: "L", kind: "box", size: 1, place: { relativeTo: "A", side: "left", gap: 1 } }]);
  check("左 1m → x=-2.5", nearV(at(r, "L"), [-2.5, 0.5, 0]), at(r, "L"));
  r = solve([...base, { name: "F", kind: "box", size: 1, place: { relativeTo: "A", side: "front", gap: 0 } }, { name: "Bk", kind: "box", size: 1, place: { relativeTo: "A", side: "back", gap: 0.5 } }]);
  check("front(+Z)/ back(-Z)", nearV(at(r, "F"), [0, 0.5, 1.5]) && nearV(at(r, "Bk"), [0, 0.5, -2]), [at(r, "F"), at(r, "Bk")]);
  r = solve([...base, { name: "T", kind: "sphere", size: 1, place: { on: "A" } }, { name: "U", kind: "box", size: 1, place: { relativeTo: "A", side: "above", gap: 0.5 } }, { name: "D", kind: "box", size: 1, place: { relativeTo: "A", side: "below" } }]);
  check("on: 上に載せる(A の天面 1.0 + 半径 0.5 = 1.5)・above + gap・below", nearV(at(r, "T"), [0, 1.5, 0]) && nearV(at(r, "U"), [0, 2, 0]) && nearV(at(r, "D"), [0, -0.5, 0]), [at(r, "T"), at(r, "U"), at(r, "D")]);
  r = solve([{ name: "G", kind: "box", size: [1, 4, 1], place: { ground: true } }, { name: "H", kind: "box", size: 2, place: { ground: 3 } }]);
  check("ground: 足元を y=0(または指定高さ)に合わせる", nearV(at(r, "G"), [0, 2, 0]) && nearV(at(r, "H"), [0, 4, 0]), [at(r, "G"), at(r, "H")]);
  r = solve([{ name: "Floor", kind: "plane", size: [10, 10], at: [0, 0, 0] }, { name: "Box", kind: "box", size: 1, at: [3, null, -2], place: { on: "Floor" } }]);
  check("at の null 軸だけ place が決める(x,z は明示・y は床の天面)", nearV(at(r, "Box"), [3, 0.5, -2]), at(r, "Box"));
  r = solve([{ name: "M", kind: "model", model: "models/tall.glb", place: { ground: true } }, { name: "C", kind: "model", model: "models/cube1m.glb", place: { relativeTo: "M", side: "right", gap: 1 } }]);
  check("モデルは asset_info の AABB(scale 1 の実寸)で解く: tall(高さ 3・底が原点)は ground で y=0、隣の cube は底揃えの y=0.5", nearV(at(r, "M"), [0, 0, 0]) && nearV(at(r, "C"), [2, 0.5, 0]), [at(r, "M"), at(r, "C")]);
  r = solve([{ name: "A", kind: "box", size: 2, at: [0, 1, 0], rotation: [0, 45, 0] }, { name: "B", kind: "box", size: 1, place: { relativeTo: "A", side: "right" } }]);
  check("回転した A の AABB(±1.414)を基準にする", near(at(r, "B")[0], 1.4142 + 0.5, 1e-3), at(r, "B"));
  r = solve([{ name: "Wall", kind: "box", size: [10, 3, 0.4], at: [0, 1.5, 5] }, { name: "Lamp", kind: "box", size: [0.3, 0.3, 0.3], pattern: { type: "along", of: "Wall", side: "front", count: 3, margin: 1, gap: 0.1 } }]);
  check("along(壁に沿って): 3 個を壁の +Z 面から 0.1m 離して、両端 1m 内側から等間隔", nearV(at(r, "Lamp_01"), [-4, 0.15, 5.45], 1e-3) && nearV(at(r, "Lamp_02"), [0, 0.15, 5.45]) && nearV(at(r, "Lamp_03"), [4, 0.15, 5.45]), ["Lamp_01", "Lamp_02", "Lamp_03"].map((n) => at(r, n)));
  r = solve([{ name: "Ring", kind: "box", size: 1, pattern: { type: "ring", count: 4, radius: 5, origin: [10, 0, 10], faceCenter: true }, place: { ground: true } }]);
  check("ring: 4 個は 90 度刻み(θ=0 が +Z)・半径 5・中心 (10,10)・faceCenter で中心を向く・y は ground", nearV(at(r, "Ring_01"), [10, 0.5, 15]) && nearV(at(r, "Ring_02"), [15, 0.5, 10]) && nearV(at(r, "Ring_03"), [10, 0.5, 5]) && nearV(r.entities[0].rotation, [0, 180, 0]) && nearV(r.entities[1].rotation, [0, 270, 0]), [r.entities.map((e: any) => e.position), r.entities.map((e: any) => e.rotation)]);
  r = solve([{ name: "G", kind: "box", size: 1, pattern: { type: "grid", count: [3, 2], spacing: [2, 4], origin: [0, 0, 0] }, place: { ground: true } }]);
  check("grid: 3×2・中心間隔 (2,4)・原点を中心に(x=-2,0,2 / z=-2,2)・名前は行優先の連番", r.entities.length === 6 && nearV(at(r, "G_01"), [-2, 0.5, -2]) && nearV(at(r, "G_03"), [2, 0.5, -2]) && nearV(at(r, "G_04"), [-2, 0.5, 2]) && nearV(at(r, "G_06"), [2, 0.5, 2]), r.entities.map((e: any) => e.position));
  const sc = (seed: number) => solve([{ name: "Floor", kind: "plane", size: [20, 20], at: [0, 0, 0] }, { name: "Rock", kind: "sphere", size: 1, pattern: { type: "scatter", count: 12, area: "Floor", seed, minSpacing: 2, yaw: "random", scaleRange: [0.8, 1.2] }, place: { on: "Floor" } }]);
  const s1 = sc(42), s2 = sc(42), s3 = sc(43);
  check("scatter: 同じ seed は完全に同じ座標・回転・スケール(決定論)、別 seed は別", j(s1.entities) === j(s2.entities) && j(s1.entities) !== j(s3.entities) && s1.entities.length === 13);
  const pts = s1.entities.filter((e: any) => e.name.startsWith("Rock_")).map((e: any) => e.position);
  let minD = Infinity; for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) minD = Math.min(minD, Math.hypot(pts[a][0] - pts[b][0], pts[a][2] - pts[b][2]));
  check("scatter: minSpacing 2m を守る・範囲は床の AABB の中", minD >= 2 - 1e-6 && pts.every((p: number[]) => Math.abs(p[0]) <= 10 && Math.abs(p[2]) <= 10), minD);
  r = solve([{ name: "Rock", kind: "box", size: 1, pattern: { type: "scatter", count: 50, area: [0, 0, 3, 3], seed: 1, minSpacing: 2 } }]);
  check("scatter: 置けないほど厳しい条件は W_SCATTER_SHORT(置けた分だけ・連番は詰まる)", r.issues.some((i) => i.code === "W_SCATTER_SHORT") && r.entities.length < 50 && r.entities.length >= 1, r.entities.length);
  r = solve([{ name: "Grp", kind: "empty", at: [10, 0, 0], rotation: [0, 90, 0] }, { name: "K", kind: "box", size: 1, parent: "Grp", at: [1, 0, 0] }, { name: "W", kind: "box", size: 1, place: { relativeTo: "K", side: "right" } }]);
  const kb = wb(r, "K");
  check("親のワールド変換: 親 (10,0,0) yaw 90 の子 local (1,0,0) は world (10,0,-1)", nearV(aabbCenter(kb), [10, 0, -1]), kb);
  r = solve([{ name: "Grp", kind: "empty", at: [10, 0, 0] }, { name: "K", kind: "box", size: 1, parent: "Grp", place: { relativeTo: "Anchor", side: "right", gap: 1 } }, { name: "Anchor", kind: "box", size: 1, at: [0, 0.5, 0] }]);
  check("place の解(ワールド)を親のローカルに戻す(world x=2 → local x=-8)・依存順で解く(Anchor が後に書かれていても)", nearV(at(r, "K"), [-8, 0.5, 0]) && r.order.join() === "Grp,Anchor,K", [at(r, "K"), r.order]);
  r = solve([{ name: "Tgt", kind: "box", size: 1, at: [0, 0, 10] }, { name: "Cam", kind: "camera", at: [10, 0, 0], lookAt: "Tgt" }]);
  check("lookAt: 対象の位置を向く回転が決まる(camera (10,0,0) → (0,0,10): yaw = atan2(-10,10) = -45)", nearV(r.entities[1].rotation, [0, -45, 0]), r.entities[1].rotation);
  r = solve([{ name: "P", kind: "fps_player", at: [0, null, -5] }]);
  check("fps_player は本体 + カメラの 2 体に展開(本体に characterController・y 既定 1.2・カメラは +0.6)", r.entities.length === 2 && r.entities[0].components.characterController?.radius === 0.4 && nearV(at(r, "P"), [0, 1.2, -5]) && nearV(at(r, "PCamera"), [0, 1.8, -5]), r.entities.map((e: any) => [e.name, e.position]));
  r = solve([{ name: "X", kind: "prefab", prefab: "prefabs/crate.prefab", place: { ground: true } }]);
  check("大きさが分からない prefab を相対配置すると E_SPEC_BOUNDS_UNKNOWN(bounds を書く案内)", r.issues.some((i) => i.code === "E_SPEC_BOUNDS_UNKNOWN"), r.issues);
  r = solve([{ name: "X", kind: "prefab", prefab: "prefabs/crate.prefab", bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, place: { ground: true } }]);
  check("prefab に bounds を書けば解ける", r.issues.length === 0 && nearV(at(r, "X"), [0, 0, 0]));
}

// ── [4] 差分計画と適用 ──────────────────────────────────────────
console.log("[4] 差分計画と適用(冪等・最小差分・plan は書かない・prune の所有者判定)");
const SIMPLE: any = { version: 1, name: "simple", entities: [{ name: "LVL_Floor", kind: "box", size: [4, 0.2, 4], group: "LVL", at: [0, -0.1, 0] }] };
const ARENA: any = {
  version: 1, name: "arena",
  entities: [
    { name: "LVL_Floor", kind: "plane", size: [20, 20], group: "LVL", at: [0, 0, 0], color: "#444444" },
    { name: "LVL_Wall_N", kind: "box", size: [20, 3, 0.4], group: "LVL", at: [0, null, 10], place: { on: "LVL_Floor" }, components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } } },
    { name: "ENV_Pillar", kind: "box", size: [0.6, 3, 0.6], group: "ENV", pattern: { type: "ring", count: 6, radius: 4, origin: [0, 0, 0] }, place: { on: "LVL_Floor" }, tags: ["pillar"] },
    { name: "LGT_Sun", kind: "light", light: "directional", group: "LGT", rotation: [-50, 30, 0], components: { directionalLight: { intensity: 1.5 } } },
    { name: "GP_Player", kind: "fps_player", group: "GP", at: [0, null, -8] },
  ],
};
{
  const t = await env();
  const before = t.sim.hash();
  const pl = await t.run({ spec: ARENA, mode: "plan" });
  check("plan: 作成 11 体(床・壁・柱 6・太陽・プレイヤー 2。グループ根 4 は暗黙で別扱い)・エンジンに何も書いていない", pl.ok && data(pl).plan.summary.create === 11 && t.sim.hash() === before && t.writes().length === 0, [data(pl).plan?.summary, t.writes().slice(0, 3)]);
  check("plan は理由・コストを持つ(cost.engineCalls / waves)・specRef を返す", pl.ok && data(pl).plan.cost.engineCalls > 10 && data(pl).plan.cost.waves >= 4 && typeof data(pl).specRef === "string", data(pl).plan?.cost);
  check("plan の create の各行に理由", pl.ok && data(pl).plan.create.every((c: any) => typeof c.reason === "string" && c.reason.length > 3));
  const ap = await t.run({ spec: ARENA });
  const d = data(ap);
  check("apply: 成功・created 11・verify.pass・commit(1 トランザクション)", ap.ok && d.result.created === 11 && d.verify.pass === true && d.transaction.committed === true && t.sim.state.tx === null, d);
  const names = t.sim.state.entities.map((e: any) => e.name);
  check("グループ根(LVL / ENV / LIGHT / GAMEPLAY)が暗黙に作られ、子はその下(親子)", ["LVL", "ENV", "LIGHT", "GAMEPLAY"].every((g) => names.includes(g)) && t.sim.state.entities.find((e: any) => e.name === "ENV_Pillar_03")?.parent === t.sim.state.entities.find((e: any) => e.name === "ENV")?.id, names);
  const pil = t.sim.state.entities.find((e: any) => e.name === "ENV_Pillar_01");
  check("柱は床の上に載る(y=1.5)・tags と所有者の印(__spec)が入る", nearV(pil.transform.position, [0, 1.5, 4]) && pil.tags?.[0] === "pillar" && pil.data?.__spec?.v === "arena", pil);
  const wall = t.sim.state.entities.find((e: any) => e.name === "LVL_Wall_N");
  check("components(rigidBody / boxCollider)と at の null 軸が反映される", wall.comps.rigidBody?.motionType === 0 && nearV(wall.transform.position, [0, 1.5, 10]), wall);
  const hash1 = t.sim.hash();
  const c00 = t.sim.state.calls.length;
  const ap2 = await t.run({ spec: ARENA });
  const d2 = data(ap2);
  check("冪等: 同じ仕様を再適用 → created 0 / updated 0 / unchanged 全部・シーンの hash 不変・書き込み 0", ap2.ok && d2.result.created === 0 && d2.result.updated === 0 && d2.result.unchanged === 11 && d2.idempotent === true && t.sim.hash() === hash1, d2.result);
  const w2 = t.sim.state.calls.slice(c00).filter((c: any) => /^(create_|spawn_|set_|delete_|transaction_|attach_|snap_)/.test(c.method));
  check("2 回目はトランザクションを開かず、書き込み系の呼び出しが 1 つも無い", !w2.some((c: any) => c.method.startsWith("transaction_")) && w2.length === 0, w2.slice(0, 4));

  // 最小差分: 1 つの値を直す
  const spec2 = JSON.parse(JSON.stringify(ARENA));
  spec2.entities[3].components.directionalLight.intensity = 2.5;
  spec2.entities[0].color = "#ff0000";
  const p3 = await t.run({ spec: spec2, mode: "plan" });
  check("1 行直すと update は 2 体だけ(太陽の intensity と床の color)・unchanged は残り 9", p3.ok && data(p3).plan.summary.update === 2 && data(p3).plan.summary.create === 0 && data(p3).plan.summary.unchanged === 9, data(p3).plan?.summary);
  const chg = data(p3).plan.update.find((u: any) => u.name === "LGT_Sun");
  check("update は変更前後の値を持つ(changes[].from / to)", chg?.changes?.[0]?.field === "components.directionalLight.intensity" && chg.changes[0].from === 1.5 && chg.changes[0].to === 2.5, chg);
  const c0 = t.sim.state.calls.length;
  const ap3 = await t.run({ spec: spec2 });
  const ws = t.sim.state.calls.slice(c0).filter((c: any) => /^(create_|spawn_|set_|delete_|attach_|snap_)/.test(c.method));
  check("適用した書き込みは最小(set_component 1 + set_color 1 + data 2 ...)で create / delete は無い", ap3.ok && data(ap3).result.updated === 2 && !ws.some((c: any) => /^(create_|spawn_|delete_)/.test(c.method)) && ws.length <= 6, ws.map((c: any) => c.method));
  check("再適用後の値が読み戻せる", t.sim.state.entities.find((e: any) => e.name === "LGT_Sun").comps.directionalLight.intensity === 2.5);

  // prune の所有者判定
  await t.engine.call("create_entity", { type: "box", name: "HandMade", position: [50, 0.5, 50] });
  const spec3 = JSON.parse(JSON.stringify(spec2));
  spec3.entities.splice(1, 1); // 壁を消す
  spec3.entities[1].pattern.count = 4; // 柱 6 → 4
  const p4 = await t.run({ spec: spec3, mode: "plan" });
  check("prune なしの plan: delete 0・孤児(壁・柱 5,6)を warnings に列挙", p4.ok && data(p4).plan.summary.delete === 0 && data(p4).plan.orphans.length === 3 && data(p4).plan.warnings.some((w: string) => /prune/.test(w)), data(p4).plan);
  const p5 = await t.run({ spec: spec3, mode: "plan", prune: true });
  check("prune:true の plan: 壁と柱 2 体を delete(手で置いた HandMade は対象外)", p5.ok && data(p5).plan.summary.delete === 3 && !data(p5).plan.delete.some((x: any) => x.name === "HandMade"), data(p5).plan.delete);
  const a5 = await t.run({ spec: spec3, prune: true });
  const names5 = t.sim.state.entities.map((e: any) => e.name);
  check("prune 適用: 壁・柱 05/06 が消え、HandMade と他は残る", a5.ok && !names5.includes("LVL_Wall_N") && !names5.includes("ENV_Pillar_05") && !names5.includes("ENV_Pillar_06") && names5.includes("HandMade") && names5.includes("ENV_Pillar_04"), names5);
  // 別の仕様名の物は消さない
  const other = { version: 1, name: "other", entities: [{ name: "OTHER_Box", kind: "box", at: [30, 0.5, 30] }] };
  await t.run({ spec: other });
  const a6 = await t.run({ spec: spec3, prune: true });
  check("別の仕様('other')が作った物は prune の対象外", a6.ok && t.sim.state.entities.some((e: any) => e.name === "OTHER_Box") && data(a6).result.deleted === 0, data(a6).result);

  // 種別変更(作り直し)
  const spec4 = JSON.parse(JSON.stringify(spec3));
  spec4.entities[0].kind = "box"; spec4.entities[0].size = [20, 0.2, 20];
  const a7 = await t.run({ spec: spec4 });
  const fl = t.sim.state.entities.find((e: any) => e.name === "LVL_Floor");
  check("種別が plane → box に変わると作り直す(replace)・値も仕様どおり", a7.ok && data(a7).result.replaced === 1 && fl.primitive === "box" && nearV(fl.transform.scale, [20, 0.2, 20]), data(a7).result);
  // 親を持つ物の種別変更は自動ではしない
  const specKids = { version: 1, name: "kids", entities: [{ name: "Parent", kind: "empty" }, { name: "Child", kind: "box", parent: "Parent" }] };
  await t.run({ spec: specKids, verify: false });
  const a8 = await t.run({ verify: false, spec: { ...specKids, entities: [{ name: "Parent", kind: "box" }, { name: "Child", kind: "box", parent: "Parent" }] } });
  check("子を持つエンティティの種別変更は E_SPEC_KIND_CHANGE で止める(子が一緒に消えるため)", !a8.ok && codes(a8).includes("E_SPEC_KIND_CHANGE") && t.sim.state.entities.some((e: any) => e.name === "Child"), codes(a8));
}

// ── [5] ロールバックと検証の specPatch ─────────────────────────────
console.log("[5] ロールバック(途中失敗・検証失敗)と specPatch");
{
  const t = await env();
  await t.engine.call("create_entity", { type: "box", name: "Pre", position: [40, 0.5, 40] });
  const h0 = t.sim.hash();
  t.sim.failNext("set_component", { name: "ENV_Pillar_03" });
  const r = await t.run({ spec: ARENA });
  check("途中(柱 03 の set_component)で失敗 → E_VALIDATION_FAILED(stage:apply)・ロールバックで hash が元に戻る(変更ゼロ)", !r.ok && r.stage === "apply" && t.sim.hash() === h0 && t.sim.state.tx === null, !r.ok ? [r.stage, r.message] : "ok");
  check("失敗は transaction.rolledBack と失敗した step を返す", !r.ok && (data(r).transaction.rolledBack === true) && data(r).transaction.failedSteps?.[0]?.entity === "ENV_Pillar_03", data(r).transaction);
  const issue = !r.ok ? r.issues[0] : null;
  check("失敗の issue は仕様の path(柱のテンプレート /entities/2)と、その部品を外す specPatch を持つ", issue?.path === "/entities/2" && !!issue, issue);
  t.sim.clearFailures();
  const ok = await t.run({ spec: ARENA });
  check("失敗を直した(failNext 解除)後は同じ仕様が通る", ok.ok && data(ok).result.created === 11, ok.ok ? data(ok).result : [ok.stage, ok.message]);

  // 検証失敗(OVERLAP / DUPLICATE)→ ロールバック → specPatch → 撃ち直して通る
  const t2 = await env();
  const bad = { version: 1, name: "bad", entities: [{ name: "LVL_Floor", kind: "plane", size: [10, 10], group: "LVL" }, { name: "LVL_A", kind: "box", size: 1, group: "LVL", at: [0, 0.5, 0] }, { name: "LVL_B", kind: "box", size: 1, group: "LVL", at: [0, 0.5, 0] }] };
  const h1 = t2.sim.hash();
  const r2 = await t2.run({ spec: bad });
  check("同じ位置に重ねた 2 個 → 検証(layout)が DUPLICATE を検出 → ロールバック(hash 元通り)", !r2.ok && r2.stage === "verify" && t2.sim.hash() === h1 && codes(r2).includes("E_LAYOUT_DUPLICATE"), !r2.ok ? [r2.stage, codes(r2)] : "ok");
  const dupIssue = issuesOf(r2).find((i) => i.code === "E_LAYOUT_DUPLICATE");
  check("DUPLICATE の issue: 対象は後ろの LVL_B(/entities/2)・specPatch は remove", dupIssue?.entity === "LVL_B" && dupIssue.path === "/entities/2" && dupIssue.specPatch?.[0]?.op === "remove", dupIssue);
  const patch = !r2.ok ? r2.specPatch : [];
  const retry = await t2.run({ specRef: !r2.ok ? r2.specRef : undefined, patch });
  check("specPatch だけを {specRef, patch} で撃ち直す → 通る(layout errors 0)", retry.ok && data(retry).verify.pass === true && t2.sim.state.entities.some((e: any) => e.name === "LVL_A") && !t2.sim.state.entities.some((e: any) => e.name === "LVL_B"), data(retry));
  // 浮き(FLOATING)は warn(適用は通り、warnings に specPatch)
  const t3 = await env();
  const fl = await t3.run({ spec: { version: 1, name: "fl", entities: [{ name: "LVL_Floor", kind: "plane", size: [10, 10], group: "LVL" }, { name: "ENV_Box", kind: "box", size: 1, group: "ENV", at: [0, 3, 0] }] } });
  check("浮いた箱は warning(適用は通る)・warnings に place.snap の specPatch", fl.ok && data(fl).verify.warnings.some((w: any) => w.code === "E_LAYOUT_FLOATING" && w.specPatch?.[0]?.value?.snap === true), data(fl).verify);
  const snapPatch = data(fl).verify.specPatch;
  const fl2 = await t3.run({ specRef: data(fl).specRef, patch: snapPatch });
  const bx = t3.sim.state.entities.find((e: any) => e.name === "ENV_Box");
  check("その specPatch を撃つと snap_to_ground が掛かり、床の上(y=0.5)に落ちる", fl2.ok && near(bx.transform.position[1], 0.5, 1e-3), bx.transform.position);
  const fl3 = await t3.run({ specRef: data(fl2).specRef });
  check("snap 後の再適用は冪等(unchanged)", fl3.ok && data(fl3).result.updated === 0 && data(fl3).result.created === 0, data(fl3).result);
  // verify:false は検証を省く
  const t4 = await env();
  const nv = await t4.run({ spec: bad, verify: false });
  check("verify:false なら重なりがあっても適用される(検証を省く)", nv.ok && data(nv).verify.checks.length === 0);
  // 命名規約の warn → specPatch(改名 + 参照の書き換え)
  const t5 = await env();
  const nm = await t5.run({ spec: { version: 1, name: "nm", entities: [{ name: "Floor", kind: "plane", size: [10, 10] }, { name: "Crate", kind: "box", size: 1, place: { on: "Floor" } }] } });
  const nw = data(nm).verify.warnings;
  check("命名規約(接頭辞なし)は warn: NO_PREFIX の specPatch は改名 + place.on の参照書き換え", nm.ok && nw.some((w: any) => w.code === "E_NAMING_NO_PREFIX" && w.specPatch.some((o: any) => o.path === "/entities/1/place/on")), nw);
  const nm2 = await t5.run({ specRef: data(nm).specRef, patch: data(nm).verify.specPatch });
  check("改名の specPatch を撃つと、規約名(LVL_Floor など)で作り直される(warn 0)", nm2.ok && data(nm2).verify.warnings.length === 0 && t5.sim.state.entities.some((e: any) => /^LVL_/.test(e.name)), [data(nm2).verify.warnings, t5.sim.state.entities.map((e: any) => e.name)]);
  // 検証エラー(仕様)では 1 つも書かない
  const t6 = await env();
  const h6 = t6.sim.hash();
  const inv = await t6.run({ spec: { version: 1, entities: [{ name: "A", kind: "cube" }, { name: "B", kind: "model", model: "models/x.glb" }] } });
  check("仕様の検証エラー → stage:validate・エンジンに書き込み 0・specPatch は全 issue のぶん", !inv.ok && inv.stage === "validate" && t6.writes().length === 0 && t6.sim.hash() === h6 && inv.specPatch.length >= 1 && inv.issues.length === 2, !inv.ok ? [inv.stage, inv.issues.length] : "ok");
  const fixed = await t6.run({ specRef: !inv.ok ? inv.specRef : undefined, patch: !inv.ok ? inv.specPatch : [] });
  check("specPatch を撃ち直すと通る(cube → box、未知モデル → 近いモデルまたは box への置換)", fixed.ok, !fixed.ok ? [fixed.stage, fixed.issues.map((i) => i.message)] : "");
  // Play 中は適用できない(plan は撃てる)
  {
    const t7 = await env();
    t7.mock.state.mode = "Playing";
    const h7 = t7.sim.hash();
    const pm = await t7.run({ spec: SIMPLE, mode: "apply" });
    check("Play 中の apply は E_MODE_CONFLICT(何も書かない)・fix は dx12_stop", !pm.ok && pm.code === "E_MODE_CONFLICT" && t7.sim.hash() === h7 && t7.writes().length === 0, !pm.ok ? pm.code : "ok");
    const pp = await t7.run({ spec: SIMPLE, mode: "plan" });
    check("Play 中でも plan は撃てる", pp.ok && data(pp).mode === "plan");
    t7.mock.state.mode = "Editor";
  }
  // specRef が無い
  const nr = await t6.run({ specRef: "zzzzzzzzzzzz", patch: [] });
  check("知らない specRef は spec を渡し直す案内", !nr.ok && nr.issues[0].code === "E_NOT_FOUND");
  const bp = await t6.run({ specRef: !inv.ok ? inv.specRef : undefined, patch: [{ op: "replace", path: "/entities/9/name", value: "x" }] });
  check("壊れた patch は E_BAD_PATCH(どの op か)", !bp.ok && bp.issues[0].code === "E_BAD_PATCH" && /patch\[0\]/.test(bp.issues[0].message), !bp.ok ? bp.issues[0] : "");
}

// ── [6] 往復(シーン → 仕様 → 適用)──────────────────────────────
console.log("[6] 往復(現在のシーン → 仕様 → 適用で同じシーン)");
{
  const RICH: any = {
    version: 1, name: "rich", lighting: undefined,
    entities: [
      { name: "LVL_Floor", kind: "plane", size: [16, 16], group: "LVL", at: [0, 0, 0], color: "#334455", material: { roughness: 0.8, metallic: 0.1 } },
      { name: "LVL_Table", kind: "box", size: [2, 0.8, 1], group: "LVL", place: { on: "LVL_Floor" }, at: [1, null, 1], components: { rigidBody: { motionType: 0 }, boxCollider: { halfExtents: [0.5, 0.5, 0.5] } }, texture: { albedo: "textures/wood.png" }, material: { alphaMode: "opaque" } },
      { name: "ENV_Lamp", kind: "light", light: "point", group: "LGT", place: { on: "LVL_Table" }, at: [1, null, 1], components: { pointLight: { intensity: 4, range: 8 } }, data: { label: "lamp", power: 4, on: true, pos: [1, 2, 3] } },
      { name: "ENV_Stone", kind: "model", model: "models/cube1m.glb", group: "ENV", pattern: { type: "grid", count: [2, 2], spacing: [3, 3], origin: [-4, 0, -4] }, place: { ground: true }, tags: ["stone"] },
      { name: "ENV_Ball", kind: "sphere", size: 0.6, group: "ENV", at: [3, 3, 3], place: { snap: true } },
      { name: "CAM_Main", kind: "camera", group: "CAM", at: [6, 4, -6], lookAt: "LVL_Table", components: { camera: { fovDegrees: 50 } } },
      { name: "GP_Player", kind: "fps_player", group: "GP", at: [-6, null, -6] },
      { name: "ENV_Script", kind: "empty", group: "ENV", script: { path: "components/Spin.lua", props: { speed: 90 } } },
    ],
  };
  const a = await env();
  const r1 = await a.run({ spec: RICH, verify: { layout: "off", naming: "off" } });
  check("複雑な仕様(model・pattern・snap・lookAt・texture・script props・data・tags)が適用できる", r1.ok, !r1.ok ? [r1.stage, r1.message, r1.issues.slice(0, 3).map((i) => i.message)] : "");
  const hashA = (await digestScene(a.engine as any)).hash;
  const ex = await exportScene(a.engine as any, { owned: true });
  check("export: owned で 全エンティティ(pattern は展開後)・仕様名 'rich' を復元", ex.spec.name === "rich" && ex.entityCount === a.sim.state.entities.filter((e: any) => e.data?.__spec).length && ex.entityCount === 12, [ex.spec.name, ex.entityCount]);
  const byName = new Map((ex.spec.entities ?? []).map((e: any) => [e.name, e as any]));
  check("export: 読み戻せない部分(texture・alphaMode・script props・lookAt・snap)が __o から復元される", byName.get("LVL_Table")?.texture?.albedo === "textures/wood.png" && byName.get("LVL_Table")?.material?.alphaMode === "opaque" && byName.get("ENV_Script")?.script?.props?.speed === 90 && byName.get("CAM_Main")?.lookAt === "LVL_Table" && byName.get("ENV_Ball")?.place?.snap === true, [byName.get("LVL_Table"), byName.get("CAM_Main")]);
  check("export: グループの根は group キーになり、エディタ内部の Grid は出さない", byName.get("LVL_Floor")?.group === "LVL" && !byName.has("Grid") && !byName.has("LVL"), [...byName.keys()]);
  // 別のエンジン(空のシーン)へ適用して同じシーンになるか
  const b = await env();
  const r2 = await b.run({ spec: ex.spec as any, verify: { layout: "off", naming: "off" } });
  check("往復: 書き出した仕様を空のシーンへ適用できる", r2.ok, !r2.ok ? [r2.stage, r2.message, r2.issues.slice(0, 3).map((i) => `${i.path} ${i.message}`)] : "");
  const digestB = await digestScene(b.engine as any);
  check("往復: シーンのダイジェストが一致(名前順・entityId と guid 以外の全項目: transform・部品・data・tags・親子)", digestB.hash === hashA, [hashA, digestB.hash]);
  const r3 = await b.run({ spec: ex.spec as any, verify: false });
  check("往復した仕様を再適用しても冪等(unchanged)", r3.ok && data(r3).result.created === 0 && data(r3).result.updated === 0, data(r3).result);
  const ex2 = await exportScene(b.engine as any, { owned: true });
  check("2 周目の export は 1 周目と同じ仕様(不動点)", j(ex2.spec) === j(ex.spec));
  // 手で作ったシーン(所有者の印なし)も仕様に起こせる
  const c = await env();
  await c.engine.call("create_entity", { type: "box", name: "Hand1", position: [1, 0.5, 2] });
  await c.engine.call("set_transform", { name: "Hand1", scale: [2, 1, 2], rotation: [0, 30, 0] });
  await c.engine.call("set_color", { name: "Hand1", color: [1, 0, 0] });
  const exh = await exportScene(c.engine as any, {});
  check("手で作ったシーンを export → kind / at / rotation / scale / color の仕様になる", exh.entityCount === 1 && exh.spec.entities?.[0]?.kind === "box" && nearV(exh.spec.entities?.[0]?.at as any, [1, 0.5, 2]) && nearV(exh.spec.entities?.[0]?.rotation as any, [0, 30, 0]) && nearV(exh.spec.entities?.[0]?.scale as any, [2, 1, 2]) && nearV(exh.spec.entities?.[0]?.color as any, [1, 0, 0]) && exh.spec.name === "exported", exh.spec);
  const d2 = await env();
  const rr = await d2.run({ spec: exh.spec as any, verify: false });
  check("その仕様を空のシーンへ適用 → 同じ見た目の箱ができる", rr.ok && j(d2.sim.state.entities.find((e: any) => e.name === "Hand1")?.transform) === j(c.sim.state.entities.find((e: any) => e.name === "Hand1")?.transform));
}

// ── [7] 追加の仕様(id・外部の基準・管理する項目・collider・設定の優先順位・色・パターン)──
console.log("[7] id の追従・外部の基準・管理する項目・collider・設定の優先順位・sRGB・パターン");
{
  // id: name を変えても同じ実体(guid 不変)に追従。複製にも孤児にもならない
  const t = await env();
  const s1: any = { version: 1, name: "ren", entities: [{ name: "Floor", id: "floor", kind: "box", size: [6, 0.2, 6], at: [0, -0.1, 0] }, { name: "Crate", id: "crate", kind: "box", size: 1, place: { on: "Floor" } }] };
  await t.run({ spec: s1, verify: false });
  const g0 = t.sim.state.entities.find((e: any) => e.name === "Crate").guid;
  const s2 = JSON.parse(JSON.stringify(s1)); s2.entities[0].name = "LVL_Floor"; s2.entities[1].name = "ENV_Crate"; s2.entities[1].place.on = "LVL_Floor";
  const pl = await t.run({ spec: s2, mode: "plan" });
  check("id: name を変えた plan は create 0 / update 2 / delete 0・孤児 0(改名は変更前後つき)", pl.ok && data(pl).plan.summary.create === 0 && data(pl).plan.summary.update === 2 && data(pl).plan.orphans.length === 0 && data(pl).plan.update[0].changes[0].field === "name", data(pl).plan?.summary);
  const rn = await t.run({ spec: s2, verify: false });
  const cr = t.sim.state.entities.find((e: any) => e.name === "ENV_Crate");
  check("id: 適用すると同じ実体(guid 不変)が改名され、旧名は残らない", rn.ok && cr?.guid === g0 && !t.sim.state.entities.some((e: any) => e.name === "Crate"), rn.ok ? "" : rn.message);
  const s3 = JSON.parse(JSON.stringify(s2)); s3.entities[1].name = "LVL_Floor";
  const cf = await t.run({ spec: s3, mode: "plan", verify: false });
  check("id: 改名先の名前を別の物が使っていると E_SPEC_RENAME_CONFLICT(重複 name は検証でも止まる)", !cf.ok && (codes(cf).includes("E_SPEC_RENAME_CONFLICT") || codes(cf).includes("E_SPEC_DUPLICATE_NAME")), codes(cf));

  // 外部(仕様の外・手で置いた物)を基準にできる: get_bounds の実測で解く
  const t2 = await env();
  await t2.engine.call("create_entity", { type: "box", name: "HandBox", position: [10, 1, 10] });
  await t2.engine.call("set_transform", { name: "HandBox", scale: [2, 2, 2] });
  const ex: any = { version: 1, name: "ext", entities: [{ name: "ENV_Next", kind: "box", size: 1, place: { relativeTo: "HandBox", side: "right", gap: 0.5 } }, { name: "CAM_View", kind: "camera", at: [0, 3, 0], lookAt: "HandBox" }] };
  const re = await t2.run({ spec: ex, verify: false, returnResolved: true } as any);
  const nx = t2.sim.state.entities.find((e: any) => e.name === "ENV_Next");
  check("外部の基準: HandBox(x 9..11・y 0..2)の右 0.5m → 箱(幅 1)の中心 x=12(y は底揃えで 0.5)", re.ok && nearV(nx.transform.position, [12, 0.5, 10]), nx?.transform);
  const cam = t2.sim.state.entities.find((e: any) => e.name === "CAM_View");
  check("外部への lookAt(対象の位置)が回転に反映される", cam.transform.rotation[1] > 0 && cam.transform.rotation[0] > 0, cam?.transform.rotation);
  const badExt = await t2.run({ spec: { version: 1, entities: [{ name: "ENV_X", kind: "box", place: { relativeTo: "HandBx", side: "right" } }] }, verify: false });
  check("外部の基準の打ち間違いも近い名前つき(シーンの名前も候補)", !badExt.ok && issuesOf(badExt)[0]?.didYouMean?.[0] === "HandBox", issuesOf(badExt)[0]);

  // 管理する項目: 書かなかった rotation / scale は手で変えた値を尊重する
  const t3 = await env();
  const m1: any = { version: 1, name: "mg", entities: [{ name: "ENV_Crate", kind: "box", size: 1, at: [1, 0.5, 1] }] };
  await t3.run({ spec: m1, verify: false });
  await t3.engine.call("set_transform", { name: "ENV_Crate", rotation: [0, 33, 0], position: [1, 0.5, 4] });   // 手で回し、z を動かす(仕様は z を管理している)
  const m2 = await t3.run({ spec: m1, verify: false });
  const cc = t3.sim.state.entities.find((e: any) => e.name === "ENV_Crate");
  check("rotation を書かなければ手で回した値(33 度)を尊重・at を書いた軸(z)は仕様どおりに戻す", m2.ok && data(m2).result.updated === 1 && nearV(cc.transform.rotation, [0, 33, 0]) && nearV(cc.transform.position, [1, 0.5, 1]), [data(m2).result, cc?.transform]);
  const m3 = await t3.run({ spec: { ...m1, entities: [{ ...m1.entities[0], at: [1, null, 1] }] }, verify: false });
  await t3.engine.call("set_transform", { name: "ENV_Crate", position: [1, 7, 1] });
  const m4 = await t3.run({ spec: { ...m1, entities: [{ ...m1.entities[0], at: [1, null, 1] }] }, verify: false });
  check("at の null 軸(y)は管理しない: 手で変えた y=7 は unchanged のまま", m3.ok && m4.ok && data(m4).result.updated === 0 && near(t3.sim.state.entities.find((e: any) => e.name === "ENV_Crate").transform.position[1], 7), data(m4).result);

  // collider の略記
  const t4 = await env();
  const cs: any = { version: 1, name: "col", entities: [{ name: "LVL_Box", kind: "box", size: 2, collider: "static" }, { name: "ENV_Ball", kind: "sphere", size: 1, collider: "dynamic", at: [4, 0.5, 0] }, { name: "ENV_Tall", kind: "model", model: "models/tall.glb", collider: "static", at: [8, 0, 0] }, { name: "ENV_Own", kind: "box", collider: "static", at: [12, 0.5, 0], components: { rigidBody: { motionType: 1 } } }] };
  const cr2 = await t4.run({ spec: cs, verify: false });
  const g = (n: string) => t4.sim.state.entities.find((e: any) => e.name === n);
  check("collider:'static' = rigidBody(motionType 0)+ boxCollider / 'dynamic' の球 = motionType 2 + sphereCollider(半径 0.5)", cr2.ok && g("LVL_Box").comps.rigidBody.motionType === 0 && nearV(g("LVL_Box").comps.boxCollider.halfExtents, [0.5, 0.5, 0.5]) && g("ENV_Ball").comps.rigidBody.motionType === 2 && g("ENV_Ball").comps.sphereCollider.radius === 0.5, [g("LVL_Box")?.comps, g("ENV_Ball")?.comps]);
  check("モデルの collider は実寸の AABB から(高さ 3・底が原点 → halfExtents [0.5,1.5,0.5]・offset [0,1.5,0])・components が優先", nearV(g("ENV_Tall").comps.boxCollider.halfExtents, [0.5, 1.5, 0.5]) && nearV(g("ENV_Tall").comps.boxCollider.offset, [0, 1.5, 0]) && g("ENV_Own").comps.rigidBody.motionType === 1, [g("ENV_Tall")?.comps, g("ENV_Own")?.comps.rigidBody]);
  check("collider を light に付けると warn(付けない)", validateSpec({ version: 1, entities: [{ name: "L", kind: "light", light: "point", collider: "static" }] }, {}).issues.some((i) => i.code === "E_SPEC_CONFLICT" && i.severity === "warn"));

  // 設定(lighting)と太陽の明示値: 設定の後にもう一度明示値を書く → 冪等
  const t5 = await env();
  const ls: any = { version: 1, name: "ls", lighting: { preset: "day" }, entities: [{ name: "LGT_Sun", kind: "light", light: "directional", group: "LGT", rotation: [-40, 10, 0], components: { directionalLight: { intensity: 1.9 } } }] };
  const l1 = await t5.run({ spec: ls, verify: false });
  const sun = t5.sim.state.entities.find((e: any) => e.name === "LGT_Sun");
  const dg1 = await digestScene(t5.engine as any);
  check("lighting.preset + 太陽の明示値: 明示値(intensity 1.9・rotation)が設定より優先される", l1.ok && near(sun.comps.directionalLight.intensity, 1.9, 1e-5) && nearV(sun.transform.rotation, [-40, 10, 0]), sun?.comps.directionalLight);
  const l2 = await t5.run({ spec: ls, verify: false });
  const dg2 = await digestScene(t5.engine as any);
  check("再適用で冪等(created 0 / updated 0・ダイジェスト不変)", l2.ok && data(l2).result.created === 0 && data(l2).result.updated === 0 && dg1.hash === dg2.hash, data(l2).result);
  check("設定は検証の後: 検証失敗のときは lighting に触れない(sim.settings.lighting が空のまま)", await (async () => {
    const t6 = await env();
    const bad2 = JSON.parse(JSON.stringify(ls)); bad2.entities.push({ name: "LVL_A", kind: "box", at: [0, 0.5, 0] }, { name: "LVL_B", kind: "box", at: [0, 0.5, 0] });
    const rb = await t6.run({ spec: bad2 });
    return !rb.ok && rb.stage === "verify" && !t6.sim.state.settings.lighting;
  })());

  // ナビメッシュ: tx の中で検証の前に焼き、検証失敗でロールバックしたら焼き直す
  const t7 = await env();
  const nv: any = { version: 1, name: "nv", navmesh: { build: true }, verify: { reachable: { from: "GP_A", to: "GP_B" } }, entities: [{ name: "GP_A", kind: "empty", at: [0, 0, 0] }, { name: "GP_B", kind: "empty", at: [5, 0, 0] }] };
  const r7 = await runSceneSpec({ engine: t7.engine as any, cache: new SpecCache(), callTool: async () => ({ ok: true, data: { reachable: false, reason: "テスト" } }) }, { spec: nv });
  const navCalls = t7.sim.state.calls.filter((c: any) => c.method === "navmesh_build").length;
  const idx = (m: string) => t7.sim.state.calls.findIndex((c: any) => c.method === m);
  check("到達不能でロールバックしたら、戻したシーンでナビメッシュを焼き直す(navmesh_build が 2 回)・最初の 1 回は検証(validate_layout)の前", !r7.ok && r7.stage === "verify" && navCalls === 2 && idx("navmesh_build") < idx("validate_layout"), [navCalls, r7.ok]);

  // 色: "#rrggbb" は見たままの色(sRGB → リニア)・配列は生の値
  const t8 = await env();
  await t8.run({ spec: { version: 1, entities: [{ name: "A", kind: "box", color: "#808080" }, { name: "B", kind: "box", color: [0.5, 0.5, 0.5], at: [3, 0, 0] }] }, verify: false });
  const ca = t8.sim.state.entities.find((e: any) => e.name === "A").color, cb = t8.sim.state.entities.find((e: any) => e.name === "B").color;
  check("color '#808080' はリニア 0.2159 で送られる・[0.5,0.5,0.5] はそのまま", nearV(ca, [0.2159, 0.2159, 0.2159], 2e-3) && nearV(cb, [0.5, 0.5, 0.5], 1e-6), [ca, cb]);

  // パターン: line の null 軸・yaw の乱数列が別(同じ seed の位置は同じ)
  const rl = resolveSpec({ version: 1, entities: [{ name: "Floor", kind: "box", size: [20, 1, 20], at: [0, -0.5, 0] }, { name: "S", kind: "box", size: [1, 0.2, 1], pattern: { type: "line", count: 3, from: [0, null, -5], to: [0, null, 5] }, place: { on: "Floor" } }] } as any, { assetBounds: () => undefined });
  check("line の from/to の null 軸は place が決める(y = 床の上 0.1)", rl.entities.filter((e) => e.name.startsWith("S_")).length === 3 && rl.entities.filter((e) => e.name.startsWith("S_")).every((e) => near(e.position![1], 0.1)) && nearV(rl.entities[3].position as any, [0, 0.1, 5]), rl.entities.map((e) => e.position));
  const mk = (extra: any) => resolveSpec({ version: 1, entities: [{ name: "A", kind: "box", size: 1, pattern: { type: "scatter", count: 8, area: [-10, -10, 10, 10], seed: 5, minSpacing: 2, ...extra } }] } as any, { assetBounds: () => undefined }).entities.map((e) => e.position);
  check("同じ seed の scatter は、yaw / scaleRange の有無に関わらず同じ位置(幹と葉を重ねられる)", j(mk({})) === j(mk({ yaw: "random", scaleRange: [0.5, 2] })));
}

console.log(failed === 0 ? `\n全部通過: ${total}/${total}` : `\n失敗: ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
