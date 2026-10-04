// シーン状態を本当に持つ偽エンジン(テスト用)。mockEngine.ts の startMockEngine({ methods: sim.methods }) に渡して使う。
//
// 目的: M11(宣言的シーン生成 dx12_apply_scene_spec)の差分計画・適用・検証・ロールバックを、実エンジン無しで決定論的にテストする。
// 写しているのは実エンジンの実装ではなく【実測(プローブ)で観測した入出力】:
//   ・エンティティ生成は即時(実エンジンはフレーム境界だが、Node が完了を待って本物の {entityId, name} を返す)。同名は "Name (1)" と連番になる。
//   ・get_bounds は「ローカル AABB の 8 頂点をワールド変換した AABB」。Euler は YXZ(回転行列 Ry*Rx*Rz)、scale はローカル軸に先に掛かる。
//   ・set_parent はワールド座標を保持しない(子の transform はそのままローカル値として解釈される)。
//   ・set_component は data が空/非オブジェクトだと code 2(tags の文字列配列だけは C++ 修正後の挙動として許可)。
//   ・transaction_rollback はエンティティを begin 時へ丸ごと戻すが、設定系(ポスト・シーン設定・ナビ)は戻らない。
//   ・validate_layout は AABB ベースで DUPLICATE / Z_FIGHT / OVERLAP / BURIED / FLOATING / COLLIDER_WITHOUT_BODY / SCALE_ANOMALY を再現する。
//
// 使い方:
//   const sim = createSceneSim({ assets: { "models/cube1m.glb": { min: [-.5,-.5,-.5], max: [.5,.5,.5] } } });
//   const mock = await startMockEngine({ methods: sim.methods });
//   sim.hash()            … シーンの決定的ハッシュ(entityId・guid を含まない)
//   sim.failNext("set_component", { name: "X" })  … 次にその method(+ name 一致)が呼ばれたら失敗を返す
import crypto from "node:crypto";
import type { MockMethod } from "./mockEngine.ts";

export type Vec3 = [number, number, number];

export type SimEntity = {
  id: number;
  name: string;
  guid: string;
  kind: "primitive" | "model" | "prefab" | "empty" | "camera" | "light" | "trigger" | "other";
  primitive?: "box" | "sphere" | "plane";
  modelPath?: string;
  parent: number | null;
  transform: { position: Vec3; rotation: Vec3; scale: Vec3 };
  color?: Vec3;
  material?: Record<string, any>;
  textures?: Record<string, string>;
  comps: Record<string, any>;
  tags?: string[];
  data?: Record<string, { t: string; v: any }>;
  internal?: boolean;
};

export type SimFailure = { method: string; nth: number; name?: string; message: string; code: number; count: number };

export type SimState = {
  /** 作成順。 */
  entities: SimEntity[];
  nextId: number;
  /** 設定系(rollback で戻らない)。 */
  settings: { lighting?: any; scene?: any; sun?: any; post?: any; navmesh?: any };
  tx: null | { label: string; snapshot: { entities: SimEntity[]; nextId: number }; calls: number };
  /** 受けた呼び出し(read も含む)。 */
  calls: { method: string; params: any }[];
  failures: SimFailure[];
  /** true にすると navmesh_path は常に到達不能を返す。 */
  navBlocked: boolean;
  /** 到達不能にする組(from / to の座標が radius(既定 1m)以内に近い。向きは問わない)。 */
  blockedPairs: { from: Vec3; to: Vec3; radius?: number }[];
};

export type SimOptions = {
  assets?: Record<string, { min: Vec3; max: Vec3; type?: string }>;
  scripts?: string[];
  textures?: string[];
  prefabs?: string[];
  scenes?: string[];
  assetsDir?: string;
  baseDir?: string;
};

// ── 小物 ────────────────────────────────────────────────────────────────────
const fr = (v: any): any => {
  if (typeof v === "number") return Math.fround(v);
  if (Array.isArray(v)) return v.map(fr);
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = fr(v[k]); return o; }
  return v;
};
const clone = <T,>(v: T): T => structuredClone(v);
const isVec = (v: any, n: number) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
const RAD = Math.PI / 180;

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return dp[b.length];
}
function nearest(target: string, names: string[], n = 5): string[] {
  const t = target.toLowerCase();
  return names.map((x) => ({ x, d: editDistance(t, x.toLowerCase()) }))
    .filter((o) => o.d <= Math.max(2, Math.floor(t.length / 2)) || o.x.toLowerCase().includes(t) || t.includes(o.x.toLowerCase()))
    .sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.x);
}

function simErr(code: number, message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, fields });
}

// ── 3x3 行列(行優先) ─────────────────────────────────────────────────────────
type M3 = number[];
const mul3 = (a: M3, b: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply3 = (m: M3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
/** R = Ry * Rx * Rz(度)。プローブ: scale[2,3,4]・rot[0,45,0] の box の AABB がエンジンと一致することを確認済み。 */
function rotMat(rot: Vec3): M3 {
  const [x, y, z] = [rot[0] * RAD, rot[1] * RAD, rot[2] * RAD];
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const Rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Ry, mul3(Rx, Rz));
}
/** クォータニオン → Euler 度(YXZ)。 */
function quatToEuler(q: [number, number, number, number]): Vec3 {
  const [x, y, z, w] = q;
  const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -R[5])));
  let yaw: number, roll: number;
  if (Math.abs(R[5]) < 0.999999) { yaw = Math.atan2(R[2], R[8]); roll = Math.atan2(R[3], R[4]); }
  else { yaw = Math.atan2(-R[6], R[0]); roll = 0; }
  return [pitch / RAD, yaw / RAD, roll / RAD];
}

type Box = { mn: Vec3; mx: Vec3 };
const sizeOf = (b: Box): Vec3 => [b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]];
const volumeOf = (b: Box) => { const s = sizeOf(b); return Math.max(0, s[0]) * Math.max(0, s[1]) * Math.max(0, s[2]); };
const unionBox = (a: Box | null, b: Box): Box => (a ? { mn: [Math.min(a.mn[0], b.mn[0]), Math.min(a.mn[1], b.mn[1]), Math.min(a.mn[2], b.mn[2])], mx: [Math.max(a.mx[0], b.mx[0]), Math.max(a.mx[1], b.mx[1]), Math.max(a.mx[2], b.mx[2])] } : b);
function intersect(a: Box, b: Box): Box | null {
  const mn: Vec3 = [Math.max(a.mn[0], b.mn[0]), Math.max(a.mn[1], b.mn[1]), Math.max(a.mn[2], b.mn[2])];
  const mx: Vec3 = [Math.min(a.mx[0], b.mx[0]), Math.min(a.mx[1], b.mx[1]), Math.min(a.mx[2], b.mx[2])];
  return mx[0] > mn[0] && mx[1] > mn[1] && mx[2] > mn[2] ? { mn, mx } : null;
}

