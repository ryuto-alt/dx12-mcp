// jev/wordify.ts の単体テスト。
// 守りたいのは 3 つ:
//   1) ビンの境界と語を固定する(動かしたら落ちる = 評価ケースを見直す合図)
//   2) 境界ちょうどの値がどちらに入るか(edge 以上は上のビン)
//   3) polish.ts のルール閾値と境界が揃っている(「眠い」と言うのにルールは眠くないと言う、を起こさない)

import { BINS, binIndex, binWord, isBinWord, labelOf, ratioWord, wordOf, yesNo } from "./wordify.ts";
import { auditScene } from "../polish.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] 境界と語の固定(動かすなら評価ケースも見直すこと)");
{
  const snapshot = {
    luma: { edges: [0.06, 0.15, 0.3, 0.5, 0.7], words: ["ほぼ真っ暗", "とても暗い", "暗い", "中くらい", "明るい", "とても明るい"] },
    contrast: { edges: [0.2, 0.35, 0.55, 0.75], words: ["とても眠い", "眠い", "普通", "メリハリがある", "とても強い"] },
    saturation: { edges: [0.04, 0.08, 0.18, 0.3], words: ["ほぼ無彩色", "くすんでいる", "普通", "鮮やか", "とても鮮やか"] },
    areaPct: { edges: [1, 8, 20, 35, 60], words: ["ほぼ無い", "少し", "目立つ", "多い", "とても多い", "画面の大半"] },
    ratio: { edges: [0.05, 0.35, 0.65, 0.95], words: ["ほぼ無い", "一部", "半分くらい", "大半", "ほぼ全部"] },
    count: { edges: [1, 2, 4, 11], words: ["なし", "ひとつ", "少し", "いくつも", "たくさん"] },
    fogDensity: { edges: [0.001, 0.008, 0.025], words: ["なし", "薄い", "中くらい", "濃い"] },
    bloom: { edges: [0.2, 0.5, 1.0], words: ["弱い", "中くらい", "強い", "とても強い"] },
    // UI(境界と uiQuality.ts のルール閾値の揃いは jev/uiJudge.test.ts の [3] で見る)
    kinds: { edges: [2, 4, 6, 9], words: ["ひとつだけ", "少ない", "普通", "多い", "とても多い"] },
    palette: { edges: [4, 7, 13, 20], words: ["ごく少ない", "少ない", "普通", "多い", "とても多い"] },
    centered: { edges: [0.05, 0.35, 0.8, 0.95], words: ["ほぼ無い", "一部だけ", "半分くらい", "大半", "ほぼ全部"] },
    // 配置(境界と ApplicationMcpValidate.cpp の閾値の揃いは jev/layoutJudge.test.ts で見る)
    objectSize: { edges: [0.3, 1, 2, 6, 20], words: ["手のひらくらい", "小物", "人の背丈くらい", "人より大きい(家具や壁くらい)", "建物くらい", "とても大きい(床や地形くらい)"] },
    overlap: { edges: [0.5, 0.8], words: ["浅くめり込んでいる", "深くめり込んでいる", "ほぼ丸ごと重なっている"] },
    lift: { edges: [1, 3], words: ["自分の高さより低く浮いている", "自分の高さの数倍浮いている", "はるか上に浮いている"] },
    buried: { edges: [0.5, 0.9], words: ["下の方が埋まっている", "半分以上埋まっている", "ほぼ全部埋まっている"] },
    // プレイ(jev/playJudge.ts の区間の事実)
    lookRate: { edges: [15, 45, 90], words: ["ほとんど見回さない", "少し見回す", "よく見回す", "激しく見回す"] },
    goalDistance: { edges: [3, 15, 50], words: ["目の前", "近い", "遠い", "とても遠い"] },
    playLength: { edges: [20, 90, 300], words: ["とても短い", "短い", "普通", "長い"] },
  };
  check("BINS がスナップショットと一致", JSON.stringify(BINS) === JSON.stringify(snapshot),
    `実際: ${JSON.stringify(BINS)}`);
  for (const [name, b] of Object.entries(BINS)) {
    check(`${name}: 語の数 = 境界の数 + 1`, b.words.length === b.edges.length + 1);
    check(`${name}: 境界は昇順`, b.edges.every((e, i) => i === 0 || e > b.edges[i - 1]));
    check(`${name}: 語は重複しない`, new Set(b.words).size === b.words.length);
  }
}

