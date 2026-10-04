// SceneSpec v1 の型と共通の定数(M11)。純データ。仕様の書き方は docs/MCP.md「宣言的シーン生成」と dx12_guide {topic:"scene_spec"}。
import type { Vec3, AABB } from "./geom.ts";
export type { Vec3, AABB } from "./geom.ts";

export const SPEC_VERSION = 1;
/** 1 回の仕様で作れるエンティティ数の上限(パターン展開後)。超えたらエラー + ジョブ推奨。 */
export const MAX_ENTITIES = 5000;
/** これを超えたら dx12_apply_scene_spec {async:true}(ジョブ)を勧める。 */
export const JOB_RECOMMEND_ENTITIES = 1500;
/** データ(data)に入れる所有者の印。prune は「この印が自分の仕様名のもの」だけを消す。 */
export const OWNER_KEY = "__spec";
/** 読み戻せない部分(texture / 別名 place の snap / lookAt / script props など)の JSON。差分の比較と scene_spec_export に使う。 */
export const OPAQUE_KEY = "__o";
/** 安定 ID の印。name を後から変えても、同じ id のエンティティを rename_entity で追従させる(複製 + 孤児にしない)。既定の id は name。 */
export const ID_KEY = "__id";

export const KINDS = [
  "box", "sphere", "plane", "model", "prefab", "empty", "camera", "light", "trigger", "particle_emitter", "decal",
  "ui_canvas", "ui_image", "ui_text", "ui_button", "ui_slider", "ui_toggle", "ui_scrollview", "fps_player",
] as const;
export type Kind = (typeof KINDS)[number];

export const LIGHT_TYPES = ["directional", "point", "spot"] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

/** 命名規約のグループ(sceneOrganize.ts の GROUPS と同じ)。値はグループ根エンティティ名。 */
export const GROUP_KEYS = ["LVL", "ENV", "LGT", "GP", "FX", "UI", "CAM"] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];
export const GROUP_ROOT: Record<GroupKey, string> = { LVL: "LVL", ENV: "ENV", LGT: "LIGHT", GP: "GAMEPLAY", FX: "FX", UI: "UI", CAM: "CAMERA" };

export const PLACE_SIDES = ["right", "left", "front", "back", "above", "below"] as const;
export type PlaceSide = (typeof PLACE_SIDES)[number];
export const PATTERN_TYPES = ["grid", "ring", "line", "along", "scatter"] as const;
export type PatternType = (typeof PATTERN_TYPES)[number];

export const LIGHTING_PRESETS = ["day", "dusk", "night", "indoor", "horror", "studio"] as const;
export const TEXTURE_SLOTS = ["albedo", "normal", "metalRoughness", "emissive"] as const;
export const ALPHA_MODES = ["auto", "opaque", "mask", "blend"] as const;

export type PlaceSpec = {
  /** 相対配置の基準にするエンティティ名(仕様の中のもの、またはシーンに既にあるもの)。 */
  relativeTo?: string;
  side?: PlaceSide;
  /** 面と面のすき間(m)。既定 0。 */
  gap?: number;
  /** 他の 2 軸の揃え。 x/z: center(既定)|min|max、y: bottom(既定。横に並べるとき)|center|top。 */
  align?: { x?: "center" | "min" | "max"; y?: "bottom" | "center" | "top"; z?: "center" | "min" | "max" };
  /** 上に載せる(side:"above" + gap 0 の略記)。 */
  on?: string;
  /** 地面(y=0、または数値の高さ)に足元を合わせる。 */
  ground?: boolean | number;
  /** 解決後に足すずらし(m)。 */
  offset?: Vec3;
  /** 置いたあとエンジンの snap_to_ground(真下の実際の面に精密レイキャストで載せる)を掛ける。y はエンジンが決める。 */
  snap?: boolean;
};

