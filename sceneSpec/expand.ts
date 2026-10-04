// SceneSpec の展開と相対配置の解決(M11)。純関数: 同じ仕様・同じ「実測の AABB」なら必ず同じ座標になる(決定論)。
//
//   ① パターン(grid / ring / line / along / scatter)を instance に展開する(名前は <name>_<NN>。乱数は seed 付き)
//   ② 相対配置(右 2m・上に載せる・壁に沿って・地面に足元を合わせる)を、AABB の実測値で解く
//        ・プリミティブは解析(box ±0.5 / sphere 半径 0.5 / plane 50m 四方)、モデルは asset_info の AABB(scale 1 の実寸)、
//          仕様の外(既にシーンにある物)は get_bounds の実測。エンジンに置いてから測る必要は無い = plan でも apply でも同じ座標。
//        ・回転・スケール・親子は get_bounds と同じ式(ローカル AABB の 8 頂点を変換)。
//   ③ 親子: at は親が無ければワールド、あればローカル。place の解は「ワールド」で出し、親のローカルへ戻す。
//
// 座標軸(ワールド): right=+X / left=-X / front=+Z / back=-Z / above=+Y / below=-Y。yaw 0 は +Z を向く。
import {
  IDENTITY, POINT_AABB, aabbCenter, aabbSize, applyAffine, invAffine, isVec3, lookAtEuler, mulAffine, mulberry32, primitiveLocalAabb, r5, roundVec, transformAabb, trs,
  type AABB, type Affine, type Vec3,
} from "./geom.ts";
import { instanceNames } from "./schema.ts";
import { GROUP_ROOT, type EntitySpec, type GroupKey, type Kind, type LightType, type MaterialSpec, type PatternSpec, type PlaceSpec, type SceneSpec, type SpecIssue } from "./types.ts";

export type Resolved = {
  name: string;
  /** 安定 ID(仕様の id、省略で name。パターンの instance は <id>_<NN>)。 */
  id: string;
  /** 仕様の entities[] の添字と、パターンの連番(1 始まり)。 */
  srcIndex: number;
  instance?: number;
  /** テンプレートの JSON Pointer(例 /entities/3)。 */
  path: string;
  kind: Kind;
  primitive?: "box" | "sphere" | "plane";
  light?: LightType;
  model?: string;
  prefab?: string;
  group?: GroupKey;
  parent?: string;
  /** 仕様の at(null = place などで決める)。 */
  at: (number | null)[];
  rotation: Vec3;
  scale: Vec3;
  color?: Vec3;
  material?: MaterialSpec;
  texture?: Record<string, string>;
  components: Record<string, Record<string, unknown>>;
  script?: { path: string; props: Record<string, unknown> };
  tags?: string[];
  data?: Record<string, number | boolean | string | Vec3>;
  place?: PlaceSpec;
  lookAt?: string | Vec3;
  snap: boolean;
  /** scale 1 のローカル AABB(null = メッシュ無し = 点)。 */
  localBounds: AABB | null;
  boundsUnknown?: boolean;
  // ── 解いた結果 ──
  /** ローカル位置(親が無ければワールド)。 */
  position?: Vec3;
  world?: Affine;
  worldBounds?: AABB;
  /** y をエンジン(snap_to_ground)が決める。 */
  yManaged?: boolean;
  /**
   * 仕様が指定した項目だけを「管理」する(指定しない項目は、既存のエンティティでは手で変えた値を尊重して触らない。作成時だけ既定値で作る)。
   * position は軸ごと(at の数値・place / pattern が解いた軸)、rotation は rotation / lookAt / pattern の向き、scale は scale / size / scaleRange。
   */
  manage?: { position: [boolean, boolean, boolean]; rotation: boolean; scale: boolean };
};

