// エンジン(C++)の MCP マニフェスト用データ表を吐く「一度きりのブートストラップ」生成器。
//
//   node tools/mcp-server/scripts/gen_engine_manifest.mjs <baseline_tools.json> [出力.inc] [--report]
//
//   baseline_tools.json … TS サーバの tools/list を保存した JSON（{init, tools:[{name,title,description,
//                          inputSchema,annotations}]}）。index.ts は起動しない（凍結コピーを読むだけ）。
//   出力.inc            … 既定 src/core/mcp/ApplicationMcpManifestData.inc
//   --report            … 集計と「人が見るべき曖昧な判定」の一覧を標準出力へ出す（.inc は書かない）
//
// 入力は 3 つ:
//   1. src/core/mcp/ApplicationMcp*.cpp の McpDefine（method 名・paramSpec・ハンドラ本文）
//   2. baseline_tools.json（TS ツール dx12_<m> ⇔ engine method <m> の 1:1 対応。paramGuard.ts の
//      COMPOSITE_TOOLS に載るものは合成ツールで 1:1 ではないので TS の引数/別名は使わない）
//   3. engineClient.ts の TIMEOUT_BY_METHOD（import して使う）
//
// ★生成物は「以後は直接編集してよい」。再生成すると手編集が消えるので、通常は再実行しないこと。
//   新しい method は表ではなく McpDefine(names, McpMeta, fn) の多重定義で書く（core/mcp/McpMeta.h）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const reportOnly = args.includes("--report");
const pos = args.filter((a) => !a.startsWith("--"));
if (pos.length < 1) {
  console.error("usage: gen_engine_manifest.mjs <baseline_tools.json> [out.inc] [--report]");
  process.exit(2);
}
const baselinePath = pos[0];
const outPath = pos[1] ?? path.join(root, "src", "core", "mcp", "ApplicationMcpManifestData.inc");

const { TIMEOUT_BY_METHOD, DEFAULT_TIMEOUT_MS } = await import(
  pathToFileURL(path.join(root, "tools", "mcp-server", "engineClient.ts")).href
);
const { COMPOSITE_TOOLS } = await import(
  pathToFileURL(path.join(root, "tools", "mcp-server", "paramGuard.ts")).href
);

