// 「この絵はまだ安っぽい。なぜか」を測って言うための判定器。
//
// ★なぜ要るか: 既存の検査は【壊れているか】しか見ない(dx12_diagnose / validate_layout)。
//   参照画像がある時は dx12_look_compare が使えるが、たいていは参照なんて無い。
//   その結果 AI は「モデルを置いて光を当てたら完成」と判断して、
//   フォグ無し・ライト 1 灯・ポスト素通し・動く物ゼロの【死んだ絵】を成果物にしてしまう。
//   高品質な絵に必ず入っている要素を並べて、入っていないものを順番に指摘する。
//
// このファイルは純関数だけ(エンジンを呼ばない)。テストは polish.test.ts。

/** エンジンから集めた事実。undefined は「読めなかった」＝判定をスキップする。 */
export type SceneFacts = {
  /** 環境マップ(HDRI)の assets 相対パス。空 = 手続き空のまま。 */
  envMapPath?: string;
  iblIntensity?: number;
  /** ライト一覧(dx12_list_lights の entries を簡約したもの)。 */
  lights?: Array<{ type: string; intensity: number; castShadow?: boolean; overBudget?: boolean }>;
  /** ボリュメトリックフォグ。 */
  fog?: { enabled?: boolean; density?: number };
  /** ポストプロセス設定(dx12_get_post_process の生の値)。 */
  post?: Record<string, unknown>;
  ssao?: { enabled?: boolean };
  contactShadow?: { enabled?: boolean };
  ssr?: { enabled?: boolean };
  /** パーティクル放出器の数(動くもの)。 */
  emitterCount?: number;
  /** シーンのエンティティ数。 */
  entityCount?: number;
  /** メッシュを持つエンティティ数。 */
  meshCount?: number;
  /** 法線マップが割り当たっているメッシュの数。 */
  normalMapCount?: number;
  /** roughness / metallic が既定のままのメッシュ数。 */
  defaultPbrCount?: number;
  /** 屋外か(空が描かれているか)。分からなければ undefined。 */
  outdoor?: boolean;
  /** 最終画の統計(screenshot を撮った時だけ)。 */
  image?: {
    /** 平均輝度 0..1。 */
    meanLuma: number;
    /** 上位 1% と下位 1% の輝度差(コントラストの実効レンジ)。 */
    dynamicRange: number;
    /** 完全な黒(輝度 0.02 未満)の画素割合(%)。 */
    blackPct: number;
    /** 完全な白(輝度 0.98 超)の画素割合(%)。 */
    whitePct: number;
    /** 平均彩度 0..1。 */
    saturation: number;
  };
};

/** エンジン内蔵のグラデーション空を指す sentinel(src/scene/Scene.h の kProceduralSkyPath)。 */
export const PROCEDURAL_SKY = "__procedural_sky__";

