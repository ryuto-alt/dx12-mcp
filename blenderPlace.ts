/**
 * Blender で作って並べたものを、同じ配置で dx12 のシーンに置く(dx12_blender_place の本体)。
 * 「2 回目以降は差分更新」: 同じ名前のエンティティがあれば Transform だけ更新し、無ければ作る。
 *
 * エンジンと Blender の呼び出しは deps で受ける(ツール登録からも検証スクリプトからも同じ関数を呼べる)。
 *
 * ★座標変換(2026-10-05 に実機で確定)。エンジンは glTF の座標をそのまま使うので、
 *   Blender のワールド座標 (x,y,z) → エンジン (x, z, -y)。これは回転(行列式 +1)なので:
 *     位置   [x,y,z]        → [x, z, -y]
 *     回転   (w,x,y,z)      → [qx, qz, -qy, qw]   ※エンジンの quaternion は [x,y,z,w]
 *     スケール [sx,sy,sz]    → [sx, sz, sy]         ※対角行列を C で共役にすると軸が入れ替わるだけ
 *   これで「各オブジェクトを原点で書き出してエンジン側で変換する」と「シーン全体を 1 つの glTF に出す」の見た目が一致する。
 *   (検証: +X 方向 2m の棒を Z 軸 90° 相当の [0,0.7071,0,0.7071] で置くと z∈[-2,0]。Blender で y∈[0,2] と一致)
 *
 * ★書き出しの罠(blenderBridge.ts の buildExportScript と同じ理由):
 *   ・use_selection=False は全シーンを出す → 全シーン全 view_layer の選択を外してから代表だけ選ぶ
 *   ・画像が tmpXXXX という一時名で出る → planImageRenames で直す
 *   ・★ユーザーのオブジェクトの matrix_world は触らない。代表の【一時コピー】(同じメッシュデータを共有・親なし・単位行列)を
 *     専用コレクションに作って書き出し、finally で必ず消す。matrix_world を書き換えて戻す方式は、親付きだと
 *     matrix_basis が浮動小数の誤差で動くので採らなかった。
 */

import fs from "node:fs";
import path from "node:path";
import { planImageRenames, BAKED_SWAP_PY } from "./blenderBridge.ts";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// ─── 純関数: 座標変換 ───────────────────────────────────────────────────────

export function blenderToEnginePos(p: readonly number[]): Vec3 { return [p[0], p[2], -p[1]]; }
/** Blender の (w,x,y,z) → エンジンの [x,y,z,w] */
export function blenderToEngineQuat(q: readonly number[]): Quat { return [q[1], q[3], -q[2], q[0]]; }
export function blenderToEngineScale(s: readonly number[]): Vec3 { return [s[0], s[2], s[1]]; }

/** -0 を 0 にして丸める(JSON と差分比較を読みやすくする) */
const r6 = (v: number): number => { const x = Math.round(v * 1e6) / 1e6; return x === 0 ? 0 : x; };

export function blenderToEngine(t: { loc: readonly number[]; quat: readonly number[]; scale: readonly number[] }):
  { position: Vec3; quaternion: Quat; scale: Vec3 } {
  return {
    position: blenderToEnginePos(t.loc).map(r6) as Vec3,
    quaternion: blenderToEngineQuat(t.quat).map(r6) as Quat,
    scale: blenderToEngineScale(t.scale).map(r6) as Vec3,
  };
}

/**
 * エンジンが get_entity で返す rotation(Euler 度 [x,y,z])→ クォータニオン [x,y,z,w]。
 * ★実測(2026-10-05): q = qY ⊗ qX ⊗ qZ(DirectXMath の RollPitchYaw と同じ。Z→X→Y の順に回す)。
 *   Blender の Euler(20,35,50)=エンジンの [16.27,38.21,-36.69] が、変換後のクォータニオンと 1e-6 で一致した。
 */
export function engineEulerToQuat(deg: readonly number[]): Quat {
  const ax = (i: number, d: number): Quat => { const h = (d * Math.PI) / 360; const q: Quat = [0, 0, 0, Math.cos(h)]; q[i] = Math.sin(h); return q; };
  const mul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  return mul(mul(ax(1, deg[1]), ax(0, deg[0])), ax(2, deg[2]));
}

