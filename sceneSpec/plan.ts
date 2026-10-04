// 現在のシーンの読み取りと、仕様との差分計画(M11)。
//
//   ・キーは「エンティティ名」。同じ仕様を 2 回撃っても、2 回目は create:0 / update:0 / unchanged:N(冪等)。
//   ・所有者の印: 作ったエンティティの data に __spec(仕様名)を書く。prune はこの印が自分の仕様名で、いまの仕様に無いものだけを消す
//     (手で置いた物・別の仕様の物は絶対に消さない)。読み戻せない部分(texture など)は __o(JSON)に写して差分に使う。
//   ・差分はエンジンの実測値と仕様の値を許容誤差つきで比べる(位置・スケール 1e-3、回転 0.05 度、float32 の丸めを吸収)。
import { stableJson } from "../guardCtx.ts";
import { angleDiffDeg, type Vec3 } from "./geom.ts";
import type { Resolved } from "./expand.ts";
import { GROUP_ROOT, ID_KEY, OPAQUE_KEY, OWNER_KEY, type SceneSpec, type SpecIssue } from "./types.ts";

export type EngineLike = { call(method: string, params?: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }): Promise<any> };

const CHUNK = 400;
/** 配列の要素を最大 n 個ずつ並列に実行する(結果は入力と同じ順)。エンジンは 1 フレームで溜まった要求を全部処理するので、並列にすると 1 体ごとの往復が消える。 */
export async function pmap<T, R>(items: readonly T[], fn: (x: T, i: number) => Promise<R>, n = CHUNK): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let s = 0; s < items.length; s += n) {
    const part = items.slice(s, s + n);
    const res = await Promise.all(part.map((x, k) => fn(x, s + k)));
    res.forEach((r, k) => { out[s + k] = r; });
  }
  return out;
}

// ── 現在のシーン ────────────────────────────────────────────────
export type ActualEntity = {
  id: number;
  name: string;
  parent?: string;
  componentTypes: string[];
  raw?: any;
};
export type SceneSnapshot = {
  byName: Map<string, ActualEntity>;
  children: Map<string, string[]>;
  sceneGeneration: number | null;
  duplicates: string[];
  count: number;
};

/**
 * 現在のシーンを読む。list_entities(verbose)+ get_hierarchy で名前・親子・コンポーネント型を取り、
 * 仕様に出てくる名前と data を持つもの(所有者の印の候補)だけ get_entity で全文を読む。
 */
export async function readScene(engine: EngineLike, wantNames: Iterable<string>, opts: { readOwners?: boolean } = {}): Promise<SceneSnapshot> {
  const list = await engine.call("list_entities", { verbose: true, limit: 0 });
  const hier = await engine.call("get_hierarchy", { limit: 0 });
  const byName = new Map<string, ActualEntity>();
  const dups: string[] = [];
  const idToName = new Map<number, string>();
  for (const e of (list?.entities ?? []) as any[]) {
    const id = e.entityId ?? e.id;
    if (byName.has(e.name)) { dups.push(e.name); continue; }
    byName.set(e.name, { id, name: e.name, componentTypes: e.componentTypes ?? [] });
    idToName.set(id, e.name);
  }
  const children = new Map<string, string[]>();
  const walk = (node: any, parent?: string) => {
    if (parent !== undefined) {
      const a = byName.get(node.name);
      if (a && idToName.get(node.entityId) === node.name) a.parent = parent;
      const arr = children.get(parent) ?? [];
      arr.push(node.name);
      children.set(parent, arr);
    }
    for (const c of node.children ?? []) walk(c, node.name);
  };
  for (const r of hier?.roots ?? []) walk(r);

  const need = new Set<string>();
  for (const n of wantNames) if (byName.has(n)) need.add(n);
  if (opts.readOwners !== false) for (const [n, a] of byName) if (a.componentTypes.includes("data")) need.add(n);
  await pmap([...need], async (n) => {
    const a = byName.get(n)!;
    a.raw = await engine.call("get_entity", { entity: a.id });
    return null;
  });
  return { byName, children, sceneGeneration: list?.sceneGeneration ?? null, duplicates: dups, count: list?.count ?? byName.size };
}

