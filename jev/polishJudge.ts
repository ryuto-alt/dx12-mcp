// polish_audit の判断段。「エンジンが測る → 数字を言葉にする → Jev が型で判断する → Claude が直す」の
// 3 番目。polish.ts のルール(auditScene)はそのまま残し、その上に「Brief に照らしてどうか」を載せる。
//
// ★ルールを捨てない理由: Jev は鍵が無い・落ちている・Brief が無いときに使えない。
//   そのとき judge.source:"rules" で今までと同じ結論を返せば、呼ぶ側は分岐しなくてよい。
//
// ★3 つの質問を 1 往復で聞く: look.brief_fit / look.next_fix / finding.intended(指摘ごと)は
//   全部同じ state(brief + facts.look + facts.findings)に射影されるので、library が 1 リクエストに束ねる。
//   finding.intended は指摘ごとに state を変える(brief + その指摘 1 件)設計もあり得たが、
//   それだと指摘の数だけリクエストが増え、state(Brief)のトークンも指摘の数だけ払う。
//   state は共通にして、どの指摘を聞いているかは質問文({{code}} と英語の説明)の側で名指しする。
//   他の指摘が state に並んでいるのは「関係ない state」ではなく、画面の全体像として判断に要る情報。

import { polishScore, type Finding, type FindingCode, type SceneFacts, PROCEDURAL_SKY } from "../polish.ts";
import { ask, type AskOptions, type AskOutcome, type JevResult, type QuestionRef, type RuleFn } from "./library.ts";
import type { JudgePlan } from "./judgeCommon.ts";
import { BINS, ratioWord, wordOf, yesNo } from "./wordify.ts";
import type { Brief } from "./brief.ts";

// ────────────────────────────────────────────────────────────────
//  指摘の言い換え(数値を含まない)
// ────────────────────────────────────────────────────────────────

/**
 * state に入れる指摘文。polish.ts の what は「画面の 55.0%」のように数値入りなので使わない
 * (数値の大小は Jev の弱点。量は facts.look の語で渡してある)。
 */
export const FINDING_TEXT: Record<FindingCode, string> = {
  NO_LIGHTS: "ライトが 1 つも無い",
  SUN_ONLY: "光源が太陽だけで、補助光(フィル・リム)が無い",
  LIGHTS_OVER_BUDGET: "ライトが上限を超えていて、超過分が描画されていない",
  NO_SHADOW_CASTER: "影を落とすライトが無い",
  NO_HDRI: "環境マップ(HDRI)が無く、既定の手続き空のまま",
  NO_FOG: "空気(ボリュメトリックフォグ)が入っていない",
  POST_PASSTHROUGH: "ポストプロセスが素通し(色調の仕上げが無い)",
  NO_BLOOM: "ブルーム(光のにじみ)が無い",
  NO_VIGNETTE: "ビネット(四隅の減光)が無い",
  GODRAYS_FOG_DOUBLE: "ゴッドレイとフォグが両方強く、光の散乱が二重に乗っている",
  NO_MOTION: "画面の中で動くもの(パーティクル)が無い",
  NO_NORMAL_MAPS: "法線マップが使われておらず、表面がつるつる",
  DEFAULT_PBR: "ほとんどの素材が既定の質感(roughness/metallic)のまま",
  NO_SSAO: "SSAO(接触部の陰り)が無い",
  NO_CONTACT_SHADOW: "コンタクトシャドウ(足元の細かい影)が無い",
  FLAT_IMAGE: "明暗の幅が狭く、眠い絵になっている",
  CLIPPED_WHITES: "白飛びしている面積が大きい",
  CRUSHED_BLACKS: "真っ黒に潰れている面積が大きい",
  DESATURATED: "色がほとんど無い(彩度が低い)",
};

const SEVERITY_WORD = { high: "重大", medium: "中", low: "軽微" } as const;

// ────────────────────────────────────────────────────────────────
//  次の一手(look.next_fix の選択肢) → 実行するツール
// ────────────────────────────────────────────────────────────────

export type FixSpec = {
  /** 実行する MCP ツール。null は「何もしない」。 */
  tool: string | null;
  /** 引数の例。<...> は呼ぶ側(Claude)が埋める。 */
  args: Record<string, unknown>;
  what: string;
  /** この直しが解消する指摘。ルールのフォールバックはこの表を逆引きする。 */
  codes: FindingCode[];
};

