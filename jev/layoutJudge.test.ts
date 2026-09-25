// jev/layoutJudge.ts の単体テスト(ネット不要。fetch とエンジン呼び出しを差し替える)。
// 守りたいのは:
//   1) 表の整合: エンジンが出しうる指摘の種類は「聞く / 聞かない」のどちらかに必ず分類されている
//   2) 程度の読み取り: 指摘文の書式が ApplicationMcpValidate.cpp の snprintf と一致している(C++ を読んで突き合わせる)
//   3) 語の境界が C++ の閾値と揃っている(めり込み 0.8 でエラー / 人がぶつかる 2m / 置き物の高さ 6m)
//   4) Jev に渡す言葉に数値が入らない(名前の連番も落とす)、グループと親の引き方、上限
//   5) 判断の組み立て: 1 リクエスト、keep の反映、聞かない種類、uncertain の見方、ルールへの戻り方

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASKED_KINDS, DEGREE_PATTERNS, GROUP_KEYS, GROUP_WORD, LAYOUT_KIND_TEXT, LAYOUT_RULES, MAX_JUDGED_ISSUES, RULE_KINDS,
  collectLayoutContext, degreeOf, groupOf, isLayoutWord, judgeLayout, planLayout, wordifyLayout,
  type LayoutContext, type LayoutIssue,
} from "./layoutJudge.ts";
import { BINS } from "./wordify.ts";
import { loadLibrary } from "./library.ts";
import { validateCases } from "./eval.ts";
import type { EntityInfo } from "../sceneOrganize.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const CPP = path.resolve(here, "..", "..", "..", "src", "core", "mcp", "ApplicationMcpValidate.cpp");
const cpp = fs.existsSync(CPP) ? fs.readFileSync(CPP, "utf8") : null;
const lib = loadLibrary({});

/** C++ の書式文字列にサンプル値を流し込む(%s → 名前、%.Nf → 値、%% → %)。 */
function cformat(fmt: string, values: (string | number)[]): string {
  let i = 0;
  return fmt.replace(/%%|%s|%\.(\d)f/g, (m, d) => {
    if (m === "%%") return "%";
    const v = values[i++];
    return m === "%s" ? String(v) : Number(v).toFixed(Number(d));
  });
}

console.log("[1] 表の整合");
{
  const gloss = (lib.questions.get("layout.intended")?.lookup?.gloss?.map ?? {}) as Record<string, string>;
  check("layout.intended の英語説明 = OVERLAP / FLOATING / BURIED", JSON.stringify(Object.keys(gloss).sort()) === '["BURIED","FLOATING","OVERLAP"]');
  check("状態文に数字が無い", Object.values(LAYOUT_KIND_TEXT).every((t) => !/[0-9０-９]/.test(t)));
  check("グループの言葉が全グループぶんある", GROUP_KEYS.every((k) => !!GROUP_WORD[k]));
  for (const id of ["layout.intended", "layout.no_collider_ok"]) {
    const d = lib.questions.get(id);
    check(`${id} が読める / state は brief + facts.layout`, !!d && JSON.stringify(d.state) === '["brief","facts.layout"]', JSON.stringify(d?.state));
  }
  check("NO_COLLIDER のフォールバックはグループ規約のルール", lib.questions.get("layout.no_collider_ok")?.fallback === "layout.noColliderByGroup"
    && typeof LAYOUT_RULES["layout.noColliderByGroup"] === "function");
  if (!cpp) console.log("  --  ApplicationMcpValidate.cpp が無いので種類の突き合わせは省略");
  else {
    const kinds = [...new Set([...cpp.matchAll(/add\(\s*"([A-Z_]+)"/g)].map((m) => m[1]))];
    const classified = new Set<string>([...ASKED_KINDS, ...RULE_KINDS]);
    check(`エンジンの指摘 ${kinds.length} 種は全部「聞く / 聞かない」に分類されている`, kinds.length >= 9 && kinds.every((k) => classified.has(k)),
      `未分類: ${kinds.filter((k) => !classified.has(k)).join(",")} / 読めた: ${kinds.join(",")}`);
    check("聞く / 聞かないが重複していない", ASKED_KINDS.every((k) => !(RULE_KINDS as readonly string[]).includes(k)));
  }
}

console.log("[2] 程度の読み取り(C++ の書式と突き合わせ)");
if (!cpp) console.log("  --  省略");
else {
  const fmt = (needle: RegExp) => (cpp.match(needle) ?? [])[1] ?? null;
  const fOverlap = fmt(/"(%s が %s に体積比 %\.0f%% めり込んでいる[^"]*)"/);
  const fFloat = fmt(/"(%s が真下の面から %\.2fm 浮いている[^"]*)"/);
  const fBuried = fmt(/"(%s が地面へ %\.2fm 埋まっている（高さ %\.2fm の %\.0f%%）[^"]*)"/);
  check("C++ に OVERLAP / FLOATING / BURIED の書式がある", !!fOverlap && !!fFloat && !!fBuried,
    JSON.stringify({ fOverlap, fFloat, fBuried }));
  if (fOverlap && fFloat && fBuried) {
    const o = degreeOf({ kind: "OVERLAP", text: cformat(fOverlap, ["Book", "Shelf", 92]) });
    check("OVERLAP 92% → ほぼ丸ごと", o.value === 0.92 && o.word === "ほぼ丸ごと重なっている", JSON.stringify(o));
    const f = degreeOf({ kind: "FLOATING", text: cformat(fFloat, ["Lamp", 1.8]) }, 0.6);
    check("FLOATING 1.8m / 高さ 0.6m → 数倍", Math.abs((f.value ?? 0) - 3) < 1e-9 && f.word === "はるか上に浮いている", JSON.stringify(f));
    const b = degreeOf({ kind: "BURIED", text: cformat(fBuried, ["Rock", 0.6, 1.2, 50]) });
    check("BURIED 50% → 半分以上", b.value === 0.5 && b.word === "半分以上埋まっている", JSON.stringify(b));
  }
  check("読めない文なら程度を言わない", degreeOf({ kind: "OVERLAP", text: "謎の文" }).word === undefined
    && degreeOf({ kind: "FLOATING", text: "Lamp が真下の面から 1.00m 浮いている" }).word === undefined /* 高さ不明 */);
  check("書式の正規表現は 3 種", Object.keys(DEGREE_PATTERNS).length === 3);
}