/** q と -q は同じ回転。内積の絶対値が 1 に近ければ等しい。 */
export function quatClose(a: readonly number[], b: readonly number[], eps = 1e-4): boolean {
  // 丸め(1e-6)で長さが 1 からずれるので正規化してから比べる
  const n = Math.hypot(a[0], a[1], a[2], a[3]) * Math.hypot(b[0], b[1], b[2], b[3]);
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / n;
  return 1 - d < eps;
}
export function vecClose(a: readonly number[], b: readonly number[], eps = 1e-4): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

// ─── 純関数: 配置計画 ───────────────────────────────────────────────────────

export interface PlaceObject {
  name: string;
  modelPath: string;          // assets 相対
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
}
export interface ExistingChild {
  entityId: number;
  name: string;
  modelPath?: string;
  position?: number[];
  quaternion?: number[];
  scale?: number[];
}
export interface PlacePlan {
  spawn: PlaceObject[];
  update: { entityId: number; obj: PlaceObject; modelChanged: boolean; transformChanged: boolean }[];
  prune: { entityId: number; name: string; reason: string }[];
  /** group 配下に同名の子が複数あった(2 個目以降)。prune:true でなくても報告する */
  duplicates: { entityId: number; name: string }[];
}

/**
 * Blender 側の一覧と group 配下の既存の子を突き合わせる。
 * ・同名の子があれば update(モデルのパスが違えば modelChanged、Transform が同じなら transformChanged:false)
 * ・無ければ spawn / 今回の一覧に無い子は prune:true のときだけ prune
 * ★名前が鍵。Blender のオブジェクト名は一意なのでそのままエンティティ名にする。
 */
export function planPlacement(objs: PlaceObject[], existing: ExistingChild[], opts: { prune?: boolean } = {}): PlacePlan {
  const byName = new Map<string, ExistingChild>();
  const duplicates: PlacePlan["duplicates"] = [];
  for (const e of existing) {
    if (byName.has(e.name)) duplicates.push({ entityId: e.entityId, name: e.name });
    else byName.set(e.name, e);
  }
  const plan: PlacePlan = { spawn: [], update: [], prune: [], duplicates };
  const wanted = new Set<string>();
  for (const o of objs) {
    wanted.add(o.name);
    const ex = byName.get(o.name);
    if (!ex) { plan.spawn.push(o); continue; }
    const same = ex.position && ex.quaternion && ex.scale
      && vecClose(ex.position, o.position) && quatClose(ex.quaternion, o.quaternion, 1e-9) && vecClose(ex.scale, o.scale);
    plan.update.push({ entityId: ex.entityId, obj: o, modelChanged: !!ex.modelPath && ex.modelPath !== o.modelPath, transformChanged: !same });
  }
  if (opts.prune) {
    for (const [name, e] of byName) if (!wanted.has(name)) plan.prune.push({ entityId: e.entityId, name, reason: "今回の Blender 側に無い" });
    for (const d of duplicates) plan.prune.push({ entityId: d.entityId, name: d.name, reason: "同名の子が重複している" });
  }
  return plan;
}

/** アセットの assets 相対パス。<assetDir>/<fileKey>/<fileKey>.gltf */
export function assetModelPath(assetDir: string, fileKey: string): string {
  return `${assetDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${fileKey}/${fileKey}.gltf`;
}

// ─── Blender 側スクリプト(純粋: 文字列を返すだけ) ───────────────────────────

export interface PlaceScriptParams {
  objects: string[];      // 空なら選択中 → 無ければ表示中の全 MESH
  assetsRoot: string;     // assets の絶対パス
  assetDir: string;       // 空なら models/blender/<blend 名>
  group: string;          // 空なら Blender_<blend 名>
  exportMeshes: boolean;  // false なら書き出さない(dryRun / meshes:false)
}

