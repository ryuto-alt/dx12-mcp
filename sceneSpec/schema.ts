// SceneSpec v1 の検証(M11)。純関数(engine も fs も触らない。アセット一覧・既存のエンティティ名は ctx で受け取る)。
//
// 出力は SpecIssue[](JSON Pointer の path・code・message・validValues / didYouMean・そのまま撃ち直せる specPatch)。
// M2 の流儀(cause / fix / didYouMean / validValues)に合わせ、AI が 1 往復で自己修正できることを目標にする。
// error が 1 件でもあれば適用しない(エンジンには 1 つも書かない)。warn は適用して結果に載せる。
import { coerceValue } from "../validate.ts";
import { nearest } from "../errors.ts";
import { nearestAsset } from "../sceneWrite.ts";
import { isVec3 } from "./geom.ts";
import { ptr } from "./patch.ts";
import {
  ALPHA_MODES, GROUP_KEYS, KINDS, LIGHTING_PRESETS, LIGHT_TYPES, MAX_ENTITIES, PATTERN_TYPES, PLACE_SIDES, TEXTURE_SLOTS,
  type PatchOp, type SpecIssue,
} from "./types.ts";

export type SchemaCtx = {
  /** dx12_list_assets の結果(assets 相対パス)。無ければ実在確認を省く(warn を 1 件出す)。 */
  assets?: { models: readonly string[]; prefabs: readonly string[]; scripts: readonly string[]; textures: readonly string[] };
  /** シーンに既にあるエンティティ名(仕様の外のものを parent / relativeTo に使える)。 */
  sceneNames?: readonly string[];
  /** 仕様の name に使えない既存の名前(エディタ内部のグリッド "Grid" など。同名で作ると内部の物を作り直そうとする)。 */
  reserved?: readonly string[];
  /** 設定できるコンポーネントの jsonKey(エンジンの describe_components)。無ければ既知の一覧。 */
  components?: readonly string[];
  /** ルック(look_apply)のプリセット id。 */
  looks?: readonly string[];
};

/** describe_components が settable と言っている jsonKey(2026-09 時点。エンジンから取れたらそちらが正)。 */
export const KNOWN_COMPONENTS = [
  "transform", "pointLight", "directionalLight", "spotLight", "camera", "rigidBody", "boxCollider", "sphereCollider", "capsuleCollider",
  "characterController", "meshCollider", "sprite2d", "tags", "data", "audioSource", "audioReverbZone", "virtualGeometry", "foliageLayer",
  "trigger", "particleEmitter", "decal", "uiCanvas", "uiRect", "uiImage", "uiText", "uiButton", "uiSlider", "uiToggle", "uiScrollView",
  "uiLayout", "uiAnimator", "brain", "trailRenderer", "networkIdentity", "networkTransform", "footIK", "animatorController",
] as const;

const KIND_ALIASES: Record<string, string> = {
  cube: "box", block: "box", cuboid: "box", ball: "sphere", orb: "sphere", floor: "plane", ground: "plane", quad: "plane",
  glb: "model", gltf: "model", mesh: "model", fbx: "model", object: "model", group: "empty", node: "empty", null: "empty", folder: "empty",
  point_light: "light", light_point: "light", light_directional: "light", light_spot: "light", spot_light: "light", sun: "light", lamp: "light",
  directional_light: "light", pointlight: "light", spotlight: "light", player: "fps_player", fps: "fps_player", fpsplayer: "fps_player",
  particles: "particle_emitter", particle: "particle_emitter", emitter: "particle_emitter", volume: "trigger", zone: "trigger", area: "trigger",
  canvas: "ui_canvas", text: "ui_text", label: "ui_text", button: "ui_button", image: "ui_image", slider: "ui_slider", toggle: "ui_toggle",
};

const ENTITY_KEYS = [
  "name", "id", "kind", "light", "model", "prefab", "group", "parent", "at", "rotation", "scale", "size", "color", "material", "texture", "collider", "components",
  "script", "tags", "data", "place", "pattern", "lookAt", "bounds", "comment",
] as const;
const KEY_ALIASES: Record<string, string> = {
  position: "at", pos: "at", location: "at", translate: "at", translation: "at", rot: "rotation", euler: "rotation", angle: "rotation", scl: "scale",
  dimensions: "size", extents: "size", colour: "color", colors: "color", mat: "material", pbr: "material", textures: "texture", component: "components",
  comps: "components", lua: "script", scripts: "script", tag: "tags", relative: "place", placement: "place", placeNear: "place", patterns: "pattern",
  type: "kind", shape: "kind", path: "model", asset: "model", mesh: "model", glb: "model", parents: "parent", groupName: "group", look_at: "lookAt", lookat: "lookAt",
  note: "comment", description: "comment", label: "name", title: "name", key: "id", uid: "id", guid: "id",
};
const ROOT_KEYS = ["version", "name", "entities", "lighting", "look", "sun", "scene", "navmesh", "verify", "comment"] as const;
const ROOT_ALIASES: Record<string, string> = { entites: "entities", entity: "entities", objects: "entities", items: "entities", nodes: "entities", light: "lighting", environment: "scene", env: "scene", checks: "verify", specName: "name" };
const PLACE_KEYS = ["relativeTo", "side", "gap", "align", "on", "ground", "offset", "snap"] as const;
const PLACE_ALIASES: Record<string, string> = { near: "relativeTo", anchor: "relativeTo", of: "relativeTo", to: "relativeTo", direction: "side", dir: "side", distance: "gap", spacing: "gap", top: "on", onTop: "on", stack: "on" };
const PATTERN_KEYS = ["type", "count", "spacing", "origin", "around", "radius", "startAngle", "arc", "faceCenter", "from", "to", "step", "of", "side", "margin", "gap", "area", "minSpacing", "seed", "jitter", "yaw", "scaleRange", "y", "exclude", "skip"] as const;
const PATTERN_ALIASES: Record<string, string> = { kind: "type", n: "count", num: "count", number: "count", gap: "spacing", center: "origin", centre: "origin", wall: "of", along: "of", rand: "seed", random: "seed", angle: "startAngle" };
const MATERIAL_KEYS = ["metallic", "roughness", "emissive", "emissiveIntensity", "opacity", "alphaMode", "uvScale"] as const;
const MATERIAL_ALIASES: Record<string, string> = { metalness: "metallic", metal: "metallic", rough: "roughness", glow: "emissive", emission: "emissive", emissiveColor: "emissive", alpha: "opacity", transparency: "opacity" };

let _issueSeq = 0;
function mk(path: string, code: string, severity: "error" | "warn", message: string, extra: Partial<SpecIssue> = {}): SpecIssue {
  _issueSeq++;
  return { path, code, severity, message, ...extra };
}

/** 最も近い候補(1 つ)。無ければ undefined。 */
const nearest1 = (t: string, c: readonly string[], liberal = false) => nearest(t, c, 1, { liberal })[0];