/**
 * ★選択肢は「今ある MCP ツールで実際に撃てるもの」だけ。polish.ts の fix 文と lookDev / vfx / decals の
 *   語彙から拾った。キーの集合は jev/questions/look.next_fix.jevq.json の criteria と一致していること
 *   (polishJudge.test.ts が突き合わせる)。
 */
export const FIXES: Record<string, FixSpec> = {
  keep_as_is: { tool: null, args: {}, what: "今のままでよい(残りの指摘は作品の意図どおり)", codes: [] },
  apply_look: { tool: "dx12_look_apply", args: { preset: "golden_hour" },
    what: "ルック(太陽+フォグ+色調)を Brief に合うプリセットで一括で当てる", codes: ["POST_PASSTHROUGH"] },
  add_key_light: { tool: "dx12_apply_lighting_preset", args: { preset: "day" },
    what: "土台の光をプリセットで入れる", codes: ["NO_LIGHTS"] },
  add_fill_light: { tool: "dx12_create_entity", args: { type: "light_point", name: "LGT_Fill_01", position: [2, 2, 2] },
    what: "キーの反対側に弱いフィル、被写体の後ろにリムの点光源を置く", codes: ["SUN_ONLY"] },
  fix_light_budget: { tool: "dx12_list_lights", args: {},
    what: "overBudget のライトを見つけて消すか range を絞る", codes: ["LIGHTS_OVER_BUDGET"] },
  enable_shadows: { tool: "dx12_set_component", args: { name: "<主要なライト>", component: "pointLight", data: { castShadow: true } },
    what: "主要なライトの影を有効にする", codes: ["NO_SHADOW_CASTER"] },
  add_hdri: { tool: "dx12_scene_env", args: { keyword: "studio" },
    what: "PolyHaven の HDRI を環境マップにする", codes: ["NO_HDRI"] },
  add_fog: { tool: "dx12_set_volumetric_fog", args: { enabled: true, density: 0.02, anisotropy: 0.5 },
    what: "ボリュメトリックフォグで空気と奥行きを入れる", codes: ["NO_FOG"] },
  add_bloom: { tool: "dx12_set_post_process", args: { bloomOn: true, bloom: 0.4, bloomThreshold: 1.05 },
    what: "ブルームで光源を光らせる", codes: ["NO_BLOOM"] },
  add_vignette: { tool: "dx12_set_post_process", args: { vignetteOn: true, vignette: 0.28, vignetteRadius: 0.8, vignetteSoftness: 0.5 },
    what: "ビネットで視線を中央へ寄せる", codes: ["NO_VIGNETTE"] },
  soften_godrays: { tool: "dx12_set_post_process", args: { grIntensity: 0.3 },
    what: "ゴッドレイを弱めて散乱の二重掛けを解く", codes: ["GODRAYS_FOG_DOUBLE"] },
  add_motion: { tool: "dx12_vfx_apply", args: { preset: "dust_motes", position: [0, 1.5, 0] },
    what: "漂う埃などの小さな動きを光の当たる場所へ置く", codes: ["NO_MOTION"] },
  add_surface_detail: { tool: "dx12_material_apply", args: { name: "<対象>", dir: "<PBR セットのフォルダ>" },
    what: "法線マップと ORM を貼り、素材ごとに質感を変える", codes: ["NO_NORMAL_MAPS", "DEFAULT_PBR"] },
  enable_ssao: { tool: "dx12_set_ssao", args: { enabled: true, intensity: 0.8, radius: 0.5 },
    what: "SSAO で接地部に陰りを入れる", codes: ["NO_SSAO"] },
  enable_contact_shadow: { tool: "dx12_set_contact_shadow", args: { enabled: true },
    what: "コンタクトシャドウで小物の足元を締める", codes: ["NO_CONTACT_SHADOW"] },
  deepen_contrast: { tool: "dx12_set_sun", args: { ambient: 0.15 },
    what: "環境光を下げて影を締め、明暗差を作る(足りなければ contrast)", codes: ["FLAT_IMAGE"] },
  lower_exposure: { tool: "dx12_set_post_process", args: { exposureOn: true, exposure: 0.8 },
    what: "露出を下げて白飛びを戻す", codes: ["CLIPPED_WHITES"] },
  lift_shadows: { tool: "dx12_set_sun", args: { ambient: 0.12 },
    what: "環境光かフィルを足して黒つぶれを持ち上げる", codes: ["CRUSHED_BLACKS"] },
  boost_color: { tool: "dx12_set_post_process", args: { saturationOn: true, saturation: 1.15 },
    what: "彩度を上げる(先に HDRI と素材の色を疑う)", codes: ["DESATURATED"] },
  add_decals: { tool: "dx12_decal_apply", args: { preset: "dirt", position: [0, 0, 0], size: 2.4, opacity: 0.4 },
    what: "汚れ・傷のデカールで使われた痕跡を足す", codes: [] },
  // ★ルール(auditScene)は「足りない」しか見ないので、盛りすぎ(ブルーム過多・彩度過多)は拾えない。
  //   Brief に照らすと「やりすぎ」も直すべき状態なので、判断段にだけある選択肢として置く。
  tone_down_grading: { tool: "dx12_set_post_process",
    args: { bloom: 0.2, saturationOn: true, saturation: 0.92, contrastOn: true, contrast: 1.0 },
    what: "盛りすぎた色調(強いブルーム・彩度・コントラスト)を控えめに戻す", codes: [] },
};

