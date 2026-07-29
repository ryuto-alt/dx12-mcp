// エンジン(C++)と MCP スキーマのドリフト検出テスト。ネット不要・エンジン起動不要。
//
// 落ちたら直し方は 1 つ: エンジンが受け付けるようになったフィールドを index.ts の
// 該当ツールの inputSchema へ足す。足さない限り、その引数は zod に黙って捨てられ、
// set_* は {applied:true} を返し、AI は「効かない操作」を延々と繰り返す。
//
// このテストが実際に止めた事故:
//   tonemapper / godraysOn / lensflareOn / dofOn / motionBlurOn / autoExposureOn /
//   bloomKnee / bloomRadius / lut* / deband / snap_to_ground の precise。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEngineMethods, parseFieldMacro, parseStringVector, parseTsTools, zodObjectKeys,
} from "./schemaDrift.ts";
import { COMPOSITE_TOOLS, GLOBAL_PARAM_KEYS, METHOD_KEY_ALIASES } from "./paramGuard.ts";
import {
  DIAG_CHECKS, RENDER_DEBUG_MODES, RENDER_DEBUG_UNSUPPORTED,
  SCULPT_BRUSHES, SCULPT_PRIMITIVES, TERRAIN_BRUSHES, TERRAIN_PRESETS,
} from "./sceneTools.ts";
import { SCENE_ROOT_KEYS } from "./sceneWrite.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
// MCP のディスパッチ表は src/core/mcp/ApplicationMcp*.cpp へテーマ別に分割済み。
// ★1 ファイル決め打ちにすると分割された瞬間に size=0 で全滅する(実際に起きた)。
// glob で拾って連結するので、TU を新設しても勝手に追従する。行番号は連結後のものになる。
const MCP_DIR = path.join(repoRoot, "src", "core", "mcp");
const CPP_SOURCES = fs.existsSync(MCP_DIR)
  ? fs.readdirSync(MCP_DIR).filter((f) => /^ApplicationMcp.*\.cpp$/.test(f)).sort()
    .map((f) => path.join(MCP_DIR, f))
  : [];
const POST_H = path.join(repoRoot, "src", "renderer", "PostProcessSettings.h");
const INDEX_TS = path.join(here, "index.ts");