export type SolveEnv = {
  /** モデルの実寸 AABB(scale 1)。asset_info の aabbMin/aabbMax。 */
  assetBounds: (path: string) => AABB | undefined;
  /** 仕様の外(既にシーンにある物)の実測。 */
  external?: {
    bounds?: (name: string) => AABB | undefined;
    world?: (name: string) => Affine | undefined;
    pivot?: (name: string) => Vec3 | undefined;
  };
};

const GROUP_ROOT_NAMES = new Set<string>(Object.values(GROUP_ROOT));

/** sRGB(0..1)→ リニア。エンジンの color は乗算されるリニア値(出力で sRGB に戻る)なので、"#rrggbb" は見たままの色になるよう変換する。[r,g,b] の配列はエンジンの値そのまま。 */
export const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function parseColor(c: unknown): Vec3 | undefined {
  if (typeof c === "string") {
    const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(c);
    if (!m) return undefined;
    const ch = (h: string) => Math.round(srgbToLinear(parseInt(h, 16) / 255) * 1e4) / 1e4;
    return [ch(m[1]), ch(m[2]), ch(m[3])];
  }
  return isVec3(c) ? [c[0], c[1], c[2]] : undefined;
}

function sizeToScale(kind: Kind, size: unknown): Vec3 | undefined {
  if (size === undefined) return undefined;
  const n = typeof size === "number" ? size : undefined;
  const a = Array.isArray(size) ? (size as number[]) : undefined;
  if (kind === "plane") {
    if (n !== undefined) return [n / 50, 1, n / 50];
    if (a && a.length >= 2) return [a[0] / 50, 1, a[a.length - 1] / 50];
    return undefined;
  }
  if (n !== undefined) return [n, n, n];
  if (a && a.length === 3) return [a[0], a[1], a[2]];
  if (a && a.length === 2) return [a[0], a[1], a[0]];
  return undefined;
}

