// Core ツール面の仕様(M3)。純データ + 純関数(サーバにも MCP にも依存しない。テストからそのまま読める)。
//
//   Core = tools/list に直接載せる主力ツール(shell 5 本の他に 28 本 + dx12_batch + dx12_call_guarded)。
//   ・「同名(旧ツールのまま)」= 旧 220 のうち頻出のもの。名前・引数・返り値は旧ツールと同一で、説明文だけ Core 用テンプレに差し替える(core 面のみ)。
//   ・「統合ツール」= 同じ道具の method 別ツール群(描画設定 26 本・撮影 8 本・地形 10 本・imgui 5 本・perf 2 本)を 1 本に畳んだ新ツール。
//     中身は旧ツールの登録済みハンドラをそのまま呼ぶ(返り値の形は旧ツールのまま)。旧名は dx12_call の別名として恒久サポート。
//   ・「エンジン直結ツール」= 旧ツールを持たず、エンジンの method 群を op で 1 本に束ねたもの(dx12_sequence = sequence_* 10 method)。旧ツールの routes は無い。
//
// 説明文テンプレ(設計書 §4.1.3): 1 文の要約(検索語を含む)/ 使う / 使わない / 副作用 / 注意 / 次。日本語・標準語。Core は 600 字以内。

export const CORE_DESCRIPTION_MAX = 600;

// ── 名前の規約(設計書 §4.1.2) ────────────────────────────────────────────────
// dx12_<動詞>_<対象>。動詞(先頭語、または dx12_look_apply のように末尾語)が副作用クラスを決める。
export type VerbClass = "read" | "write" | "runtime" | "guarded" | "capture";
export const VERB_CLASS: Record<string, VerbClass> = {
  get: "read", list: "read", find: "read", describe: "read", check: "read", validate: "read", query: "read",
  capture: "capture",
  set: "write", create: "write", add: "write", remove: "write", apply: "write", edit: "write", spawn: "write",
  delete: "write", move: "write", write: "write", attach: "write", open: "write", save: "write", compose: "write",
  play: "runtime", stop: "runtime", run: "runtime", record: "runtime", step: "runtime",
  git: "guarded", eval: "guarded", build: "guarded", launch: "guarded", publish: "guarded",
};
/** 動詞で判定できない Core 名(名詞・複合語)。名前規約の例外として明示する。 */
export const NAME_EXCEPTIONS = new Set([
  "dx12_imgui", "dx12_batch", "dx12_quality_gate", "dx12_call", "dx12_call_guarded",
  "dx12_tool_search", "dx12_tool_describe", "dx12_doctor", "dx12_guide",
  // フリート(専用エンジンの管理)。dx12_engine_<動詞>。launch は「プロセスを起動する」だが自分専用の使い捨てエンジンなので guarded ではない。
  "dx12_engine_launch", "dx12_engine_list", "dx12_engine_stop", "dx12_engine_attach", "dx12_engine_refresh", "dx12_engine_use",
  // シーケンサー(.dxseq)。名詞 1 語で、op(list / load / get / eval / edit / save / scrub / play / stop / autoplay)が副作用クラスを決める。
  "dx12_sequence",
  // ジョブ API(M6)。dx12_job_<操作>。status / cancel / result / logs は動詞規約(get / list …)に入らないので明示の例外にする。
  "dx12_job_start", "dx12_job_status", "dx12_job_cancel", "dx12_job_list", "dx12_job_result", "dx12_job_logs",
  // エディタ操作(M7)。dx12_editor_<名詞・動詞>。command(op で list / run / describe)と state(読み取り専用。get_ で始まらない名前だが、
  // 「エディタの状態」を 1 語で引ける名前を優先した)は名詞、notify / select は動詞規約(notify / select)に無い語。
  "dx12_editor_command", "dx12_editor_state", "dx12_editor_notify", "dx12_editor_select", "dx12_editor_modal",
  // 宣言的シーン生成(M11)。apply は動詞 apply で判定できるが、export は書き出し(読み取り専用)の名詞的な使い方なので明示する。
  "dx12_scene_spec_export",
]);

export function verbOf(name: string): { verb: string; cls: VerbClass } | null {
  if (NAME_EXCEPTIONS.has(name)) return null;
  const parts = name.replace(/^dx12_/, "").split("_");
  for (const cand of [parts[0], parts[parts.length - 1]]) {
    if (cand && VERB_CLASS[cand]) return { verb: cand, cls: VERB_CLASS[cand] };
  }
  return null;
}

// ── Core の一覧(tools/list の並び = shell 5 本の後にこの順) ────────────────────────────
/** 旧ツールのまま Core に入れるもの(名前・引数は旧ツールと同一。説明だけテンプレ)。 */
export const CORE_LEGACY: string[] = [
  "dx12_list_entities", "dx12_get_entity", "dx12_get_log",
  "dx12_create_entity", "dx12_spawn_model", "dx12_set_transform", "dx12_set_component", "dx12_delete_entity",
  "dx12_look_apply", "dx12_material_apply", "dx12_vfx_apply", "dx12_create_lua_component", "dx12_ui_compose",
  "dx12_play", "dx12_stop", "dx12_quality_gate",
  "dx12_open_scene", "dx12_save_scene", "dx12_batch",
];
/** 統合ツール(新規)。 */
export const CORE_CONSOLIDATED: string[] = [
  "dx12_get_render_settings", "dx12_set_render_settings", "dx12_get_perf", "dx12_capture", "dx12_edit_terrain", "dx12_imgui",
];
/**
 * エンジン直結ツール(旧ツールを持たない新ツール。core 面の tools/list に出る)。
 *   dx12_sequence {op:list|load|save|get|eval|scrub|play|stop|edit|autoplay} → エンジン method sequence_<op>(edit だけ sequence_apply_op)。
 *   実装は sequenceOps.ts(純ロジック)+ toolset/sequenceCore.ts(登録)。
 *
 * ★Core 面の上限(40 本)に収めるため、dx12_sequence を足す代わりに dx12_get_script_errors を長尾(dx12_call)へ移した。選んだ理由:
 *   (1) 頻度が最も低い: 呼ぶのは dx12_play の結果に scriptErrors>0 が出たときだけ。ログ全体は dx12_get_log で足りる。
 *   (2) dx12_call {name:"dx12_get_script_errors"} で名前・引数・返り値そのまま代替できる(旧名は恒久サポート)。
 *   (3) 引数が無い読み取り 1 本で、説明が長尾に回っても発見しやすい(dx12_tool_search「スクリプトエラー」/ 旧名)。
 *   (dx12_run_playtests / dx12_engine_attach / dx12_engine_refresh を長尾へ移した M6 と同じ作法。)
 */
export const CORE_ENGINE_DIRECT: string[] = ["dx12_sequence"];
/** shell の隣に置く、guarded 専用の実行口(core 面だけ tools/list に出る)。 */
export const CORE_GUARDED_TOOL = "dx12_call_guarded";

/**
 * フリート(専用エンジンの管理。docs/MCP_FLEET_DESIGN.md)。Core に入れるのは 2 本(launch / stop)。
 * M6 でジョブ API の 3 本を Core に入れるため、attach(手動起動のエンジンを読み取り専用で見る。頻度が最も低い)と
 * refresh(build ジョブの refreshEngines:true が「ビルド → 更新」の流れを担う)を長尾(dx12_call)へ移した。use は M3 から長尾。
 * M7 でエディタ操作の 2 本を Core に入れるため、list(launch の返り値と dx12_doctor の fleet 欄で代替できる)も長尾へ移した(下の EDITOR の注)。
 */