export function buildPlaceScript(p: PlaceScriptParams): string {
  const params = JSON.stringify(JSON.stringify({ ...p, assetsRoot: p.assetsRoot.replace(/\\/g, "/") }));
  return `
import bpy, json, os, re
from mathutils import Matrix
${BAKED_SWAP_PY}
P = json.loads(${params})
report = {"objects": [], "skipped": [], "warnings": [], "assets": []}

def safe(s):
    t = re.sub(r"[^0-9A-Za-z_.-]", "_", s).strip(".")
    return t or "unnamed"

bpy.context.view_layer.update()
scene = bpy.context.scene
blend = os.path.splitext(os.path.basename(bpy.data.filepath))[0] or "untitled"
asset_dir = (P["assetDir"] or ("models/blender/" + safe(blend))).replace("\\\\", "/").strip("/")
report["blendName"] = blend
report["assetDir"] = asset_dir
report["group"] = P["group"] or ("Blender_" + blend)

# ① 対象を決める(名前指定 → 選択中 → 表示中の全 MESH)
targets = []
if P["objects"]:
    for n in P["objects"]:
        ob = bpy.data.objects.get(n)
        if ob is None:
            report["warnings"].append("オブジェクトが見つからない: " + n)
        else:
            targets.append(ob)
    report["source"] = "names"
else:
    targets = list(bpy.context.selected_objects)
    report["source"] = "selection"
    if not targets:
        targets = [o for o in bpy.context.view_layer.objects if o.type == 'MESH' and o.visible_get()]
        report["source"] = "visible"
seen = set()
targets = [o for o in sorted(targets, key=lambda o: o.name) if not (o.name in seen or seen.add(o.name))]

if abs(scene.unit_settings.scale_length - 1.0) > 1e-9:
    report["warnings"].append("シーンの単位スケールが %g。glTF は Blender 内部の単位(=1 が 1m)のまま出るので、見かけの m とずれる" % scene.unit_settings.scale_length)

# ② MESH だけ取る。それ以外は理由付きで skipped
REASON = {
    'LIGHT': "ライトは対象外(エンジン側は dx12_create_entity {type:light_*} で作る)",
    'CAMERA': "カメラは対象外(エンジン側は dx12_create_entity {type:camera} で作る)",
    'EMPTY': "空(EMPTY)は対象外。親子は平らにしてワールド変換で置く",
}
meshes = []
for ob in targets:
    if ob.type != 'MESH':
        why = REASON.get(ob.type, ob.type + " は MESH ではないので対象外(置きたいなら Blender でメッシュに変換する)")
        report["skipped"].append({"name": ob.name, "type": ob.type, "reason": why})
    elif len(ob.data.polygons) == 0:
        report["skipped"].append({"name": ob.name, "type": ob.type, "reason": "面が 0 枚"})
    else:
        meshes.append(ob)

# ③ メッシュキー: モディファイア無し=メッシュデータ名(リンク複製は 1 アセットを共有) / 有り=オブジェクト固有
def raw_key(ob):
    # ★焼いたマテリアル(dx12_baked_material)があれば、同じメッシュでも別アセット(見た目が違う)
    suffix = ("." + ob["dx12_baked_material"]) if ob.get("dx12_baked_material") else ""
    return (("o:" + ob.name) if len(ob.modifiers) > 0 else ("m:" + ob.data.name)) + suffix

file_keys = {}
used = set()
for rk in sorted(set(raw_key(o) for o in meshes)):
    fk = safe(rk[2:])
    n = 2
    base = fk
    while fk in used:
        fk = base + "_" + str(n)
        n += 1
    used.add(fk)
    file_keys[rk] = fk

groups = {}
for ob in meshes:
    rk = raw_key(ob)
    groups.setdefault(rk, []).append(ob)

# ④ 各オブジェクトのワールド変換(平らにする。親子は matrix_world に畳まれている)
warned_mat = set()
for ob in meshes:
    mw = ob.matrix_world
    loc, rot, scl = mw.decompose()
    err = max(abs(a - b) for ra, rb in zip(Matrix.LocRotScale(loc, rot, scl), mw) for a, b in zip(ra, rb))
    if err > 1e-4:
        report["warnings"].append(ob.name + ": せん断(非一様スケールの親の下で回転している等)があり、位置・回転・スケールに分解すると形が合わない(誤差 %.4f)" % err)
    if min(scl) < 0:
        report["warnings"].append(ob.name + ": 負のスケール(ミラー)。エンジン側で面が裏返る可能性がある")
    for slot in (ob.material_slots if not ob.get("dx12_baked_material") else []):
        mat = slot.material
        if mat is None or not mat.use_nodes:
            k = (ob.data.name, None if mat is None else mat.name)
            if k not in warned_mat:
                warned_mat.add(k)
                report["warnings"].append(ob.name + ": マテリアルが無い/ノード無効 → エンジンでは真っ白になる")
            continue
        if not any(n.type == 'TEX_IMAGE' and n.image for n in mat.node_tree.nodes):
            k = (ob.data.name, mat.name)
            if k not in warned_mat:
                warned_mat.add(k)
                report["warnings"].append(ob.name + " / " + mat.name + ": 画像テクスチャが 1 枚も無い → エンジンは baseColorFactor を読まないので真っ白になる")
    report["objects"].append({
        "name": ob.name, "key": file_keys[raw_key(ob)], "parent": ob.parent.name if ob.parent else None,
        "loc": [loc.x, loc.y, loc.z], "quat": [rot.w, rot.x, rot.y, rot.z], "scale": [scl.x, scl.y, scl.z],
    })

# ⑤ 書き出し(アセットごと 1 回)。★ユーザーのオブジェクトは触らず、代表の一時コピーを単位行列で出す
saved = []
for sc in bpy.data.scenes:
    for vl in sc.view_layers:
        act = vl.objects.active
        saved.append((vl, [o.name for o in vl.objects if o.select_get(view_layer=vl)], act.name if act else None))

def deselect_all():
    for sc in bpy.data.scenes:
        for vl in sc.view_layers:
            for o in vl.objects:
                try:
                    o.select_set(False, view_layer=vl)
                except Exception:
                    pass

tmp_col = None
try:
    if P["exportMeshes"] and meshes:
        tmp_col = bpy.data.collections.new("dx12_place_tmp")
        scene.collection.children.link(tmp_col)
    for rk in sorted(groups):
        fk = file_keys[rk]
        objs = groups[rk]
        d = os.path.join(P["assetsRoot"], asset_dir, fk)
        out = os.path.join(d, fk + ".gltf").replace("\\\\", "/")
        a = {"key": fk, "meshKey": rk, "path": asset_dir + "/" + fk + "/" + fk + ".gltf", "objects": [o.name for o in objs], "exported": False}
        if P["exportMeshes"]:
            tmp = None
            swap = None
            try:
                os.makedirs(d, exist_ok=True)
                rep = objs[0]
                tmp = rep.copy()
                tmp.animation_data_clear()
                for c in list(tmp.constraints):
                    tmp.constraints.remove(c)
                tmp.parent = None
                tmp.matrix_parent_inverse = Matrix.Identity(4)
                tmp.matrix_basis = Matrix.Identity(4)
                tmp.hide_viewport = False
                tmp.hide_render = False
                tmp_col.objects.link(tmp)
                # ★焼いた物は、一時コピーのメッシュを複製して焼いたマテリアル + 先頭 UV に差し替える(元のオブジェクト・メッシュは触らない)
                swap = dx12_swap_in(tmp)
                if swap is not None:
                    a["bakedMaterial"] = tmp["dx12_baked_material"]
                bpy.context.view_layer.update()
                deselect_all()
                tmp.hide_set(False)
                tmp.select_set(True)
                bpy.context.view_layer.objects.active = tmp
                kwargs = dict(
                    filepath=out,
                    use_selection=True,          # ★False だと全シーンが出る
                    export_yup=True,
                    export_apply=True,
                    export_morph=False,          # シェイプキーは出さない(元のキーは消さない)
                    export_animations=False,
                    export_format="GLTF_SEPARATE",
                    export_texture_dir="textures",
                )
                try:
                    bpy.ops.export_scene.gltf(**kwargs)
                except TypeError:
                    # 版によって引数名が違う。落ちるくらいなら最小構成で出す。
                    for k in ("export_animations", "export_morph", "export_apply"):
                        kwargs.pop(k, None)
                    bpy.ops.export_scene.gltf(**kwargs)
                if os.path.exists(out):
                    a["exported"] = True
                    a["size"] = os.path.getsize(out)
                else:
                    a["error"] = "書き出したのにファイルが無い: " + out
            except Exception as e:
                a["error"] = str(e)
            finally:
                if tmp is not None:
                    try:
                        dx12_swap_out(tmp, swap)
                        bpy.data.objects.remove(tmp, do_unlink=True)
                    except Exception as e:
                        report["warnings"].append("一時コピーの削除に失敗: " + str(e))
        report["assets"].append(a)
finally:
    # ★必ず元に戻す: 一時コレクション・選択・アクティブ
    if tmp_col is not None:
        try:
            bpy.data.collections.remove(tmp_col)
        except Exception as e:
            report["warnings"].append("一時コレクションの削除に失敗: " + str(e))
    deselect_all()
    for vl, sel, act in saved:
        for n in sel:
            o = bpy.data.objects.get(n)
            if o is not None:
                try:
                    o.select_set(True, view_layer=vl)
                except Exception:
                    pass
        if act is not None and bpy.data.objects.get(act) is not None:
            try:
                vl.objects.active = bpy.data.objects[act]
            except Exception:
                pass

print(json.dumps(report))
`.trim();
}