// ── 期待する状態(仕様)と実測の比較 ─────────────────────────────
const EPS_POS = 1e-3;
const EPS_ROT = 0.05;

const near = (a: number, b: number, eps = EPS_POS) => Math.abs(a - b) <= eps + 1e-5 * Math.abs(b);
const vecNear = (a: unknown, b: Vec3, eps = EPS_POS) => Array.isArray(a) && a.length >= 3 && [0, 1, 2].every((k) => typeof a[k] === "number" && near(a[k], b[k], eps));
/** 部分比較: want の各キーが have に(近似で)含まれるか。 */
export function subsetEq(have: unknown, want: unknown): boolean {
  if (typeof want === "number") return typeof have === "number" && near(have, want, 1e-4);
  if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && want.every((w, i) => subsetEq(have[i], w));
  if (want && typeof want === "object") {
    if (!have || typeof have !== "object") return false;
    return Object.entries(want as Record<string, unknown>).every(([k, w]) => subsetEq((have as any)[k], w));
  }
  return have === want;
}

export type Change = { field: string; from?: unknown; to: unknown };

/** 管理する軸は仕様の値、管理しない軸は現在の値(set_transform は 3 軸まとめて渡すため、手で変えた値を壊さない)。 */
export function mergePosition(r: Resolved, actual: unknown): Vec3 {
  const cur = Array.isArray(actual) && actual.length >= 3 ? (actual as number[]) : [0, 0, 0];
  const mg = r.manage?.position ?? [true, true, true];
  return [0, 1, 2].map((k) => (mg[k] && !(k === 1 && r.yManaged) ? r.position![k] : cur[k])) as Vec3;
}

/** 読み戻せない部分(仕様の texture・alphaMode・script props・lookAt・snap・prefab)の正準 JSON。空なら undefined。 */
export function opaqueOf(r: Resolved): string | undefined {
  const o: Record<string, unknown> = {};
  if (r.texture && Object.keys(r.texture).length) o.texture = r.texture;
  if (r.material?.alphaMode !== undefined) o.alphaMode = r.material.alphaMode;
  if (r.material?.uvScale !== undefined) o.uvScale = r.material.uvScale;
  if (r.script && Object.keys(r.script.props).length) o.props = r.script.props;
  if (r.lookAt !== undefined) o.lookAt = r.lookAt;
  if (r.snap) o.snap = true;
  if (r.prefab) o.prefab = r.prefab;
  return Object.keys(o).length ? stableJson(o) : undefined;
}

/** 実体の種別が仕様と合っているか(合わなければ作り直し)。 */
export function kindMatches(r: Resolved, a: ActualEntity): boolean {
  const raw = a.raw ?? {};
  const types: string[] = raw.componentTypes ?? a.componentTypes ?? [];
  const has = (k: string) => types.includes(k);
  switch (r.kind) {
    case "box": case "sphere": case "plane": return raw.primitive === r.primitive;
    case "model": return raw.meshRenderer?.modelPath === r.model;
    case "prefab": return true; // 印(__o の prefab)で比べる
    case "light": return has(r.light === "directional" ? "directionalLight" : r.light === "spot" ? "spotLight" : "pointLight");
    case "camera": return has("camera");
    case "trigger": return has("trigger");
    case "particle_emitter": return has("particleEmitter");
    case "decal": return has("decal");
    case "ui_canvas": return has("uiCanvas");
    case "ui_image": return has("uiImage");
    case "ui_text": return has("uiText");
    case "ui_button": return has("uiButton");
    case "ui_slider": return has("uiSlider");
    case "ui_toggle": return has("uiToggle");
    case "ui_scrollview": return has("uiScrollView");
    case "empty": case "fps_player": return raw.primitive === undefined && !has("meshRenderer");
    default: return true;
  }
}

