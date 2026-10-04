/**
 * Blender のオブジェクトに高品質 PBR 素材を貼る(dx12_blender_material_apply)/ エンジン用のテクスチャへ焼く(dx12_material_bake)の本体。
 * 素材の取得・ORM 詰めは materialLibrary.ts。ここは Blender 側スクリプト(純粋: 文字列を返すだけ)と純関数と orchestration。
 *
 * ★設計の要点(2026-10-05)
 *   ・エンジンは KHR_texture_transform を読まない。Mapping ノードで縮尺を合わせても書き出しで失われる。
 *     だから【頂点の UV そのもの】を 1/scaleM で拡縮した専用 UV マップ dx12_uv を作り、それをアクティブにする。元の UV マップは残す。
 *   ・元の UV が「実寸比で一様」(辺ごとの UV 長/実長の比が 1.25 倍以内)なら元 UV を一様拡縮、そうでなければ箱投影(1UV=1m)で作り直す。
 *     プリミティブの既定 UV は面ごとに 0..1 なので、非一様スケールの板(2m×0.2m×1m)に貼ると模様が面ごとに伸び縮みする。そこで自動的に箱投影に切り替える。
 *   ・occlusion は Blender の glTF エクスポータが認識する「glTF Material Output」ノードグループ(Occlusion 入力)へ orm の R をつなぐ。
 *     同じ orm 画像を MR と共有するので書き出しで 1 枚の ORM になる。
 *   ・antiTile / 箱投影ノード / 風化 / Bump はノードのままではエンジンへ持っていけない(書き出しはノードを評価しない)→ needsBake。
 *   ・焼き(bake)は元のマテリアルを触らない: マテリアルの【複製】にだけ焼き先ノードを足して焼き、結果は <元の名前>_dx12 に作る。
 *     オブジェクトにはカスタムプロパティ dx12_baked_material を書くだけ。書き出し(blenderPlace / buildExportScript)が一時コピーにだけ差し替える。
 *   ・Blender に流すスクリプトに SystemExit / sys.exit を入れない(公式アドオンは except Exception でしか受けない)。
 */
import path from "node:path";
import { BAKED_SWAP_PY } from "./blenderBridge.ts";
import {
  ensureMaterial, resolveMaterial, materialsRoot, MATERIAL_RESOLUTIONS,
  type MaterialHit, type MatRes, type EnsuredMaterial, type MaterialSource,
} from "./materialLibrary.ts";

// ─── 純関数 ─────────────────────────────────────────────────────────────────

/** 模様 1 枚の実寸 m。scaleM 指定 > 素材の実寸(短辺でなく幅 w) > 2m。0 以下は無効 */
export function resolveScaleM(scaleM: number | undefined, sizeM: [number, number] | null | undefined): { scaleM: number; from: "arg" | "material" | "default"; aspect: number } {
  if (typeof scaleM === "number" && scaleM > 0) return { scaleM, from: "arg", aspect: 1 };
  // 素材が正方形でない実寸(ambientCG の 2.2m × 1.1m など)なら、V 方向は高さぶんの実寸で貼る(aspect = 高さ/幅)
  if (sizeM && sizeM[0] > 0) return { scaleM: sizeM[0], from: "material", aspect: sizeM[1] > 0 && Math.abs(sizeM[1] / sizeM[0] - 1) > 0.01 ? sizeM[1] / sizeM[0] : 1 };
  return { scaleM: 2, from: "default", aspect: 1 };
}
/** UV を掛ける倍率(1UV=1m の UV に掛けると、模様 1 枚が scaleM m になる) */
export function uvScaleFactor(scaleM: number): number { return 1 / scaleM; }
/**
 * 元 UV の「UV 長/実長」の中央値 medianRatio から、模様 1 枚を scaleM m にするための倍率。
 * (1m あたり 1 UV の UV なら medianRatio=1 で 1/scaleM。0..1 を面に貼っただけの 2m の面なら 0.5 → 2/scaleM)
 */
export function uvScaleFromRatio(medianRatio: number, scaleM: number): number { return uvScaleFactor(scaleM) / medianRatio; }
/** 元 UV が一様か(辺比の最大/最小)。閾値 1.25 */
export function isUniformUv(ratios: number[], tol = 1.25): boolean {
  const r = ratios.filter((x) => x > 0);
  if (r.length === 0 || r.length < ratios.length) return false;
  return Math.max(...r) / Math.min(...r) <= tol;
}
/** 1m の面に何回模様が繰り返されるか(scaleM が 1.7 なら 0.588) */
export function repeatsPerMeter(scaleM: number): number { return 1 / scaleM; }

/** 2 の冪に丸める(対数で最も近い方)。1 未満は 1 */
export function roundPow2(x: number): number { return x <= 1 ? 1 : 2 ** Math.round(Math.log2(x)); }
/**
 * 焼き解像度: 表面積(m²)から。raw = sqrt(area) × texelDensity を 2 の冪に丸め、[minRes, maxRes] で挟む。
 * (UV 1 枚に全面を詰めたときの 1m あたりの px 数が texelDensity。実際の UV の充填率ぶんは測って結果に出す)
 */
export function bakeResolution(areaM2: number, texelDensity: number, minRes: number, maxRes: number): { raw: number; resolution: number; clamped: "min" | "max" | null } {
  const raw = Math.sqrt(Math.max(areaM2, 0)) * texelDensity;
  const lo = roundPow2(minRes), hi = roundPow2(maxRes);
  const p = roundPow2(raw);
  if (p < lo) return { raw, resolution: lo, clamped: "min" };
  if (p > hi) return { raw, resolution: hi, clamped: "max" };
  return { raw, resolution: p, clamped: null };
}

/**
 * 既定のマテリアル名。★オプションが違うのに同じ名前だと、あとから貼った物が先に貼った物のノードを作り直してしまう
 * (同名は置き換える仕様)ので、ノードの作りを変えるオプションは名前に入れる。
 */
export function defaultMaterialName(id: string, res: string, o: { antiTile: boolean; projection: string; edgeWear: number; dirt: number; bump: boolean }): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const parts = [o.antiTile ? "at" : "", o.projection === "box" ? "box" : "", o.edgeWear > 0 ? `e${f(o.edgeWear)}` : "", o.dirt > 0 ? `d${f(o.dirt)}` : "", o.bump ? "bump" : ""].filter(Boolean);
  return `dx12_${id}_${res}${parts.length ? "_" + parts.join("_") : ""}`;
}

export interface ApplyOptions {
  objects?: string[];
  source?: "all" | MaterialSource;
  id?: string;
  query?: string;
  resolution?: MatRes;
  projection?: "uv" | "box";
  scaleM?: number;
  antiTile?: boolean;
  displacement?: "none" | "bump";
  weathering?: { edgeWear?: number; dirt?: number };
  materialName?: string;
}

