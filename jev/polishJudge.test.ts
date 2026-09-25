// jev/polishJudge.ts の単体テスト(ネット不要)。
// 守りたいのは:
//   1) 表の整合: 指摘コード ⇔ 状態文 ⇔ 直し方 ⇔ 質問ファイルの英語説明、選択肢 ⇔ FIXES
//   2) 次の一手は【実在する MCP ツールと引数】だけ(index.ts の zod スキーマと突き合わせる)
//   3) Jev に渡す言葉に数値が入らない(公式 jaggedness: 数値の大小に弱い)
//   4) 判断の組み立て: 1 リクエストで 3 種、keep の反映、食い違いは uncertain、ルールへの戻り方
//   5) 評価ケース(*.cases.json)の語が本番の wordify と食い違っていない

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIEF_FIT_LEVELS, FINDING_TEXT, FIXES, FIX_BY_CODE, POLISH_RULES, buildJudgeContext, isLookWord,
  judgePolish, rulesJudge, suggestLookPreset, wordifyLook,
} from "./polishJudge.ts";
import { FINDING_CODES, auditScene, polishScore, type SceneFacts } from "../polish.ts";
import { loadLibrary } from "./library.ts";
import { validateCases } from "./eval.ts";
import { parseTsTools } from "../schemaDrift.ts";
import { LOOK_PRESETS } from "../lookDev.ts";
import { LIGHTING_PRESETS } from "../sceneTools.ts";
import { findVfxPreset as findVfx } from "../vfx.ts";
import { DECAL_IDS } from "../decals.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = loadLibrary({});

console.log("[1] 表の整合");
{
  const gloss = (lib.questions.get("finding.intended")?.lookup?.gloss?.map ?? {}) as Record<string, string>;
  for (const code of FINDING_CODES) {
    check(`${code}: 状態文・直し方・英語説明がある`, !!FINDING_TEXT[code] && !!FIX_BY_CODE[code] && !!gloss[code],
      JSON.stringify({ text: FINDING_TEXT[code], fix: FIX_BY_CODE[code], gloss: gloss[code] }));
  }
  check("英語説明に余分なコードが無い", Object.keys(gloss).every((c) => (FINDING_CODES as readonly string[]).includes(c)));
  const criteria = Object.keys((lib.questions.get("look.next_fix")?.criteria ?? {}) as object).sort();
  check("look.next_fix の選択肢 = FIXES のキー", JSON.stringify(criteria) === JSON.stringify(Object.keys(FIXES).sort()),
    `question=${criteria.join(",")}\n      fixes=${Object.keys(FIXES).sort().join(",")}`);
  check("状態文に数値が無い(量は facts.look の語で渡す)", Object.values(FINDING_TEXT).every((t) => !/\d/.test(t.replace("1 つも", ""))),
    Object.values(FINDING_TEXT).filter((t) => /\d/.test(t)).join(" / "));
  // auditScene が実際に出すコードが全部既知であること(死んだ絵を食わせて全部出させる)
  const dead: SceneFacts = {
    envMapPath: "", lights: [{ type: "Directional", intensity: 2, overBudget: true }], fog: { enabled: true, density: 0.02 },
    post: { godraysOn: true, grIntensity: 0.9, exposureOn: true }, ssao: { enabled: false }, contactShadow: { enabled: false },
    emitterCount: 0, meshCount: 10, normalMapCount: 0, defaultPbrCount: 10,
    image: { meanLuma: 0.5, dynamicRange: 0.1, blackPct: 50, whitePct: 20, saturation: 0.01 },
  };
  const codes = new Set([...auditScene(dead), ...auditScene({ lights: [] }), ...auditScene({ fog: { enabled: false }, post: {} }),
                         ...auditScene({ ssao: { enabled: true }, contactShadow: { enabled: false } })].map((f) => f.code));
  check("auditScene が出す指摘は全部 code を持ち、表にある", [...codes].every((c) => !!c && !!FINDING_TEXT[c]), [...codes].join(","));
  check("auditScene は 19 種すべてを出しうる", codes.size === FINDING_CODES.length, `${codes.size}: ${[...codes].join(",")}`);
}