// ─── 本体 ───────────────────────────────────────────────────────────────────

export interface PlaceOptions {
  objects?: string[];
  assetDir?: string;
  group?: string;
  meshes?: boolean;
  prune?: boolean;
  dryRun?: boolean;
}
export interface PlaceDeps {
  engineCall: (method: string, params?: Record<string, unknown>) => Promise<any>;
  blenderExec: (code: string) => Promise<{ stdout: string; json?: unknown }>;
  assetsDir: string;
}

interface BlenderReport {
  blendName: string; assetDir: string; group: string; source: string;
  objects: { name: string; key: string; parent: string | null; loc: number[]; quat: number[]; scale: number[] }[];
  skipped: { name: string; type: string; reason: string }[];
  warnings: string[];
  assets: { key: string; meshKey: string; path: string; objects: string[]; exported: boolean; size?: number; error?: string; bakedMaterial?: string }[];
  error?: string;
}

/** .gltf の tmp 名の画像を意味のある名前へ(テクスチャは <asset>/textures/ の中。uri はフォルダ付き) */
async function renameTmpImages(gltfAbs: string, base: string, warnings: string[]): Promise<number> {
  try {
    const doc = JSON.parse(await fs.promises.readFile(gltfAbs, "utf8"));
    const dir = path.dirname(gltfAbs);
    // uri は "textures/tmpabc.jpg" のようにフォルダ付き。planImageRenames は名前部分だけを見るので分けて渡す。
    const shadow = { images: (doc.images ?? []).map((im: any) => ({ ...im, uri: im.uri && !String(im.uri).startsWith("data:") ? path.posix.basename(decodeURIComponent(im.uri)) : im.uri })) };
    const plan = planImageRenames(shadow, base);
    let n = 0;
    for (const r of plan) {
      const sub = path.posix.dirname(decodeURIComponent(doc.images[r.index].uri));
      const rel = (name: string) => (sub === "." ? name : `${sub}/${name}`);
      try {
        await fs.promises.rename(path.join(dir, rel(r.from)), path.join(dir, rel(r.to)));
        doc.images[r.index].uri = rel(r.to);
        n++;
      } catch (e) { warnings.push(`画像の改名に失敗: ${r.from} → ${r.to}: ${(e as Error).message}`); }
    }
    if (n) await fs.promises.writeFile(gltfAbs, JSON.stringify(doc), "utf8");
    return n;
  } catch (e) { warnings.push(`${path.basename(gltfAbs)} の画像名の整理に失敗: ${(e as Error).message}`); return 0; }
}

