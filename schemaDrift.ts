// エンジン(C++)の MCP ハンドラが受け付けるフィールドと、この MCP サーバの zod スキーマが
// 宣言しているフィールドを突き合わせるための純パーサ(fs も engine も触らない)。
//
// ★なぜ要るか
//   エンジンに新しい設定フィールドが足されても TS スキーマに足し忘れると、その引数は
//   zod に黙って捨てられ、set_* は {applied:true} を返す。AI からは「効かない操作」が
//   延々と続く。実際 tonemapper / godraysOn / lensflareOn / dofOn / motionBlurOn /
//   autoExposureOn などが長期間このまま渡せなくなっていた。
//   完全自動同期までは要らないが「次に足し忘れたらテストが赤くなる」だけは必要。
//
// ★真実の情報源(2 世代ある。両方読める)
//   [新] src/core/Application.cpp のディスパッチ表:
//          McpDefine("get_dxr|set_dxr", "shadowEnabled:any,aoRadius:number,...", DX12E_MCP_HANDLER { ... });
//        第 2 引数が【エンジン自身が申告するキー表】(dx12_describe_mcp_params がそのまま返す予定のもの)。
//        以前の 118 本の `else if (method == "...")` は MSVC の C1061 上限に張り付いていたため
//        表引きへ置き換えられた(#30)。**キーはこの申告表とハンドラ本文の走査の和集合**を採る:
//          - 申告表だけ  … 本文の書き方が想定外でも拾える(= 取りこぼさない)
//          - 本文だけ    … 申告表の書き忘れがあっても拾える(= 嘘の表に騙されない)
//   [旧] HandleMcpCommand() 内 `method == "..."` の else-if 連鎖。
//        古いコミットを checkout したときのために残してある(McpDefine が 1 本も無ければこちら)。
//
//   どちらの世代でも、params から読むキーを本文から静的に拾う。現在拾える書き方は 5 通り:
//     1) params.value("k",…) / params.contains("k") / params["k"] / params.at("k") / params.find("k")
//     2) Mcp*Param(params, "k") 系ヘルパ
//     3) キー名リテラルを取らないヘルパ(ResolveMcpEntity=entity/name, ParseMcpVk=key) … 別表で補う
//     4) キー名を引数で受けるローカルなラムダ  vec3("albedo", …) → lambdaParamKeys
//     5) 入れ子オブジェクト  json sky = params.value("skybox",…); sky.contains("k") → nestedParamKeys
//   ★4 と 5 は取りこぼしていた(= その引数を TS から消してもテストが気づかなかった)。

