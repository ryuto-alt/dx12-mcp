// 知覚層（エンジンの perceive）の数値 → 言葉の facts。
//
// ★なぜ要るか:
//   判断モデル Jev は画像を見られず、数値の大小や近さにも弱い（0.28 と 0.31 のどちらが暗いか）。
//   エンジンが出した「プレイヤーの目から見た事実」（占有率・周囲との輝度比・灯りの向き・遮蔽・
//   空の割合…）を、ここで比較と境界まで済ませて語にする。Jev には語だけを渡し、元の数値は raw に残す。
//
// ★指標の厳密な定義はエンジン側 src/renderer/PerceptionStats.h の先頭にある（ここは写さない）。
//   ここで決めるのは「どの値からどの語にするか」だけで、境界は下の PERCEIVE_BINS の 1 か所に集める。
//   境界を動かしたら perceive.test.ts が落ちる（動かすなら Jev の評価ケースも見直すこと）。
//   明るさ・彩度・面積の境界は jev/wordify.ts（polish と揃えた表）と同じ値にしてある。
//
// ★このファイルは純関数だけ（エンジンにも MCP にも依存しない）。ツール登録は index.ts 側。

/** edges[i] 未満なら words[i]、最後の edge 以上なら words の末尾。words.length === edges.length + 1。 */
export type Bin = { readonly edges: readonly number[]; readonly words: readonly string[] };

export const PERCEIVE_BINS = {
  /** 画面占有率 share（0..1）。0.2% 未満は「そこにあると気付けない」大きさ。 */
  share: {
    edges: [0.002, 0.01, 0.04, 0.15, 0.4],
    words: ["ほぼ見えない", "ごく小さい", "小さい", "中くらい", "大きい", "画面の大半"],
  },
  /** 表示色の輝度 Y'（0..1）。jev/wordify.ts の luma と同じ境界。 */
  luma: {
    edges: [0.06, 0.15, 0.3, 0.5, 0.7],
    words: ["ほぼ真っ暗", "とても暗い", "暗い", "中くらい", "明るい", "とても明るい"],
  },
  /** 周囲との輝度比の大きさ max(c, 1/c)。c = (luma+0.05)/(lumaRing+0.05)。1.15 未満は背景に溶ける。 */
  contrast: {
    edges: [1.15, 1.5, 2.5],
    words: ["ほぼ同じ（背景に溶ける）", "低い", "普通", "高い"],
  },
  /** 面の中の輝度のばらつき lumaStd（0..1）。小さい＝模様も陰影も無い＝何の面か読めない。 */
  texture: {
    edges: [0.015, 0.04, 0.08],
    words: ["のっぺり（模様も陰影もほぼ無い）", "模様・陰影が少ない", "普通", "模様・陰影がはっきり"],
  },
  /** litFacing（影を無視した直接光のうち、見えている面の側に届く割合 0..1）。 */
  litFacing: {
    edges: [0.2, 0.45, 0.75],
    words: ["影（灯りは裏側から当たっている）", "ほぼ影", "半分くらい照らされている", "照らされている"],
  },
  /** occlusion（遮蔽物が無ければ映るはずの画素のうち隠れている割合 0..1）。 */
  occlusion: {
    edges: [0.05, 0.35, 0.65, 0.95],
    words: ["隠れていない", "一部隠れている", "半分くらい隠れている", "大半が隠れている", "ほぼ全部隠れている"],
  },
  /** カメラからの距離（m）。 */
  distance: {
    edges: [1, 3, 8, 20, 50],
    words: ["目の前", "すぐ近く", "近い", "中くらいの距離", "遠い", "とても遠い"],
  },
  /** HSV 彩度の平均（0..1）。jev/wordify.ts の saturation と同じ境界。 */
  saturation: {
    edges: [0.04, 0.08, 0.18, 0.3],
    words: ["ほぼ無彩色", "くすんでいる", "普通", "鮮やか", "とても鮮やか"],
  },
  /** 画面に占める割合（%）。黒潰れ・白飛びの面積。jev/wordify.ts の areaPct と同じ境界。 */
  areaPct: {
    edges: [1, 8, 20, 35, 60],
    words: ["ほぼ無い", "少し", "目立つ", "多い", "とても多い", "画面の大半"],
  },
  /** 領域の中の「何も描かれていない（空・クリア色）」割合（0..1）。 */
  emptyRatio: {
    edges: [0.05, 0.35, 0.65, 0.95],
    words: ["ほぼ無い", "一部", "半分くらい", "大半", "ほぼ全部"],
  },
  /** 画面上の横位置（重心 x, 0..1）。 */
  horizontal: {
    edges: [0.15, 0.35, 0.45, 0.55, 0.65, 0.85],
    words: ["左端", "左", "中央やや左", "中央", "中央やや右", "右", "右端"],
  },
  /** 画面上の縦位置（重心 y, 0..1。下向き）。中段は語にしない（空文字）。 */
  vertical: {
    edges: [0.15, 0.35, 0.65, 0.85],
    words: ["上端", "上寄り", "", "下寄り", "下端"],
  },
  /** 見えている画素のうち裏面の割合（0..1）。 */
  backFacing: {
    edges: [0.1, 0.5],
    words: ["いいえ", "一部", "はい（裏面が見えている＝手前の灯りでも暗く見える）"],
  },
} as const satisfies Record<string, Bin>;

