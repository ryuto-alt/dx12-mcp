/**
 * Blender の自動起動と、dx12 へ流すための書き出し（BlenderMCP アドオンのソケットを直接叩く）。
 *
 * なぜ dx12 側から Blender を叩くのか（2026-09-10 にユーザーと合意）:
 *   「必要なモデルがあったら自分で Blender を立ち上げてモデリングして持ってくる」を成立させるには、
 *   ①Blender が起動しているか自分で確かめて要れば起動する ②書き出しの規約が守られている
 *   の 2 つが要る。②は文章で書いても毎回守られないので、**踏んだ罠を全部コードに埋めた
 *   書き出し関数**を 1 本用意して、それしか使わせない形にする。
 *
 * 埋めてある罠（すべて実際に踏んだもの。詳細は各所のコメント）:
 *   ・use_selection=False は .blend 内の【全シーン】を書き出す → 全部 deselect してから対象だけ選ぶ
 *   ・glTF エクスポータが画像を tmpXXXX.jpg という一時名で出す → 再書き出しで前の参照が切れる
 *   ・エンジンは baseColorFactor を読まない → テクスチャ無しの単色マテリアルは真っ白になる
 *   ・エンジンにアルファ抜きが無い → 葉・枝カードのような α 前提の面は不透明な板になる
 *   ・シェイプキーが .bin の大半を占める（実例: 75MB のうち 70MB）
 *   ・UI が日本語だとノード名も日本語 → nodes["Principled BSDF"] は KeyError。type で引く
 *
 * プロトコル: BlenderMCP アドオンは TCP 9876 で行 JSON ではなく「1 リクエスト = 1 JSON」を受け、
 * `{"status":"success","result":{...}}` を 1 回返して待ち受けに戻る。
 * execute_code は **stdout をそのまま result.result に入れて返す**ので、
 * スクリプト側は print(json.dumps(...)) で結果を戻す。
 */

import net from "node:net";

export const BLENDER_PORT = 9876;

// ─── ソケットクライアント ────────────────────────────────────────────────

export interface BlenderResponse {
  status?: string;
  result?: unknown;
  message?: string;
}

/** ポートが開いているか（＝アドオンのサーバーが動いているか）だけ見る。 */
export function isPortOpen(port: number, host = "127.0.0.1", timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * 1 コマンド送って 1 レスポンスを受ける。
 * ★アドオンは長さ枠を付けないので、受信を JSON として parse できるまで貯める。
 *   途中で切れた JSON を parse しようとして毎回落ちる実装にしないこと。
 */
export function blenderCall(
  type: string,
  params: Record<string, unknown> = {},
  opts: { port?: number; timeoutMs?: number } = {},
): Promise<BlenderResponse> {
  const port = opts.port ?? BLENDER_PORT;
  const timeoutMs = opts.timeoutMs ?? 120_000;   // モデリングは普通に数十秒かかる
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let buf = "";
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; sock.destroy(); reject(e); } };
    sock.setTimeout(timeoutMs);
    sock.once("timeout", () => fail(new Error(`Blender が ${timeoutMs}ms 応答しない`)));
    sock.once("error", (e) => fail(e));
    sock.once("connect", () => sock.write(JSON.stringify({ type, params })));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      try {
        const parsed = JSON.parse(buf) as BlenderResponse;
        settled = true;
        sock.destroy();
        resolve(parsed);
      } catch {
        /* まだ全部届いていない。次の chunk を待つ */
      }
    });
    sock.once("close", () => {
      if (settled) return;
      try { resolve(JSON.parse(buf) as BlenderResponse); }
      catch { fail(new Error("Blender が応答を返さずに切断した")); }
    });
    sock.connect(port, "127.0.0.1");
  });
}

/** execute_code の戻りは stdout 文字列。JSON を print していれば取り出す。 */
export function parseCodeResult(resp: BlenderResponse): { stdout: string; json?: unknown } {
  const inner = (resp?.result ?? {}) as { result?: unknown; executed?: boolean };
  const stdout = typeof inner.result === "string" ? inner.result : "";
  // 末尾の行から順に JSON として読めるものを探す（print が複数あっても最後を採る）
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!(l.startsWith("{") || l.startsWith("["))) continue;
    try { return { stdout, json: JSON.parse(l) }; } catch { /* 次の行 */ }
  }
  return { stdout };
}