/** 仕様の 1 エンティティ → テンプレート(パターン展開前)。fps_player は 2 体(本体 + カメラ)に展開する。 */
function makeTemplates(e: EntitySpec, index: number, env: SolveEnv, assetHasScript: (p: string) => boolean): Resolved[] {
  const path = `/entities/${index}`;
  const scaleIn = typeof e.scale === "number" ? ([e.scale, e.scale, e.scale] as Vec3) : isVec3(e.scale) ? ([...e.scale] as Vec3) : undefined;
  const scale: Vec3 = scaleIn ?? sizeToScale(e.kind, e.size) ?? [1, 1, 1];
  const parent = e.parent ?? (e.group ? GROUP_ROOT[e.group] : undefined);
  const base: Resolved = {
    name: e.name, id: e.id ?? e.name, srcIndex: index, path, kind: e.kind, group: e.group, parent,
    at: Array.isArray(e.at) ? (e.at.slice(0, 3) as (number | null)[]) : [null, null, null], rotation: isVec3(e.rotation) ? ([...e.rotation] as Vec3) : [0, 0, 0], scale,
    color: parseColor(e.color), material: e.material ? { ...e.material } : undefined, texture: e.texture ? { ...(e.texture as Record<string, string>) } : undefined,
    components: e.components ? JSON.parse(JSON.stringify(e.components)) : {},
    script: typeof e.script === "string" ? { path: e.script, props: {} } : e.script && typeof e.script === "object" ? { path: e.script.path, props: { ...(e.script.props ?? {}) } } : undefined,
    tags: e.tags ? [...e.tags] : undefined, data: e.data ? { ...e.data } : undefined,
    place: e.place ? JSON.parse(JSON.stringify(e.place)) : undefined, lookAt: e.lookAt, snap: e.place?.snap === true, localBounds: null,
  };
  (base as any)._manageRot = isVec3(e.rotation) || e.lookAt !== undefined;
  if (e.collider && ["box", "sphere", "plane", "model", "prefab"].includes(e.kind)) {
    // 当たり判定の略記(components があればそちらが優先)
    const comps: Record<string, Record<string, unknown>> = { rigidBody: { motionType: e.collider === "dynamic" ? 2 : 0 } };
    if (e.kind === "sphere") comps.sphereCollider = { radius: 0.5 };
    else if (e.kind === "plane") comps.boxCollider = { halfExtents: [25, 0.5, 25], offset: [0, -0.5, 0] };
    else {
      const lb = e.kind === "model" ? (e.bounds ?? env.assetBounds(e.model ?? "")) : e.bounds;
      if (lb) comps.boxCollider = { halfExtents: [0, 1, 2].map((k) => r5((lb.max[k] - lb.min[k]) / 2)), offset: [0, 1, 2].map((k) => r5((lb.max[k] + lb.min[k]) / 2)) };
      else comps.boxCollider = { halfExtents: [0.5, 0.5, 0.5] };
    }
    base.components = { ...comps, ...base.components };
  }
  (base as any)._manageScale = scaleIn !== undefined || e.size !== undefined;
  while (base.at.length < 3) base.at.push(null);

  switch (e.kind) {
    case "box": case "sphere": case "plane":
      base.primitive = e.kind; base.localBounds = primitiveLocalAabb(e.kind); break;
    case "model": {
      base.model = e.model;
      const b = e.bounds ? { min: e.bounds.min, max: e.bounds.max } : e.model ? env.assetBounds(e.model) : undefined;
      if (b) base.localBounds = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 }; else { base.localBounds = null; base.boundsUnknown = true; }
      break;
    }
    case "prefab": {
      base.prefab = e.prefab;
      if (e.bounds) base.localBounds = { min: [...e.bounds.min] as Vec3, max: [...e.bounds.max] as Vec3 }; else { base.localBounds = null; base.boundsUnknown = true; }
      break;
    }
    case "light": base.light = e.light ?? "point"; break;
    case "fps_player": {
      // 一人称プレイヤー(FPS テンプレートと同じ形): 本体(characterController + FpsController)+ カメラ。y 未指定は 1.2m(足元 0.25m 上)。
      const camName = `${e.name}Camera`;
      const at = base.at.slice() as (number | null)[];
      const hasPlace = !!e.place;
      if (at[1] === null && !hasPlace) at[1] = 1.2;
      const script = base.script ?? (assetHasScript("components/FpsController.lua") ? { path: "components/FpsController.lua", props: {} } : undefined);
      if (script && script.props.cam === undefined) script.props = { ...script.props, cam: camName };
      const body: Resolved = { ...base, kind: "empty", at, script, components: { characterController: { radius: 0.4, halfHeight: 0.55, jumpSpeed: 7.5, stepHeight: 0.4 }, ...base.components } };
      const cam: Resolved = {
        ...base, name: camName, id: `${base.id}Camera`, kind: "camera", instance: undefined, at: [at[0], at[1] === null ? null : (at[1] as number) + 0.6, at[2]], script: undefined, tags: undefined, data: undefined,
        components: { camera: { fovDegrees: 74, nearClip: 0.05, farClip: 500, isActive: true } }, color: undefined, material: undefined, texture: undefined, place: undefined, lookAt: undefined,
        localBounds: null, parent: base.parent,
      };
      return [body, cam];
    }
    default: break; // empty / camera / trigger / particle / decal / ui_*
  }
  return [base];
}

type Inst = {
  at?: (number | null)[];
  rotation?: Vec3;
  scale?: Vec3;
  /** パターンが向き / 大きさを決めたか(管理対象にする)。 */
  rotationManaged?: boolean;
  scaleManaged?: boolean;
  /** along 用: 位置の代わりに「中心をこのワールド座標に揃える」軸。 */
  centerOn?: { x?: number; y?: number; z?: number };
  place?: PlaceSpec;
};

type Ctx = {
  bounds: (name: string) => AABB | undefined;
  pivot: (name: string) => Vec3 | undefined;
  issues: SpecIssue[];
};