export type PerceiveBinName = keyof typeof PERCEIVE_BINS;

/** 値 → ビンの番号（0..words.length-1）。NaN / 非数は -1。 */
export function binIndex(value: number, bin: Bin): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return -1;
  for (let i = 0; i < bin.edges.length; i++) if (value < bin.edges[i]) return i;
  return bin.edges.length;
}

/** 値 → 語。読めない値（null / undefined / NaN）は undefined（「無い」と決めつけない）。 */
export function perceiveWord(name: PerceiveBinName, value: number | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const i = binIndex(value, PERCEIVE_BINS[name]);
  return i < 0 ? undefined : PERCEIVE_BINS[name].words[i];
}

// ─── エンジンの応答の形（必要なぶんだけ） ─────────────────────────────

export interface PerceiveStatsRaw {
  name: string;
  parent?: string;
  entityId?: number;
  members?: number;
  transparent?: boolean;
  transparentMembers?: number;
  pixels: number;
  share: number;
  bbox: number[] | null;
  center: number[] | null;
  luma: number;
  lumaStd: number;
  lumaRing: number | null;
  contrast: number | null;
  saturation: number;
  distance: number | null;
  distanceMin?: number | null;
  fullyInView: boolean | null;
  projectedExtent: number[] | null;
  isolatedPixels?: number;
  occlusion: number | null;
  litFacing: number | null;
  unlit?: boolean;
  backFacing: number | null;
  mainLight: { name: string; facing: number | null } | null;
  note?: string;
}

export interface PerceiveRegionRaw { empty: number; luma: number; lumaStd: number; distance: number | null }

export interface PerceiveRaw {
  mode?: string;
  camera?: { source?: string; position?: number[]; forward?: number[]; fovDeg?: number };
  scene: {
    empty: number;
    regions: { top: PerceiveRegionRaw; bottom: PerceiveRegionRaw; left: PerceiveRegionRaw; right: PerceiveRegionRaw };
    luma: { mean: number; p5: number; p50: number; p95: number; crushed: number; clipped: number };
    farthest: number | null;
    visibleEntities?: number;
  };
  targets?: PerceiveStatsRaw[];
  top?: PerceiveStatsRaw[];
  transparent?: { count?: number; included?: boolean };
}

// ─── 1 対象ぶん ─────────────────────────────────────────────────────────