const dataVal = (v: unknown): { t: string; v: unknown } => {
  if (typeof v === "number") return { t: "number", v };
  if (typeof v === "boolean") return { t: "bool", v };
  if (typeof v === "string") return { t: "string", v };
  return { t: "vec3", v };
};

/** 仕様の data + 所有者の印 → エンジンの data コンポーネントの値({key:{t,v}})。 */
export function dataPayload(r: Resolved, owner: string): Record<string, { t: string; v: unknown }> {
  const out: Record<string, { t: string; v: unknown }> = {};
  for (const [k, v] of Object.entries(r.data ?? {})) out[k] = dataVal(v);
  out[OWNER_KEY] = { t: "string", v: owner };
  out[ID_KEY] = { t: "string", v: r.id };
  const o = opaqueOf(r);
  if (o !== undefined) out[OPAQUE_KEY] = { t: "string", v: o };
  return out;
}

/** 仕様(1 体)と実測の差。空なら unchanged。 */
export function diffEntity(r: Resolved, a: ActualEntity, owner: string, parentActual: string | undefined): Change[] {
  const raw = a.raw ?? {};
  const ch: Change[] = [];
  const tr = raw.transform ?? {};
  const mg = r.manage ?? { position: [true, true, true] as [boolean, boolean, boolean], rotation: true, scale: true };
  if ((r.parent ?? undefined) !== (parentActual ?? undefined)) ch.push({ field: "parent", from: parentActual ?? null, to: r.parent ?? null });
  if (r.position) {
    // 管理する軸だけ比べる(snap の y はエンジンが決める。at に書かなかった軸・place が解かない軸は手で変えた値を尊重する)
    const axes = [0, 1, 2].filter((k) => mg.position[k] && !(k === 1 && r.yManaged));
    const pos = tr.position;
    if (!Array.isArray(pos) || axes.some((k) => !near(pos[k], r.position![k]))) ch.push({ field: "position", from: pos, to: mergePosition(r, pos) });
  }
  const rot = tr.rotation;
  if (mg.rotation && (!Array.isArray(rot) || [0, 1, 2].some((k) => angleDiffDeg(rot[k], r.rotation[k]) > EPS_ROT))) ch.push({ field: "rotation", from: rot, to: r.rotation });
  if (mg.scale && !vecNear(tr.scale, r.scale)) ch.push({ field: "scale", from: tr.scale, to: r.scale });
  if (r.color && !vecNear(raw.color, r.color, 1e-3)) ch.push({ field: "color", from: raw.color ?? null, to: r.color });
  if (r.material) {
    const m = raw.material ?? {};
    const want: Record<string, unknown> = {};
    if (r.material.metallic !== undefined) want.metallic = r.material.metallic;
    if (r.material.roughness !== undefined) want.roughness = r.material.roughness;
    if (r.material.opacity !== undefined) want.opacity = r.material.opacity;
    if (r.material.emissiveIntensity !== undefined) want.emissiveIntensity = r.material.emissiveIntensity;
    if (r.material.emissive !== undefined) want.emissiveColor = r.material.emissive;
    for (const [k, v] of Object.entries(want)) if (!subsetEq(m[k], v)) ch.push({ field: `material.${k}`, from: m[k], to: v });
  }
  for (const [ck, fields] of Object.entries(r.components)) {
    const have = raw[ck];
    if (have === undefined) { ch.push({ field: `components.${ck}`, from: null, to: fields }); continue; }
    for (const [fk, fv] of Object.entries(fields)) if (!subsetEq(have[fk], fv)) ch.push({ field: `components.${ck}.${fk}`, from: have[fk], to: fv });
  }
  if (r.tags) {
    const have = Array.isArray(raw.tags) ? [...raw.tags].sort() : [];
    const want = [...r.tags].sort();
    if (stableJson(have) !== stableJson(want)) ch.push({ field: "tags", from: raw.tags ?? [], to: r.tags });
  }
  const hd = raw.data ?? {};
  const want = dataPayload(r, owner);
  for (const [k, v] of Object.entries(want)) if (!subsetEq(hd[k], v)) ch.push({ field: k === OWNER_KEY ? "owner" : k === ID_KEY ? "id" : k === OPAQUE_KEY ? "opaque" : `data.${k}`, from: hd[k]?.v ?? null, to: v.v });
  if (opaqueOf(r) === undefined && hd[OPAQUE_KEY] !== undefined) ch.push({ field: "opaque", from: hd[OPAQUE_KEY]?.v, to: null });
  if (r.script) {
    const have = raw.luaScript?.scriptPath;
    if (have !== r.script.path) ch.push({ field: "script", from: have ?? null, to: r.script.path });
  }
  return ch;
}