console.log("[2] 境界ちょうどは上のビン、少し下は下のビン");
{
  check("contrast 0.35 → 普通", wordOf("contrast", 0.35) === "普通");
  check("contrast 0.3499 → 眠い", wordOf("contrast", 0.3499) === "眠い");
  check("luma 0 → ほぼ真っ暗", wordOf("luma", 0) === "ほぼ真っ暗");
  check("luma 1 → とても明るい", wordOf("luma", 1) === "とても明るい");
  check("count 0 → なし / 1 → ひとつ / 3 → 少し / 4 → いくつも / 11 → たくさん",
    ["なし", "ひとつ", "少し", "いくつも", "たくさん"].join() === [0, 1, 3, 4, 11].map((n) => wordOf("count", n)).join());
  check("areaPct 60 → 画面の大半", wordOf("areaPct", 60) === "画面の大半");
  check("NaN は語を出さない", wordOf("luma", NaN) === undefined && binIndex(NaN, BINS.luma) === -1);
  check("undefined / null は語を出さない(読めない ≠ 無い)", wordOf("luma", undefined) === undefined && binWord(null, BINS.luma) === undefined);
  check("labelOf は人向けに数値を添える", labelOf("contrast", 0.284) === "眠い(0.28)", String(labelOf("contrast", 0.284)));
  check("ratioWord: 分母 0 は語を出さない", ratioWord(0, 0) === undefined);
  check("ratioWord: 12/40 → 一部", ratioWord(12, 40) === "一部");
  check("ratioWord: 1 を超えない", ratioWord(50, 40) === "ほぼ全部");
  check("yesNo: undefined は語を出さない", yesNo(undefined, "あり", "なし") === undefined && yesNo(true, "あり", "なし") === "あり");
  check("isBinWord", isBinWord("fogDensity", "濃い") && !isBinWord("fogDensity", "とても濃い"));
}

console.log("[3] polish.ts のルール閾値と境界が揃っている");
{
  const img = (o: Partial<{ meanLuma: number; dynamicRange: number; blackPct: number; whitePct: number; saturation: number }>) =>
    auditScene({ image: { meanLuma: 0.4, dynamicRange: 0.6, blackPct: 2, whitePct: 1, saturation: 0.2, ...o } }).map((f) => f.code);
  // 眠い絵: ルールは dynamicRange < 0.35 で FLAT_IMAGE。語は 0.35 未満で「眠い」以下。
  check("0.349: ルール FLAT_IMAGE ⇔ 語「眠い」", img({ dynamicRange: 0.349 }).includes("FLAT_IMAGE") && wordOf("contrast", 0.349) === "眠い");
  check("0.35: ルールは言わない ⇔ 語「普通」", !img({ dynamicRange: 0.35 }).includes("FLAT_IMAGE") && wordOf("contrast", 0.35) === "普通");
  // 彩度: ルールは < 0.08。
  check("0.079: DESATURATED ⇔「くすんでいる」", img({ saturation: 0.079 }).includes("DESATURATED") && wordOf("saturation", 0.079) === "くすんでいる");
  check("0.08: 言わない ⇔「普通」", !img({ saturation: 0.08 }).includes("DESATURATED") && wordOf("saturation", 0.08) === "普通");
  // 白飛び: ルールは > 8%(8 ちょうどは言わない)。語は 8 以上で「目立つ」。
  check("8.01%: CLIPPED_WHITES ⇔「目立つ」", img({ whitePct: 8.01 }).includes("CLIPPED_WHITES") && wordOf("areaPct", 8.01) === "目立つ");
  check("7.99%: 言わない ⇔「少し」", !img({ whitePct: 7.99 }).includes("CLIPPED_WHITES") && wordOf("areaPct", 7.99) === "少し");
  // 真っ黒: ルールは > 35%。語は 35 以上で「とても多い」。
  check("35.01%: CRUSHED_BLACKS ⇔「とても多い」", img({ blackPct: 35.01 }).includes("CRUSHED_BLACKS") && wordOf("areaPct", 35.01) === "とても多い");
  check("34.99%: 言わない ⇔「多い」", !img({ blackPct: 34.99 }).includes("CRUSHED_BLACKS") && wordOf("areaPct", 34.99) === "多い");
  // フォグ: ルールは density > 0.001 で「入っている」。ちょうど 0.001 の扱いは
  //   wordifyLook(polishJudge.ts)が enabled と合わせて「なし」にする(polishJudge.test.ts で見る)。
  const fog = (density: number) => auditScene({ fog: { enabled: true, density } }).map((f) => f.code);
  check("fog 0.0009: NO_FOG ⇔「なし」", fog(0.0009).includes("NO_FOG") && wordOf("fogDensity", 0.0009) === "なし");
  check("fog 0.0011: 言わない ⇔「薄い」", !fog(0.0011).includes("NO_FOG") && wordOf("fogDensity", 0.0011) === "薄い");
}

console.log(failed === 0 ? "\nOK: jev/wordify テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