/** engine のヘルパ関数のうち、引数にキー名リテラルを持たないもの → 実際に読むキー。 */
const IMPLICIT_HELPER_KEYS: ReadonlyArray<{ re: RegExp; keys: readonly string[] }> = [
  { re: /ResolveMcpEntity\s*\(|ResolveMcpComponentEntity\s*</, keys: ["entity", "name"] },
  { re: /ParseMcpVk\s*\(/, keys: ["key"] },
];

/** params からキーを読む書き方(Application.cpp で実際に使われている形)。 */
const PARAM_READ_PATTERNS: readonly RegExp[] = [
  /params\s*\.\s*value\(\s*"([A-Za-z0-9_]+)"/g,
  /params\s*\.\s*contains\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
  /params\s*\[\s*"([A-Za-z0-9_]+)"\s*\]/g,
  /params\s*\.\s*at\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
  /params\s*\.\s*find\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
  // McpFloatParam / McpIntParam / McpEnumParam / McpVec3Required / McpTryVec3 ...
  /\bMcp[A-Za-z0-9_]*\s*(?:<[^>()]*>\s*)?\(\s*params\s*,\s*"([A-Za-z0-9_]+)"/g,
];

export type EngineMethod = {
  /** ハンドラ本文の走査 ∪ McpDefine の申告表。 */
  keys: string[];
  line: number;
  /** ハンドラが {"applied", true} を返す＝「成功したように見えるだけ」の返り値。 */
  returnsAppliedTrue: boolean;
  /** 入れ子オブジェクトで読むキー。親キー名 → 子キー名(set_scene_settings の skybox)。 */
  nested: Record<string, string[]>;
  /**
   * McpDefine の第 2 引数(エンジン自身が申告するキー表)。キー名 → 型("number"/"int"/
   * "bool"/"string"/"vec3"/"any")。文字列リテラルで書かれていない場合(McpPostParamSpec() 等の
   * 関数呼び出し)と旧世代のソースでは null。
   * ★これは将来 dx12_describe_mcp_params が返すものと同じ。着地したらテキスト解析をやめて
   *   そちらへ移れるように、ここでも申告表を素通しで持っておく。
   */
  declared: Record<string, string> | null;
};

/**
 * ★穴 1: キー名を引数で受け取るローカルなラムダ経由の読み。
 *   set_volumetric_fog は `auto vec3 = [&](const char* key, XMFLOAT3& dst){ ... params[key] ... };`
 *   を定義して `vec3("albedo", f.albedo)` と呼ぶ。params[key] は変数添字なので
 *   PARAM_READ_PATTERNS では拾えず、albedo / ambient が【エンジンに無いキー扱い】になっていた
 *   (＝TS からこの 2 つを消してもテストが気づかない)。
 *   ブロック内で「params を自分の第 1 引数で引くラムダ」を見つけ、その呼び出し実引数を鍵として拾う。
 */
function lambdaParamKeys(body: string): string[] {
  const out: string[] = [];
  const decl = /\bauto\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[[^\]]*\]\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(body))) {
    const fn = m[1];
    // 第 1 引数の変数名(`const char* key` → key)
    const first = (m[2].split(",")[0] ?? "").match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (!first) continue;
    const kv = first[1];
    const readsParams = new RegExp(
      `params\\s*(?:\\[\\s*${kv}\\s*\\]|\\.\\s*(?:value|contains|at|find)\\s*\\(\\s*${kv}\\b)`,
    ).test(body);
    if (!readsParams) continue;
    for (const c of body.matchAll(new RegExp(`\\b${fn}\\s*\\(\\s*"([A-Za-z0-9_]+)"`, "g"))) out.push(c[1]);
  }
  return out;
}

/**
 * ★穴 2: 入れ子オブジェクト経由の読み。
 *   set_scene_settings は `const json sky = params.value("skybox", json::object());` と受けてから
 *   `sky.contains("envMapPath")` で中を読む。トップレベルには "skybox" しか現れないので、
 *   中身のフィールド(envMapPath / iblIntensity / …)は【誰とも突き合わされていなかった】。
 *   `json NAME = params.value("親"...)` / `params["親"]` を見つけて NAME 経由の読みを子キーにする。
 */
function nestedParamKeys(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const decl =
    /\b(?:const\s+)?(?:nlohmann::)?(?:json|auto)\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*params\s*(?:\.\s*value\s*\(\s*"([A-Za-z0-9_]+)"|\[\s*"([A-Za-z0-9_]+)"\s*\])/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(body))) {
    const varName = m[1];
    const parent = m[2] ?? m[3];
    const kids = new Set<string>();
    const reads = [
      new RegExp(`\\b${varName}\\s*\\.\\s*(?:value|contains|at|find)\\s*\\(\\s*"([A-Za-z0-9_]+)"`, "g"),
      new RegExp(`\\b${varName}\\s*\\[\\s*"([A-Za-z0-9_]+)"\\s*\\]`, "g"),
    ];
    for (const r of reads) for (const c of body.matchAll(r)) kids.add(c[1]);
    if (kids.size > 0) out[parent] = [...(out[parent] ?? []), ...kids].filter((v, i, a) => a.indexOf(v) === i).sort();
  }
  return out;
}

/** ハンドラ本文 1 つ分からキー / 入れ子 / applied を抜く(新旧の世代で共通)。 */
function scanHandlerBody(body: string) {
  const keys = new Set<string>();
  for (const p of PARAM_READ_PATTERNS) {
    p.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.exec(body))) keys.add(m[1]);
  }
  for (const h of IMPLICIT_HELPER_KEYS) if (h.re.test(body)) for (const key of h.keys) keys.add(key);
  for (const key of lambdaParamKeys(body)) keys.add(key);
  return {
    keys,
    nested: nestedParamKeys(body),
    returnsAppliedTrue: /\{\s*"applied"\s*,\s*true\s*\}/.test(body),
  };
}

/**
 * 隣接した C++ 文字列リテラルを 1 本に繋ぐ("a" "b" → "ab")。
 * リテラルが 1 つも無い(= McpPostParamSpec() のような関数呼び出し)なら null。
 */
function cppStringLiteral(arg: string): string | null {
  const parts = [...arg.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (parts.length === 0) return null;
  return parts.join("").replace(/\\(.)/g, "$1");
}

/** "a:number,b:any" → {a:"number", b:"any"}。空文字("" = 引数なし)は {}。 */
function parseParamSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(":");
    out[i < 0 ? s : s.slice(0, i)] = i < 0 ? "any" : s.slice(i + 1).trim();
  }
  return out;
}