// ── 実行の手順(Step)と計画 ──────────────────────────────────────
export type Step = {
  /** 波(同じ phase の Step は並列に撃つ。phase の小さい順に 1 つずつ完了を待つ)。 */
  phase: number;
  method: string;
  params: Record<string, unknown>;
  entity?: string;
  /** create 系の結果から entityId を控える。 */
  captureId?: boolean;
};
export const PHASE = { groups: 0, delete: 1, rename: 2, create: 3, parent: 4, transform: 5, props: 6, snap: 7, scriptProps: 8 } as const;

export type PlanEntry = {
  name: string;
  action: "create" | "update" | "replace" | "delete" | "unchanged";
  kind?: string;
  reason: string;
  changes?: Change[];
  impact?: string;
  implicit?: boolean;
  steps: number;
};

export type SettingEntry = { what: string; effect: string; method?: string; params?: Record<string, unknown> };

export type Plan = {
  specName: string;
  summary: { create: number; update: number; replace: number; delete: number; unchanged: number; total: number; settings: number };
  entries: PlanEntry[];
  settings: SettingEntry[];
  /** いまの仕様に無いが、この仕様(同じ名前)が作った物。prune:true で消せる。 */
  orphans: string[];
  cost: { engineCalls: number; waves: number; estimatedMs: number; estimatedFrames: number };
  steps: Step[];
  issues: SpecIssue[];
  warnings: string[];
};

const CREATE_TYPE: Record<string, string> = {
  empty: "empty", camera: "camera", trigger: "trigger", particle_emitter: "particle_emitter", decal: "decal",
  ui_canvas: "ui_canvas", ui_image: "ui_image", ui_text: "ui_text", ui_button: "ui_button", ui_slider: "ui_slider", ui_toggle: "ui_toggle", ui_scrollview: "ui_scrollview",
};

function createStep(r: Resolved): Step {
  const world: Vec3 = r.parent ? [0, 0, 0] : (r.position ?? [0, 0, 0]);
  const base = { name: r.name, position: world };
  if (r.kind === "model") return { phase: PHASE.create, method: "spawn_model", params: { path: r.model, ...base }, entity: r.name, captureId: true };
  if (r.kind === "prefab") return { phase: PHASE.create, method: "spawn_prefab", params: { path: r.prefab, ...base }, entity: r.name, captureId: true };
  if (r.primitive) return { phase: PHASE.create, method: "create_entity", params: { type: r.primitive, ...base }, entity: r.name, captureId: true };
  if (r.kind === "light") return { phase: PHASE.create, method: "create_entity", params: { type: `light_${r.light ?? "point"}`, ...base }, entity: r.name, captureId: true };
  const params: Record<string, unknown> = { type: CREATE_TYPE[r.kind] ?? "empty", ...base };
  if (r.kind.startsWith("ui_") && r.kind !== "ui_canvas" && r.parent) params.parentName = r.parent;
  return { phase: PHASE.create, method: "create_entity", params, entity: r.name, captureId: true };
}

