// ツールカタログ: 登録済みの TS ツール(旧 220 本 + shell)と、エンジンのマニフェストを 1 つの一覧にまとめる。
// dx12_tool_search / dx12_tool_describe / dx12_call の共通の土台。
//
//   - 旧ツール(dx12_xxx)は TS の zod スキーマ・説明が正。マニフェストに同名 method があれば
//     effect / timeout / category / mode などを足す。
//   - マニフェストにだけある method(TS ラッパ無し。新しくエンジンに足したもの)は kind:"method" として
//     そのまま載る。TS を再起動・再編集しなくても describe/call できる(再起動不要の核)。

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { EffectName, Manifest, ManifestMethod, ManifestParam } from "./manifest.ts";
import { SEARCH_HINTS, SEARCH_HINTS_EN } from "./searchHints.ts";
import { CORE_DESCRIPTIONS, CORE_SET, replacedByMap, type Consolidated } from "./coreSpec.ts";

/** マニフェストの keywords と検索語表(searchHints.ts)を合わせた語のリスト。 */
const WS = /\s+/;
function keywordsFor(bare: string, mf: ManifestMethod | undefined): string[] {
  const words = [...(mf?.keywords ?? "").split(WS), ...(SEARCH_HINTS[bare] ?? "").split(WS),
    ...(SEARCH_HINTS_EN[bare] ?? "").split(WS)].filter(Boolean);
  return [...new Set(words)];
}

export type EffectClass = "read" | "write" | "runtime" | "guarded";

export type ParamDoc = {
  name: string; type: string; required: boolean; enum?: string[];
  min?: number; max?: number; default?: unknown; desc?: string;
};

export type ToolDoc = {
  /** 検索結果の name。旧ツールは dx12_xxx、TS ラッパの無いエンジン method は method 名。 */
  id: string;
  kind: "shell" | "tool" | "method";
  tier: "shell" | "core" | "legacy" | "engine";
  title: string;
  summary: string;
  description: string;
  category: string;
  effect: EffectName;
  effectClass: EffectClass;
  mode: string;
  /** 対応するエンジン method(あれば)。 */
  method?: string;
  /** Core 面(tools/list に直接載る主力)に入っているか。旧ツールのまま入るもの・統合ツール・dx12_batch。 */
  core: boolean;
  /** Core 用の説明テンプレ(あれば。旧ツールのまま入る Core は description(旧文)とは別に持つ)。 */
  coreDescription?: string;
  /** 統合ツールなら、振り分けの引数名と旧ツールへの対応。 */
  consolidated?: { param: string; routes: Record<string, string>; nested?: string };
  /** op でエンジンの method 群を束ねたツール(dx12_sequence)の op 表。op ごとの method・副作用・引数。 */
  opTable?: OpTable;
  /** この旧ツールを置き換える統合ツール(key はその統合ツールでの target/op/view/mode)。旧名の呼び方は変わらない。 */
  replacedBy?: { tool: string; key: string };
  /** 別名。dx12_ を外した名前 / マニフェストの aliases。 */
  aliases: string[];
  keywords: string[];
  params: ParamDoc[];
  timeoutMs?: number;
  idempotent?: boolean;
  deferred?: boolean;
  dryRun: "native" | "preview" | "static" | "none";
  /** ファイルを書く前に元の内容を退避する(エンジンの journal。rollback / journal_restore で戻せる)。 */
  journal?: boolean;
  next: { tool: string; when?: string }[];
  examples: { args: Record<string, unknown>; note?: string }[];
  /** TS だけで動く合成ツール(エンジンに同名 method が無い)。 */
  composite: boolean;
  destructive?: boolean;
  source: string;
};

/** op でエンジンの method 群を束ねたツールの op 表(旧ツールを持たない Core ツール。中身は sequenceOps.ts)。 */
export type OpTable = {
  /** 振り分けの引数名(op)。 */
  param: string;
  /** 別名を正準の op 名へ(dx12_call の meta.effect / dx12_tool_describe の target で使う)。 */
  normalize?: (raw: unknown) => string | null;
  ops: Record<string, { method: string; effect: EffectName; required: string[]; optional: string[]; dryRun: string; summary: string }>;
};

