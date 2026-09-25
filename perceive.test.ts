// perceive.ts（知覚層の数値 → 言葉）の単体テスト。エンジンは要らない（オフライン）。
// 守りたいのは 4 つ:
//   1) ビンの境界と語を固定する（動かしたら落ちる = Jev の評価ケースを見直す合図）
//   2) 境界ちょうどの値がどちらに入るか（edge 以上は上のビン）
//   3) JUNCTION で実測した値（2026-09-25, stagedemo3）が直感どおりの語になる
//      ── 破片の灯りを裏へ回すと「影」、井戸の底の灯りを消すと「暗い / 陰影が少ない」、
//         破片に寄りすぎると「画面の大半・収まらない」
//   4) facts に数値が混ざらない（Jev は数値に弱い。数値は raw にだけ残す）
//
// 実行: node perceive.test.ts

import {
  PERCEIVE_BINS, binIndex, contrastWord, fitsWord, perceiveWord, perceptionFacts, positionWord,
  regionWord, targetFacts, type PerceiveRaw, type PerceiveStatsRaw,
} from "./perceive.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] 境界と語の固定（動かすなら評価ケースも見直すこと）");
{
  const snapshot = {
    share: { edges: [0.002, 0.01, 0.04, 0.15, 0.4], words: ["ほぼ見えない", "ごく小さい", "小さい", "中くらい", "大きい", "画面の大半"] },
    luma: { edges: [0.06, 0.15, 0.3, 0.5, 0.7], words: ["ほぼ真っ暗", "とても暗い", "暗い", "中くらい", "明るい", "とても明るい"] },
    contrast: { edges: [1.15, 1.5, 2.5], words: ["ほぼ同じ（背景に溶ける）", "低い", "普通", "高い"] },
    texture: { edges: [0.015, 0.04, 0.08], words: ["のっぺり（模様も陰影もほぼ無い）", "模様・陰影が少ない", "普通", "模様・陰影がはっきり"] },
    litFacing: { edges: [0.2, 0.45, 0.75], words: ["影（灯りは裏側から当たっている）", "ほぼ影", "半分くらい照らされている", "照らされている"] },
    occlusion: { edges: [0.05, 0.35, 0.65, 0.95], words: ["隠れていない", "一部隠れている", "半分くらい隠れている", "大半が隠れている", "ほぼ全部隠れている"] },
    distance: { edges: [1, 3, 8, 20, 50], words: ["目の前", "すぐ近く", "近い", "中くらいの距離", "遠い", "とても遠い"] },
    saturation: { edges: [0.04, 0.08, 0.18, 0.3], words: ["ほぼ無彩色", "くすんでいる", "普通", "鮮やか", "とても鮮やか"] },
    areaPct: { edges: [1, 8, 20, 35, 60], words: ["ほぼ無い", "少し", "目立つ", "多い", "とても多い", "画面の大半"] },
    emptyRatio: { edges: [0.05, 0.35, 0.65, 0.95], words: ["ほぼ無い", "一部", "半分くらい", "大半", "ほぼ全部"] },
    horizontal: { edges: [0.15, 0.35, 0.45, 0.55, 0.65, 0.85], words: ["左端", "左", "中央やや左", "中央", "中央やや右", "右", "右端"] },
    vertical: { edges: [0.15, 0.35, 0.65, 0.85], words: ["上端", "上寄り", "", "下寄り", "下端"] },
    backFacing: { edges: [0.1, 0.5], words: ["いいえ", "一部", "はい（裏面が見えている＝手前の灯りでも暗く見える）"] },
  };
  check("PERCEIVE_BINS がスナップショットと一致", JSON.stringify(PERCEIVE_BINS) === JSON.stringify(snapshot),
    `実際: ${JSON.stringify(PERCEIVE_BINS)}`);
  for (const [name, b] of Object.entries(PERCEIVE_BINS)) {
    check(`${name}: 語の数 = 境界の数 + 1`, b.words.length === b.edges.length + 1);
    check(`${name}: 境界は昇順`, b.edges.every((e, i) => i === 0 || e > b.edges[i - 1]));
    check(`${name}: 語は重複しない`, new Set(b.words).size === b.words.length);
  }
  // 明るさ・彩度・面積は jev/wordify.ts（polish と揃えた表）と同じ境界。ずれると同じ絵に違う語が付く
  check("luma の境界は wordify と同じ", JSON.stringify(PERCEIVE_BINS.luma.edges) === JSON.stringify([0.06, 0.15, 0.3, 0.5, 0.7]));
}