/** ノードのままではエンジンへ持っていけない理由(空なら書き出してそのまま使える) */
export function bakeReasons(o: { projection: string; antiTile: boolean; displacement: string; hasHeight: boolean; edgeWear: number; dirt: number }): string[] {
  const r: string[] = [];
  if (o.antiTile) r.push("antiTile: Voronoi で UV をセルごとにずらすノードは書き出しで評価されない(エンジンでは繰り返しが目立つまま)");
  if (o.projection === "box") r.push("projection:box: 箱投影は Image Texture ノードの機能で、glTF には UV しか出ない(dx12_uv は面ごとの箱投影 UV で代用)");
  if (o.edgeWear > 0 || o.dirt > 0) r.push("weathering: 角の擦れ(Bevel)と窪みの汚れ(AO ノード)は色・粗さをノードで変えているだけ。書き出しでは元の素材の色のまま");
  if (o.displacement === "bump" && o.hasHeight) r.push("displacement:bump: Bump ノードを挟むと glTF エクスポータが height 画像を法線マップとして書き出してしまう(実測)。焼くと法線に畳み込まれる");
  return r;
}

// ─── Blender 側スクリプト ───────────────────────────────────────────────────

const lit = (v: unknown) => JSON.stringify(JSON.stringify(v));

export interface ApplyScriptParams {
  objects: string[];
  materialName: string;
  scaleM: number;
  aspect?: number;           // V 方向の実寸 = scaleM × aspect(既定 1)
  projection: "uv" | "box";
  antiTile: boolean;
  displacement: "none" | "bump";
  edgeWear: number;
  dirt: number;
  imageBase: string;
  maps: { color?: string; orm: string; normal_gl?: string; height?: string; emission?: string; opacity?: string };
  meta: Record<string, unknown>;
}