// ── コンポーネントの既定値(src/core/ApplicationInternal.cpp の describe_components 表の写し) ─────────
const COMP_DEFAULTS: Record<string, any> = {
  pointLight: { color: [1, 1, 1], intensity: 1, range: 10, castShadows: false, sourceRadius: 0 },
  directionalLight: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1, ambient: 0.25 },
  spotLight: { color: [1, 1, 1], intensity: 3, range: 15, direction: [0, -1, 0], innerConeDeg: 18, outerConeDeg: 28, castShadows: false },
  camera: { fovDegrees: 60, nearClip: 0.1, farClip: 1000, isActive: false, projection: 0, orthoSize: 10, screenShaderEnabled: true, screenShaderParams: [0, 0, 0, 0], screenShaderPath: "" },
  rigidBody: { motionType: 2, mass: 1, restitution: 0.4, friction: 0.3, linearDamping: 0.02, angularDamping: 0.01, useGravity: true, continuousCollision: false },
  boxCollider: { halfExtents: [0.5, 0.5, 0.5], offset: [0, 0, 0] },
  sphereCollider: { radius: 0.5, offset: [0, 0, 0] },
  capsuleCollider: { radius: 0.5, halfHeight: 1, offset: [0, 0, 0] },
  characterController: { radius: 0.4, halfHeight: 0.6, offset: [0, 0, 0], mass: 70, maxSlopeDeg: 50, stepHeight: 0.3, jumpSpeed: 6, gravityScale: 1 },
  meshCollider: { offset: [0, 0, 0] },
  trigger: { actions: [], filter: "", halfExtents: [1, 1, 1], offset: [0, 0, 0], once: false, radius: 1, shape: 0 },
  particleEmitter: { kind: 0, blend: 0, rate: 30, orient: 0, playOnStart: true, looping: true, duration: 1, dir: [0, 1, 0], spread: 0.4, speed: 3, speedVar: 0.4, size: 0.3, sizeEnd: 0, life: 0.8, lifeVar: 0.3, color: [1, 0.6, 0.2], colorEnd: [1, 0.12, 0.05], intensity: 3, gravity: 0, drag: 1, light: false, lightRange: 3, flicker: 0, gpu: false, texturePath: "" },
  trailRenderer: { emitting: true, width: 0.25, life: 0.5, color: [0.4, 0.8, 1], colorEnd: [0.1, 0.2, 1], intensity: 2, blend: 0, minDist: 0.03 },
  decal: { atlasUV: [0, 0, 1, 1], atlasUVNormal: [0, 0, 0, 0], tint: [1, 1, 1], opacity: 1, emissive: [0, 0, 0], normalStrength: 1, roughness: -1, metallic: -1, angleFadeDeg: 60, fadeEdge: 0.1, sortOrder: 0 },
  audioSource: { clipPath: "", volume: 1, loop: false, spatial: true, playOnStart: true, minDistance: 1, maxDistance: 30, bus: "", priority: 128 },
  audioReverbZone: { preset: "room", shape: 0, halfExtents: [4, 2.5, 4], radius: 5, fadeDistance: 2, wet: 0.5, priority: 0, enabled: true },
  sprite2d: { texturePath: "", layer: 0, size: [1, 1], uvMin: [0, 0], uvMax: [1, 1], color: [1, 1, 1, 1], worldSpace: true, billboard: false },
  virtualGeometry: { vgeoPath: "", enabled: true },
  uiCanvas: { refHeight: 1080, refWidth: 1920, scaleMode: 0, sortOrder: 0, visible: true },
  uiRect: { anchorMin: [0.5, 0.5], anchorMax: [0.5, 0.5], pivot: [0.5, 0.5], offsetMin: [-50, -50], offsetMax: [50, 50], order: 0 },
  uiImage: { texturePath: "", color: [1, 1, 1, 1], shape: 0, raycastBlock: true },
  uiText: { text: "Text", fontSize: 32, color: [1, 1, 1, 1], alignH: 1, alignV: 1 },
  uiButton: { normalColor: [1, 1, 1, 1], hoverColor: [0.9, 0.9, 0.9, 1], pressedColor: [0.7, 0.7, 0.7, 1] },
  uiSlider: { value: 0.5, min: 0, max: 1 },
  uiToggle: { isOn: false },
  uiScrollView: { horizontal: false, vertical: true },
  luaScript: { scriptPath: "", enabled: true, props: [] },
  gridPlane: {},
};
/** componentTypes の並び(実エンジンのレジストリ順: プローブで transform, meshRenderer, rigidBody, boxCollider, data の順を確認)。 */
const COMP_ORDER = ["pointLight", "directionalLight", "spotLight", "camera", "rigidBody", "boxCollider", "sphereCollider", "capsuleCollider", "characterController", "meshCollider", "sprite2d", "trailRenderer", "decal", "trigger", "particleEmitter", "audioSource", "audioReverbZone", "virtualGeometry", "uiCanvas", "uiRect", "uiImage", "uiText", "uiButton", "uiSlider", "uiToggle", "uiScrollView", "luaScript", "gridPlane"];
const SETTABLE = new Set([...Object.keys(COMP_DEFAULTS).filter((k) => k !== "gridPlane"), "tags", "data"]);

const CREATE_TYPES = ["box", "sphere", "plane", "empty", "camera", "light_directional", "light_point", "light_spot", "particle_emitter", "trigger", "decal", "ui_canvas", "ui_image", "ui_text", "ui_button", "ui_slider", "ui_toggle", "ui_scrollview"];
const UI_DEFAULT_NAMES: Record<string, string> = { ui_canvas: "UICanvas", ui_image: "UIImage", ui_text: "UIText", ui_button: "UIButton", ui_slider: "UISlider", ui_toggle: "UIToggle", ui_scrollview: "UIScrollView" };

const PRESETS: Record<string, { label: string; tip: string; sun: { intensity: number; ambient: number; color: Vec3; az: number; el: number }; post: Record<string, any> }> = {
  day: { label: "昼", tip: "明るい日中", sun: { intensity: 1.2, ambient: 0.35, color: [1, 0.96, 0.88], az: 30, el: 50 }, post: { bloomOn: true, bloom: 0.3, exposure: 1, exposureOn: false, saturationOn: true, saturation: 1.05, vignetteOn: false } },
  dusk: { label: "夕暮れ", tip: "低い橙の光", sun: { intensity: 0.7, ambient: 0.2, color: [1, 0.6, 0.35], az: 80, el: 8 }, post: { bloomOn: true, bloom: 0.5, exposure: 0.9, exposureOn: true, saturationOn: true, saturation: 1.1, vignetteOn: true, vignette: 0.4 } },
  night: { label: "夜", tip: "青い月明かり", sun: { intensity: 0.1, ambient: 0.05, color: [0.5, 0.6, 1], az: 200, el: 35 }, post: { bloomOn: true, bloom: 0.5, exposure: 0.8, exposureOn: true, saturationOn: true, saturation: 0.8, vignetteOn: true, vignette: 0.5 } },
  indoor: { label: "屋内", tip: "落ち着いた暖色の環境光", sun: { intensity: 0.3, ambient: 0.5, color: [1, 0.95, 0.85], az: 0, el: 60 }, post: { bloomOn: true, bloom: 0.25, exposure: 1, exposureOn: false, saturationOn: false, vignetteOn: false } },
  horror: { label: "ホラー", tip: "ほぼ真っ暗 + 冷たい薄明かり + 強いビネット", sun: { intensity: 0.25, ambient: 0.02, color: [0.8797693848609924, 0.9083322882652283, 1], az: 30.0, el: -68 }, post: { bloom: 0.5, bloomOn: true, bloomThreshold: 1.2, exposure: 0.8, exposureOn: true, saturation: 0.6, saturationOn: true, vignette: 0.75, vignetteOn: true } },
  studio: { label: "スタジオ", tip: "均一で中立な光", sun: { intensity: 1, ambient: 0.4, color: [1, 1, 1], az: 20, el: 45 }, post: { bloomOn: true, bloom: 0.2, exposure: 1, exposureOn: false, saturationOn: false, vignetteOn: false } },
};

function kelvinToRgb(k: number): Vec3 {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}
const dirFromAzEl = (az: number, el: number): Vec3 => {
  const a = az * RAD, e = el * RAD;
  return [-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e)];
};