/**
 * [新世代] ディスパッチ表 McpDefine("a|b", "キー:型,...", DX12E_MCP_HANDLER { ... }) を読む。
 * McpDefine が 1 本も無ければ null(呼び出し側が旧世代のパーサへ落ちる)。
 */
function parseMcpDefineTable(cppSource: string): Map<string, EngineMethod> | null {
  const out = new Map<string, EngineMethod>();
  const re = /\bMcpDefine\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cppSource))) {
    // 宣言側 (void Application::McpDefine(...)) は読まない
    if (/Application::\s*$/.test(cppSource.slice(Math.max(0, m.index - 20), m.index))) continue;
    // ★行コメントの中の例(「McpDefine("名前", "キー:型,...", ...) を 1 本足す」)を拾わない。
    //   拾うと "名前" という架空の method が生えて [1] の逆引きが嘘をつく。
    const lineStart = cppSource.lastIndexOf("\n", m.index) + 1;
    if (cppSource.slice(lineStart, m.index).includes("//")) continue;
    const open = m.index + m[0].length - 1;
    const args = splitCallArgs(cppSource, open);
    if (args.length < 3) continue;
    const names = cppStringLiteral(args[0]);
    // method 名は英小文字/数字/_ と、get/set をまとめる '|' だけ(コメント例や日本語を弾く保険)。
    if (!names || !/^[a-z0-9_]+(\|[a-z0-9_]+)*$/.test(names)) continue;
    const spec = cppStringLiteral(args[1]);
    const body = args.slice(2).join(",");
    const scanned = scanHandlerBody(body);
    const declared = spec == null ? null : parseParamSpec(spec);
    // ★和集合。申告表(describe_mcp_params が返すもの)と本文のどちらに出てきても
    //   「エンジンが受け付けるキー」として扱う＝どちらの書き忘れでも取りこぼさない。
    const keys = new Set(scanned.keys);
    const nested: Record<string, string[]> = { ...scanned.nested };
    for (const k of Object.keys(declared ?? {})) {
      // 申告表は入れ子を "skybox.envMapPath" のドット表記で書く。トップレベルの
      // 突き合わせ([2])に混ぜると「TS に無いキー」の誤検出になるので、入れ子表([8])へ送る。
      const dot = k.indexOf(".");
      if (dot < 0) { keys.add(k); continue; }
      const [parent, child] = [k.slice(0, dot), k.slice(dot + 1)];
      keys.add(parent);
      nested[parent] = [...new Set([...(nested[parent] ?? []), child])].sort();
    }
    const line = cppSource.slice(0, m.index).split("\n").length;
    for (const name of names.split("|").map((s) => s.trim()).filter(Boolean)) {
      out.set(name, {
        keys: [...keys].sort(), line,
        returnsAppliedTrue: scanned.returnsAppliedTrue, nested, declared,
      });
    }
  }
  return out.size > 0 ? out : null;
}

/**
 * Application.cpp から「method 名 → 受け付ける params キー」を抜く。
 * 同じハンドラが複数 method を受ける場合(get_dxr|set_dxr)は両方に同じ集合を割り当てる。
 *
 * ★まずディスパッチ表(McpDefine)を読み、無ければ旧世代の else-if 連鎖を読む。
 *   旧世代の注意点(古いコミットを見るときのため残す): ハンドラは 1 関数ではなく、
 *   C1061 対策で切り出された受け皿関数(HandleMcpRenderCommand)の分岐はインデントが浅い。
 *   「最頻インデントの行だけを分岐の頭」とすると切り出し先が丸ごと落ちるので、
 *   インデントではなく【入れ子関係】で頭かどうかを決める(下の isInnerRecheck)。
 */