/** 重心 → 「中央やや右・下寄り」。どちらも中段なら「中央」。 */
export function positionWord(center: readonly number[] | null | undefined): string | undefined {
  if (!center || center.length < 2) return undefined;
  const h = perceiveWord("horizontal", center[0]);
  const v = perceiveWord("vertical", center[1]);
  if (h === undefined || v === undefined) return undefined;
  if (!v) return h;
  if (h === "中央") return `中央・${v}`;
  return `${h}・${v}`;
}

/** contrast（比）→「低い（周囲より暗い）」。 */
export function contrastWord(contrast: number | null | undefined): string | undefined {
  if (contrast === null || contrast === undefined || !(contrast > 0)) return undefined;
  const mag = Math.max(contrast, 1 / contrast);
  const w = perceiveWord("contrast", mag);
  if (w === undefined) return undefined;
  if (mag < PERCEIVE_BINS.contrast.edges[0]) return w;   // 方向を言うほどの差が無い
  return `${w}（周囲より${contrast < 1 ? "暗い" : "明るい"}）`;
}

/** 視野に収まるか。はみ出す量（projectedExtent）で「画面より大きい」を分ける。 */
export function fitsWord(s: Pick<PerceiveStatsRaw, "fullyInView" | "projectedExtent">): string | undefined {
  if (s.fullyInView === null || s.fullyInView === undefined) return undefined;
  if (s.fullyInView) return "全体が視野に収まる";
  const ext = s.projectedExtent;
  if (ext && Math.max(ext[0], ext[1]) > 1) return "収まらない（画面より大きい）";
  return "一部が画面の外";
}

/** 灯りの当たり方。unlit は「届いていない」、主光源の向きも添える。 */
export function lightingWord(s: Pick<PerceiveStatsRaw, "litFacing" | "unlit" | "mainLight">): string | undefined {
  if (s.unlit) return "どの灯りも届いていない";
  return perceiveWord("litFacing", s.litFacing);
}

export interface TargetFacts {
  name: string;
  facts: Record<string, string>;
  raw: Record<string, number | boolean | string | null>;
}

/** 1 対象の facts。見えていないときは visibility だけ（他の語は嘘になるので出さない）。 */
export function targetFacts(s: PerceiveStatsRaw): TargetFacts {
  const facts: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => { if (v !== undefined && v !== "") facts[k] = v; };
  const raw = {
    share: s.share, luma: s.luma, lumaRing: s.lumaRing, contrast: s.contrast, lumaStd: s.lumaStd,
    litFacing: s.litFacing, occlusion: s.occlusion, distance: s.distance, fullyInView: s.fullyInView,
    backFacing: s.backFacing, mainLight: s.mainLight?.name ?? null,
  };

  if (s.pixels <= 0) {
    if ((s.isolatedPixels ?? 0) > 0) put("visibility", "完全に隠れている（手前の物に遮られている）");
    else if (s.fullyInView === false) put("visibility", "視野の外");
    else if (s.members === 0) put("visibility", "描く物が無い（メッシュを持たない）");
    else put("visibility", "見えていない");
    put("fits_in_view", fitsWord(s));
    return { name: s.name, facts, raw };
  }

  put("visibility", "見えている");
  put("screen_share", perceiveWord("share", s.share));
  put("position", positionWord(s.center));
  put("brightness", perceiveWord("luma", s.luma));
  put("contrast", contrastWord(s.contrast));
  put("texture", perceiveWord("texture", s.lumaStd));
  put("lit_side", lightingWord(s));
  if (s.mainLight?.name && s.mainLight.facing !== null && s.mainLight.facing !== undefined && !s.unlit) {
    const f = s.mainLight.facing;
    put("main_light", `${s.mainLight.name}（${f >= 0.75 ? "見えている面に当たっている" : f <= 0.25 ? "裏側から当たっている" : "横から当たっている"}）`);
  }
  if ((s.backFacing ?? 0) >= PERCEIVE_BINS.backFacing.edges[0]) put("back_face", perceiveWord("backFacing", s.backFacing));
  put("occluded", perceiveWord("occlusion", s.occlusion));
  put("fits_in_view", fitsWord(s));
  put("distance", perceiveWord("distance", s.distance));
  put("saturation", perceiveWord("saturation", s.saturation));
  if (s.transparent || (s.transparentMembers ?? 0) > 0) put("material", "半透明");
  return { name: s.name, facts, raw };
}