/** 「作った直後」または「差分のある項目だけ」の更新 Step 群。changed が undefined なら全部(作成)。 */
export function updateSteps(r: Resolved, owner: string, changed?: Set<string>, mergedPos?: Vec3): Step[] {
  const steps: Step[] = [];
  const all = changed === undefined;
  const has = (f: string) => all || [...changed!].some((c) => c === f || c.startsWith(`${f}.`));
  if (has("parent") && r.parent) steps.push({ phase: PHASE.parent, method: "set_parent", params: { name: r.name, parentName: r.parent }, entity: r.name });
  if (has("parent") && !r.parent && !all) steps.push({ phase: PHASE.parent, method: "set_parent", params: { name: r.name }, entity: r.name });
  // transform: 変わった項目だけ(作成は 3 項目とも。y をエンジンが決めるときは位置を x,z だけ確実に)
  const t: Record<string, unknown> = { name: r.name };
  if (r.position && (all || has("position"))) t.position = mergedPos ?? r.position;
  if (all || has("rotation")) t.rotation = r.rotation;
  if (all || has("scale")) t.scale = r.scale;
  if (Object.keys(t).length > 1) steps.push({ phase: PHASE.transform, method: "set_transform", params: t, entity: r.name });
  if (r.color && has("color")) steps.push({ phase: PHASE.props, method: "set_color", params: { name: r.name, color: r.color }, entity: r.name });
  if (r.material && (all || has("material") || has("opaque"))) {
    const m = r.material;
    const p: Record<string, unknown> = { name: r.name };
    if (m.metallic !== undefined) p.metallic = m.metallic;
    if (m.roughness !== undefined) p.roughness = m.roughness;
    if (m.opacity !== undefined) p.opacity = m.opacity;
    if (m.emissiveIntensity !== undefined) p.emissiveIntensity = m.emissiveIntensity;
    if (m.emissive !== undefined) p.emissiveColor = m.emissive;
    if (m.alphaMode !== undefined) p.alphaMode = m.alphaMode;
    if (m.uvScale !== undefined) { p.uvScaleU = m.uvScale[0]; p.uvScaleV = m.uvScale[1]; }
    if (Object.keys(p).length > 1) steps.push({ phase: PHASE.props, method: "set_pbr", params: p, entity: r.name });
  }
  if (r.texture && (all || has("opaque"))) for (const [slot, path] of Object.entries(r.texture)) steps.push({ phase: PHASE.props, method: "set_texture", params: { name: r.name, path, slot }, entity: r.name });
  for (const [ck, fields] of Object.entries(r.components)) if (all || has(`components.${ck}`)) steps.push({ phase: PHASE.props, method: "set_component", params: { name: r.name, component: ck, data: fields }, entity: r.name });
  if (r.tags && (all || has("tags"))) steps.push({ phase: PHASE.props, method: "set_component", params: { name: r.name, component: "tags", data: r.tags }, entity: r.name });
  if (all || has("data") || has("owner") || has("id") || has("opaque")) steps.push({ phase: PHASE.props, method: "set_component", params: { name: r.name, component: "data", data: dataPayload(r, owner) }, entity: r.name });
  if (r.script && (all || has("script"))) {
    steps.push({ phase: PHASE.props, method: "attach_lua_component", params: { name: r.name, script: r.script.path }, entity: r.name });
  }
  if (r.script && Object.keys(r.script.props).length && (all || has("script") || has("opaque"))) {
    for (const [key, value] of Object.entries(r.script.props)) steps.push({ phase: PHASE.scriptProps, method: "set_lua_property", params: { name: r.name, key, value }, entity: r.name });
  }
  if (r.snap && (all || has("position") || has("scale") || has("rotation") || has("parent") || has("opaque"))) steps.push({ phase: PHASE.snap, method: "snap_to_ground", params: { name: r.name, precise: true }, entity: r.name });
  return steps;
}