// ─── Blender の実行ファイルを探す ────────────────────────────────────────

/** よくある場所を新しい版から順に返す（存在確認は呼び出し側）。 */
export function blenderCandidatePaths(programFiles = "C:\\Program Files"): string[] {
  const versions = ["5.2", "5.1", "5.0", "4.5", "4.4", "4.3", "4.2", "4.1", "4.0"];
  return versions.map((v) => `${programFiles}\\Blender Foundation\\Blender ${v}\\blender.exe`);
}

// ─── 書き出し規約 ────────────────────────────────────────────────────────

export interface ModelBrief {
  rules: string[];
  materials: string[];
  gotchas: string[];
}

/**
 * dx12 へ持ってくるモデルの作り方。Blender で作り始める**前**に読む。
 * ここに書いてあることは全部「守らないと実際に壊れた」項目。
 */
export function modelBrief(kind: string): ModelBrief {
  const common: ModelBrief = {
    rules: [
      "★角には必ずベベルを入れる（2〜4mm / 2 段 / 角度制限 30 度 / harden normals）。" +
        "これが『うすぺらい』の最大の原因。実物の角は必ず微妙に丸く、そこがハイライトを拾う。" +
        "完全に鋭い角は光を一切拾わないので、どんなに良いテクスチャを貼っても紙細工に見える",
      "★ベベルの【前に】スケールを適用する（transform_apply(scale=True)）。" +
        "非一様スケールのまま掛けると軸ごとにベベル幅が変わり、片側だけ角が丸い歪んだ形になる",
      "★UV は実寸で切る（cube_project(cube_size=1.0) で 1 UV = 1m）。" +
        "プリミティブの既定 UV は【面ごとに 0..1】なので、60cm の箱にも 6m の壁にも " +
        "テクスチャが 1 枚だけ貼られる＝模様の大きさが物の大きさと合わず、玩具に見える",
      "スムーズシェード + 自動スムーズ 30 度 + 加重法線。曲面のカクつきが消え、平面は平面のまま残る",
      "★曲面は最初から分割を足しておく（樽・柱なら 24〜32、球なら 32 前後）。" +
        "ベベルは角を丸めるだけでシルエットの角は消せないので、16 角柱は仕上げても 16 角のまま残る",
      "板から作った物には必ず厚みを付ける（Solidify）。厚みゼロの面は紙に見えるうえ Z ファイティングも起こす",
      "単位はメートル。1.8m の人なら Blender 上でも 1.8。spawn 時のスケールは常に 1 で置く",
      "原点は接地面の中心（底面の真ん中）。snap_to_ground と当たり判定がここを基準にする",
      "正面は +Y（Blender の -Y がエンジンの +Z）。壁に付ける家具は rotY を間違えると背板が手前に来る",
      "書き出しは glTF。FBX は cm 基準なので避ける（読めるが余計な換算が挟まる）",
    ],
    materials: [
      "★単色マテリアルは禁止。エンジンは glTF の baseColorFactor を読まないので、" +
        "テクスチャ無しのマテリアルは【真っ白】になる（茶色に設定した木箱が白い箱として出る）。" +
        "真鍮・革・蝋のような単色で済ませたい物にも必ず col テクスチャを作る",
      "★素材は PolyHaven から取る（CC0・API キー不要・859 種類）。" +
        "手続きノードで作るより速く、質も比べものにならない。dx12_blender_material が面倒を見る",
      "★ORM は R=AO / G=roughness / B=metallic。PolyHaven の arm マップがそのまま使える。" +
        "rough 単体（グレースケール）を metallicRoughness として出すと B に粗さの値が入り、" +
        "木や布が金属として描かれる",
      "法線は OpenGL 規約（nor_gl）。DirectX 規約（nor_dx）は使わない",
      "★アルファ抜きの面は Blender で消してから出すか、alphaMode を MASK にする。" +
        "葉・枝カード・角膜のような α 前提の面をそのまま出すと不透明な板になる",
      "テクセル密度は 512〜1024 texel/m に揃える（2k テクスチャなら 1 UV = 2m 前後）",
    ],
    gotchas: [
      "★環境光が手続き空（既定）のままだと、全部に青が乗って彩度が落ちる。" +
        "モデルの見栄えを判断する前に dx12_scene_env で HDRI を入れること。" +
        "金属と光沢は環境に映るものが無いと質感が出ない",
      "shape_key_clear() してから出す。使わないシェイプキーが .bin の大半を占める（実例: 75MB のうち 70MB）",
      "UI が日本語だとノード名も日本語。nodes['Principled BSDF'] は KeyError になるので type='BSDF_PRINCIPLED' で引く",
      "書き出し前に全シーンの全 view_layer で deselect してから対象だけ選ぶ（use_selection=False は .blend 内の全シーンを出す）",
      "transform_apply を重ねがけすると location が頂点に焼かれ、エンジンでだけ物が飛ぶ",
      "Blender 4.1 以降 mesh.use_auto_smooth は消えた。bpy.ops.object.shade_auto_smooth(angle=) を使う",
    ],
  };
  const k = kind.toLowerCase();
  if (k.includes("charact") || k.includes("キャラ") || k.includes("player") || k.includes("enemy")) {
    common.rules.push("スキンメッシュはボーン付きで出す。エンジンは FBX のスケール補正をスキンには掛けない規約なので glTF が安全");
    common.rules.push("アニメーションはクリップ名がそのまま Lua の playAnimByName に渡る名前になる");
    common.rules.push("キャラにベベルは要らない（有機形状は元から丸い）。かわりにサブディビジョンで面を足す");
  }
  if (k.includes("prop") || k.includes("小物") || k.includes("家具") || k.includes("furniture")) {
    common.rules.push("当たり判定を付けるなら箱で足りることが多い。凹んだ形が要るときだけ sculpt/MeshShape を検討する");
    common.rules.push("小物ほどベベルが効く。手に取る距離で見るので角の丸みが直接『安っぽさ』になる");
  }
  if (k.includes("level") || k.includes("床") || k.includes("wall") || k.includes("壁")) {
    common.rules.push("床・壁はエンジン側で rigidBody{motionType:0,mass:0} を必ず付ける（コライダーだけでは Jolt に載らない）");
    common.rules.push("床と壁を同一平面で突き合わせない。1mm 以内で重なると Z ファイティングでちらつく（dx12_validate_layout の Z_FIGHT）");
    common.rules.push("★床の法線マップは外すことを検討する。高いタイリング × 寝た面だと N·L の符号が裏返って黒い斑点が出る");
  }
  return common;
}

