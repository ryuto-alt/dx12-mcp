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
] as const;
/** 重い検査（assets 全走査）。速く回したいときはこれを外す。 */
export const DIAG_SLOW_CHECKS = ["textures", "models"] as const;

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
