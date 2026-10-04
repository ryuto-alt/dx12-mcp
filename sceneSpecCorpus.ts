// 宣言的シーン生成(M11)の「自己修正ループ」の壊した仕様 20 件と、機械適用のハーネス。
//   例 5 本(sceneSpec/examples/*.json)のどれかを 1 か所壊し、dx12_apply_scene_spec に撃つ → 失敗結果の specPatch(fix[0])を
//   {specRef, patch} でそのまま撃ち直す、を最大 3 回まで繰り返して「成功に転じるか」を数える(M2 の自己修復率と同じ手法)。
//   ・偽エンジン(sceneSim)で 20 件、実エンジン(専用インスタンス)で real:true の 10 件以上を走らせる。
//   ・repairable:false は「機械では直せないと分かっている」件(到達不能・仕様の外の既存物との重なり)。正直に分母に入れる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const loadExample = (n: string): any => JSON.parse(fs.readFileSync(path.join(here, "sceneSpec", "examples", `${n}.json`), "utf8"));

export type Case = {
  id: string;
  /** 壊す元の例(sceneSpec/examples/<base>.json)。 */
  base: "fps_arena" | "room" | "garden" | "showcase" | "horror_corridor";
  /** 何を壊したか(1 行)。 */
  note: string;
  /** 元の仕様を壊す(元は変えず、コピーを返す)。 */
  mutate: (spec: any) => any;
  /** 最初の適用で失敗する段階(検証)。 */
  firstStage: "validate" | "apply" | "verify";
  /** 機械の specPatch で直せると期待するか。 */
  repairable: boolean;
  /** 実エンジンでも走らせる(モデル・スクリプト・テクスチャの実在に依存しないもの)。 */
  real?: boolean;
  /** 偽エンジン限定の準備(到達不能の再現など)。 */
  sim?: (sim: any) => void;
  /** 適用の前に、仕様の外の物をシーンに置く(手で置いた物との重なりの再現)。engine.call を渡す。 */
  pre?: (call: (method: string, params: Record<string, unknown>) => Promise<any>) => Promise<void>;
};

const ent = (s: any, name: string) => { const e = s.entities.find((x: any) => x.name === name); if (!e) throw new Error(`base に ${name} が無い`); return e; };
const clone = (s: any) => JSON.parse(JSON.stringify(s));