export function buildApplyScript(p: ApplyScriptParams): string {
  return `
import bpy, bmesh, json, math, traceback
from mathutils import Vector
${BAKED_SWAP_PY}
P = json.loads(${lit({ ...p, maps: Object.fromEntries(Object.entries(p.maps).map(([k, v]) => [k, v && String(v).replace(/\\/g, "/")])) })})
UVN = "dx12_uv"
SCALE_M = float(P["scaleM"])
S_TILE = 1.0 / SCALE_M
ASPECT = float(P.get("aspect") or 1.0)
S_TILE_V = S_TILE / ASPECT
BOX = P["projection"] == "box"
report = {"objects": [], "warnings": []}

def pick_targets():
    bpy.context.view_layer.update()   # ★matrix_world を最新に(直前にスケールを変えた直後でも実寸が合う)
    out = []
    if P["objects"]:
        for n in P["objects"]:
            ob = bpy.data.objects.get(n)
            if ob is None:
                report["warnings"].append("オブジェクトが見つからない: " + n)
            elif ob.type != 'MESH':
                report["warnings"].append(n + " は MESH ではない(" + ob.type + ")ので貼らない")
            else:
                out.append(ob)
    else:
        out = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    seen = set()
    return [o for o in sorted(out, key=lambda o: o.name) if not (o.name in seen or seen.add(o.name))]

# ─── UV: 専用 UV マップ dx12_uv を実寸で作る(エンジンは KHR_texture_transform を読まない) ───
def prep_uv(ob):
    me = ob.data
    s = ob.matrix_world.to_scale()
    sc = Vector((abs(s.x) or 1e-9, abs(s.y) or 1e-9, abs(s.z) or 1e-9))
    names = [l.name for l in me.uv_layers]
    src = me.get("dx12_uv_src")
    if not src or src not in names:
        act = me.uv_layers.active.name if me.uv_layers.active else None
        cands = [n for n in names if n != UVN]
        src = act if (act and act != UVN) else (cands[0] if cands else "")
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_src = bm.loops.layers.uv.get(src) if src else None
    uv_dst = bm.loops.layers.uv.get(UVN) or bm.loops.layers.uv.new(UVN)
    info = {"uvSource": None, "srcUv": src or None}
    ratios = []
    if uv_src is not None and not BOX:
        for f in bm.faces:
            for l in f.loops:
                l2 = l.link_loop_next
                d = l2.vert.co - l.vert.co
                wl = Vector((d.x * sc.x, d.y * sc.y, d.z * sc.z)).length
                if wl < 1e-6:
                    continue
                ratios.append((l2[uv_src].uv - l[uv_src].uv).length / wl)
    uniform = bool(ratios) and min(ratios) > 1e-9 and (max(ratios) / min(ratios)) <= 1.25
    if uniform:
        med = sorted(ratios)[len(ratios) // 2]
        k = S_TILE / med
        for f in bm.faces:
            for l in f.loops:
                uu = l[uv_src].uv
                l[uv_dst].uv = (uu.x * k, uu.y * k / ASPECT)
        info["uvSource"] = "original"
        info["uvScale"] = k
        info["ratioSpread"] = max(ratios) / min(ratios)
    else:
        for f in bm.faces:
            n = f.normal
            wn = (abs(n.x / sc.x), abs(n.y / sc.y), abs(n.z / sc.z))
            ax = wn.index(max(wn))
            neg = (n.x, n.y, n.z)[ax] < 0
            for l in f.loops:
                c = l.vert.co
                x, y, z = c.x * sc.x, c.y * sc.y, c.z * sc.z
                if ax == 2:
                    u, v = x, y
                elif ax == 0:
                    u, v = y, z
                else:
                    u, v = x, z
                if neg:
                    u = -u
                l[uv_dst].uv = (u * S_TILE, v * S_TILE_V)
        info["uvSource"] = "box" if (BOX or uv_src is None) else "box(auto)"
        if ratios:
            info["ratioSpread"] = max(ratios) / max(min(ratios), 1e-9)
            info["why"] = "元の UV は実寸比が一様でない(辺比の最大/最小 %.1f 倍 > 1.25)ので箱投影で作り直した" % info["ratioSpread"]
        elif uv_src is None:
            info["why"] = "元の UV が無いので箱投影(1UV=1m)で作った"
    bm.to_mesh(me)
    bm.free()
    layer = me.uv_layers.get(UVN)
    me.uv_layers.active = layer
    layer.active_render = True
    me["dx12_uv_src"] = src or ""
    # ★書き出しの texCoord は「メッシュ内の並び順」。エンジンは TEXCOORD_0 しか読まないので dx12_uv を先頭にする(他の UV は名前も中身も残る)
    if dx12_uv_to_front(me, UVN):
        info["movedToFront"] = True
    me.update()
    return info

# ─── マテリアル ───
def build_material():
    mat = bpy.data.materials.get(P["materialName"])
    if mat is None:
        mat = bpy.data.materials.new(P["materialName"])
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new("ShaderNodeOutputMaterial"); out.location = (1500, 0)
    bsdf = N.new("ShaderNodeBsdfPrincipled"); bsdf.location = (1200, 0)
    L.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    maps = P["maps"]
    notes = {}

    def load(path, kind, noncolor):
        im = bpy.data.images.load(path, check_existing=True)
        im.colorspace_settings.name = 'Non-Color' if noncolor else 'sRGB'
        im.name = P["imageBase"] + "_" + kind
        return im

    # 座標
    if BOX:
        tc = N.new("ShaderNodeTexCoord"); tc.location = (-1700, 0)
        mp0 = N.new("ShaderNodeMapping"); mp0.location = (-1500, 0)
        osc = P.get("objScale") or [1, 1, 1]
        mp0.inputs["Scale"].default_value = (osc[0] * S_TILE, osc[1] * S_TILE, osc[2] * S_TILE)
        L.new(tc.outputs["Object"], mp0.inputs["Vector"])
        vec = mp0.outputs["Vector"]
    else:
        uvn = N.new("ShaderNodeUVMap"); uvn.uv_map = UVN; uvn.location = (-1500, 0)
        vec = uvn.outputs["UV"]

    # antiTile: Voronoi のセルごとに UV をずらす/少し回す。2 層(A・B)を、A のセルの縁で B に寄せて継ぎ目を隠す
    vecA = vecB = fac_out = None
    if P["antiTile"]:
        def cells(scale, off, x):
            vin = vec
            if off:
                ad = N.new("ShaderNodeVectorMath"); ad.operation = 'ADD'; ad.location = (x - 250, 400)
                ad.inputs[1].default_value = (off, off * 0.37, off * 0.61)
                L.new(vec, ad.inputs[0]); vin = ad.outputs[0]
            v1 = N.new("ShaderNodeTexVoronoi"); v1.voronoi_dimensions = '3D' if BOX else '2D'; v1.feature = 'F1'; v1.location = (x, 500)
            v1.inputs["Scale"].default_value = scale
            L.new(vin, v1.inputs["Vector"])
            v2 = N.new("ShaderNodeTexVoronoi"); v2.voronoi_dimensions = v1.voronoi_dimensions; v2.feature = 'DISTANCE_TO_EDGE'; v2.location = (x, 250)
            v2.inputs["Scale"].default_value = scale
            L.new(vin, v2.inputs["Vector"])
            # セルごとの乱数色 → 位置(0..8)と回転(±0.25rad)
            ml = N.new("ShaderNodeVectorMath"); ml.operation = 'MULTIPLY'; ml.location = (x + 200, 500)
            ml.inputs[1].default_value = (8.0, 8.0, 8.0)
            L.new(v1.outputs["Color"], ml.inputs[0])
            sp = N.new("ShaderNodeSeparateColor"); sp.location = (x + 200, 350)
            L.new(v1.outputs["Color"], sp.inputs["Color"])
            m1 = N.new("ShaderNodeMath"); m1.operation = 'SUBTRACT'; m1.location = (x + 380, 350); m1.inputs[1].default_value = 0.5
            L.new(sp.outputs["Blue"], m1.inputs[0])
            m2 = N.new("ShaderNodeMath"); m2.operation = 'MULTIPLY'; m2.location = (x + 540, 350); m2.inputs[1].default_value = 0.5
            L.new(m1.outputs[0], m2.inputs[0])
            cx = N.new("ShaderNodeCombineXYZ"); cx.location = (x + 700, 350)
            L.new(m2.outputs[0], cx.inputs["Z"])
            mp = N.new("ShaderNodeMapping"); mp.vector_type = 'POINT'; mp.location = (x + 880, 450)
            L.new(vec, mp.inputs["Vector"])
            L.new(ml.outputs[0], mp.inputs["Location"])
            L.new(cx.outputs[0], mp.inputs["Rotation"])
            return mp.outputs["Vector"], v2.outputs["Distance"]
        vecA, edgeA = cells(0.4, 0.0, -1300)
        vecB, _e = cells(0.55, 13.7, -1300 + 0)
        mr = N.new("ShaderNodeMapRange"); mr.location = (-300, 600)
        mr.inputs["From Min"].default_value = 0.0; mr.inputs["From Max"].default_value = 0.1
        mr.inputs["To Min"].default_value = 1.0; mr.inputs["To Max"].default_value = 0.0
        mr.clamp = True
        L.new(edgeA, mr.inputs["Value"])
        fac_out = mr.outputs["Result"]

    def tex_node(im, v, y):
        n = N.new("ShaderNodeTexImage"); n.image = im; n.interpolation = 'Linear'; n.location = (-700, y)
        if BOX:
            n.projection = 'BOX'; n.projection_blend = 0.2
        L.new(v, n.inputs["Vector"])
        return n

    def sample(im, y):
        if not P["antiTile"]:
            return tex_node(im, vec, y).outputs["Color"]
        a = tex_node(im, vecA, y); b = tex_node(im, vecB, y - 40)
        mx = N.new("ShaderNodeMix"); mx.data_type = 'RGBA'; mx.blend_type = 'MIX'; mx.location = (-420, y)
        L.new(fac_out, mx.inputs[0])
        rg = [s for s in mx.inputs if s.enabled and s.type == 'RGBA']
        L.new(a.outputs["Color"], rg[0]); L.new(b.outputs["Color"], rg[1])
        return [o for o in mx.outputs if o.enabled and o.type == 'RGBA'][0]

    # color / orm
    col = sample(load(maps["color"], "color", False), 400) if maps.get("color") else None
    orm = sample(load(maps["orm"], "orm", True), 100)
    sep = N.new("ShaderNodeSeparateColor"); sep.location = (-200, 100)
    L.new(orm, sep.inputs["Color"])
    rough = sep.outputs["Green"]
    metal = sep.outputs["Blue"]

    # 風化(ノードのまま。焼かないとエンジンへは行かない)
    def mixrgba(a, b, fac, blend='MIX', x=0, y=0):
        mx = N.new("ShaderNodeMix"); mx.data_type = 'RGBA'; mx.blend_type = blend; mx.location = (x, y)
        L.new(fac, mx.inputs[0])
        rg = [s for s in mx.inputs if s.enabled and s.type == 'RGBA']
        if isinstance(a, tuple): rg[0].default_value = a
        else: L.new(a, rg[0])
        if isinstance(b, tuple): rg[1].default_value = b
        else: L.new(b, rg[1])
        return [o for o in mx.outputs if o.enabled and o.type == 'RGBA'][0]
    def mixfloat(a, b, fac, x=0, y=0):
        mx = N.new("ShaderNodeMix"); mx.data_type = 'FLOAT'; mx.location = (x, y)
        L.new(fac, mx.inputs[0])
        fl = [s for s in mx.inputs if s.enabled and s.type == 'VALUE' and s.name in ("A", "B")]
        if isinstance(a, float): fl[0].default_value = a
        else: L.new(a, fl[0])
        if isinstance(b, float): fl[1].default_value = b
        else: L.new(b, fl[1])
        return [o for o in mx.outputs if o.enabled and o.type == 'VALUE'][0]
    def math(op, a, b=None, x=0, y=0, clamp=False):
        m = N.new("ShaderNodeMath"); m.operation = op; m.location = (x, y); m.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, float): m.inputs[i].default_value = v
            else: L.new(v, m.inputs[i])
        return m.outputs[0]

    if P["edgeWear"] > 0:
        bev = N.new("ShaderNodeBevel"); bev.location = (-200, -300); bev.inputs["Radius"].default_value = 0.012
        geo = N.new("ShaderNodeNewGeometry"); geo.location = (-200, -450)
        dt = N.new("ShaderNodeVectorMath"); dt.operation = 'DOT_PRODUCT'; dt.location = (0, -350)
        L.new(bev.outputs["Normal"], dt.inputs[0]); L.new(geo.outputs["Normal"], dt.inputs[1])
        e1 = N.new("ShaderNodeMapRange"); e1.location = (180, -350); e1.clamp = True
        e1.inputs["From Min"].default_value = 0.6; e1.inputs["From Max"].default_value = 0.995
        e1.inputs["To Min"].default_value = 1.0; e1.inputs["To Max"].default_value = 0.0
        L.new(dt.outputs["Value"], e1.inputs["Value"])
        nz = N.new("ShaderNodeTexNoise"); nz.location = (0, -600); nz.inputs["Scale"].default_value = 14.0
        tcn = N.new("ShaderNodeTexCoord"); tcn.location = (-200, -650)
        L.new(tcn.outputs["Object"], nz.inputs["Vector"])
        e2 = N.new("ShaderNodeMapRange"); e2.location = (180, -600); e2.clamp = True
        e2.inputs["From Min"].default_value = 0.35; e2.inputs["From Max"].default_value = 0.65
        L.new(nz.outputs["Fac"], e2.inputs["Value"])
        e3 = math('MULTIPLY', e1.outputs["Result"], e2.outputs["Result"], 360, -450)
        me_ = math('MULTIPLY', e3, float(P["edgeWear"]), 520, -450, clamp=True)
        if col is not None:
            col = mixrgba(col, (0.78, 0.74, 0.68, 1.0), me_, 'MIX', 700, 400)
        rough = mixfloat(rough, math('MULTIPLY', rough, 0.55, 700, 0), me_, 860, 50)
    if P["dirt"] > 0:
        ao = N.new("ShaderNodeAmbientOcclusion"); ao.location = (-200, -900)
        ao.inputs["Distance"].default_value = 0.4; ao.samples = 8
        try:
            ao.only_local = True
        except Exception:
            pass
        cav = math('SUBTRACT', 1.0, ao.outputs["AO"], 40, -900)
        d1 = N.new("ShaderNodeMapRange"); d1.location = (200, -900); d1.clamp = True
        d1.inputs["From Min"].default_value = 0.05; d1.inputs["From Max"].default_value = 0.8
        L.new(cav, d1.inputs["Value"])
        md = math('MULTIPLY', d1.outputs["Result"], float(P["dirt"]), 380, -900, clamp=True)
        if col is not None:
            col = mixrgba(col, (0.28, 0.22, 0.17, 1.0), md, 'MULTIPLY', 900, 400)
        rough = mixfloat(rough, 1.0, math('MULTIPLY', md, 0.7, 700, -900), 1000, 50)

    if col is not None:
        L.new(col, bsdf.inputs["Base Color"])
    L.new(rough, bsdf.inputs["Roughness"])
    L.new(metal, bsdf.inputs["Metallic"])

    # 法線(OpenGL) + bump
    nmap = None
    if maps.get("normal_gl"):
        nsock = sample(load(maps["normal_gl"], "normal", True), -250)
        nm = N.new("ShaderNodeNormalMap"); nm.space = 'TANGENT'; nm.uv_map = UVN; nm.location = (700, -250)
        L.new(nsock, nm.inputs["Color"])
        nmap = nm.outputs["Normal"]
    if P["displacement"] == "bump" and maps.get("height"):
        hsock = sample(load(maps["height"], "height", True), -550)
        bp = N.new("ShaderNodeBump"); bp.location = (950, -300)
        bp.inputs["Strength"].default_value = 0.4; bp.inputs["Distance"].default_value = 0.01
        L.new(hsock, bp.inputs["Height"])
        if nmap is not None: L.new(nmap, bp.inputs["Normal"])
        L.new(bp.outputs["Normal"], bsdf.inputs["Normal"])
        notes["bump"] = True
    elif nmap is not None:
        L.new(nmap, bsdf.inputs["Normal"])
    if maps.get("emission"):
        L.new(sample(load(maps["emission"], "emission", False), -800), bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0
    if maps.get("opacity"):
        L.new(sample(load(maps["opacity"], "opacity", True), -1000), bsdf.inputs["Alpha"])
        try:
            mat.blend_method = 'HASHED'
        except Exception:
            pass

    # glTF Material Output(Occlusion)。同じ orm 画像の R をつなぐ → 書き出しで MR と同じ 1 枚の ORM になる
    ng = None
    for g in bpy.data.node_groups:
        if g.name.lower().startswith("gltf material output") and any(i.name == "Occlusion" for i in g.interface.items_tree if getattr(i, "in_out", "") == 'INPUT'):
            ng = g
            break
    if ng is None:
        ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        ng.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    gn = N.new("ShaderNodeGroup"); gn.node_tree = ng; gn.location = (1200, -400); gn.label = "glTF Material Output"
    L.new(sep.outputs["Red"], gn.inputs["Occlusion"])

    for k, v in P["meta"].items():
        mat["dx12_" + k] = json.dumps(v) if isinstance(v, (dict, list)) else v
    mat["dx12_scaleM"] = SCALE_M
    mat["dx12_needs_bake"] = bool(P["antiTile"] or BOX or P["edgeWear"] > 0 or P["dirt"] > 0 or notes.get("bump"))
    return mat

def main():
    targets = pick_targets()
    if not targets:
        report["error"] = "貼る対象が無い(objects を渡すか、Blender で MESH を選択する)"
        return
    s0 = targets[0].matrix_world.to_scale()
    P["objScale"] = [abs(s0.x), abs(s0.y), abs(s0.z)]
    if BOX and any(max(abs(a - b) for a, b in zip(o.matrix_world.to_scale(), s0)) > 1e-4 for o in targets):
        report["warnings"].append("projection:box でオブジェクトごとのスケールが違う。ノードの箱投影は最初のオブジェクトのスケールで合わせた")
    mat = build_material()
    done_meshes = {}
    for ob in targets:
        me = ob.data
        prev = [s.material.name if s.material else None for s in ob.material_slots]
        if me.name in done_meshes:
            info = dict(done_meshes[me.name]); info["sharedMesh"] = True
        else:
            info = prep_uv(ob)
            done_meshes[me.name] = info
        me.materials.clear()
        me.materials.append(mat)
        try:
            me.polygons.foreach_set("material_index", [0] * len(me.polygons))
            me.update()
        except Exception:
            pass
        info.update({"name": ob.name, "mesh": me.name, "previousMaterials": prev, "tileM": SCALE_M, "repeatsPerMeter": S_TILE, "repeatsPerMeterV": S_TILE_V,
                     "uvLayers": [l.name for l in me.uv_layers], "activeUv": me.uv_layers.active.name if me.uv_layers.active else None})
        report["objects"].append(info)
    report["material"] = mat.name
    report["needsBake"] = bool(mat.get("dx12_needs_bake"))

try:
    main()
except Exception as e:
    report["error"] = str(e)
    report["trace"] = traceback.format_exc()[-1800:]
print(json.dumps(report))
`.trim();
}