function entityIdOf(r: any): number {
  const id = r?.entityId ?? r?.entity?.entityId ?? r?.id;
  if (typeof id !== "number") throw new Error(`エンジンの応答に entityId が無い: ${JSON.stringify(r)?.slice(0, 200)}`);
  return id;
}

/** エンティティの現在値(get_entity の形に依存する部分をここに閉じ込める) */
function readEntity(ent: any): Pick<ExistingChild, "modelPath" | "position" | "quaternion" | "scale"> {
  const t = ent?.transform ?? {};
  return {
    modelPath: ent?.meshRenderer?.modelPath ?? ent?.modelPath,
    position: t.position,
    quaternion: t.quaternion ?? (Array.isArray(t.rotation) ? engineEulerToQuat(t.rotation) : undefined),
    scale: t.scale,
  };
}

export async function placeFromBlender(opts: PlaceOptions, deps: PlaceDeps): Promise<Record<string, unknown>> {
  const { engineCall, blenderExec, assetsDir } = deps;
  const meshes = opts.meshes !== false;
  const dryRun = opts.dryRun === true;
  const warnings: string[] = [];

  // ① Blender 側(execute 1 回)。dryRun / meshes:false は書き出さない
  const code = buildPlaceScript({
    objects: opts.objects ?? [], assetsRoot: assetsDir, assetDir: opts.assetDir ?? "", group: opts.group ?? "",
    exportMeshes: meshes && !dryRun,
  });
  const { json, stdout } = await blenderExec(code);
  if (!json) throw new Error(`Blender の結果を読めなかった（stdout: ${stdout.slice(0, 400)}）`);
  const rep = json as BlenderReport;
  if (rep.error) throw new Error(rep.error);
  warnings.push(...rep.warnings);
  const skipped = [...rep.skipped];

  // ② アセットの後始末(画像名)と、使えるアセットの判定
  const assetByKey = new Map(rep.assets.map((a) => [a.key, a]));
  const unusable = new Map<string, string>();   // key → 理由
  for (const a of rep.assets) {
    if (meshes && !dryRun) {
      if (a.error || !a.exported) { unusable.set(a.key, `書き出しに失敗: ${a.error ?? "不明"}`); continue; }
      await renameTmpImages(path.join(assetsDir, a.path), a.key, warnings);
    } else if (!meshes && !fs.existsSync(path.join(assetsDir, a.path))) {
      unusable.set(a.key, `アセットが無い(meshes:false は書き出さない): ${a.path}`);
    }
  }
  const objs: PlaceObject[] = [];
  for (const o of rep.objects) {
    const a = assetByKey.get(o.key)!;
    const bad = unusable.get(o.key);
    if (bad) { skipped.push({ name: o.name, type: "MESH", reason: bad }); continue; }
    const t = blenderToEngine(o);
    objs.push({ name: o.name, modelPath: a.path, ...t });
  }
  if (rep.objects.some((o) => o.parent)) warnings.push("親子は平らにした(ワールド変換で group の直下に置く)。Blender の親を動かしたら子も再実行で追従する");

  // ③ エンジン側の既存状態を読む(ここまでは何も書かない)
  const group = rep.group;
  let groupId: number | null = null;
  const found = await engineCall("find_entity", { name: group }).catch(() => null);
  if (found && typeof found.entityId === "number") groupId = found.entityId;
  const existing: ExistingChild[] = [];
  if (groupId !== null) {
    const h = await engineCall("get_hierarchy", { root: groupId, maxDepth: 1 });
    const node = (h?.roots ?? [])[0];
    for (const c of node?.children ?? []) {
      const ent = await engineCall("get_entity", { entity: c.entityId }).catch(() => null);
      existing.push({ entityId: c.entityId, name: c.name, ...readEntity(ent) });
    }
  }
  const plan = planPlacement(objs, existing, { prune: opts.prune === true });
  const assetsOut = rep.assets.filter((a) => !unusable.has(a.key)).map((a) => ({ key: a.key, path: a.path, objects: a.objects, ...(a.size !== undefined ? { size: a.size } : {}), ...(a.bakedMaterial ? { bakedMaterial: a.bakedMaterial } : {}) }));
  for (const d of plan.duplicates) warnings.push(`group 配下に同名の子が重複: ${d.name}(entityId ${d.entityId})。prune:true で消せる`);

  const base = { group, assetDir: rep.assetDir, assets: assetsOut, skipped, warnings };
  if (dryRun) {
    return {
      dryRun: true, ...base, blendName: rep.blendName,
      groupExists: groupId !== null, willCreateGroup: groupId === null,
      spawn: plan.spawn.map((o) => ({ name: o.name, path: o.modelPath })),
      update: plan.update.map((u) => ({ name: u.obj.name, entityId: u.entityId, modelChanged: u.modelChanged, transformChanged: u.transformChanged })),
      prune: plan.prune,
      willExport: meshes ? assetsOut.map((a) => a.path) : [],
      next: "dryRun は何も変えていない。問題なければ dryRun を外して撃つ",
    };
  }

  // ④ 書く。トランザクションで 1 回の Undo に畳む(使えなければ外して警告)
  let tx = false;
  try { await engineCall("transaction_begin", { label: `Blender から配置(${group})` }); tx = true; }
  catch (e) {
    if (/MODE|Playing/i.test(String((e as Error).message))) throw e;
    warnings.push(`トランザクションを開けなかった(Undo は個別になる): ${(e as Error).message}`);
  }
  const spawned: { name: string; entityId: number; path: string }[] = [];
  const updated: { name: string; entityId: number; modelChanged: boolean; transformChanged: boolean }[] = [];
  const pruned: { name: string; entityId: number; reason: string }[] = [];
  try {
    // 書き出し直したアセットが読み込み済みなら古いメッシュが残る → 読み直す(Undo の対象外)
    if (meshes && assetsOut.length) {
      const rl = await engineCall("reload_assets", { path: rep.assetDir, force: true }).catch((e) => { warnings.push(`reload_assets に失敗: ${(e as Error).message}`); return null; });
      if (rl && Array.isArray(rl.warnings)) warnings.push(...rl.warnings);
    }
    if (groupId === null) {
      // ★group のルートは原点・無回転・スケール 1(set_parent はワールドを保たないので、単位変換でないと子がワープする)
      groupId = entityIdOf(await engineCall("create_entity", { type: "empty", name: group, position: [0, 0, 0] }));
    }
    const setT = (entity: number, o: PlaceObject) =>
      engineCall("set_transform", { entity, position: o.position, quaternion: o.quaternion, scale: o.scale });

    for (const o of plan.spawn) {
      const id = entityIdOf(await engineCall("spawn_model", { path: o.modelPath, name: o.name }));
      await engineCall("set_parent", { entity: id, parent: groupId });
      await setT(id, o);
      spawned.push({ name: o.name, entityId: id, path: o.modelPath });
    }
    for (const u of plan.update) {
      let id = u.entityId;
      if (u.modelChanged) {
        // ★meshRenderer は set_component で差し替えられない仕様のことがある → 作り直し(同名・同じ親)
        await engineCall("delete_entity", { entity: id });
        id = entityIdOf(await engineCall("spawn_model", { path: u.obj.modelPath, name: u.obj.name }));
        await engineCall("set_parent", { entity: id, parent: groupId });
        await setT(id, u.obj);
      } else if (u.transformChanged) {
        await setT(id, u.obj);
      }
      updated.push({ name: u.obj.name, entityId: id, modelChanged: u.modelChanged, transformChanged: u.transformChanged || u.modelChanged });
    }
    for (const p of plan.prune) {
      await engineCall("delete_entity", { entity: p.entityId });
      pruned.push({ name: p.name, entityId: p.entityId, reason: p.reason });
    }
    if (tx) { await engineCall("transaction_commit", {}); tx = false; }
  } catch (e) {
    if (tx) { try { await engineCall("transaction_rollback", {}); } catch { /* 巻き戻せなくても元のエラーを返す */ } }
    throw e;
  }

  return {
    ...base, blendName: rep.blendName, groupId, spawned, updated, pruned,
    transaction: tx === false ? "committed(Undo 1 回で戻る。ただし書き出したファイルと reload_assets は戻らない)" : "none",
    next: "dx12_validate_layout で埋まり/ちらつきを確認、dx12_screenshot_from で見た目を確認。"
      + "Blender で動かしたら meshes:false で撃ち直すと Transform だけ更新する(速い)。group を動かすと全体が動く",
  };
}