/** dx12_tool_describe / dx12_call が使う、登録済み TS ツールの実体。 */
export type ToolEntry = {
  name: string;
  title: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  annotations: Record<string, unknown>;
  tier: "shell" | "core" | "legacy";
  /** Core 面に入るか(旧ツールのまま入るものも true)。 */
  core?: boolean;
  /** Core 用の説明テンプレ(core 面の tools/list に出る文言)。 */
  coreDescription?: string;
  /** 統合ツールの振り分け表。 */
  consolidated?: Consolidated;
  /** op でエンジンの method 群を束ねたツールの op 表。 */
  opTable?: OpTable;
  /** 使い方の例(検索結果・dx12_tool_describe に出る)。エンジンのマニフェストに例があればそちらが優先。 */
  examples?: { args: Record<string, unknown>; note?: string }[];
  /** 検索語(統合ツールなど、searchHints.ts に無い新ツール用)。 */
  extraKeywords?: string;
  /** マニフェストの expose:"core" から実行中に登録した動的ツール(エンジンから method が消えたら外す)。 */
  dynamic?: boolean;
  /** SDK が zod 検証した後に呼ばれる本体と同じもの(未知キー検査を含む)。 */
  invoke: (args: any) => Promise<any>;
  /** tools/list に出すか(shell モードで旧ツールを隠すときに false)。 */
  listed: boolean;
};

// ── 副作用の分類(TS 側の補助。エンジンのマニフェストに同名 method があればそちらが優先) ───────────
export const GUARDED_NAMES = new Set([
  "dx12_eval_lua", "dx12_delete_asset", "dx12_build_game", "dx12_net_launch_test_client",
  "dx12_git_checkout", "dx12_git_merge", "dx12_git_merge_abort", "dx12_git_commit",
  "dx12_git_push", "dx12_git_pull", "dx12_git_fetch",
]);
/**
 * エンジンの method ではないが、任意の Lua を走らせるので guarded と同じ扱いにする合成ツール(toolset/luaStep.ts)。
 * GUARDED_NAMES は「dx12_ + guarded な method」と 1 対 1(safety.test.ts / dx12_batch の判定が使う)なので、そこへは混ぜない。
 */
export const GUARDED_COMPOSITE_NAMES = new Set(["dx12_lua_step"]);
export function isGuardedToolName(name: string): boolean { return GUARDED_NAMES.has(name) || GUARDED_COMPOSITE_NAMES.has(name); }
const RUNTIME_NAMES = new Set([
  "dx12_play", "dx12_stop", "dx12_step_frames", "dx12_key_down", "dx12_key_up", "dx12_key_press",
  "dx12_mouse_move", "dx12_play_script", "dx12_autoplay", "dx12_record_playtest", "dx12_run_playtests",
  "dx12_measure_player", "dx12_benchmark", "dx12_quality_gate", "dx12_ui_click",
  "dx12_imgui_pointer", "dx12_imgui_key", "dx12_imgui_virtual_input",
  // M3 で見直し: 時間を進めて連写する/Play して流すツール(シーンのデータは変えないが実行状態に効く)。
  "dx12_vfx_preview", "dx12_sequence_preview",
  // フリート: プロセスの起動・停止・束縛の切替(シーンのデータは変えない。dx12_engine_list は readOnlyHint で read)。
  "dx12_engine_launch", "dx12_engine_stop", "dx12_engine_attach", "dx12_engine_refresh", "dx12_engine_use",
  // ジョブ: プロセス・エンジンを動かす / 止める(status・list・result・logs は readOnlyHint で read)。
  "dx12_job_start", "dx12_job_cancel",
]);
const WRITE_FILE_NAMES = new Set([
  "dx12_create_lua_component", "dx12_create_shader", "dx12_import_asset", "dx12_move_asset",
  "dx12_save_scene", "dx12_scene_write", "dx12_blender_ensure", "dx12_blender_export",
  "dx12_blender_material", "dx12_blender_polish", "dx12_install_font", "dx12_decal_apply",
  "dx12_sequence_author", "dx12_record_playtest", "dx12_reload_assets", "dx12_brief", "dx12_jev_ask",
]);
// M3 で見直し: screenshot_from / focus_and_screenshot / camera_path はエディタカメラを動かして撮る(シーンのデータは書かない)ので
// write_scene(=Undo に積まれる)ではなく write_setting。
const WRITE_SETTING_RE = /^dx12_(set_(post_process|ssao|ssr|ssgi|taa|dxr|volumetric_fog|shadow_pcss|contact_shadow|occlusion|depth_prepass|normal_filter|render_scale|scene_settings|sun|editor_camera)|apply_lighting_preset|look_apply|scene_env|screenshot_from|focus_and_screenshot|camera_path)$/;