export const FLEET_TOOLS: string[] = ["dx12_engine_launch", "dx12_engine_list", "dx12_engine_stop", "dx12_engine_attach", "dx12_engine_refresh", "dx12_engine_use"];
export const CORE_FLEET: string[] = ["dx12_engine_launch", "dx12_engine_stop"];
export const FLEET_TOOL_SET = new Set(FLEET_TOOLS);

/**
 * ジョブ API(M6)。長い処理を裏で走らせて id を返し、ポーリング(dx12_job_status)で進捗を読む。
 * Core は start / status / cancel の 3 本。list / result / logs は長尾(dx12_call)。
 * 入れ替えの理由: dx12_run_playtests は playtest ジョブ(dx12_job_start {kind:"playtest"})が同じ回帰確認を進捗つきで担うので長尾へ
 * (設計書の M10 で dx12_playtest に統合予定の枠)。attach / refresh は上の FLEET の注を参照。
 */
export const JOB_TOOLS: string[] = ["dx12_job_start", "dx12_job_status", "dx12_job_cancel", "dx12_job_list", "dx12_job_result", "dx12_job_logs"];
export const CORE_JOBS: string[] = ["dx12_job_start", "dx12_job_status", "dx12_job_cancel"];
export const JOB_TOOL_SET = new Set(JOB_TOOLS);

/**
 * エディタ操作(M7)。エディタのコマンド表(メニュー・ショートカット・コマンドパレットと同じ。エンジンが唯一の源)を名前で実行し、
 * エディタの今の状態(選択・窓・モーダル・モード・Undo・通知)を読む。Core は command / state の 2 本。notify(人へのトースト通知)と
 * select(複数選択・クエリ選択。dx12_select_entity の上位互換)・modal(開いているモーダルを閉じる)は長尾(dx12_call)。
 *
 * ★Core 面の上限(40 本)に収めるため、この 2 本を足す代わりに dx12_play_script と dx12_engine_list を長尾(dx12_call)へ移した。選んだ理由:
 *   dx12_play_script … 入力の台本つき検証は Core の dx12_play / dx12_stop + dx12_get_log で足りる場面が大半で、頻度が低い。
 *     M10 で dx12_playtest に統合する予定の枠(dx12_run_playtests を長尾へ移した M6 と同じ作法)。dx12_call {name:'dx12_play_script'} で名前・引数・返り値そのまま使える。
 *   dx12_engine_list … dx12_engine_launch の返り値(engineId・port)と dx12_doctor の fleet 欄で代替できる。台数の上限で断られたときだけ要るので、
 *     頻度が最も低いフリートのツール(attach / refresh を長尾へ移した M6 と同じ)。
 *   オフラインの選択率(Core 面のみ recall@3 / 全ツール検索 recall@3)への影響は docs/MCP.md §0 と MCP_M7_REPORT.md の数字を参照。
 */
export const EDITOR_TOOLS: string[] = ["dx12_editor_command", "dx12_editor_state", "dx12_editor_notify", "dx12_editor_select", "dx12_editor_modal"];
export const CORE_EDITOR: string[] = ["dx12_editor_command", "dx12_editor_state"];
export const EDITOR_TOOL_SET = new Set(EDITOR_TOOLS);

/**
 * 宣言的シーン生成(M11)。仕様 JSON(SceneSpec v1)を 1 回で差分適用し、自動検証して、失敗は specPatch(そのまま撃ち直せる JSON Patch)で返す。
 * Core は dx12_apply_scene_spec の 1 本。dx12_scene_spec_export(現在のシーン → 仕様。往復の検証にも使う)は長尾(dx12_call)。
 *
 * ★Core 面の上限(40 本)に収めるため、dx12_apply_scene_spec を足す代わりに dx12_scene_write を長尾(dx12_call)へ移した。選んだ理由:
 *   (1) M3 で「dx12_apply_scene_spec(M11)が来るまでの代役」として Core に置いた本人。役目(部屋・地形・配置の一括生成)を、検証つき・差分適用・
 *       1 トランザクション・自動検証・自己修正つきの新ツールが引き継ぐ。
 *   (2) dx12_call {name:'dx12_scene_write'} で名前・引数・返り値そのまま使える(旧名は恒久サポート。生の JSON を書く用途・別ファイルへ書く用途は残る)。
 *   (3) 発見性: 「部屋を作って」「ステージ一式」「街を並べて」は dx12_apply_scene_spec が第一候補になり、dx12_scene_write は「シーン JSON を直接書く」で引ける。
 *   オフラインの選択率への影響は docs/MCP.md §0 と MCP_M11_REPORT.md の数字を参照。
 */
export const SCENE_SPEC_TOOLS: string[] = ["dx12_apply_scene_spec", "dx12_scene_spec_export"];
export const CORE_SCENE_SPEC: string[] = ["dx12_apply_scene_spec"];
export const SCENE_SPEC_TOOL_SET = new Set(SCENE_SPEC_TOOLS);

/** tools/list の並び(shell 5 本を除く)。設計書 §4.1.5 の並びに従う(フリートの 5 本は shell の直後 = 最初に使う道具)。 */
export const CORE_ORDER: string[] = [
  ...CORE_FLEET, ...CORE_JOBS,
  "dx12_list_entities", "dx12_get_entity", "dx12_get_render_settings", "dx12_set_render_settings",
  "dx12_get_log", "dx12_get_perf", "dx12_capture", "dx12_apply_scene_spec",
  "dx12_create_entity", "dx12_spawn_model", "dx12_set_transform", "dx12_set_component", "dx12_delete_entity",
  "dx12_look_apply", "dx12_material_apply", "dx12_vfx_apply", "dx12_edit_terrain", "dx12_create_lua_component",
  "dx12_ui_compose", "dx12_play", "dx12_stop", "dx12_sequence", "dx12_quality_gate",
  "dx12_imgui", ...CORE_EDITOR, "dx12_open_scene", "dx12_save_scene",
  "dx12_batch", CORE_GUARDED_TOOL,
];
/**
 * 設計書の「Core 28 本」から dx12_run_playtests を長尾へ移し(M6)、dx12_get_script_errors を長尾へ移して dx12_sequence を足し、
 * さらに dx12_play_script を長尾へ移して dx12_editor_command / dx12_editor_state を足した 28 本(M7)
 * = 上の並びから batch・call_guarded・フリート・ジョブを除いたもの。
 */
export const CORE_28: string[] = CORE_ORDER.filter((n) => n !== "dx12_batch" && n !== CORE_GUARDED_TOOL && !CORE_FLEET.includes(n) && !CORE_JOBS.includes(n));

export const CORE_LEGACY_SET = new Set(CORE_LEGACY);
export const CORE_SET = new Set(CORE_ORDER);
export const SHELL_TOOLS = ["dx12_tool_search", "dx12_tool_describe", "dx12_call", "dx12_doctor", "dx12_guide"];

// ── 統合ツールのルーティング ─────────────────────────────────────────────────────────
export type Consolidated = {
  name: string;
  /** 振り分けの引数名(target / op / view / mode)。 */
  param: string;
  /** キー → 旧ツール名。 */
  routes: Record<string, string>;
  /** true = 旧ツールの引数を values オブジェクトに入れる(描画設定)。false = 残りの引数をそのまま旧ツールへ渡す(フラット)。 */
  nested?: string;
  /** param が省略されたときの既定のキー、または引数から推測する関数。 */
  fallback?: string | ((args: Record<string, unknown>) => string | undefined);
  /** param 省略が許されるか(false なら必須)。 */
  paramRequired: boolean;
  /** 検索語(catalog の keywords に足す)。 */
  keywords: string;
  category: string;
};