console.log("[2] 次の一手は実在する MCP ツールと引数だけ");
{
  const tools = parseTsTools(fs.readFileSync(path.join(here, "..", "index.ts"), "utf8"));
  const SPREADS: Record<string, string[]> = { "...entityRef": ["entity", "name"] };
  for (const [id, fix] of Object.entries(FIXES)) {
    if (fix.tool === null) { check(`${id}: 何もしない`, id === "keep_as_is"); continue; }
    const t = tools.find((x) => x.tool === fix.tool);
    if (!t) { check(`${id}: ${fix.tool} が登録されている`, false); continue; }
    const keys = new Set(t.schemaKeys.flatMap((k) => (k.startsWith("...") ? SPREADS[k] ?? [] : [k])));
    const unknown = Object.keys(fix.args).filter((k) => !keys.has(k));
    check(`${id}: ${fix.tool} の引数 ${Object.keys(fix.args).join(",") || "(なし)"} が全部スキーマにある`, unknown.length === 0,
      `スキーマに無い: ${unknown.join(",")}`);
  }
  check("add_motion の VFX プリセットが実在", !!findVfx(String(FIXES.add_motion.args.preset)));
  check("add_decals のデカールが実在", (DECAL_IDS as readonly string[]).includes(String(FIXES.add_decals.args.preset)));
  const lookIds = LOOK_PRESETS.map((p) => p.id);
  const briefs = [{ genre: "ホラー" }, { genre: "明るいパズル" }, { genre: "リミナル" }, { genre: "写実" }, { genre: "夜の街" }, {}, null];
  check("suggestLookPreset はいつも実在のルックと照明プリセットを返す",
    briefs.every((b) => { const s = suggestLookPreset(b as any); return lookIds.includes(s.look) && (LIGHTING_PRESETS as readonly string[]).includes(s.lighting); }),
    JSON.stringify(briefs.map((b) => suggestLookPreset(b as any))));
  check("ホラーの Brief → horror_candle / horror", suggestLookPreset({ genre: "一人称ホラー" }).look === "horror_candle"
    && suggestLookPreset({ genre: "一人称ホラー" }).lighting === "horror");
}

console.log("[3] Jev に渡す言葉に数値を入れない");
{
  const variants: SceneFacts[] = [
    { image: { meanLuma: 0.07, dynamicRange: 0.52, blackPct: 55.3, whitePct: 0.3, saturation: 0.06 } },
    { envMapPath: "textures/hdri/x_2k.hdr", lights: [{ type: "Directional", intensity: 3, castShadow: true }, { type: "Point", intensity: 1 }],
      fog: { enabled: true, density: 0.03 }, post: { bloomOn: true, bloom: 1.2, vignetteOn: true }, emitterCount: 5, decalCount: 12,
      meshCount: 40, normalMapCount: 30, defaultPbrCount: 5, ssao: { enabled: true }, contactShadow: { enabled: false }, outdoor: true },
  ];
  for (const f of variants) {
    const { look, raw } = wordifyLook(f);
    check(`数字を含む語が無い(${Object.keys(look).length} 項目)`, Object.values(look).every((v) => !/[0-9０-９]/.test(v)), JSON.stringify(look));
    check("元の数値は raw に残る", Object.values(raw).some((v) => typeof v === "number"));
    check("全部の語が語彙表に載っている", Object.entries(look).every(([k, v]) => isLookWord(k, v)),
      Object.entries(look).filter(([k, v]) => !isLookWord(k, v)).map(([k, v]) => `${k}=${v}`).join(","));
  }
  check("読めなかった項目は言わない(「無い」と決めつけない)", Object.keys(wordifyLook({}).look).length === 0);
  check("fog enabled でも density 0.001 は「なし」(ルールと同じ)", wordifyLook({ fog: { enabled: true, density: 0.001 } }).look.fog === "なし");
  check("fog 無効は「なし」", wordifyLook({ fog: { enabled: false, density: 0.05 } }).look.fog === "なし");
  check("ポスト素通しの言い方", wordifyLook({ post: {} }).look.postEffects === "素通し(トーンマップのみ)");
  const ctx = buildJudgeContext({ genre: "x" }, variants[0], auditScene(variants[0]));
  check("findings は {code, issue(数値なし), severity}", ctx.facts.findings.every((f) => !!f.code && !/\d/.test(f.issue) && ["重大", "中", "軽微"].includes(f.severity)),
    JSON.stringify(ctx.facts.findings));
}