console.log("[3] 語の境界が C++ の閾値と揃っている");
if (!cpp) console.log("  --  省略");
else {
  check("めり込み: 3 割未満は OVERLAP にしない(C++)", /ratio\s*<\s*0\.30f\)\s*continue/.test(cpp));
  check("めり込み: 0.8 超でエラー(C++) ⇔「ほぼ丸ごと」の境界 0.8", /ratio\s*>\s*0\.80f\s*\?\s*2\s*:\s*1/.test(cpp) && BINS.overlap.edges[1] === 0.8);
  check("NO_COLLIDER の「人がぶつかる」高さ 2m ⇔「人の背丈くらい」の上端 2", /SizeY\(\)\s*>=\s*2\.0f/.test(cpp) && BINS.objectSize.edges[2] === 2);
  check("置き物(IsProp)の高さ 6m ⇔「人より大きい」の上端 6", /SizeY\(\)\s*<=\s*6\.0f/.test(cpp) && BINS.objectSize.edges[3] === 6);
}

// ── 共通の小さなシーン: LVL / ENV / GAMEPLAY のグループの下に物がある ──
const E = (entityId: number, name: string, parent?: number): EntityInfo => ({ entityId, name, componentTypes: [], parent });
const entities = new Map<number, EntityInfo>([
  [1, E(1, "LVL")], [2, E(2, "ENV")], [3, E(3, "GAMEPLAY")],
  [10, E(10, "LVL_Floor", 1)], [11, E(11, "LVL_Wall_02", 1)],
  [20, E(20, "Library", 2)], [21, E(21, "ENV_Bookshelf_01", 20)], [22, E(22, "ENV_Book_07", 20)],
  [23, E(23, "ENV_Grass_03", 2)], [24, E(24, "ENV_Lamp_Hanging", 2)],
  [30, E(30, "GP_Enemy_Slime_01", 3)], [40, E(40, "Crate")],
]);
const sizes = new Map<number, [number, number, number]>([
  [10, [20, 0.2, 20]], [11, [6, 3, 0.3]], [21, [2, 2.2, 0.4]], [22, [0.2, 0.3, 0.05]], [23, [3, 0.4, 3]],
  [24, [0.5, 0.6, 0.5]], [30, [0.8, 0.8, 0.8]], [40, [0.8, 0.8, 0.8]],
]);
const ctx: LayoutContext = { sizes, entities };
const ISSUES: LayoutIssue[] = [
  { kind: "OVERLAP", level: "error", text: "ENV_Book_07 が ENV_Bookshelf_01 に体積比 100% めり込んでいる。どちらかをずらすか片方を消すこと",
    entityId: 22, name: "ENV_Book_07", otherEntityId: 21, otherName: "ENV_Bookshelf_01" },
  { kind: "OVERLAP", level: "warning", text: "GP_Enemy_Slime_01 が LVL_Wall_02 に体積比 45% めり込んでいる。どちらかをずらすか片方を消すこと",
    entityId: 30, name: "GP_Enemy_Slime_01", otherEntityId: 11, otherName: "LVL_Wall_02" },
  { kind: "FLOATING", level: "warning", text: "ENV_Lamp_Hanging が真下の面から 1.80m 浮いている。dx12_snap_to_ground で接地させること", entityId: 24, name: "ENV_Lamp_Hanging" },
  { kind: "NO_COLLIDER", level: "warning", text: "ENV_Grass_03: 一辺 3.0m あるのに当たり判定が無い(すり抜ける)", entityId: 23, name: "ENV_Grass_03" },
  { kind: "NO_COLLIDER", level: "warning", text: "LVL_Wall_02: 一辺 6.0m あるのに当たり判定が無い(すり抜ける)", entityId: 11, name: "LVL_Wall_02" },
  { kind: "Z_FIGHT", level: "error", text: "LVL_Floor と Crate の面が Y 軸で 0.00mm しか離れていない", entityId: 40, name: "Crate", otherEntityId: 10, otherName: "LVL_Floor" },
  { kind: "BURIED", level: "error", text: "Crate が地面へ 0.40m 埋まっている（高さ 0.80m の 50%）。dx12_snap_to_ground で接地させること", entityId: 40, name: "Crate", fixed: true },
];