export const FIX_BY_CODE: Record<FindingCode, string> = Object.fromEntries(
  Object.entries(FIXES).flatMap(([id, f]) => f.codes.map((c) => [c, id])),
) as Record<FindingCode, string>;

/**
 * Brief の言葉からルックのプリセットを引く(apply_look / add_key_light の引数を埋めるだけ)。
 * ★判断ではなく引数の下書き。外れても Claude が dx12_look_library で選び直せば済む。
 */
export function suggestLookPreset(brief: Brief | null | undefined): { look: string; lighting: string; matched: boolean } {
  const t = JSON.stringify(brief ?? {}).toLowerCase();
  const table: [RegExp, string, string][] = [
    [/ホラー|horror|恐怖|怖/, "horror_candle", "horror"],
    [/ノワール|noir|ネオン|neon|サイバー/, "neon_noir", "night"],
    [/白黒|モノクロ/, "film_noir", "night"],
    [/水中|underwater/, "underwater", "dusk"],
    [/砂漠|desert/, "desert_heat", "day"],
    [/レトロ|vhs/, "retro_vhs", "indoor"],
    [/夢|dream|幻想/, "dreamy_soft", "day"],
    [/夜|night|月/, "moonlit_night", "night"],
    [/夕|golden|夕焼け/, "golden_hour", "dusk"],
    [/リミナル|liminal|空虚/, "overcast_gloom", "indoor"],
    [/写実|realistic|実写|リアル/, "clean_studio", "indoor"],
    [/明る|かわいい|パズル|アニメ|anime|cute|bright|ポップ/, "anime_daylight", "day"],
  ];
  for (const [re, look, lighting] of table) if (re.test(t)) return { look, lighting, matched: true };
  return { look: "golden_hour", lighting: "day", matched: false };
}

// ────────────────────────────────────────────────────────────────
//  facts → 言葉
// ────────────────────────────────────────────────────────────────

const POST_NAMES: Record<string, string> = {
  bloomOn: "ブルーム", vignetteOn: "ビネット", exposureOn: "露出補正", contrastOn: "コントラスト",
  saturationOn: "彩度補正", autoExposureOn: "自動露出", lutOn: "LUT", grainOn: "フィルムグレイン",
  godraysOn: "ゴッドレイ", dofOn: "被写界深度", tintOn: "色味(ティント)",
};

/**
 * SceneFacts → Jev に渡す言葉(look)と、人とログ用の元の数値(raw)。
 * ★look には数値を 1 つも入れない。読めなかった項目は落とす(「無い」と決めつけない)。
 */