/** 太陽の明示した値(rotation / components.directionalLight)を、ライティングの設定の後に書き直す(仕様の値を優先する)。エラーの一覧を返す。 */
export async function runStepsForOverride(engine: EngineLike, resolved: Resolved[], owner: string, ids: Map<string, number>): Promise<string[]> {
  const steps: Step[] = [];
  for (const r of resolved) {
    if (r.kind !== "light" || r.light !== "directional") continue;
    const changed = new Set<string>();
    if (r.manage?.rotation) changed.add("rotation");
    if (r.components.directionalLight) changed.add("components.directionalLight");
    if (changed.size) steps.push(...updateSteps(r, owner, changed));
  }
  const errs: string[] = [];
  await pmap(steps, async (s) => { try { await engine.call(s.method, s.params); } catch (e: any) { errs.push(String(e?.message ?? e).slice(0, 200)); } return null; });
  void ids;
  return errs;
}

const wavesOf = (steps: Step[]) => new Set(steps.map((s) => s.phase)).size;

export type PlanOpts = { prune?: boolean; owner: string };

/** 差分計画を作る(エンジンには何も書かない)。 */
export function buildPlan(spec: SceneSpec, resolved: Resolved[], snap: SceneSnapshot, opts: PlanOpts): Plan {
  const owner = opts.owner;
  const entries: PlanEntry[] = [];
  const steps: Step[] = [];
  const issues: SpecIssue[] = [];
  const warnings: string[] = [];
  const desiredNames = new Set(resolved.map((r) => r.name));
  const groupRootNames = new Set(Object.values(GROUP_ROOT));

  // グループ根(仕様が参照していて、シーンに無いもの)は空のエンティティを作る(原点・無回転・スケール 1)。
  const needGroups = new Set<string>();
  for (const r of resolved) if (r.parent && groupRootNames.has(r.parent) && !desiredNames.has(r.parent) && !snap.byName.has(r.parent)) needGroups.add(r.parent);
  for (const g of [...needGroups].sort()) {
    entries.push({ name: g, action: "create", kind: "empty", reason: "グループの根(命名規約)。原点・無回転・スケール 1 で作る", implicit: true, steps: 1 });
    steps.push({ phase: PHASE.groups, method: "create_entity", params: { type: "empty", name: g, position: [0, 0, 0] }, entity: g, captureId: true });
  }

  // 所有者の印(__spec)が同じで __id が同じ物は、名前が変わっていても同じエンティティ(rename_entity で追従。複製 + 孤児にしない)。
  const ownedById = new Map<string, ActualEntity>();
  for (const [n, a] of snap.byName) {
    if (a.raw?.data?.[OWNER_KEY]?.v !== owner) continue;
    const idv = a.raw?.data?.[ID_KEY]?.v ?? n;
    if (typeof idv === "string" && !ownedById.has(idv)) ownedById.set(idv, a);
  }
  const matched = new Set<string>();   // 実体の(現在の)名前
  for (const r of resolved) {
    let a = snap.byName.get(r.name);
    const byId = ownedById.get(r.id);
    let renamed: string | undefined;
    if (byId && byId.name !== r.name && !matched.has(byId.name)) {
      const holder = snap.byName.get(r.name);
      if (holder && holder !== byId) {
        issues.push({ path: r.path, code: "E_SPEC_RENAME_CONFLICT", severity: "error", entity: r.name, message: `${r.name} に改名したいが(id '${r.id}' の実体は '${byId.name}')、その名前を別のエンティティ(${holder.raw?.data?.[OWNER_KEY]?.v === owner ? "この仕様が作った物" : "手で置いた物など"})が使っている`, cause: "名前は一意。改名先が空いていないと追従できない", fix: [{ tool: "dx12_delete_entity", args: { name: r.name }, why: "改名先を空けるか、name / id を変える" }] });
        continue;
      }
      renamed = byId.name;
      a = byId;
    }
    if (a) matched.add(a.name);
    if (!a) {
      const st = [createStep(r), ...updateSteps(r, owner)];
      steps.push(...st);
      entries.push({ name: r.name, action: "create", kind: r.kind, reason: "仕様にあり、シーンに無い", changes: [{ field: "position", to: r.position }], steps: st.length });
      continue;
    }
    if (!kindMatches(r, a)) {
      const kids = snap.children.get(r.name) ?? [];
      if (kids.length) issues.push({
        path: r.path, code: "E_SPEC_KIND_CHANGE", severity: "error", entity: r.name,
        message: `${r.name} は種別が変わる(作り直しが要る)が、子が ${kids.length} 体あり、一緒に消える(${kids.slice(0, 3).join(", ")}${kids.length > 3 ? " …" : ""})`,
        cause: "種別(primitive / モデル / ライトなど)は後から変えられない。子を持つエンティティの作り直しは自動ではしない",
        fix: [{ tool: "dx12_delete_entity", args: { name: r.name }, why: "先に手動で消すか、name を変えて別の物として作る" }],
      });
      const st: Step[] = [{ phase: PHASE.delete, method: "delete_entity", params: { name: r.name }, entity: r.name }, createStep(r), ...updateSteps(r, owner)];
      steps.push(...st);
      entries.push({ name: r.name, action: "replace", kind: r.kind, reason: "種別が仕様と違う(作り直す)", impact: `子 ${kids.length} 体も消える`, steps: st.length });
      continue;
    }
    const changes = diffEntity(r, a, owner, a.parent);
    const renameSteps: Step[] = [];
    if (renamed !== undefined) { renameSteps.push({ phase: PHASE.rename, method: "rename_entity", params: { entity: a.id, name: r.name }, entity: r.name }); changes.unshift({ field: "name", from: renamed, to: r.name }); }
    if (changes.length === 0) { entries.push({ name: r.name, action: "unchanged", kind: r.kind, reason: "仕様と一致", steps: 0 }); continue; }
    const posChange = changes.find((c) => c.field === "position");
    const st = [...renameSteps, ...updateSteps(r, owner, new Set(changes.map((c) => c.field)), posChange ? (posChange.to as Vec3) : undefined)];
    steps.push(...st);
    entries.push({ name: r.name, action: "update", kind: r.kind, reason: renamed !== undefined ? `名前が変わった('${renamed}' → '${r.name}'。id '${r.id}' で追従)+ ${changes.length - 1} 項目` : `${changes.length} 項目が仕様と違う`, changes, steps: st.length });
  }

  // 孤児(この仕様が作ったが、いまの仕様に無い)
  const orphansAll: string[] = [];
  for (const [n, a] of snap.byName) {
    const own = a.raw?.data?.[OWNER_KEY]?.v;
    if (own === owner && !desiredNames.has(n) && !matched.has(n) && !groupRootNames.has(n)) orphansAll.push(n);
  }
  const orphanSet = new Set(orphansAll);
  const topmost = orphansAll.filter((n) => { const p = snap.byName.get(n)?.parent; return !(p && orphanSet.has(p)); });
  const countDesc = (n: string): number => (snap.children.get(n) ?? []).reduce((s, c) => s + 1 + countDesc(c), 0);
  if (opts.prune) {
    for (const n of topmost) {
      const d = countDesc(n);
      const foreign = (function walk(x: string): number { return (snap.children.get(x) ?? []).reduce((s, c) => s + (orphanSet.has(c) ? 0 : 1) + walk(c), 0); })(n);
      steps.push({ phase: PHASE.delete, method: "delete_entity", params: { name: n }, entity: n });
      entries.push({ name: n, action: "delete", reason: `仕様に無い(仕様 '${owner}' が作った物)。prune:true`, impact: d ? `子孫 ${d} 体も消える${foreign ? `(うちこの仕様が作っていない物 ${foreign} 体)` : ""}` : undefined, steps: 1 });
    }
  } else if (orphansAll.length) {
    warnings.push(`いまの仕様に無いが、この仕様('${owner}')が前に作った物が ${orphansAll.length} 体ある(${orphansAll.slice(0, 5).join(", ")}${orphansAll.length > 5 ? " …" : ""})。消すなら prune:true(削除は承認が要る)`);
  }

  // 設定(適用の最後・コミットの後。エンジンのトランザクションでは戻らない設定系だけなので、検証が通った後に撃つ)
  const settings: SettingEntry[] = [];
  if (spec.lighting) settings.push({ what: "lighting", effect: `ライティングのプリセット '${spec.lighting.preset}'(太陽 + ポスト。冪等)`, method: "apply_lighting_preset", params: { preset: spec.lighting.preset } });
  if (spec.look) settings.push({ what: "look", effect: `ルック '${spec.look.preset}'(太陽 + 霧 + 空 + ポスト。冪等)`, method: "look_apply", params: { preset: spec.look.preset, ...(spec.look.strength !== undefined ? { strength: spec.look.strength } : {}), ...(spec.look.parts ? { parts: spec.look.parts } : {}) } });
  if (spec.sun) settings.push({ what: "sun", effect: "太陽の向き・色・強度(絶対値。冪等)", method: "set_sun", params: { ...spec.sun } });
  if (spec.scene) settings.push({ what: "scene", effect: "スカイボックス / IBL / デカールアトラス", method: "set_scene_settings", params: { ...spec.scene } });
  if (spec.navmesh && (spec.navmesh as any).build !== false) { const { build: _b, ...rest } = spec.navmesh as any; settings.push({ what: "navmesh", effect: "ナビメッシュを焼き直す(現在のシーンのメッシュから)", method: "navmesh_build", params: rest }); }

  const summary = {
    create: entries.filter((e) => e.action === "create" && !e.implicit).length,
    update: entries.filter((e) => e.action === "update").length,
    replace: entries.filter((e) => e.action === "replace").length,
    delete: entries.filter((e) => e.action === "delete").length,
    unchanged: entries.filter((e) => e.action === "unchanged").length,
    total: resolved.length, settings: settings.length,
  };
  const waves = wavesOf(steps) + (settings.length ? 1 : 0);
  const calls = steps.length + settings.length + 2;
  const cost = {
    engineCalls: calls, waves,
    // 実測(実エンジン): 同じ波の要求は 1 フレームで全部処理される。波ごとに約 1〜2 フレーム(17ms 前後)+ 1 コールあたり 0.1〜0.3ms。
    estimatedMs: Math.round(waves * 35 + calls * 0.3 + (settings.length ? 100 : 0)),
    estimatedFrames: waves * 2,
  };
  return { specName: owner, summary, entries, settings, orphans: orphansAll, cost, steps, issues, warnings };
}