// ── 1. エンジン側の McpDefine を抜く ─────────────────────────────────────────
function splitCallArgs(text, openIdx) {
  const a = [];
  let depth = 0, cur = "", inStr = null, esc = false, inLine = false, inBlock = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === "\n") inLine = false; cur += c; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; cur += "*/"; i++; continue; } cur += c; continue; }
    if (inStr) {
      cur += c;
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && n === "/") { inLine = true; cur += "//"; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; cur += "/*"; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if ("([{".includes(c)) { depth++; if (depth === 1) continue; cur += c; continue; }
    if (")]}".includes(c)) { depth--; if (depth === 0) { a.push(cur); return a; } cur += c; continue; }
    if (c === "," && depth === 1) { a.push(cur); cur = ""; continue; }
    cur += c;
  }
  a.push(cur);
  return a;
}
const cppLiteral = (arg) => {
  const parts = [...arg.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return parts.length ? parts.join("").replace(/\\(.)/g, "$1") : null;
};
function parseSpec(spec) {
  const out = {};
  for (const part of (spec ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    out[i < 0 ? s : s.slice(0, i)] = i < 0 ? "any" : s.slice(i + 1).trim();
  }
  return out;
}

const mcpDir = path.join(root, "src", "core", "mcp");
const engine = new Map(); // name → {file, spec|null, body, shared:boolean, order}
let order = 0;
for (const f of fs.readdirSync(mcpDir).filter((f) => /^ApplicationMcp.*\.cpp$/.test(f) && f !== "ApplicationMcpManifest.cpp").sort()) {
  const src = fs.readFileSync(path.join(mcpDir, f), "utf8");
  const re = /\bMcpDefine\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (/Application::\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const ls = src.lastIndexOf("\n", m.index) + 1;
    if (src.slice(ls, m.index).includes("//")) continue;
    const a = splitCallArgs(src, m.index + m[0].length - 1);
    if (a.length < 3) continue;
    const names = cppLiteral(a[0]);
    if (!names || !/^[a-z0-9_]+(\|[a-z0-9_]+)*$/.test(names)) continue;
    const spec = cppLiteral(a[1]);
    const body = a.slice(2).join(",");
    const list = names.split("|");
    for (const n of list) engine.set(n, { file: f, spec, body, shared: list.length > 1, order: order++ });
  }
}

// ── 2. TS ツール ───────────────────────────────────────────────────────────
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const tsTool = new Map(baseline.tools.map((t) => [t.name, t]));

// ── 3. 分類の規則 ──────────────────────────────────────────────────────────
const RENDER_SETTING = ["post_process", "ssao", "ssr", "ssgi", "taa", "dxr", "volumetric_fog", "shadow_pcss",
  "contact_shadow", "occlusion", "depth_prepass", "normal_filter", "render_scale"];

const GUARDED = new Set(["eval_lua", "delete_asset", "build_game", "net_launch_test_client"]);
const isGuarded = (n) => (n.startsWith("git_") && n !== "git_status" && n !== "git_branches") || GUARDED.has(n);
const RUNTIME = new Set(["play", "stop", "step_frames", "key_down", "key_up", "key_press", "mouse_move",
  "benchmark", "imgui_pointer", "imgui_key", "imgui_virtual_input", "ui_click"]);
const WRITE_SETTING_EXTRA = new Set(["set_editor_camera", "apply_lighting_preset", "set_sun", "set_scene_settings",
  "navmesh_settings", "navmesh_debug"]);
const WRITE_FILE = new Set(["create_lua_component", "create_shader", "import_asset", "move_asset", "save_scene",
  "create_prefab",
  "terrain_create", "terrain_generate", "terrain_sculpt", "terrain_erode", "terrain_paint", "terrain_autopaint",
  "terrain_set_layers"]);
// 判定を上書きするもの（曖昧さを表で明示する）
const EFFECT_OVERRIDE = {
  reload_scripts: "runtime", reload_assets: "runtime",
  select_entity: "write_setting", focus_camera: "write_setting", look_at: "write_setting",
  new_scene: "write_scene", open_scene: "write_scene", open_project: "write_scene",
  undo: "write_scene", redo: "write_scene",
  transaction_begin: "write_scene", transaction_commit: "write_scene", transaction_rollback: "write_scene",
  debug_human_edit: "write_scene", debug_human_undo: "write_scene",
  render_debug: "read", screenshot: "read", screenshot_final: "read", screenshot_game_view: "read",
  ui_screenshot: "read", imgui_screenshot: "read", read_texture: "read", perceive: "read",
  diagnose: "read", net_setup: "write_setting", validate_layout: "read",
};
// 「人が見るべき曖昧な判定」— 規則ではなく上書き / 推測で決めたもの
const AMBIGUOUS = new Set([
  ...Object.keys(EFFECT_OVERRIDE), "navmesh_settings", "navmesh_debug", "navmesh_build", "navmesh_clear",
  "create_prefab", "sculpt_create", "sculpt_make_editable", "sculpt_brush", "set_lua_property", "set_mesh_shader",
  "set_mesh_shader_params", "set_sprite_shader", "set_texture", "play_anim", "set_anim_param", "ui_click",
  "add_particle_layer", "remove_particle_layer", "group_entities", "snap_to_ground", "net_launch_test_client",
  "brain_state", "get_log", "get_script_errors",
]);

function categoryOf(n) {
  const rs = RENDER_SETTING.find((r) => n === `get_${r}` || n === `set_${r}`);
  if (rs) return "render";
  if (n.startsWith("terrain_") || n.startsWith("sculpt_")) return "terrain";
  if (n.startsWith("navmesh_")) return "navmesh";
  if (n.startsWith("git_")) return "git";
  if (n.startsWith("net_")) return "net";
  if (n.startsWith("imgui_")) return "editor_ui";
  if (n.startsWith("transaction_") || n === "undo" || n === "redo" || n.startsWith("debug_human_")) return "undo";
  const table = {
    entity: ["create_entity", "delete_entity", "duplicate_entity", "set_transform", "get_entity", "list_entities",
      "find_entity", "query_entities", "rename_entity", "set_parent", "group_entities", "select_entity",
      "get_hierarchy", "get_bounds", "snap_to_ground", "set_component", "remove_component", "describe_components",
      "spawn_model", "spawn_prefab", "create_prefab"],
    scene: ["get_scene_settings", "set_scene_settings", "save_scene", "open_scene", "new_scene", "list_scenes"],
    project: ["open_project", "build_game"],
    material: ["set_pbr", "set_color", "set_texture", "set_mesh_shader", "set_mesh_shader_params",
      "set_sprite_shader", "create_shader", "read_shader", "list_shader_templates", "describe_shader_contract"],
    vfx: ["list_particle_layers", "add_particle_layer", "remove_particle_layer"],
    lighting: ["list_lights", "set_sun", "apply_lighting_preset"],
    render: ["render_debug"],
    camera: ["get_editor_camera", "set_editor_camera", "focus_camera", "look_at", "project_world_to_screen"],
    lua: ["create_lua_component", "attach_lua_component", "read_lua_component", "get_lua_component_state",
      "set_lua_property", "describe_lua_api", "eval_lua", "reload_scripts", "get_script_errors"],
    ui: ["ui_click", "ui_tree", "ui_screenshot"],
    play: ["play", "stop", "get_mode", "get_play_session", "step_frames"],
    input: ["key_down", "key_up", "key_press", "mouse_move"],
    anim: ["play_anim", "get_anim_state", "set_anim_param", "describe_anim_graph"],
    audio: ["audio_state"],
    ai: ["brain_state"],
    physics: ["raycast", "raycast_precise", "overlap_box", "overlap_sphere", "get_physics_state", "pick"],
    capture: ["screenshot", "screenshot_final", "screenshot_game_view", "perceive"],
    quality: ["validate_scene", "validate_layout"],
    perf: ["perf_stats", "benchmark"],
    asset: ["import_asset", "asset_info", "reload_assets", "move_asset", "delete_asset", "list_assets", "read_texture"],
    diag: ["diagnose", "get_log"],
    meta: ["ping", "describe_mcp_params", "describe_mcp_manifest"],
  };
  for (const [cat, list] of Object.entries(table)) if (list.includes(n)) return cat;
  return null;
}

// ── 4. 要約・キーワード・引数 ──────────────────────────────────────────────
function firstSentences(desc, max = 140) {
  const text = desc.replace(/\s+/g, " ").trim();
  // 句点（。 / ". "）までを 1 文とみなす。括弧の中の句点では切らない。
  const sentences = [];
  let depth = 0, cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    cur += c;
    if ("(（[{「".includes(c)) depth++;
    else if (")）]}」".includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "。" || (c === "." && (text[i + 1] === " " || i === text.length - 1)))) {
      sentences.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) sentences.push(cur.trim());
  let out = sentences[0] ?? text;
  if (out.length > max) {
    // 1 文目が長すぎる: max 以内の最後の読点 / 空白で切って「…」を付ける（途中の語で切らない）
    let cut = -1;
    for (const ch of ["、", "，", ", ", " "]) {
      const k = out.lastIndexOf(ch, max - 1);
      if (k > 30) cut = Math.max(cut, k);
    }
    out = (cut > 0 ? out.slice(0, cut) : out.slice(0, max)).replace(/[、，,\s]+$/, "") + "…";
    return { text: out, truncated: true };
  }
  for (let i = 1; i < sentences.length; i++) {
    if ((out + sentences[i]).length <= max && out.length < 60) out += sentences[i]; else break;
  }
  return { text: out, truncated: false };
}

const shortDesc = (d) => {
  if (!d) return "";
  let t = d.replace(/\s+/g, " ").trim();
  if (t.length > 100) {
    const k = Math.max(t.lastIndexOf("。", 99), t.lastIndexOf("、", 99));
    t = (k > 30 ? t.slice(0, k + 1) : t.slice(0, 99)) + (k > 30 && t[k] === "。" ? "" : "…");
  }
  return t;
};

function jsonSchemaToParam(key, sch, required) {
  let type = "any";
  let en = null;
  if (sch.enum) { type = "enum"; en = sch.enum.map(String); }
  else if (sch.anyOf || sch.oneOf) type = "any";
  else if (sch.type === "boolean") type = "bool";
  else if (sch.type === "integer") type = key === "entity" ? "entityRef" : "int";
  else if (sch.type === "number") type = "number";
  else if (sch.type === "string") type = /assets/.test(sch.description ?? "") ? "assetPath" : "string";
  else if (sch.type === "object") type = "object";
  else if (sch.type === "array") {
    const n = sch.minItems != null && sch.minItems === sch.maxItems ? sch.minItems : null;
    const numeric = sch.items && sch.items.type === "number";
    type = numeric && (n === 2 || n === 3 || n === 4) ? `vec${n}` : "array";
  }
  return {
    name: key, type, required, enumPipe: en, min: sch.minimum ?? null, max: sch.maximum ?? null,
    def: sch.default ?? null, desc: shortDesc(sch.description),
  };
}

// ── 5. 1 method ぶんの行を作る ─────────────────────────────────────────────
function modeOf(n, body, desc) {
  const cond = [...body.matchAll(/if\s*\(\s*([^;{}]*?)\)\s*(?:\{\s*)?throw\s+McpError\s*\(\s*McpErr::ModeConflict/g)];
  let mode = "any";
  for (const c of cond) {
    const x = c[1];
    if (/busyPlaying/.test(x) && !/!\s*busyPlaying/.test(x)) mode = "editor";
    else if (/m_engineMode\s*==\s*EngineMode::Playing/.test(x)) mode = "editor";
    else if (/m_engineMode\s*!=\s*EngineMode::Editor/.test(x)) mode = "editor";
    else if (/m_engineMode\s*!=\s*EngineMode::Playing/.test(x)) mode = "playing";
  }
  const editorInDesc = /★Editor(?:\s*モード)?\s*限定/.test(desc ?? "");
  return { mode: mode !== "any" ? mode : editorInDesc ? "editor" : "any", viaBody: mode !== "any", viaDesc: editorInDesc };
}

const rows = [];
const report = { ambiguous: [], truncated: [], noTs: [], modeSource: {}, tsOnlyDropped: [] };
const names = [...engine.keys()].sort();
for (const n of names) {
  const e = engine.get(n);
  const ts = tsTool.get(`dx12_${n}`);
  const composite = ts && COMPOSITE_TOOLS.has(ts.name);
  const useTs = ts && !composite;
  const desc = ts?.description ?? "";

  // 要約
  let summary;
  if (ts) {
    const s = firstSentences(desc);
    summary = s.text;
    if (s.truncated) report.truncated.push(n);
  } else {
    summary = {
      read_texture: "テクスチャ画像を読み戻して情報（またはピクセルの統計）を返す",
      debug_human_edit: "ヘッドレス専用の検証口。人の編集を模して Transform を直接書く（Undo へ人の操作として積む）",
      debug_human_undo: "ヘッドレス専用の検証口。人の Ctrl+Z を模す",
    }[n] ?? n;
    report.noTs.push(n);
  }
  const title = ts?.title ?? "";
  const keywords = [n.split("_").join(" "), title].filter(Boolean).join(" ");

  // カテゴリ / group / target
  const category = categoryOf(n);
  if (!category) throw new Error(`category not assigned: ${n}`);
  let group = "", target = "";
  const rs = RENDER_SETTING.find((r) => n === `get_${r}` || n === `set_${r}`);
  if (rs) { group = "render_setting"; target = rs; }
  else if (n.startsWith("terrain_")) { group = "terrain"; target = n.slice("terrain_".length); }
  else if (n.startsWith("sculpt_")) { group = "sculpt"; target = n.slice("sculpt_".length); }
  else if (n.startsWith("navmesh_")) { group = "navmesh"; target = n.slice("navmesh_".length); }

  // effect
  let effect;
  const ann = useTs ? ts.annotations ?? {} : {};
  if (EFFECT_OVERRIDE[n]) effect = EFFECT_OVERRIDE[n];
  else if (isGuarded(n)) effect = "guarded";
  else if (RUNTIME.has(n)) effect = "runtime";
  else if (ann.readOnlyHint === true || (!useTs && /^(get_|list_|describe_)/.test(n)) || n === "ping") effect = "read";
  else if (WRITE_FILE.has(n)) effect = "write_file";
  else if (WRITE_SETTING_EXTRA.has(n) || RENDER_SETTING.some((r) => n === `set_${r}`)) effect = "write_setting";
  else effect = "write_scene";
  if (AMBIGUOUS.has(n)) report.ambiguous.push(`${n} → ${effect}`);

  // mode
  const md = modeOf(n, e.body, desc);
  report.modeSource[n] = md.viaBody ? "body" : md.viaDesc ? "desc" : "-";

  // deferred（ハンドラ本文で isDeferred = true にしているもの）
  const deferred = /\bisDeferred\s*=\s*true\b/.test(e.body);
  const timeoutMs = TIMEOUT_BY_METHOD[n] ?? DEFAULT_TIMEOUT_MS ?? 10000;
  const idempotent = effect === "read" || (useTs && ann.idempotentHint === true);

  // params
  const declared = e.spec != null ? parseSpec(e.spec) : null;
  const params = [];
  const seen = new Set();
  if (useTs) {
    const props = ts.inputSchema?.properties ?? {};
    const reqd = new Set(ts.inputSchema?.required ?? []);
    for (const [k, sch] of Object.entries(props)) {
      if (k === "idempotency_key" || k === "expectGeneration") continue;
      // TS 側だけが持つ引数（Jev 判定など）はエンジンが読まないので載せない。
      // ただし set_post_process / set_ssao は申告表が X マクロ生成（declared=null）なので TS を正とする。
      if (declared && !(k in declared)) { report.tsOnlyDropped.push(`${n}.${k}`); continue; }
      params.push(jsonSchemaToParam(k, sch, reqd.has(k)));
      seen.add(k);
    }
  }
  // エンジンが申告しているのに TS に無いキー（共有ハンドラの get_* は set_* 用のキー表を持つので載せない）
  const readOfShared = e.shared && effect === "read";
  if (declared && !readOfShared) {
    for (const [k, t] of Object.entries(declared)) {
      if (seen.has(k) || k === "idempotency_key") continue;
      const type = ["bool", "int", "number", "string", "vec3", "object", "any"].includes(t) ? t : "any";
      params.push({ name: k, type, required: false, enumPipe: null, min: null, max: null, def: null, desc: "" });
    }
  }

  const dryRun = params.some((p) => /^dry_?run$/i.test(p.name)) ? "native" : "none";
  const aliases = useTs ? [ts.name] : [];

  rows.push({ name: n, summary, keywords, category, group, target, effect, mode: md.mode, timeoutMs, idempotent,
    deferred, dryRun, aliases, params, file: e.file });
}

// ── 6. 出力 ─────────────────────────────────────────────────────────────────
const count = (key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {});
if (reportOnly) {
  console.log("methods:", rows.length);
  console.log("effect:", JSON.stringify(count("effect")));
  console.log("category:", JSON.stringify(count("category")));
  console.log("mode:", JSON.stringify(count("mode")));
  console.log("deferred:", rows.filter((r) => r.deferred).map((r) => r.name).join(" "));
  console.log("deferred count:", rows.filter((r) => r.deferred).length);
  console.log("dryRun native:", rows.filter((r) => r.dryRun === "native").map((r) => r.name).join(" "));
  console.log("mode!=any:", rows.filter((r) => r.mode !== "any").map((r) => `${r.name}=${r.mode}(${report.modeSource[r.name]})`).join(" "));
  console.log("ambiguous effect:", report.ambiguous.join(" | "));
  console.log("no TS tool:", report.noTs.join(" "));
  console.log("summary truncated with …:", report.truncated.join(" "));
  console.log("TS-only params dropped:", report.tsOnlyDropped.join(" "));
  for (const eff of ["read", "write_scene", "write_setting", "write_file", "runtime", "guarded"])
    console.log(`  ${eff}:`, rows.filter((r) => r.effect === eff).map((r) => r.name).join(" "));
  process.exit(0);
}

const enumName = { read: "Read", write_scene: "WriteScene", write_setting: "WriteSetting", write_file: "WriteFile",
  runtime: "Runtime", guarded: "Guarded" };
// C++ 文字列リテラル（UTF-8 のまま。MSVC は /utf-8 でビルドする）。トライグラフ回避のため ?? を分ける。
const q = (s) => {
  if (s == null) return "nullptr";
  let o = "";
  for (const ch of String(s)) {
    if (ch === "\\") o += "\\\\";
    else if (ch === '"') o += '\\"';
    else if (ch === "\n") o += "\\n";
    else if (ch === "\r") o += "\\r";
    else if (ch === "\t") o += "\\t";
    else o += ch;
  }
  return `"${o.replace(/\?\?/g, "?\\?")}"`;
};
const numLit = (v) => (v == null ? "nullptr" : q(String(v)));
const defLit = (v) => (v == null ? "nullptr" : q(JSON.stringify(v)));
const b = (v) => (v ? "true" : "false");

// MSVC の 1 リテラル 16KB 制限 (C2026) と、1 関数が巨大になるのを避けるため、
// 関数を分割し、引数は 1 要素ずつの初期化子にする。
const CHUNK = 12;
let out = "";
out += "// ★生成物。一度きりのブートストラップ。以後は直接編集してよい。再生成すると手編集が消える。\n";
out += "// 生成元: tools/mcp-server/scripts/gen_engine_manifest.mjs（TS の tools/list の凍結コピー + ApplicationMcp*.cpp の McpDefine +\n";
out += "//         engineClient.ts の TIMEOUT_BY_METHOD）。ApplicationMcpManifest.cpp の無名名前空間の中へ include される。\n";
out += "// M(summary, keywords, category, group, target, effect, mode, timeoutMs, idempotent, deferred, dryRun, aliases, params)\n";
out += "// P(name, type, required, enumPipe, min, max, default, desc)\n";
out += `// 行数: ${rows.length}\n\n`;
const chunks = [];
for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));
chunks.forEach((chunk, ci) => {
  out += `void FillManifestChunk${ci}(ManifestRows& o)\n{\n`;
  for (const r of chunk) {
    out += `    o.push_back({${q(r.name)}, M(${q(r.summary)},\n`;
    out += `        ${q(r.keywords)},\n`;
    out += `        ${q(r.category)}, ${q(r.group)}, ${q(r.target)}, McpEffect::${enumName[r.effect]}, ${q(r.mode)}, ${r.timeoutMs}, ${b(r.idempotent)}, ${b(r.deferred)},\n`;
    out += `        ${q(r.dryRun)}, ${q(r.aliases.join("|"))}, {\n`;
    for (const p of r.params) {
      if (p.enumPipe && p.enumPipe.some((v) => v.includes("|"))) throw new Error(`enum value contains '|': ${r.name}.${p.name}`);
      out += `            P(${q(p.name)}, ${q(p.type)}, ${b(p.required)}, ${p.enumPipe ? q(p.enumPipe.join("|")) : "nullptr"}, ${numLit(p.min)}, ${numLit(p.max)}, ${defLit(p.def)}, ${p.desc ? q(p.desc) : "nullptr"}),\n`;
    }
    out += "        })});\n";
  }
  out += "}\n\n";
});
out += "void FillGeneratedManifestRows(ManifestRows& o)\n{\n";
chunks.forEach((_, ci) => { out += `    FillManifestChunk${ci}(o);\n`; });
out += "}\n";
fs.writeFileSync(outPath, out.replace(/\n/g, "\r\n"), "utf8");
console.log(`wrote ${outPath} (${rows.length} rows, ${(out.length / 1024).toFixed(0)} KB)`);
