// 数値 → 言葉のビン。Jev に渡す state はここを通してから作る。
//
// ★なぜ数値をそのまま渡さないか(公式 model-jaggedness と実測):
//   Jev は数を数えられず、数値の大小・近さ(0.28 と 0.31 のどちらが暗いか)に弱い。
//   「平均輝度 0.07」を渡すと判断がぶれるが、「とても暗い」なら安定する。
//   だから比較と境界はここ(TS)で済ませ、Jev には結論の語だけを渡す。
//   元の数値は結果の raw に別途残す(人とログのため。state には入れない)。
//
// ★境界は下の BINS に 1 か所で集める。polish.ts の閾値(眠い絵 0.35 / 白飛び 8% /
//   真っ黒 35% / 彩度 0.08)と境界を揃えてあるので、ルールの指摘と語が食い違わない
//   (「眠い」と言っているのにルールは眠くないと言う、が起きない)。
//   境界を動かしたら wordify.test.ts が落ちる。動かすなら評価ケースも見直すこと。
//
// このファイルは純関数だけ。

/** edges[i] 未満なら words[i]、最後の edge 以上なら words の末尾。words.length === edges.length + 1。 */
export type Bin = { readonly edges: readonly number[]; readonly words: readonly string[] };

export const BINS = {
  /** 最終画の平均輝度 0..1(polish の meanLuma)。 */
  luma: {
    edges: [0.06, 0.15, 0.3, 0.5, 0.7],
    words: ["ほぼ真っ暗", "とても暗い", "暗い", "中くらい", "明るい", "とても明るい"],
  },
  /** 実効レンジ 0..1(上下 1% を落とした明暗差)。0.35 未満が polish の「眠い絵」。 */
  contrast: {
    edges: [0.2, 0.35, 0.55, 0.75],
    words: ["とても眠い", "眠い", "普通", "メリハリがある", "とても強い"],
  },
  /** 平均彩度 0..1。0.08 未満が polish の「彩度ほぼゼロ」。 */
  saturation: {
    edges: [0.04, 0.08, 0.18, 0.3],
    words: ["ほぼ無彩色", "くすんでいる", "普通", "鮮やか", "とても鮮やか"],
  },
  /** 画面に占める割合(%)。白飛び 8% / 真っ黒 35% が polish の閾値。 */
  areaPct: {
    edges: [1, 8, 20, 35, 60],
    words: ["ほぼ無い", "少し", "目立つ", "多い", "とても多い", "画面の大半"],
  },
  /** 全体に対する割合 0..1(法線マップの付いたメッシュの割合など)。 */
  ratio: {
    edges: [0.05, 0.35, 0.65, 0.95],
    words: ["ほぼ無い", "一部", "半分くらい", "大半", "ほぼ全部"],
  },
  /** 個数。Jev は数を数えられないので、比較に要る粒度の語へ丸める。 */
  count: {
    edges: [1, 2, 4, 11],
    words: ["なし", "ひとつ", "少し", "いくつも", "たくさん"],
  },
  /** ボリュメトリックフォグの密度。0.001 以下は polish でも「フォグ無し」扱い。 */
  fogDensity: {
    edges: [0.001, 0.008, 0.025],
    words: ["なし", "薄い", "中くらい", "濃い"],
  },
  /** ブルームの強さ(post.bloom)。look_apply のプリセットは 0.2〜0.6、1 を超えると画面が滲む。 */
  bloom: {
    edges: [0.2, 0.5, 1.0],
    words: ["弱い", "中くらい", "強い", "とても強い"],
  },

  // ── UI(uiQuality.ts の auditUiTree と境界を揃える) ──
  /** 種類の数(表示中のフォントサイズの種類)。6 種以上 = FONT_SIZE_SPRAWL(>5)と同じ線。 */
  kinds: {
    edges: [2, 4, 6, 9],
    words: ["ひとつだけ", "少ない", "普通", "多い", "とても多い"],
  },
  /** 面色の系統数(RGB を 1/16 に量子化した数)。13 以上 = PALETTE_SPRAWL(>12)と同じ線。 */
  palette: {
    edges: [4, 7, 13, 20],
    words: ["ごく少ない", "少ない", "普通", "多い", "とても多い"],
  },
  /** 操作+テキスト要素のうち水平中央に乗っている割合。0.8 以上 = CENTERED_MONOTONY と同じ線。 */
  centered: {
    edges: [0.05, 0.35, 0.8, 0.95],
    words: ["ほぼ無い", "一部だけ", "半分くらい", "大半", "ほぼ全部"],
  },

  // ── 配置(src/core/mcp/ApplicationMcpValidate.cpp の閾値と境界を揃える) ──
  /**
   * 物の大きさ(子を含むワールド AABB の最長辺 m)。2m は NO_COLLIDER の「人がぶつかる大きさ」、
   * 6m は IsProp(置き物)の高さの上限と同じ線。
   */
  objectSize: {
    edges: [0.3, 1, 2, 6, 20],
    words: ["手のひらくらい", "小物", "人の背丈くらい", "人より大きい(家具や壁くらい)", "建物くらい", "とても大きい(床や地形くらい)"],
  },
  /** めり込みの深さ(重なった体積 / 小さい方の体積)。0.3 未満は OVERLAP にならない、0.8 超でエラー。 */
  overlap: {
    edges: [0.5, 0.8],
    words: ["浅くめり込んでいる", "深くめり込んでいる", "ほぼ丸ごと重なっている"],
  },
  /** 浮きの高さ(支えとの隙間 / 自分の高さ)。 */
  lift: {
    edges: [1, 3],
    words: ["自分の高さより低く浮いている", "自分の高さの数倍浮いている", "はるか上に浮いている"],
  },
  /** 埋まりの深さ(沈んだ深さ / 自分の高さ)。0.25 未満かつ 50cm 未満は BURIED にならない。 */
  buried: {
    edges: [0.5, 0.9],
    words: ["下の方が埋まっている", "半分以上埋まっている", "ほぼ全部埋まっている"],
  },

  // ── プレイ(jev/playJudge.ts の区間の事実) ──
  /** 見回しの速さ(yaw の変化量の合計 / 秒、度)。 */
  lookRate: {
    edges: [15, 45, 90],
    words: ["ほとんど見回さない", "少し見回す", "よく見回す", "激しく見回す"],
  },
  /** ゴールまでの水平距離(m)。autoplay の到達判定(1.5m)より十分外を「目の前」の上限にする。 */
  goalDistance: {
    edges: [3, 15, 50],
    words: ["目の前", "近い", "遠い", "とても遠い"],
  },
  /** 1 回のプレイの長さ(秒)。 */
  playLength: {
    edges: [20, 90, 300],
    words: ["とても短い", "短い", "普通", "長い"],
  },
} as const satisfies Record<string, Bin>;