console.log("[2] 境界ちょうどは上のビン、少し下は下のビン");
{
  check("share 0.04 → 中くらい", perceiveWord("share", 0.04) === "中くらい");
  check("share 0.0399 → 小さい", perceiveWord("share", 0.0399) === "小さい");
  check("share 0.4 → 画面の大半", perceiveWord("share", 0.4) === "画面の大半");
  check("litFacing 0.2 → ほぼ影", perceiveWord("litFacing", 0.2) === "ほぼ影");
  check("litFacing 0.1999 → 影", perceiveWord("litFacing", 0.1999)?.startsWith("影") === true);
  check("occlusion 0 → 隠れていない", perceiveWord("occlusion", 0) === "隠れていない");
  check("NaN は -1（語を出さない）", binIndex(Number.NaN, PERCEIVE_BINS.share) === -1 && perceiveWord("share", Number.NaN) === undefined);
  check("null は語を出さない", perceiveWord("luma", null) === undefined);
}

console.log("[3] 位置・コントラスト・視野の語");
{
  check("(0.5,0.5) → 中央", positionWord([0.5, 0.5]) === "中央");
  check("(0.6,0.5) → 中央やや右", positionWord([0.6, 0.5]) === "中央やや右");
  check("(0.5,0.2) → 中央・上寄り", positionWord([0.5, 0.2]) === "中央・上寄り");
  check("(0.95,0.9) → 右端・下端", positionWord([0.95, 0.9]) === "右端・下端");
  check("位置が無ければ語なし", positionWord(null) === undefined);
  check("contrast 1.05 → 背景に溶ける（方向は言わない）", contrastWord(1.05) === "ほぼ同じ（背景に溶ける）");
  check("contrast 0.44 → 普通（周囲より暗い）", contrastWord(0.44) === "普通（周囲より暗い）");
  check("contrast 0.74 → 低い（周囲より暗い）", contrastWord(0.74) === "低い（周囲より暗い）");
  check("contrast 3 → 高い（周囲より明るい）", contrastWord(3) === "高い（周囲より明るい）");
  check("contrast null → 語なし", contrastWord(null) === undefined);
  check("収まる", fitsWord({ fullyInView: true, projectedExtent: [0.2, 0.3] }) === "全体が視野に収まる");
  check("画面より大きい", fitsWord({ fullyInView: false, projectedExtent: [1.3, 1.5] }) === "収まらない（画面より大きい）");
  check("一部が外", fitsWord({ fullyInView: false, projectedExtent: [0.4, 0.3] }) === "一部が画面の外");
  check("後ろに回り込む（extent 無し）→ 一部が外", fitsWord({ fullyInView: false, projectedExtent: null }) === "一部が画面の外");
}

// ─── JUNCTION の実測値（2026-09-25。tools/bench のヘッドレス + dx12 perceive、fov 72） ───
const base = (o: Partial<PerceiveStatsRaw>): PerceiveStatsRaw => ({
  name: "x", pixels: 1000, share: 0.01, bbox: [0.4, 0.4, 0.6, 0.6], center: [0.5, 0.5], luma: 0.5, lumaStd: 0.05,
  lumaRing: 0.5, contrast: 1, saturation: 0.1, distance: 5, fullyInView: true, projectedExtent: [0.2, 0.2],
  occlusion: 0, litFacing: 1, backFacing: 0, mainLight: null, ...o,
});
// 継ぎ目6 の焦点 (14, 5.1, 122) から破片 C6_p0 を見る。灯りは手前 / 裏へ回した（9/8 の「真っ黒な板」）
const shardLit = base({ name: "C6_p0", pixels: 22414, share: 0.0366, center: [0.5897, 0.504], luma: 0.3829, lumaStd: 0.0202,
  lumaRing: 0.537, contrast: 0.7374, saturation: 0.17, distance: 4.114, occlusion: 0, litFacing: 0.9768,
  mainLight: { name: "C6_fill", facing: 0.9897 }, isolatedPixels: 22414 });
const shardDark = base({ name: "C6_p0", pixels: 22414, share: 0.0366, center: [0.5897, 0.504], luma: 0.2706, lumaStd: 0.05,
  lumaRing: 0.6807, contrast: 0.4387, saturation: 0.1714, distance: 4.114, occlusion: 0, litFacing: 0.0006,
  mainLight: { name: "C6_fill", facing: 0 }, isolatedPixels: 22414 });