function patternCenter(p: PatternSpec, ctx: Ctx): Vec3 | undefined {
  if (isVec3(p.origin)) return p.origin;
  if (isVec3(p.around)) return p.around;
  if (typeof p.around === "string") { const b = ctx.bounds(p.around); if (b) return aabbCenter(b); }
  return undefined;
}

/** パターンの instance の一覧(名前の付け方は schema.instanceNames と同じ)。 */
function generate(t: Resolved, p: PatternSpec, ctx: Ctx): Inst[] {
  const seed = Number.isInteger(p.seed) ? (p.seed as number) : 1;
  const rng = mulberry32(seed);
  const out: Inst[] = [];
  const cnt = p.count;
  const jitter = typeof p.jitter === "number" ? p.jitter : 0;
  const jit = () => (jitter > 0 ? (rng() * 2 - 1) * jitter : 0);
  const path = `${t.path}/pattern`;
  switch (p.type) {
    case "grid": {
      const c = Array.isArray(cnt) ? cnt : [1, 1];
      const sp = Array.isArray(p.spacing) ? p.spacing : [1, 1];
      const nx = c[0], ny = c.length === 3 ? c[1] : 1, nz = c.length === 3 ? c[2] : c[1];
      const sx = sp[0], sy = sp.length === 3 ? sp[1] : 0, sz = sp.length === 3 ? sp[2] : sp[1];
      const ctr = patternCenter(p, ctx);
      const cx = ctr ? ctr[0] : 0, cz = ctr ? ctr[2] : 0;
      const cy = typeof p.y === "number" ? p.y : null; // y は pattern.y を書いたときだけ明示(書かなければ place / 既定で決める)
      for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const y = c.length === 3 ? (cy ?? 0) + (j - (ny - 1) / 2) * sy : cy;
        out.push({ at: [r5(cx + (i - (nx - 1) / 2) * sx + jit()), y === null ? null : r5(y), r5(cz + (k - (nz - 1) / 2) * sz + jit())] });
      }
      return out;
    }
    case "ring": {
      const n = typeof cnt === "number" ? cnt : 1;
      const r = p.radius ?? 1;
      const ctr = patternCenter(p, ctx) ?? [0, 0, 0];
      const start = p.startAngle ?? 0;
      const arc = p.arc ?? 360;
      for (let i = 0; i < n; i++) {
        const th = start + (arc >= 360 ? (arc * i) / n : n > 1 ? (arc * i) / (n - 1) : 0);
        const rad = (th * Math.PI) / 180;
        const inst: Inst = { at: [r5(ctr[0] + r * Math.sin(rad)), typeof p.y === "number" ? p.y : null, r5(ctr[2] + r * Math.cos(rad))] };
        if (p.faceCenter) { let y = th + 180 + t.rotation[1]; y = ((y % 360) + 360) % 360; inst.rotation = [t.rotation[0], r5(y), t.rotation[2]]; inst.rotationManaged = true; }
        out.push(inst);
      }
      return out;
    }
    case "line": {
      const n = typeof cnt === "number" ? cnt : 1;
      const from = p.from ?? [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const at: (number | null)[] = [null, null, null];
        for (let k = 0; k < 3; k++) {
          const a = from[k];
          if (a === null || a === undefined) continue;
          if (isVec3(p.step)) at[k] = r5(a + p.step[k] * i);
          else { const b = p.to?.[k] ?? a; const f = n > 1 ? i / (n - 1) : 0; at[k] = r5(a + ((b as number) - a) * f); }
        }
        out.push({ at });
      }
      return out;
    }
    case "along": {
      const n = typeof cnt === "number" ? cnt : 1;
      const A = p.of ? ctx.bounds(p.of) : undefined;
      if (!A) { ctx.issues.push({ path, code: "E_SPEC_BOUNDS_UNKNOWN", severity: "error", message: `pattern.along の対象 '${p.of}' の大きさが分からない(メッシュが無い/測れない)`, entity: t.name }); return out; }
      const side = p.side ?? "front";
      const margin = p.margin ?? 0;
      const gap = p.gap ?? 0;
      const alongX = side === "front" || side === "back" || side === "above" || side === "below";
      const lo = (alongX ? A.min[0] : A.min[2]) + margin, hi = (alongX ? A.max[0] : A.max[2]) - margin;
      for (let i = 0; i < n; i++) {
        const v = n > 1 ? lo + ((hi - lo) * i) / (n - 1) : (lo + hi) / 2;
        out.push({ at: [null, null, null], centerOn: alongX ? { x: r5(v) } : { z: r5(v) }, place: { relativeTo: p.of, side, gap, align: { y: "bottom" } } });
      }
      return out;
    }
    case "scatter": {
      const n = typeof cnt === "number" ? cnt : 1;
      let area: [number, number, number, number] | undefined;
      if (Array.isArray(p.area)) area = p.area as [number, number, number, number];
      else if (typeof p.area === "string") { const b = ctx.bounds(p.area); if (b) area = [b.min[0], b.min[2], b.max[0], b.max[2]]; }
      if (!area) { ctx.issues.push({ path: `${path}/area`, code: "E_SPEC_BOUNDS_UNKNOWN", severity: "error", message: `scatter の範囲 '${String(p.area)}' の大きさが分からない`, entity: t.name }); return out; }
      const minSp = p.minSpacing ?? 0;
      const excl = (p.exclude ?? []).map((nm) => ctx.bounds(nm)).filter((b): b is AABB => !!b);
      const placed: [number, number][] = [];
      // 位置と、向き・大きさのばらつきは別の乱数列にする(yaw / scaleRange を変えても、同じ seed なら位置は同じ。木の幹と葉を同じ seed で重ねられる)
      const rngExtra = mulberry32((seed ^ 0x9e3779b9) >>> 0);
      let attempts = 0;
      const maxAttempts = Math.max(50, n * 40);
      while (placed.length < n && attempts < maxAttempts) {
        attempts++;
        const x = r5(area[0] + rng() * (area[2] - area[0])), z = r5(area[1] + rng() * (area[3] - area[1]));
        if (minSp > 0 && placed.some((q) => Math.hypot(q[0] - x, q[1] - z) < minSp)) continue;
        if (excl.some((b) => x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2])) continue;
        placed.push([x, z]);
        const inst: Inst = { at: [x, typeof p.y === "number" ? p.y : null, z] };
        if (p.yaw === "random") { inst.rotation = [t.rotation[0], r5(rngExtra() * 360), t.rotation[2]]; inst.rotationManaged = true; }
        else if (typeof p.yaw === "number") { inst.rotation = [t.rotation[0], p.yaw, t.rotation[2]]; inst.rotationManaged = true; }
        if (p.scaleRange) { const s = r5(p.scaleRange[0] + (p.scaleRange[1] - p.scaleRange[0]) * rngExtra()); inst.scale = [t.scale[0] * s, t.scale[1] * s, t.scale[2] * s]; inst.scaleManaged = true; }
        out.push(inst);
      }
      if (placed.length < n) ctx.issues.push({ path, code: "W_SCATTER_SHORT", severity: "warn", message: `${t.name}: scatter は ${n} 個のうち ${placed.length} 個しか置けなかった(minSpacing / exclude が厳しい)。連番は ${placed.length} まで`, entity: t.name, specPatch: undefined });
      return out;
    }
  }
  return out;
}