export type Severity = "high" | "medium" | "low";
export const CATEGORIES = ["light", "air", "grade", "motion", "material", "contact", "image"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Finding = {
  category: Category;
  severity: Severity;
  /** 何が足りないか(1 行)。 */
  what: string;
  /** なぜそれで安っぽく見えるか。 */
  why: string;
  /** 次に撃つツール(そのまま実行できる形)。 */
  fix: string;
};

const on = (post: Record<string, unknown> | undefined, key: string): boolean =>
  !!post && post[key] === true;
const numOf = (post: Record<string, unknown> | undefined, key: string, d = 0): number => {
  const v = post?.[key];
  return typeof v === "number" ? v : d;
};

/**
 * 事実 → 指摘。順番は「効く順」(光 → 空気 → 階調 → 動き → 素材 → 接地)。
 * ★1 つの指摘に必ず【why】と【次に撃つコマンド】を付ける。
 *   「フォグが無い」だけでは AI は動けないし、動いても値が出鱈目になる。
 */
export function auditScene(f: SceneFacts): Finding[] {
  const out: Finding[] = [];

  // ── 光 ──────────────────────────────────────────────
  if (f.lights) {
    const dir = f.lights.filter((l) => l.type.toLowerCase().includes("direction"));
    const others = f.lights.filter((l) => !l.type.toLowerCase().includes("direction"));
    if (f.lights.length === 0) {
      out.push({
        category: "light", severity: "high",
        what: "ライトが 1 つも無い",
        why: "環境光だけの絵は陰影が付かず、形が読めない平面の集まりに見える。",
        fix: "dx12_apply_lighting_preset(preset:'day') か dx12_look_apply(preset:'golden_hour')",
      });
    } else if (dir.length > 0 && others.length === 0) {
      out.push({
        category: "light", severity: "medium",
        what: "光源が太陽 1 灯だけ(補助光が無い)",
        why: "キーライトだけだと影が真っ黒に潰れ、立体の『回り込み』が消えて安っぽく見える。"
          + "実写もゲームも、見せたい物には必ずフィル(起こし)とリム(輪郭)が入っている。",
        fix: "dx12_create_entity(type:'light_point') を 2 つ置き、キーの反対側に弱いフィル(intensity 1/4 程度)、"
          + "被写体の後ろにリムを置く。屋外なら dx12_scene_env の HDRI がフィルの代わりになる",
      });
    }
    if (f.lights.some((l) => l.overBudget)) {
      out.push({
        category: "light", severity: "high",
        what: "ライトが上限を超えていて、超過分は描画されていない",
        why: "『置いたのに明るくならない』の原因はほぼこれ。無言で切り捨てられる。",
        fix: "dx12_list_lights で overBudget のものを消すか range を絞る",
      });
    }
    if (f.lights.length > 0 && !f.lights.some((l) => l.castShadow)) {
      out.push({
        category: "light", severity: "medium",
        what: "影を落とすライトが 1 つも無い",
        why: "影が無いと物が床から浮いて見える(接地感が消える)。絵の説得力はほぼ影で決まる。",
        fix: "主要なライトの castShadow を有効にする(dx12_set_component component:'pointLight'/'spotLight' data:{castShadow:true})",
      });
    }
  }
  // ★「手続き空」は空文字ではなく sentinel で入っている(Scene.h の kProceduralSkyPath)。
  //   空文字だけ見ていると、既定のシーンがそのまま合格してしまう(実測で踏んだ)。
  if (f.envMapPath !== undefined && (f.envMapPath === "" || f.envMapPath === PROCEDURAL_SKY)) {
    out.push({
      category: "light", severity: "high",
      what: "環境マップ(HDRI)が無く、手続き空のまま",
      why: "既定の空は全体に青を乗せて彩度を奪う(実測: 同じ木箱が青灰色 → 本来の木の色になった)。"
        + "金属と光沢は【映り込む物が無いと質感そのものが出ない】。",
      fix: "dx12_scene_env(keyword:'sunset' か 'studio' 等) で PolyHaven の HDRI を入れる。"
        + "屋内で環境光を効かせたくない場合は入れない(ambient が無視されるため)",
    });
  }

  // ── 空気 ────────────────────────────────────────────
  const fogOn = f.fog?.enabled === true && (f.fog?.density ?? 0) > 0.001;
  if (f.fog && !fogOn) {
    out.push({
      category: "air", severity: f.outdoor === false ? "low" : "medium",
      what: "空気(ボリュメトリックフォグ)が入っていない",
      why: "遠近が濃さで分かれないと、遠景と近景が同じ平面に貼り付いて見える。"
        + "光の筋(ゴッドレイ)も空気が無いと立体的に出ない。",
      fix: "dx12_set_volumetric_fog(enabled:true, density:0.012〜0.03, anisotropy:0.5) "
        + "または dx12_look_apply でルートごと当てる",
    });
  }

  // ── 階調(グレーディング)────────────────────────────
  if (f.post) {
    const graded = ["bloomOn", "vignetteOn", "exposureOn", "contrastOn", "saturationOn",
                    "autoExposureOn", "lutOn", "grainOn"].filter((k) => on(f.post, k));
    if (graded.length === 0) {
      out.push({
        category: "grade", severity: "high",
        what: "ポストプロセスが素通し(トーンマップだけ)",
        why: "HDR の絵をそのまま出すと『眠い CG』になる。ブルーム・露出・コントラストが"
          + "入って初めて『撮られた絵』になる。",
        fix: "dx12_look_apply(preset:'golden_hour' 等) で光+空気+階調を一括で当てる",
      });
    } else if (!on(f.post, "bloomOn")) {
      out.push({
        category: "grade", severity: "medium",
        what: "ブルームが無効",
        why: "光源や発光パーティクルが【ただの明るい面】になる。加算エフェクトは"
          + "ブルームに乗って初めて光って見える。",
        fix: "dx12_set_post_process(bloomOn:true, bloom:0.4, bloomThreshold:1.05)",
      });
    }
    if (graded.length > 0 && !on(f.post, "vignetteOn")) {
      out.push({
        category: "grade", severity: "low",
        what: "ビネットが無い",
        why: "四隅が明るいままだと視線が画面外へ逃げる。わずかな減光で中央へ誘導できる。",
        fix: "dx12_set_post_process(vignetteOn:true, vignette:0.28, vignetteRadius:0.8, vignetteSoftness:0.5)",
      });
    }
    if (on(f.post, "godraysOn") && fogOn && numOf(f.post, "grIntensity") > 0.5) {
      out.push({
        category: "air", severity: "low",
        what: "ゴッドレイとボリュメトリックフォグが両方強い",
        why: "太陽の散乱が二重に乗って白飛びする。どちらかを主役にすること。",
        fix: "dx12_set_post_process(grIntensity:0.3) か dx12_set_volumetric_fog(sunIntensity:0.6)",
      });
    }
  }

  // ── 動き ────────────────────────────────────────────
  if (f.emitterCount !== undefined && f.emitterCount === 0) {
    out.push({
      category: "motion", severity: "medium",
      what: "画面の中で動くものが 1 つも無い(パーティクルがゼロ)",
      why: "静止した絵は『作りかけ』に見える。埃・虫・火の粉・葉のような"
        + "小さな動きが 1 つ入るだけで空気が生きる(安い割に効果が大きい)。",
      fix: "dx12_vfx_apply(preset:'dust_motes') を光の当たる場所へ。"
        + "屋外の夜は 'fireflies'、焚き火の周りは 'ember_drift'",
    });
  }

  // ── 素材 ────────────────────────────────────────────
  if (f.meshCount !== undefined && f.meshCount > 0) {
    if (f.normalMapCount !== undefined && f.normalMapCount === 0) {
      out.push({
        category: "material", severity: "medium",
        what: "法線マップが 1 枚も使われていない",
        why: "面がつるつるのままだと、どんなに光を凝っても『粘土の模型』に見える。"
          + "凹凸は光の当たり方でしか伝わらない。",
        fix: "dx12_material_apply(name:<対象>, textureDir:<PBR セットのフォルダ>) で"
          + "albedo/normal/ORM をまとめて貼る",
      });
    }
    const defRatio = (f.defaultPbrCount ?? 0) / f.meshCount;
    if (defRatio > 0.8) {
      out.push({
        category: "material", severity: "medium",
        what: `メッシュの ${Math.round(defRatio * 100)}% が既定の PBR 値のまま`,
        why: "roughness が全部同じだと、木も金属も布も同じ『プラスチック』に見える。"
          + "質感の差は roughness の差で出る。",
        fix: "dx12_set_pbr で材質ごとに変える(金属 metallic:1 roughness:0.25 / "
          + "木 metallic:0 roughness:0.6 / 布 roughness:0.9)",
      });
    }
  }

  // ── 接地 ────────────────────────────────────────────
  if (f.ssao && f.ssao.enabled === false) {
    out.push({
      category: "contact", severity: "medium",
      what: "SSAO(接触部の陰り)が無効",
      why: "物と床の接点に陰りが無いと、置いてあるのではなく浮いて見える。",
      fix: "dx12_set_ssao(enabled:true, intensity:0.8, radius:0.5)",
    });
  }
  if (f.contactShadow && f.contactShadow.enabled === false && f.ssao?.enabled) {
    out.push({
      category: "contact", severity: "low",
      what: "コンタクトシャドウが無効",
      why: "シャドウマップは細かい接地の影を落としきれない。小物の足元が甘いままになる。",
      fix: "dx12_set_contact_shadow(enabled:true)",
    });
  }

  // ── 絵そのもの ──────────────────────────────────────
  if (f.image) {
    const im = f.image;
    if (im.dynamicRange < 0.35) {
      out.push({
        category: "image", severity: "high",
        what: `明暗の幅が狭い(実効レンジ ${im.dynamicRange.toFixed(2)})`,
        why: "一番明るい所と暗い所の差が小さい絵は、霧がかかったように眠く見える。"
          + "まず光で差を作り、それでも足りなければコントラストで詰める。",
        fix: "環境光(ambient)を下げて影を締める → dx12_set_sun(ambient:0.15) の後、"
          + "dx12_set_post_process(contrastOn:true, contrast:1.15)",
      });
    }
    if (im.whitePct > 8) {
      out.push({
        category: "image", severity: "high",
        what: `白飛びが多い(画面の ${im.whitePct.toFixed(1)}%)`,
        why: "飛んだ所は色も形も失われる。明るさは露出で作るもので、飽和で作るものではない。",
        fix: "dx12_set_post_process(exposureOn:true, exposure:0.8) か、"
          + "光源の intensity を下げる(dx12_list_lights で強い順に見る)",
      });
    }
    if (im.blackPct > 35) {
      out.push({
        category: "image", severity: "medium",
        what: `真っ黒な面積が大きい(画面の ${im.blackPct.toFixed(1)}%)`,
        why: "暗いのと『何も無い』のは違う。潰れた所に情報が無いと、"
          + "作り込んでいない場所を隠しているように見える。",
        fix: "環境光かフィルライトを少し足す(dx12_set_sun(ambient:0.12) / 弱い point light)。"
          + "暗所を暗いまま見せたいならフォグで『空気の明るさ』を足す",
      });
    }
    if (im.saturation < 0.08) {
      out.push({
        category: "image", severity: "low",
        what: `彩度がほぼ無い(${im.saturation.toFixed(3)})`,
        why: "白黒狙いでないなら、色が無い＝マテリアルか環境光のどちらかが死んでいる。",
        fix: "dx12_scene_env で HDRI を入れる / dx12_set_post_process(saturationOn:true, saturation:1.15)",
      });
    }
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** 指摘から 100 点満点のスコア(high -12 / medium -6 / low -2)。 */
export function polishScore(findings: Finding[]): number {
  let s = 100;
  for (const f of findings) s -= f.severity === "high" ? 12 : f.severity === "medium" ? 6 : 2;
  return Math.max(0, s);
}

/** スコアの言い換え(数字だけだと次の一手が決まらないので)。 */
export function verdict(score: number, findings: Finding[]): string {
  if (findings.length === 0) return "必須要素は全部入っている。あとは構図と密度の勝負";
  const high = findings.filter((f) => f.severity === "high").length;
  if (high >= 2) return "土台が欠けている。high の指摘を上から順に潰すこと(効く順に並べてある)";
  if (score >= 85) return "だいたい出来ている。medium を 1〜2 個潰せば仕上がる";
  return "『それらしい絵』の手前。high → medium の順に潰すこと";
}

// ── 最終画の統計 ────────────────────────────────────────────
// ★「眠い / 飛んでいる / 潰れている」は人が見れば一瞬だが、AI は数えないと分からない。
//   ヒストグラムの端(上位/下位 1%)で実効レンジを取るのは、1 個の外れ画素
//   (小さな光源や UI の白点)でレンジが満点になってしまうのを避けるため。

import { PNG } from "pngjs";

export type ImageFacts = NonNullable<SceneFacts["image"]>;

export function imageFacts(pngBuffer: Buffer): ImageFacts {
  const png = PNG.sync.read(pngBuffer);
  const n = png.width * png.height;
  if (n === 0) throw new Error("画像のサイズが 0");
  const hist = new Uint32Array(256);
  let sum = 0, sat = 0, black = 0, white = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    sum += l;
    hist[Math.min(255, Math.max(0, Math.round(l * 255)))]++;
    if (l < 0.02) black++;
    if (l > 0.98) white++;
    // 彩度は max-min（HSV の S 相当。平均輝度で割らないので暗部の色ノイズに強い）
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat += (mx - mn) / 255;
  }
  // 上位 / 下位 1% を落とした実効レンジ
  const cut = Math.max(1, Math.floor(n * 0.01));
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    meanLuma: r3(sum / n),
    dynamicRange: r3(Math.max(0, (hi - lo) / 255)),
    blackPct: r3((black / n) * 100),
    whitePct: r3((white / n) * 100),
    saturation: r3(sat / n),
  };
}