export function parseEngineMethods(cppSource: string): Map<string, EngineMethod> {
  const table = parseMcpDefineTable(cppSource);
  if (table) return table;
  const lines = cppSource.split(/\r?\n/);
  const all: { line: number; names: string[]; indent: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /(?:^|\s)(?:else\s+)?if\s*\(method\s*==\s*"([a-z0-9_]+)"(?:\s*\|\|\s*method\s*==\s*"([a-z0-9_]+)")?\s*\)/,
    );
    if (m) {
      all.push({
        line: i,
        names: [m[1], m[2]].filter(Boolean) as string[],
        indent: (lines[i].match(/^[ \t]*/) as RegExpMatchArray)[0].length,
      });
    }
  }
  // ★入れ子の `if (method == "...")` を分岐の頭と誤認しない。
  //   1 ブロックで 2 method を捌く所は中でもう一度 method を見る
  //   (get_dxr||set_dxr の中の set_dxr / overlap_box||overlap_sphere / terrain_paint||terrain_autopaint)。
  //   これを頭と数えるとブロックが途中で切れ、前半のキーが落ちて【ドリフトを見逃す】。
  //   見分け方: 「直前の頭より深いインデント」かつ「名前が直前の頭の名前の部分集合」なら中の再判定。
  //   インデントの絶対値には依らないので、分岐が複数の関数へ散っても壊れない。
  const heads: typeof all = [];
  for (const h of all) {
    const cur = heads[heads.length - 1];
    const isInnerRecheck = cur != null && h.indent > cur.indent
      && h.names.every((n) => cur.names.includes(n));
    if (!isInnerRecheck) heads.push(h);
  }
  const out = new Map<string, EngineMethod>();
  for (let k = 0; k < heads.length; k++) {
    const from = heads[k].line;
    let to = k + 1 < heads.length ? heads[k + 1].line : lines.length;
    // ★関数の閉じ括弧(桁 0 の '}')で必ず切る。分岐が複数の関数に散っている今、
    //   「次の頭まで」だけだと関数の末尾〜次の関数の前置きまで巻き込み、
    //   そこで読んでいる params のキーが最後の method に混ざる(偽のドリフト源)。
    for (let i = from + 1; i < to; i++) if (/^\}/.test(lines[i])) { to = i; break; }
    const scanned = scanHandlerBody(lines.slice(from, to).join("\n"));
    for (const n of heads[k].names) {
      out.set(n, {
        keys: [...scanned.keys].sort(), line: from + 1,
        returnsAppliedTrue: scanned.returnsAppliedTrue, nested: scanned.nested, declared: null,
      });
    }
  }
  return out;
}

/**
 * PostProcessSettings.h の X マクロ(DX12E_POST_FIELDS / DX12E_SSAO_FIELDS)からフィールド名を抜く。
 * これは「エンジン側が正だと決めた唯一の名前表」(Lua の post.set もここから生成される)。
 */