const RENDER_TARGETS = ["post_process", "ssao", "ssr", "ssgi", "taa", "volumetric_fog", "shadow_pcss", "dxr", "contact_shadow", "occlusion", "depth_prepass", "normal_filter", "render_scale", "scene_settings"] as const;
export const RENDER_SETTING_TARGETS: readonly string[] = RENDER_TARGETS;

const routesOf = (prefix: string): Record<string, string> => Object.fromEntries(RENDER_TARGETS.map((t) => [t, `dx12_${prefix}_${t}`]));

export const CONSOLIDATED: Record<string, Consolidated> = {
  dx12_get_render_settings: {
    name: "dx12_get_render_settings", param: "target", routes: routesOf("get"), paramRequired: false, category: "render",
    keywords: "render settings 描画設定 ポストプロセス post process bloom tonemap exposure ssao ssr ssgi taa fog shadow dxr 現在値 読む get",
  },
  dx12_set_render_settings: {
    name: "dx12_set_render_settings", param: "target", routes: routesOf("set"), nested: "values", paramRequired: true, category: "render",
    keywords: "render settings 描画設定 ポストプロセス post process bloom tonemap exposure ssao ssr ssgi taa fog shadow dxr 調整 変更 set ブルーム 露出 影 霧 反射 環境遮蔽",
  },
  dx12_get_perf: {
    name: "dx12_get_perf", param: "mode",
    routes: { snapshot: "dx12_perf_stats", benchmark: "dx12_benchmark" },
    fallback: (a) => ("frames" in a || "uncap" in a ? "benchmark" : "snapshot"), paramRequired: false, category: "perf",
    keywords: "perf performance fps frame time ボトルネック 性能 パフォーマンス benchmark ベンチ 計測 重い gpu cpu drawcalls",
  },
  dx12_capture: {
    name: "dx12_capture", param: "view",
    routes: {
      final: "dx12_screenshot_final", scene: "dx12_screenshot", game: "dx12_screenshot_game_view", ui: "dx12_ui_screenshot",
      debug: "dx12_render_debug", texture: "dx12_view_texture", from: "dx12_screenshot_from", focus: "dx12_focus_and_screenshot",
    },
    fallback: (a) => ("position" in a || "target" in a ? "from" : "entity" in a || "name" in a ? "focus" : "mode" in a ? "debug" : "final"),
    paramRequired: false, category: "capture",
    keywords: "capture screenshot スクリーンショット スクショ 撮影 撮る キャプチャ 画像 最終画 視点 カメラ debug 中間バッファ 見た目 確認",
  },
  dx12_edit_terrain: {
    name: "dx12_edit_terrain", param: "op",
    routes: {
      create: "dx12_terrain_create", generate: "dx12_terrain_generate", sculpt: "dx12_terrain_sculpt", erode: "dx12_terrain_erode",
      paint: "dx12_terrain_paint", autopaint: "dx12_terrain_autopaint", set_layers: "dx12_terrain_set_layers",
      sculpt_create: "dx12_sculpt_create", sculpt_make_editable: "dx12_sculpt_make_editable", sculpt_brush: "dx12_sculpt_brush",
    },
    paramRequired: true, category: "terrain",
    keywords: "terrain 地形 山 丘 峡谷 heightfield sculpt スカルプト 彫る erode 浸食 paint 塗る layers レイヤー 岩 雪 草 fbm",
  },
  dx12_imgui: {
    name: "dx12_imgui", param: "op",
    routes: {
      virtual_input: "dx12_imgui_virtual_input", pointer: "dx12_imgui_pointer", key: "dx12_imgui_key",
      find: "dx12_imgui_find", screenshot: "dx12_imgui_screenshot",
    },
    paramRequired: true, category: "editor_ui",
    keywords: "imgui editor エディタ UI inspector インスペクタ パネル ウィンドウ クリック 入力 仮想入力 pointer key 値欄 window",
  },
};

export type RoutedCall =
  | { ok: true; key: string; legacy: string; legacyArgs: Record<string, unknown> }
  | { ok: false; code: "E_MISSING_PARAM" | "E_BAD_ENUM" | "E_BAD_TYPE"; message: string; param: string; validValues: string[]; didYouMean?: string; received?: unknown };

/** 統合ツールの引数 → 旧ツール名 + 旧ツールの引数。 */
export function routeConsolidated(spec: Consolidated, args: Record<string, unknown>): RoutedCall {
  const keys = Object.keys(spec.routes);
  let key = args[spec.param];
  const rest: Record<string, unknown> = { ...args };
  delete rest[spec.param];
  if (key === undefined || key === null || key === "") {
    const fb = typeof spec.fallback === "function" ? spec.fallback(rest) : spec.fallback;
    if (!fb && spec.paramRequired) {
      return { ok: false, code: "E_MISSING_PARAM", param: spec.param, validValues: keys, message: `${spec.name}: 必須の引数 '${spec.param}' が無い(${keys.join(" | ")})` };
    }
    key = fb;
  }
  if (typeof key !== "string") {
    return { ok: false, code: "E_BAD_TYPE", param: spec.param, validValues: keys, received: key, message: `${spec.name}: 引数 '${spec.param}' は文字列でなければならない(${keys.join(" | ")})` };
  }
  const k = key.trim().toLowerCase();
  const legacy = spec.routes[k] ?? spec.routes[k.replace(/^dx12_/, "")];
  if (!legacy) {
    return { ok: false, code: "E_BAD_ENUM", param: spec.param, validValues: keys, received: key, message: `${spec.name}: '${spec.param}' に ${JSON.stringify(key)} は使えない(有効な値: ${keys.join(", ")})` };
  }
  if (spec.nested) {
    const v = rest[spec.nested];
    delete rest[spec.nested];
    if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
      return { ok: false, code: "E_BAD_TYPE", param: spec.nested, validValues: [], received: v, message: `${spec.name}: '${spec.nested}' はオブジェクトでなければならない(旧ツールの引数をそのまま入れる)` };
    }
    // values が無く、その外にキーがあるとき(旧ツールの引数をフラットに渡された)は、そのまま values 扱いにする(往復を無駄にしない)。
    const merged = { ...rest, ...((v as Record<string, unknown>) ?? {}) };
    if (Object.keys(merged).length === 0) {
      return { ok: false, code: "E_MISSING_PARAM", param: spec.nested, validValues: [], message: `${spec.name}: 必須の引数 '${spec.nested}' が無い(変える値。旧ツールの引数をキー: 値で入れる)` };
    }
    return { ok: true, key: k in spec.routes ? k : k.replace(/^dx12_/, ""), legacy, legacyArgs: merged };
  }
  return { ok: true, key: k in spec.routes ? k : k.replace(/^dx12_/, ""), legacy, legacyArgs: rest };
}

/** 旧ツール名 → それを置き換える統合ツールと、その呼び方(旧引数を渡すと新しい形にして返す)。 */
export function toCoreCall(legacyName: string, legacyArgs: Record<string, unknown> = {}): { tool: string; args: Record<string, unknown> } | null {
  for (const spec of Object.values(CONSOLIDATED)) {
    for (const [key, legacy] of Object.entries(spec.routes)) {
      if (legacy !== legacyName) continue;
      if (spec.nested) return { tool: spec.name, args: { [spec.param]: key, [spec.nested]: legacyArgs } };
      if (spec.param === "mode" && key === "snapshot") return { tool: spec.name, args: { ...legacyArgs } };
      return { tool: spec.name, args: { [spec.param]: key, ...legacyArgs } };
    }
  }
  return null;
}