const dependsOf = (e: EntitySpec): string[] => {
  const d: string[] = [];
  if (typeof e.parent === "string") d.push(e.parent);
  if (e.place?.relativeTo) d.push(e.place.relativeTo);
  if (e.place?.on) d.push(e.place.on);
  if (typeof e.lookAt === "string") d.push(e.lookAt);
  const p = e.pattern;
  if (p) { if (typeof p.around === "string") d.push(p.around); if (p.of) d.push(p.of); if (typeof p.area === "string") d.push(p.area); if (p.exclude) d.push(...p.exclude); }
  return d;
};

export type ResolveResult = { entities: Resolved[]; issues: SpecIssue[]; order: string[] };

/** 仕様(検証済み)を、座標まで解いたエンティティ列にする。 */
export function resolveSpec(spec: SceneSpec, env: SolveEnv, opts: { assetHasScript?: (p: string) => boolean } = {}): ResolveResult {
  const issues: SpecIssue[] = [];
  const entitiesIn = Array.isArray(spec.entities) ? spec.entities : [];
  const hasScript = opts.assetHasScript ?? (() => false);

  // 名前 → 提供する node(パターンは instance 名、fps_player はカメラ名も)
  const provider = new Map<string, number>();
  entitiesIn.forEach((e, i) => {
    if (e.pattern) {
      const cnt = Array.isArray(e.pattern.count) ? (e.pattern.count as number[]).reduce((a, b) => a * b, 1) : typeof e.pattern.count === "number" ? e.pattern.count : 0;
      for (const nm of instanceNames(e.name, cnt, e.pattern.skip)) provider.set(nm, i);
    } else { provider.set(e.name, i); if (e.kind === "fps_player") provider.set(`${e.name}Camera`, i); }
  });

  // 依存(node 間)。仕様に無い名前は外部(シーンの実測)。
  const deps: Set<number>[] = entitiesIn.map((e, i) => {
    const s = new Set<number>();
    for (const n of dependsOf(e)) { const j = provider.get(n); if (j !== undefined && j !== i) s.add(j); }
    return s;
  });
  const done = new Set<number>();
  const order: number[] = [];
  const remaining = new Set(entitiesIn.map((_, i) => i));
  while (remaining.size) {
    let progressed = false;
    for (const i of [...remaining].sort((a, b) => a - b)) {
      if ([...deps[i]].every((d) => done.has(d))) { order.push(i); done.add(i); remaining.delete(i); progressed = true; break; }
    }
    if (!progressed) { // 循環(検証を通していれば来ない)。残りは仕様の順で解く
      for (const i of [...remaining].sort((a, b) => a - b)) { order.push(i); done.add(i); remaining.delete(i); }
      issues.push({ path: "/entities", code: "E_SPEC_CYCLE", severity: "error", message: "相対配置・親子が循環していて解けない" });
    }
  }

  const solved = new Map<string, Resolved>();
  const worldBoundsOf = (name: string): AABB | undefined => solved.get(name)?.worldBounds ?? env.external?.bounds?.(name);
  const pivotOf = (name: string): Vec3 | undefined => { const r = solved.get(name); return r?.world ? applyAffine(r.world, [0, 0, 0]) : env.external?.pivot?.(name); };
  const worldOf = (name: string): Affine => {
    const r = solved.get(name);
    if (r?.world) return r.world;
    if (GROUP_ROOT_NAMES.has(name) && !provider.has(name)) return IDENTITY;
    return env.external?.world?.(name) ?? IDENTITY;
  };
  const ctx: Ctx = { bounds: worldBoundsOf, pivot: pivotOf, issues };
  const out: Resolved[] = [];
  const perNode: Resolved[][] = entitiesIn.map(() => []);

  for (const i of order) {
    const e = entitiesIn[i];
    const templates = makeTemplates(e, i, env, hasScript);
    let instances: Resolved[];
    if (e.pattern) {
      const t = templates[0];
      const gen = generate(t, e.pattern, ctx);
      const total = Array.isArray(e.pattern.count) ? (e.pattern.count as number[]).reduce((a, b) => a * b, 1) : typeof e.pattern.count === "number" ? e.pattern.count : gen.length;
      const width = Math.max(2, String(total).length);
      const skip = new Set(e.pattern.skip ?? []);
      instances = [];
      gen.forEach((g, gi) => {
        const n = gi + 1;
        if (skip.has(n)) return;
        // scatter が置けなかった分は連番が詰まる(gen が n 個未満)。skip の連番は元の連番で数える。
        const inst: Resolved = {
          ...t, name: `${e.name}_${String(n).padStart(width, "0")}`, id: `${t.id}_${String(n).padStart(width, "0")}`, instance: n,
          at: g.at ? g.at.slice() : t.at.slice(), rotation: g.rotation ?? t.rotation, scale: g.scale ?? t.scale, place: g.place ?? t.place, snap: (g.place ?? t.place)?.snap === true || t.snap,
          components: JSON.parse(JSON.stringify(t.components)),
        };
        (inst as any)._centerOn = g.centerOn;
        (inst as any)._manageRot = (t as any)._manageRot || g.rotationManaged === true;
        (inst as any)._manageScale = (t as any)._manageScale || g.scaleManaged === true;
        instances.push(inst);
      });
    } else instances = templates;

    for (const r of instances) {
      solveOne(r, { worldOf, worldBoundsOf, pivotOf, issues });
      solved.set(r.name, r);
      perNode[i].push(r);
    }
  }
  // 出力は仕様の順(展開後)
  for (let i = 0; i < entitiesIn.length; i++) out.push(...perNode[i]);
  return { entities: out, issues, order: order.map((i) => entitiesIn[i].name) };
}

