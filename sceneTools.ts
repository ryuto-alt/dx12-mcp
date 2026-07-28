// 地形 / スカルプト / 診断ツールの「引数の正規化と検証」だけを切り出した純ロジック。
//
// なぜ index.ts から分けるか: index.ts を import すると stdio トランスポートに接続して
// サーバが起動してしまうのでテストできない。ここは副作用ゼロ・エンジン非依存なので
// sceneTools.test.ts からそのまま検証できる（uiQuality.ts / uiComposer.ts と同じ流儀）。
//
// エラーは「AI の次の行動が変わる粒度」で投げる: code(=engine の error_code と同じ体系)、
// message(何が悪いか)、hint(次に何をすればいいか)、valid_values(列挙型なら有効値の全部)。

import { z } from "zod";

/**
 * 固定長の数値配列 zod を【毎回新しいインスタンスで】作る。
 *
 * ★これがファクトリ関数である理由（既知の不具合の再発防止）:
 * 同じ ZodType インスタンスを 1 つのツールの複数フィールドで使い回すと、SDK が生成する
 * JSON Schema で 2 個目以降が `$ref: "#/properties/position"` に畳まれる。$ref を解決しない
 * クライアントでは「rotation: received string」のような的外れなエラーになり、
 * dx12_set_transform の rotation/scale や dx12_spawn_box の scale が弾かれていた。
 * インスタンスを毎回作れば $ref は出ない（sceneTools.test.ts で回帰を止めている）。
 */
export const vecN = (n: number) => z.array(z.number()).length(n);
export const v2 = () => vecN(2);
export const v3 = () => vecN(3);
export const v4 = () => vecN(4);

/** engine 側 McpErr と同じ番号体系（docs/MCP.md §8）。 */
export const ERR = {
  NOT_FOUND: 1,
  INVALID_PARAM: 2,
  MODE_CONFLICT: 3,
  STALE_SCENE: 4,
  UNKNOWN_COMPONENT: 6,
  INTERNAL: 7,
} as const;

export type ToolError = Error & { code: number; hint?: string; valid_values?: string[] };

/** ツール側バリデーションのエラー。errResult が code/hint/valid_values を整形して出す。 */
export function argError(message: string, hint: string, valid_values?: string[]): ToolError {
  const e = new Error(message) as ToolError;
  e.code = ERR.INVALID_PARAM;
  e.hint = hint;
  if (valid_values) e.valid_values = valid_values;
  return e;
}

// ── 列挙値（エンジン側の enum と 1:1。順序も合わせてある）──────────────
export const TERRAIN_PRESETS = ["hills", "canyon", "mountains"] as const;
export const TERRAIN_BRUSHES = ["raise", "lower", "smooth", "flatten", "noise"] as const;
export const SCULPT_BRUSHES = [
  "draw", "pull", "push", "smooth", "flatten", "pinch", "noise", "grab",
] as const;
export const SCULPT_PRIMITIVES = ["box", "sphere", "plane", "cylinder"] as const;
export const LIGHTING_PRESETS = ["day", "dusk", "night", "indoor", "horror", "studio"] as const;
/** DeepDiag::AllCheckIds() と同じ並び（src/gui/DeepDiagnostics.h）。 */
export const DIAG_CHECKS = [
  "shaders", "textures", "models", "gamma", "scene_assets",
  "lighting", "terrain", "picking", "instancing", "scripts",
  // DXR（計画09）。ケーパビリティ / 加速構造 / RT 影・RT-AO の設定矛盾を見る。
  "dxr",
] as const;
/** 重い検査（assets 全走査）。速く回したいときはこれを外す。 */
export const DIAG_SLOW_CHECKS = ["textures", "models"] as const;

// ── dx12_render_debug の mode（中間バッファ可視化）─────────────────────────
//
// 正は Application.cpp の `static const DbgEntry kEntries[]`（method == "render_debug"）と
// docs/MCP.md §4-2-1 の表。並びは docs の表に合わせてある（off は「全部戻すだけ」なので最後）。
// schemaDrift.test.ts [10] が C++ の kEntries[] と集合一致を検証している。
export const RENDER_DEBUG_MODES = [
  "normal", "roughness", "metallic", "depth", "ao", "contactShadow", "velocity", "ssr", "ssgi",
  // DXR（計画09）。rt = プライマリレイのヒット距離、rtDiff = RT とラスタの距離差
  // （加速構造の検証はこれが本命）。非対応 GPU では真っ黒 + warnings が返るだけでエラーにはならない。
  "rt", "rtDiff",
  // rtAlbedo = レイのヒット点のアルベド（計画09 Step 5 のバインドレス検証）。
  // ラスタの絵と色が一致すれば InstanceID → GeometryInfo → VB/IB/テクスチャ の配線が正しい。
  // Dynamic Resources（SM6.6 + Resource Binding Tier 3）非対応 GPU では真っ黒になる。
  "rtAlbedo",
  "shadowCascade", "lightComplexity", "clusterGrid", "decalCount",
  "fogScattering", "fogTransmittance", "fogSlice", "off",
] as const;