/** 計画の表示用(件数の多いときは各 action を detail 件までに切る)。 */
export function presentPlan(plan: Plan, detail = 60): Record<string, unknown> {
  const pick = (a: PlanEntry["action"]) => plan.entries.filter((e) => e.action === a);
  const shrink = (e: PlanEntry) => ({ name: e.name, ...(e.kind ? { kind: e.kind } : {}), reason: e.reason, ...(e.changes ? { changes: e.changes.slice(0, 6) } : {}), ...(e.impact ? { impact: e.impact } : {}), ...(e.implicit ? { implicit: true } : {}) });
  const cut = (a: PlanEntry["action"]) => { const l = pick(a); return { list: l.slice(0, detail).map(shrink), omitted: Math.max(0, l.length - detail) }; };
  const c = cut("create"), u = cut("update"), rp = cut("replace"), d = cut("delete");
  return {
    summary: plan.summary,
    create: c.list, ...(c.omitted ? { createOmitted: c.omitted } : {}),
    update: u.list, ...(u.omitted ? { updateOmitted: u.omitted } : {}),
    ...(rp.list.length ? { replace: rp.list } : {}),
    delete: d.list, ...(d.omitted ? { deleteOmitted: d.omitted } : {}),
    unchanged: plan.summary.unchanged,
    settings: plan.settings.map((s) => ({ what: s.what, effect: s.effect })),
    orphans: plan.orphans.slice(0, 30),
    cost: plan.cost,
    warnings: plan.warnings,
  };
}