export interface BakeScriptParams {
  objects: string[];
  texelDensity: number;
  maxRes: number;
  minRes: number;
  samples: number;
  maps: string[];            // basecolor / roughness / metallic / normal / ao / emission
  device: "auto" | "cpu";
  fallbackDir: string;       // 未保存の .blend の焼き先(絶対パス)
}

export function buildBakeScript(p: BakeScriptParams): string {
  return `
import bpy, bmesh, json, math, os, re, time, traceback
import numpy as np
from mathutils import Vector

P = json.loads(${lit({ ...p, fallbackDir: p.fallbackDir.replace(/\\/g, "/") })})
report = {"units": [], "warnings": [], "skipped": []}
scene = bpy.context.scene
T0 = time.time()
WANT = set(P["maps"])

def safe(s):
    t = re.sub(r"[^0-9A-Za-z_.-]", "_", s).strip(".")
    return t or "unnamed"

def pow2(x):
    return 1 if x <= 1 else 2 ** int(round(math.log2(x)))

def res_for(area):
    raw = math.sqrt(max(area, 0.0)) * P["texelDensity"]
    lo, hi = pow2(P["minRes"]), pow2(P["maxRes"])
    return raw, max(lo, min(hi, pow2(raw)))

# ─── 対象 ───
def pick_targets():
    bpy.context.view_layer.update()   # ★matrix_world を最新に(直前にスケールを変えた直後でも実寸が合う)
    out = []
    if P["objects"]:
        for n in P["objects"]:
            ob = bpy.data.objects.get(n)
            if ob is None:
                report["warnings"].append("オブジェクトが見つからない: " + n)
            else:
                out.append(ob)
    else:
        out = list(bpy.context.selected_objects)
        if not out:
            out = [o for o in bpy.context.view_layer.objects if o.type == 'MESH' and o.visible_get()]
    seen = set()
    res = []
    for o in sorted(out, key=lambda o: o.name):
        if o.name in seen:
            continue
        seen.add(o.name)
        if o.type != 'MESH':
            report["skipped"].append({"name": o.name, "reason": o.type + " は MESH ではない"})
        elif len(o.data.polygons) == 0:
            report["skipped"].append({"name": o.name, "reason": "面が 0 枚"})
        else:
            res.append(o)
    return res

def world_area(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    eo = ob.evaluated_get(dg)
    me = eo.to_mesh()
    me.transform(ob.matrix_world)
    a = sum(p.area for p in me.polygons)
    eo.to_mesh_clear()
    return a

def uv_area(ob, layer):
    me = ob.data
    a = 0.0
    for p in me.polygons:
        pts = [layer.data[i].uv for i in p.loop_indices]
        s = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
            s += x1 * y2 - x2 * y1
        a += abs(s) * 0.5
    return a

def uv_is_clean(me, layer):
    """0..1 に収まり、三角形が重ならない(64x64 で粗く塗って二重塗りを数える)。高ポリは疑って False"""
    if len(me.polygons) > 3000:
        return False
    G = 64
    grid = np.zeros((G, G), dtype=np.int32)
    me.calc_loop_triangles()
    for t in me.loop_triangles:
        pts = [layer.data[i].uv for i in t.loops]
        for q in pts:
            if q[0] < -1e-4 or q[0] > 1 + 1e-4 or q[1] < -1e-4 or q[1] > 1 + 1e-4:
                return False
        (x0, y0), (x1, y1), (x2, y2) = [(q[0] * G, q[1] * G) for q in pts]
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-9:
            continue
        xs = [x0, x1, x2]; ys = [y0, y1, y2]
        for gy in range(max(0, int(min(ys))), min(G, int(max(ys)) + 1)):
            for gx in range(max(0, int(min(xs))), min(G, int(max(xs)) + 1)):
                px, py = gx + 0.5, gy + 0.5
                a = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den
                b = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den
                c = 1 - a - b
                if a >= 0 and b >= 0 and c >= 0:
                    grid[gy, gx] += 1
    return int((grid > 1).sum()) == 0

# ─── Cycles / デバイス ───
saved_scene = {}
def setup_cycles():
    saved_scene["engine"] = scene.render.engine
    saved_scene["samples"] = scene.cycles.samples if hasattr(scene, "cycles") else None
    saved_scene["device"] = scene.cycles.device if hasattr(scene, "cycles") else None
    scene.render.engine = 'CYCLES'
    dev = "CPU"
    saved_scene["prefs"] = None
    if P["device"] != "cpu":
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            saved_scene["prefs"] = (prefs.compute_device_type, None)
            for t in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
                try:
                    prefs.compute_device_type = t
                except Exception:
                    continue
                try:
                    prefs.get_devices()
                except Exception:
                    pass
                ds = [d for d in prefs.devices if d.type == t]
                if ds:
                    saved_scene["devs"] = [(d, d.use) for d in prefs.devices]
                    for d in ds:
                        d.use = True
                    scene.cycles.device = 'GPU'
                    dev = "GPU:" + t
                    break
            else:
                prefs.compute_device_type = saved_scene["prefs"][0]
        except Exception as e:
            report["warnings"].append("GPU の設定に失敗(CPU で焼く): " + str(e))
    if dev == "CPU":
        scene.cycles.device = 'CPU'
    report["device"] = dev

def restore_cycles():
    try:
        scene.render.engine = saved_scene.get("engine", scene.render.engine)
        if saved_scene.get("samples") is not None:
            scene.cycles.samples = saved_scene["samples"]
        if saved_scene.get("device") is not None:
            scene.cycles.device = saved_scene["device"]
        for d, u in saved_scene.get("devs", []):
            d.use = u
        if saved_scene.get("prefs"):
            bpy.context.preferences.addons['cycles'].preferences.compute_device_type = saved_scene["prefs"][0]
    except Exception as e:
        report["warnings"].append("Cycles 設定の復元に失敗: " + str(e))

# ─── ノード補助 ───
def principled_of(nt):
    outn = None
    for n in nt.nodes:
        if n.type == 'OUTPUT_MATERIAL' and n.is_active_output:
            outn = n
    if outn is None:
        outn = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if outn is None:
        return None, None
    if outn.inputs['Surface'].links:
        f = outn.inputs['Surface'].links[0].from_node
        if f.type == 'BSDF_PRINCIPLED':
            return outn, f
    return outn, next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)

def pin_uv(nt, uv_name):
    """UV の指定が無い画像/法線ノードに、元のアクティブ UV を明示する(焼き中だけアクティブ UV が変わるため)"""
    if not uv_name:
        return
    for n in list(nt.nodes):
        if n.type == 'TEX_IMAGE' and not n.inputs['Vector'].links:
            u = nt.nodes.new("ShaderNodeUVMap"); u.uv_map = uv_name
            nt.links.new(u.outputs["UV"], n.inputs["Vector"])
        elif n.type == 'NORMAL_MAP' and not n.uv_map:
            n.uv_map = uv_name

def gltf_occlusion_source(nt):
    for n in nt.nodes:
        if n.type == 'GROUP' and n.node_tree and n.node_tree.name.lower().startswith("gltf material output"):
            s = n.inputs.get("Occlusion")
            if s is not None and s.links:
                return s.links[0].from_socket
    return None

def emit_pass(copies, getter):
    """各マテリアル複製の出力を Emission に差し替える(getter(nt, p) が (socket|None, default) を返す)"""
    ems = []
    for nt, outn, p in copies:
        sock, dflt = getter(nt, p)
        em = nt.nodes.new('ShaderNodeEmission')
        if sock is not None:
            nt.links.new(sock, em.inputs['Color'])
        else:
            v = dflt
            em.inputs['Color'].default_value = (v[0], v[1], v[2], 1.0) if hasattr(v, '__len__') else (v, v, v, 1.0)
        nt.links.new(em.outputs['Emission'], outn.inputs['Surface'])
        ems.append((nt, em))
    return ems

def clear_emit(ems, copies):
    for nt, em in ems:
        nt.nodes.remove(em)
    for nt, outn, p in copies:
        nt.links.new(p.outputs['BSDF'], outn.inputs['Surface'])

def sock_getter(name):
    def g(nt, p):
        s = p.inputs[name]
        if s.links:
            return s.links[0].from_socket, None
        return None, s.default_value
    return g

def has_stochastic(copies):
    return any(n.type in ('BEVEL', 'AMBIENT_OCCLUSION') for nt, o, p in copies for n in nt.nodes)

def read_gray(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)

# ─── 焼き 1 ユニット(同じメッシュ・同じマテリアル構成のオブジェクトはまとめる) ───
def bake_unit(ob, others, out_dir, used_names):
    me = ob.data
    u = {"objects": [o.name for o in [ob] + others], "mesh": me.name, "warnings": []}
    slots = [(i, s.material) for i, s in enumerate(ob.material_slots) if s.material is not None]
    if not slots:
        u["error"] = "マテリアルが無い(焼く物が無い)"
        report["skipped"].append({"name": ob.name, "reason": u["error"]})
        return None
    u["materials"] = [m.name for i, m in slots]
    base_name = slots[0][1].name
    if base_name.endswith("_dx12"):
        base_name = base_name[:-5]
    baked_name = base_name + "_dx12"
    if baked_name in used_names and used_names[baked_name] != me.name:
        baked_name = base_name + "_" + safe(ob.name) + "_dx12"
    used_names[baked_name] = me.name
    u["bakedMaterial"] = baked_name

    area = world_area(ob)
    raw, res = res_for(area)
    u.update({"areaM2": round(area, 6), "rawResolution": round(raw, 2), "resolution": res})

    # UV
    orig_active = me.uv_layers.active.name if me.uv_layers.active else None
    orig_render = next((l.name for l in me.uv_layers if l.active_render), None)
    layer = me.uv_layers.get("dx12_bake")
    u["uvSource"] = "existing"
    if layer is None:
        reuse = None
        for l in me.uv_layers:
            if l.name != "dx12_uv" and uv_is_clean(me, l):
                reuse = l
                break
        if reuse is not None and reuse.name != "dx12_bake":
            # 元の UV がそのまま使えるなら使う(dx12_bake という名前の複製にして元は残す)
            layer = me.uv_layers.new(name="dx12_bake")
            for i, d in enumerate(reuse.data):
                layer.data[i].uv = d.uv
            u["uvSource"] = "reused:" + reuse.name
        else:
            layer = me.uv_layers.new(name="dx12_bake")
            me.uv_layers.active = layer
            bpy.ops.object.select_all(action='DESELECT')
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            try:
                bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=min(0.02, 12.0 / res), margin_method='FRACTION', correct_aspect=True, scale_to_bounds=True)
            except TypeError:
                bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=min(0.02, 12.0 / res), correct_aspect=True, scale_to_bounds=True)
            bpy.ops.object.mode_set(mode='OBJECT')
            u["uvSource"] = "smart_project"
    me = ob.data                       # ★エディットモードを出入りすると古い参照は無効になる(読むと範囲外/ゴミ)。取り直す
    layer = me.uv_layers["dx12_bake"]
    me.uv_layers.active = layer
    layer.active_render = True
    uva = uv_area(ob, layer)
    u["uvCoverage"] = round(uva, 4)
    u["measuredTexelDensity"] = round(res * math.sqrt(uva / area), 2) if area > 0 and uva > 0 else None

    # マテリアル複製 + 焼き先ノード
    pin_name = orig_active if orig_active != "dx12_bake" else None
    saved_slots = []
    copies = []
    tmps = []
    targets_tex = []
    for s in ob.material_slots:
        saved_slots.append((s, s.material))
    try:
        for i, orig in slots:
            c = orig.copy()
            c.name = "__dx12_bake_tmp_" + safe(orig.name)
            c.use_nodes = True
            tmps.append(c)
            pin_uv(c.node_tree, pin_name)
            outn, p = principled_of(c.node_tree)
            if p is None:
                u["error"] = "Principled BSDF が無い(" + orig.name + ")。対応は Principled BSDF のみ"
                return u
            tn = c.node_tree.nodes.new('ShaderNodeTexImage'); tn.location = (-1200, -1200)
            targets_tex.append((c.node_tree, tn))
            copies.append((c.node_tree, outn, p))
            ob.material_slots[i].material = c
        occl_src = []
        for nt, outn, p in copies:
            occl_src.append(gltf_occlusion_source(nt))

        mp = max(4, res // 128)
        stoch = has_stochastic(copies)
        smp = P["samples"] if stoch else 1
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob

        def new_img(name, color, data):
            img = bpy.data.images.new(name, res, res, alpha=False, float_buffer=False, is_data=data)
            img.generated_color = color
            return img

        def bake(kind, img, samples, extra=None):
            for nt, tn in targets_tex:
                tn.image = img
                nt.nodes.active = tn
                for n in nt.nodes:
                    n.select = (n == tn)
            scene.cycles.samples = samples
            kw = dict(type=kind, margin=mp, margin_type='EXTEND', use_clear=True, target='IMAGE_TEXTURES', uv_layer="dx12_bake")
            if extra:
                kw.update(extra)
            try:
                bpy.ops.object.bake(**kw)
            except Exception as e:
                # GPU(OptiX/CUDA)が初期化できない等 → CPU でやり直す(1 回だけ)
                if scene.cycles.device == 'GPU':
                    report["warnings"].append("GPU で焼けなかった(" + repr(e)[:120] + ")→ CPU に切り替えた")
                    scene.cycles.device = 'CPU'
                    report["device"] = "CPU(GPU から切替)"
                    bpy.ops.object.bake(**kw)
                else:
                    raise

        passes = {}
        inter = []
        want_emit = [("basecolor", "Base Color", False), ("roughness", "Roughness", True), ("metallic", "Metallic", True)]
        for key, sockname, data in want_emit:
            if key not in WANT:
                continue
            img = new_img(baked_name + "_" + key + "_tmp", (0, 0, 0, 1), data)
            ems = emit_pass(copies, sock_getter(sockname))
            bake('EMIT', img, smp)
            clear_emit(ems, copies)
            passes[key] = img
            inter.append(img)
        if "emission" in WANT:
            def emg(nt, p):
                s = p.inputs["Emission Color"]
                return (s.links[0].from_socket, None) if s.links else (None, s.default_value)
            need = any(p.inputs["Emission Color"].links or (sum(p.inputs["Emission Color"].default_value[:3]) > 1e-4 and p.inputs["Emission Strength"].default_value > 0) for nt, o, p in copies)
            if need:
                img = new_img(baked_name + "_emission_tmp", (0, 0, 0, 1), False)
                ems = emit_pass(copies, emg)
                bake('EMIT', img, smp)
                clear_emit(ems, copies)
                passes["emission"] = img
                inter.append(img)
        if "normal" in WANT:
            img = new_img(baked_name + "_normal_tmp", (0.5, 0.5, 1.0, 1.0), True)
            bake('NORMAL', img, smp, dict(normal_space='TANGENT', normal_r='POS_X', normal_g='POS_Y', normal_b='POS_Z'))
            passes["normal"] = img
            inter.append(img)
        if "ao" in WANT:
            # 素材側の AO(glTF Material Output の Occlusion につながっているもの)
            if any(s is not None for s in occl_src):
                img = new_img(baked_name + "_matao_tmp", (1, 1, 1, 1), True)
                ems = []
                for (nt, outn, p), s in zip(copies, occl_src):
                    em = nt.nodes.new('ShaderNodeEmission')
                    if s is not None:
                        nt.links.new(s, em.inputs['Color'])
                    nt.links.new(em.outputs['Emission'], outn.inputs['Surface'])
                    ems.append((nt, em))
                bake('EMIT', img, 1)
                clear_emit(ems, copies)
                passes["matao"] = img
                inter.append(img)
            # 形による陰(自己遮蔽)。Cycles の AO ベイクはワールドの AO 距離を使う
            w = scene.world
            made_world = False
            if w is None:
                w = bpy.data.worlds.new("dx12_tmp_world")
                scene.world = w
                made_world = True
            old_dist = w.light_settings.distance
            w.light_settings.distance = 1.0
            try:
                img = new_img(baked_name + "_ao_tmp", (1, 1, 1, 1), True)
                bake('AO', img, max(P["samples"], 32))
                passes["ao"] = img
                inter.append(img)
            finally:
                w.light_settings.distance = old_dist
                if made_world:
                    scene.world = None
                    bpy.data.worlds.remove(w)
    finally:
        for s, m in saved_slots:
            s.material = m
        for c in tmps:
            bpy.data.materials.remove(c)
        me.uv_layers.active = me.uv_layers.get(orig_active) if orig_active and me.uv_layers.get(orig_active) else me.uv_layers.get("dx12_bake")
        for l in me.uv_layers:
            l.active_render = (l.name == orig_render) if orig_render else (l.name == me.uv_layers.active.name)

    # 保存 + ORM
    os.makedirs(out_dir, exist_ok=True)
    files = {}
    def save(img, key, data):
        path = os.path.join(out_dir, safe(baked_name) + "_" + key + ".png")
        img.filepath_raw = path
        img.file_format = 'PNG'
        img.save()
        files[key] = path.replace("\\\\", "/")
        return path
    stats = {}
    if "basecolor" in passes:
        save(passes["basecolor"], "basecolor", False)
    if "normal" in passes:
        save(passes["normal"], "normal", True)
    if "emission" in passes:
        save(passes["emission"], "emission", False)
    # ORM: R = AO(形の陰 × 素材の AO)/ G = roughness / B = metallic。無いものは AO=1 / roughness=1 / metallic=0
    out = np.ones((res, res, 4), dtype=np.float32)
    ao = np.ones((res, res), dtype=np.float32)
    if "ao" in passes:
        ao = ao * read_gray(passes["ao"])[..., 0]
    if "matao" in passes:
        ao = ao * read_gray(passes["matao"])[..., 0]
    out[..., 0] = ao
    out[..., 1] = read_gray(passes["roughness"])[..., 0] if "roughness" in passes else 1.0
    out[..., 2] = read_gray(passes["metallic"])[..., 0] if "metallic" in passes else 0.0
    out[..., 3] = 1.0
    orm = bpy.data.images.new(baked_name + "_orm_tmp", res, res, alpha=False, float_buffer=False, is_data=True)
    orm.pixels.foreach_set(out.ravel())
    save(orm, "orm", True)
    inter.append(orm)
    stats["orm"] = [float(out[..., i].mean()) for i in range(3)]
    stats["ormMin"] = [float(out[..., i].min()) for i in range(3)]
    stats["ormMax"] = [float(out[..., i].max()) for i in range(3)]
    for im in inter:
        bpy.data.images.remove(im)

    # 焼いたテクスチャだけを使うマテリアル <元の名前>_dx12
    mat = bpy.data.materials.get(baked_name)
    if mat is None:
        mat = bpy.data.materials.new(baked_name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out_n = N.new("ShaderNodeOutputMaterial"); out_n.location = (900, 0)
    bs = N.new("ShaderNodeBsdfPrincipled"); bs.location = (600, 0)
    L.new(bs.outputs["BSDF"], out_n.inputs["Surface"])
    uvn = N.new("ShaderNodeUVMap"); uvn.uv_map = "dx12_bake"; uvn.location = (-900, 0)
    def tex(key, non, y):
        im = bpy.data.images.load(files[key], check_existing=False)
        im.colorspace_settings.name = 'Non-Color' if non else 'sRGB'
        im.name = baked_name + "_" + key
        n = N.new("ShaderNodeTexImage"); n.image = im; n.location = (-600, y)
        L.new(uvn.outputs["UV"], n.inputs["Vector"])
        return n
    if "basecolor" in files:
        L.new(tex("basecolor", False, 300).outputs["Color"], bs.inputs["Base Color"])
    o = tex("orm", True, 0)
    sp = N.new("ShaderNodeSeparateColor"); sp.location = (-300, 0)
    L.new(o.outputs["Color"], sp.inputs["Color"])
    L.new(sp.outputs["Green"], bs.inputs["Roughness"])
    L.new(sp.outputs["Blue"], bs.inputs["Metallic"])
    if "normal" in files:
        nn = tex("normal", True, -300)
        nm = N.new("ShaderNodeNormalMap"); nm.space = 'TANGENT'; nm.uv_map = "dx12_bake"; nm.location = (300, -300)
        L.new(nn.outputs["Color"], nm.inputs["Color"])
        L.new(nm.outputs["Normal"], bs.inputs["Normal"])
    if "emission" in files:
        L.new(tex("emission", False, -600).outputs["Color"], bs.inputs["Emission Color"])
        bs.inputs["Emission Strength"].default_value = 1.0
    ng = None
    for g in bpy.data.node_groups:
        if g.name.lower().startswith("gltf material output") and any(i.name == "Occlusion" for i in g.interface.items_tree if getattr(i, "in_out", "") == 'INPUT'):
            ng = g
            break
    if ng is None:
        ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        ng.interface.new_socket("Occlusion", in_out='INPUT', socket_type='NodeSocketFloat')
    gn = N.new("ShaderNodeGroup"); gn.node_tree = ng; gn.location = (600, -400)
    L.new(sp.outputs["Red"], gn.inputs["Occlusion"])
    mat["dx12_baked_from"] = json.dumps(u["materials"])
    for o2 in [ob] + others:
        o2["dx12_baked_material"] = baked_name
    u["files"] = files
    u["stats"] = stats
    u["passes"] = sorted(k for k in passes if k not in ("matao",)) + (["matao"] if "matao" in passes else [])
    u["seconds"] = round(time.time() - T0, 2)
    return u

def main():
    targets = pick_targets()
    if not targets:
        report["error"] = "焼く対象が無い(objects を渡すか、Blender で MESH を選択する)"
        return
    saved = []
    for sc in bpy.data.scenes:
        for vl in sc.view_layers:
            act = vl.objects.active
            saved.append((vl, [o.name for o in vl.objects if o.select_get(view_layer=vl)], act.name if act else None))
    # 元のマテリアル割り当てと UV を後で比べられるよう、事前の状態も返す
    before = {}
    for o in targets:
        before[o.name] = {"materials": [s.material.name if s.material else None for s in o.material_slots], "uvLayers": [l.name for l in o.data.uv_layers],
                          "activeUv": o.data.uv_layers.active.name if o.data.uv_layers.active else None}
    report["before"] = before
    setup_cycles()
    base_dir = os.path.join(os.path.dirname(bpy.data.filepath), "dx12_baked") if bpy.data.filepath else P["fallbackDir"]
    report["bakeDir"] = base_dir.replace("\\\\", "/")
    try:
        try:
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            pass
        groups = {}
        for ob in targets:
            key = (ob.data.name, tuple(s.material.name if s.material else "" for s in ob.material_slots))
            groups.setdefault(key, []).append(ob)
        used = {}
        for key, obs in groups.items():
            try:
                r = bake_unit(obs[0], obs[1:], base_dir, used)
            except Exception as e:
                r = {"objects": [o.name for o in obs], "error": str(e), "trace": traceback.format_exc()[-1500:]}
                try:
                    bpy.ops.object.mode_set(mode='OBJECT')
                except Exception:
                    pass
            if r is not None:
                report["units"].append(r)
    finally:
        restore_cycles()
        bpy.ops.object.select_all(action='DESELECT')
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
    after = {}
    for o in targets:
        after[o.name] = {"materials": [s.material.name if s.material else None for s in o.material_slots], "uvLayers": [l.name for l in o.data.uv_layers],
                         "activeUv": o.data.uv_layers.active.name if o.data.uv_layers.active else None, "bakedMaterial": o.get("dx12_baked_material")}
    report["after"] = after
    report["seconds"] = round(time.time() - T0, 2)

try:
    main()
except Exception as e:
    report["error"] = str(e)
    report["trace"] = traceback.format_exc()[-1800:]
print(json.dumps(report))
`.trim();
}