export function wordifyLook(f: SceneFacts): { look: Record<string, string>; raw: Record<string, unknown> } {
  const look: Record<string, string | undefined> = {};
  const raw: Record<string, unknown> = {};
  const im = f.image;
  if (im) {
    look.brightness = wordOf("luma", im.meanLuma);
    look.contrast = wordOf("contrast", im.dynamicRange);
    look.colorSaturation = wordOf("saturation", im.saturation);
    look.crushedBlackArea = wordOf("areaPct", im.blackPct);
    look.blownWhiteArea = wordOf("areaPct", im.whitePct);
    Object.assign(raw, { meanLuma: im.meanLuma, dynamicRange: im.dynamicRange, saturation: im.saturation,
                         blackPct: im.blackPct, whitePct: im.whitePct });
  }
  look.setting = yesNo(f.outdoor, "屋外(空が見える)", "屋内");
  if (f.envMapPath !== undefined) {
    const hdri = f.envMapPath !== "" && f.envMapPath !== PROCEDURAL_SKY;
    look.environmentLight = hdri ? "HDRI(実写の環境光)あり" : "既定の手続き空のまま(HDRI なし)";
    raw.envMapPath = f.envMapPath;
  }
  if (f.lights) {
    const dir = f.lights.filter((l) => l.type.toLowerCase().includes("direction"));
    const others = f.lights.length - dir.length;
    look.sun = dir.length > 0 ? "あり" : "なし";
    look.otherLights = wordOf("count", others);
    look.shadowCastingLights = f.lights.some((l) => l.castShadow) ? "あり" : "なし";
    if (f.lights.some((l) => l.overBudget)) look.lightsOverBudget = "上限超過で描画されていない光がある";
    raw.lights = f.lights.length;
    raw.otherLights = others;
  }
  if (f.fog) {
    const on = f.fog.enabled === true && (f.fog.density ?? 0) > 0.001;
    look.fog = on ? wordOf("fogDensity", f.fog.density ?? 0) : "なし";
    raw.fogDensity = on ? f.fog.density ?? 0 : 0;
  }
  if (f.post) {
    const enabled = Object.keys(POST_NAMES).filter((k) => f.post?.[k] === true);
    look.postEffects = enabled.length ? enabled.map((k) => POST_NAMES[k]).join("・") : "素通し(トーンマップのみ)";
    if (f.post.bloomOn === true && typeof f.post.bloom === "number") {
      look.bloomStrength = wordOf("bloom", f.post.bloom);
      raw.bloom = f.post.bloom;
    }
    raw.postEffects = enabled;
  }
  if (f.emitterCount !== undefined) { look.movingParticles = wordOf("count", f.emitterCount); raw.emitterCount = f.emitterCount; }
  if (f.decalCount !== undefined) { look.dirtAndWearDecals = wordOf("count", f.decalCount); raw.decalCount = f.decalCount; }
  look.normalMappedMeshes = ratioWord(f.normalMapCount, f.meshCount);
  look.untouchedMaterials = ratioWord(f.defaultPbrCount, f.meshCount);
  if (f.meshCount !== undefined) Object.assign(raw, { meshCount: f.meshCount, normalMapCount: f.normalMapCount, defaultPbrCount: f.defaultPbrCount });
  if (f.ssao) look.ambientOcclusion = yesNo(f.ssao.enabled, "あり", "なし");
  if (f.contactShadow) look.contactShadows = yesNo(f.contactShadow.enabled, "あり", "なし");

  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(look)) if (typeof v === "string") clean[k] = v;
  return { look: clean, raw };
}

/** look の語が wordify の語彙から出たものか(評価ケースの手書きが本番とずれていないかの検査用)。 */
export const LOOK_VOCAB: Record<string, readonly string[]> = {
  brightness: BINS.luma.words,
  contrast: BINS.contrast.words,
  colorSaturation: BINS.saturation.words,
  crushedBlackArea: BINS.areaPct.words,
  blownWhiteArea: BINS.areaPct.words,
  setting: ["屋外(空が見える)", "屋内"],
  environmentLight: ["HDRI(実写の環境光)あり", "既定の手続き空のまま(HDRI なし)"],
  sun: ["あり", "なし"],
  otherLights: BINS.count.words,
  shadowCastingLights: ["あり", "なし"],
  lightsOverBudget: ["上限超過で描画されていない光がある"],
  fog: BINS.fogDensity.words,
  bloomStrength: BINS.bloom.words,
  movingParticles: BINS.count.words,
  dirtAndWearDecals: BINS.count.words,
  normalMappedMeshes: BINS.ratio.words,
  untouchedMaterials: BINS.ratio.words,
  ambientOcclusion: ["あり", "なし"],
  contactShadows: ["あり", "なし"],
};

export function isLookWord(key: string, word: string): boolean {
  if (key === "postEffects") {
    if (word === "素通し(トーンマップのみ)") return true;
    const names = Object.values(POST_NAMES);
    return word.split("・").every((w) => names.includes(w));
  }
  return (LOOK_VOCAB[key] ?? []).includes(word);
}

export type JudgeContext = {
  brief: Brief | null;
  facts: { look: Record<string, string>; findings: { code: FindingCode; issue: string; severity: string }[] };
};