/**
 * 作っていない mode → 「なぜ無いか」と「代わりに何を見ればいいか」（docs/MCP.md §4-2-1）。
 *
 * ★ここが要る理由: AI は絵が変なとき真っ先に albedo / overdraw を試す（他エンジンにあるので）。
 *   ただ弾くと「引数を間違えた」と解釈して綴りを変えて何度も撃つ。理由と代替を返せば 1 回で止まる。
 */
export const RENDER_DEBUG_UNSUPPORTED: Readonly<Record<string, string>> = {
  albedo:
    "前方レンダラなのでアルベドの G-Buffer が存在しない"
    + "（作るには深度プリパスに RT をもう 1 枚足す＝速度 PSO の RTV 本数の契約に手を入れることになるので見送られた）。"
    + "代わりに: 最終画は dx12_screenshot、マテリアルの割当そのものは dx12_get_entity / dx12_material_apply、"
    + "テクスチャ単体は dx12_view_texture で見ること",
  overdraw:
    "加算カウント用の専用パス（全メッシュを再描画してブレンド加算）が要り、既存のどのバッファにも無い。"
    + "代わりに: 描画数/三角形数は dx12_perf_stats の draws/tris、"
    + 'ライトの重なりは mode:"lightComplexity"、クラスタ境界は mode:"clusterGrid" で見ること',
};

/**
 * render_debug の mode が非対応 / 未知のときのメッセージ。有効な mode なら null。
 * zod の errorMap から呼ぶ（＝スキーマ違反のエラー本文がそのまま理由になる）。
 */
export function renderDebugModeIssue(mode: unknown): string | null {
  if (typeof mode !== "string") return null;   // 型違いは zod の既定メッセージに任せる
  if ((RENDER_DEBUG_MODES as readonly string[]).includes(mode)) return null;
  const why = RENDER_DEBUG_UNSUPPORTED[mode];
  if (why) {
    return `dx12_render_debug: mode:"${mode}" は【意図的に非対応】。${why}`
      + `。有効な mode: ${RENDER_DEBUG_MODES.join(", ")}`;
  }
  return `dx12_render_debug: mode:"${mode}" は知らない可視化。`
    + `有効な mode: ${RENDER_DEBUG_MODES.join(", ")}`
    + `（albedo / overdraw は意図的に非対応。理由つきで弾かれる）`;
}

// ── set_component で触れないコンポーネント（B11）────────────────────────────
//
// ★エンジン側の事実（src/core/Application.cpp を読んで確認）
//   set_component は transform → ApplyOrphanComponent(gimmick/audioSource/particleEmitter/trigger
//   の 4 つだけ) → RemoveRegisteredComponent + 登録済みデシリアライザ、の順で処理する
//   (Application.cpp:4023-4079)。terrain / sculptMesh / gridPlane はそのどれにも載っていないので
//   RemoveRegisteredComponent(:2223-2259) が false を返し、UNKNOWN_COMPONENT
//   「unknown/unsupported component」で落ちる。
//   これは事故ではなく設計で、describe_components も settable:false と申告している
//   (:3039 terrain / :3053 sculptMesh / :2894 meshRenderer / :3021 skeletalAnimation)。
//   コンポーネントを作り直すと、生きている高さ配列・頂点配列とメッシュ/コライダーの結び付きが切れるため。
//
//   問題は【エラー文が "unknown"】なこと。実際は「知らない」のではなく「専用ツールを使え」なので、
//   AI は名前を推測して撃ち直す(sculpt / sculptMesh / Terrain …)。ここでエンジンへ送る前に
//   本当の理由と代わりの手段を返す。
export const NON_SETTABLE_COMPONENTS: Readonly<Record<string, { why: string; use: string }>> = {
  terrain: {
    why: "高さ配列(assets/terrain/*.hf)を持つ生きたコンポーネントで、作り直すとメッシュとコライダーとの結び付きが切れる",
    use: "dx12_terrain_create(worldSize/maxHeight/uvScale/color の更新も兼ねる冪等ツール) / "
      + "dx12_terrain_generate / dx12_terrain_sculpt / dx12_terrain_erode / dx12_terrain_sample / "
      + "dx12_terrain_paint / dx12_terrain_autopaint",
  },
  sculptMesh: {
    why: "頂点配列(assets/sculpt/*.smsh)を持つ生きたコンポーネントで、terrain と同じ理由で作り直せない",
    use: "dx12_sculpt_create(uvScale/color/collision の更新も兼ねる) / dx12_sculpt_make_editable / dx12_sculpt_brush",
  },
  sculpt: {
    why: "シーン JSON 上のキー名。get_entity / describe_components が使う jsonKey は sculptMesh。どちらにせよ set_component では触れない",
    use: "dx12_sculpt_create / dx12_sculpt_make_editable / dx12_sculpt_brush",
  },
  gridPlane: {
    why: "エディタの参照グリッド専用マーカー。シーン読み込み時に size を無視して常に最新値で作り直す実装なので、書いても意味が無い(SceneSerializer.cpp:1112-1118)",
    use: "触る必要は無い。床が欲しいなら dx12_create_entity type:\"plane\" か dx12_terrain_create",
  },
  meshRenderer: {
    why: "メッシュ実体(GPU バッファ)の所有整合が要るため set_component 非対応",
    use: "モデル差し替えは dx12_spawn_model / 見た目は dx12_material_apply・dx12_set_texture・dx12_set_pbr・dx12_set_color・dx12_set_mesh_shader",
  },
  skeletalAnimation: {
    why: "モデルロード時に作られる読み取り専用コンポーネント",
    use: "dx12_get_anim_state で一覧、dx12_play_anim で再生",
  },
};