/** 旧名 → 置き換える統合ツール名(alias 表の統計・検索結果の replacedBy 用)。 */
export function replacedByMap(): Map<string, { tool: string; key: string }> {
  const m = new Map<string, { tool: string; key: string }>();
  for (const spec of Object.values(CONSOLIDATED)) for (const [key, legacy] of Object.entries(spec.routes)) m.set(legacy, { tool: spec.name, key });
  return m;
}

// ── 説明文テンプレ(core 面の tools/list に出る文言) ──────────────────────────────────────
export const CORE_DESCRIPTIONS: Record<string, string> = {
  dx12_list_entities:
    "開いているシーンのエンティティ一覧(entityId・name)を返す。verbose:true で componentTypes 付き、name_prefix / component_type で絞り込める。\n"
    + "使う: シーンの中身・名前・id の把握。使わない: 親子構造(→ dx12_tool_search「階層」)、1 体の詳細(→ dx12_get_entity)。\n"
    + "副作用: なし(読み取りのみ)。注意: Stop / open_scene の後は entityId が変わる(sceneGeneration で判別)。\n"
    + "返り値: {entities, count, total, sceneGeneration}。件数が既定 10000(verbose は 5000)を超えると truncated:true と nextOffset(続きは offset、全件は limit:0)。次: dx12_get_entity。",

  dx12_get_entity:
    "エンティティの全コンポーネントと値を JSON で読む(entity=id か name=完全一致)。\n"
    + "使う: 編集の前後の値の確認、コンポーネント構成の把握。使わない: 一覧(→ dx12_list_entities)、コンポーネントの型仕様(→ dx12_call {name:'dx12_describe_components'})。\n"
    + "副作用: なし。返り値: entityId・componentTypes・各コンポーネントの値・sceneGeneration。\n"
    + "次: 変更は dx12_set_component / dx12_set_transform。",

  dx12_get_render_settings:
    "描画設定(ポスト/ブルーム/トーンマップ・SSAO・SSR・SSGI・TAA・霧・影 PCSS・DXR・コンタクトシャドウ・オクルージョン・深度プリパス・法線フィルタ・レンダースケール・シーン設定)の現在値を読む。\n"
    + "使う: 設定を変える前の現在値の確認。使わない: 変更(→ dx12_set_render_settings)、雰囲気を一括で寄せる(→ dx12_look_apply)。\n"
    + "引数: target(14 種)。省略で全 target の現在値をまとめて返す。有効キーは dx12_tool_describe {name:'dx12_set_render_settings', target:'<target>'}。\n"
    + "副作用: なし。次: dx12_set_render_settings。",

  dx12_set_render_settings:
    "描画設定を 1 つ変更し、読み返した実値を返す({applied, current, mismatched?})。post process, bloom, tonemap, exposure, SSAO, SSR, fog, shadow, DXR の調整。\n"
    + "使う: 個別の値の調整。使わない: 太陽・霧・ポストを雰囲気ごと一括で当てる(→ dx12_look_apply)。\n"
    + "引数: target(post_process|ssao|ssr|ssgi|taa|volumetric_fog|shadow_pcss|dxr|contact_shadow|occlusion|depth_prepass|normal_filter|render_scale|scene_settings)と values{…}。有効キーは dx12_tool_describe {name:'dx12_set_render_settings', target:'ssao'}。\n"
    + "副作用: シーン設定を変更(Undo 可)。注意: mismatched はエンジンが丸めた/無視した値。同じ呼び出しを繰り返さない。次: dx12_capture。",

  dx12_get_log:
    "エンジンログの末尾 N 行(lines)を返す。print() の出力・エンジンの警告とエラーの確認。\n"
    + "使う: 原因不明の不具合、Play 後のエラー確認。使わない: どのスクリプトが壊れたか知りたい(→ dx12_call {name:'dx12_get_script_errors'})。\n"
    + "副作用: なし。注意: ログはエンジンの作業ディレクトリ相対で開くため、CWD が悪いと空になる。\n"
    + "次: dx12_call {name:'dx12_get_script_errors'} / 接続を疑うなら dx12_doctor。",

  dx12_get_script_errors:
    "loadError が立っている Lua スクリプトを全て返す({count, errors:[{entityId, name, scriptPath, message}]}。message は traceback 込み)。\n"
    + "使う: dx12_play の結果に scriptErrors>0 が出たとき、どのエンティティが壊れたか分からないとき。使わない: ログ全体を読む(→ dx12_get_log)。\n"
    + "副作用: なし。注意: .lua を保存し直すだけでホットリロードされ復活する(Play を止めなくてよい)。\n"
    + "次: 該当の .lua を直して再確認。",

  dx12_get_perf:
    "性能を測る。mode:'snapshot'(既定)は直近 window フレームの fps・frameMs・GPU パス別時間・drawCalls を即時取得、mode:'benchmark' は frames フレーム計測して統計を返す。\n"
    + "使う: FPS・ボトルネックの特定、最適化前後の比較。使わない: 品質全般の検査(→ dx12_quality_gate)。\n"
    + "引数: mode / window / frames / uncap。副作用: なし(計測のみ。benchmark は計測中だけ FPS 上限を外して戻す)。\n"
    + "注意: 比較は同じ条件(カメラ・シーン・Play/Editor)で。次: dx12_capture {view:'debug'} で描画の切り分け。",

  dx12_capture:
    "3D の絵を撮って PNG で返す(スクリーンショット)。view: final(既定。ポスト適用後=人が見る最終画)/ scene(ポスト前)/ game(ゲームカメラ視点)/ ui(エディタ全体)/ debug(中間バッファ。mode)/ texture(アセット画像)/ from(position+target)/ focus(entity か name に寄せる)。\n"
    + "使う: 見た目の確認は final。使わない: ImGui 込みの操作画面(→ dx12_imgui {op:'screenshot'})。\n"
    + "副作用: なし(from / focus はエディタカメラを動かす)。注意: 他のキーは view ごとの引数(dx12_tool_describe {name:'dx12_capture', target:'<view>'})。\n"
    + "次: 直すなら dx12_set_render_settings / dx12_look_apply。",

  dx12_scene_write:
    "シーン JSON をファイルへ直接書く。書く前に検証し、エラーがあれば書かずに理由を全部返す。数十体以上を一気に並べるとき用(open:true で書いた後そのまま開く)。\n"
    + "使う: 部屋・地形・配置の一括生成。使わない: 1〜数体の追加(→ dx12_create_entity / dx12_spawn_model)。\n"
    + "副作用: ファイル書込み(Undo 不可)。上書き前の内容は journal に残り、result.journal.restore(journal_restore)で戻せる。\n"
    + "注意: modelPath / scriptPath の実在を検証する。skipAssetCheck / force は必要なときだけ。次: dx12_capture・dx12_quality_gate。",

  dx12_apply_scene_spec:
    "シーン仕様 JSON(SceneSpec v1)を 1 回で差分適用し、自動検証する。entities に name・kind(box/sphere/plane/model/light/camera…)・at(m)・place(右 2m・上に載せる)・pattern(grid/ring/along/scatter)・components などを宣言する。部屋・ステージ・街並み・ショーケースの一括生成。\n"
    + "使う: 数体以上のまとまった配置、仕様の直しと再適用(同じ仕様は何も変えない=冪等)。使わない: 1〜数体の追加(→ dx12_create_entity)、生のシーン JSON(→ dx12_call {name:'dx12_scene_write'})。\n"
    + "引数: spec(または specRef + patch)・mode(plan=差分だけ / apply 既定)・verify・prune(仕様に無い物を消す。承認が要る)・async(大規模はジョブ)。\n"
    + "副作用: シーン変更(1 トランザクション。Undo 1 回で丸ごと戻る)。注意: 失敗・検証落ちは全体をロールバックし、issues[].specPatch(JSON Patch)を返す → {specRef, patch} で撃ち直す。書き方は dx12_guide {topic:'scene_spec'}。",

  dx12_scene_spec_export:
    "現在のシーンを SceneSpec(仕様 JSON)に書き出す(読み取り専用)。owned:true で、仕様が作った物だけ。座標は展開後の絶対値。\n"
    + "使う: 手で作ったシーンを仕様にして dx12_apply_scene_spec で再現・修正する、仕様 → シーン → 仕様の往復確認。使わない: シーン JSON ファイルの読み出し。\n"
    + "副作用: なし。注意: ライティング・ルック・ナビメッシュなどの設定は書き出さない。\n"
    + "次: dx12_apply_scene_spec {spec}。",

  dx12_create_entity:
    "エンティティを生成する(Editor 限定)。type は box / sphere / light_* / camera / particle_emitter / trigger / ui_* など。本物の {entityId, name, sceneGeneration} を同期で返す。\n"
    + "使う: プリミティブ・ライト・カメラ・UI 部品を 1 つずつ作る。使わない: モデル(→ dx12_spawn_model)、大量配置(→ dx12_apply_scene_spec)。\n"
    + "副作用: シーン変更(Undo 可)。idempotency_key で再試行の二重生成を防げる。注意: 細かい値は生成後に dx12_set_component / dx12_set_transform で調整。\n"
    + "ui_* は親 Canvas を自動選択/生成する。次: dx12_set_transform。",

  dx12_spawn_model:
    "モデル(.glb / .gltf / .fbx / .obj)を assets 相対パスから生成し、本物の {entityId, name, sceneGeneration} を同期で返す。\n"
    + "使う: 3D モデルを 1 つ置く。使わない: 数十個並べる(→ dx12_apply_scene_spec)、プリミティブ(→ dx12_create_entity)。\n"
    + "副作用: シーン変更(Undo 可)。idempotency_key で二重生成を防げる。\n"
    + "注意: path は assets 相対(dx12_call {name:'dx12_list_assets'} で確認)。読み込み時に大きさが正規化されることがあるので、生成後に dx12_get_entity で scale を確認。次: dx12_set_transform。",

  dx12_set_transform:
    "エンティティの Transform を設定する(指定したフィールドだけ更新)。position / rotation(Euler 度)/ quaternion / scale。entity(id) か name で指定。\n"
    + "使う: 位置・向き・大きさの変更。使わない: 他のコンポーネント(→ dx12_set_component)、床に接地(→ dx12_call {name:'dx12_snap_to_ground'})、対象へ向ける(→ dx12_call {name:'dx12_look_at'})。\n"
    + "副作用: シーン変更(Undo 可)。注意: rotation と quaternion は排他。親子ではローカル値。\n"
    + "次: dx12_get_entity で読み返す / dx12_capture。",

  dx12_set_component:
    "コンポーネントを設定する(無ければ追加、あれば置換)。component は jsonKey、data はコンポーネントごとの JSON。\n"
    + "使う: ライト強度・物理・Lua など transform 以外の値の変更、コンポーネントの追加。使わない: Transform(→ dx12_set_transform)、質感(→ dx12_material_apply)、削除(→ dx12_call {name:'dx12_remove_component'})。\n"
    + "副作用: シーン変更(Undo 可)。注意: data の形は dx12_call {name:'dx12_describe_components'} で先に確認。tags は文字列配列、DataComponent は {key:{t,v}}。\n"
    + "次: dx12_get_entity で読み返す。",

  dx12_delete_entity:
    "エンティティを子ごと削除する(entity=id か name)。{deletedEntityId, deletedCount, sceneGeneration} を同期で返す。\n"
    + "使う: 不要な物の削除。使わない: 一時的に隠すだけ(→ dx12_set_component で無効化)。\n"
    + "副作用: シーン変更(Undo 可・破壊的)。子孫も消える。\n"
    + "注意: 削除前に dx12_get_entity で対象を確認する(dx12_call {dryRun:true} で存在確認だけできる)。次: 間違えたら dx12_call {name:'dx12_undo'}。",

  dx12_look_apply:
    "雰囲気(ルック)を 1 コールで当てる: 太陽 + ボリュメトリックフォグ + 背景の強さ + ポスト約 20 項目。preset / strength(0..1。ポストにだけ効く)/ parts(['post'] など部分適用)/ dryRun。冪等で、読み返した実値と mismatched を返す。\n"
    + "使う: 夕暮れ・ホラー・ムーディなど絵作りの一括適用。使わない: 個別の値(→ dx12_set_render_settings)。\n"
    + "副作用: 太陽・フォグ・ポスト設定を変更(Undo 可)。注意: 暗いルックは光源を置いてから当てる。プリセット一覧は dx12_call {name:'dx12_look_library'}。\n"
    + "次: dx12_capture {view:'final'}。",

  dx12_material_apply:
    "PBR の 4 点(BaseColor / Normal / ORM / Height)を 1 回でエンティティへ割り当てる。dir に素材フォルダを渡すとファイル名から用途を推定する(Poly Haven 系・albedo/ORM 等)。個別指定は推定より優先。\n"
    + "使う: テクスチャ付きの質感を付ける。使わない: 単色(→ dx12_call {name:'dx12_set_color'})、数値だけ(→ dx12_call {name:'dx12_set_pbr'})。\n"
    + "副作用: シーン変更(Undo 可)。注意: metallic/roughness の数値指定が残ると ORM が無効になる(自動で解除する)。height は ignored に出る。\n"
    + "返り値: {applied, resolved, ignored, warnings, targets}。次: dx12_capture。",

  dx12_vfx_apply:
    "レシピから複数レイヤーのパーティクル演出(炎・煙・火花・爆発・魔法など)を 1 コールで組み立てる。新規エンティティを作るか、既存へ付ける。scale / rate / intensity / color / oneShot / life / dryRun で調整。\n"
    + "使う: 松明・焚き火・爆発などの VFX を置く。使わない: レイヤー単位の細かい編集(→ dx12_call {name:'dx12_add_particle_layer'})。\n"
    + "副作用: シーン変更(Undo 可)。新規生成は Editor 限定。\n"
    + "注意: 静止画 1 枚では出ているか判断できない。置いたら dx12_call {name:'dx12_vfx_preview'} で連写確認。レシピ一覧は dx12_call {name:'dx12_vfx_library'}。",

  dx12_edit_terrain:
    "地形・スカルプトを編集する。op: create / generate(fBm で高さを作り直す)/ sculpt(ブラシ)/ erode(浸食)/ paint(レイヤー塗り)/ autopaint(傾斜・標高で焼き直す)/ set_layers(.terrainlayers 割当)/ sculpt_create / sculpt_make_editable / sculpt_brush。\n"
    + "使う: 山・丘・崖・岩の生成と整形。使わない: 高さや重みの読み取り(→ dx12_call {name:'dx12_terrain_sample'})。\n"
    + "副作用: 地形データの変更(ファイル書込み・Undo 不可)。\n"
    + "注意: Editor 限定。他のキーは op ごとの引数(dx12_tool_describe {name:'dx12_edit_terrain', target:'<op>'})。次: create → generate → erode → set_layers → autopaint → paint。",

  dx12_create_lua_component:
    "Lua コンポーネント(.lua)を assets/components/ に作成する。書く前に構文検証し、エラーなら書かずに error を返す。返り値 {path}。\n"
    + "使う: 挙動・ゲームロジックのスクリプトを新規作成。使わない: 既存スクリプトの読み出し(→ dx12_call {name:'dx12_read_lua_component'})。\n"
    + "副作用: ファイル書込み(Undo 不可)。注意: 作っただけでは動かない。\n"
    + "次: dx12_call {name:'dx12_attach_lua_component'} の script に {path} を渡して貼る → dx12_play → dx12_call {name:'dx12_get_script_errors'}。",

  dx12_ui_compose:
    "役割(role)とレイアウト意図(dock / stack / grid)から、ゲーム内 UI(Canvas・UIRect・UILayout・スタイル・ボタン)をまとめて構築する。blueprint に theme / prefix / root ツリーを渡す。既存 UI は消さず、prefix 付きの新 Canvas を作る。\n"
    + "使う: タイトル画面・メニュー・HUD の作成。使わない: 部品 1 つだけ(→ dx12_create_entity {type:'ui_button'})。\n"
    + "副作用: シーン変更(Undo 可)。失敗時は作った Canvas を自動削除する。\n"
    + "次: dx12_call {name:'dx12_ui_audit'} → dx12_capture {view:'ui'} → dx12_save_scene。",

  dx12_play:
    "Editor → Playing に切り替える。{mode, sceneGeneration, scriptErrors} を同期で返す。\n"
    + "使う: 実際に動かして確認する前。使わない: 入力の台本つきで検証する(→ dx12_play_script)。\n"
    + "副作用: 実行状態が変わる(Stop で再生前のスナップショットに戻る)。\n"
    + "注意: scriptErrors>0 は Lua が死んでいる(Play 自体は成功)ので、絵を見る前に dx12_call {name:'dx12_get_script_errors'}。カメラが無いと MODE_CONFLICT。次: dx12_stop。",

  dx12_stop:
    "Playing → Editor に戻す(再生前のスナップショットに復元)。{mode, sceneGeneration} を同期で返す。\n"
    + "使う: Play の終了、Play 中の変更の破棄。\n"
    + "副作用: シーンを作り直すので全 entityId が変わる(sceneGeneration +1)。Play 中に行った変更は破棄される。\n"
    + "注意: Stop 後は古い id を使わず、name 指定か dx12_list_entities で取り直す。次: dx12_list_entities。",

  dx12_play_script:
    "入力タイムラインと合否条件を 1 コールで走らせる(dt=1/60 固定で決定論的)。steps は {t 秒, down/up/press キー, yaw 度} の配列、expect は {at|by 秒, near+radius, yAbove, yBelow, grounded, movedAtLeast}。返り値 {pass, results, trace, durationSec}(落ちたら不足量つき)。\n"
    + "使う: ゴールに届くか・ジャンプが越えるかの検証。使わない: 保存済みの回帰テスト(→ dx12_run_playtests)。\n"
    + "副作用: Play を実行する(押しっぱなしのキーは離す)。注意: yaw はマウス注入で合わせる(camera:setYaw では向かない)。次: dx12_stop。",

  dx12_sequence:
    "時間軸の演出(カメラワーク・カット・イベント)を .dxseq シーケンスで編集・評価・再生する(シーケンス/タイムライン/カットシーン/キーフレーム)。op: list / load / get / eval(非破壊で時刻の値を読む)/ edit(ops で編集)/ save / scrub(エディタ上に適用)/ play / stop / autoplay。\n"
    + "使う: 新形式 .dxseq の作成・編集・確認・再生。使わない: 台本 JSON から Lua を作る旧方式(→ dx12_call {name:'dx12_sequence_author'})。\n"
    + "副作用: op しだい(list/get/eval=なし、edit/save=ファイル、scrub/play/stop=実行状態、autoplay=シーン)。scrub は保存・Play で自動的に元へ戻る。dryRun:true は edit/save/scrub/play で実際の影響を返す。\n"
    + "注意: 引数は op ごと(dx12_tool_describe {name:'dx12_sequence', target:'<op>'})。次: eval → scrub → dx12_capture {view:'game'}。",

  dx12_run_playtests:
    "保存済みの .playtest を再生して、記録どおり動くか確かめる。落ちたら『いつ・どれだけ』ずれたかを返す(終点・経路)。name 省略で全部。\n"
    + "使う: ジャンプ力・コライダー・Lua を変えた後の回帰確認。使わない: その場の新しい検証(→ dx12_play_script)。\n"
    + "副作用: Play を実行する(シーンを開き直して再生)。注意: Editor 中に撃つ。\n"
    + "次: 落ちたら dx12_call {name:'dx12_get_script_errors'} / dx12_capture で原因を見る。",

  dx12_quality_gate:
    "作業の区切りで 1 回撃つ品質ゲート: シーン検証・配置検査(埋まり/浮き/重なり)・絵の仕上がり・UI 監査・playtests をまとめて 1 つの合否にする。返り値 {pass, blocking, keep, suggestions, uncertain, checks, next}。\n"
    + "使う: 作業の区切り、完成を主張する前。使わない: 個別の検査だけ(→ dx12_call {name:'dx12_validate_layout'} など)。\n"
    + "副作用: 検査のみ(playtests を指定したときだけシーンを開き直して再生する)。\n"
    + "注意: blocking は直すまで先へ進まない。suggestions の tool/args はそのまま撃てる。judge:false で外部の判断段を使わない。",

  dx12_imgui:
    "エディタ UI を仮想入力で操作・撮影する。op: virtual_input(仮想入力モード ON/OFF)/ find(名前で UI 要素の座標を探す)/ pointer(move・click・drag・wheel)/ key(キー・文字入力)/ screenshot(ImGui 込み)。\n"
    + "使う: エディタのパネル操作、Inspector の値入力。使わない: Play 中のゲーム入力。\n"
    + "前提: 仮想入力モード ON と --background 起動。副作用: エディタの状態を変える(実マウス・実キーボード・OS のカーソルには触れない)。\n"
    + "注意: 座標は推測せず find で得る。押す/離すは別フレーム。他のキーは op ごとの引数。次: op:'screenshot' で結果確認。",

  dx12_open_scene:
    "シーンを開く(現在のシーンを置換)。path は assets 相対。本物の {sceneName, path, entityCount, sceneGeneration} を同期で返す。\n"
    + "使う: 別シーンへの切り替え、外部で書いた JSON の読み込み。使わない: 空のシーンを新規作成(→ dx12_call {name:'dx12_new_scene'})。\n"
    + "副作用: 現在のシーンを閉じる(未保存の変更は失われうる)。\n"
    + "注意: 先に dx12_ping で sceneDirty:false を確認するか dx12_save_scene。開いた後は古い entityId が無効。次: dx12_list_entities。",

  dx12_save_scene:
    "現在のシーンを保存する。path は assets 相対(例 scenes/title.json)、省略で今開いているシーンへ上書き。{path} を返す(配置検査の要約 layout も付く)。\n"
    + "使う: 作業の区切り、シーン JSON を外部で触る前・開き直す前。使わない: JSON を丸ごと書く(→ dx12_call {name:'dx12_scene_write'})。\n"
    + "副作用: ファイル書込み(Undo 不可)。\n"
    + "注意: Play 中に撃たない(欠けたシーンが書かれることがある)。dx12_ping で mode:Editor を確認し、path は明示する。",

  dx12_batch:
    "複数の操作を順に実行して往復を減らす。ops は [{method, params}](method はエンジンの method 名で dx12_ 接頭辞なし)。既定 atomic:true はトランザクションで包み、失敗すれば丸ごとロールバック(成功時は Undo 1 回で戻る)。\n"
    + "使う: 同種の編集の連続。使わない: 数十体以上の配置(→ dx12_apply_scene_spec)、guarded な操作(→ dx12_call_guarded)。\n"
    + "副作用: 各 op の副作用に従う。注意: play / stop / open_scene / undo 系は atomic の中で使えない(省略すると自動で atomic:false)。params のキーは対応するツールと同じで、未知キーの op は実行しない。",

  // ── フリート(専用エンジンの管理) ─────────────────────────────────────────────
  dx12_engine_launch:
    "自分専用のエンジンを背景で起動し、このセッションの既定エンジンに束縛する。専用エンジンは全体で最大 3 台、10 分操作が無いと自動終了する。ポート・exe コピー・データ領域・使い捨てプロジェクトは全部別で、ビルド中でも衝突しない。\n"
    + "使う: 作業の最初(dx12_doctor がエンジン無しと言ったとき)。使わない: 手で起動済みのエンジンを見るだけ(→ dx12_engine_attach)、既存エンジンの更新(→ dx12_engine_refresh)。\n"
    + "引数: name / project(省略で使い捨て)/ mode(background 既定。headless=画面不要。visible は既定で拒否)/ scene / dpiScale。\n"
    + "副作用: プロセスを起動し約 27 MB をコピーする。窓は画面外でフォーカスを奪わない。返り値: {engineId, port, pid, dir}。次: dx12_list_entities。",

  dx12_engine_list:
    "起動中の専用エンジンの一覧(自分のもの・他のセッションのもの・孤児)と、台数・上限・空き VRAM/RAM を返す。discover:true で手動起動のエンジン(8787・8850〜8859)も探す。\n"
    + "使う: 上限で断られたとき、どのエンジンを止めるか決めるとき。使わない: 接続の診断(→ dx12_doctor)。\n"
    + "副作用: なし(孤児の回収だけ行う)。注意: 他のセッションのエンジンには ping を送らない(接続枠を奪わない)。次: dx12_engine_stop / dx12_call {name:'dx12_engine_use'}。",

  dx12_engine_stop:
    "自分の専用エンジンを止める(プロセスツリーごと終了)。engine=id / name / port、all:true で自分の全部。他のセッションのエンジンは止められない(孤児は可)。\n"
    + "使う: 作業の終わり、上限の枠を空けるとき。使わない: 最新の exe への入れ替え(→ dx12_engine_refresh)。\n"
    + "副作用: エンジンが終了する(未保存は MCP の自動保存の範囲だけ残る)。使い捨てプロジェクトは 24 時間残る。\n"
    + "注意: 閉じ忘れても 10 分で自動終了する。返り値: {stopped[]}。",

  dx12_engine_attach:
    "手で起動したエンジンや他のセッションのエンジンを読み取り専用で見る(port か engine)。effect が read の method だけ送れる。接続は最後の応答から 1.5 秒で閉じ、持ち主の接続枠を塞がない。\n"
    + "使う: 状態・シーンの確認だけしたいとき。使わない: 編集・撮影・Play(→ dx12_engine_launch で自分専用を起動)。\n"
    + "副作用: 既定エンジンの束縛を切り替える。readOnly:false は confirm:true が要る。\n"
    + "注意: 持ち主が接続中は応答が無く E_ENGINE_BUSY になる。次: dx12_list_entities。",

  dx12_engine_refresh:
    "ビルドの後に、専用エンジンの exe コピーを最新へ差し替えて、同じポート・プロジェクトで再起動する。\n"
    + "使う: ビルドの後、dx12_doctor が古い exe コピーを警告したとき(build ジョブの refreshEngines:true でも同じ)。使わない: エンジンを増やす(→ dx12_engine_launch)。\n"
    + "副作用: エンジンを再起動する(entityId は全て失効。シーンは自動保存されたものが開き直される)。\n"
    + "注意: 元の exe がビルド中なら断る(動いているエンジンは止めない)。返り値: {engineId, pid, exe}。",

  dx12_engine_use:
    "既定エンジンを切り替える(engine=id / name / port。'none' で従来の探索に戻す)。\n"
    + "使う: 自分が複数のエンジンを持っていて、向き先を切り替えるとき。使わない: 1 回だけ別のエンジンへ撃つ(→ dx12_call の engine 引数)。\n"
    + "副作用: 以後の全ツールの向き先が変わる。返り値: {bound}。次: dx12_list_entities。",

  // ── ジョブ API(M6) ─────────────────────────────────────────────────────────
  dx12_job_start:
    "長い処理(ビルド・ctest・UI テスト・複数カメラ×表示倍率のスクショ一括撮影・ベンチの繰り返し計測(中央値)・プレイテスト・cook)を裏で走らせ、即座に id を返す。kind: build / ctest / ui_tests / screenshot_batch / bench / playtest / scene_spec(大規模なシーン仕様の適用)/ vg_cook / ue_import / external。\n"
    + "使う: 2 分を超えうる処理(サブエージェントでも切れない)。使わない: 数秒で終わる操作(→ dx12_call)。external(任意のコマンド)は承認が要る。\n"
    + "引数: kind・args(kind ごと。dx12_guide {topic:'jobs'})・engine・idempotencyKey(再送で二重開始しない)・waitSec(その秒数まで待ってから返す)。\n"
    + "副作用: プロセスやエンジンを使う。build は全セッションで 1 本ずつ。次: dx12_job_status {id, waitSec:30}。",

  dx12_job_status:
    "ジョブの状態と進捗({state, progress{phase, pct, message, etaSec}, queuePosition, summary, error})を返す。waitSec を付けると終了まで(最大その秒数)待ち、変化のたびに進捗通知も送る。id 省略で動いているジョブの一覧。\n"
    + "使う: dx12_job_start の後の確認、MCP サーバを再起動した後の復元。使わない: 出力の全文(→ dx12_job_logs)、結果の全文(→ dx12_job_result)。\n"
    + "副作用: なし。注意: pct は経過時間からの見積もりのことがある(progress.estimated)。\n"
    + "次: 終わったら summary を読む。失敗は summary.errors と dx12_job_logs。",

  dx12_job_cancel:
    "ジョブをキャンセルする。走っているプロセスはツリーごと終了し(自分が起動した pid だけ)、順番待ちのジョブは開始されない。bench / playtest はエンジンの残りフレームを打ち切る。\n"
    + "使う: 不要になった・暴走したジョブの停止。使わない: 終わったジョブ(何も起きない)。\n"
    + "副作用: ジョブが cancelled になる。ビルド途中の成果物は中途半端に残りうる。他のセッションのジョブは force と承認が要る。\n"
    + "次: dx12_job_status {id}。",

  dx12_job_list:
    "ジョブの一覧(新しい順。id・kind・state・進捗)。MCP サーバ再起動前のジョブ、終わったジョブも含む。state / kind / mine で絞れる。\n"
    + "使う: id を忘れたとき、動いているジョブの確認。使わない: 1 件の詳細(→ dx12_job_status)。\n"
    + "副作用: なし。次: dx12_job_status {id} / dx12_job_result {id}。",

  dx12_job_result:
    "終わったジョブの結果の全文を返す(summary・失敗したテスト・ビルドエラー・スクショのマニフェスト・成果物のパス)。動いているジョブは E_JOB_NOT_FINISHED。\n"
    + "使う: 完了後の詳細の確認。使わない: 進捗(→ dx12_job_status)、出力の生ログ(→ dx12_job_logs)。\n"
    + "副作用: なし。注意: 結果が大きいときは要約とファイルのパスだけ返す。",

  dx12_job_logs:
    "ジョブの出力(ビルド・ctest・エンジンのログなど)の末尾 N 行を返す。実行中でも読める。\n"
    + "使う: 失敗の原因の確認、止まって見えるときの様子見。使わない: 結果の要約(→ dx12_job_status)。\n"
    + "副作用: なし。注意: 20 MB を超えた分は記録されない。tail は最大 500 行。",

  // ── エディタ操作(M7) ─────────────────────────────────────────────────────────
  dx12_editor_command:
    "エディタのコマンド(メニュー・ショートカット・コマンドパレットと同じ表)を id で実行する。op: list(一覧。いま実行できるか・理由つき)/ describe(1 件の詳細と引数)/ run(実行)。窓の開閉 window.* ・作成 create.* ・Undo/Redo・複製・ビュー・ギズモ・Play/停止など。\n"
    + "使う: ウィンドウを開く、元に戻す、エンティティを作る、表示を切り替える。使わない: 値の編集(→ dx12_set_component)、Inspector の値欄(→ dx12_imgui)、複数選択(→ dx12_call {name:'dx12_editor_select'})。\n"
    + "副作用: コマンドしだい。削除・保存の上書き・ファイルダイアログ・プロジェクトを閉じるは guarded で、E_GUARDED の fix(dx12_call_guarded)から実行する。dryRun:true で影響だけ確認できる。\n"
    + "注意: モーダルが開いていると E_MODAL_OPEN(→ dx12_editor_state で確認、dx12_call {name:'dx12_editor_modal'} で閉じる)。id は list の結果を使い、推測しない。次: dx12_editor_state で結果を確認。",

  dx12_editor_state:
    "エディタの今の状態を読む(読み取り専用)。scope: all / selection(選択)/ windows(開いているツール窓・ドック・フォーカス)/ layout / modal(モーダル・ダイアログの有無と種類)/ mode(Play・未保存・カメラ・ビューモード・背景/仮想入力)/ undo / toasts(直近の通知)/ perf。\n"
    + "使う: 操作の前後の確認、モーダルで詰まったとき、選択・未保存・Play 中かの確認。使わない: シーン内のエンティティ(→ dx12_list_entities / dx12_get_entity)、詳しい性能(→ dx12_get_perf)。\n"
    + "副作用: なし。注意: modal.blocking が true の間はエディタのコマンドが断られる。\n"
    + "次: モーダルは dx12_call {name:'dx12_editor_modal', args:{action:'dismiss'}} で閉じる(Esc では閉じない)。操作は dx12_editor_command。",

  dx12_editor_notify:
    "エディタ画面の右下にトースト通知を出す(AI から人へ。生成完了・要確認など)。message(1〜400 字)/ level(info・success・warn・error)/ seconds。\n"
    + "使う: 長い作業の完了や確認してほしい点を人へ静かに伝える。使わない: 結果をログへ残す(→ dx12_get_log)、質問して返事を待つ(トーストは一方通行)。\n"
    + "副作用: 表示のみ(シーンは変わらない)。注意: --background(画面外の窓)では人の画面には出ない。dx12_editor_state {scope:'toasts'} で出たことは確認できる。\n"
    + "次: なし。",

  dx12_editor_modal:
    "開いているモーダル / ダイアログを閉じる(キャンセルと同じ)。action: get(既定。editor_state {scope:'modal'} と同じ)/ dismiss(いちばん上の安全に閉じられるものを閉じる)。新規シーン・名前を付けて保存・新規スクリプト / シェーダーのダイアログを閉じる。\n"
    + "使う: E_MODAL_OPEN で詰まったとき、モーダルを出すコマンドを実行した後。使わない: 未保存の確認・自動保存の復旧(ボタンで選ぶ → dx12_imgui)、コマンドパレット(Esc → dx12_imgui)。\n"
    + "副作用: モーダルが閉じる(入力途中の内容は捨てられる)。注意: ImGui のモーダルは Esc では閉じない。閉じられないものは E_UNSUPPORTED、モーダルが無ければ E_NOT_FOUND。\n"
    + "次: dx12_editor_state {scope:'modal'} で閉じたか確認。",

  dx12_editor_select:
    "エディタのエンティティ選択を変える。mode: set(既定)/ add / remove / toggle / clear。names(完全一致)・entities(id)・query(名前の部分一致・* ? 可)・tag・guids で指定し、複数選択もできる。focus:true でカメラを寄せる。\n"
    + "使う: 複数選択、名前パターンでの選択、Undo・複製・削除など選択を対象にするコマンドの前。使わない: 1 体だけ選ぶ旧ツール(dx12_select_entity は残る)、選択の確認(→ dx12_editor_state {scope:'selection'})。\n"
    + "副作用: 選択状態だけ(シーンは変わらない)。注意: Stop / シーン切り替えで entityId が変わるので name 指定が安定。\n"
    + "次: dx12_editor_command で複製・グループ化などを実行。",

  dx12_call_guarded:
    "取り返しが付かない/外部に影響する操作を実行する: git commit・push・pull・checkout・merge、eval_lua(任意 Lua 実行)、delete_asset、build_game、net_launch_test_client、dx12_job_start {kind:'external'}(任意の外部プロセス)など。ユーザーが毎回承認する。\n"
    + "使う: dx12_call が E_GUARDED を返した操作。使わない: 通常の操作(→ dx12_call)。\n"
    + "引数: name・args・dryRun(true で実行せず影響だけ返す)。副作用: 破壊的または外部へ出る。\n"
    + "注意: 先に dryRun:true で影響を確認する。承認されなかった操作を繰り返さない。",
};