/** キーの打ち間違いの提案: 別名表 → 既知キーへの編集距離 → 別名キーへの編集距離(postion → position → at)。 */
function suggestKey(k: string, keys: readonly string[], aliases: Record<string, string>): string | undefined {
  if (aliases[k]) return aliases[k];
  const n = nearest1(k, keys);
  if (n) return n;
  const ak = nearest1(k, Object.keys(aliases));
  return ak ? aliases[ak] : undefined;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** パターンの件数(instance 名を数えるのに必要。壊れていれば 0)。 */
export function patternCount(p: unknown): number {
  if (!isObj(p)) return 0;
  const c = p.count;
  if (typeof c === "number" && Number.isFinite(c)) return Math.max(0, Math.floor(c));
  if (Array.isArray(c) && c.length >= 1 && c.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return c.reduce((a: number, b: number) => a * Math.floor(b), 1);
  return 0;
}

/** パターン展開後の instance 名(連番は 1 始まり。桁は max(2, 件数の桁))。 */
export function instanceNames(name: string, count: number, skip?: number[]): string[] {
  const width = Math.max(2, String(count).length);
  const out: string[] = [];
  const skipped = new Set(skip ?? []);
  for (let i = 1; i <= count; i++) if (!skipped.has(i)) out.push(`${name}_${String(i).padStart(width, "0")}`);
  return out;
}

export type ValidateResult = {
  issues: SpecIssue[];
  /** 展開後の名前 → どの entities[i] のどの連番か。 */
  names: Map<string, { index: number; instance?: number }>;
  entityCount: number;
};

export function validateSpec(raw: unknown, ctx: SchemaCtx = {}): ValidateResult {
  const issues: SpecIssue[] = [];
  const names = new Map<string, { index: number; instance?: number }>();
  const push = (i: SpecIssue) => issues.push(i);

  if (!isObj(raw)) {
    push(mk("", "E_BAD_TYPE", "error", `仕様のルートはオブジェクトでなければならない(今は ${typeName(raw)})`, {
      cause: "SceneSpec は {version:1, entities:[…]} の形", fix: [{ tool: "dx12_guide", args: { topic: "scene_spec" }, why: "仕様の書き方と例" }],
    }));
    return { issues, names, entityCount: 0 };
  }
  const spec = raw;

  // ── ルート ──
  for (const k of Object.keys(spec)) {
    if ((ROOT_KEYS as readonly string[]).includes(k)) continue;
    const dym = suggestKey(k, ROOT_KEYS, ROOT_ALIASES);
    push(mk(ptr(k), "E_UNKNOWN_PARAM", "error", `知らないキー '${k}'${dym ? `(→ '${dym}' のことか?)` : ""}`, {
      validValues: [...ROOT_KEYS], didYouMean: dym ? [dym] : [],
      specPatch: dym && !(dym in spec) ? [{ op: "move", from: ptr(k), path: ptr(dym) }] : [{ op: "remove", path: ptr(k) }],
    }));
  }
  if (spec.version === undefined) {
    push(mk("/version", "E_MISSING_PARAM", "error", "version が無い(1 を書く)", { validValues: [1], specPatch: [{ op: "add", path: "/version", value: 1 }] }));
  } else if (spec.version !== 1) {
    push(mk("/version", "E_BAD_ENUM", "error", `version ${JSON.stringify(spec.version)} は未対応(1 だけ)`, { validValues: [1], specPatch: [{ op: "replace", path: "/version", value: 1 }] }));
  }
  if (spec.name !== undefined && (typeof spec.name !== "string" || !/^[A-Za-z0-9_.\-]{1,64}$/.test(spec.name))) {
    push(mk("/name", "E_BAD_TYPE", "error", "name は英数字・_・-・. の 1〜64 文字(所有者の印になる)", {
      specPatch: [{ op: "replace", path: "/name", value: typeof spec.name === "string" ? spec.name.replace(/[^A-Za-z0-9_.\-]+/g, "_").slice(0, 64) || "scene" : "scene" }],
    }));
  }

  const entitiesRaw = spec.entities;
  if (entitiesRaw !== undefined && !Array.isArray(entitiesRaw)) {
    push(mk("/entities", "E_BAD_TYPE", "error", `entities は配列(今は ${typeName(entitiesRaw)})`, {
      specPatch: isObj(entitiesRaw) ? [{ op: "replace", path: "/entities", value: Object.entries(entitiesRaw).map(([k, v]) => (isObj(v) ? { name: k, ...v } : { name: k })) }] : undefined,
    }));
  }
  const entities: unknown[] = Array.isArray(entitiesRaw) ? entitiesRaw : [];

  // ── 名前(仕様の中の全名前 = パターン展開後)。参照の検査より先に集める ──
  const specNames = new Set<string>();
  entities.forEach((e, i) => {
    if (!isObj(e) || typeof e.name !== "string" || e.name === "") return;
    if (e.pattern !== undefined) {
      const n = patternCount(e.pattern);
      const skip = isObj(e.pattern) && Array.isArray(e.pattern.skip) ? (e.pattern.skip as number[]).filter((x) => Number.isInteger(x)) : undefined;
      const inst = instanceNames(e.name, n, skip);
      inst.forEach((nm) => specNames.add(nm));
    } else specNames.add(e.name);
  });
  const sceneNames = new Set(ctx.sceneNames ?? []);
  const allRefNames = [...new Set([...specNames, ...sceneNames])];
  const refExists = (n: string) => specNames.has(n) || sceneNames.has(n);
  const groupRoots = new Set(["LVL", "ENV", "LIGHT", "GAMEPLAY", "FX", "UI", "CAMERA"]);

  /** 参照(エンティティ名)の検査。無ければ近い名前つきの issue。 */
  const checkRef = (path: string, v: unknown, label: string, removeOnFail: PatchOp[] = []) => {
    if (typeof v !== "string" || v === "") { push(mk(path, "E_BAD_TYPE", "error", `${label} はエンティティ名(空でない文字列)`, { specPatch: removeOnFail.length ? removeOnFail : undefined })); return; }
    if (refExists(v) || groupRoots.has(v)) return;
    const dym = nearest(v, allRefNames, 5);
    push(mk(path, "E_NOT_FOUND_ENTITY", "error", `${label} '${v}' が仕様にもシーンにも無い${dym.length ? `(近い名前: ${dym.slice(0, 3).join(", ")})` : ""}`, {
      didYouMean: dym, cause: "参照先のエンティティ名は完全一致で書く。パターンで作るものは連番付きの名前(例 Pillar_03)で参照する",
      specPatch: dym.length ? [{ op: "replace", path, value: dym[0] }] : (removeOnFail.length ? removeOnFail : undefined),
    }));
  };

  let total = 0;
  const seenNames = new Map<string, number>();
  const seenIds = new Map<string, number>();

  entities.forEach((raw, i) => {
    const base = ptr("entities", i);
    if (!isObj(raw)) { push(mk(base, "E_BAD_TYPE", "error", `entities[${i}] はオブジェクト(今は ${typeName(raw)})`, { specPatch: [{ op: "remove", path: base }] })); return; }
    const e = raw;

    // 未知キー
    for (const k of Object.keys(e)) {
      if ((ENTITY_KEYS as readonly string[]).includes(k)) continue;
      const dym = suggestKey(k, ENTITY_KEYS, KEY_ALIASES);
      push(mk(`${base}/${k}`, "E_UNKNOWN_PARAM", "error", `entities[${i}] の知らないキー '${k}'${dym ? `(→ '${dym}' のことか?)` : ""}`, {
        validValues: [...ENTITY_KEYS], didYouMean: dym ? [dym] : [], entity: typeof e.name === "string" ? e.name : undefined,
        specPatch: dym && !(dym in e) ? [{ op: "move", from: `${base}/${k}`, path: `${base}/${dym}` }] : [{ op: "remove", path: `${base}/${k}` }],
      }));
    }

    // name
    let name = "";
    if (typeof e.name !== "string" || e.name.trim() === "") {
      push(mk(`${base}/name`, "E_MISSING_PARAM", "error", `entities[${i}] に name(空でない文字列)が無い。name は差分適用のキー`, { specPatch: [{ op: "add", path: `${base}/name`, value: `Entity_${String(i + 1).padStart(2, "0")}` }] }));
    } else {
      name = e.name;
      if (name.length > 64) push(mk(`${base}/name`, "E_OUT_OF_RANGE", "error", `name '${name.slice(0, 20)}…' が 64 文字を超える`, { specPatch: [{ op: "replace", path: `${base}/name`, value: name.slice(0, 64) }] }));
      if (/[\u0000-\u001f]/.test(name)) push(mk(`${base}/name`, "E_BAD_TYPE", "error", "name に制御文字が入っている"));
      if (ctx.reserved?.includes(name)) push(mk(`${base}/name`, "E_SPEC_DUPLICATE_NAME", "error", `name '${name}' はエディタ内部のエンティティの名前(予約)。同名では作れない`, { entity: name, specPatch: [{ op: "replace", path: `${base}/name`, value: `${name}_01` }] }));
      if (groupRoots.has(name)) push(mk(`${base}/name`, "E_SPEC_DUPLICATE_NAME", "error", `'${name}' はグループの根の名前(予約)`, { specPatch: [{ op: "replace", path: `${base}/name`, value: `${name}_01` }] }));
      if (/ \(\d+\)$/.test(name)) push(mk(`${base}/name`, "E_BAD_TYPE", "warn", `name '${name}' の " (N)" はエンジンが重複名に付ける連番と紛らわしい`));
    }

    // id(安定 ID。省略で name)
    if (e.id !== undefined && (typeof e.id !== "string" || !/^[A-Za-z0-9_.\-]{1,64}$/.test(e.id))) {
      push(mk(`${base}/id`, "E_BAD_TYPE", "error", `id は英数字・_・-・. の 1〜64 文字(name を変えても同じ物として追従させる安定 ID)`, { entity: name || undefined, specPatch: [{ op: "remove", path: `${base}/id` }] }));
    }

    // kind
    let kind = typeof e.kind === "string" ? e.kind : undefined;
    let lightFromKind: string | undefined;
    if (e.kind === undefined) {
      const guess = e.model !== undefined ? "model" : e.prefab !== undefined ? "prefab" : e.light !== undefined ? "light" : e.pattern !== undefined || e.at !== undefined || e.size !== undefined ? "box" : "empty";
      push(mk(`${base}/kind`, "E_MISSING_PARAM", "error", `entities[${i}](${name || "?"}) に kind が無い`, { validValues: [...KINDS], didYouMean: [guess], specPatch: [{ op: "add", path: `${base}/kind`, value: guess }] }));
    } else if (typeof e.kind !== "string" || !(KINDS as readonly string[]).includes(e.kind)) {
      const rawKind = String(e.kind);
      const lk = rawKind.toLowerCase().replace(/[\s-]+/g, "_");
      let dym = KIND_ALIASES[lk] ?? KIND_ALIASES[lk.replace(/_/g, "")] ?? nearest1(lk, KINDS, true);
      const m = /^light_(directional|point|spot)$/.exec(lk) ?? /^(directional|point|spot)_light$/.exec(lk);
      if (m) { lightFromKind = m[1]; dym = "light"; }
      const patch: PatchOp[] = dym ? [{ op: "replace", path: `${base}/kind`, value: dym }] : [];
      if (lightFromKind && e.light === undefined) patch.push({ op: "add", path: `${base}/light`, value: lightFromKind });
      push(mk(`${base}/kind`, "E_BAD_ENUM", "error", `entities[${i}](${name || "?"}) の kind に ${JSON.stringify(e.kind)} は使えない${dym ? `(→ '${dym}' のことか?)` : ""}`, {
        validValues: [...KINDS], didYouMean: dym ? [dym] : [], entity: name || undefined, specPatch: patch.length ? patch : undefined,
      }));
      kind = dym; // 以降の検査は近い kind で続ける(エラーは既に出している)
    }

    // 種別ごとの必須・排他
    if (kind === "model") {
      if (typeof e.model !== "string" || e.model === "") push(mk(`${base}/model`, "E_MISSING_PARAM", "error", `entities[${i}](${name}) は kind:"model" なのに model(assets 相対パス)が無い`, { entity: name }));
      else if (ctx.assets) {
        if (!ctx.assets.models.includes(e.model)) {
          const near = nearestAsset(e.model, ctx.assets.models);
          const dym = near ? [near] : nearest(e.model, ctx.assets.models, 3);
          push(mk(`${base}/model`, "E_NOT_FOUND_ASSET", "error", `entities[${i}](${name}) の model '${e.model}' が assets に無い${dym.length ? `(→ '${dym[0]}' のことか?)` : ""}`, {
            didYouMean: dym, validValues: ctx.assets.models.length <= 12 ? [...ctx.assets.models] : undefined, entity: name,
            cause: "参照切れのモデルはエンティティごと作られない。パスは assets 相対で区切りは / 。一覧は dx12_call {name:'dx12_list_assets', args:{type:'model'}}",
            specPatch: dym.length ? [{ op: "replace", path: `${base}/model`, value: dym[0] }] : [{ op: "replace", path: `${base}/kind`, value: "box" }, { op: "remove", path: `${base}/model` }],
          }));
        }
      }
    } else if (e.model !== undefined) {
      push(mk(`${base}/model`, "E_SPEC_CONFLICT", "error", `entities[${i}](${name}) は kind:${JSON.stringify(kind)} なのに model がある(model は kind:"model" のとき)`, { entity: name, specPatch: [{ op: "replace", path: `${base}/kind`, value: "model" }] }));
    }
    if (kind === "prefab") {
      if (typeof e.prefab !== "string" || e.prefab === "") push(mk(`${base}/prefab`, "E_MISSING_PARAM", "error", `entities[${i}](${name}) は kind:"prefab" なのに prefab(assets 相対パス)が無い`, { entity: name }));
      else if (ctx.assets && !ctx.assets.prefabs.includes(e.prefab)) {
        const dym = nearest(e.prefab, ctx.assets.prefabs, 3);
        push(mk(`${base}/prefab`, "E_NOT_FOUND_ASSET", "error", `entities[${i}](${name}) の prefab '${e.prefab}' が assets に無い`, {
          didYouMean: dym, entity: name, specPatch: dym.length ? [{ op: "replace", path: `${base}/prefab`, value: dym[0] }] : undefined,
        }));
      }
    } else if (e.prefab !== undefined) {
      push(mk(`${base}/prefab`, "E_SPEC_CONFLICT", "error", `entities[${i}](${name}) は kind:${JSON.stringify(kind)} なのに prefab がある`, { entity: name, specPatch: [{ op: "replace", path: `${base}/kind`, value: "prefab" }] }));
    }
    if (kind === "light" || e.light !== undefined) {
      if (e.light === undefined && !lightFromKind) push(mk(`${base}/light`, "E_MISSING_PARAM", "error", `entities[${i}](${name}) は kind:"light" なのに light(directional|point|spot)が無い`, { validValues: [...LIGHT_TYPES], entity: name, specPatch: [{ op: "add", path: `${base}/light`, value: "point" }] }));
      else if (e.light !== undefined && !(LIGHT_TYPES as readonly string[]).includes(String(e.light))) {
        const dym = nearest1(String(e.light).replace(/^light_/, ""), LIGHT_TYPES, true) ?? "point";
        push(mk(`${base}/light`, "E_BAD_ENUM", "error", `light に ${JSON.stringify(e.light)} は使えない(${LIGHT_TYPES.join(" | ")})`, { validValues: [...LIGHT_TYPES], didYouMean: [dym], entity: name, specPatch: [{ op: "replace", path: `${base}/light`, value: dym }] }));
      }
      if (kind !== "light" && e.light !== undefined && kind !== undefined) push(mk(`${base}/light`, "E_SPEC_CONFLICT", "error", `entities[${i}](${name}) は kind:${JSON.stringify(kind)} なのに light がある`, { entity: name, specPatch: [{ op: "replace", path: `${base}/kind`, value: "light" }] }));
    }

    // group / parent
    if (e.group !== undefined) {
      if (typeof e.group !== "string" || !(GROUP_KEYS as readonly string[]).includes(e.group)) {
        const dym = typeof e.group === "string" ? (Object.entries({ LIGHT: "LGT", GAMEPLAY: "GP", CAMERA: "CAM", LEVEL: "LVL", ENVIRONMENT: "ENV" }).find(([k]) => k === String(e.group).toUpperCase())?.[1] ?? nearest1(e.group, GROUP_KEYS, true)) : undefined;
        push(mk(`${base}/group`, "E_BAD_ENUM", "error", `group に ${JSON.stringify(e.group)} は使えない(${GROUP_KEYS.join(" | ")})`, { validValues: [...GROUP_KEYS], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym ? [{ op: "replace", path: `${base}/group`, value: dym }] : [{ op: "remove", path: `${base}/group` }] }));
      }
    }
    if (e.parent !== undefined) {
      checkRef(`${base}/parent`, e.parent, "parent", [{ op: "remove", path: `${base}/parent` }]);
      if (e.parent === name) push(mk(`${base}/parent`, "E_SPEC_CYCLE", "error", `${name} の parent が自分自身`, { entity: name, specPatch: [{ op: "remove", path: `${base}/parent` }] }));
      if (e.group !== undefined) push(mk(`${base}/group`, "E_SPEC_CONFLICT", "warn", `${name} は group と parent の両方を指定している(parent が優先され、group は無視される)`, { entity: name, specPatch: [{ op: "remove", path: `${base}/group` }] }));
    }

    // at / rotation / scale / size
    const vecCheck = (key: "at" | "rotation" | "scale", allowNull: boolean, allowScalar: boolean) => {
      const v = e[key];
      if (v === undefined) return;
      if (allowScalar && typeof v === "number" && Number.isFinite(v)) return;
      const ok = Array.isArray(v) && v.length === 3 && v.every((x) => (typeof x === "number" && Number.isFinite(x)) || (allowNull && x === null));
      if (ok) return;
      const co = typeof v === "string" ? coerceValue("array", v) : { ok: false as const };
      const fixed = co.ok && Array.isArray(co.value) && co.value.length === 3 ? co.value : undefined;
      push(mk(`${base}/${key}`, "E_BAD_TYPE", "error", `entities[${i}](${name}) の ${key} は数値 3 つの配列 [x,y,z]${allowNull ? "(null は place などで決める)" : ""}${allowScalar ? "か一様の数値" : ""}(今は ${JSON.stringify(v).slice(0, 60)})`, {
        entity: name, specPatch: fixed ? [{ op: "replace", path: `${base}/${key}`, value: fixed }] : undefined,
        cause: key === "rotation" ? "rotation は Euler 角(度)[x,y,z]。四元数は使えない" : key === "at" ? "単位はメートル。[x,y,z]" : undefined,
      }));
    };
    vecCheck("at", true, false);
    vecCheck("rotation", false, false);
    vecCheck("scale", false, true);
    if (e.size !== undefined) {
      const okSize = (typeof e.size === "number" && Number.isFinite(e.size) && e.size > 0)
        || (Array.isArray(e.size) && (e.size.length === 2 || e.size.length === 3) && e.size.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0));
      if (!okSize) push(mk(`${base}/size`, "E_BAD_TYPE", "error", `entities[${i}](${name}) の size は正の数値(sphere は直径)、または [w,h,d](plane は [w,d])`, { entity: name }));
      if (e.scale !== undefined) push(mk(`${base}/size`, "E_SPEC_CONFLICT", "error", `entities[${i}](${name}) は size と scale を両方指定している(どちらか 1 つ。size は実寸 m、scale は倍率)`, { entity: name, specPatch: [{ op: "remove", path: `${base}/size` }] }));
      if (kind === "model" || kind === "prefab") push(mk(`${base}/size`, "E_SPEC_CONFLICT", "error", `size はプリミティブ(box / sphere / plane)だけ。モデルは scale(倍率。モデルの実寸に対して)で指定する`, { entity: name, specPatch: [{ op: "remove", path: `${base}/size` }] }));
    }
    if (isVec3(e.scale) && (e.scale as number[]).some((x) => x === 0)) push(mk(`${base}/scale`, "E_OUT_OF_RANGE", "error", `entities[${i}](${name}) の scale に 0 がある(面が消え、ピッキングも素通りする)`, { entity: name, specPatch: [{ op: "replace", path: `${base}/scale`, value: (e.scale as number[]).map((x) => (x === 0 ? 1 : x)) }] }));
    if (isVec3(e.scale) && (e.scale as number[]).some((x) => x < 0)) push(mk(`${base}/scale`, "E_OUT_OF_RANGE", "error", `entities[${i}](${name}) の scale が負(面が裏返る)`, { entity: name, specPatch: [{ op: "replace", path: `${base}/scale`, value: (e.scale as number[]).map((x) => Math.abs(x)) }] }));
    if (typeof e.scale === "number" && e.scale <= 0) push(mk(`${base}/scale`, "E_OUT_OF_RANGE", "error", `entities[${i}](${name}) の scale は正の数`, { entity: name, specPatch: [{ op: "replace", path: `${base}/scale`, value: 1 }] }));

    // 単位の取り違え(cm と m)の疑い。エラーにはしない(warn)が、直す差分は付ける。
    {
      const dims: number[] = [];
      if (isVec3(e.scale)) dims.push(...(e.scale as number[])); else if (typeof e.scale === "number") dims.push(e.scale);
      if (Array.isArray(e.size)) dims.push(...(e.size as number[])); else if (typeof e.size === "number") dims.push(e.size);
      const big = Math.max(0, ...dims.map(Math.abs));
      const isModel = kind === "model" || kind === "prefab";
      if ((!isModel && big > 300) || (isModel && big > 50)) {
        const key = e.size !== undefined ? "size" : "scale";
        const cur = e[key];
        const div = (x: number) => Math.round((x / 100) * 1e4) / 1e4;
        push(mk(`${base}/${key}`, "W_UNIT_SUSPECT", "warn", `entities[${i}](${name}) の ${key} が最大 ${big}。単位はメートル(cm と取り違えていないか)。${isModel ? "モデルは読み込み時に実寸(m)になり scale は倍率" : "size は実寸 m"}`, {
          entity: name, cause: "cm の値をそのまま書くと 100 倍の物になる", specPatch: cur !== undefined && (typeof cur === "number" || Array.isArray(cur)) ? [{ op: "replace", path: `${base}/${key}`, value: Array.isArray(cur) ? (cur as number[]).map(div) : div(cur as number) }] : undefined,
        }));
      }
      if (isModel && dims.length && Math.max(...dims.map(Math.abs)) > 0 && Math.max(...dims.map(Math.abs)) < 0.02) {
        push(mk(`${base}/scale`, "W_UNIT_SUSPECT", "warn", `entities[${i}](${name}) の scale が ${Math.max(...dims.map(Math.abs))} と非常に小さい。モデルは読み込み時に m へ正規化済み(cm→m の変換を二重に掛けていないか)`, { entity: name }));
      }
      const atBig = Array.isArray(e.at) ? Math.max(0, ...(e.at as unknown[]).map((x) => (typeof x === "number" ? Math.abs(x) : 0))) : 0;
      if (atBig > 3000) push(mk(`${base}/at`, "W_UNIT_SUSPECT", "warn", `entities[${i}](${name}) の at に ${atBig} m がある。単位はメートル(cm と取り違えていないか)`, { entity: name, specPatch: Array.isArray(e.at) ? [{ op: "replace", path: `${base}/at`, value: (e.at as (number | null)[]).map((x) => (typeof x === "number" ? Math.round((x / 100) * 1e4) / 1e4 : x)) }] : undefined }));
    }

    // color
    if (e.color !== undefined) {
      const c = e.color;
      if (typeof c === "string") {
        if (!/^#?[0-9a-fA-F]{6}$/.test(c)) push(mk(`${base}/color`, "E_BAD_TYPE", "error", `color '${c}' は "#rrggbb" か [r,g,b](0..1)`, { entity: name }));
      } else if (!isVec3(c)) {
        const co = typeof c === "string" ? coerceValue("array", c) : { ok: false as const };
        push(mk(`${base}/color`, "E_BAD_TYPE", "error", `color は [r,g,b](0..1)か "#rrggbb"(今は ${JSON.stringify(c).slice(0, 40)})`, { entity: name, specPatch: co.ok ? [{ op: "replace", path: `${base}/color`, value: co.value }] : undefined }));
      } else if ((c as number[]).some((x) => x < 0 || x > 1)) {
        const arr = c as number[];
        const fix = arr.every((x) => x >= 0 && x <= 255) ? arr.map((x) => Math.round((x / 255) * 1e4) / 1e4) : arr.map((x) => Math.min(1, Math.max(0, x)));
        push(mk(`${base}/color`, "E_OUT_OF_RANGE", "error", `color は 0..1(今は ${JSON.stringify(arr)})。0..255 の値なら 255 で割る`, { entity: name, specPatch: [{ op: "replace", path: `${base}/color`, value: fix }] }));
      }
    }
    // material
    if (e.material !== undefined) {
      if (!isObj(e.material)) push(mk(`${base}/material`, "E_BAD_TYPE", "error", `material はオブジェクト {metallic, roughness, emissive, …}`, { entity: name }));
      else {
        const mb = `${base}/material`;
        for (const k of Object.keys(e.material)) {
          if ((MATERIAL_KEYS as readonly string[]).includes(k)) continue;
          const dym = suggestKey(k, MATERIAL_KEYS, MATERIAL_ALIASES);
          push(mk(`${mb}/${k}`, "E_UNKNOWN_PARAM", "error", `material の知らないキー '${k}'${dym ? `(→ '${dym}')` : ""}`, { validValues: [...MATERIAL_KEYS], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym && !(dym in e.material) ? [{ op: "move", from: `${mb}/${k}`, path: `${mb}/${dym}` }] : [{ op: "remove", path: `${mb}/${k}` }] }));
        }
        for (const k of ["metallic", "roughness", "opacity"] as const) {
          const v = (e.material as any)[k];
          if (v === undefined) continue;
          if (typeof v !== "number" || !Number.isFinite(v)) push(mk(`${mb}/${k}`, "E_BAD_TYPE", "error", `material.${k} は数値(0..1)`, { entity: name }));
          else if (v < 0 || v > 1) push(mk(`${mb}/${k}`, "E_OUT_OF_RANGE", "error", `material.${k} は 0..1(今は ${v})`, { entity: name, specPatch: [{ op: "replace", path: `${mb}/${k}`, value: Math.min(1, Math.max(0, v)) }] }));
        }
        const em = (e.material as any).emissive;
        if (em !== undefined && !isVec3(em)) push(mk(`${mb}/emissive`, "E_BAD_TYPE", "error", "material.emissive は [r,g,b]", { entity: name }));
        const am = (e.material as any).alphaMode;
        if (am !== undefined && !(ALPHA_MODES as readonly string[]).includes(am)) push(mk(`${mb}/alphaMode`, "E_BAD_ENUM", "error", `material.alphaMode に ${JSON.stringify(am)} は使えない`, { validValues: [...ALPHA_MODES], didYouMean: typeof am === "string" && nearest1(am, ALPHA_MODES, true) ? [nearest1(am, ALPHA_MODES, true)!] : [], entity: name }));
      }
    }
    // texture
    if (e.texture !== undefined) {
      if (!isObj(e.texture)) push(mk(`${base}/texture`, "E_BAD_TYPE", "error", "texture はオブジェクト {albedo, normal, metalRoughness, emissive}", { entity: name }));
      else for (const [slot, p] of Object.entries(e.texture)) {
        const tp = `${base}/texture/${slot}`;
        if (!(TEXTURE_SLOTS as readonly string[]).includes(slot)) {
          const dym = nearest1(slot, TEXTURE_SLOTS, true);
          push(mk(tp, "E_UNKNOWN_PARAM", "error", `texture のスロット '${slot}' は使えない(${TEXTURE_SLOTS.join(" | ")})`, { validValues: [...TEXTURE_SLOTS], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym && !(dym in e.texture) ? [{ op: "move", from: tp, path: `${base}/texture/${dym}` }] : [{ op: "remove", path: tp }] }));
          continue;
        }
        if (typeof p !== "string") { push(mk(tp, "E_BAD_TYPE", "error", "texture のパスは文字列(assets 相対)", { entity: name })); continue; }
        if (ctx.assets && !ctx.assets.textures.includes(p)) {
          const dym = nearest(p, ctx.assets.textures, 3);
          push(mk(tp, "E_NOT_FOUND_ASSET", "error", `texture '${p}' が assets に無い${dym.length ? `(→ '${dym[0]}')` : ""}`, { didYouMean: dym, entity: name, specPatch: dym.length ? [{ op: "replace", path: tp, value: dym[0] }] : [{ op: "remove", path: tp }] }));
        }
      }
    }
    // collider(当たり判定の略記)
    if (e.collider !== undefined) {
      if (e.collider !== "static" && e.collider !== "dynamic") {
        const dym = typeof e.collider === "string" ? nearest1(e.collider, ["static", "dynamic"], true) : undefined;
        const alias = e.collider === true ? "static" : dym;
        push(mk(`${base}/collider`, "E_BAD_ENUM", "error", `collider に ${JSON.stringify(e.collider)} は使えない(static | dynamic)`, { validValues: ["static", "dynamic"], didYouMean: alias ? [alias] : [], entity: name || undefined, specPatch: alias ? [{ op: "replace", path: `${base}/collider`, value: alias }] : [{ op: "remove", path: `${base}/collider` }] }));
      } else if (kind === "light" || kind === "camera" || kind === "empty" || (typeof kind === "string" && kind.startsWith("ui_"))) {
        push(mk(`${base}/collider`, "E_SPEC_CONFLICT", "warn", `kind:${kind} には形が無いので collider は付けない(box / sphere / plane / model / prefab だけ)`, { entity: name || undefined, specPatch: [{ op: "remove", path: `${base}/collider` }] }));
      }
    }
    // components
    if (e.components !== undefined) {
      if (!isObj(e.components)) push(mk(`${base}/components`, "E_BAD_TYPE", "error", "components はオブジェクト {jsonKey: {フィールド…}}", { entity: name }));
      else {
        const known = ctx.components ?? KNOWN_COMPONENTS;
        for (const [ck, cv] of Object.entries(e.components)) {
          const cp = `${base}/components/${ck}`;
          if (ck === "transform") { push(mk(cp, "E_SPEC_CONFLICT", "error", "transform は at / rotation / scale で指定する(components には書かない)", { entity: name, specPatch: [{ op: "remove", path: cp }] })); continue; }
          if (ck === "tags" || ck === "data") { push(mk(cp, "E_SPEC_CONFLICT", "error", `${ck} は entities[].${ck} で指定する(components には書かない)`, { entity: name, specPatch: [{ op: "move", from: cp, path: `${base}/${ck}` }] })); continue; }
          if (!known.includes(ck)) {
            const dym = nearest(ck, known, 3, { liberal: true });
            push(mk(cp, "E_NOT_FOUND_COMPONENT", "error", `コンポーネント '${ck}' が無い${dym.length ? `(→ '${dym[0]}' のことか?)` : ""}`, { didYouMean: dym, entity: name, cause: "jsonKey は dx12_call {name:'dx12_describe_components'} で確認する", specPatch: dym.length && !(dym[0] in e.components) ? [{ op: "move", from: cp, path: `${base}/components/${dym[0]}` }] : [{ op: "remove", path: cp }] }));
            continue;
          }
          if (!isObj(cv) || Object.keys(cv).length === 0) push(mk(cp, "E_BAD_TYPE", "error", `components.${ck} は空でないオブジェクト(変えたいフィールドだけでよい)`, { entity: name, specPatch: [{ op: "remove", path: cp }] }));
        }
      }
    }
    // script
    if (e.script !== undefined) {
      const sp = typeof e.script === "string" ? e.script : isObj(e.script) ? e.script.path : undefined;
      if (typeof sp !== "string" || sp === "") push(mk(`${base}/script`, "E_BAD_TYPE", "error", "script は Lua のパス(assets 相対)か {path, props}", { entity: name }));
      else if (ctx.assets && !ctx.assets.scripts.includes(sp)) {
        const near = nearestAsset(sp, ctx.assets.scripts);
        const dym = near ? [near] : nearest(sp, ctx.assets.scripts, 3);
        push(mk(typeof e.script === "string" ? `${base}/script` : `${base}/script/path`, "E_NOT_FOUND_ASSET", "error", `script '${sp}' が assets に無い${dym.length ? `(→ '${dym[0]}' のことか?)` : ""}`, {
          didYouMean: dym, entity: name, cause: "先に dx12_create_lua_component で作るか、既存の .lua のパスを書く",
          specPatch: dym.length ? [{ op: "replace", path: typeof e.script === "string" ? `${base}/script` : `${base}/script/path`, value: dym[0] }] : [{ op: "remove", path: `${base}/script` }],
        }));
      }
      if (isObj(e.script) && e.script.props !== undefined && !isObj(e.script.props)) push(mk(`${base}/script/props`, "E_BAD_TYPE", "error", "script.props は {プロパティ名: 値}", { entity: name }));
    }
    // tags / data
    if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== "string" || t === ""))) {
      const asStr = typeof e.tags === "string" ? [e.tags] : undefined;
      push(mk(`${base}/tags`, "E_BAD_TYPE", "error", `tags は文字列の配列 ["enemy","boss"](今は ${JSON.stringify(e.tags).slice(0, 40)})`, { entity: name, specPatch: asStr ? [{ op: "replace", path: `${base}/tags`, value: asStr }] : [{ op: "remove", path: `${base}/tags` }] }));
    }
    if (e.data !== undefined) {
      if (!isObj(e.data)) push(mk(`${base}/data`, "E_BAD_TYPE", "error", "data は {キー: 数値|真偽|文字列|[x,y,z]}", { entity: name }));
      else for (const [dk, dv] of Object.entries(e.data)) {
        if (dk.startsWith("__")) push(mk(`${base}/data/${dk}`, "E_SPEC_CONFLICT", "error", `data のキー '${dk}' は予約(__ で始まるキーは所有者の印に使う)`, { entity: name, specPatch: [{ op: "move", from: `${base}/data/${dk}`, path: `${base}/data/${dk.replace(/^_+/, "")}` }] }));
        else if (!(typeof dv === "number" || typeof dv === "boolean" || typeof dv === "string" || isVec3(dv))) push(mk(`${base}/data/${dk}`, "E_BAD_TYPE", "error", `data.${dk} は数値・真偽・文字列・[x,y,z] のどれか`, { entity: name, specPatch: [{ op: "remove", path: `${base}/data/${dk}` }] }));
      }
    }
    // bounds
    if (e.bounds !== undefined && !(isObj(e.bounds) && isVec3(e.bounds.min) && isVec3(e.bounds.max))) push(mk(`${base}/bounds`, "E_BAD_TYPE", "error", "bounds は {min:[x,y,z], max:[x,y,z]}(scale 1 のローカル AABB)", { entity: name }));

    // place
    if (e.place !== undefined) {
      const pb = `${base}/place`;
      if (!isObj(e.place)) push(mk(pb, "E_BAD_TYPE", "error", "place はオブジェクト {relativeTo, side, gap, on, ground, offset, snap}", { entity: name }));
      else {
        const p = e.place;
        for (const k of Object.keys(p)) {
          if ((PLACE_KEYS as readonly string[]).includes(k)) continue;
          const dym = suggestKey(k, PLACE_KEYS, PLACE_ALIASES);
          push(mk(`${pb}/${k}`, "E_UNKNOWN_PARAM", "error", `place の知らないキー '${k}'${dym ? `(→ '${dym}')` : ""}`, { validValues: [...PLACE_KEYS], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym && !(dym in p) ? [{ op: "move", from: `${pb}/${k}`, path: `${pb}/${dym}` }] : [{ op: "remove", path: `${pb}/${k}` }] }));
        }
        if (p.relativeTo !== undefined) checkRef(`${pb}/relativeTo`, p.relativeTo, "place.relativeTo", [{ op: "remove", path: pb }]);
        if (p.on !== undefined) checkRef(`${pb}/on`, p.on, "place.on", [{ op: "remove", path: pb }]);
        if (p.relativeTo === name || p.on === name) push(mk(pb, "E_SPEC_CYCLE", "error", `${name} が自分自身を基準にしている`, { entity: name, specPatch: [{ op: "remove", path: pb }] }));
        if (p.relativeTo !== undefined && p.side === undefined) push(mk(`${pb}/side`, "E_MISSING_PARAM", "error", `place.relativeTo には side(${PLACE_SIDES.join(" | ")})が要る`, { validValues: [...PLACE_SIDES], entity: name, specPatch: [{ op: "add", path: `${pb}/side`, value: "right" }] }));
        if (p.side !== undefined && !(PLACE_SIDES as readonly string[]).includes(String(p.side))) {
          const alias: Record<string, string> = { east: "right", west: "left", north: "front", south: "back", up: "above", down: "below", top: "above", bottom: "below", forward: "front", behind: "back", x: "right", "+x": "right", "-x": "left", "+z": "front", "-z": "back" };
          const dym = alias[String(p.side).toLowerCase()] ?? nearest1(String(p.side), PLACE_SIDES, true);
          push(mk(`${pb}/side`, "E_BAD_ENUM", "error", `place.side に ${JSON.stringify(p.side)} は使えない(${PLACE_SIDES.join(" | ")})`, { validValues: [...PLACE_SIDES], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym ? [{ op: "replace", path: `${pb}/side`, value: dym }] : undefined }));
        }
        if (p.relativeTo !== undefined && p.on !== undefined) push(mk(pb, "E_SPEC_CONFLICT", "error", "place.relativeTo と place.on は同時に使えない(on は「上に載せる」の略記)", { entity: name, specPatch: [{ op: "remove", path: `${pb}/on` }] }));
        if (p.gap !== undefined && (typeof p.gap !== "number" || !Number.isFinite(p.gap))) push(mk(`${pb}/gap`, "E_BAD_TYPE", "error", "place.gap は数値(m)", { entity: name }));
        if (p.offset !== undefined && !isVec3(p.offset)) push(mk(`${pb}/offset`, "E_BAD_TYPE", "error", "place.offset は [x,y,z](m)", { entity: name }));
        if (p.ground !== undefined && typeof p.ground !== "boolean" && (typeof p.ground !== "number" || !Number.isFinite(p.ground))) push(mk(`${pb}/ground`, "E_BAD_TYPE", "error", "place.ground は true か地面の高さ(m)", { entity: name }));
        if (p.snap !== undefined && typeof p.snap !== "boolean") push(mk(`${pb}/snap`, "E_BAD_TYPE", "error", "place.snap は真偽", { entity: name }));
        if (p.align !== undefined && !isObj(p.align)) push(mk(`${pb}/align`, "E_BAD_TYPE", "error", "place.align は {x, y, z}(x/z: center|min|max、y: bottom|center|top)", { entity: name }));
      }
    }
    // lookAt
    if (e.lookAt !== undefined) {
      if (typeof e.lookAt === "string") checkRef(`${base}/lookAt`, e.lookAt, "lookAt", [{ op: "remove", path: `${base}/lookAt` }]);
      else if (!isVec3(e.lookAt)) push(mk(`${base}/lookAt`, "E_BAD_TYPE", "error", "lookAt はエンティティ名か [x,y,z]", { entity: name }));
      if (e.rotation !== undefined) push(mk(`${base}/lookAt`, "E_SPEC_CONFLICT", "error", `${name} は rotation と lookAt を両方指定している(lookAt が回転を決める)`, { entity: name, specPatch: [{ op: "remove", path: `${base}/rotation` }] }));
    }

    // pattern
    let count = 1;
    if (e.pattern !== undefined) {
      const pp = `${base}/pattern`;
      if (!isObj(e.pattern)) { push(mk(pp, "E_BAD_TYPE", "error", "pattern はオブジェクト {type, count, …}", { entity: name })); count = 0; }
      else {
        const p = e.pattern;
        for (const k of Object.keys(p)) {
          if ((PATTERN_KEYS as readonly string[]).includes(k)) continue;
          const dym = suggestKey(k, PATTERN_KEYS, PATTERN_ALIASES);
          push(mk(`${pp}/${k}`, "E_UNKNOWN_PARAM", "error", `pattern の知らないキー '${k}'${dym ? `(→ '${dym}')` : ""}`, { validValues: [...PATTERN_KEYS], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym && !(dym in p) ? [{ op: "move", from: `${pp}/${k}`, path: `${pp}/${dym}` }] : [{ op: "remove", path: `${pp}/${k}` }] }));
        }
        if (typeof p.type !== "string" || !(PATTERN_TYPES as readonly string[]).includes(p.type)) {
          const dym = typeof p.type === "string" ? ({ circle: "ring", round: "ring", row: "line", array: "grid", random: "scatter", wall: "along", edge: "along" } as Record<string, string>)[p.type.toLowerCase()] ?? nearest1(p.type, PATTERN_TYPES, true) : undefined;
          push(mk(`${pp}/type`, p.type === undefined ? "E_MISSING_PARAM" : "E_BAD_ENUM", "error", `pattern.type に ${JSON.stringify(p.type)} は使えない(${PATTERN_TYPES.join(" | ")})`, { validValues: [...PATTERN_TYPES], didYouMean: dym ? [dym] : [], entity: name, specPatch: dym ? [{ op: p.type === undefined ? "add" : "replace", path: `${pp}/type`, value: dym }] : undefined }));
        }
        count = patternCount(p);
        const cnt = p.count;
        const cntOk = typeof cnt === "number" ? Number.isInteger(cnt) && cnt >= 1 : Array.isArray(cnt) && (cnt.length === 2 || cnt.length === 3) && cnt.every((x) => Number.isInteger(x) && x >= 1);
        if (!cntOk) {
          push(mk(`${pp}/count`, cnt === undefined ? "E_MISSING_PARAM" : "E_OUT_OF_RANGE", "error", `pattern.count は 1 以上の整数(grid は [nx,nz] か [nx,ny,nz])。今は ${JSON.stringify(cnt)}`, {
            entity: name, specPatch: typeof cnt === "number" ? [{ op: "replace", path: `${pp}/count`, value: Math.max(1, Math.round(cnt) || 1) }] : cnt === undefined ? [{ op: "add", path: `${pp}/count`, value: 4 }] : undefined,
          }));
          count = 0;
        }
        if (cntOk && p.type === "grid" && typeof cnt === "number") push(mk(`${pp}/count`, "E_BAD_TYPE", "error", "grid の count は [nx,nz](または [nx,ny,nz])。1 次元なら type:\"line\"", { entity: name, specPatch: [{ op: "replace", path: `${pp}/count`, value: [cnt, 1] }] }));
        if (cntOk && p.type !== "grid" && Array.isArray(cnt)) push(mk(`${pp}/count`, "E_BAD_TYPE", "error", `${p.type} の count は整数 1 つ`, { entity: name, specPatch: [{ op: "replace", path: `${pp}/count`, value: (cnt as number[]).reduce((a, b) => a * b, 1) }] }));
        for (const key of ["around", "of"] as const) if (typeof p[key] === "string") checkRef(`${pp}/${key}`, p[key], `pattern.${key}`, [{ op: "remove", path: `${pp}/${key}` }]);
        if (typeof p.area === "string") checkRef(`${pp}/area`, p.area, "pattern.area", [{ op: "remove", path: `${pp}/area` }]);
        if (Array.isArray(p.exclude)) p.exclude.forEach((x, xi) => { if (typeof x === "string" && !refExists(x)) checkRef(`${pp}/exclude/${xi}`, x, "pattern.exclude", [{ op: "remove", path: `${pp}/exclude/${xi}` }]); });
        if (p.type === "ring" && (typeof p.radius !== "number" || !(p.radius > 0))) push(mk(`${pp}/radius`, p.radius === undefined ? "E_MISSING_PARAM" : "E_OUT_OF_RANGE", "error", "ring には radius(> 0 の m)が要る", { entity: name, specPatch: [{ op: p.radius === undefined ? "add" : "replace", path: `${pp}/radius`, value: 3 }] }));
        if (p.type === "ring" && p.around === undefined && p.origin === undefined) push(mk(`${pp}/around`, "E_MISSING_PARAM", "error", "ring には中心(around: 名前か座標、または origin)が要る", { entity: name, specPatch: [{ op: "add", path: `${pp}/origin`, value: [0, 0, 0] }] }));
        if (p.type === "grid" && (!Array.isArray(p.spacing) || !(p.spacing as unknown[]).every((x) => typeof x === "number" && (x as number) > 0))) push(mk(`${pp}/spacing`, p.spacing === undefined ? "E_MISSING_PARAM" : "E_BAD_TYPE", "error", "grid には spacing([sx,sz] か [sx,sy,sz]。中心間隔 m。正の数)が要る", { entity: name, specPatch: [{ op: p.spacing === undefined ? "add" : "replace", path: `${pp}/spacing`, value: [2, 2] }] }));
        const vecN = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => x === null || (typeof x === "number" && Number.isFinite(x)));
        if (p.type === "line" && !(vecN(p.from) && (vecN(p.to) || isVec3(p.step)))) push(mk(`${pp}/from`, "E_MISSING_PARAM", "error", "line には from と、to か step([dx,dy,dz])が要る(各 [x,y,z]。y などは null で place に任せられる)", { entity: name }));
        if (p.type === "along" && typeof p.of !== "string") push(mk(`${pp}/of`, "E_MISSING_PARAM", "error", "along には沿う対象(of: 壁などのエンティティ名)が要る", { entity: name }));
        if (p.type === "along" && p.side !== undefined && !(PLACE_SIDES as readonly string[]).includes(String(p.side))) push(mk(`${pp}/side`, "E_BAD_ENUM", "error", `pattern.side に ${JSON.stringify(p.side)} は使えない`, { validValues: [...PLACE_SIDES], entity: name }));
        if (p.type === "scatter" && p.area === undefined) push(mk(`${pp}/area`, "E_MISSING_PARAM", "error", "scatter には area([minX,minZ,maxX,maxZ] か範囲にするエンティティ名)が要る", { entity: name, specPatch: [{ op: "add", path: `${pp}/area`, value: [-10, -10, 10, 10] }] }));
        if (Array.isArray(p.area) && !(p.area.length === 4 && p.area.every((x) => typeof x === "number" && Number.isFinite(x)) && (p.area as number[])[0] < (p.area as number[])[2] && (p.area as number[])[1] < (p.area as number[])[3])) push(mk(`${pp}/area`, "E_BAD_TYPE", "error", "area は [minX,minZ,maxX,maxZ](min < max)", { entity: name }));
        if (p.seed !== undefined && !Number.isInteger(p.seed)) push(mk(`${pp}/seed`, "E_BAD_TYPE", "error", "seed は整数", { entity: name, specPatch: typeof p.seed === "number" ? [{ op: "replace", path: `${pp}/seed`, value: Math.round(p.seed) }] : undefined }));
        if (p.scaleRange !== undefined && !(Array.isArray(p.scaleRange) && p.scaleRange.length === 2 && (p.scaleRange as number[]).every((x) => typeof x === "number" && x > 0) && (p.scaleRange as number[])[0] <= (p.scaleRange as number[])[1])) push(mk(`${pp}/scaleRange`, "E_BAD_TYPE", "error", "scaleRange は [min, max](正の数・min ≤ max)", { entity: name }));
        if (p.skip !== undefined && !(Array.isArray(p.skip) && p.skip.every((x) => Number.isInteger(x) && x >= 1))) push(mk(`${pp}/skip`, "E_BAD_TYPE", "error", "skip は作らない連番(1 始まり)の整数配列", { entity: name }));
        if (typeof p.around === "string" && p.around === name) push(mk(`${pp}/around`, "E_SPEC_CYCLE", "error", `${name} のパターンが自分自身を中心にしている`, { entity: name, specPatch: [{ op: "remove", path: `${pp}/around` }] }));
        if (e.place !== undefined && isObj(e.place) && (e.place.relativeTo !== undefined) && p.type !== "scatter") push(mk(`${base}/place`, "E_SPEC_CONFLICT", "warn", `${name} は pattern と place.relativeTo を併用している(各 instance に同じ相対配置が掛かり、位置がパターンの位置を上書きする)`, { entity: name }));
      }
    }

    // id の重複(instance は <id>_<NN>)
    if (name && typeof e.id === "string" && !issues.some((x) => x.path === `${base}/id` && x.severity === "error")) {
      const ids = e.pattern !== undefined ? instanceNames(e.id, count, isObj(e.pattern) && Array.isArray(e.pattern.skip) ? (e.pattern.skip as number[]).filter((x) => Number.isInteger(x)) : undefined) : [e.id, ...(kind === "fps_player" ? [`${e.id}Camera`] : [])];
      for (const idv of ids) {
        const prev = seenIds.get(idv);
        if (prev !== undefined) push(mk(`${base}/id`, "E_SPEC_DUPLICATE_NAME", "error", `id '${idv}' が entities[${prev}] と重複(id は仕様の中で一意)`, { entity: name, specPatch: [{ op: "replace", path: `${base}/id`, value: `${e.id}_${i + 1}` }] }));
        else seenIds.set(idv, i);
      }
    }

    // 名前の登録(重複検査)。パターンは instance 名で。
    if (name) {
      if (e.pattern !== undefined) {
        const skip = isObj(e.pattern) && Array.isArray(e.pattern.skip) ? (e.pattern.skip as number[]).filter((x) => Number.isInteger(x)) : undefined;
        const inst = instanceNames(name, count, skip);
        total += inst.length;
        inst.forEach((nm) => {
          const m = /_(\d+)$/.exec(nm);
          if (seenNames.has(nm) || names.has(nm)) {
            const first = seenNames.get(nm) ?? names.get(nm)!.index;
            push(mk(`${base}/name`, "E_SPEC_DUPLICATE_NAME", "error", `名前 '${nm}'(entities[${i}] の pattern から)が entities[${first}] と重複`, { entity: nm, specPatch: [{ op: "replace", path: `${base}/name`, value: `${name}_${i + 1}` }] }));
          } else { seenNames.set(nm, i); names.set(nm, { index: i, instance: m ? Number(m[1]) : undefined }); }
        });
      } else {
        total += kind === "fps_player" ? 2 : 1;
        if (seenNames.has(name)) {
          const first = seenNames.get(name)!;
          let cand = `${name}_2`; let n = 2;
          while (specNames.has(cand) || seenNames.has(cand)) { n++; cand = `${name}_${n}`; }
          push(mk(`${base}/name`, "E_SPEC_DUPLICATE_NAME", "error", `name '${name}' が entities[${first}] と重複(name は差分適用のキーで、仕様の中で一意)`, { entity: name, didYouMean: [cand], specPatch: [{ op: "replace", path: `${base}/name`, value: cand }] }));
        } else { seenNames.set(name, i); names.set(name, { index: i }); }
        if (kind === "fps_player") names.set(`${name}Camera`, { index: i, instance: 2 });
      }
    }
  });

  if (total > MAX_ENTITIES) {
    push(mk("/entities", "E_SPEC_LIMIT", "error", `作るエンティティが ${total} 体で上限 ${MAX_ENTITIES} を超える(パターン展開後)`, {
      cause: `1 回の仕様で作れるのは ${MAX_ENTITIES} 体まで。仕様を分けるか、散布(植生)なら foliage(dx12_call {name:'dx12_foliage_scatter'})を使う。大きい仕様は async:true(ジョブ)で流す`,
      fix: [{ tool: "dx12_apply_scene_spec", args: { async: true }, why: "大規模な仕様はジョブで非同期に実行する(上限以内なら)" }],
    }));
  }

  // 相対配置・親子の循環(参照の存在は上で検査済み)
  const deps = new Map<string, Set<string>>();
  entities.forEach((e, i) => {
    if (!isObj(e) || typeof e.name !== "string") return;
    const d = new Set<string>();
    if (typeof e.parent === "string") d.add(e.parent);
    if (isObj(e.place)) { if (typeof e.place.relativeTo === "string") d.add(e.place.relativeTo); if (typeof e.place.on === "string") d.add(e.place.on); }
    if (isObj(e.pattern)) { for (const k of ["around", "of", "area"] as const) if (typeof e.pattern[k] === "string") d.add(e.pattern[k] as string); if (Array.isArray(e.pattern.exclude)) for (const x of e.pattern.exclude) if (typeof x === "string") d.add(x); }
    // instance 名は元の spec index に解決する
    const resolved = new Set<string>();
    for (const n of d) { const m = names.get(n); if (m) { const owner = entities[m.index] as any; if (owner && typeof owner.name === "string" && owner.name !== e.name) resolved.add(owner.name); } }
    deps.set(e.name, resolved);
  });
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cyc: string[][] = [];
  const dfs = (n: string) => {
    state.set(n, 1); stack.push(n);
    for (const m of deps.get(n) ?? []) {
      if (!deps.has(m)) continue;
      if (state.get(m) === 1) { cyc.push([...stack.slice(stack.indexOf(m)), m]); continue; }
      if (!state.has(m)) dfs(m);
    }
    stack.pop(); state.set(n, 2);
  };
  for (const n of deps.keys()) if (!state.has(n)) dfs(n);
  for (const c of cyc) {
    const last = c[c.length - 2];
    const idx = entities.findIndex((x: any) => isObj(x) && x.name === last);
    const e = entities[idx] as any;
    const key = isObj(e?.place) ? "place" : typeof e?.parent === "string" ? "parent" : isObj(e?.pattern) ? "pattern" : "place";
    push(mk(ptr("entities", idx, key), "E_SPEC_CYCLE", "error", `相対配置・親子が循環している: ${c.join(" → ")}`, { entity: last, cause: "相対配置は基準側を先に決める。輪になっていると解決できない", specPatch: [{ op: "remove", path: ptr("entities", idx, key) }] }));
  }

  // ── 設定 ──
  if (spec.lighting !== undefined) {
    if (!isObj(spec.lighting) || typeof spec.lighting.preset !== "string" || !(LIGHTING_PRESETS as readonly string[]).includes(spec.lighting.preset)) {
      const cur = isObj(spec.lighting) ? spec.lighting.preset : spec.lighting;
      const dym = typeof cur === "string" ? nearest1(cur, LIGHTING_PRESETS, true) : undefined;
      push(mk("/lighting/preset", "E_BAD_ENUM", "error", `lighting.preset に ${JSON.stringify(cur)} は使えない(${LIGHTING_PRESETS.join(" | ")})`, { validValues: [...LIGHTING_PRESETS], didYouMean: dym ? [dym] : [], specPatch: dym ? [{ op: "replace", path: "/lighting", value: { preset: dym } }] : [{ op: "remove", path: "/lighting" }] }));
    }
  }
  if (spec.look !== undefined) {
    const looks = ctx.looks;
    if (!isObj(spec.look) || typeof spec.look.preset !== "string") push(mk("/look", "E_BAD_TYPE", "error", "look は {preset, strength?, parts?}", { specPatch: [{ op: "remove", path: "/look" }] }));
    else {
      if (looks && !looks.includes(spec.look.preset)) {
        const dym = nearest(spec.look.preset, looks, 3, { liberal: true });
        push(mk("/look/preset", "E_BAD_ENUM", "error", `look.preset に ${JSON.stringify(spec.look.preset)} は使えない${dym.length ? `(→ '${dym[0]}')` : ""}`, { validValues: looks.length <= 20 ? [...looks] : undefined, didYouMean: dym, specPatch: dym.length ? [{ op: "replace", path: "/look/preset", value: dym[0] }] : [{ op: "remove", path: "/look" }] }));
      }
      const st = spec.look.strength;
      if (st !== undefined && (typeof st !== "number" || st < 0 || st > 1)) push(mk("/look/strength", "E_OUT_OF_RANGE", "error", `look.strength は 0..1(今は ${JSON.stringify(st)})`, { specPatch: [{ op: "replace", path: "/look/strength", value: typeof st === "number" ? Math.min(1, Math.max(0, st)) : 1 }] }));
    }
  }
  if (spec.sun !== undefined && !isObj(spec.sun)) push(mk("/sun", "E_BAD_TYPE", "error", "sun は {timeOfDay | azimuth, elevation, intensity, …}(dx12_set_sun の引数)", { specPatch: [{ op: "remove", path: "/sun" }] }));
  if (spec.scene !== undefined && !isObj(spec.scene)) push(mk("/scene", "E_BAD_TYPE", "error", "scene は {skybox:{…}, decalAtlasPath?}(dx12_set_scene_settings の引数)", { specPatch: [{ op: "remove", path: "/scene" }] }));
  if (spec.navmesh !== undefined) {
    if (!isObj(spec.navmesh)) push(mk("/navmesh", "E_BAD_TYPE", "error", "navmesh は {build:true, agentRadius?, …}(dx12_navmesh_build の引数)", { specPatch: [{ op: "replace", path: "/navmesh", value: { build: true } }] }));
    else if (spec.navmesh.build === undefined) push(mk("/navmesh/build", "E_MISSING_PARAM", "error", "navmesh.build(true / false)が無い", { specPatch: [{ op: "add", path: "/navmesh/build", value: true }] }));
  }
  if (spec.verify !== undefined && typeof spec.verify !== "boolean") {
    if (!isObj(spec.verify)) push(mk("/verify", "E_BAD_TYPE", "error", "verify は真偽か {layout, naming, scene, reachable}", { specPatch: [{ op: "replace", path: "/verify", value: true }] }));
    else {
      const allowed = ["layout", "naming", "scene", "reachable"];
      for (const k of Object.keys(spec.verify)) if (!allowed.includes(k)) {
        const dym = nearest1(k, allowed, true);
        push(mk(`/verify/${k}`, "E_UNKNOWN_PARAM", "error", `verify の知らないキー '${k}'${dym ? `(→ '${dym}')` : ""}`, { validValues: allowed, didYouMean: dym ? [dym] : [], specPatch: dym && !(dym in spec.verify) ? [{ op: "move", from: `/verify/${k}`, path: `/verify/${dym}` }] : [{ op: "remove", path: `/verify/${k}` }] }));
      }
      for (const k of ["layout", "naming"] as const) {
        const v = (spec.verify as any)[k];
        if (v !== undefined && !["error", "warn", "off"].includes(v)) push(mk(`/verify/${k}`, "E_BAD_ENUM", "error", `verify.${k} は error | warn | off`, { validValues: ["error", "warn", "off"], specPatch: [{ op: "replace", path: `/verify/${k}`, value: v === true ? "error" : v === false ? "off" : "warn" }] }));
      }
      const rc = (spec.verify as any).reachable;
      if (rc !== undefined) {
        const arr = Array.isArray(rc) ? rc : [rc];
        arr.forEach((r: any, ri: number) => {
          const rp = Array.isArray(rc) ? `/verify/reachable/${ri}` : "/verify/reachable";
          if (!isObj(r) || typeof r.from !== "string" || typeof r.to !== "string") push(mk(rp, "E_BAD_TYPE", "error", "verify.reachable は {from:エンティティ名, to:エンティティ名}", {}));
          else { checkRef(`${rp}/from`, r.from, "verify.reachable.from", []); checkRef(`${rp}/to`, r.to, "verify.reachable.to", []); }
        });
      }
    }
  }

  if (!ctx.assets && entities.some((e) => isObj(e) && (e.model !== undefined || e.prefab !== undefined || e.script !== undefined || e.texture !== undefined))) {
    push(mk("", "W_ASSETS_UNCHECKED", "warn", "アセットの実在を確認していない(一覧が取れなかった)。参照切れのモデルはエンティティごと作られない"));
  }
  return { issues, names, entityCount: total };
}

/** error の issue が無いか。 */
export const hasErrors = (issues: SpecIssue[]) => issues.some((i) => i.severity === "error");