/**
 * 規約どおりに書き出す Blender Python を組み立てる。
 * objectNames が空なら選択中のオブジェクトを使う。
 *
 * ★この関数は純粋（文字列を返すだけ）。実行は blenderCall("execute_code", {code}) 側。
 */
export function buildExportScript(opts: {
  objectNames: string[];
  outPath: string;        // .glb か .gltf の絶対パス（Blender から見えるパス）
  clearShapeKeys?: boolean;
  applyModifiers?: boolean;
}): string {
  const names = JSON.stringify(opts.objectNames ?? []);
  const out = JSON.stringify(opts.outPath.replace(/\\/g, "/"));
  // ★拡張子から書き出し形式を決めて **必ず渡す**。渡さないと Blender の既定（GLB）になり、
  //   models/rock.gltf を頼んだのに rock.glb が出る＝参照が全部切れて
  //   spawn_model が "model not found" で落ちる（実際に踏んだ）。
  const fmt = /\.glb$/i.test(opts.outPath) ? "GLB" : "GLTF_SEPARATE";
  const clearSk = opts.clearShapeKeys === false ? "False" : "True";
  const applyMod = opts.applyModifiers === false ? "False" : "True";
  // Python 側のインデントを壊さないよう、テンプレートリテラルは素のまま埋める
  return `
import bpy, json, os

want = ${names}
out_path = ${out}
clear_shape_keys = ${clearSk}
apply_modifiers = ${applyMod}
EXPORT_FORMAT = "${fmt}"

report = {"exported": [], "warnings": [], "path": out_path}

# ★全シーンの全 view_layer で選択を解除してから対象だけ選ぶ。
#   use_selection=False にすると glTF は .blend 内の【全シーン】を書き出す（scenes は配列なので合法）。
#   別シーンで作業していても他シーンのオブジェクトが混ざる、という事故がこれで起きる。
for sc in bpy.data.scenes:
    for vl in sc.view_layers:
        for ob in sc.objects:
            try:
                ob.select_set(False, view_layer=vl)
            except Exception:
                pass

scene = bpy.context.scene
targets = []
if want:
    for n in want:
        ob = bpy.data.objects.get(n)
        if ob is None:
            report["warnings"].append("オブジェクトが見つからない: " + n)
        else:
            targets.append(ob)
else:
    targets = [o for o in bpy.context.selected_objects] or [o for o in scene.objects if o.type == 'MESH']

if not targets:
    print(json.dumps({"error": "書き出す対象が無い", "report": report}))
else:
    for ob in targets:
        try:
            ob.select_set(True)
        except Exception:
            pass
        report["exported"].append(ob.name)

        if ob.type == 'MESH':
            # シェイプキーは使わないなら捨てる。モーフターゲットは .bin の大半を占めることがある。
            if clear_shape_keys and ob.data.shape_keys:
                n_keys = len(ob.data.shape_keys.key_blocks)
                ob.shape_key_clear()
                report["warnings"].append(ob.name + ": シェイプキー " + str(n_keys) + " 個を削除した（容量削減）")

            # 単色マテリアル（画像テクスチャ無し）はエンジンで真っ白になる。必ず言う。
            for slot in ob.material_slots:
                mat = slot.material
                if mat is None or not mat.use_nodes:
                    report["warnings"].append(ob.name + ": マテリアルが無い/ノード無効 → エンジンでは真っ白になる")
                    continue
                has_image = any(n.type == 'TEX_IMAGE' and n.image for n in mat.node_tree.nodes)
                if not has_image:
                    report["warnings"].append(
                        ob.name + " / " + mat.name +
                        ": 画像テクスチャが 1 枚も無い → エンジンは baseColorFactor を読まないので真っ白になる")

    bpy.context.view_layer.objects.active = targets[0]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    kwargs = dict(
        filepath=out_path,
        use_selection=True,          # ★ここが False だと全シーンが出る
        export_apply=apply_modifiers,
        export_yup=True,
        export_format=EXPORT_FORMAT, # ★渡さないと既定の GLB になり拡張子と食い違う
    )
    if EXPORT_FORMAT == 'GLTF_SEPARATE':
        kwargs["export_texture_dir"] = "textures"
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # 版によって引数名が違う。落ちるくらいなら最小構成で出す。
        kwargs.pop("export_apply", None)
        bpy.ops.export_scene.gltf(**kwargs)

    # ★頼んだパスに本当にできたかを確かめる。形式と拡張子が食い違うと
    #   別名のファイルができて、呼び出し側は成功したと思い込む。
    if not os.path.exists(out_path):
        alt = [f for f in os.listdir(os.path.dirname(out_path))
               if os.path.splitext(f)[0] == os.path.splitext(os.path.basename(out_path))[0]]
        report["error"] = ("頼んだパスにファイルができていない: " + out_path +
                           "（同名で見つかったもの: " + ", ".join(alt) + "）")
    report["size"] = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    print(json.dumps(report))
`.trim();
}