// ─── シーン全体 ─────────────────────────────────────────────────────────

/** 領域（上下左右の半分）の見え方。「何も無い」「暗くて何も見えない」「一様」「面が見える（遠い）」。 */
export function regionWord(r: PerceiveRegionRaw | undefined): string | undefined {
  if (!r) return undefined;
  if (r.empty >= PERCEIVE_BINS.emptyRatio.edges[3]) return "何も描かれていない（空）";
  const parts: string[] = [];
  if (r.empty >= PERCEIVE_BINS.emptyRatio.edges[1]) parts.push(`空が${perceiveWord("emptyRatio", r.empty)}`);
  // ★暗さと一様さを先に見る。面が描かれていても、真っ暗・のっぺりなら「見えない」と同じ。
  const flat = r.lumaStd < PERCEIVE_BINS.texture.edges[0];
  if (r.luma < PERCEIVE_BINS.luma.edges[1] && flat) parts.push("暗くて何も見えない");
  else if (flat) parts.push("一様（霧か無地の面だけ）");
  else {
    // ★暗い領域は明るさも添える（真下を覗いて「面はあるが、とても暗い」を「面が見える」だけで済ませない）
    const notes = [perceiveWord("distance", r.distance)];
    if (r.luma < PERCEIVE_BINS.luma.edges[2]) notes.push(perceiveWord("luma", r.luma));
    const n = notes.filter((x): x is string => !!x);
    parts.push(n.length ? `面が見える（${n.join("・")}）` : "面が見える");
  }
  return parts.join("・");
}

export interface PerceptionFacts {
  viewpoint: string | undefined;
  scene: Record<string, string>;
  targets: TargetFacts[];
  top: TargetFacts[];
}

/** 視点の説明。座標は Jev に渡しても役に立たないので、出どころだけ。 */
export function viewpointWord(raw: PerceiveRaw): string | undefined {
  const src = raw.camera?.source;
  const mode = raw.mode === "Playing" ? "プレイ中" : raw.mode === "Editor" ? "エディタ" : undefined;
  const w = src === "game" ? "ゲームカメラ" : src === "explicit" ? "指定した視点" : src === "editor" ? "エディタのカメラ" : undefined;
  if (!w) return mode;
  return mode ? `${w}（${mode}）` : w;
}

/**
 * エンジンの perceive の結果 → 言葉の facts。
 * @param opts.top 画面占有の上位を何件まで語にするか（既定 3）
 */
export function perceptionFacts(raw: PerceiveRaw, opts: { top?: number } = {}): PerceptionFacts {
  const scene: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => { if (v !== undefined && v !== "") scene[k] = v; };
  const sc = raw.scene;
  put("brightness", perceiveWord("luma", sc.luma.mean));
  put("upper_half", regionWord(sc.regions.top));
  put("lower_half", regionWord(sc.regions.bottom));
  put("left_half", regionWord(sc.regions.left));
  put("right_half", regionWord(sc.regions.right));
  put("sky_or_void", perceiveWord("emptyRatio", sc.empty));
  put("black_crush", perceiveWord("areaPct", sc.luma.crushed * 100));
  put("blown_out", perceiveWord("areaPct", sc.luma.clipped * 100));
  put("farthest_surface", sc.farthest === null ? "無い（何も描かれていない）" : perceiveWord("distance", sc.farthest));
  const top = (raw.top ?? []).slice(0, opts.top ?? 3);
  if (top.length) put("dominant", `${top[0].name}（${perceiveWord("share", top[0].share) ?? "?"}）`);

  return {
    viewpoint: viewpointWord(raw),
    scene,
    targets: (raw.targets ?? []).map(targetFacts),
    top: top.map(targetFacts),
  };
}