type SolveCtx = {
  worldOf: (name: string) => Affine;
  worldBoundsOf: (name: string) => AABB | undefined;
  pivotOf: (name: string) => Vec3 | undefined;
  issues: SpecIssue[];
};

/** 1 体のローカル位置・ワールド行列・ワールド AABB を解く。 */
function solveOne(r: Resolved, c: SolveCtx): void {
  const parentW = r.parent ? c.worldOf(r.parent) : IDENTITY;
  const parentLin: Affine = { m: parentW.m, t: [0, 0, 0] };
  const selfLin = trs([0, 0, 0], r.rotation, r.scale);
  const lin = mulAffine(parentLin, selfLin);
  const p = r.place;
  const needsBox = !!p && (p.relativeTo !== undefined || p.on !== undefined || p.ground !== undefined && p.ground !== false) || !!(r as any)._centerOn;
  let box0: AABB = POINT_AABB;
  if (r.localBounds) box0 = transformAabb(r.localBounds, lin);
  else if (needsBox && r.boundsUnknown) {
    c.issues.push({ path: r.path, code: "E_SPEC_BOUNDS_UNKNOWN", severity: "error", entity: r.name, message: `${r.name}: 大きさが分からない(${r.kind === "prefab" ? "prefab" : "モデル"}の AABB を取れなかった)ので相対配置できない`, cause: "bounds:{min,max}(scale 1 のローカル AABB)を書くか、at を明示する" });
  }

  const explicit = r.at;
  const baseLocal: Vec3 = [explicit[0] ?? 0, explicit[1] ?? 0, explicit[2] ?? 0];
  const W: Vec3 = applyAffine(parentW, baseLocal);
  const solved: (number | undefined)[] = [undefined, undefined, undefined];

  const align1 = (k: 0 | 1 | 2, mode: string | undefined, A: AABB): number => {
    const m = mode ?? "center";
    if (m === "min" || m === "bottom") return A.min[k] - box0.min[k];
    if (m === "max" || m === "top") return A.max[k] - box0.max[k];
    return aabbCenter(A)[k] - aabbCenter(box0)[k];
  };

  const anchorName = p?.relativeTo ?? p?.on;
  if (p && anchorName) {
    const A = c.worldBoundsOf(anchorName);
    if (!A) {
      c.issues.push({ path: `${r.path}/place`, code: "E_SPEC_BOUNDS_UNKNOWN", severity: "error", entity: r.name, message: `${r.name}: 基準 '${anchorName}' の大きさが分からない(メッシュが無い/測れない)ので相対配置できない`, cause: "基準側に bounds を書くか、at を明示する" });
    } else {
      const side = p.on !== undefined ? "above" : p.side ?? "right";
      const gap = p.gap ?? 0;
      const al = p.align ?? {};
      // 主軸
      if (side === "right") solved[0] = A.max[0] + gap - box0.min[0];
      else if (side === "left") solved[0] = A.min[0] - gap - box0.max[0];
      else if (side === "front") solved[2] = A.max[2] + gap - box0.min[2];
      else if (side === "back") solved[2] = A.min[2] - gap - box0.max[2];
      else if (side === "above") solved[1] = A.max[1] + gap - box0.min[1];
      else if (side === "below") solved[1] = A.min[1] - gap - box0.max[1];
      // 他の軸の揃え
      if (side !== "right" && side !== "left") solved[0] = align1(0, al.x, A);
      if (side !== "above" && side !== "below") solved[1] = align1(1, al.y ?? "bottom", A);
      if (side !== "front" && side !== "back") solved[2] = align1(2, al.z, A);
    }
  }
  if (p && p.ground !== undefined && p.ground !== false && solved[1] === undefined) {
    const gy = typeof p.ground === "number" ? p.ground : 0;
    solved[1] = gy - box0.min[1];
  }
  // along: 中心を指定の座標に揃える
  const centerOn = (r as any)._centerOn as { x?: number; y?: number; z?: number } | undefined;
  if (centerOn) {
    const cc = aabbCenter(box0);
    if (centerOn.x !== undefined) solved[0] = centerOn.x - cc[0];
    if (centerOn.y !== undefined) solved[1] = centerOn.y - cc[1];
    if (centerOn.z !== undefined) solved[2] = centerOn.z - cc[2];
  }
  const off = p?.offset ?? [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (explicit[k] !== null) continue;
    if (solved[k] !== undefined) W[k] = (solved[k] as number) + off[k];
    else if (off[k] !== 0) W[k] += off[k];
  }
  // ワールド → 親のローカル(明示された軸はその値そのまま)
  const inv = invAffine(parentW);
  const localSolved = inv ? applyAffine(inv, W) : W;
  const local: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) local[k] = explicit[k] !== null ? (explicit[k] as number) : localSolved[k];
  r.position = roundVec(local);
  r.manage = {
    position: [0, 1, 2].map((k) => explicit[k] !== null || solved[k] !== undefined || off[k] !== 0) as [boolean, boolean, boolean],
    rotation: (r as any)._manageRot === true || r.lookAt !== undefined,
    scale: (r as any)._manageScale === true,
  };
  // snap: y はエンジンが決める(明示の y があっても、snap が最終的に上書きする)
  r.yManaged = r.snap === true;

  // lookAt: 回転を決める(親の回転は考慮しない。位置は解いた後の値)
  const worldTmp = mulAffine(parentW, trs(r.position, r.rotation, r.scale));
  if (r.lookAt !== undefined) {
    const from = applyAffine(worldTmp, [0, 0, 0]);
    const target = typeof r.lookAt === "string" ? c.pivotOf(r.lookAt) : r.lookAt;
    if (target) r.rotation = lookAtEuler(from, target);
    else c.issues.push({ path: `${r.path}/lookAt`, code: "E_SPEC_BOUNDS_UNKNOWN", severity: "error", entity: r.name, message: `${r.name}: lookAt の対象 '${String(r.lookAt)}' の位置が分からない` });
  }
  r.world = mulAffine(parentW, trs(r.position, r.rotation, r.scale));
  r.worldBounds = r.localBounds ? transformAabb(r.localBounds, r.world) : { min: applyAffine(r.world, [0, 0, 0]), max: applyAffine(r.world, [0, 0, 0]) };
  delete (r as any)._centerOn; delete (r as any)._manageRot; delete (r as any)._manageScale;
}

export { aabbSize };