// ─── orchestration ──────────────────────────────────────────────────────────

export interface BlenderExec { (code: string): Promise<{ stdout: string; json?: unknown }> }

const asRes = (r: unknown): MatRes => (MATERIAL_RESOLUTIONS as readonly string[]).includes(String(r)) ? (r as MatRes) : "2k";
const clamp01 = (x: unknown) => Math.max(0, Math.min(1, Number(x) || 0));

export async function applyMaterial(
  opts: ApplyOptions,
  deps: { blenderExec: BlenderExec; ensure?: typeof ensureMaterial; resolve?: typeof resolveMaterial },
): Promise<Record<string, unknown>> {
  const res = asRes(opts.resolution);
  const hit: MaterialHit = await (deps.resolve ?? resolveMaterial)({ source: opts.source, id: opts.id, query: opts.query });
  const mat: EnsuredMaterial = await (deps.ensure ?? ensureMaterial)({ source: hit.source, id: hit.id, resolution: res, hit });
  const sizeM = mat.meta.sizeM ?? hit.sizeM;
  const sc = resolveScaleM(opts.scaleM, sizeM);
  const projection = opts.projection === "box" ? "box" : "uv";
  const antiTile = opts.antiTile === true;
  const displacement = opts.displacement === "none" ? "none" : "bump";
  const edgeWear = clamp01(opts.weathering?.edgeWear), dirt = clamp01(opts.weathering?.dirt);
  const hasHeight = !!mat.maps.height;
  const reasons = bakeReasons({ projection, antiTile, displacement, hasHeight, edgeWear, dirt });
  const materialName = opts.materialName || defaultMaterialName(hit.id, mat.meta.resolution, { antiTile, projection, edgeWear, dirt, bump: displacement === "bump" && hasHeight });
  const code = buildApplyScript({
    objects: opts.objects ?? [], materialName, scaleM: sc.scaleM, aspect: sc.aspect, projection, antiTile, displacement, edgeWear, dirt,
    imageBase: materialName,
    maps: { color: mat.maps.color, orm: mat.orm, normal_gl: mat.maps.normal_gl, height: displacement === "bump" ? mat.maps.height : undefined, emission: mat.maps.emission, opacity: mat.maps.opacity },
    meta: { source: hit.source, id: hit.id, license: "CC0", url: hit.url, resolution: mat.meta.resolution },
  });
  const { json, stdout } = await deps.blenderExec(code);
  if (!json) throw new Error(`Blender の結果を読めなかった(stdout: ${stdout.slice(0, 400)})`);
  const r = json as any;
  if (r.error) throw new Error(`${r.error}${r.trace ? "\n" + r.trace : ""}`);
  const warnings: string[] = [...mat.warnings, ...(r.warnings ?? [])];
  if (sc.from === "default") warnings.push("素材の実寸が不明なので scaleM は 2m にした(合わなければ scaleM で指定)");
  if (mat.meta.orm.defaults.length) warnings.push(`ORM に素材が無いチャンネルは既定値: ${mat.meta.orm.defaults.join(" / ")}`);
  const needsBake = reasons.length > 0;
  return {
    material: r.material, source: hit.source, id: hit.id, name: hit.name, license: "CC0", url: hit.url,
    resolution: mat.meta.resolution, cached: mat.cached, cacheDir: mat.dir,
    maps: Object.fromEntries(Object.entries(mat.maps).map(([k, v]) => [k, path.basename(v as string)])), orm: mat.orm,
    ormMode: mat.meta.orm.mode,
    scaleM: sc.scaleM, scaleFrom: sc.from, repeatsPerMeter: repeatsPerMeter(sc.scaleM), ...(sc.aspect !== 1 ? { repeatsPerMeterV: repeatsPerMeter(sc.scaleM * sc.aspect) } : {}), sizeM,
    projection, antiTile, displacement, weathering: { edgeWear, dirt },
    objects: r.objects, needsBake, ...(needsBake ? { needsBakeReasons: reasons } : {}), warnings,
    next: needsBake
      ? "ノードのままではエンジンへ行かない → dx12_material_bake で焼いてから dx12_blender_place(焼いた方が書き出しで自動的に使われる)"
      : "そのまま dx12_blender_place(または dx12_blender_export)で書き出せる。縮尺は dx12_uv で実寸済み",
  };
}