export type BinName = keyof typeof BINS;

/** 値 → ビンの番号(0..words.length-1)。NaN / 非数は -1。 */
export function binIndex(value: number, bin: Bin): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return -1;
  for (let i = 0; i < bin.edges.length; i++) if (value < bin.edges[i]) return i;
  return bin.edges.length;
}

/** 値 → 語。読めない値は undefined(「無い」と決めつけない＝ state から落とす)。 */
export function binWord(value: number | undefined | null, bin: Bin): string | undefined {
  if (value === undefined || value === null) return undefined;
  const i = binIndex(value, bin);
  return i < 0 ? undefined : bin.words[i];
}

export function wordOf(name: BinName, value: number | undefined | null): string | undefined {
  return binWord(value, BINS[name]);
}

/** 人が読む表示用「暗い(0.28)」。★Jev の state には使わない(数値を渡さない方針)。 */
export function labelOf(name: BinName, value: number | undefined | null, digits = 2): string | undefined {
  const w = wordOf(name, value);
  if (w === undefined || value === undefined || value === null) return undefined;
  return `${w}(${Number(value).toFixed(digits)})`;
}

/** ある語がそのビンの語彙に含まれるか(評価ケースの語が wordify と食い違っていないかの検査用)。 */
export function isBinWord(name: BinName, word: string): boolean {
  return (BINS[name].words as readonly string[]).includes(word);
}

/** 有無の 2 値。undefined は「読めなかった」なので語を出さない。 */
export function yesNo(v: boolean | undefined, yes: string, no: string): string | undefined {
  return v === undefined ? undefined : v ? yes : no;
}

/** 比率(分子/分母)を ratio ビンの語へ。分母 0 や片方不明は undefined。 */
export function ratioWord(num: number | undefined, den: number | undefined): string | undefined {
  if (num === undefined || den === undefined || !(den > 0)) return undefined;
  return wordOf("ratio", Math.max(0, Math.min(1, num / den)));
}