export type PatternSpec = {
  type: PatternType;
  count?: number | [number, number] | [number, number, number];
  /** grid: 中心間隔(m)[x,z] または [x,y,z]。line: step の代わりに from/to。 */
  spacing?: [number, number] | Vec3;
  /** grid/ring の中心(座標)。省略で around を使う。 */
  origin?: Vec3;
  /** grid/ring の中心にするエンティティ名(その AABB の中心)、または座標。 */
  around?: string | Vec3;
  radius?: number;
  startAngle?: number;
  arc?: number;
  faceCenter?: boolean;
  /** line: 始点・終点。null の軸は解かない(place で決める。例 y を床に載せる)。 */
  from?: (number | null)[];
  to?: (number | null)[];
  step?: Vec3;
  /** along: 沿う対象(壁など)。 */
  of?: string;
  side?: PlaceSide;
  margin?: number;
  gap?: number;
  /** scatter の範囲 [minX,minZ,maxX,maxZ] か、範囲にするエンティティ名。 */
  area?: [number, number, number, number] | string;
  minSpacing?: number;
  seed?: number;
  jitter?: number;
  yaw?: "random" | number;
  scaleRange?: [number, number];
  y?: number;
  /** 避けるエンティティ名(その AABB の XZ 範囲に入れない)。 */
  exclude?: string[];
  /** 作らない連番(1 始まり)。 */
  skip?: number[];
};

export type MaterialSpec = {
  metallic?: number; roughness?: number; emissive?: Vec3; emissiveIntensity?: number; opacity?: number;
  alphaMode?: (typeof ALPHA_MODES)[number]; uvScale?: [number, number];
};

export type EntitySpec = {
  name: string;
  /** 安定 ID(省略で name)。name を変えても同じ id は同じ物として名前だけ変える。パターンの instance の id は <id>_<NN>。 */
  id?: string;
  kind: Kind;
  light?: LightType;
  model?: string;
  prefab?: string;
  group?: GroupKey;
  parent?: string;
  /** 位置(m)。親が無ければワールド、あればローカル。null の軸は place などで決める。 */
  at?: (number | null)[];
  rotation?: Vec3;
  scale?: Vec3 | number;
  /** プリミティブの実寸(m)。box [w,h,d] / sphere 直径 / plane [w,d]。scale の別表現(併用不可)。 */
  size?: number | number[];
  color?: Vec3 | string;
  material?: MaterialSpec;
  texture?: Partial<Record<(typeof TEXTURE_SLOTS)[number], string>>;
  /** 当たり判定の略記: "static"(動かない床・壁)/ "dynamic"(物理で動く)。rigidBody + 形に合ったコライダー(box は ±0.5、sphere は半径 0.5、モデルは実寸の AABB)を付ける。components で上書きできる。 */
  collider?: "static" | "dynamic";
  components?: Record<string, Record<string, unknown>>;
  script?: string | { path: string; props?: Record<string, unknown> };
  tags?: string[];
  data?: Record<string, number | boolean | string | Vec3>;
  place?: PlaceSpec;
  pattern?: PatternSpec;
  lookAt?: string | Vec3;
  /** メッシュの実寸が測れないもの(prefab など)の AABB(scale 1)。相対配置の基準にするときだけ要る。 */
  bounds?: { min: Vec3; max: Vec3 };
  comment?: string;
};

export type VerifySpec = {
  layout?: "error" | "warn" | "off";
  naming?: "error" | "warn" | "off";
  scene?: boolean;
  reachable?: { from: string; to: string } | { from: string; to: string }[];
};

export type SceneSpec = {
  version: 1;
  /** 仕様の名前(所有者の印)。同じ名前で撃ち直すと差分になる。既定 "scene"。 */
  name?: string;
  entities?: EntitySpec[];
  lighting?: { preset: (typeof LIGHTING_PRESETS)[number] };
  look?: { preset: string; strength?: number; parts?: string[] };
  sun?: Record<string, unknown>;
  scene?: { skybox?: Record<string, unknown>; decalAtlasPath?: string };
  navmesh?: { build: boolean } & Record<string, unknown>;
  verify?: VerifySpec | boolean;
  comment?: string;
};

// ── 検証の結果 ───────────────────────────────────────────────
export type PatchOp = { op: "add" | "replace" | "remove" | "move" | "copy" | "test"; path: string; value?: unknown; from?: string };

export type SpecFix = { tool?: string; args?: Record<string, unknown>; why?: string };

/** 仕様の不具合 1 件。path は JSON Pointer(仕様のルートから)。specPatch はそのまま撃ち直せる差分。 */
export type SpecIssue = {
  path: string;
  code: string;
  severity: "error" | "warn";
  message: string;
  cause?: string;
  validValues?: unknown[];
  didYouMean?: string[];
  fix?: SpecFix[];
  specPatch?: PatchOp[];
  /** 検証(verify)由来のとき、どの検査か。 */
  check?: string;
  /** 関係するエンティティ名。 */
  entity?: string;
  /** 同じ原因・同じ直し方をまとめたときの、全エンティティ名と件数(パターンの instance など)。 */
  entities?: string[];
  count?: number;
};