/**
 * .gltf に付いてくる tmpXXXX.jpg のような一時名の画像を、意味のある名前へ直す計画を作る。
 * （Blender 5.2 の glTF エクスポータは画像を tmp 名で出すので、モデルを個別に書き出すと
 *   同じテクスチャが別名で重複し、再書き出しで名前が変わって**前に出したモデルの参照が切れる**。
 *   額縁が白・絨毯が黒になった、という形で実際に踏んだ。）
 *
 * gltf は .gltf の JSON（パース済み）、baseName は付けたい接頭辞。
 * 返り値は [{from, to}] の並びで、呼び出し側がファイル名変更と uri 書き換えを行う。
 */
export function planImageRenames(
  gltf: { images?: { uri?: string; name?: string }[]; materials?: unknown[] },
  baseName: string,
): { index: number; from: string; to: string }[] {
  const plan: { index: number; from: string; to: string }[] = [];
  const images = gltf.images ?? [];
  const used = new Set<string>();
  images.forEach((img, i) => {
    const uri = img.uri;
    if (!uri || uri.startsWith("data:")) return;          // 埋め込みは対象外
    const dot = uri.lastIndexOf(".");
    const ext = dot >= 0 ? uri.slice(dot) : ".png";
    const stem = dot >= 0 ? uri.slice(0, dot) : uri;
    // 明らかに一時名のものだけ直す。人が付けた名前は尊重する。
    if (!/^tmp[0-9a-z_]*$/i.test(stem) && !/^Image[._-]?\d*$/i.test(stem)) return;
    let to = `${baseName}_${i}${ext}`;
    let n = 2;
    while (used.has(to)) to = `${baseName}_${i}_${n++}${ext}`;
    used.add(to);
    plan.push({ index: i, from: uri, to });
  });
  return plan;
}