/**
 * set_component に渡された component が「専用ツール側の担当」なら、その旨のエラーを返す。
 * 触れるコンポーネントなら null（＝そのままエンジンへ流す）。
 */
export function nonSettableComponentError(component: unknown): ToolError | null {
  const key = typeof component === "string" ? component.trim() : "";
  const info = NON_SETTABLE_COMPONENTS[key];
  if (!info) return null;
  const e = new Error(
    `${key} は dx12_set_component では設定できない(describe_components も settable:false と申告している)。理由: ${info.why}`,
  ) as ToolError;
  e.code = ERR.UNKNOWN_COMPONENT;
  e.hint = `代わりに ${info.use} を使う。同じ名前で撃ち直しても結果は変わらない`;
  return e;
}

/** 地形ブラシのストローク点。ワールド XZ 座標の配列へ正規化する。 */
export type StrokePoint = [number, number];

/**
 * point / points / worldPos のどれで来ても [x,z][] に畳む。
 * - [x,z]     … そのまま
 * - [x,y,z]   … y は捨てる（地形は XZ グリッドなので高さ入力は意味を持たない）
 * 最大 512 点。1 点も無ければ「どう指定すればいいか」を添えて弾く。
 */
export function normalizeStrokePoints(args: {
  point?: number[];
  points?: number[][];
  worldPos?: number[];
}): StrokePoint[] {
  const out: StrokePoint[] = [];
  const push = (a: unknown, where: string) => {
    if (!Array.isArray(a) || (a.length !== 2 && a.length !== 3) || a.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
      throw argError(
        `${where} は [x,z] か [x,y,z] の有限な数値で渡す`,
        "ワールド座標。y は無視される（地形は XZ グリッドなので高さは指定できない）",
      );
    }
    out.push([a[0] as number, (a.length === 2 ? a[1] : a[2]) as number]);
  };

  if (args.points !== undefined) {
    if (!Array.isArray(args.points)) {
      throw argError("points は [x,z] の配列で渡す", "1 点だけなら point:[x,z] を使う");
    }
    if (args.points.length > 512) {
      throw argError(`points が多すぎる (${args.points.length} > 512)`, "512 点ずつに分割して複数回呼ぶ");
    }
    args.points.forEach((p, i) => push(p, `points[${i}]`));
  }
  if (args.point !== undefined) push(args.point, "point");
  if (args.worldPos !== undefined) push(args.worldPos, "worldPos");

  if (out.length === 0) {
    throw argError(
      "筆を置く場所が指定されていない",
      "point:[x,z] か points:[[x,z],...] をワールド座標で渡す。場所が分からんときは dx12_pick か dx12_terrain_sample で調べる",
    );
  }
  return out;
}

/**
 * diagnose の only 引数を正規化する（配列でもカンマ区切り文字列でも受ける）。
 * 未知の ID は valid_values 付きで弾く＝AI が推測で撃ち直さない。
 * 戻り値はエンジンへ渡すカンマ区切り文字列（空 = 全検査）。
 */
export function normalizeDiagnoseOnly(only?: string | string[]): string {
  if (only === undefined || only === null) return "";
  const raw = Array.isArray(only) ? only : String(only).split(",");
  const ids = raw.map((s) => String(s).trim().toLowerCase()).filter((s) => s.length > 0);
  const seen: string[] = [];
  for (const id of ids) {
    if (!(DIAG_CHECKS as readonly string[]).includes(id)) {
      throw argError(`unknown check id: ${id}`, "有効な検査 ID のどれかを指定する", [...DIAG_CHECKS]);
    }
    if (!seen.includes(id)) seen.push(id);
  }
  return seen.join(",");
}

/** only を省略したときの「速い既定」。重い検査(textures/models)だけ落とす。 */
export function fastDiagnoseOnly(): string {
  return DIAG_CHECKS.filter((c) => !(DIAG_SLOW_CHECKS as readonly string[]).includes(c)).join(",");
}