export const CASES: Case[] = [
  { id: "typo_key_postion", base: "showcase", note: "キー at を postion と打ち間違える", firstStage: "validate", repairable: true, real: true, mutate: (s) => { const e = ent(s, "ENV_Pedestal"); e.postion = e.at; delete e.at; return s; } },
  { id: "kind_alias_cube", base: "showcase", note: "kind に cube(別名)を書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "ENV_Cube").kind = "cube"; return s; } },
  { id: "kind_point_light", base: "room", note: "kind に point_light を書く(kind:light + light:point が正)", firstStage: "validate", repairable: true, mutate: (s) => { const e = ent(s, "LGT_Window"); e.kind = "point_light"; delete e.light; return s; } },
  { id: "model_path_typo", base: "showcase", note: "モデルのパスを 1 文字違い(cube1.glb)にする", firstStage: "validate", repairable: true, real: true, mutate: (s) => { s.entities.push({ name: "ENV_Model", kind: "model", model: "models/cube1.glb", group: "ENV", at: [-3, null, 0], place: { on: "LVL_Floor" } }); return s; } },
  { id: "duplicate_name", base: "room", note: "同じ name を 2 つ書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { s.entities.push({ ...clone(ent(s, "ENV_ChairL")) }); return s; } },
  { id: "ref_typo_relativeTo", base: "room", note: "place.relativeTo の名前を打ち間違える(ENV_Tabel)", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "ENV_ChairL").place.relativeTo = "ENV_Tabel"; return s; } },
  { id: "parent_missing", base: "showcase", note: "存在しない parent を指す", firstStage: "validate", repairable: true, mutate: (s) => { ent(s, "ENV_Cube").parent = "GP_Nobody"; return s; } },
  { id: "cycle_place", base: "showcase", note: "相対配置が輪になる(Cube と Pedestal が互いを基準に)", firstStage: "validate", repairable: true, mutate: (s) => { ent(s, "ENV_Pedestal").place = { relativeTo: "ENV_Cube", side: "left" }; ent(s, "ENV_Pedestal").at = [null, null, null]; return s; } },
  { id: "at_as_string", base: "showcase", note: "at を文字列 \"2.4,1.8,-5.2\" で書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "CAM_Main").at = "2.4,1.8,-5.2"; return s; } },
  { id: "color_0_255", base: "showcase", note: "color を 0..255 で書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "ENV_Sphere").color = [201, 162, 74]; return s; } },
  { id: "roughness_range", base: "showcase", note: "material.roughness に 5 を書く", firstStage: "validate", repairable: true, mutate: (s) => { ent(s, "ENV_Sphere").material.roughness = 5; return s; } },
  { id: "component_key_typo", base: "room", note: "components のキーを rigidbody(小文字)と書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "ENV_Table").components = { rigidbody: { motionType: 0 } }; return s; } },
  { id: "script_path_typo", base: "showcase", note: "script のパスを打ち間違える(Spinnr.lua)", firstStage: "validate", repairable: true, mutate: (s) => { s.entities.push({ name: "ENV_Spinner", kind: "empty", group: "ENV", script: "components/Spinnr.lua" }); return s; } },
  { id: "pattern_no_count", base: "room", note: "ring パターンに count を書かない", firstStage: "validate", repairable: true, real: true, mutate: (s) => { s.entities.push({ name: "ENV_Stool", kind: "box", size: 0.4, group: "ENV", pattern: { type: "ring", radius: 2.2, origin: [0.5, 0, -0.5] }, place: { on: "LVL_Floor" } }); return s; } },
  { id: "lighting_preset_typo", base: "showcase", note: "lighting.preset に nite を書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { s.lighting.preset = "nite"; return s; } },
  { id: "size_and_scale", base: "showcase", note: "size と scale を両方書く", firstStage: "validate", repairable: true, real: true, mutate: (s) => { ent(s, "ENV_Cube").scale = 2; return s; } },
  { id: "overlap_duplicate_position", base: "showcase", note: "同じ位置に同じ箱を 2 つ置く(検証の DUPLICATE)", firstStage: "verify", repairable: true, real: true, mutate: (s) => { s.entities.push({ name: "ENV_CubeTwin", kind: "box", size: 0.5, group: "ENV", rotation: [0, 35, 0], place: { relativeTo: "ENV_Pedestal", side: "right", gap: 0.9 } }); return s; } },
  { id: "buried_box", base: "showcase", note: "床に半分埋まった箱(検証の BURIED)", firstStage: "verify", repairable: true, real: true, mutate: (s) => { s.entities.push({ name: "ENV_Buried", kind: "box", size: 1, group: "ENV", at: [-3, -0.4, 0] }); return s; } },
  { id: "collider_without_body", base: "room", note: "boxCollider だけで rigidBody が無い(検証の COLLIDER_WITHOUT_BODY)", firstStage: "verify", repairable: true, mutate: (s) => { ent(s, "ENV_Table").components = { boxCollider: { halfExtents: [0.5, 0.5, 0.5] } }; return s; } },
  { id: "grid_overlap", base: "showcase", note: "grid の spacing が箱より小さく、instance が重なる(検証の OVERLAP)", firstStage: "verify", repairable: true, mutate: (s) => { s.entities.push({ name: "ENV_Tile", kind: "box", size: 1, group: "ENV", pattern: { type: "grid", count: [2, 2], spacing: [0.1, 0.1], origin: [-4, 0, -2] }, place: { on: "LVL_Floor" } }); return s; } },
  { id: "unreachable_wall", base: "fps_arena", note: "通路を完全に塞ぐ壁(到達性の検証。機械では直せない)", firstStage: "verify", repairable: false, sim: (sim) => { sim.state.navBlocked = true; }, mutate: (s) => { s.entities.push({ name: "LVL_Barrier", kind: "box", size: [42, 5, 1], group: "LVL", at: [0, null, 0], place: { on: "LVL_Floor" }, collider: "static" }); return s; } },
  { id: "double_fault", base: "showcase", note: "キーの打ち間違いとモデルのパス違いを同時に", firstStage: "validate", repairable: true, real: true, mutate: (s) => { const e = ent(s, "ENV_Pedestal"); e.rotaton = [0, 0, 0]; s.entities.push({ name: "ENV_Model", kind: "model", model: "models/cube1.glb", group: "ENV", at: [-3, null, 0], place: { on: "LVL_Floor" } }); return s; } },
  { id: "scale_zero", base: "showcase", note: "scale に 0 を含める", firstStage: "validate", repairable: true, mutate: (s) => { const e = ent(s, "ENV_Pedestal"); delete e.size; e.scale = [1.4, 0, 1.4]; return s; } },
  { id: "reserved_name_grid", base: "room", note: "エディタ内部の名前 Grid を使う", firstStage: "validate", repairable: true, real: true, mutate: (s) => { s.entities.push({ name: "Grid", kind: "box", size: 0.5, group: "ENV", at: [1.5, null, 1.5], place: { on: "LVL_Floor" } }); return s; } },
  { id: "light_enum_typo", base: "showcase", note: "light に pointt を書く", firstStage: "validate", repairable: true, mutate: (s) => { ent(s, "LGT_Fill").light = "pointt"; return s; } },
  { id: "side_east", base: "room", note: "place.side に east を書く", firstStage: "validate", repairable: true, mutate: (s) => { ent(s, "ENV_ChairR").place.side = "east"; return s; } },
  { id: "foreign_overlap", base: "showcase", note: "仕様の外の既存の物(手で置いた箱)と同じ場所に重なる(機械では直せない)", firstStage: "verify", repairable: false, real: true, mutate: (s) => s,
    pre: async (call) => { await call("create_entity", { type: "box", name: "HandMade", position: [0, 0.45, 0] }); await call("set_transform", { name: "HandMade", scale: [1.4, 0.9, 1.4] }); } },
];

export type RepairRun = (input: { spec?: unknown; specRef?: string; patch?: unknown[]; mode?: "plan" | "apply"; verify?: unknown }) => Promise<any>;

export type RepairOutcome = {
  id: string;
  ok: boolean;
  /** 最初の適用が期待どおり失敗したか。 */
  firstFailed: boolean;
  firstStage?: string;
  /** 撃ち直した回数(0 = 最初から成功)。 */
  retries: number;
  attempts: { ok: boolean; stage?: string; codes: string[]; patchOps: number }[];
  detail?: string;
};

/** 壊した仕様を撃ち、失敗結果の specPatch を {specRef, patch} で撃ち直す(最大 maxRetries 回)。 */
export async function repairLoop(id: string, run: RepairRun, spec: any, maxRetries = 3): Promise<RepairOutcome> {
  const out: RepairOutcome = { id, ok: false, firstFailed: false, retries: 0, attempts: [] };
  let r = await run({ spec });
  const rec = (x: any) => out.attempts.push({ ok: !!x.ok, stage: x.stage ?? x.body?.details?.stage, codes: (x.issues ?? []).map((i: any) => i.code).slice(0, 6), patchOps: (x.specPatch ?? x.body?.details?.specPatch ?? []).length });
  rec(r);
  out.firstFailed = !r.ok;
  out.firstStage = r.ok ? undefined : (r.stage ?? r.body?.details?.stage);
  for (let i = 0; i < maxRetries && !r.ok; i++) {
    const patch = r.specPatch ?? r.body?.details?.specPatch ?? [];
    const ref = r.specRef ?? r.body?.details?.specRef;
    if (!patch.length || !ref) { out.detail = `specPatch が無い(${(r.issues ?? [])[0]?.code ?? r.body?.code}: ${String(r.message ?? r.body?.message).slice(0, 120)})`; break; }
    out.retries++;
    r = await run({ specRef: ref, patch });
    rec(r);
  }
  out.ok = !!r.ok;
  if (!out.ok && !out.detail) out.detail = `${out.retries} 回撃ち直しても失敗: ${String(r.message ?? r.body?.message).slice(0, 160)}`;
  return out;
}
