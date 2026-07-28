// 「引数が無言で捨てられる」事故を止めるための共通部品。
//
// ★何が起きていたか
//   MCP SDK は inputSchema を z.object(shape) にして parse する。zod の既定は
//   【未知キーを黙って捨てる】ので、スキーマに書き忘れたフィールド(例: godraysOn)は
//   ハンドラに届く前に消える。エンジンは「未指定＝現状維持」なので何も起きず、
//   それでも set_* は {applied:true} を返す。AI から見ると「成功したのに変わらない」＝
//   同じ操作を無限に繰り返す。実際に tonemapper / godraysOn 等で起きた。
//
// ★対処(このファイルの役割)
//   1) 未知キーの検出と「近い正解」の提示   … unknownParamKeys / unknownKeyError
//   2) 適用後にエンジンから読み返して照合   … verifyApplied
//   index.ts 側は inputSchema を z.object(shape).passthrough() で登録して未知キーを
//   ハンドラまで通し、ここで弾く(捨てずにエラーにする)。

import { argError, type ToolError } from "./sceneTools.ts";

/** 編集距離(打ち間違いキーの候補提示用。短い文字列しか来ないので素朴な DP で十分)。 */
export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** 未知キーに一番近い既知キーを返す(大文字小文字違いは最優先)。 */
export function nearestKey(key: string, known: readonly string[]): string | null {
  const lower = key.toLowerCase();
  const exactCase = known.find((k) => k.toLowerCase() === lower);
  if (exactCase) return exactCase;
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(lower, k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  // 3 文字以上ズレていたら「近い」とは言わない(見当違いの提案は害になる)。
  return bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : null;
}

/**
 * どの method でもエンジンが先頭で読む共通キー(Application.cpp の McpDeferred 構築)。
 * ツール個別のスキーマに無くても弾かない。
 */
export const GLOBAL_PARAM_KEYS: readonly string[] = ["idempotency_key"];

/** args のうち declared にも GLOBAL_PARAM_KEYS にも無いキー(=このままだと黙って捨てられる分)。 */
export function unknownParamKeys(args: unknown, declared: readonly string[]): string[] {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return [];
  const allowed = new Set<string>([...declared, ...GLOBAL_PARAM_KEYS]);
  return Object.keys(args as Record<string, unknown>).filter((k) => !allowed.has(k));
}

/** 有効値一覧を本文に載せる上限(set_post_process は 85 個あるので全部出すと読みにくい)。 */
const MAX_LISTED_KEYS = 32;

/**
 * 未知キーのエラー。「何が悪いか」だけでなく「代わりに何を書けばいいか」まで入れる。
 * where はツール名 or "dx12_batch ops[i] method"。
 */
export function unknownKeyError(where: string, unknown: readonly string[], declared: readonly string[]): ToolError {
  const parts = unknown.map((k) => {
    const near = nearestKey(k, declared);
    return near ? `${k}(→ ${near} のことか?)` : k;
  });
  const hint = declared.length > MAX_LISTED_KEYS
    ? `使えるキーは ${declared.length} 個ある。対になる dx12_get_* を呼ぶと現在値つきで全部返る`
    : "下の有効な値のどれかに直して呼び直してくれ";
  return argError(
    `${where}: 知らない引数 ${parts.join(", ")} が来た(このまま実行すると黙って無視される)`,
    hint,
    declared.length > 0 && declared.length <= MAX_LISTED_KEYS ? [...declared] : undefined,
  );
}

// ── 適用後の読み返し照合 ────────────────────────────────────────
// エンジンは float32 で保持して JSON へ出すので 0.65 が 0.6499999761581421 になる。
// 完全一致では常に不一致になるため相対誤差で見る。
const REL_EPS = 1e-5;

function numEq(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= REL_EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

function valueEq(want: unknown, got: unknown): boolean {
  if (typeof want === "number" && typeof got === "number") return numEq(want, got);
  if (Array.isArray(want) && Array.isArray(got)) {
    return want.length === got.length && want.every((w, i) => valueEq(w, got[i]));
  }
  if (want && got && typeof want === "object" && typeof got === "object"
      && !Array.isArray(want) && !Array.isArray(got)) {
    return Object.entries(want as Record<string, unknown>)
      .every(([k, v]) => valueEq(v, (got as Record<string, unknown>)[k]));
  }
  return want === got;
}

export type Mismatch = { key: string; requested: unknown; actual: unknown };

/**
 * 「頼んだ値」と「set 後に get で読み返した実値」を突き合わせる。
 * requested のキーだけ見る(get は active / note など余分を返すため)。
 * 入れ子(set_scene_settings の skybox など)も辿る。
 */
export function verifyApplied(
  requested: Record<string, unknown>,
  current: unknown,
  prefix = "",
): Mismatch[] {
  const out: Mismatch[] = [];
  if (current == null || typeof current !== "object" || Array.isArray(current)) {
    // 読み返せなかった: 照合を諦める(嘘をつくよりは何も言わない)
    return out;
  }
  const cur = current as Record<string, unknown>;
  for (const [k, want] of Object.entries(requested)) {
    if (want === undefined) continue;              // 未指定は「現状維持」なので対象外
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in cur)) { out.push({ key: path, requested: want, actual: undefined }); continue; }
    const got = cur[k];
    if (want && typeof want === "object" && !Array.isArray(want)
        && got && typeof got === "object" && !Array.isArray(got)) {
      out.push(...verifyApplied(want as Record<string, unknown>, got, path));
      continue;
    }
    if (!valueEq(want, got)) out.push({ key: path, requested: want, actual: got });
  }
  return out;
}

/** undefined を落とした素の引数(zod optional は未指定でもキーが生えることがある)。 */
export function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * dx12_<name> と engine method が 1:1 でないツール(複数 method を叩く合成ツール、
 * エンジンを介さない純ローカルツール)。dx12_batch の引数検査から外す。
 * ここに載っていないツールは「dx12_X ⇔ engine の method X」と見なす
 * (schemaDrift.test.ts がその対応を実際に検証する)。
 */
export const COMPOSITE_TOOLS: ReadonlySet<string> = new Set([
  "dx12_ui_design_brief", "dx12_ui_audit", "dx12_ui_compose", "dx12_ui_compare",
  "dx12_spawn_box", "dx12_spawn_sphere", "dx12_spawn_coin", "dx12_scatter",
  "dx12_batch", "dx12_install_font", "dx12_diagnose",
  "dx12_focus_and_screenshot", "dx12_screenshot_from", "dx12_view_texture",
  "dx12_preview_model", "dx12_look_compare", "dx12_camera_path", "dx12_scene_write",
  // set_texture ×3 + set_pbr + get_entity を畳んだ合成ツール(engine に material_apply は無い)
  "dx12_material_apply",
]);

/**
 * engine method 側だけが持つ別名(TS スキーマには出さないが渡ってきても捨てない)。
 * Application.cpp を読んで確認した分だけ載せる。
 */
export const METHOD_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  step_frames: ["n"],        // frames の別名
  set_component: ["values"], // data の別名
};