console.log("[4] 判断の組み立て");
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-judge-"));
  const facts: SceneFacts = {
    envMapPath: "__procedural_sky__", lights: [{ type: "Point", intensity: 0.8, castShadow: true }],
    fog: { enabled: false }, post: { vignetteOn: true }, emitterCount: 0, outdoor: false,
    image: { meanLuma: 0.05, dynamicRange: 0.5, blackPct: 60, whitePct: 0, saturation: 0.02 },
  };
  const findings = auditScene(facts);
  const reqs: any[] = [];
  const fake = (choice: string, keepCodes: string[], noulFor?: (code: string) => number): FetchLike => async (_u, init) => {
    const b = JSON.parse(init.body);
    reqs.push(b);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      const code = (JSON.stringify(q.instructions).match(/flagged this condition in a game scene: ([A-Z_]+)/) ?? [])[1] ?? "";
      if (q.type === "noul") answers[k] = { type: "noul", noul: noulFor ? noulFor(code) : keepCodes.includes(code) ? 0.95 : 0.05 };
      if (q.type === "choice") answers[k] = { type: "choice", choice, confidence: 0.8, probabilities: {} };
      if (q.type === "score") answers[k] = { type: "score", score: 3.7, confidence: 0.9 };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             text: async () => JSON.stringify({ model: "m", answers, usage: { input_tokens: 900, output_tokens: 40 } }) };
  };
  const brief = { genre: "一人称ホラー", mood: ["暗い"], avoid: ["明るい照明"] };
  const base = { baseDir: TMP, apiKey: "k", cache: "off" as const };

  const j = await judgePolish({ brief, facts, findings, askOptions: { ...base, fetch: fake("add_fog", ["CRUSHED_BLACKS", "DESATURATED"]) } });
  check("1 リクエストで 2 + 指摘数の質問", reqs.length === 1 && Object.keys(reqs[0].questions).length === 2 + findings.length,
    `${reqs.length} req / ${Object.keys(reqs[0]?.questions ?? {}).length} q / findings ${findings.length}`);
  check("state は brief + facts(look, findings)だけ", JSON.stringify(Object.keys(reqs[0].state).sort()) === '["brief","facts"]'
    && JSON.stringify(Object.keys(reqs[0].state.facts).sort()) === '["findings","look"]');
  check("source=jev", j.source === "jev");
  check("briefFit は 0..4 と言葉", j.briefFit?.value === 3.7 && j.briefFit.level === BRIEF_FIT_LEVELS[4] && j.briefFit.outOf === 4, JSON.stringify(j.briefFit));
  const kept = j.findings.filter((f) => f.keep).map((f) => f.code).sort().join();
  check("意図どおりの指摘だけ keep", kept === "CRUSHED_BLACKS,DESATURATED", kept);
  check("nextFix は選択肢 → ツールと引数", j.nextFix?.id === "add_fog" && j.nextFix.tool === "dx12_set_volumetric_fog"
    && j.nextFix.args.enabled === true && j.nextFix.confidence === 0.8, JSON.stringify(j.nextFix));
  check("keep を除いたスコアは上がる", j.scoreExcludingKept > polishScore(findings)
    && j.scoreExcludingKept === polishScore(findings.filter((f) => !["CRUSHED_BLACKS", "DESATURATED"].includes(f.code))));
  check("食い違いが無ければ uncertain は空", j.uncertain.length === 0, JSON.stringify(j.uncertain));

  reqs.length = 0;
  const j2 = await judgePolish({ brief, facts, findings, askOptions: { ...base, fetch: fake("lift_shadows", ["CRUSHED_BLACKS"]) } });
  check("意図どおりと言った指摘を直そうとしたら uncertain", j2.uncertain.some((u) => u.why.includes("lift_shadows")), JSON.stringify(j2.uncertain));
  const j3 = await judgePolish({ brief, facts, findings, askOptions: { ...base, fetch: fake("keep_as_is", ["CRUSHED_BLACKS"]) } });
  check("直すべき指摘が残るのに keep_as_is なら uncertain", j3.uncertain.some((u) => u.why.includes("keep_as_is")), JSON.stringify(j3.uncertain));
  const j4 = await judgePolish({ brief, facts, findings, askOptions: { ...base, fetch: fake("add_fog", [], () => 0.66) } });
  check("閾値付近(0.66 vs 0.7)の指摘は uncertain に上がる", j4.findings.every((f) => f.uncertain) && j4.uncertain.length >= findings.length);
  check("ホラーなら apply_look の引数は horror_candle", (await judgePolish({ brief, facts, findings,
    askOptions: { ...base, fetch: fake("apply_look", []) } })).nextFix?.args.preset === "horror_candle");

  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  reqs.length = 0;
  const r = await judgePolish({ brief, facts, findings, askOptions: { baseDir: TMP, fetch: fake("add_fog", []) } });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし → rules(ネットに出ない)", r.source === "rules" && reqs.length === 0);
  check("rules の nextFix は効く順の先頭の直し方", r.nextFix?.id === FIX_BY_CODE[findings[0].code], `${r.nextFix?.id} / ${findings[0].code}`);
  check("rules は keep しない / briefFit は出さない", r.findings.every((f) => !f.keep && f.intended === null) && r.briefFit === null);
  check("rules のスコアは既存と同じ", r.scoreExcludingKept === polishScore(findings));

  const nb = await judgePolish({ brief: null, facts, findings, askOptions: { ...base, fetch: fake("add_fog", []) } });
  check("Brief なし → rules + briefMissing(ネットに出ない)", nb.source === "rules" && nb.briefMissing === true && reqs.length === 0);
  check("ルール judge 単体", rulesJudge([], "x", null).nextFix?.id === "keep_as_is");
  check("POLISH_RULES: 指摘が無ければ keep_as_is", POLISH_RULES["polish.firstFindingFix"]({ context: { facts: { findings: [] } }, vars: {}, def: {} as any })?.value === "keep_as_is");
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("[5] 評価ケースの語が本番の wordify と食い違っていない");
{
  // ★look の語彙で見るので polish の質問(state に facts.look)だけ。ui / layout / play のケースはそれぞれのテストが見る
  const casesFiles = [...lib.questions.values()].filter((q) => q.casesPath && fs.existsSync(q.casesPath) && q.state.includes("facts.look"));
  if (casesFiles.length === 0) console.log("  --  評価ケースがまだ無い");
  for (const q of casesFiles) {
    const file = JSON.parse(fs.readFileSync(q.casesPath!, "utf8"));
    check(`${q.id}: ケースファイルの形`, validateCases(file).length === 0, validateCases(file).join(" / "));
    check(`${q.id}: 12 件以上`, file.cases.length >= 12, String(file.cases.length));
    check(`${q.id}: question が一致`, file.question === q.id);
    const bad: string[] = [];
    for (const c of file.cases) {
      const look = c.context?.facts?.look ?? {};
      for (const [k, v] of Object.entries<string>(look)) if (!isLookWord(k, v)) bad.push(`${c.name}: look.${k}=${v}`);
      for (const f of c.context?.facts?.findings ?? []) {
        if (FINDING_TEXT[f.code as keyof typeof FINDING_TEXT] !== f.issue) bad.push(`${c.name}: finding ${f.code} の issue が FINDING_TEXT と違う`);
      }
      if (q.type === "noul" && typeof c.expect !== "boolean") bad.push(`${c.name}: expect は true/false`);
      if (q.type === "score" && !(Number.isInteger(c.expect) && c.expect >= 0 && c.expect < (q.criteria as unknown[]).length)) bad.push(`${c.name}: expect は段の番号`);
      if (q.type === "choice") {
        for (const e of Array.isArray(c.expect) ? c.expect : [c.expect]) if (!(e in FIXES)) bad.push(`${c.name}: 選択肢に無い ${e}`);
      }
      if (q.id === "finding.intended") {
        const code = c.vars?.code;
        if (!code || !FINDING_TEXT[code as keyof typeof FINDING_TEXT]) bad.push(`${c.name}: vars.code が無い/知らない`);
        else if (!(c.context?.facts?.findings ?? []).some((f: any) => f.code === code)) bad.push(`${c.name}: 聞いている ${code} が findings に無い`);
      }
      if (!c.context?.brief) bad.push(`${c.name}: brief が無い(Brief 依存の質問なのでルールに落ちる)`);
    }
    check(`${q.id}: 全ケースの語・コード・期待値が本番と一致`, bad.length === 0, bad.join("\n      "));
    const briefs = new Set(file.cases.map((c: any) => JSON.stringify(c.context?.brief)));
    check(`${q.id}: Brief が 4 種以上`, briefs.size >= 4, String(briefs.size));
    // 同じ facts で Brief だけ違い、正解が変わるケースがあること(判断が Brief に依存している証拠)
    const byFacts = new Map<string, Set<string>>();
    for (const c of file.cases) {
      const key = JSON.stringify([c.context?.facts, c.vars ?? null]);
      byFacts.set(key, new Set([...(byFacts.get(key) ?? []), JSON.stringify(c.expect)]));
    }
    check(`${q.id}: 同じ facts で Brief によって正解が変わる組がある`, [...byFacts.values()].some((s) => s.size >= 2));
  }
}

console.log(failed === 0 ? "\nOK: jev/polishJudge テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