export function buildJudgeContext(brief: Brief | null | undefined, facts: SceneFacts, findings: Finding[]): JudgeContext {
  return {
    brief: brief ?? null,
    facts: {
      look: wordifyLook(facts).look,
      findings: findings.map((f) => ({ code: f.code, issue: FINDING_TEXT[f.code], severity: SEVERITY_WORD[f.severity] })),
    },
  };
}

// ────────────────────────────────────────────────────────────────
//  ルール(フォールバック)
// ────────────────────────────────────────────────────────────────

/** 既存ロジックの「次の一手」= 効く順に並んだ指摘の先頭を直す。 */
export const POLISH_RULES: Record<string, RuleFn> = {
  "polish.firstFindingFix": ({ context }) => {
    const first = context?.facts?.findings?.[0]?.code as FindingCode | undefined;
    const id = first ? FIX_BY_CODE[first] ?? "keep_as_is" : "keep_as_is";
    return { value: id, decided: id, reason: first ? `ルール: 効く順の先頭(${first})を直す` : "ルール: 指摘が無い" };
  },
};

// ────────────────────────────────────────────────────────────────
//  判断段の本体
// ────────────────────────────────────────────────────────────────

export const BRIEF_FIT_LEVELS = ["Brief と逆", "ほぼ外れ", "どちらでもない", "だいたい合う", "よく合う"] as const;

export type Judge = {
  source: "jev" | "cache" | "rules";
  briefMissing?: boolean;
  reason?: string;
  briefFit: { value: number; level: string; outOf: number; confidence?: number; decided?: unknown } | null;
  findings: { code: FindingCode; intended: number | null; keep: boolean; uncertain?: boolean }[];
  nextFix: { id: string; tool: string | null; args: Record<string, unknown>; what: string; confidence: number | null } | null;
  uncertain: { id: string; why: string }[];
  /** 意図どおり(keep)と判断した指摘を除いた場合のスコア。 */
  scoreExcludingKept: number;
  usd?: number;
  ms?: number;
  next?: string;
};

function fixOf(id: string, brief: Brief | null | undefined): Judge["nextFix"] {
  const spec = FIXES[id];
  if (!spec) return null;
  const args = { ...spec.args };
  if (id === "apply_look" || id === "add_key_light") {
    const s = suggestLookPreset(brief);
    args.preset = id === "apply_look" ? s.look : s.lighting;
  }
  return { id, tool: spec.tool, args, what: spec.what, confidence: null };
}

/** ルールだけで作る judge(鍵なし・Brief なし・Jev 失敗)。既存の polish の結論をそのまま入れる。 */
export function rulesJudge(findings: Finding[], reason: string, brief: Brief | null | undefined, briefMissing?: boolean): Judge {
  const first = findings[0]?.code;
  return {
    source: "rules",
    ...(briefMissing ? { briefMissing: true } : {}),
    reason,
    briefFit: null,
    findings: findings.map((f) => ({ code: f.code, intended: null, keep: false })),
    nextFix: fixOf(first ? FIX_BY_CODE[first] ?? "keep_as_is" : "keep_as_is", brief),
    uncertain: [],
    scoreExcludingKept: polishScore(findings),
  };
}

const live = (r: JevResult | undefined) => !!r && (r.source === "jev" || r.source === "cache");

export type PolishJudgeInput = { brief: Brief | null | undefined; facts: SceneFacts; findings: Finding[] };

/**
 * 聞く質問と材料(plan)。★品質ゲートは各検査の plan を集めて 1 往復で聞くので、
 * 「質問を作る」と「答えを読む」を分けてある(judgePolish は 2 つを続けて呼ぶだけ)。
 */
export function planPolish(input: PolishJudgeInput): JudgePlan & { codes: FindingCode[] } {
  const context = buildJudgeContext(input.brief, input.facts, input.findings);
  const codes = [...new Set(input.findings.map((f) => f.code))];
  const refs: QuestionRef[] = [
    "look.brief_fit",
    "look.next_fix",
    ...codes.map((code) => ({ id: "finding.intended", vars: { code } })),
  ];
  return { facts: context.facts, refs, codes };
}

/**
 * 判断段。findings は auditScene の結果(only で絞った後)。例外は投げない。
 */
export async function judgePolish(input: PolishJudgeInput & { askOptions?: AskOptions }): Promise<Judge> {
  const plan = planPolish(input);
  const out = await ask(plan.refs, { brief: input.brief ?? null, facts: plan.facts },
    { ...input.askOptions, rules: { ...POLISH_RULES, ...input.askOptions?.rules } });
  return interpretPolish(input, plan, out.results, out);
}