export interface BakeOptions {
  objects?: string[]; texelDensity?: number; maxRes?: number; minRes?: number; samples?: number;
  maps?: string[]; device?: "auto" | "cpu";
}
export const BAKE_MAPS = ["basecolor", "roughness", "metallic", "normal", "ao", "emission"] as const;

export async function bakeMaterials(opts: BakeOptions, deps: { blenderExec: BlenderExec }): Promise<Record<string, unknown>> {
  const maps = (opts.maps && opts.maps.length ? opts.maps : [...BAKE_MAPS]).map((m) => String(m).toLowerCase());
  const bad = maps.filter((m) => !(BAKE_MAPS as readonly string[]).includes(m));
  if (bad.length) throw new Error(`maps に未対応の名前: ${bad.join(", ")}(使えるのは ${BAKE_MAPS.join(" / ")})`);
  const code = buildBakeScript({
    objects: opts.objects ?? [],
    texelDensity: opts.texelDensity && opts.texelDensity > 0 ? opts.texelDensity : 1024,
    maxRes: opts.maxRes && opts.maxRes > 0 ? opts.maxRes : 4096,
    minRes: opts.minRes && opts.minRes > 0 ? opts.minRes : 512,
    samples: opts.samples && opts.samples > 0 ? Math.floor(opts.samples) : 16,
    maps, device: opts.device === "cpu" ? "cpu" : "auto",
    fallbackDir: path.join(materialsRoot(), "_baked", "untitled"),
  });
  const { json, stdout } = await deps.blenderExec(code);
  if (!json) throw new Error(`Blender の結果を読めなかった(stdout: ${stdout.slice(0, 400)})`);
  const r = json as any;
  if (r.error) throw new Error(`${r.error}${r.trace ? "\n" + r.trace : ""}`);
  const failed = (r.units ?? []).filter((u: any) => u.error);
  return {
    ...r,
    ok: failed.length === 0 && (r.units ?? []).length > 0,
    next: "dx12_blender_place で置く(オブジェクトのカスタムプロパティ dx12_baked_material が書き出し時の一時コピーにだけ反映される。元のマテリアル割り当てはそのまま)",
  };
}