// ─── 仕上げパス（「うすぺらい」を消す幾何の処理） ──────────────────────────

export interface PolishOptions {
  objectNames: string[];
  /** ベベル幅 m（既定 0.003 = 3mm）。小物ほど効く */
  bevelWidth?: number;
  bevelSegments?: number;
  /** 自動スムーズの角度（度） */
  smoothAngle?: number;
  /** 1 UV = 何メートルで切り直すか。0 で UV を触らない */
  uvMeters?: number;
  /** これ以下の厚みしかない軸があれば Solidify する m（0 で無効） */
  minThickness?: number;
}

/**
 * 「安っぽい形」を直す Blender Python を組み立てる（純粋）。
 *
 * 実測で確かめた効き目（2026-09-11、木箱 60cm で比較）:
 *   ・ベベル無しの角は光を一切拾わず、テクスチャを貼っても紙細工に見える。
 *     4mm のベベルを入れると角にハイライトの線が走り、固まりとして見えるようになる。
 *   ・プリミティブの既定 UV は面ごとに 0..1 なので、板の模様が物の大きさと無関係になる。
 *     cube_project(1.0) で実寸に切り直すと模様の縮尺が合う。
 */
export function buildPolishScript(opts: PolishOptions): string {
  const names = JSON.stringify(opts.objectNames ?? []);
  const bw = opts.bevelWidth ?? 0.003;
  const seg = opts.bevelSegments ?? 2;
  const ang = opts.smoothAngle ?? 30;
  const uvm = opts.uvMeters ?? 1.0;
  const minT = opts.minThickness ?? 0.004;
  return `
import bpy, math, json

want = ${names}
BEVEL_W = ${bw}
BEVEL_SEG = ${seg}
SMOOTH_ANGLE = ${ang}
UV_METERS = ${uvm}
MIN_THICKNESS = ${minT}

report = {"objects": [], "warnings": []}

targets = []
if want:
    for n in want:
        ob = bpy.data.objects.get(n)
        if ob is None:
            report["warnings"].append("見つからない: " + n)
        elif ob.type == 'MESH':
            targets.append(ob)
else:
    targets = [o for o in bpy.context.selected_objects if o.type == 'MESH']
    if not targets:
        targets = [o for o in bpy.context.scene.objects if o.type == 'MESH']

for ob in targets:
    done = []
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob

    # ① スケールを適用する。★必ずベベルより先。非一様スケールのまま掛けると
    #    軸ごとにベベル幅が変わり「片側だけ角が丸い」歪んだ形になる。
    if tuple(round(v, 4) for v in ob.scale) != (1.0, 1.0, 1.0):
        try:
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            done.append("スケール適用")
        except Exception as e:
            report["warnings"].append(ob.name + ": スケール適用に失敗 " + str(e))

    dims = list(ob.dimensions)
    # ② 厚みが無い（板）なら Solidify。紙に見えるうえ Z ファイティングも起こす。
    if MIN_THICKNESS > 0 and min(dims) < MIN_THICKNESS:
        if not any(m.type == 'SOLIDIFY' for m in ob.modifiers):
            m = ob.modifiers.new("dx12_solidify", 'SOLIDIFY')
            m.thickness = max(MIN_THICKNESS, 0.004)
            m.offset = 0.0
            done.append("Solidify %.0fmm" % (m.thickness * 1000))

    # ③ UV を実寸で切り直す。プリミティブの既定 UV は面ごとに 0..1 なので、
    #    模様の大きさが物の大きさと合わない（60cm の箱も 6m の壁も 1 枚）。
    if UV_METERS > 0:
        try:
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.cube_project(cube_size=UV_METERS)
            bpy.ops.object.mode_set(mode='OBJECT')
            done.append("UV %gm/UV" % UV_METERS)
        except Exception as e:
            try:
                bpy.ops.object.mode_set(mode='OBJECT')
            except Exception:
                pass
            report["warnings"].append(ob.name + ": UV 展開に失敗 " + str(e))

    # ④ スムーズ + 自動スムーズ（曲面のカクつきだけ消し、平面は平面のまま）
    try:
        bpy.ops.object.shade_smooth()
        bpy.ops.object.shade_auto_smooth(angle=math.radians(SMOOTH_ANGLE))
        done.append("自動スムーズ %d度" % SMOOTH_ANGLE)
    except Exception as e:
        report["warnings"].append(ob.name + ": スムーズに失敗 " + str(e))

    # ⑤ ベベル。★これが「うすぺらい」を消す本体。
    if BEVEL_W > 0 and not any(m.name == "dx12_bevel" for m in ob.modifiers):
        b = ob.modifiers.new("dx12_bevel", 'BEVEL')
        b.width = BEVEL_W
        b.segments = BEVEL_SEG
        b.limit_method = 'ANGLE'
        b.angle_limit = math.radians(SMOOTH_ANGLE)
        try:
            b.harden_normals = True
        except Exception:
            pass
        done.append("ベベル %.0fmm x%d" % (BEVEL_W * 1000, BEVEL_SEG))

    # ⑥ 加重法線（ベベルの陰影を平面へ引きずらない）
    if not any(m.type == 'WEIGHTED_NORMAL' for m in ob.modifiers):
        w = ob.modifiers.new("dx12_weighted_normal", 'WEIGHTED_NORMAL')
        w.keep_sharp = True
        done.append("加重法線")

    # ★仕上げは「形の粗さ」までは直せない。16 角柱の樽はベベルを掛けても
    #   シルエットが 16 角のまま残る（実測で確認）。面が少なすぎるものは作り直しが要る。
    n_poly = len(ob.data.polygons)
    if n_poly < 40:
        report["warnings"].append(
            ob.name + ": 面が %d しかない。曲面なら分割を増やして作り直すこと" % n_poly +
            "（樽・柱なら 24〜32 分割。ベベルではシルエットの角は消えない）")

    report["objects"].append({
        "name": ob.name,
        "size": [round(v, 4) for v in ob.dimensions],
        "polys": n_poly,
        "applied": done,
    })

print(json.dumps(report, ensure_ascii=False))
`.trim();
}