// 第四幕の井戸（6m 下）を縁から見下ろす。底の冷たい灯り 2 灯をあり / なし（「深さが見えない」）
const pitOn = base({ name: "W5_pit", pixels: 53288, share: 0.087, center: [0.6166, 0.4149], luma: 0.3446, lumaStd: 0.1248,
  lumaRing: 0.3817, contrast: 0.9143, distance: 16.7252, fullyInView: false, projectedExtent: [2.0181, 0.6323],
  occlusion: 0.8607, litFacing: 1, mainLight: { name: "W5_pl281", facing: 1 } });
const pitOff = base({ ...pitOn, luma: 0.1757, lumaStd: 0.0161, lumaRing: 0.3224, contrast: 0.6059,
  mainLight: { name: "C23_fill", facing: 1 } });
// 破片に 0.5m 未満まで寄った（fov 45）。「仕掛けが画面を埋める」
const shardFill = base({ name: "C6_p0", pixels: 612241, share: 1, center: [0.5, 0.5], luma: 0.1624, lumaStd: 0.0276,
  lumaRing: null, contrast: null, distance: 1.0621, fullyInView: false, projectedExtent: [1.3039, 1.5029] });

console.log("[4] 実測値 → 直感どおりの語");
{
  const lit = targetFacts(shardLit).facts, dark = targetFacts(shardDark).facts;
  check("灯りが手前の破片は「照らされている」", lit.lit_side === "照らされている", JSON.stringify(lit));
  check("灯りを裏へ回すと「影」", dark.lit_side === "影（灯りは裏側から当たっている）", JSON.stringify(dark));
  check("主光源が裏から当たっていると名指しする", dark.main_light === "C6_fill（裏側から当たっている）", dark.main_light);
  check("暗くなった破片は「暗い」", dark.brightness === "暗い" && lit.brightness === "中くらい");
  check("破片は周囲より暗い", dark.contrast?.includes("周囲より暗い") === true && lit.contrast?.includes("周囲より暗い") === true);
  check("大きさは「小さい」・位置は「中央やや右」", dark.screen_share === "小さい" && dark.position === "中央やや右");
  check("遮られていない・視野に収まる", dark.occluded === "隠れていない" && dark.fits_in_view === "全体が視野に収まる");

  const on = targetFacts(pitOn).facts, off = targetFacts(pitOff).facts;
  check("井戸の底は灯りがあれば陰影がはっきり", on.texture === "模様・陰影がはっきり" && on.brightness === "中くらい", JSON.stringify(on));
  check("底の灯りを消すと「暗い」「陰影が少ない」", off.brightness === "暗い" && off.texture === "模様・陰影が少ない", JSON.stringify(off));
  check("井戸は縁で大半が隠れている・遠い", on.occluded === "大半が隠れている" && on.distance === "中くらいの距離");
  check("横に長い井戸は一部が画面の外（画面より大きい）", on.fits_in_view === "収まらない（画面より大きい）");

  const fill = targetFacts(shardFill).facts;
  check("寄りすぎると「画面の大半」「収まらない」", fill.screen_share === "画面の大半" && fill.fits_in_view === "収まらない（画面より大きい）", JSON.stringify(fill));
  check("周囲が無ければ contrast は言わない", fill.contrast === undefined);
}

console.log("[5] 見えていない対象と半透明");
{
  const hidden = targetFacts(base({ pixels: 0, share: 0, center: null, isolatedPixels: 300, occlusion: 1 })).facts;
  check("遮蔽物の陰 → 完全に隠れている", hidden.visibility?.startsWith("完全に隠れている") === true && Object.keys(hidden).length <= 2,
    JSON.stringify(hidden));
  const outside = targetFacts(base({ pixels: 0, share: 0, center: null, isolatedPixels: 0, fullyInView: false, projectedExtent: null })).facts;
  check("視野の外", outside.visibility === "視野の外");
  const noMesh = targetFacts(base({ pixels: 0, share: 0, members: 0, fullyInView: null, projectedExtent: null })).facts;
  check("メッシュを持たない", noMesh.visibility?.startsWith("描く物が無い") === true);
  const ghost = targetFacts(base({ transparentMembers: 1 })).facts;
  check("半透明は material に出す", ghost.material === "半透明");
  const unlit = targetFacts(base({ litFacing: null, unlit: true })).facts;
  check("灯りが届かない", unlit.lit_side === "どの灯りも届いていない");
  const back = targetFacts(base({ backFacing: 0.9, litFacing: 0 })).facts;
  check("裏面が見えている", back.back_face?.startsWith("はい") === true);
}

