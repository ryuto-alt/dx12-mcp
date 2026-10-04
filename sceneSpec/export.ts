// 現在のシーン → 仕様 JSON(dx12_scene_spec_export)。往復(シーン → 仕様 → 適用)で同じシーンになることを保証する(テストで検証)。
//
//   ・座標は展開後の絶対値(at / rotation / scale)。相対配置・パターンは平らにする(結果は同じ)。ただし読み戻せない部分(texture・
//     alphaMode・uvScale・script props・lookAt・snap・prefab)は、所有者の印 __o に写してあるので、その仕様で作った物なら元の指定を復元する。
//   ・除外: エディタ内部(gridPlane)、グループの根(LVL / ENV / LIGHT / GAMEPLAY / FX / UI / CAMERA。仕様が group から作り直す)。
import { isVec3 } from "./geom.ts";
import { KNOWN_COMPONENTS } from "./schema.ts";
import { pmap, type EngineLike } from "./plan.ts";
import { GROUP_ROOT, ID_KEY, OPAQUE_KEY, OWNER_KEY, type EntitySpec, type GroupKey, type SceneSpec } from "./types.ts";

const ROOT_TO_GROUP = new Map<string, GroupKey>((Object.entries(GROUP_ROOT) as [GroupKey, string][]).map(([k, v]) => [v, k]));
const NON_COMPONENT = new Set(["transform", "tags", "data", "meshRenderer", "material", "color", "luaScript", "componentTypes", "entityId", "guid", "luaReadable", "name", "primitive", "primitiveSize", "sceneGeneration", "bakedTextures", "gridPlane"]);
const LIGHT_COMPS: Record<string, "directional" | "point" | "spot"> = { directionalLight: "directional", pointLight: "point", spotLight: "spot" };
const KIND_BY_COMP: [string, EntitySpec["kind"]][] = [["camera", "camera"], ["trigger", "trigger"], ["particleEmitter", "particle_emitter"], ["decal", "decal"], ["uiCanvas", "ui_canvas"], ["uiImage", "ui_image"], ["uiText", "ui_text"], ["uiButton", "ui_button"], ["uiSlider", "ui_slider"], ["uiToggle", "ui_toggle"], ["uiScrollView", "ui_scrollview"]];

const isDefault = (v: number[] | undefined, d: number) => !Array.isArray(v) || v.every((x) => Math.abs(x - d) < 1e-6);
const num = (x: number) => Math.round(x * 1e5) / 1e5;
const vec = (v: number[]): [number, number, number] => [num(v[0]), num(v[1]), num(v[2])];

export type ExportOpts = {
  /** true = 所有者の印(__spec)がある物だけ。false = シーン全体(既定)。 */
  owned?: boolean;
  /** 仕様名(省略で、所有者の印が 1 種類ならそれ、無ければ "exported")。 */
  name?: string;
  /** 名前の一覧に絞る。 */
  only?: string[];
  /** 名前の接頭辞で絞る。 */
  prefix?: string;
};

export type ExportResult = { spec: SceneSpec; entityCount: number; skipped: { name: string; reason: string }[]; notes: string[] };