console.log("[4] 指摘 → 言葉");
{
  const w = wordifyLayout(ISSUES, ctx);
  const flat = JSON.stringify(w.layout);
  check("聞くのは未修正の聞く種類だけ(Z_FIGHT と修正済みの BURIED は入らない)", w.layout.issues.length === 5
    && w.layout.issues.every((f) => f.kind !== ("Z_FIGHT" as string)), flat);
  check("エラーが先頭に来る(ref A = 本棚の本)", w.layout.issues[0].ref === "A" && w.layout.issues[0].object === "ENV_Book");
  check("数字を含む語が無い(名前の連番も落ちている)", !/[0-9０-９]/.test(flat), flat);
  check("全部の語が語彙表に載っている", w.layout.issues.every((f) => Object.entries(f).every(([k, v]) => isLayoutWord(k, v))),
    w.layout.issues.flatMap((f) => Object.entries(f).filter(([k, v]) => !isLayoutWord(k, v)).map(([k, v]) => `${f.ref}.${k}=${v}`)).join(","));
  const a = w.layout.issues[0];
  check("グループは祖先のルート、親はルートでない直近の祖先", a.group === GROUP_WORD.ENV && a.parent === "Library", JSON.stringify(a));
  check("相手の名前・グループ・大きさも言葉で", a.other === "ENV_Bookshelf" && a.otherGroup === GROUP_WORD.ENV && a.otherSize === "人より大きい(家具や壁くらい)", JSON.stringify(a));
  check("めり込みの程度", a.degree === "ほぼ丸ごと重なっている");
  const lamp = w.layout.issues.find((f) => f.object === "ENV_Lamp_Hanging")!;
  check("浮きの程度は自分の高さに対する割合(1.8m / 0.6m)", lamp.degree === "はるか上に浮いている", JSON.stringify(lamp));
  check("グループ外でも規約の接頭辞からグループを推す", groupOf(99, "LVL_Stair_01", entities).key === "LVL" && groupOf(99, "Box", entities).key === null);
  check("元の数値は raw に残る", w.raw.some((r) => typeof r.degree === "number") && w.raw.every((r) => r.entityId !== undefined));
  const many = Array.from({ length: MAX_JUDGED_ISSUES + 3 }, (_, i) => ({ kind: "FLOATING", level: "warning", text: "", entityId: 24, name: `ENV_Coin_${i}` }));
  const wm = wordifyLayout(many, ctx);
  check(`上限 ${MAX_JUDGED_ISSUES} 件、溢れたぶんは skipped`, wm.layout.issues.length === MAX_JUDGED_ISSUES && wm.skipped === 3);
  check("ref は英字(Jev は数を数えられない)", wm.layout.issues.every((f) => /^[A-L]$/.test(f.ref)));
}