/**
 * 「普段は read だが、引数によっては書く」ツール。dryRun で実行してよいかを引数つきで判定する。
 * validate_layout は fix:'safe'|'all' のとき自動修正でシーンを書き換える(dryRun で撃つと本当に直してしまう)。
 */
export const CONDITIONAL_WRITE: Record<string, (args: Record<string, unknown>) => boolean> = {
  dx12_validate_layout: (a) => a.fix === "safe" || a.fix === "all",
};

/**
 * 「普段は guarded ではないが、引数によっては guarded として扱うツール」。ゲート(dx12_call の confirm / dx12_call_guarded)の判定に引数つきで使う。
 * dx12_job_start {kind:"external"} は任意の外部プロセスを走らせる = eval_lua / build_game と同じ扱い。
 */
export const CONDITIONAL_GUARDED: Record<string, (args: Record<string, unknown>) => boolean> = {
  dx12_job_start: (a) => a.kind === "external",
  // 仕様に無いエンティティを消す適用(prune)は削除 = guarded。plan(mode:"plan" / dryRun)は誰でも撃てる。
  dx12_apply_scene_spec: (a) => a.prune === true && a.mode !== "plan" && a.dryRun !== true,
};

export function effectClassOf(effect: EffectName): EffectClass {
  if (effect === "read") return "read";
  if (effect === "runtime") return "runtime";
  if (effect === "guarded") return "guarded";
  return "write";
}

/**
 * 旧ツールの「次に使うと良いツール」の補足(旧ツールの名前・引数・説明は変えず、dx12_tool_describe の next に足すだけ)。
 * dx12_select_entity は 1 体だけ選ぶ旧ツール。複数選択・名前パターン・追加/解除・全解除は M7 の dx12_editor_select(長尾)。
 */
const EXTRA_NEXT: Record<string, { tool: string; when?: string }[]> = {
  dx12_select_entity: [{ tool: "dx12_editor_select", when: "複数選択・名前のパターン(Wall*)・タグ・追加/解除・全解除・フォーカス(1 体だけならこのツールで足りる)" }],
};

/** 統合ツールの代表の副作用(実際の呼び出しは、振り分け先の旧ツールの副作用で判定する)。 */
const CONSOLIDATED_EFFECT: Record<string, EffectName> = {
  dx12_get_render_settings: "read", dx12_set_render_settings: "write_setting", dx12_get_perf: "read",
  dx12_capture: "read", dx12_edit_terrain: "write_file", dx12_imgui: "runtime",
  // op で変わる(list/get/eval=read、load/scrub/play/stop=runtime、save/edit=write_file、autoplay=write_scene)。最も重い write_scene を代表にする。op ごとの値は opTable。
  dx12_sequence: "write_scene",
  // エディタ操作(M7)。command は op で変わる(list / describe = read、run = write_setting)ので代表は write_setting。op ごとの値は opTable。
  dx12_editor_command: "write_setting", dx12_editor_notify: "write_setting", dx12_editor_select: "write_setting", dx12_editor_modal: "write_setting",
  // 宣言的シーン生成(M11)。plan / 失敗時は何も書かない(または全体をロールバック)が、代表は write_scene。設定(lighting / look / scene / navmesh)も含む。
  dx12_apply_scene_spec: "write_scene", dx12_scene_spec_export: "read",
};