export async function exportScene(engine: EngineLike, opts: ExportOpts = {}): Promise<ExportResult> {
  const list = await engine.call("list_entities", { verbose: true, limit: 0 });
  const hier = await engine.call("get_hierarchy", { limit: 0 });
  const ents: { id: number; name: string; types: string[] }[] = ((list?.entities ?? []) as any[]).map((e) => ({ id: e.entityId ?? e.id, name: e.name, types: e.componentTypes ?? [] }));
  const idName = new Map(ents.map((e) => [e.id, e.name]));
  const parentOf = new Map<string, string>();
  const order: string[] = [];
  const walk = (n: any, p?: string) => { if (p !== undefined) parentOf.set(n.name, p); order.push(n.name); for (const c of n.children ?? []) walk(c, n.name); };
  for (const r of hier?.roots ?? []) walk(r);
  void idName;

  const skipped: { name: string; reason: string }[] = [];
  const notes: string[] = [];
  const candidates = ents.filter((e) => {
    if (e.types.includes("gridPlane")) return false;
    if (ROOT_TO_GROUP.has(e.name)) return false;
    if (opts.only && !opts.only.includes(e.name)) return false;
    if (opts.prefix && !e.name.startsWith(opts.prefix)) return false;
    return true;
  });
  const raws = new Map<string, any>();
  await pmap(candidates, async (e) => { raws.set(e.name, await engine.call("get_entity", { entity: e.id })); return null; });

  const owners = new Set<string>();
  const selected = candidates.filter((e) => {
    const own = raws.get(e.name)?.data?.[OWNER_KEY]?.v;
    if (typeof own === "string") owners.add(own);
    return opts.owned ? typeof own === "string" : true;
  });
  const selectedNames = new Set(selected.map((e) => e.name));
  const out: EntitySpec[] = [];

  const byOrder = [...selected].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  for (const e of byOrder) {
    const raw = raws.get(e.name) ?? {};
    const tr = raw.transform ?? {};
    const es: EntitySpec = { name: e.name, kind: "empty" };
    const idv = raw.data?.[ID_KEY]?.v;
    if (typeof idv === "string" && idv !== e.name) es.id = idv;
    const opaque = (() => { try { const s = raw.data?.[OPAQUE_KEY]?.v; return typeof s === "string" ? JSON.parse(s) : undefined; } catch { return undefined; } })();

    // 種別
    if (raw.primitive === "box" || raw.primitive === "sphere" || raw.primitive === "plane") es.kind = raw.primitive;
    else if (raw.meshRenderer?.modelPath) { es.kind = "model"; es.model = raw.meshRenderer.modelPath; }
    else if (opaque?.prefab) { es.kind = "prefab"; es.prefab = opaque.prefab; }
    else {
      const lc = Object.keys(LIGHT_COMPS).find((k) => raw[k] !== undefined);
      if (lc) { es.kind = "light"; es.light = LIGHT_COMPS[lc]; }
      else { const kc = KIND_BY_COMP.find(([k]) => raw[k] !== undefined); if (kc) es.kind = kc[1]; }
    }

    // 親 / グループ
    const parent = parentOf.get(e.name);
    if (parent !== undefined) {
      const g = ROOT_TO_GROUP.get(parent);
      if (g) es.group = g; else if (selectedNames.has(parent)) es.parent = parent;
      else { notes.push(`${e.name} の親 '${parent}' は書き出す対象に無い(親なしとして出した)`); }
    }
    // Transform
    if (Array.isArray(tr.position)) es.at = vec(tr.position);
    if (!opaque?.lookAt && !isDefault(tr.rotation, 0)) es.rotation = vec(tr.rotation);
    if (!isDefault(tr.scale, 1)) es.scale = vec(tr.scale);
    // 見た目
    if (Array.isArray(raw.color) && raw.color.length >= 3) es.color = vec(raw.color);
    if (raw.material && typeof raw.material === "object") {
      const m: Record<string, unknown> = {};
      for (const k of ["metallic", "roughness", "opacity", "emissiveIntensity"] as const) {
        if (typeof raw.material[k] !== "number") continue;
        // モデルの既定 material は {metallic:1, roughness:1}(get_entity が常に返す)。既定と同じ値は書かない(書くと set_pbr が余計に走る)。
        if (es.kind === "model" && (k === "metallic" || k === "roughness") && raw.material[k] === 1) continue;
        m[k] = num(raw.material[k]);
      }
      if (isVec3(raw.material.emissiveColor)) m.emissive = vec(raw.material.emissiveColor);
      if (opaque?.alphaMode) m.alphaMode = opaque.alphaMode;
      if (opaque?.uvScale) m.uvScale = opaque.uvScale;
      if (Object.keys(m).length) es.material = m as any;
    }
    if (opaque?.texture) es.texture = opaque.texture;
    // コンポーネント
    const comps: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (NON_COMPONENT.has(k) || typeof v !== "object" || v === null || Array.isArray(v)) continue;
      if (!(KNOWN_COMPONENTS as readonly string[]).includes(k)) { skipped.push({ name: e.name, reason: `未対応のコンポーネント '${k}'(書き出さない)` }); continue; }
      comps[k] = JSON.parse(JSON.stringify(v));
    }
    if (Object.keys(comps).length) es.components = comps;
    if (raw.luaScript?.scriptPath) es.script = opaque?.props && Object.keys(opaque.props).length ? { path: raw.luaScript.scriptPath, props: opaque.props } : raw.luaScript.scriptPath;
    if (Array.isArray(raw.tags) && raw.tags.length) es.tags = [...raw.tags];
    if (raw.data && typeof raw.data === "object") {
      const d: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw.data as Record<string, any>)) { if (k === OWNER_KEY || k === OPAQUE_KEY || k === ID_KEY) continue; d[k] = v?.v; }
      if (Object.keys(d).length) es.data = d;
    }
    if (opaque?.lookAt !== undefined) es.lookAt = opaque.lookAt;
    if (opaque?.snap) es.place = { snap: true };
    out.push(es);
  }

  const name = opts.name ?? (owners.size === 1 ? [...owners][0] : "exported");
  if (owners.size > 1 && !opts.name) notes.push(`所有者の印が複数(${[...owners].join(", ")})。仕様名は 'exported' にした`);
  const spec: SceneSpec = { version: 1, name, entities: out };
  notes.push("設定(ライティング・ルック・スカイボックス・ナビメッシュ)は書き出さない(仕様の lighting / look / scene / navmesh で別に指定する)");
  return { spec, entityCount: out.length, skipped, notes };
}