// ── 本体 ────────────────────────────────────────────────────────────────────
export function createSceneSim(opts: SimOptions = {}) {
  const assets = opts.assets ?? {};
  const scripts = opts.scripts ?? [];
  const textures = opts.textures ?? [];
  const prefabs = opts.prefabs ?? [];
  const scenes = opts.scenes ?? ["scenes/main.json"];
  const baseDir = opts.baseDir ?? "C:/mock/project/";
  const assetsDir = opts.assetsDir ?? `${baseDir}assets/`;

  const mkEntity = (p: Partial<SimEntity> & { name: string; kind: SimEntity["kind"] }): SimEntity => ({
    id: 0, guid: "", parent: null, comps: {},
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ...p,
  });

  const state: SimState = {
    entities: [], nextId: 1, settings: {}, tx: null, calls: [], failures: [], navBlocked: false, blockedPairs: [],
  };
  const grid = mkEntity({ name: "Grid", kind: "primitive", primitive: "plane", internal: true, comps: { gridPlane: {} } });
  grid.id = 1048576; grid.guid = "0000000000100000";
  state.entities.push(grid);
  const newGuid = () => crypto.randomBytes(8).toString("hex");

  // ── 検索 ──
  const byId = (id: number) => state.entities.find((e) => e.id === id);
  const byName = (n: string) => state.entities.find((e) => e.name === n);
  const childrenOf = (e: SimEntity) => state.entities.filter((c) => c.parent === e.id);
  const descendants = (e: SimEntity): SimEntity[] => { const out: SimEntity[] = []; const walk = (x: SimEntity, d: number) => { if (d > 64) return; for (const c of childrenOf(x)) { out.push(c); walk(c, d + 1); } }; walk(e, 0); return out; };
  const isDescendant = (e: SimEntity, anc: SimEntity) => { let c = e.parent != null ? byId(e.parent) : undefined; for (let d = 0; c && d < 64; d++) { if (c.id === anc.id) return true; c = c.parent != null ? byId(c.parent) : undefined; } return false; };
  const hasMesh = (e: SimEntity) => e.kind === "primitive" || e.kind === "model";

  const resolve = (p: any): SimEntity => {
    if (p && p.entity !== undefined && p.entity !== null) {
      const e = typeof p.entity === "number" ? byId(p.entity) : byName(String(p.entity));
      if (!e) throw simErr(1, "invalid entity id", { error_name: "E_NOT_FOUND_ENTITY", error_cause: "entityId が無効(Stop / open_scene で変わる)" });
      return e;
    }
    if (p && typeof p.name === "string") {
      const e = byName(p.name);
      if (e) return e;
      const dym = nearest(p.name, state.entities.filter((x) => !x.internal).map((x) => x.name));
      throw simErr(1, `no entity named '${p.name}'`, {
        error_name: "E_NOT_FOUND_ENTITY", error_cause: "この名前のエンティティがシーンに無い。名前は大文字小文字も含めて完全一致で引く",
        error_did_you_mean: dym, error_fix: [{ tool: "list_entities", args: { name_prefix: p.name.slice(0, 3) }, why: "先頭が同じ名前の一覧で正しい名前を確かめる" }],
      });
    }
    throw simErr(2, "entity or name is required", { error_name: "E_MISSING_PARAM" });
  };

  // ── 幾何 ──
  const localAabb = (e: SimEntity): Box | null => {
    if (e.kind === "primitive") {
      if (e.primitive === "plane") return { mn: [-25, 0, -25], mx: [25, 0, 25] };
      return { mn: [-0.5, -0.5, -0.5], mx: [0.5, 0.5, 0.5] };
    }
    if (e.kind === "model") { const a = assets[e.modelPath ?? ""]; return a ? { mn: a.min, mx: a.max } : { mn: [-0.5, -0.5, -0.5], mx: [0.5, 0.5, 0.5] }; }
    return null;
  };
  const worldXf = (e: SimEntity): { L: M3; t: Vec3 } => {
    const chain: SimEntity[] = [];
    let c: SimEntity | undefined = e;
    for (let d = 0; c && d < 64; d++) { chain.unshift(c); c = c.parent != null ? byId(c.parent) : undefined; }
    let L: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let t: Vec3 = [0, 0, 0];
    for (const x of chain) {
      const R = rotMat(x.transform.rotation); const s = x.transform.scale;
      const Ll: M3 = [R[0] * s[0], R[1] * s[1], R[2] * s[2], R[3] * s[0], R[4] * s[1], R[5] * s[2], R[6] * s[0], R[7] * s[1], R[8] * s[2]];
      const pt = apply3(L, x.transform.position);
      t = [t[0] + pt[0], t[1] + pt[1], t[2] + pt[2]];
      L = mul3(L, Ll);
    }
    return { L, t };
  };
  const ownBox = (e: SimEntity): Box | null => {
    const lb = localAabb(e);
    if (!lb) return null;
    const { L, t } = worldXf(e);
    let mn: Vec3 = [Infinity, Infinity, Infinity], mx: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const c: Vec3 = [i & 1 ? lb.mx[0] : lb.mn[0], i & 2 ? lb.mx[1] : lb.mn[1], i & 4 ? lb.mx[2] : lb.mn[2]];
      const w = apply3(L, c);
      const p: Vec3 = [w[0] + t[0], w[1] + t[1], w[2] + t[2]];
      mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1]), Math.min(mn[2], p[2])];
      mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1]), Math.max(mx[2], p[2])];
    }
    return { mn, mx };
  };
  /** 自分 + 子孫のメッシュを含めたワールド AABB(メッシュが無ければ null)。 */
  const deepBox = (e: SimEntity): Box | null => {
    let b: Box | null = ownBox(e);
    for (const d of descendants(e)) { const db = ownBox(d); if (db) b = unionBox(b, db); }
    return b;
  };

  // ── 変更の記録 ──
  const undoInfo = (method: string) => ({ undoEntry: `AI: ${method}`, ...(state.tx ? { undoTransaction: state.tx.label } : {}) });
  const requireEditor = (ctx: any, what: string) => {
    if (ctx.state.mode === "Playing") throw simErr(3, `cannot ${what} while Playing; call dx12_stop first`, { error_name: "E_MODE_CONFLICT", error_hint: "dx12_stop で Editor へ戻してから行う" });
  };
  const uniquify = (n: string, except?: SimEntity): string => {
    const exists = (q: string) => state.entities.some((e) => e !== except && e.name === q);
    if (!exists(n)) return n;
    let stem = n;
    const m = /^(.*) \(\d+\)$/.exec(n);
    if (m) stem = m[1];
    for (let i = 1; i < 1000; i++) { const cand = `${stem} (${i})`; if (!exists(cand)) return cand; }
    return n;
  };
  const addEntity = (e: SimEntity): SimEntity => { e.id = state.nextId++; e.guid = newGuid(); state.entities.push(e); return e; };
  const vec3Param = (v: any, label: string, example: string): Vec3 => {
    if (!isVec(v, 3)) throw simErr(2, `${label} must be [x,y,z]`, { error_name: "E_BAD_TYPE", error_hint: example });
    return v as Vec3;
  };
  const componentTypes = (e: SimEntity): string[] => {
    const out = ["transform"];
    if (hasMesh(e)) out.push("meshRenderer");
    const keys = Object.keys(e.comps);
    for (const k of COMP_ORDER) if (keys.includes(k)) out.push(k);
    for (const k of keys) if (!out.includes(k)) out.push(k);
    if (e.tags && e.tags.length) out.push("tags");
    if (e.data && Object.keys(e.data).length) out.push("data");
    return out;
  };
  const entityJson = (e: SimEntity): any => {
    const out: any = {
      componentTypes: componentTypes(e), entityId: e.id, guid: e.guid, luaReadable: ["transform"], name: e.name,
      sceneGeneration: 1, transform: clone(e.transform),
    };
    if (e.kind === "primitive") {
      out.primitive = e.primitive;
      if (e.primitive === "sphere") out.primitiveSize = 0.5;
      if (e.primitive === "plane") out.primitiveSize = 50;
    }
    if (e.kind === "model") {
      out.meshRenderer = { modelPath: e.modelPath };
      out.bakedTextures = [{ albedo: false, metalRoughness: false, normal: false }];
      out.material = { metallic: 1, roughness: 1, ...(e.material ?? {}) };
    } else if (e.material && Object.keys(e.material).length) out.material = clone(e.material);
    if (e.color) out.color = clone(e.color);
    if (e.textures && Object.keys(e.textures).length) out.materialTextureOverrides = clone(e.textures);
    for (const k of Object.keys(e.comps)) out[k] = clone(e.comps[k]);
    if (e.tags && e.tags.length) out.tags = [...e.tags];
    if (e.data && Object.keys(e.data).length) out.data = clone(e.data);
    return out;
  };

  // ── 失敗の注入 ──
  const failNext: (method: string, o?: { nth?: number; name?: string; message?: string; code?: number }) => void = (method, o = {}) => {
    state.failures.push({ method, nth: o.nth ?? 1, name: o.name, message: o.message ?? "simulated failure", code: o.code ?? 7, count: 0 });
  };
  const paramName = (p: any): string | undefined => {
    if (typeof p?.name === "string") return p.name;
    if (typeof p?.entity === "number") return byId(p.entity)?.name;
    return undefined;
  };
  const checkFail = (method: string, p: any) => {
    for (const f of state.failures) {
      if (f.method !== method) continue;
      if (f.name !== undefined && paramName(p) !== f.name) continue;
      f.count++;
      if (f.count >= f.nth) {
        state.failures.splice(state.failures.indexOf(f), 1);
        throw simErr(f.code, f.message, { error_name: "E_INTERNAL" });
      }
    }
  };

  // ── method 定義 ──
  const TX_COUNTED = new Set(["set_sun", "apply_lighting_preset"]);   // 太陽エンティティを触るので Undo に積まれる(設定系だが rollback される)
  const methods: MockMethod[] = [];
  type Handler = (p: any, ctx: any) => any;
  const def = (name: string, effect: "read" | "write_scene" | "write_setting" | "runtime", fn: Handler, extra: Record<string, unknown> = {}) => {
    methods.push({
      name, category: "scene", summary: `sim ${name}`, effect, mode: "any", timeoutMs: 8000, params: [], source: "meta", ...extra,
      handler: (p: any, ctx: any) => {
        const params = p ?? {};
        state.calls.push({ method: name, params: clone(params) });
        checkFail(name, params);
        const r = fn(params, ctx);
        if (state.tx && (effect === "write_scene" || TX_COUNTED.has(name))) state.tx.calls++;
        return r;
      },
    } as MockMethod);
  };

  // 読み取り
  def("list_entities", "read", (p) => {
    let list = state.entities;
    if (typeof p.name_prefix === "string") list = list.filter((e) => e.name.startsWith(p.name_prefix));
    if (typeof p.component_type === "string") list = list.filter((e) => componentTypes(e).includes(p.component_type));
    return {
      count: list.length, sceneGeneration: 1,
      entities: list.map((e) => ({ entityId: e.id, id: e.id, name: e.name, ...(p.verbose ? { componentTypes: componentTypes(e) } : {}) })),
    };
  });
  def("get_hierarchy", "read", () => {
    const node = (e: SimEntity): any => { const ch = childrenOf(e); return { entityId: e.id, name: e.name, ...(ch.length ? { children: ch.map(node) } : {}) }; };
    return { count: state.entities.length, roots: state.entities.filter((e) => e.parent === null).map(node), sceneGeneration: 1 };
  });
  def("get_entity", "read", (p) => entityJson(resolve(p)));
  def("find_entity", "read", (p) => { const e = byName(String(p.name ?? "")); return e ? { entityId: e.id, name: e.name } : null; });
  def("get_bounds", "read", (p) => {
    const e = resolve(p);
    const b = p.includeChildren ? deepBox(e) : ownBox(e);
    if (!b) {
      const t = worldXf(e).t;
      return { center: t, entityId: e.id, hasMesh: false, max: t, min: t, size: [0, 0, 0] };
    }
    const s = sizeOf(b);
    return { center: [(b.mn[0] + b.mx[0]) / 2, (b.mn[1] + b.mx[1]) / 2, (b.mn[2] + b.mx[2]) / 2], entityId: e.id, hasMesh: true, max: b.mx, min: b.mn, size: s };
  });
  const assetRows = (): { name: string; path: string; type: string }[] => {
    const stem = (p: string) => p.split("/").pop()!.replace(/\.[^.]*$/, "");
    return [
      ...Object.entries(assets).map(([path, a]) => ({ name: stem(path), path, type: a.type ?? "model" })),
      ...scripts.map((path) => ({ name: stem(path), path, type: "script" })),
      ...textures.map((path) => ({ name: stem(path), path, type: "texture" })),
      ...prefabs.map((path) => ({ name: stem(path), path, type: "prefab" })),
      ...scenes.map((path) => ({ name: stem(path), path, type: "scene" })),
    ];
  };
  const notFoundAsset = (path: string): Error => simErr(1, `asset not found: ${path}`, {
    error_name: "E_NOT_FOUND_ASSET", error_cause: "assets 相対パスに一致するアセットが無い",
    error_did_you_mean: nearest(path, assetRows().map((a) => a.path)),
    error_fix: [{ tool: "list_assets", args: {}, why: "実在するアセットのパスを確かめる" }],
  });
  def("list_assets", "read", (p) => assetRows().filter((a) => !p.type || a.type === p.type));
  def("asset_info", "read", (p) => {
    const path = String(p.path ?? "");
    const row = assetRows().find((a) => a.path === path);
    if (!row) throw notFoundAsset(path);
    if (row.type === "model") {
      const a = assets[path];
      return { aabbMax: a.max, aabbMin: a.min, aabbNote: "ノード変換込みのワールド AABB(スケール1で spawn した時の実サイズ)", animations: [], boneCount: 0, fileSizeBytes: 1748, hasSkeleton: false, materialCount: 1, meshCount: 1, path, totalFaces: 12, totalVertices: 24, type: "model" };
    }
    return { path, type: row.type, fileSizeBytes: 100 };
  });
  def("get_scene_settings", "read", () => ({
    decalAtlasPath: state.settings.scene?.decalAtlasPath ?? "",
    note: "post-process は dx12_get_post_process、SSAO は dx12_get_ssao を使う",
    skybox: { drawSkybox: true, envMapPath: "__procedural_sky__", iblIntensity: 1, skyboxIntensity: 1, ...(state.settings.scene?.skybox ?? {}) },
    atmosphere: { enabled: false, timeOfDay: 12, timeSpeed: 0, latitudeDeg: 35, dayOfYear: 81, sunMode: 0, driveSun: true, driveIBL: true, ...(state.settings.scene?.atmosphere ?? {}) },
    atmosphereState: { active: false },
  }));
  def("get_post_process", "read", () => ({ enabled: true, bloom: 0.4, bloomOn: false, exposure: 1, exposureOn: false, saturation: 1, saturationOn: false, vignette: 0.3, vignetteOn: false, ...(state.settings.post ?? {}) }));
  def("get_log", "read", () => ({ lines: [], entries: [] }));
  def("get_mode", "read", (_p, ctx) => ({ mode: ctx.state.mode }));
  def("describe_components", "read", () => ({
    components: [{ jsonKey: "transform", settable: true, removable: false, fields: [] }, ...[...SETTABLE].map((k) => ({ jsonKey: k, settable: true, removable: true, fields: Object.entries(COMP_DEFAULTS[k] ?? {}).map(([name, d]) => ({ name, default: d })) }))],
  }));
  def("validate_scene", "read", (p) => ({ pass: true, exitCode: 0, report: "PASS", scenePath: p.path ?? "scenes/main.json" }));

  // 生成
  const finishCreate = (e: SimEntity, position: any, name: string) => {
    e.name = uniquify(name);
    if (position !== undefined) e.transform.position = fr(vec3Param(position, "position", "例: position:[0, 0.5, 0]（ワールド座標の 3 要素）"));
    return addEntity(e);
  };
  def("create_entity", "write_scene", (p, ctx) => {
    requireEditor(ctx, "create entities");
    const type = String(p.type ?? "box");
    if (!CREATE_TYPES.includes(type)) throw simErr(2, `type must be one of: ${CREATE_TYPES.join(", ")}`, { error_name: "E_BAD_ENUM", error_values: CREATE_TYPES, error_did_you_mean: nearest(type, CREATE_TYPES, 3) });
    let name = typeof p.name === "string" ? p.name : "";
    if (!name) name = UI_DEFAULT_NAMES[type] ?? (type[0].toUpperCase() + type.slice(1));
    const prim = (["box", "sphere", "plane"] as const).find((x) => x === type);
    let e: SimEntity;
    const ids: number[] = [];
    if (prim) e = mkEntity({ name, kind: "primitive", primitive: prim });
    else if (type === "empty") e = mkEntity({ name, kind: "empty" });
    else if (type === "camera") e = mkEntity({ name, kind: "camera", comps: { camera: { ...clone(COMP_DEFAULTS.camera), isActive: true } } });
    else if (type === "light_point") e = mkEntity({ name, kind: "light", comps: { pointLight: clone(COMP_DEFAULTS.pointLight) } });
    else if (type === "light_spot") e = mkEntity({ name, kind: "light", comps: { spotLight: clone(COMP_DEFAULTS.spotLight) } });
    else if (type === "light_directional") { e = mkEntity({ name, kind: "light", comps: { directionalLight: clone(COMP_DEFAULTS.directionalLight) } }); e.transform.rotation = [-30, 0, 0]; }
    else if (type === "trigger") e = mkEntity({ name, kind: "trigger", comps: { trigger: clone(COMP_DEFAULTS.trigger) } });
    else if (type === "particle_emitter") e = mkEntity({ name, kind: "other", comps: { particleEmitter: clone(COMP_DEFAULTS.particleEmitter) } });
    else if (type === "decal") e = mkEntity({ name, kind: "other", comps: { decal: clone(COMP_DEFAULTS.decal) } });
    else if (type === "ui_canvas") e = mkEntity({ name, kind: "other", comps: { uiCanvas: clone(COMP_DEFAULTS.uiCanvas) } });
    else {
      // ui_*: 親 Canvas を自動選択/生成する(実エンジンと同じ)。
      let canvas = state.entities.find((x) => x.comps.uiCanvas);
      if (!canvas) { canvas = addEntity(mkEntity({ name: uniquify("UICanvas"), kind: "other", comps: { uiCanvas: clone(COMP_DEFAULTS.uiCanvas) } })); ids.push(canvas.id); }
      const key = { ui_image: "uiImage", ui_text: "uiText", ui_button: "uiButton", ui_slider: "uiSlider", ui_toggle: "uiToggle", ui_scrollview: "uiScrollView" }[type as string] as string;
      e = mkEntity({ name, kind: "other", parent: canvas.id, comps: { uiRect: clone(COMP_DEFAULTS.uiRect), [key]: clone(COMP_DEFAULTS[key]) } });
    }
    finishCreate(e, p.position, name);
    ids.push(e.id);
    return { entityId: e.id, name: e.name, sceneGeneration: 1, ...(type.startsWith("ui_") ? { entityIds: [e.id] } : {}) };
  });
  def("spawn_model", "write_scene", (p, ctx) => {
    requireEditor(ctx, "spawn");
    const path = String(p.path ?? "");
    if (!path) throw simErr(2, "missing 'path'", { error_name: "E_MISSING_PARAM" });
    if (path[0] === "/" || path.includes("\\") || path.includes(":") || path.includes("..")) throw simErr(2, "invalid path (assets 相対のみ)", { error_name: "E_INVALID_PARAM" });
    if (!assets[path]) throw notFoundAsset(path);
    const name = typeof p.name === "string" && p.name ? p.name : path.split("/").pop()!.replace(/\.[^.]*$/, "");
    const e = finishCreate(mkEntity({ name, kind: "model", modelPath: path }), p.position, name);
    return { entityId: e.id, name: e.name, sceneGeneration: 1 };
  });
  def("spawn_prefab", "write_scene", (p, ctx) => {
    requireEditor(ctx, "spawn");
    const path = String(p.path ?? "");
    if (!prefabs.includes(path)) throw notFoundAsset(path);
    const name = typeof p.name === "string" && p.name ? p.name : path.split("/").pop()!.replace(/\.[^.]*$/, "");
    const root = finishCreate(mkEntity({ name, kind: "prefab" }), p.position, name);
    const body = addEntity(mkEntity({ name: uniquify(`${root.name}_Body`), kind: "primitive", primitive: "box", parent: root.id }));
    return { entityId: root.id, rootEntityId: root.id, entityIds: [root.id, body.id], name: root.name, sceneGeneration: 1 };
  });
  def("delete_entity", "write_scene", (p, ctx) => {
    requireEditor(ctx, "delete");
    const e = resolve(p);
    const gone = new Set([e.id, ...descendants(e).map((d) => d.id)]);
    state.entities = state.entities.filter((x) => !gone.has(x.id));
    return { deletedEntityId: e.id, deletedCount: gone.size, sceneGeneration: 1, ...undoInfo("delete_entity") };
  });
  def("rename_entity", "write_scene", (p) => {
    const e = resolve({ entity: p.entity });
    if (typeof p.name !== "string" || !p.name) throw simErr(2, "missing 'name'", { error_name: "E_MISSING_PARAM" });
    e.name = uniquify(p.name, e);
    return { entityId: e.id, name: e.name, ...undoInfo("rename_entity") };
  });

  // 編集
  def("set_transform", "write_scene", (p) => {
    const e = resolve(p);
    const t = e.transform;
    if (p.position !== undefined) t.position = fr(vec3Param(p.position, "position", "例: position:[1, 0, -2]（ワールド座標の 3 要素）"));
    if (p.rotation !== undefined) t.rotation = fr(vec3Param(p.rotation, "rotation", "例: rotation:[0, 90, 0]（度単位のオイラー角 [x,y,z]）"));
    if (p.quaternion !== undefined) {
      if (!isVec(p.quaternion, 4)) throw simErr(2, "quaternion must be [x,y,z,w]", { error_name: "E_BAD_TYPE" });
      t.rotation = fr(quatToEuler(p.quaternion));
    }
    if (p.scale !== undefined) t.scale = fr(vec3Param(p.scale, "scale", "例: scale:[1, 1, 1]（3 要素）"));
    return { entityId: e.id, ...undoInfo("set_transform") };
  });
  def("set_color", "write_scene", (p) => {
    const e = resolve(p);
    e.color = fr(vec3Param(p.color, "color", "例: color:[1, 0.5, 0]（0..1 の 3 要素）"));
    return { color: e.color, entityId: e.id, ...undoInfo("set_color") };
  });
  def("set_pbr", "write_scene", (p) => {
    const e = resolve(p);
    const keys = ["metallic", "roughness", "emissiveColor", "emissiveIntensity", "opacity", "alphaMode", "alphaCutoff", "uvScaleU", "uvScaleV"];
    if (p.alphaMode !== undefined && !["auto", "opaque", "mask", "blend"].includes(p.alphaMode)) throw simErr(2, "alphaMode must be one of: auto, opaque, mask, blend", { error_name: "E_BAD_ENUM", error_values: ["auto", "opaque", "mask", "blend"] });
    e.material = e.material ?? {};
    for (const k of keys) if (p[k] !== undefined) e.material[k] = fr(p[k]);
    const m = e.material;
    return { alphaCutoff: -1, alphaMode: "auto", emissiveColor: [0, 0, 0], emissiveIntensity: 0, entityId: e.id, metallic: 0, opacity: 1, roughness: 0.5, uvScaleU: 1, uvScaleV: 1, ...m, ...undoInfo("set_pbr") };
  });
  def("set_texture", "write_scene", (p) => {
    const e = resolve(p);
    if (!hasMesh(e)) throw simErr(6, "entity has no MeshRenderer", { error_name: "E_NOT_FOUND_COMPONENT" });
    const path = String(p.path ?? "");
    if (!textures.includes(path)) throw notFoundAsset(path);
    const slot = String(p.slot ?? "albedo");
    if (!["albedo", "normal", "metalRoughness", "emissive"].includes(slot)) throw simErr(2, "slot must be one of: albedo, normal, metalRoughness, emissive", { error_name: "E_BAD_ENUM", error_values: ["albedo", "normal", "metalRoughness", "emissive"] });
    e.textures = { ...(e.textures ?? {}), [slot]: path };
    return { entityId: e.id, path, slot, ...undoInfo("set_texture") };
  });
  def("set_component", "write_scene", (p) => {
    const e = resolve(p);
    const comp = String(p.component ?? "");
    if (!comp) throw simErr(2, "missing 'component'", { error_name: "E_MISSING_PARAM" });
    const data = p.data !== undefined ? p.data : p.values;
    if (comp === "tags" && Array.isArray(data)) {
      if (data.some((s: any) => typeof s !== "string")) throw simErr(2, "tags must be an array of strings", { error_name: "E_BAD_TYPE" });
      e.tags = [...data];
      return { component: comp, entityId: e.id, ...undoInfo("set_component") };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length === 0) {
      throw simErr(2, "missing component fields: pass a non-empty 'data' object", { error_name: "E_MISSING_PARAM", error_hint: "例: data:{\"intensity\": 2.5}（変えたいフィールドだけでよい。名前と型は dx12_describe_components）" });
    }
    if (comp === "transform") {
      if (data.position !== undefined) e.transform.position = fr(vec3Param(data.position, "position", "例: data:{\"position\":[0, 1, 0]}（3 要素）"));
      if (data.rotation !== undefined) e.transform.rotation = fr(vec3Param(data.rotation, "rotation", "例: data:{\"rotation\":[0, 90, 0]}"));
      if (data.scale !== undefined) e.transform.scale = fr(vec3Param(data.scale, "scale", "例: data:{\"scale\":[1, 1, 1]}"));
    } else if (comp === "data") {
      for (const [k, v] of Object.entries<any>(data)) {
        if (!v || typeof v !== "object" || typeof v.t !== "string") throw simErr(2, `data.${k} must be {t,v}`, { error_name: "E_BAD_TYPE", error_hint: "data={\"hp\":{\"t\":\"number\",\"v\":100}}" });
      }
      e.data = { ...(e.data ?? {}), ...clone(data) };
    } else if (SETTABLE.has(comp) && comp !== "tags") {
      const cur = e.comps[comp] ?? clone(COMP_DEFAULTS[comp] ?? {});
      e.comps[comp] = fr({ ...cur, ...clone(data) });
    } else {
      throw simErr(6, `unknown/unsupported component: ${comp} (call dx12_describe_components)`, {
        error_name: "E_NOT_FOUND_COMPONENT", error_did_you_mean: nearest(comp, [...SETTABLE], 3), error_hint: "dx12_describe_components で settable な jsonKey を確かめる",
      });
    }
    return { component: comp, entityId: e.id, ...undoInfo("set_component") };
  });
  def("remove_component", "write_scene", (p) => {
    const e = resolve(p);
    const comp = String(p.component ?? "");
    if (comp === "transform" || comp === "name") throw simErr(2, "cannot remove core component (transform/name)", { error_name: "E_INVALID_PARAM" });
    let removed = false;
    if (comp === "tags" && e.tags) { delete e.tags; removed = true; }
    else if (comp === "data" && e.data) { delete e.data; removed = true; }
    else if (comp in e.comps) { delete e.comps[comp]; removed = true; }
    if (!removed) throw simErr(6, `unknown/unsupported component: ${comp} (call dx12_describe_components)`, { error_name: "E_NOT_FOUND_COMPONENT", error_did_you_mean: nearest(comp, Object.keys(e.comps), 3) });
    return { entityId: e.id, removed: comp, ...undoInfo("remove_component") };
  });
  def("set_parent", "write_scene", (p) => {
    const e = resolve(p);
    if (p.parent === undefined || p.parent === null) { e.parent = null; return { entityId: e.id, ...undoInfo("set_parent") }; }
    const par = typeof p.parent === "number" ? byId(p.parent) : undefined;
    if (!par) throw simErr(2, "invalid parent id", { error_name: "E_NOT_FOUND_ENTITY", error_cause: "parent は既存エンティティの entityId(名前では指せない)" });
    if (par.id === e.id || isDescendant(par, e)) throw simErr(2, "set_parent would create a cycle", { error_name: "E_INVALID_PARAM" });
    e.parent = par.id;   // ★ワールド座標は保持しない(transform 値はそのままローカルとして解釈される)
    return { entityId: e.id, parent: par.id, ...undoInfo("set_parent") };
  });
  def("attach_lua_component", "write_scene", (p) => {
    const e = resolve(p);
    const script = String(p.script ?? "");
    if (!scripts.includes(script)) throw notFoundAsset(script);
    e.comps.luaScript = { scriptPath: script, enabled: true, props: [] };
    return { entityId: e.id, ok: true };
  });
  def("set_lua_property", "write_scene", (p) => {
    const e = resolve(p);
    const ls = e.comps.luaScript;
    if (!ls) throw simErr(6, "entity has no LuaScript", { error_name: "E_NOT_FOUND_COMPONENT" });
    const key = String(p.key ?? "");
    if (!key) throw simErr(2, "missing 'key'", { error_name: "E_MISSING_PARAM" });
    const props: any[] = Array.isArray(ls.props) ? ls.props : (ls.props = []);
    const cur = props.find((x) => x.name === key);
    if (cur) cur.value = p.value; else props.push({ name: key, value: p.value });
    return { entityId: e.id, key, value: p.value, ...undoInfo("set_lua_property") };
  });
  def("look_at", "write_scene", (p) => {
    const e = resolve(p);
    let target: Vec3;
    if (p.target !== undefined) target = vec3Param(p.target, "target", "例: target:[0, 1, 5]");
    else if (typeof p.targetName === "string") target = worldXf(resolve({ name: p.targetName })).t;
    else if (p.targetEntity !== undefined) target = worldXf(resolve({ entity: p.targetEntity })).t;
    else throw simErr(2, "target / targetName / targetEntity のどれかが要る", { error_name: "E_MISSING_PARAM" });
    const pos = worldXf(e).t;
    const d = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
    const yaw = Math.atan2(d[0], d[2]) / RAD;
    const pitch = -Math.atan2(d[1], Math.hypot(d[0], d[2])) / RAD;
    e.transform.rotation = fr([pitch === 0 ? 0 : pitch, yaw === 0 ? 0 : yaw, 0]);
    return { entityId: e.id, rotation: e.transform.rotation, target, ...undoInfo("look_at") };
  });
  /** snap_to_ground / 自動修正の共通: 対象の真下で最初に当たる面(他メッシュ AABB の天面)。 */
  const supportBelow = (e: SimEntity, b: Box, groundLikeOnly = false): { y: number; by: SimEntity } | null => {
    const cx = (b.mn[0] + b.mx[0]) / 2, cz = (b.mn[2] + b.mx[2]) / 2;
    const limit = b.mx[1] + 0.05;
    let best: { y: number; by: SimEntity } | null = null;
    for (const o of state.entities) {
      if (o === e || o.internal || !hasMesh(o) || isDescendant(o, e) || isDescendant(e, o)) continue;
      const ob = ownBox(o);
      if (!ob || cx < ob.mn[0] || cx > ob.mx[0] || cz < ob.mn[2] || cz > ob.mx[2] || ob.mx[1] > limit) continue;
      if (groundLikeOnly) { const db = deepBox(o); if (!db || isProp(db)) continue; }
      if (!best || ob.mx[1] > best.y) best = { y: ob.mx[1], by: o };
    }
    return best;
  };
  const moveWorldY = (e: SimEntity, dy: number) => {
    const par = e.parent != null ? byId(e.parent) : undefined;
    const sy = par ? Math.abs(worldXf(par).L[4]) || 1 : 1;
    e.transform.position = fr([e.transform.position[0], e.transform.position[1] + dy / sy, e.transform.position[2]]);
  };
  def("snap_to_ground", "write_scene", (p) => {
    const e = resolve(p);
    const b = deepBox(e);
    if (!b) return { entityId: e.id, moved: false, method: "raycast", position: e.transform.position, note: "メッシュが無い" };
    const hit = supportBelow(e, b);
    if (!hit) return { entityId: e.id, moved: false, method: "raycast", position: e.transform.position, note: "真下に面が無い" };
    const movedBy = fr(hit.y + (typeof p.offset === "number" ? p.offset : 0) - b.mn[1]);
    moveWorldY(e, movedBy);
    return { entityId: e.id, groundEntityId: hit.by.id, groundY: hit.y, method: "raycast", movedBy, moved: true, position: e.transform.position, ...undoInfo("snap_to_ground") };
  });

  // トランザクション
  def("transaction_begin", "runtime", (p) => {
    if (state.tx) throw simErr(3, "transaction already open", { error_name: "E_MODE_CONFLICT", error_hint: "先に transaction_commit か transaction_rollback で閉じる" });
    const label = typeof p.label === "string" && p.label ? p.label : "mcp";
    state.tx = { label, snapshot: { entities: clone(state.entities), nextId: state.nextId }, calls: 0 };
    return { entryName: `AI: ${label}`, idleTimeoutSec: 600, label, note: "以降の編集は 1 エントリにまとまる", open: true, undoDepth: 0 };
  });
  def("transaction_commit", "runtime", () => {
    if (!state.tx) throw simErr(3, "no open transaction", { error_name: "E_MODE_CONFLICT" });
    const tx = state.tx; state.tx = null;
    return { committed: true, label: tx.label, calls: tx.calls, pushed: tx.calls > 0, entryName: `AI: ${tx.label}`, humanEditsDuringTransaction: 0 };
  });
  def("transaction_rollback", "runtime", () => {
    if (!state.tx) throw simErr(3, "no open transaction", { error_name: "E_MODE_CONFLICT" });
    const tx = state.tx; state.tx = null;
    state.entities = clone(tx.snapshot.entities);
    state.nextId = tx.snapshot.nextId;
    return { rolledBack: true, label: tx.label, calls: tx.calls, humanEditsDuringTransaction: 0, sceneGeneration: 1, note: "begin 以降の AI の編集を逆順に戻した" };
  });
  def("transaction_status", "read", () => ({ open: !!state.tx, label: state.tx?.label ?? null, calls: state.tx?.calls ?? 0 }));

  // 設定系(rollback で戻らない)
  const findSun = () => state.entities.find((e) => e.comps.directionalLight);
  def("apply_lighting_preset", "write_setting", (p) => {
    const preset = String(p.preset ?? "");
    const P = PRESETS[preset];
    if (!P) throw simErr(2, `unknown preset: ${preset}`, { error_name: "E_BAD_ENUM", error_values: Object.keys(PRESETS), error_did_you_mean: nearest(preset, Object.keys(PRESETS), 3) });
    const sun = findSun();
    let sunOut: any = null;
    if (sun) {
      const direction = fr(preset === "horror" ? [0.185495525598526, -0.9274778962135315, 0.3246169984340668] : dirFromAzEl(P.sun.az, P.sun.el));
      sun.comps.directionalLight = { ...sun.comps.directionalLight, ambient: fr(P.sun.ambient), color: fr(P.sun.color), direction, intensity: fr(P.sun.intensity) };
      sunOut = { ambient: P.sun.ambient, color: P.sun.color, direction, entityId: sun.id, intensity: P.sun.intensity };
    }
    state.settings.lighting = preset;
    state.settings.post = { ...(state.settings.post ?? {}), ...clone(P.post) };
    return { label: P.label, note: "太陽 + ポストをまとめて適用した(冪等)", post: clone(P.post), preset, sun: sunOut, tip: P.tip, ...undoInfo("apply_lighting_preset") };
  });
  def("set_sun", "write_setting", (p) => {
    const sun = findSun();
    if (!sun) throw simErr(1, "no directional light in scene", { error_name: "E_NOT_FOUND_ENTITY", error_cause: "太陽(DirectionalLight)が無い" });
    const cur = sun.comps.directionalLight;
    const v = [-cur.direction[0], -cur.direction[1], -cur.direction[2]];
    let az = Math.atan2(v[0], v[2]) / RAD, el = Math.asin(Math.max(-1, Math.min(1, v[1]))) / RAD;
    let tod: number | null = null;
    if (typeof p.timeOfDay === "number") { tod = p.timeOfDay; az = ((tod - 6) / 12) * 180 - 90 + 180; el = 90 * Math.sin(((tod - 6) / 12) * Math.PI); }
    if (typeof p.azimuth === "number") az = p.azimuth;
    if (typeof p.elevation === "number") el = p.elevation;
    const next: any = { ...cur, direction: fr(dirFromAzEl(az, el)) };
    if (isVec(p.color, 3)) next.color = fr(p.color);
    else if (typeof p.kelvin === "number") next.color = fr(kelvinToRgb(p.kelvin));
    if (typeof p.intensity === "number") next.intensity = fr(p.intensity);
    if (typeof p.ambient === "number") next.ambient = fr(p.ambient);
    sun.comps.directionalLight = next;
    state.settings.sun = { azimuth: az, elevation: el, timeOfDay: tod };
    return { ambient: next.ambient, azimuthDeg: fr(az), color: next.color, direction: next.direction, elevationDeg: fr(el), entityId: sun.id, intensity: next.intensity, name: sun.name, note: "絶対指定＝同じ引数の再実行で同じ結果(冪等)", timeOfDay: tod, ...undoInfo("set_sun") };
  });
  def("set_scene_settings", "write_setting", (p) => {
    if (p.skybox === undefined && p.decalAtlasPath === undefined && p.atmosphere === undefined) throw simErr(2, "skybox か atmosphere か decalAtlasPath が要る", { error_name: "E_MISSING_PARAM" });
    const cur = state.settings.scene ?? {};
    const { preset: _preset, ...atmo } = (p.atmosphere ?? {}) as Record<string, unknown>;
    state.settings.scene = { ...cur, ...(p.decalAtlasPath !== undefined ? { decalAtlasPath: p.decalAtlasPath } : {}), skybox: { ...(cur.skybox ?? {}), ...(p.skybox ?? {}) },
      atmosphere: { ...(cur.atmosphere ?? {}), ...atmo } };
    return { applied: true, decalAtlasPath: state.settings.scene.decalAtlasPath ?? "", envMapRebake: false };
  });
  def("navmesh_build", "write_scene", (_p, ctx) => {
    requireEditor(ctx, "build navmesh");
    const meshes = state.entities.filter((e) => hasMesh(e) && !e.internal).length;
    state.settings.navmesh = { built: true, polyCount: Math.max(1, meshes * 2) };
    return { ok: true, built: true, polyCount: state.settings.navmesh.polyCount };
  });
  def("navmesh_info", "read", () => ({ config: {}, stats: { built: !!state.settings.navmesh?.built, polyCount: state.settings.navmesh?.polyCount ?? 0 }, debugDraw: false }));
  def("navmesh_path", "read", (p) => {
    const from = vec3Param(p.from, "from", "例: from:[0,0,0]"), to = vec3Param(p.to, "to", "例: to:[0,0,10]");
    const near = (a: Vec3, b: Vec3, r: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= r;
    const blocked = state.navBlocked || state.blockedPairs.some((bp) => { const r = bp.radius ?? 1; return (near(from, bp.from, r) && near(to, bp.to, r)) || (near(from, bp.to, r) && near(to, bp.from, r)); });
    if (blocked || !state.settings.navmesh?.built) return { points: [], reached: false };
    return { points: [from, to], reached: true, length: Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) };
  });

  // ── 配置検査 ──
  function isProp(b: Box): boolean { const s = sizeOf(b); return s[0] * s[2] <= 25 && s[1] <= 6; }
  def("validate_layout", "read", (p, ctx) => {
    requireEditor(ctx, "validate layout");
    const fixStr = p.fix ?? "none";
    if (!["none", "safe", "all"].includes(fixStr)) throw simErr(2, `unknown fix mode: ${fixStr}`, { error_name: "E_BAD_ENUM", error_values: ["none", "safe", "all"] });
    const fixMode = fixStr === "none" ? 0 : fixStr === "safe" ? 1 : 2;
    const tol = typeof p.tolerance === "number" ? p.tolerance : 0.001;
    const items: { e: SimEntity; b: Box }[] = [];
    for (const e of state.entities) {
      if (!hasMesh(e) || e.internal || e.comps.uiRect) continue;
      let anc = e.parent != null ? byId(e.parent) : undefined, has = false;
      for (let d = 0; anc && d < 64; d++) { if (hasMesh(anc)) { has = true; break; } anc = anc.parent != null ? byId(anc.parent) : undefined; }
      if (has) continue;
      const b = deepBox(e);
      if (b) items.push({ e, b });
    }
    type Issue = { kind: string; level: 1 | 2; e: SimEntity; other?: SimEntity; text: string; fixed: boolean };
    const issues: Issue[] = [];
    const add = (kind: string, level: 1 | 2, e: SimEntity, text: string, other?: SimEntity) => issues.push({ kind, level, e, other, text, fixed: false });
    // ② スケール異常
    for (const it of items) {
      const s = it.e.transform.scale;
      if (s.some((v) => v <= 0)) { add("SCALE_ANOMALY", 2, it.e, `${it.e.name}: スケールに 0 か負の値が入っている（面が裏返る/消える）`); continue; }
      const big = Math.max(...sizeOf(it.b));
      if (big > 1000) add("SCALE_ANOMALY", 1, it.e, `${it.e.name}: 一辺 ${big.toFixed(0)}m。単位の取り違え（cm→m）か spawn スケールの事故を疑う`);
      else if (big > 0 && big < 0.005) add("SCALE_ANOMALY", 1, it.e, `${it.e.name}: 一辺 ${(big * 1000).toFixed(1)}mm。画面にはまず映らない。モデルの実寸は dx12_asset_info で確認`);
    }
    // ③ 当たり判定の欠落
    const usesPhysics = state.entities.some((e) => e.comps.rigidBody || e.comps.characterController);
    for (const it of items) {
      const c = it.e.comps;
      const hasCol = !!(c.boxCollider || c.sphereCollider || c.capsuleCollider);
      if (hasCol && !c.rigidBody && !c.characterController) {
        add("COLLIDER_WITHOUT_BODY", 2, it.e, `${it.e.name}: コライダーはあるが rigidBody が無い。このエンジンは rigidBody が無いと Jolt に載らない＝当たり判定は効いていない。dx12_set_component(component:"rigidBody", data:{motionType:0, mass:0}) を足すこと`);
        continue;
      }
      const s = sizeOf(it.b);
      const walkable = s[0] * s[2] >= 4 || s[1] >= 2;
      if (usesPhysics && !c.rigidBody && !c.characterController && walkable)
        add("NO_COLLIDER", 1, it.e, `${it.e.name}: 一辺 ${Math.max(...s).toFixed(1)}m あるのに当たり判定が無い（すり抜ける）。床/壁/足場なら rigidBody を付ける`);
    }
    // ④ 二重配置
    const dupPairs = new Set<string>();
    const dupEntities = new Set<SimEntity>();
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i].e.transform.position, b = items[j].e.transform.position;
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.01) continue;
      const sa = sizeOf(items[i].b), sb = sizeOf(items[j].b);
      if (Math.abs(sa[0] - sb[0]) > 0.01 || Math.abs(sa[1] - sb[1]) > 0.01 || Math.abs(sa[2] - sb[2]) > 0.01) continue;
      dupPairs.add(`${i},${j}`); dupEntities.add(items[i].e); dupEntities.add(items[j].e);
      add("DUPLICATE", 2, items[j].e, `${items[j].e.name} が ${items[i].e.name} と同じ場所に重なっている（同じ生成を 2 回撃った疑い）。片方を dx12_delete_entity で消すこと`, items[i].e);
    }
    // ⑤ 面同士の重なり(Z ファイト)
    const kThin = Math.max(0.001, tol);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      if (dupPairs.has(`${i},${j}`)) continue;
      const ov = intersect(items[i].b, items[j].b);
      if (!ov) continue;
      const os = sizeOf(ov);
      if (Math.min(...os) > kThin || Math.max(...os) < 0.10) continue;
      const axis = os[0] <= os[1] && os[0] <= os[2] ? "X" : os[1] <= os[2] ? "Y" : "Z";
      const iSmaller = volumeOf(items[i].b) <= volumeOf(items[j].b);
      const mover = iSmaller ? items[i] : items[j], anchor = iSmaller ? items[j] : items[i];
      add("Z_FIGHT", 2, mover.e, `${anchor.e.name} と ${mover.e.name} の面が ${axis} 軸で ${(Math.min(...os) * 1000).toFixed(2)}mm しか離れていない（${Math.max(...os).toFixed(1)}m 四方が重なる）。描画がちらつく。小さい方の ${mover.e.name} を ${axis} 方向へ 5mm ずらすこと`, anchor.e);
    }
    // ⑥ 深い貫通
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      if (dupPairs.has(`${i},${j}`)) continue;
      const ov = intersect(items[i].b, items[j].b);
      if (!ov) continue;
      if (Math.min(...sizeOf(ov)) <= kThin) continue;
      const smaller = Math.min(volumeOf(items[i].b), volumeOf(items[j].b));
      if (smaller <= 1e-6) continue;
      const ratio = volumeOf(ov) / smaller;
      if (ratio < 0.30) continue;
      add("OVERLAP", ratio > 0.80 ? 2 : 1, items[j].e, `${items[j].e.name} が ${items[i].e.name} に体積比 ${(ratio * 100).toFixed(0)}%めり込んでいる。どちらかをずらすか片方を消すこと`, items[i].e);
    }
    // ⑦ 浮き / めり込み
    for (const it of items) {
      if (!isProp(it.b) || dupEntities.has(it.e)) continue;
      const support = supportBelow(it.e, it.b);
      if (!support) continue;
      const ground = supportBelow(it.e, it.b, true);
      const gap = ground ? it.b.mn[1] - ground.y : 1;
      const sy = sizeOf(it.b)[1];
      if (gap < 0) {
        const depth = -gap;
        if (depth > Math.max(0.05, Math.min(0.5, sy * 0.25)))
          add("BURIED", 2, it.e, `${it.e.name} が地面へ ${depth.toFixed(2)}m 埋まっている（高さ ${sy.toFixed(2)}m の ${(sy > 0 ? (depth / sy) * 100 : 0).toFixed(0)}%）。dx12_snap_to_ground で接地させること`);
      } else {
        const lift = it.b.mn[1] - support.y;
        if (lift > Math.max(0.10, sy * 0.5)) add("FLOATING", 1, it.e, `${it.e.name} が真下の面から ${lift.toFixed(2)}m 浮いている。dx12_snap_to_ground で接地させること`);
      }
    }
    // ⑧ 自動修正(検出時の issues の順に。C++ と同じ)
    let fixed = 0;
    if (fixMode > 0) {
      for (const is of issues) {
        if (!state.entities.includes(is.e)) continue;
        if (is.kind === "BURIED" || is.kind === "FLOATING") {
          const b = deepBox(is.e);
          if (!b) continue;
          const land = supportBelow(is.e, b);
          if (!land) continue;
          moveWorldY(is.e, land.y - b.mn[1]);
          is.fixed = true; fixed++;
        } else if (is.kind === "Z_FIGHT" && is.other) {
          const a = deepBox(is.e), o = deepBox(is.other);
          if (!a || !o) continue;
          const ov = intersect(a, o);
          if (!ov) continue;
          const [ex, ey, ez] = sizeOf(ov);
          const bias = 0.005;
          const pos = [...is.e.transform.position] as Vec3;
          const ax = ey <= ex && ey <= ez ? 1 : ex <= ez ? 0 : 2;
          const ca = (a.mn[ax] + a.mx[ax]) / 2, co = (o.mn[ax] + o.mx[ax]) / 2;
          pos[ax] += ca >= co ? bias : -bias;
          is.e.transform.position = fr(pos);
          is.fixed = true; fixed++;
        } else if (is.kind === "COLLIDER_WITHOUT_BODY") {
          is.e.comps.rigidBody = fr({ ...clone(COMP_DEFAULTS.rigidBody), motionType: 0, mass: 0 });
          is.fixed = true; fixed++;
        }
      }
    }
    const errors = issues.filter((i) => !i.fixed && i.level >= 2).length;
    const warnings = issues.filter((i) => !i.fixed && i.level < 2).length;
    return {
      pass: errors === 0, checked: items.length, errors, warnings, fixed, sceneGeneration: 1,
      issues: issues.map((i) => ({
        entityId: i.e.id, fixed: i.fixed, kind: i.kind, level: i.level >= 2 ? "error" : "warning", name: i.e.name, text: i.text,
        ...(i.other ? { otherEntityId: i.other.id, otherName: i.other.name } : {}),
      })),
      ...(fixMode === 0 && errors > 0 ? { next: "fix:\"safe\" で BURIED/FLOATING/Z_FIGHT/COLLIDER_WITHOUT_BODY は自動で直せる" } : {}),
    };
  });

  // ping の補助(mockEngine の ping に足す情報は pingExtra で渡す。ここでは何も定義しない)。
  void assetsDir;

  // ── ハッシュ / スナップショット ──
  const normalized = (list: SimEntity[]) => {
    const nameOf = (id: number | null) => (id == null ? null : list.find((x) => x.id === id)?.name ?? null);
    return list.map((e) => ({
      name: e.name, parent: nameOf(e.parent), kind: e.kind, primitive: e.primitive ?? null, modelPath: e.modelPath ?? null,
      transform: e.transform, color: e.color ?? null, material: e.material ?? null, textures: e.textures ?? null,
      comps: e.comps, tags: e.tags ?? null, data: e.data ?? null,
    }));
  };
  const hash = (): string => crypto.createHash("sha1").update(JSON.stringify(normalized(state.entities))).digest("hex").slice(0, 16);
  const snapshot = () => clone({ entities: state.entities, nextId: state.nextId, settings: state.settings });
  const clearFailures = () => { state.failures.length = 0; };

  return { methods, state, hash, failNext, clearFailures, snapshot, assetsDir, baseDir };
}