/** マニフェストに無い TS ツールの副作用を、名前と annotations から決める。 */
export function inferEffect(name: string, annotations: Record<string, unknown> | undefined): EffectName {
  if (CONSOLIDATED_EFFECT[name]) return CONSOLIDATED_EFFECT[name];
  if (isGuardedToolName(name)) return "guarded";
  if (RUNTIME_NAMES.has(name)) return "runtime";
  if (WRITE_FILE_NAMES.has(name)) return "write_file";
  if (WRITE_SETTING_RE.test(name)) return "write_setting";
  if (annotations?.readOnlyHint === true) return "read";
  return "write_scene";
}

// ── カテゴリ(マニフェストに category が無い/オフライン時の代役。規則 + 例外) ─────────────────────
const CATEGORY_RULES: [RegExp, string][] = [
  [/^(engine_)/, "fleet"], [/^(git_)/, "git"], [/^(net_)/, "net"], [/^(imgui_)/, "editor_ui"],
  [/^(terrain_|sculpt_)/, "terrain"], [/^(navmesh_|check_reachable|brain_state)/, "navmesh"],
  [/^(vfx_|.*particle_layer)/, "vfx"], [/^(look_|apply_lighting_preset|list_lights|set_sun)/, "lighting"],
  [/^(decal_)/, "decal"], [/^(sequence(_|$))/, "sequence"], [/^(blender_|model_brief|asset_gap)/, "blender"],
  [/^(jev_|brief$)/, "jev"], [/^(quality_gate|validate_|polish_audit|perceive)/, "quality"],
  [/^(screenshot|focus_and_screenshot|ui_screenshot|render_debug|camera_path|look_compare|view_texture|preview_model|pick|raycast_precise|project_world_to_screen|get_editor_camera|set_editor_camera)/, "capture"],
  [/^(ui_|install_font)/, "ui"], [/^(play|stop|step_frames|key_|mouse_move|get_play_session|record_playtest|run_playtests|autoplay|measure_player)/, "play"],
  [/^(undo|redo|transaction_|batch)/, "undo"], [/^(perf_stats|benchmark)/, "perf"],
  [/^(diagnose|ping|get_mode|get_log|get_script_errors|describe_)/, "diag"],
  [/^(list_assets|asset_info|import_asset|move_asset|delete_asset|reload_assets|read_texture)/, "asset"],
  [/^(create_lua_component|attach_lua_component|read_lua_component|get_lua_component_state|set_lua_property|reload_scripts|eval_lua|create_shader|read_shader|list_shader_templates)/, "lua"],
  [/^(get_|set_)(post_process|ssao|ssr|ssgi|taa|dxr|volumetric_fog|shadow_pcss|contact_shadow|occlusion|depth_prepass|normal_filter|render_scale)/, "render"],
  [/^(set_pbr|set_color|set_texture|material_apply|set_mesh_shader|set_sprite_shader)/, "material"],
  [/^(play_anim|get_anim_state|set_anim_param|audio_state)/, "anim"], [/^(get_physics_state|raycast|overlap_)/, "physics"],
  [/^(open_scene|new_scene|save_scene|list_scenes|scene_|organize_scene|get_scene_settings|set_scene_settings|open_project|build_game)/, "scene"],
];

export function categoryOf(name: string): string {
  const n = name.replace(/^dx12_/, "");
  for (const [re, cat] of CATEGORY_RULES) if (re.test(n)) return cat;
  return "entity";
}

// ── 説明文/スキーマの整形 ─────────────────────────────────────────────────────────────