// ─── PolyHaven の PBR マテリアル ─────────────────────────────────────────

export interface MaterialOptions {
  objectNames: string[];
  /** PolyHaven のアセット ID（例 brown_planks_05）。省略時は keyword で検索 */
  assetId?: string;
  keyword?: string;
  resolution?: "1k" | "2k" | "4k";
  /** 1 UV = 何メートル（テクセル密度。2k なら 2m が 1024texel/m） */
  uvMeters?: number;
}

/**
 * PolyHaven の PBR 素材を落として貼る Blender Python（純粋）。
 *
 * ★arm（AO/Roughness/Metallic が 1 枚に詰まったもの）があればそれを使う。
 *   無ければ Rough から R=AO / G=rough / B=0 の ORM を組む。
 *   rough 単体をそのまま metallicRoughness として出すと B に粗さが入り、
 *   木や布が金属として描かれる（glTF は B=metallic と決まっている）。
 */
export function buildMaterialScript(opts: MaterialOptions): string {
  const names = JSON.stringify(opts.objectNames ?? []);
  const asset = JSON.stringify(opts.assetId ?? "");
  const keyword = JSON.stringify(opts.keyword ?? "");
  const res = JSON.stringify(opts.resolution ?? "2k");
  const uvm = opts.uvMeters ?? 2.0;
  return `
import bpy, os, json, struct, zlib, tempfile
import requests

want = ${names}
ASSET = ${asset}
KEYWORD = ${keyword}
RES = ${res}
UV_METERS = ${uvm}
HDR = {"User-Agent": "blender-mcp"}
report = {"warnings": []}

# ① アセットを決める（ID 指定が無ければキーワードで探す）
if not ASSET:
    if not KEYWORD:
        print(json.dumps({"error": "assetId か keyword のどちらかが要る"}))
        raise SystemExit
    lst = requests.get("https://api.polyhaven.com/assets", params={"t": "textures"},
                       headers=HDR, timeout=60).json()
    hits = [k for k in lst if KEYWORD.lower() in k.lower()]
    if not hits:
        kw = KEYWORD.lower()
        hits = [k for k, v in lst.items()
                if any(kw in t.lower() for t in (v.get("tags") or []) + (v.get("categories") or []))]
    if not hits:
        print(json.dumps({"error": "PolyHaven に該当なし: " + KEYWORD}))
        raise SystemExit
    ASSET = sorted(hits)[0]
report["asset"] = ASSET

files = requests.get("https://api.polyhaven.com/files/" + ASSET, headers=HDR, timeout=60).json()
report["maps"] = sorted(files.keys())

texdir = os.path.join(tempfile.gettempdir(), "dx12_polyhaven", ASSET)
os.makedirs(texdir, exist_ok=True)

def grab(kind, prefer=("jpg", "png", "exr")):
    node = files.get(kind)
    if not node:
        return None
    e = node.get(RES) or list(node.values())[0]
    fmt = next((f for f in prefer if f in e), None) or list(e.keys())[0]
    url = e[fmt]["url"]
    path = os.path.join(texdir, kind + "." + url.rsplit(".", 1)[-1])
    if not os.path.exists(path):
        open(path, "wb").write(requests.get(url, headers=HDR, timeout=300).content)
    return path

p_col = grab("Diffuse") or grab("diff") or grab("albedo")
p_nor = grab("nor_gl")
p_arm = grab("arm")
p_rough = grab("Rough") or grab("rough")
p_ao = grab("AO") or grab("ao")

# ② ORM を用意する。arm があればそのまま（R=AO/G=rough/B=metal）。
p_orm = p_arm
if not p_orm and p_rough:
    SZ = 1024
    p_orm = os.path.join(texdir, "orm_composed.png")
    if not os.path.exists(p_orm):
        def gray(path):
            im = bpy.data.images.load(path, check_existing=True)
            im.colorspace_settings.name = 'Non-Color'
            if tuple(im.size) != (SZ, SZ):
                im.scale(SZ, SZ)
            return list(im.pixels)
        rg = gray(p_rough)
        ao = gray(p_ao) if p_ao else None
        buf = bytearray()
        for y in range(SZ - 1, -1, -1):
            buf.append(0)
            row = y * SZ * 4
            for x in range(SZ):
                i = row + x * 4
                r = int(max(0.0, min(1.0, ao[i])) * 255) if ao else 255
                g = int(max(0.0, min(1.0, rg[i])) * 255)
                buf += bytes((r, g, 0))
        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data +
                    struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
        png = b"\\x89PNG\\r\\n\\x1a\\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", SZ, SZ, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", zlib.compress(bytes(buf), 6))
        png += chunk(b"IEND", b"")
        open(p_orm, "wb").write(png)
        report["warnings"].append("arm が無いので Rough から ORM を合成した（B=0）")

# ③ マテリアルを組む
mat = bpy.data.materials.new("PH_" + ASSET)
mat.use_nodes = True
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

def tex(path, non_color, y):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        n.image.colorspace_settings.name = 'Non-Color'
    n.location = (-800, y)
    return n

if p_col:
    nt.links.new(tex(p_col, False, 300).outputs["Color"], bsdf.inputs["Base Color"])
if p_nor:
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.location = (-450, 0)
    nt.links.new(tex(p_nor, True, 0).outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
if p_orm:
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-450, -300)
    nt.links.new(tex(p_orm, True, -300).outputs["Color"], sep.inputs["Color"])
    # ★glTF エクスポータはこの形（G→Roughness / B→Metallic）を metallicRoughness として書く
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

report["slots"] = {"baseColor": bool(p_col), "normal": bool(p_nor),
                   "orm": bool(p_orm), "ormSource": "arm" if p_arm else "composed"}

# ④ 貼る（UV も実寸で切り直す）
targets = []
if want:
    for n in want:
        ob = bpy.data.objects.get(n)
        if ob is None:
            report["warnings"].append("見つからない: " + n)
        elif ob.type == 'MESH':
            targets.append(ob)
else:
    targets = [o for o in bpy.context.selected_objects if o.type == 'MESH']

for ob in targets:
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    if UV_METERS > 0:
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.cube_project(cube_size=UV_METERS)
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception as e:
            try:
                bpy.ops.object.mode_set(mode='OBJECT')
            except Exception:
                pass
            report["warnings"].append(ob.name + ": UV 展開に失敗 " + str(e))

report["applied"] = [o.name for o in targets]
print(json.dumps(report, ensure_ascii=False))
`.trim();
}