console.log("[5] 材料集め(エンジン呼び出しを差し替え)");
{
  const calls: { method: string; params: any }[] = [];
  const fakeCall = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "get_bounds") return { size: sizes.get(params.entity) ?? [1, 1, 1] };
    if (method === "list_entities") return { entities: [...entities.values()].map((e) => ({ entityId: e.entityId, name: e.name, componentTypes: [] })) };
    if (method === "get_hierarchy") {
      const node = (id: number): any => ({ entityId: id, children: [...entities.values()].filter((e) => e.parent === id).map((e) => node(e.entityId)) });
      return { roots: [...entities.values()].filter((e) => e.parent === undefined).map((e) => node(e.entityId)) };
    }
    return null;
  };
  const c = await collectLayoutContext(fakeCall, ISSUES);
  const bounded = calls.filter((x) => x.method === "get_bounds").map((x) => x.params.entity).sort((a, b) => a - b);
  check("大きさは聞く指摘に出てくる物だけ測る(Z_FIGHT の Crate は測らない)", JSON.stringify(bounded) === "[11,21,22,23,24,30]", JSON.stringify(bounded));
  check("親子は階層から引ける", c.entities.get(22)?.parent === 20 && c.entities.get(20)?.parent === 2);
  calls.length = 0;
  await collectLayoutContext(fakeCall, ISSUES.filter((i) => i.kind === "Z_FIGHT"));
  check("聞く指摘が無ければエンジンを 1 回も叩かない", calls.length === 0);
}