// ── 旧 220 の alias 表(統計・検索の replacedBy) ──────────────────────────────────────
export type AliasEntry = { legacy: string; canonical: string; via: "same" | "consolidated" | "long_tail"; call?: { tool: string; args: Record<string, unknown> } };

/** 旧ツール名の一覧から alias 表を作る。same = Core に同名で入る / consolidated = 統合ツールが置換 / long_tail = dx12_call で使う。 */
export function buildAliasTable(legacyNames: string[]): AliasEntry[] {
  const rep = replacedByMap();
  return legacyNames.map((legacy): AliasEntry => {
    if (CORE_LEGACY_SET.has(legacy)) return { legacy, canonical: legacy, via: "same" };
    const r = rep.get(legacy);
    if (r) return { legacy, canonical: r.tool, via: "consolidated", call: toCoreCall(legacy, {}) ?? undefined };
    return { legacy, canonical: legacy, via: "long_tail" };
  });
}

export function aliasStats(table: AliasEntry[]) {
  const by = { same: 0, consolidated: 0, long_tail: 0 };
  for (const e of table) by[e.via]++;
  return { total: table.length, ...by };
}

/**
 * 統合ツール経由で旧ツールを検証/実行して出たエラーの fix を、統合ツールの呼び方へ書き直す
 * (fix の tool が旧名のままでも動くが、AI が「いま使っているツール」の形で撃ち直せるようにする)。
 */
export function rewriteFixToCore<F extends { tool?: string; args?: Record<string, unknown> }>(fix: F[] | undefined, viaLegacy: string): F[] | undefined {
  if (!fix) return fix;
  return fix.map((f) => {
    if (f.tool !== viaLegacy) return f;
    const c = toCoreCall(viaLegacy, f.args ?? {});
    return c ? { ...f, tool: c.tool, args: c.args } : f;
  });
}