/** ask の答え(plan.refs と同じ順)→ judge。out は費用と Brief の有無(ゲートでは束ねた 1 往復の値)。 */
export function interpretPolish(input: PolishJudgeInput, plan: ReturnType<typeof planPolish>, results: JevResult[],
                                out: Pick<AskOutcome, "usd" | "ms" | "briefMissing">): Judge {
  const { brief, findings } = input;
  const codes = plan.codes;
  const [fitRes, nextRes, ...findRes] = results;

  if (![fitRes, nextRes, ...findRes].some(live)) {
    const why = out.briefMissing
      ? "Brief が無いのでルールで判断した(dx12_brief で作品の意図を書くと Jev が使われる)"
      : (fitRes?.error ? `Jev に聞けなかった: ${fitRes.error}` : fitRes?.reason ?? "ルールで判断した");
    return { ...rulesJudge(findings, why, brief, out.briefMissing), usd: out.usd, ms: out.ms };
  }

  const uncertain: Judge["uncertain"] = [];
  const briefFit = live(fitRes) && typeof fitRes.value === "number"
    ? {
        value: Number(fitRes.value.toFixed(2)),
        level: BRIEF_FIT_LEVELS[Math.max(0, Math.min(BRIEF_FIT_LEVELS.length - 1, Math.round(fitRes.value)))],
        outOf: BRIEF_FIT_LEVELS.length - 1,
        confidence: fitRes.confidence,
        decided: fitRes.decided,
      }
    : null;
  if (live(fitRes) && fitRes.uncertain) uncertain.push({ id: fitRes.id, why: fitRes.reason ?? "境界付近" });

  const judgedFindings: Judge["findings"] = codes.map((code, i) => {
    const r = findRes[i];
    if (!live(r)) return { code, intended: null, keep: false };
    if (r.uncertain) uncertain.push({ id: r.id, why: r.reason ?? "境界付近" });
    return { code, intended: typeof r.value === "number" ? Number(r.value.toFixed(3)) : null,
             keep: r.decided === true, ...(r.uncertain ? { uncertain: true } : {}) };
  });
  const kept = new Set(judgedFindings.filter((f) => f.keep).map((f) => f.code));
  const notKept = findings.filter((f) => !kept.has(f.code));

  let nextFix: Judge["nextFix"];
  if (live(nextRes) && typeof nextRes.value === "string") {
    nextFix = fixOf(nextRes.value, brief);
    if (nextFix) nextFix.confidence = nextRes.confidence ?? null;
    if (nextRes.uncertain) uncertain.push({ id: nextRes.id, why: nextRes.reason ?? "confidence が低い" });
    // ★2 つの判断が食い違ったら自動で直さない: 「意図どおり」と言った指摘を直そうとしている /
    //   直すべき指摘が残っているのに keep_as_is。どちらも Claude が絵を見て決める。
    const spec = FIXES[nextRes.value];
    if (spec?.codes.some((c) => kept.has(c))) {
      uncertain.push({ id: nextRes.id, why: `次の一手 ${nextRes.value} が、意図どおりと判断した指摘(${spec.codes.filter((c) => kept.has(c)).join(",")})を直そうとしている` });
    }
    if (nextRes.value === "keep_as_is" && notKept.length > 0) {
      uncertain.push({ id: nextRes.id, why: `keep_as_is だが、意図どおりでない指摘が残っている(${notKept.map((f) => f.code).join(",")})` });
    }
  } else {
    // 次の一手だけ取れなかった: 意図どおりの指摘を飛ばしてルールの先頭を採る
    const first = notKept[0]?.code;
    nextFix = fixOf(first ? FIX_BY_CODE[first] ?? "keep_as_is" : "keep_as_is", brief);
  }

  const source = [fitRes, nextRes, ...findRes].some((r) => r?.source === "jev") ? "jev" : "cache";
  return {
    source,
    briefFit,
    findings: judgedFindings,
    nextFix,
    uncertain,
    scoreExcludingKept: polishScore(notKept),
    usd: out.usd,
    ms: out.ms,
    next: uncertain.length
      ? "uncertain がある。dx12_screenshot_final の絵を自分の目で見て、そこだけは Claude が判断すること"
      : "nextFix.tool を nextFix.args で撃ち、もう一度 dx12_polish_audit で確かめる",
  };
}