/** 説明の先頭 1 文(検索結果の要約)。句点で切り、長すぎれば省略する。 */
export function firstSentence(desc: string, max = 140): string {
  const flat = desc.replace(/\s+/g, " ").trim();
  const m = /^(.{10,}?[。.!?！？])(?=\s|[^\x00-\x7f]|$)/.exec(flat);
  const s = m ? m[1] : flat;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function summarizeType(s: any): string {
  if (!s) return "any";
  if (s.enum) return "enum";
  if (Array.isArray(s.anyOf)) return s.anyOf.map(summarizeType).join("|");
  if (Array.isArray(s.oneOf)) return s.oneOf.map(summarizeType).join("|");
  if (s.type === "array") {
    const inner = summarizeType(s.items);
    if (s.minItems != null && s.minItems === s.maxItems) return `${inner}[${s.minItems}]`;
    return `${inner}[]`;
  }
  if (Array.isArray(s.type)) return s.type.join("|");
  return String(s.type ?? "any");
}

/** zod の shape から params を組む(SDK が tools/list に出すのと同じ JSON Schema を経由する)。 */
export function paramsFromShape(shape: Record<string, z.ZodTypeAny>): ParamDoc[] {
  let js: any;
  try {
    js = zodToJsonSchema(z.object(shape), { strictUnions: true, $refStrategy: "none" } as any);
  } catch {
    return Object.keys(shape).map((name) => ({ name, type: "any", required: false }));
  }
  const required = new Set<string>(js.required ?? []);
  const out: ParamDoc[] = [];
  for (const [name, p] of Object.entries<any>(js.properties ?? {})) {
    const d: ParamDoc = { name, type: summarizeType(p), required: required.has(name) };
    if (Array.isArray(p.enum)) d.enum = p.enum.map(String);
    else if (Array.isArray(p.anyOf)) {
      const lits = p.anyOf.filter((x: any) => Array.isArray(x.enum) || x.const !== undefined);
      if (lits.length === p.anyOf.length) d.enum = lits.flatMap((x: any) => (x.enum ?? [x.const]).map(String));
    }
    if (typeof p.minimum === "number") d.min = p.minimum;
    if (typeof p.maximum === "number") d.max = p.maximum;
    if (p.default !== undefined) d.default = p.default;
    if (typeof p.description === "string") d.desc = p.description;
    out.push(d);
  }
  return out;
}

function paramsFromManifest(ps: ManifestParam[] | undefined): ParamDoc[] {
  return (ps ?? []).map((p) => {
    const d: ParamDoc = { name: p.name, type: p.type, required: !!p.required };
    if (p.enum?.length) d.enum = p.enum;
    if (p.min != null) d.min = p.min;
    if (p.max != null) d.max = p.max;
    if (p.default !== undefined) d.default = p.default;
    if (p.desc) d.desc = p.desc;
    return d;
  });
}

/** 旧ツールの params にマニフェストの説明を補う(TS 側に説明が無い引数だけ)。 */
function mergeParams(tsParams: ParamDoc[], mf: ManifestMethod | undefined): ParamDoc[] {
  if (!mf?.params?.length) return tsParams;
  const byName = new Map(mf.params.map((p) => [p.name, p]));
  return tsParams.map((p) => {
    const m = byName.get(p.name);
    if (m?.desc && !p.desc) return { ...p, desc: m.desc };
    return p;
  });
}

// ── カタログ ────────────────────────────────────────────────────────────────────────

export class Catalog {
  docs: ToolDoc[] = [];
  private byId = new Map<string, ToolDoc>();
  private byAlias = new Map<string, ToolDoc>();

  constructor(docs: ToolDoc[]) {
    this.docs = docs;
    for (const d of docs) {
      this.byId.set(d.id.toLowerCase(), d);
      for (const a of d.aliases) if (!this.byAlias.has(a.toLowerCase())) this.byAlias.set(a.toLowerCase(), d);
      if (d.method && !this.byAlias.has(d.method.toLowerCase())) this.byAlias.set(d.method.toLowerCase(), d);
    }
  }

  /** 名前(旧ツール名 / dx12_ 無し / エンジン method 名 / 別名)から 1 件引く。大文字小文字は無視。 */
  resolve(name: string): ToolDoc | null {
    const n = String(name ?? "").trim().toLowerCase();
    if (!n) return null;
    return this.byId.get(n) ?? this.byId.get("dx12_" + n) ?? this.byAlias.get(n) ?? null;
  }

  get size() { return this.docs.length; }
  names(): string[] { return this.docs.map((d) => d.id); }
}

export function buildCatalog(
  registry: Map<string, ToolEntry>,
  manifest: Manifest | null,
): Catalog {
  const docs: ToolDoc[] = [];
  const claimed = new Set<string>();   // 旧ツールに対応済みのエンジン method 名
  const replaced = replacedByMap();

  for (const t of registry.values()) {
    const bare = t.name.replace(/^dx12_/, "");
    const mf = manifest?.methods.get(bare);
    const isShell = t.tier === "shell";
    // 対応するエンジン method: 同名 method があり、マニフェストの aliases に無関係な別ツールが居ない場合。
    const method = !isShell && mf ? bare : undefined;
    if (method) claimed.add(bare);
    const tsParams = paramsFromShape(t.shape);
    const effect: EffectName = isShell
      ? (t.name === "dx12_call" ? "write_scene" : t.name === "dx12_call_guarded" ? "guarded" : "read")
      : isGuardedToolName(t.name) ? "guarded" : (mf?.effect ?? inferEffect(t.name, t.annotations));   // guarded は TS 側の表でも守る(多層防御)
    const isCore = !isShell && (t.core === true || CORE_SET.has(t.name));
    const coreDescription = t.coreDescription ?? (isCore ? CORE_DESCRIPTIONS[t.name] : undefined);
    docs.push({
      id: t.name,
      kind: isShell ? "shell" : "tool",
      tier: t.tier,
      title: t.title,
      // Core は説明テンプレの先頭 1 文を要約にする(検索結果で最初に読まれる文)。旧ツールの説明文は description に残す。
      summary: firstSentence(coreDescription ?? t.description),
      description: t.description,
      core: isCore,
      ...(coreDescription ? { coreDescription } : {}),
      ...(t.consolidated ? { consolidated: { param: t.consolidated.param, routes: t.consolidated.routes, nested: t.consolidated.nested } } : {}),
      ...(t.opTable ? { opTable: t.opTable } : {}),
      ...(replaced.get(t.name) ? { replacedBy: replaced.get(t.name) } : {}),
      category: isShell ? "meta" : (mf?.category && mf.category !== "uncategorized" ? mf.category : categoryOf(t.name)),
      effect,
      effectClass: effectClassOf(effect),
      mode: mf?.mode ?? "any",
      method,
      aliases: [bare, ...(mf?.aliases ?? []).filter((a) => a !== t.name)],
      keywords: [...new Set([...keywordsFor(bare, mf), ...(t.extraKeywords ?? "").split(WS).filter(Boolean)])],
      params: mergeParams(tsParams, mf),
      timeoutMs: mf?.timeoutMs,
      idempotent: mf?.idempotent ?? (t.annotations?.idempotentHint === true ? true : undefined),
      deferred: mf?.deferred,
      dryRun: mf?.dryRun === "native" ? "native" : mf?.dryRun === "preview" ? "preview" : "static",
      ...(mf?.journal ? { journal: true } : {}),
      next: [...(mf?.next ?? []), ...(EXTRA_NEXT[t.name] ?? [])],
      examples: mf?.examples ?? t.examples ?? [],
      composite: !isShell && !mf,
      destructive: t.annotations?.destructiveHint === true,
      source: mf ? `ts+${mf.source ?? "manifest"}` : "ts",
    });
  }

  // TS ラッパの無いエンジン method(新しく足したもの・ラッパ未作成のもの)。
  if (manifest) {
    for (const mf of manifest.methods.values()) {
      if (claimed.has(mf.name)) continue;
      if (registry.has("dx12_" + mf.name)) continue;
      docs.push({
        id: mf.name,
        kind: "method",
        tier: "engine",
        core: false,
        title: mf.name,
        summary: mf.summary || `エンジン method ${mf.name}`,
        description: mf.summary || "",
        category: mf.category || categoryOf(mf.name),
        effect: mf.effect,
        effectClass: effectClassOf(mf.effect),
        mode: mf.mode ?? "any",
        method: mf.name,
        aliases: [...(mf.aliases ?? []), "dx12_" + mf.name],
        keywords: keywordsFor(mf.name, mf),
        params: paramsFromManifest(mf.params),
        timeoutMs: mf.timeoutMs,
        idempotent: mf.idempotent,
        deferred: mf.deferred,
        dryRun: mf.dryRun === "native" ? "native" : mf.dryRun === "preview" ? "preview" : "static",
        ...(mf.journal ? { journal: true } : {}),
        next: mf.next ?? [],
        examples: mf.examples ?? [],
        composite: false,
        source: mf.source ?? "manifest",
      });
    }
  }
  return new Catalog(docs);
}