console.log("[6] 判断の組み立て");
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-layout-"));
  const reqs: any[] = [];
  /** ref ごとに yes の確率を返す偽 Jev。 */
  const fake = (byRef: Record<string, number>): FetchLike => async (_u, init) => {
    const b = JSON.parse(init.body);
    reqs.push(b);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      const ref = (JSON.stringify(q.instructions).match(/flagged issue ([A-L]) /) ?? [])[1] ?? "";
      answers[k] = { type: "noul", noul: byRef[ref] ?? 0.1 };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             text: async () => JSON.stringify({ model: "m", answers, usage: { input_tokens: 900, output_tokens: 20 } }) };
  };
  const brief = { genre: "書斎の探索", mood: ["静か"], avoid: ["散らかった配置"] };
  const report = { errors: 3, warnings: 4, issues: ISSUES };
  const base = { baseDir: TMP, apiKey: "k", cache: "off" as const };

  const plan = planLayout({ brief, report, ctx });
  check("plan: 聞く指摘ぶんの質問(intended ×3 + no_collider ×2)", plan.refs.length === 5
    && plan.refs.filter((r: any) => r.id === "layout.no_collider_ok").length === 2);
  // A(本棚の本)・C(吊りランプ)・D(草)は意図どおり、B(壁の中のスライム)・E(当たりの無い壁)は直す
  const j = await judgeLayout({ brief, report, ctx, askOptions: { ...base, fetch: fake({ A: 0.93, B: 0.05, C: 0.9, D: 0.88, E: 0.04 }) } });
  check("1 リクエストに束ねる", reqs.length === 1 && Object.keys(reqs[0].questions).length === 5, `${reqs.length} req`);
  check("state は brief + facts.layout だけ", JSON.stringify(Object.keys(reqs[0].state.facts)) === '["layout"]' && !!reqs[0].state.brief);
  check("keep の反映", j.findings.filter((f) => f.keep).map((f) => f.ref).join() === "A,C,D", JSON.stringify(j.findings));
  check("findings に entityId と name が付く", j.findings.every((f) => typeof f.entityId === "number" && !!f.name));
  check("keep を除くとエラーが減る(本棚の本は消え、Z_FIGHT は残る)", j.errorsExcludingKept === 1 && j.passExcludingKept === false, JSON.stringify(j));
  check("聞かない種類は notAsked(修正済みは数えない)", JSON.stringify(j.notAsked) === '["Z_FIGHT"]', JSON.stringify(j.notAsked));
  check("source=jev / cost に 1 リクエスト", j.source === "jev" && j.cost.requests === 1);

  const j2 = await judgeLayout({ brief, report, ctx, askOptions: { ...base, fetch: fake({ A: 0.66 }) } });
  const u = j2.uncertain.find((x) => x.id === "layout.intended#A");
  check("閾値付近は uncertain + その物へ寄って撮るツール呼び出し", !!u && u.look?.tool === "dx12_focus_and_screenshot" && (u.look.args as any).entity === 22,
    JSON.stringify(j2.uncertain));

  reqs.length = 0;
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const r = await judgeLayout({ brief, report, ctx, askOptions: { baseDir: TMP, fetch: fake({}) } });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし → ネットに出ない、source=rules", reqs.length === 0 && r.source === "rules");
  check("鍵なし: NO_COLLIDER はグループ規約(ENV の草は要らない / LVL の壁は要る)、他は keep しない",
    r.findings.filter((f) => f.keep).map((f) => f.name).join() === "ENV_Grass_03", JSON.stringify(r.findings));
  const nb = await judgeLayout({ brief: null, report, ctx, askOptions: { ...base, fetch: fake({ A: 0.99 }) } });
  check("Brief なし → ネットに出ない + briefMissing", reqs.length === 0 && nb.briefMissing === true && nb.source === "rules");
  const none = await judgeLayout({ brief, report: { issues: ISSUES.filter((i) => i.kind === "Z_FIGHT") }, ctx, askOptions: { ...base, fetch: fake({}) } });
  check("聞く指摘が無ければ Jev に出ない", reqs.length === 0 && none.findings.length === 0 && none.notAsked.includes("Z_FIGHT"));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("[7] 評価ケース(*.cases.json)の語が本番の wordifyLayout と食い違っていない");
{
  const qs = ["layout.intended", "layout.no_collider_ok"].map((id) => lib.questions.get(id)!);
  for (const q of qs) {
    const file = JSON.parse(fs.readFileSync(q.casesPath!, "utf8"));
    check(`${q.id}: ケースファイルの形`, validateCases(file).length === 0, validateCases(file).join(" / "));
    check(`${q.id}: 12 件以上`, file.cases.length >= 12, String(file.cases.length));
    check(`${q.id}: question が一致`, file.question === q.id);
    const bad: string[] = [];
    for (const c of file.cases) {
      const facts = c.context?.facts?.layout;
      if (!facts) { bad.push(`${c.name}: facts.layout が無い`); continue; }
      if (!c.context?.brief) bad.push(`${c.name}: brief が無い(Brief 依存の質問なのでルールに落ちる)`);
      if (JSON.stringify(Object.keys(c.context.facts)) !== '["layout"]') bad.push(`${c.name}: facts に layout 以外がある`);
      for (const is of facts.issues ?? []) {
        for (const [k, v] of Object.entries<any>(is)) if (!isLayoutWord(k, v)) bad.push(`${c.name}: ${is.ref}.${k}=${JSON.stringify(v)}`);
      }
      if (q.type === "noul" && typeof c.expect !== "boolean") bad.push(`${c.name}: expect は true/false`);
      const asked = (facts.issues ?? []).find((i: any) => i.ref === c.vars?.ref);
      if (!asked) bad.push(`${c.name}: 聞いている ref ${c.vars?.ref} が issues に無い`);
      else if (q.id === "layout.intended" && (asked.kind === "NO_COLLIDER" || asked.kind !== c.vars?.kind)) bad.push(`${c.name}: kind が食い違う`);
      else if (q.id === "layout.no_collider_ok" && asked.kind !== "NO_COLLIDER") bad.push(`${c.name}: NO_COLLIDER ではない指摘を聞いている`);
    }
    check(`${q.id}: 全ケースの語・期待値が本番と一致`, bad.length === 0, bad.join("\n      "));
    const briefs = new Set(file.cases.map((c: any) => JSON.stringify(c.context?.brief)));
    check(`${q.id}: Brief が 4 種以上`, briefs.size >= 4, String(briefs.size));
    const byFacts = new Map<string, Set<string>>();
    for (const c of file.cases) {
      const key = JSON.stringify([c.context?.facts, c.vars ?? null]);
      byFacts.set(key, new Set([...(byFacts.get(key) ?? []), JSON.stringify(c.expect)]));
    }
    check(`${q.id}: 同じ facts で Brief によって正解が変わる組がある`, [...byFacts.values()].some((s) => s.size >= 2));
  }
}

console.log(failed === 0 ? "\nOK: jev/layoutJudge テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