export function parseFieldMacro(header: string, macroName: string): string[] {
  const start = header.indexOf(`#define ${macroName}(`);
  if (start < 0) return [];
  // 行末 '\' で継続するマクロ本体を最後まで取る
  const rest = header.slice(start);
  const endRel = rest.search(/\\\r?\n(?![\s\S]*?\\\r?\n)/);   // 最後の継続行を探す用の保険
  let body = "";
  for (const line of rest.split(/\r?\n/)) {
    body += line;
    if (!/\\\s*$/.test(line)) break;
  }
  void endRel;
  const names: string[] = [];
  // 定義行そのもの(#define NAME(B, F, I, V, S)) を落としてから X(field) を拾う
  const afterDecl = body.slice(body.indexOf(")") + 1);
  for (const m of afterDecl.matchAll(/\b[A-Z]\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) names.push(m[1]);
  return [...new Set(names)];
}

/**
 * Application.cpp の `static const std::vector<std::string> kName{"a", "b", ...};` から
 * 文字列リストを抜く(McpEnumParam に渡している列挙表)。見つからなければ null。
 */
export function parseStringVector(cppSource: string, varName: string): string[] | null {
  const re = new RegExp(`std::vector<std::string>\\s+${varName}\\s*\\{([^}]*)\\}`, "s");
  const m = cppSource.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
}

export type TsTool = {
  tool: string; schemaKeys: string[]; methods: string[]; line: number;
  /** inputSchema のソーステキスト(入れ子 z.object の中身を見るため。zodObjectKeys で使う)。 */
  schemaSrc: string;
};

/**
 * inputSchema のソースから、あるキーの入れ子 z.object({...}) が宣言しているキーを返す。
 * 例: `skybox: z.object({ envMapPath: ..., }).passthrough()` → ["envMapPath", ...]。
 * 入れ子が無い/z.object でなければ null。
 */
export function zodObjectKeys(schemaSrc: string, prop: string): string[] | null {
  const expr = extractProperty(schemaSrc, prop);
  if (expr == null) return null;
  const i = expr.indexOf("z.object(");
  if (i < 0) return null;
  return objectKeys(splitCallArgs(expr, expr.indexOf("(", i))[0] ?? null);
}

/**
 * index.ts のテキストから reg(...) / regRaw(...) のツール名・引数キー・呼ぶ engine method を抜く。
 * index.ts は import した時点で stdio サーバが起動してしまうので、実行せずテキストで読む。
 */
export function parseTsTools(indexSource: string): TsTool[] {
  const tools: TsTool[] = [];
  const re = /\b(reg|regRaw)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexSource))) {
    // 関数定義側 (function reg(...) / function regRaw(...)) は拾わない
    const before = indexSource.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s*$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const args = splitCallArgs(indexSource, open);
    if (args.length < 3) continue;
    const nameM = args[0].match(/^\s*"([a-z0-9_]+)"\s*$/);
    if (!nameM) continue;
    // reg: (name, title, description, inputSchema, ann, handler) / regRaw: (name, config, handler)
    const isReg = m[1] === "reg";
    const schemaArg = isReg ? args[3] : args[1];
    const schemaKeys = isReg ? objectKeys(schemaArg) : objectKeys(extractProperty(schemaArg, "inputSchema"));
    const handler = args.slice(isReg ? 5 : 2).join(",");
    const methods = [...handler.matchAll(/engine\.call\(\s*"([a-z0-9_]+)"/g)].map((x) => x[1]);
    const applied = [...handler.matchAll(/applyAndVerify\(\s*"([a-z0-9_]+)"\s*,\s*"([a-z0-9_]+)"/g)];
    for (const a of applied) { methods.push(a[1]); methods.push(a[2]); }
    tools.push({
      tool: nameM[1],
      schemaKeys: schemaKeys ?? [],
      methods: [...new Set(methods)],
      line: indexSource.slice(0, m.index).split("\n").length,
      schemaSrc: (isReg ? schemaArg : extractProperty(schemaArg, "inputSchema")) ?? "",
    });
  }
  return tools;
}

// ── 以下、素朴なソース走査(文字列/コメント/入れ子括弧を飛ばすだけ) ──────────

/** '(' の位置から呼び出し引数をトップレベルのカンマで割る。 */
function splitCallArgs(text: string, openIdx: number): string[] {
  const args: string[] = [];
  let depth = 0, cur = "", inStr: string | null = null, esc = false, inLine = false, inBlock = false;
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
    if (c === '"' || c === "'" || c === "`") { inStr = c; cur += c; continue; }
    if ("([{".includes(c)) { depth++; if (depth === 1) continue; cur += c; continue; }
    if (")]}".includes(c)) { depth--; if (depth === 0) { args.push(cur); return args; } cur += c; continue; }
    if (c === "," && depth === 1) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  args.push(cur);
  return args;
}

/** オブジェクトリテラルのトップレベルのキー名(`...spread` はそのまま返す)。 */
export function objectKeys(body: string | null): string[] | null {
  if (body == null) return null;
  const t = body.trim();
  if (!t.startsWith("{")) return null;
  const inner = t.slice(1, t.lastIndexOf("}"));
  const parts: string[] = [];
  let depth = 0, cur = "", inStr: string | null = null, esc = false, inLine = false, inBlock = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i], n = inner[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      if (esc) { esc = false; cur += c; continue; }
      if (c === "\\") { esc = true; cur += c; continue; }
      if (c === inStr) inStr = null;
      cur += c; continue;
    }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; cur += c; continue; }
    if ("([{".includes(c)) { depth++; cur += c; continue; }
    if (")]}".includes(c)) { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  const keys: string[] = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (s.startsWith("...")) { keys.push(s.replace(/^\.\.\./, "...").split(/[\s,}]/)[0]); continue; }
    const km = s.match(/^["']?([A-Za-z0-9_$]+)["']?\s*:/);
    if (km) keys.push(km[1]);
  }
  return keys;
}

/** オブジェクトリテラルから 1 プロパティの値部分だけ取り出す(regRaw の inputSchema 用)。 */
export function extractProperty(objectLiteral: string, prop: string): string | null {
  const t = objectLiteral.trim();
  if (!t.startsWith("{")) return null;
  const inner = t.slice(1, t.lastIndexOf("}"));
  const re = new RegExp(`(^|[,{\\s])${prop}\\s*:`);
  const m = inner.match(re);
  if (!m || m.index == null) return null;
  const start = inner.indexOf(":", m.index) + 1;
  let depth = 0, inStr: string | null = null, esc = false;
  for (let i = start; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return inner.slice(start, i);
    if (depth < 0) return inner.slice(start, i);
  }
  return inner.slice(start);
}