let failed = 0;
const ok = (label: string) => console.log(`  OK  ${label}`);
function check(label: string, cond: boolean, detail?: string) {
  if (cond) ok(label);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

if (CPP_SOURCES.length === 0 || !fs.existsSync(POST_H)) {
  // mcp-server だけを配布したケース。突き合わせる相手が無いので検査しない(落とさない)。
  console.log("SKIP: エンジンのソース(src/core/mcp/ApplicationMcp*.cpp)が無いのでドリフト検査は省略");
  process.exit(0);
}

const cpp = CPP_SOURCES.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const header = fs.readFileSync(POST_H, "utf8");
const indexSrc = fs.readFileSync(INDEX_TS, "utf8");

const engine = parseEngineMethods(cpp);
const tools = parseTsTools(indexSrc);

// index.ts の共通スプレッド部品 → 実キー。増えたらここに足す(足し忘れは下の [0] が気づく)。
const SPREADS: Record<string, string[]> = {
  "...entityRef": ["entity", "name"],
  // dx12_screenshot / dx12_screenshot_final の共通引数($ref 回避でファクトリにしてある)。
  "...captureParams()": ["path", "deterministic", "settleFrames"],
};

/**
 * 同じ if 分岐が 2 つの method を受けているせいで、相手側のキーまで拾ってしまう分。
 * (`method == "a" || method == "b"` の形。パーサはブロックを分けられないので両方に同じ集合が付く)
 * ★ここに書くのは「相手 method のキー」だけ。自分のキーを書くと本物のドリフトを見逃す。
 */
const SHARED_BLOCK_KEYS: Record<string, string[]> = {
  overlap_box: ["radius"],
  overlap_sphere: ["halfExtents"],
  // ApplicationMcp*.cpp(連結) `get_shadow_pcss || set_shadow_pcss`。get は引数を取らない({} が正)。
  get_shadow_pcss: [
    "enabled", "lightTanAngle", "maxPenumbraTexels", "blockerSearchTexels", "temporalDither",
  ],
  // ApplicationMcp*.cpp(連結) `get_dxr || set_dxr`。同じく get は引数を取らない。
  get_dxr: [
    "shadowEnabled", "shadowSunAngle", "shadowNormalBias", "shadowMaxDistance", "shadowIntensity",
    "aoEnabled", "aoRadius", "aoRayCount", "aoIntensity", "aoPower", "aoCombineWithSsao",
    "aoDenoise", "aoDenoiseRadius", "maxInstances", "forceBuildTlas",
    "ddgiEnabled", "ddgiSpacing", "ddgiProbeCountX", "ddgiProbeCountY", "ddgiProbeCountZ",
    "ddgiOriginX", "ddgiOriginY", "ddgiOriginZ", "ddgiRayLength", "ddgiHysteresis",
    "ddgiIntensity", "ddgiNormalBias",
  ],
  // ApplicationMcp*.cpp(連結):6358 `terrain_paint || terrain_autopaint`
  terrain_paint: [
    "rockSlopeStart", "rockSlopeEnd", "dirtSlopeStart", "dirtSlopeEnd",
    "snowHeightStart", "snowHeightEnd", "noiseStrength",
  ],
  terrain_autopaint: ["layer", "radius", "strength", "falloff", "point", "points", "worldPos"],
};

console.log("[0] パーサ自体が壊れていないこと");
check("ApplicationMcp*.cpp(連結) から MCP method を抜ける", engine.size >= 90, `size=${engine.size}`);
check("index.ts からツール定義を抜ける", tools.length >= 100, `tools=${tools.length}`);
check("代表的な method / ツールが取れている",
  engine.has("set_post_process") && engine.has("set_ssao") && engine.has("set_volumetric_fog")
  && tools.some((t) => t.tool === "dx12_set_post_process")
  && tools.some((t) => t.tool === "dx12_screenshot"));
check("スプレッドが全部 SPREADS に載っている",
  tools.every((t) => t.schemaKeys.every((k) => !k.startsWith("...") || k in SPREADS)),
  tools.flatMap((t) => t.schemaKeys.filter((k) => k.startsWith("...") && !(k in SPREADS))).join(","));
{
  // 入れ子の `if (method == "...")` を分岐の頭と誤認しないこと。誤認するとブロックが途中で切れ、
  // 前半で読んでいるキーが丸ごと落ちて【ドリフトを検出できなくなる】(terrain_paint が
  // entity/name しか持たない状態になっていた)。両 method が同じ行・同じ全部入りの集合になるのが正。
  const paint = engine.get("terrain_paint");
  const auto = engine.get("terrain_autopaint");
  check("`a || b` の分岐は 1 ブロックとして両 method に同じ集合が付く",
    paint != null && auto != null && paint.line === auto.line
    && paint.keys.includes("layer") && paint.keys.includes("rockSlopeStart"),
    `paint=${JSON.stringify(paint)} / auto=${JSON.stringify(auto)}`);

  // ★穴 1: キー名を引数で受けるローカルなラムダ経由の読み。set_volumetric_fog の
  //   `auto vec3 = [&](const char* key, ...){ ... params[key] ... }` → vec3("albedo", ...)。
  //   拾えないと albedo / ambient を TS から消してもテストが素通りする。
  const fog = engine.get("set_volumetric_fog");
  check("キー名を引数で受けるラムダ経由の読みを拾える",
    fog != null && fog.keys.includes("albedo") && fog.keys.includes("ambient"),
    `set_volumetric_fog keys=${fog?.keys.join(",")}`);

  // ★穴 2: 入れ子オブジェクト経由の読み。set_scene_settings の
  //   `const json sky = params.value("skybox", ...); sky.contains("envMapPath")`。
  const scene = engine.get("set_scene_settings");
  check("入れ子オブジェクト(skybox)の子キーを拾える",
    scene != null && (scene.nested["skybox"] ?? []).includes("envMapPath")
    && (scene.nested["skybox"] ?? []).includes("drawSkybox"),
    `set_scene_settings nested=${JSON.stringify(scene?.nested)}`);

  // ★穴 3: ディスパッチ表への移行(#30)。以前は 118 本の `else if (method == "...")` で、
  //   パーサは「最頻インデントの行が分岐の頭」という前提で読んでいた。
  //   今は McpDefine("a|b", "キー:型,...", DX12E_MCP_HANDLER {...}) の表引きなので、
  //   その前提は完全に消えている。新世代の読み方が生きていることをここで固定する。
  const usesTable = /\bMcpDefine\s*\(\s*"/.test(cpp);
  check("ApplicationMcp*.cpp(連結) はディスパッチ表(McpDefine)になっている", usesTable,
    "else-if 連鎖へ戻ったなら parseEngineMethods の旧世代フォールバックが使われる(それ自体は動く)");
  for (const m of ["get_shadow_pcss", "set_shadow_pcss", "get_dxr", "set_dxr"]) {
    check(`ディスパッチ表の "a|b" 形式も両方拾える: ${m}`, engine.has(m),
      'McpDefine("get_x|set_x", ...) の | 区切りを parseEngineMethods が展開できていない');
  }
  {
    // get/set が 1 本のハンドラなら【同じ行・同じ集合】になるのが正(片方だけなら切れている)。
    const g = engine.get("get_dxr"), s = engine.get("set_dxr");
    check("`get_dxr|set_dxr` は 1 本のハンドラとして両 method に同じ集合が付く",
      g != null && s != null && g.line === s.line
      && g.keys.includes("shadowEnabled") && g.keys.includes("forceBuildTlas"),
      `get=${JSON.stringify(g)} / set=${JSON.stringify(s)}`);
    // 他のハンドラのキーが混ざっていないこと(splitCallArgs が本文の途中で切れていない印)。
    check("ハンドラの範囲が隣へ漏れていない", s != null && !s.keys.includes("idempotency_key"),
      `set_dxr keys=${s?.keys.join(",")}`);
  }
  if (usesTable) {
    // ★McpDefine の第 2 引数は【エンジン自身が申告するキー表】で、そのまま
    //   dx12_describe_mcp_params が返す想定のもの。申告表とハンドラ本文が食い違うと
    //   「describe が嘘をつく」= AI が存在しない引数を渡す / 使える引数を知らないままになる。
    //   describe_mcp_params が着地したらテキスト解析をやめてそれを引けばよく、その時に
    //   「申告表が正しい」ことの担保がここになる。
    const lies: string[] = [];
    let specced = 0;
    for (const [name, em] of engine) {
      if (!em.declared) continue;   // McpPostParamSpec() 等、リテラルでない申告表は対象外
      specced++;
      const spec = new Set(Object.keys(em.declared).map((k) => k.split(".")[0]));
      const missing = em.keys.filter((k) => !spec.has(k));
      if (missing.length > 0) lies.push(`${name}: 本文は読むのに申告表に無い → ${missing.join(", ")}`);
    }
    check("McpDefine の申告表が 100 本以上のハンドラに付いている", specced >= 100, `specced=${specced}`);
    check("申告表とハンドラ本文が一致(describe_mcp_params が嘘をつかない)", lies.length === 0,
      lies.join("\n      "));
  }
}

const keysOf = (t: { schemaKeys: string[] }) =>
  new Set(t.schemaKeys.flatMap((k) => (k.startsWith("...") ? (SPREADS[k] ?? []) : [k])));

console.log("\n[1] dx12_<X> ツールは engine の method X と対応している");
{
  const orphans = tools
    .filter((t) => !COMPOSITE_TOOLS.has(t.tool))
    .filter((t) => !engine.has(t.tool.replace(/^dx12_/, "")))
    .map((t) => `${t.tool} (index.ts:${t.line})`);
  check("1:1 のはずのツールに対応する engine method がある", orphans.length === 0,
    `対応先が無い: ${orphans.join(", ")}\n      → 合成ツールなら paramGuard.ts の COMPOSITE_TOOLS に足す`);
}

console.log("\n[2] エンジンが受け付けるフィールド ⊇ TS スキーマ(渡せないフィールドが無い)");
{
  const drifted: string[] = [];
  for (const t of tools) {
    if (COMPOSITE_TOOLS.has(t.tool)) continue;
    const method = t.tool.replace(/^dx12_/, "");
    const em = engine.get(method);
    if (!em) continue;   // [1] が報告済み
    const declared = keysOf(t);
    const allowed = new Set<string>([
      ...GLOBAL_PARAM_KEYS,
      ...(METHOD_KEY_ALIASES[method] ?? []),
      ...(SHARED_BLOCK_KEYS[method] ?? []),
    ]);
    const missing = em.keys.filter((k) => !declared.has(k) && !allowed.has(k));
    if (missing.length > 0) {
      drifted.push(`${t.tool}: エンジンにあるのに TS スキーマに無い → ${missing.join(", ")}`
        + `  (ApplicationMcp*.cpp(連結):${em.line} / index.ts:${t.line})`);
    }
  }
  check("全ツールで取りこぼしゼロ", drifted.length === 0, drifted.join("\n      "));
}

console.log("\n[3] PostProcessSettings.h の名前表(X マクロ)と突き合わせ");
{
  const postFields = parseFieldMacro(header, "DX12E_POST_FIELDS");
  const ssaoFields = parseFieldMacro(header, "DX12E_SSAO_FIELDS");
  check("DX12E_POST_FIELDS を読めている", postFields.length >= 80, `${postFields.length} fields`);
  check("DX12E_SSAO_FIELDS を読めている", ssaoFields.length === 7, ssaoFields.join(","));

  const pp = tools.find((t) => t.tool === "dx12_set_post_process")!;
  const ppKeys = keysOf(pp);
  const missPp = postFields.filter((f) => !ppKeys.has(f));
  check("dx12_set_post_process が名前表の全フィールドを宣言している", missPp.length === 0,
    `足りない: ${missPp.join(", ")}`);

  const ssao = tools.find((t) => t.tool === "dx12_set_ssao")!;
  const ssaoKeys = keysOf(ssao);
  const missSsao = ssaoFields.filter((f) => !ssaoKeys.has(f));
  check("dx12_set_ssao が名前表の全フィールドを宣言している", missSsao.length === 0,
    `足りない: ${missSsao.join(", ")}`);

  // 名前表 ⊆ engine ハンドラ (C++ 側の取りこぼし検出。ここが落ちたらエンジンの set_post_process が
  // フィールドを 1 つ読み忘れている＝MCP からは永遠に触れない)
  const em = engine.get("set_post_process")!;
  const notHandled = postFields.filter((f) => !em.keys.includes(f));
  check("engine の set_post_process が名前表の全フィールドを読んでいる", notHandled.length === 0,
    `ApplicationMcp*.cpp(連結) が読んでいない: ${notHandled.join(", ")}`);
}

console.log("\n[4] {applied:true} を鵜呑みにせず get_* で読み返している");
{
  // エンジンが {"applied", true} しか返さない method は、それだけでは「本当に入ったか」が
  // 分からない(未知フィールドを無視しても applied:true が返る)。get_* の対がある場合は
  // 必ず読み返してから返すこと。
  const notVerified: string[] = [];
  for (const [method, em] of engine) {
    if (!em.returnsAppliedTrue) continue;
    const pair = method.startsWith("set_") ? `get_${method.slice(4)}` : null;
    if (!pair || !engine.has(pair)) continue;
    const t = tools.find((x) => x.tool === `dx12_${method}`);
    if (!t) continue;
    if (!t.methods.includes(pair)) notVerified.push(`${t.tool}(index.ts:${t.line})`);
  }
  check("applied:true を返す設定系は適用後に get_* で読み返す", notVerified.length === 0,
    `鵜呑みにしている: ${notVerified.join(", ")}`);
}

console.log("\n[5] 列挙値(sceneTools.ts の定数 ⇔ engine の表)");
{
  // 列挙は足し忘れても「黙って捨てられる」わけではない(zod が弾く / engine が有効値を返す)が、
  // エンジンに増えたブラシ等が MCP から永遠に選べない状態になるのは同じなので一緒に見る。
  const cases: [string, string, readonly string[]][] = [
    ["kTerrainPresets", "TERRAIN_PRESETS", TERRAIN_PRESETS],
    ["kTerrainBrushes", "TERRAIN_BRUSHES", TERRAIN_BRUSHES],
    ["kSculptBrushes", "SCULPT_BRUSHES", SCULPT_BRUSHES],
    ["kSculptPrims", "SCULPT_PRIMITIVES", SCULPT_PRIMITIVES],
  ];
  for (const [cppVar, tsName, tsValues] of cases) {
    const engineValues = parseStringVector(cpp, cppVar);
    if (engineValues == null) {
      check(`${cppVar} を ApplicationMcp*.cpp(連結) から読める`, false, "変数名が変わった? schemaDrift.test.ts を更新すること");
      continue;
    }
    check(`${tsName} が ${cppVar} と一致(順序込み)`,
      JSON.stringify(engineValues) === JSON.stringify([...tsValues]),
      `engine=[${engineValues.join(",")}] / ts=[${tsValues.join(",")}]`);
  }
}

console.log("\n[6] SHARED_BLOCK_KEYS が本物のドリフトを隠していないこと");
{
  // ここに自分のキーを書くと [2] が素通りしてしまう。載せていいのは「相方 method のキー」だけ。
  const leaks: string[] = [];
  for (const [method, keys] of Object.entries(SHARED_BLOCK_KEYS)) {
    const t = tools.find((x) => x.tool === `dx12_${method}`);
    if (!t) { leaks.push(`dx12_${method} が index.ts に無い`); continue; }
    const declared = keysOf(t);
    const own = keys.filter((k) => declared.has(k));
    if (own.length > 0) leaks.push(`${method}: 自分で宣言しているキーを除外している → ${own.join(", ")}`);
  }
  check("除外リストは相方 method のキーだけ", leaks.length === 0, leaks.join("\n      "));
}

console.log("\n[7] 今回追加したツールが宣言を取りこぼしていないこと");
{
  // [2] は「エンジン ⊇ TS」しか見ない(共有ブロックのぶんは除外される)ので、
  // 地形ペイント 2 本については「TS が実際に何を宣言しているか」も名指しで固定する。
  const want: Record<string, string[]> = {
    dx12_terrain_paint: ["entity", "name", "layer", "point", "points", "worldPos", "radius", "strength", "falloff"],
    dx12_terrain_autopaint: ["entity", "name", "rockSlopeStart", "rockSlopeEnd", "dirtSlopeStart",
      "dirtSlopeEnd", "snowHeightStart", "snowHeightEnd", "noiseStrength"],
  };
  for (const [tool, keys] of Object.entries(want)) {
    const t = tools.find((x) => x.tool === tool);
    if (!t) { check(`${tool} が登録されている`, false); continue; }
    const declared = keysOf(t);
    const missing = keys.filter((k) => !declared.has(k));
    check(`${tool} が engine の引数を全部宣言している`, missing.length === 0, `足りない: ${missing.join(", ")}`);
  }
  const mat = tools.find((t) => t.tool === "dx12_material_apply");
  check("dx12_material_apply が登録されている & 合成ツール扱い",
    mat != null && COMPOSITE_TOOLS.has("dx12_material_apply"));
  check("dx12_material_apply は既存 method だけで組んである(新しい C++ method を要求しない)",
    mat != null && mat.methods.every((m) => engine.has(m)) && mat.methods.length > 0,
    `methods=${mat?.methods.join(",")}`);
  check("dx12_material_apply が set_texture / set_pbr / get_entity を使う",
    mat != null && ["set_texture", "set_pbr", "get_entity"].every((m) => mat.methods.includes(m)),
    `methods=${mat?.methods.join(",")}`);
}

console.log("\n[8] 入れ子オブジェクトのフィールドもドリフトを見る(トップレベルだけでは見えない分)");
{
  // [2] はトップレベルのキーしか比べないので、skybox:{...} の中身は誰とも突き合わされていなかった。
  // エンジンが入れ子で読むキー ⊆ TS の入れ子 z.object が宣言するキー、を見る。
  const drifted: string[] = [];
  let checkedPairs = 0;
  for (const t of tools) {
    if (COMPOSITE_TOOLS.has(t.tool)) continue;
    const em = engine.get(t.tool.replace(/^dx12_/, ""));
    if (!em) continue;
    for (const [parent, kids] of Object.entries(em.nested)) {
      if (kids.length === 0) continue;
      const declared = zodObjectKeys(t.schemaSrc, parent);
      if (declared == null) {
        drifted.push(`${t.tool}: エンジンは ${parent} の中を読んでいるが TS 側が z.object で宣言していない`
          + ` → ${kids.join(", ")}  (ApplicationMcp*.cpp(連結):${em.line} / index.ts:${t.line})`);
        continue;
      }
      checkedPairs++;
      const missing = kids.filter((k) => !declared.includes(k));
      if (missing.length > 0) {
        drifted.push(`${t.tool}: ${parent} の中でエンジンにあるのに TS に無い → ${missing.join(", ")}`
          + `  (ApplicationMcp*.cpp(連結):${em.line} / index.ts:${t.line})`);
      }
    }
  }
  check("入れ子の取りこぼしゼロ", drifted.length === 0, drifted.join("\n      "));
  check("入れ子の突き合わせが 1 組以上成立している(パーサが黙って 0 件になっていない)",
    checkedPairs >= 1, `checkedPairs=${checkedPairs}`);

  // set_scene_settings のハンドラは z.object とは別に known[] を持っている(未知キー弾き用)。
  // ここがズレると「スキーマ上は有効なのにガードが弾く」ので一緒に固定する。
  const skyboxDecl = zodObjectKeys(tools.find((t) => t.tool === "dx12_set_scene_settings")!.schemaSrc, "skybox") ?? [];
  const known = indexSrc.match(/const known = \[([^\]]*)\]/);
  const knownKeys = known ? [...known[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]) : [];
  check("dx12_set_scene_settings の known[] と skybox の z.object が一致",
    JSON.stringify([...skyboxDecl].sort()) === JSON.stringify([...knownKeys].sort()),
    `z.object=[${skyboxDecl.join(",")}] / known=[${knownKeys.join(",")}]`);
}

console.log("\n[9] アニメーション系ツール(エンジンに実装済みで TS 定義が無かった分)");
{
  // エンジン側にハンドラがあるのに TS 定義が無いと、そのツールは MCP から一生呼べない。
  // [1] は「TS → エンジン」しか見ないので、逆向き(エンジン → TS)はここで名指しで押さえる。
  const want: Record<string, string[]> = {
    dx12_play_anim: ["entity", "name", "clip", "clipName", "blend", "loop", "speed", "state", "layer"],
    dx12_set_anim_param: ["entity", "name", "param", "value", "trigger"],
    dx12_describe_anim_graph: ["entity", "name", "path"],
  };
  for (const [tool, keys] of Object.entries(want)) {
    const t = tools.find((x) => x.tool === tool);
    if (!t) { check(`${tool} が登録されている`, false); continue; }
    const declared = keysOf(t);
    const missing = keys.filter((k) => !declared.has(k));
    check(`${tool} が engine の引数を全部宣言している`, missing.length === 0, `足りない: ${missing.join(", ")}`);
  }

  // ★以前ここには「エンジンが name をエンティティ名/FSM パラメータ名の二重の意味で読んでいる」
  //   前提の 2 つの見張り(entityRef を展開しないこと / 壊れたままであること)が入っていた。
  //   エンジンが param を正にして name をエンティティ名へ戻した(ApplicationMcp*.cpp(連結):5943)ので撤去し、
  //   代わりに「param が正・name はエンティティ名」を固定する検査へ置き換えた。
  const sap = tools.find((t) => t.tool === "dx12_set_anim_param");
  check("dx12_set_anim_param は param を宣言している(パラメータ名の正)",
    sap != null && sap.schemaKeys.includes("param"), `schemaKeys=${sap?.schemaKeys.join(",")}`);
  check("dx12_set_anim_param は他ツールと同じ entityRef を展開している(name = エンティティ名)",
    sap != null && sap.schemaKeys.includes("...entityRef"), `schemaKeys=${sap?.schemaKeys.join(",")}`);
  {
    // エンジン側が param を正として読み、name はエンティティ名の後方互換フォールバックである
    // ことの確認。ここが崩れたら TS の name の意味も戻す必要がある。
    // ★ハンドラの探し方はディスパッチ表(McpDefine)を前提にする。旧世代の
    //   `else if (method == "set_anim_param")` も一応見る(古いコミット用)。
    const at = [`McpDefine("set_anim_param"`, `method == "set_anim_param"`]
      .map((needle) => cpp.indexOf(needle)).find((i) => i >= 0) ?? -1;
    const body = at < 0 ? "" : cpp.slice(at, at + 2500);
    check("engine の set_anim_param は param を先に読む(name はフォールバック)",
      /params\.value\(\s*"param"/.test(body)
      && body.indexOf('params.value("param"') < body.indexOf('params.value("name"'),
      "ApplicationMcp*.cpp(連結) の set_anim_param が param を読まなくなった / name を先に見るようになった");
  }
}

console.log("\n[10] 新規ツール(エンジンに実装済みで TS 定義が無かった分)");
{
  // [1] は「TS → エンジン」しか見ないので、逆向き(エンジンにあるのに TS が無い)は名指しで押さえる。
  // 引数は ApplicationMcp*.cpp(連結) の各ハンドラを読んで写したもの(docs/MCP.md §4-2 と一致)。
  const want: Record<string, string[]> = {
    dx12_render_debug: ["mode", "frames", "gain", "depthRange", "exposure"],
    dx12_terrain_set_layers: [
      "entity", "name", "layerSetPath", "splatResolution", "autopaint", "uvScale", "heightBlendDepth",
      "triplanarSharpness", "normalStrength", "macroScale", "macroStrength", "distTilingStart",
      "distTilingFarScale", "pomHeightScale", "pomFadeStart", "pomFadeEnd",
      "triplanar", "pom", "macro", "distTiling",
    ],
    dx12_terrain_splat_info: ["entity", "name", "gridSize", "point", "points"],
    dx12_set_shadow_pcss: [
      "enabled", "lightTanAngle", "maxPenumbraTexels", "blockerSearchTexels", "temporalDither",
    ],
    dx12_get_shadow_pcss: [],
    dx12_set_dxr: [
      "shadowEnabled", "shadowSunAngle", "shadowNormalBias", "shadowMaxDistance", "shadowIntensity",
      "aoEnabled", "aoRadius", "aoRayCount", "aoIntensity", "aoPower", "aoCombineWithSsao",
      "aoDenoise", "aoDenoiseRadius", "maxInstances", "forceBuildTlas",
      "ddgiEnabled", "ddgiSpacing", "ddgiProbeCountX", "ddgiProbeCountY", "ddgiProbeCountZ",
      "ddgiOriginX", "ddgiOriginY", "ddgiOriginZ", "ddgiRayLength", "ddgiHysteresis",
      "ddgiIntensity", "ddgiNormalBias",
    ],
    dx12_get_dxr: [],
  };
  for (const [tool, keys] of Object.entries(want)) {
    const t = tools.find((x) => x.tool === tool);
    if (!t) { check(`${tool} が登録されている`, false); continue; }
    const declared = keysOf(t);
    const missing = keys.filter((k) => !declared.has(k));
    check(`${tool} が engine の引数を全部宣言している`, missing.length === 0, `足りない: ${missing.join(", ")}`);
  }

  // set_shadow_pcss は get_shadow_pcss と同じ else-if ブロックなので [4] の
  // 「{applied:true} を返す」判定に引っかからない(返すのは applied: method=="set_..." )。
  // 読み返しの流儀から外れていないことをここで名指しで固定する。
  const setPcss = tools.find((t) => t.tool === "dx12_set_shadow_pcss");
  check("dx12_set_shadow_pcss は applyAndVerify で get_shadow_pcss を読み返す",
    setPcss != null && setPcss.methods.includes("set_shadow_pcss")
    && setPcss.methods.includes("get_shadow_pcss"), `methods=${setPcss?.methods.join(",")}`);

  // set_dxr も同じ理由で [4] に引っかからない(applied は method 名で決まる)。
  // さらに DXR は「非対応 GPU では error_code:2 で必ず落ちる」経路があるので、
  //   ① applyAndVerify で読み返していること
  //   ② 撃つ前に get_dxr で supported を見て、非対応を【エラーではない結果】として返すこと
  // の 2 つを名指しで固定する。②が無いと AI が非対応環境で延々と撃ち直す。
  {
    const setDxr = tools.find((t) => t.tool === "dx12_set_dxr");
    check("dx12_set_dxr は applyAndVerify で get_dxr を読み返す",
      setDxr != null && setDxr.methods.includes("set_dxr") && setDxr.methods.includes("get_dxr"),
      `methods=${setDxr?.methods.join(",")}`);
    check("dx12_set_dxr は非対応 GPU を「正常な非対応」として返す(retryable:false)",
      /function dxrUnsupportedResult/.test(indexSrc)
      && /retryable:\s*false/.test(indexSrc)
      && /isDxrUnsupportedError/.test(indexSrc),
      "非対応 GPU の error_code:2 を素のエラーで返すと引数不正と区別が付かず、AI が撃ち直し続ける");
    check("非対応判定は error_code だけでなく message でも絞っている(引数不正を握り潰さない)",
      /does not support inline raytracing/.test(indexSrc),
      "error_code:2 は引数不正の汎用コードでもあるので、全部を非対応扱いにすると本物のバグが隠れる");
  }

  // render_debug の mode 表 ⇔ ApplicationMcp*.cpp(連結) の kEntries[]。
  // C++ は `static const DbgEntry kEntries[] = {{"off", 0}, {"normal", ...}, ...}` なので
  // parseStringVector(std::vector<std::string> 用)では拾えない。ここで直接抜く。
  {
    const at = cpp.indexOf("static const DbgEntry kEntries[]");
    const block = at < 0 ? "" : cpp.slice(at, cpp.indexOf("};", at));
    const engineModes = [...block.matchAll(/\{\s*"([A-Za-z0-9_]+)"\s*,/g)].map((m) => m[1]);
    check("ApplicationMcp*.cpp(連結) から render_debug の mode 表を読める", engineModes.length >= 16,
      `modes=${engineModes.join(",")}`);
    const sortedEngine = [...engineModes].sort();
    const sortedTs = [...RENDER_DEBUG_MODES].sort();
    check("RENDER_DEBUG_MODES が kEntries[] と一致(集合)",
      JSON.stringify(sortedEngine) === JSON.stringify(sortedTs),
      `engine=[${sortedEngine.join(",")}] / ts=[${sortedTs.join(",")}]`);
    // 非対応の 2 つは【エンジンにも無い】こと。増えたら TS の除外表を消す合図。
    for (const m of Object.keys(RENDER_DEBUG_UNSUPPORTED)) {
      check(`非対応 mode "${m}" はエンジンにも無い(実装されたら除外表を消す合図)`,
        !engineModes.includes(m),
        `ApplicationMcp*.cpp(連結) の kEntries[] に "${m}" が生えた。sceneTools.ts の RENDER_DEBUG_UNSUPPORTED から外し、`
        + "RENDER_DEBUG_MODES へ足すこと");
    }
  }
}

console.log("\n[11] エンジン側の『名前表』との突き合わせ(列挙の取りこぼし)");
{
  // (0) describe_mcp_params。エンジンが自分の引数表を返せるようになった(#30)ので、
  //     TS 側にもツールが無いと AI から引けない = 「エンジンの現物」を確かめる手段が無くなる。
  //     このテストが静的に読んでいる McpDefine の申告表と、実行時に返るものは同じ表。
  if (engine.has("describe_mcp_params")) {
    check("dx12_describe_mcp_params が登録されている(エンジンの引数表を AI から引ける)",
      tools.some((t) => t.tool === "dx12_describe_mcp_params"),
      "engine に describe_mcp_params があるのに TS ツールが無い");
  }

  // ★ここは「増えたのに TS が知らない」を拾う場所。zod で弾かれる列挙は黙って捨てられこそ
  //   しないが、エンジンに生えた検査 / パスが MCP から永遠に選べない・見えないのは同じ害。

  // (a) diagnose の only ⇔ DeepDiag::AllCheckIds()
  const DIAG_CPP = path.join(repoRoot, "src", "gui", "DeepDiagnostics.cpp");
  if (!fs.existsSync(DIAG_CPP)) {
    console.log("  --  DeepDiagnostics.cpp が無いので diagnose の検査 ID は照合しない");
  } else {
    const src = fs.readFileSync(DIAG_CPP, "utf8");
    const at = src.indexOf("DeepDiag::AllCheckIds()");
    const block = at < 0 ? "" : src.slice(at, src.indexOf("}", src.indexOf("return", at)));
    const ids = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    check("DeepDiagnostics.cpp から AllCheckIds() を読める", ids.length >= 10, `ids=${ids.join(",")}`);
    check("DIAG_CHECKS が AllCheckIds() と一致(順序込み)",
      JSON.stringify(ids) === JSON.stringify([...DIAG_CHECKS]),
      `engine=[${ids.join(",")}] / ts=[${DIAG_CHECKS.join(",")}]`);
  }

  // (b) perf_stats の gpuPassMs ⇔ GpuTimer::Name()
  //     返り値のキーはツール説明にしか書けない(engine の result は素通し)ので、
  //     「説明に全パス名が載っているか」で見る。載っていないパスは AI から存在しないのと同じ。
  const TIMER_CPP = path.join(repoRoot, "src", "graphics", "GpuTimer.cpp");
  if (!fs.existsSync(TIMER_CPP)) {
    console.log("  --  GpuTimer.cpp が無いので gpuPassMs は照合しない");
  } else {
    const names = [...fs.readFileSync(TIMER_CPP, "utf8")
      .matchAll(/case\s+[A-Za-z]+\s*:\s*return\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    check("GpuTimer.cpp からパス名を読める", names.length >= 10, `names=${names.join(",")}`);
    const perf = tools.find((t) => t.tool === "dx12_perf_stats");
    const desc = perf ? indexSrc.slice(indexSrc.indexOf('"dx12_perf_stats"'),
      indexSrc.indexOf('"dx12_perf_stats"') + 2000) : "";
    const missing = names.filter((n) => !desc.includes(n));
    check("dx12_perf_stats の説明が gpuPassMs の全パス名を挙げている", missing.length === 0,
      `説明に無い: ${missing.join(", ")}  (GpuTimer::Name が増えたら index.ts の説明にも足すこと)`);
  }
}

console.log("\n[12] シーン JSON のルートキー(SceneSerializer.cpp が書くもの ⊆ SCENE_ROOT_KEYS)");
{
  // ★取りこぼしの常習犯。contactShadow / taa / ssr / ssgi のときと、shadowPcss / raytracing の
  //   ときで計 3 回起きている。エンジン自身が保存したシーンを読んだだけで
  //   「ルートの未知キー」警告が出る = dx12_scene_write の検証が嘘をつく。
  const SER = path.join(repoRoot, "src", "scene", "SceneSerializer.cpp");
  if (!fs.existsSync(SER)) {
    console.log("  --  SceneSerializer.cpp が無いのでルートキーは照合しない");
  } else {
    const written = [...new Set([...fs.readFileSync(SER, "utf8")
      .matchAll(/\broot\s*\[\s*"([A-Za-z0-9_]+)"\s*\]\s*=/g)].map((m) => m[1]))];
    check("SceneSerializer.cpp から root[...] への書き込みを読める", written.length >= 10,
      `written=${written.join(",")}`);
    const missing = written.filter((k) => !(SCENE_ROOT_KEYS as readonly string[]).includes(k));
    check("SCENE_ROOT_KEYS がエンジンの書くルートキーを網羅している", missing.length === 0,
      `足りない: ${missing.join(", ")}  → sceneWrite.ts の SCENE_ROOT_KEYS に足すこと`);
  }
}

console.log("\n[13] 遅延同期 method のタイムアウトが engine の待ち時間に足りている");
{
  // ★ドリフトの別の形: スキーマは合っているのに【待ち時間】が合っていないと、
  //   エンジンは撮り続けているのに TS 側だけタイムアウトして「失敗」に見える。
  //   screenshot / screenshot_final の deterministic は settleFrames(最大 240)ぶん
  //   描いてから返るので、8000ms の読み取り系グループに置いてはいけない。
  const clientSrc = fs.readFileSync(path.join(here, "engineClient.ts"), "utf8");
  const timeoutOf = (m: string): number | null => {
    const hit = clientSrc.match(new RegExp(`TIMEOUT_BY_METHOD\\["${m}"\\]\\s*=\\s*(\\d+)`));
    return hit ? Number(hit[1]) : null;
  };
  // render_debug(最大 120 フレームで 60s)が先例。同じ桁を下限にする。
  const baseline = timeoutOf("render_debug") ?? 60000;
  for (const m of ["screenshot", "screenshot_final"]) {
    const t = timeoutOf(m);
    check(`${m} のタイムアウトが遅延同期に足りている(>= render_debug の ${baseline}ms)`,
      t != null && t >= baseline,
      `${m} = ${t ?? "未設定(既定 10000ms)"}  → engineClient.ts の TIMEOUT_BY_METHOD に足すこと。`
      + "deterministic:true は settleFrames(最大 240)フレーム描いてから返る");
  }
  // 8000ms の一括グループへ書き戻されていないこと(上書き順で救われている状態を許さない)。
  const fastGroup = clientSrc.slice(0, clientSrc.indexOf("]) TIMEOUT_BY_METHOD[m] = 8000;"));
  for (const m of ["screenshot", "screenshot_final"]) {
    check(`${m} が 8000ms の読み取り系グループに入っていない`,
      !new RegExp(`"${m}"`).test(fastGroup),
      `${m} が 8000ms グループに残っている`);
  }

  // ★絵を「見る/測る」ツールは最終画(ポスト後)を撮ること。ここが screenshot に戻ると
  //   「MCP の測定と目視が食い違う」問題(§6 B5)がそのまま再発する。
  //   実際の呼び出しは captureTools.test.ts が偽エンジンで見ているので、ここは
  //   「エンジン method 名が index.ts に存在するか」の静的な裏取り。
  check("index.ts が engine の screenshot_final を呼んでいる",
    /engine\.call\("screenshot_final"/.test(indexSrc),
    "screenshot_final の呼び出しが消えている");
  check("dx12_screenshot_final がツールとして登録されている",
    tools.some((t) => t.tool === "dx12_screenshot_final"),
    "index.ts に dx12_screenshot_final が無い");

  // ★assetsDir はエンジンが返す正を使う(ログからの推定ハックは撤去済み)。
  //   撤去した理由を書き残した墓標コメントには名前が残るので、コメントを剥がしてから見る。
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const liveCode = stripComments(indexSrc) + stripComments(fs.readFileSync(path.join(here, "sceneWrite.ts"), "utf8"));
  check("ログからの assetsDir 推定ハックが復活していない",
    !/assetsDirCandidatesFromLog/.test(liveCode),
    "assetsDirCandidatesFromLog が戻っている → assets の正は dx12_ping の assetsDir(protocolVersion 4)");
  check("assetsDir の解決が dx12_ping を見ている",
    /resolveAssetsDir[\s\S]{0,900}?engine\.call\("ping"/.test(indexSrc),
    "resolveAssetsDir が ping を呼んでいない");
  // エンジンが本当に ping で返しているかの裏取り(片側だけ消すと壊れる)。
  // 上限は暴走防止のためだけ。ping のハンドラにフィールドやコメントを足すと
  // すぐ届かなくなるので、handler の実長より十分広く取る（1200 では sceneDirty 追加で切れた）。
  const ping = cpp.match(/McpDefine\("ping"[\s\S]{0,2400}?\}\);/);
  check("engine の ping が assetsDir を返している",
    ping != null && /"assetsDir"/.test(ping[0]) && /"protocolVersion"\s*,\s*4/.test(ping[0]),
    "ApplicationMcp*.cpp(連結) の ping に assetsDir / protocolVersion 4 が無い");
}

console.log(failed === 0
  ? "\nOK: schemaDrift テストすべて通過"
  : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