console.log("[6] シーン全体と facts に数値が混ざらないこと");
{
  check("空だけの領域", regionWord({ empty: 1, luma: 0.6, lumaStd: 0.02, distance: null }) === "何も描かれていない（空）");
  check("暗くてのっぺり → 見えない", regionWord({ empty: 0, luma: 0.08, lumaStd: 0.005, distance: 30 }) === "暗くて何も見えない");
  check("明るいがのっぺり → 霧か無地", regionWord({ empty: 0, luma: 0.5, lumaStd: 0.005, distance: 30 }) === "一様（霧か無地の面だけ）");
  check("面が見える（距離付き）", regionWord({ empty: 0, luma: 0.5, lumaStd: 0.1, distance: 6 }) === "面が見える（近い）");
  check("空が半分", regionWord({ empty: 0.5, luma: 0.5, lumaStd: 0.1, distance: 6 }) === "空が半分くらい・面が見える（近い）");
  // 実測（井戸の真上から真下、底の灯りなし）: 面はあるが真っ暗に近い。明るさを添えて言う
  check("暗い面は明るさも添える", regionWord({ empty: 0, luma: 0.14, lumaStd: 0.03, distance: 9.8 }) === "面が見える（中くらいの距離・とても暗い）",
    regionWord({ empty: 0, luma: 0.14, lumaStd: 0.03, distance: 9.8 }));

  const raw: PerceiveRaw = {
    mode: "Editor",
    camera: { source: "explicit", position: [14, 5.1, 122], fovDeg: 72 },
    scene: {
      empty: 0,
      regions: {
        top: { empty: 0, luma: 0.5037, lumaStd: 0.1536, distance: 15.0098 },
        bottom: { empty: 0, luma: 0.5155, lumaStd: 0.1343, distance: 6.0777 },
        left: { empty: 0, luma: 0.4769, lumaStd: 0.1506, distance: 10.1008 },
        right: { empty: 0, luma: 0.5422, lumaStd: 0.1301, distance: 10.9707 },
      },
      luma: { mean: 0.5096, p5: 0.2588, p50: 0.5137, p95: 0.7569, crushed: 0, clipped: 0.0006 },
      farthest: 26.7246,
    },
    targets: [shardDark],
    top: [base({ name: "N1_flr_s", share: 0.4046 }), base({ name: "N1_s_1", share: 0.2799 }), shardDark, base({ name: "extra" })],
  };
  const f = perceptionFacts(raw);
  check("視点の説明", f.viewpoint === "指定した視点（エディタ）", f.viewpoint);
  check("下半分に面が見える", f.scene.lower_half === "面が見える（近い）", f.scene.lower_half);
  check("最も遠い面", f.scene.farthest_surface === "遠い");
  check("白飛び・黒潰れ", f.scene.black_crush === "ほぼ無い" && f.scene.blown_out === "ほぼ無い");
  check("画面を占めている物", f.scene.dominant === "N1_flr_s（画面の大半）", f.scene.dominant);
  check("top は既定 3 件", f.top.length === 3);
  check("targets は対象の数だけ", f.targets.length === 1 && f.targets[0].name === "C6_p0");
  const noDigitKeys = ["main_light", "dominant"];   // 名前（エンティティ名）には数字が入り得る
  const leaks: string[] = [];
  const scan = (o: Record<string, string>) => {
    for (const [k, v] of Object.entries(o)) if (!noDigitKeys.includes(k) && /[0-9]/.test(v)) leaks.push(`${k}=${v}`);
  };
  scan(f.scene);
  for (const t of [...f.targets, ...f.top]) scan(t.facts);
  check("facts の語に数値が混ざらない", leaks.length === 0, leaks.join(" / "));
  check("元の数値は raw に残る", f.targets[0].raw.litFacing === 0.0006 && f.targets[0].raw.share === 0.0366);

  const empty = perceptionFacts({ ...raw, scene: { ...raw.scene, farthest: null }, targets: [], top: [] });
  check("何も描かれていなければ「無い」", empty.scene.farthest_surface === "無い（何も描かれていない）" && empty.scene.dominant === undefined);
}

console.log(failed === 0 ? "\nOK: perceive テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
