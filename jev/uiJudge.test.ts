// jev/uiJudge.ts の単体テスト(ネット不要。fetch を差し替える)。
// 守りたいのは:
//   1) 表の整合: auditUiTree が出しうるコードは「聞く / 聞かない」のどちらかに必ず分類されている、
//      聞くコード ⇔ 状態文 ⇔ 質問ファイルの英語説明
//   2) Jev に渡す言葉に数値が入らない(名前の連番・画面の文言の数字も落とす)、語彙表に載った語だけ
//   3) 語の境界が uiQuality.ts のルール閾値と揃っている(「多い」と言うのにルールは言わない、を起こさない)
//   4) 判断の組み立て: 1 リクエストで brief_fit + 指摘コードの数、keep の反映(pass / score の数え直し)、
//      機能の欠陥は聞かない、uncertain には見るためのツール呼び出しが付く、ルールへの戻り方

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditUiTree } from "../uiQuality.ts";
import {
  UI_ISSUE_TEXT, UI_JUDGED_CODES, UI_NOT_ASKED, UI_VOCAB, isUiWord, judgeUi, planUi, rulesUiJudge, wordifyUi,
} from "./uiJudge.ts";
import { loadLibrary } from "./library.ts";
import { validateCases } from "./eval.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

let nextId = 1;
const node = (name: string, rect: number[], extra: any = {}) => ({
  entityId: nextId++, name, resolvedRect: rect, uiRect: { visible: true }, components: [], ...extra,
});
const btn = (name: string, x: number, y: number, extra: any = {}) =>
  node(name, [x, y, 240, 64], { components: ["uiImage", "uiButton"], uiButton: { interactable: true, onClickEvent: "go" },
    uiImage: { color: [0.2, 0.2, 0.2, 1], gradientDir: 0, outlineWidth: 0, shadowAlpha: 0, shape: 0 }, ...extra });
const text = (name: string, x: number, y: number, fs: number, s: string, extra: any = {}) =>
  node(name, [x, y, 600, Math.ceil(fs * 1.5)], { components: ["uiText"], text: s,
    uiText: { fontSize: fs, wrap: false, rich: false, charAnim: 0, outlineWidth: 0, shadowAlpha: 0, ...extra } });
const canvas = (children: any[]) => ({ canvases: [{ name: "Canvas", uiCanvas: { refWidth: 1920, refHeight: 1080 }, children }] });

/** 好みのルールを全部踏むにぎやかな画面(ガチャ風)+ 機能の欠陥 1 つ(小さすぎるボタン)。 */
function busyTree() {
  const colors = Array.from({ length: 14 }, (_, i) => [((i * 37) % 16) / 16, ((i * 11) % 16) / 16, ((i * 5) % 16) / 16, 1]);
  const kids: any[] = [];
  // 中央に 6 個のボタン(中心 x = 840 + 120 = 960)。1 個は光沢が速く、1 個は装飾を 4 重。
  for (let i = 0; i < 6; i++) {
    kids.push(btn(`UI_Gacha_${String(i + 1).padStart(2, "0")}`, 840, 200 + i * 100, {
      uiImage: { color: colors[i], gradientDir: i === 0 ? 1 : 0, outlineWidth: i === 0 ? 2 : 0, shadowAlpha: i === 0 ? 0.5 : 0,
                 shape: i === 0 ? 3 : 0, gradientScrollSpeed: i === 1 ? 0.8 : 0 },
    }));
  }
  // 文字サイズ 6 種、中央。1 つは 1 文字ずつの演出 + 縁取り。数字入りの文言。
  [18, 20, 24, 28, 32, 40].forEach((fs, i) =>
    kids.push(text(`UI_Label_${i}`, 660, 820 + i * 2 + i * 60, fs, i === 0 ? "10連ガチャ 3000" : `ラベル${i}`,
      i === 0 ? { charAnim: 1, outlineWidth: 2 } : {})));
  // 面色をばらまく
  colors.slice(6).forEach((c, i) => kids.push(node(`UI_Deco_${i}`, [40 + i * 40, 40, 30, 30],
    { components: ["uiImage"], uiImage: { color: c, gradientDir: 0, outlineWidth: 0, shadowAlpha: 0, shape: 0 } })));
  // 画面外へはみ出す帯
  kids.push(node("UI_Banner", [-120, 60, 900, 90], { components: ["uiImage"], uiImage: { color: [0.9, 0.1, 0.3, 1], gradientDir: 0, outlineWidth: 0, shadowAlpha: 0, shape: 0 } }));
  // 機能の欠陥: 小さすぎるボタン(SMALL_HIT_TARGET = error)
  kids.push(node("UI_Tiny", [1700, 1000, 40, 30], { components: ["uiButton"], uiButton: { interactable: true, onClickEvent: "x" } }));
  return canvas(kids);
}

const lib = loadLibrary({});

console.log("[1] 表の整合");
{
  const tree = busyTree();
  const audit = auditUiTree(tree, "balanced");
  const codes = new Set(audit.issues.map((i) => i.code));
  for (const c of UI_JUDGED_CODES) check(`busyTree が ${c} を出す(テストの前提)`, codes.has(c), [...codes].join(","));
  const classified = new Set<string>([...UI_JUDGED_CODES, ...UI_NOT_ASKED]);
  const extra = [
    ...auditUiTree({ canvases: [{ uiCanvas: { refWidth: 1920, refHeight: 1080 }, children: [
      node("Collapsed", [0, 0, 0, 0]),
      node("Blocker", [0, 0, 1920, 1080], { components: ["uiImage"], uiImage: { raycastBlock: true, color: [0, 0, 0, 1] } }),
      node("A", [100, 100, 40, 30], { components: ["uiButton"], uiButton: { interactable: true, onClickEvent: "" } }),
      node("B", [105, 105, 40, 30], { components: ["uiButton"], uiButton: { interactable: true, onClickEvent: "b" } }),
      node("T", [0, 0, 50, 12], { components: ["uiText"], text: "long long text", uiText: { fontSize: 14, rich: true, wrap: true } }),
      node("R1", [300, 300, 200, 50], { components: ["uiButton"], uiButton: { onClickEvent: "a" } }),
      node("R2", [302, 363, 200, 50], { components: ["uiButton"], uiButton: { onClickEvent: "a" } }),
    ] }] }).issues,
    ...audit.issues,
  ];
  // DEEP_HIERARCHY は 10 段以上の入れ子でだけ出る
  let deep: any = node("Leaf", [0, 0, 10, 10]);
  for (let i = 0; i < 11; i++) deep = node(`D${i}`, [0, 0, 100, 100], { children: [deep] });
  extra.push(...auditUiTree(canvas([deep])).issues);
  const unclassified = [...new Set(extra.map((i) => i.code))].filter((c) => !classified.has(c));
  check("auditUiTree の出すコードは全部「聞く / 聞かない」に分類されている", unclassified.length === 0, unclassified.join(","));
  check("聞く / 聞かないが重複していない", UI_JUDGED_CODES.every((c) => !(UI_NOT_ASKED as readonly string[]).includes(c)));
  const gloss = (lib.questions.get("ui.finding_intended")?.lookup?.gloss?.map ?? {}) as Record<string, string>;
  check("聞くコード ⇔ 状態文 ⇔ 英語説明", UI_JUDGED_CODES.every((c) => !!UI_ISSUE_TEXT[c] && !!gloss[c])
    && Object.keys(gloss).every((c) => (UI_JUDGED_CODES as readonly string[]).includes(c)), JSON.stringify(Object.keys(gloss)));
  check("状態文に数字が無い", Object.values(UI_ISSUE_TEXT).every((t) => !/[0-9０-９]/.test(t)));
  for (const id of ["ui.finding_intended", "ui.brief_fit"]) {
    const d = lib.questions.get(id);
    check(`${id} が読める / state は brief + facts.ui`, !!d && JSON.stringify(d.state) === '["brief","facts.ui"]', JSON.stringify(d?.state));
  }
}

console.log("[2] Jev に渡す言葉に数値を入れない");
{
  const tree = busyTree();
  const audit = auditUiTree(tree);
  const { ui, raw } = wordifyUi(tree, audit, "title");
  const flat = JSON.stringify({ ...ui, issues: ui.issues.map((i) => ({ ...i, code: "" })) });
  check("数字を含む語が無い(名前の連番・文言の数字も落ちている)", !/[0-9０-９]/.test(flat), flat);
  check("文言の数字は # に潰れる", (ui.labels ?? []).some((l) => l.includes("#連ガチャ #")), JSON.stringify(ui.labels));
  check("名前の連番は落ちる", ui.issues.some((i) => (i.targets ?? []).includes("UI_Gacha")), JSON.stringify(ui.issues));
  check("全部の語が語彙表に載っている", Object.entries(ui).every(([k, v]) => isUiWord(k, v)),
    Object.entries(ui).filter(([k, v]) => !isUiWord(k, v)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(","));
  check("語彙表のキーは wordifyUi の出すキーと食い違わない",
    Object.keys(ui).every((k) => k === "labels" || k === "issues" || k in UI_VOCAB), Object.keys(ui).join(","));
  check("元の数値は raw に残る", typeof raw.fontSizeKinds === "number" && typeof raw.colorFamilies === "number");
  check("聞かないコード(SMALL_HIT_TARGET)は issues に入らない", !ui.issues.some((i) => (i.code as string) === "SMALL_HIT_TARGET"));
  check("画面の役割は日本語で", ui.screen === "タイトル画面");
  check("空の UI は語をほとんど出さない(読めない ≠ 無い)", Object.keys(wordifyUi({ canvases: [] }, { issues: [] }).ui)
    .filter((k) => k !== "issues" && k !== "interactiveElements" && k !== "textElements").length === 0,
    JSON.stringify(wordifyUi({ canvases: [] }, { issues: [] }).ui));
}

console.log("[3] 語の境界が uiQuality のルール閾値と揃っている");
{
  const fonts = (n: number) => {
    const t = canvas(Array.from({ length: n }, (_, i) => text(`T${i}`, 100, 100 + i * 120, 18 + i * 4, "t")));
    const a = auditUiTree(t);
    return { rule: a.issues.some((i) => i.code === "FONT_SIZE_SPRAWL"), word: wordifyUi(t, a).ui.fontSizeKinds };
  };
  const f5 = fonts(5), f6 = fonts(6);
  check("フォント 5 種: ルールは言わない ⇔「普通」", !f5.rule && f5.word === "普通", JSON.stringify(f5));
  check("フォント 6 種: FONT_SIZE_SPRAWL ⇔「多い」", f6.rule && f6.word === "多い", JSON.stringify(f6));
  const palette = (n: number) => {
    const t = canvas(Array.from({ length: n }, (_, i) => node(`P${i}`, [100 + i * 60, 100, 40, 40],
      { components: ["uiImage"], uiImage: { color: [i / 16, 0, 0, 1] } })));
    const a = auditUiTree(t);
    return { rule: a.issues.some((i) => i.code === "PALETTE_SPRAWL"), word: wordifyUi(t, a).ui.colorFamilies };
  };
  const p12 = palette(12), p13 = palette(13);
  check("面色 12 系統: 言わない ⇔「普通」", !p12.rule && p12.word === "普通", JSON.stringify(p12));
  check("面色 13 系統: PALETTE_SPRAWL ⇔「多い」", p13.rule && p13.word === "多い", JSON.stringify(p13));
  const centered = (nCenter: number, nLeft: number) => {
    const t = canvas([...Array.from({ length: nCenter }, (_, i) => btn(`C${i}`, 840, 100 + i * 90)),
                      ...Array.from({ length: nLeft }, (_, i) => btn(`L${i}`, 100, 100 + i * 90))]);
    const a = auditUiTree(t);
    return { rule: a.issues.some((i) => i.code === "CENTERED_MONOTONY"), word: wordifyUi(t, a).ui.centeredShare };
  };
  const c8 = centered(8, 2), c7 = centered(7, 3);
  check("中央 8/10: CENTERED_MONOTONY ⇔「大半」", c8.rule && c8.word === "大半", JSON.stringify(c8));
  check("中央 7/10: 言わない ⇔「半分くらい」", !c7.rule && c7.word === "半分くらい", JSON.stringify(c7));
}

console.log("[4] 判断の組み立て");
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-ui-"));
  const tree = busyTree();
  const audit = auditUiTree(tree, "strict");
  const reqs: any[] = [];
  const fake = (keep: string[], opts: { noul?: number; score?: number; conf?: number } = {}): FetchLike => async (_u, init) => {
    const b = JSON.parse(init.body);
    reqs.push(b);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      const code = (JSON.stringify(q.instructions).match(/on the current screen: ([A-Z_]+)/) ?? [])[1] ?? "";
      if (q.type === "noul") answers[k] = { type: "noul", noul: opts.noul ?? (keep.includes(code) ? 0.93 : 0.08) };
      if (q.type === "score") answers[k] = { type: "score", score: opts.score ?? 3.6, confidence: opts.conf ?? 0.9 };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             text: async () => JSON.stringify({ model: "m", answers, usage: { input_tokens: 800, output_tokens: 20 } }) };
  };
  const brief = { genre: "ソシャゲのガチャ画面", mood: ["にぎやか", "きらきら"], avoid: ["地味"], ui: "光るボタンと派手な装飾" };
  const base = { baseDir: TMP, apiKey: "k", cache: "off" as const };
  const plan = planUi({ brief, tree, audit });

  const j = await judgeUi({ brief, tree, audit, strictness: "strict", askOptions: { ...base, fetch: fake(["BUSY_GLOSS", "OVER_DECORATED", "PALETTE_SPRAWL"]) } });
  check("1 リクエストで brief_fit + 聞くコードの数", reqs.length === 1 && Object.keys(reqs[0].questions).length === 1 + UI_JUDGED_CODES.length,
    `${reqs.length} req / ${Object.keys(reqs[0]?.questions ?? {}).length} q`);
  check("state は brief + facts.ui だけ", JSON.stringify(Object.keys(reqs[0].state).sort()) === '["brief","facts"]'
    && JSON.stringify(Object.keys(reqs[0].state.facts)) === '["ui"]');
  check("plan.refs の数と一致", plan.refs.length === 1 + UI_JUDGED_CODES.length);
  check("source=jev / briefFit は 0..4 と言葉", j.source === "jev" && j.briefFit?.value === 3.6 && j.briefFit.level === "よく合う");
  check("意図どおりの指摘だけ keep", j.findings.filter((f) => f.keep).map((f) => f.code).sort().join() === "BUSY_GLOSS,OVER_DECORATED,PALETTE_SPRAWL",
    JSON.stringify(j.findings));
  check("機能の欠陥は聞かずに notAsked", j.notAsked.includes("SMALL_HIT_TARGET") && !j.findings.some((f) => f.code === "SMALL_HIT_TARGET"));
  check("keep を除くとスコアが上がる", j.scoreExcludingKept > audit.score, `${j.scoreExcludingKept} vs ${audit.score}`);
  check("SMALL_HIT_TARGET(エラー)が残るので strict の pass は false のまま", j.passExcludingKept === false);
  check("cost に 1 リクエストぶん", j.cost.requests === 1 && j.cost.tokens === 800, JSON.stringify(j.cost));
  check("食い違いが無ければ uncertain は空", j.uncertain.length === 0, JSON.stringify(j.uncertain));

  const j2 = await judgeUi({ brief, tree, audit, askOptions: { ...base, fetch: fake([], { noul: 0.52 }) } });   // 閾値 0.5 の ±0.1 以内
  check("閾値付近は uncertain に上がり、見るためのツール呼び出しが付く",
    j2.uncertain.length >= UI_JUDGED_CODES.length && j2.uncertain.every((u) => u.look?.tool === "dx12_ui_screenshot"), JSON.stringify(j2.uncertain.slice(0, 2)));
  const j3 = await judgeUi({ brief, tree, audit, askOptions: { ...base, fetch: fake([], { conf: 0.2 }) } });
  check("brief_fit の confidence が低いと uncertain", j3.uncertain.some((u) => u.id === "ui.brief_fit"));

  // 機能の欠陥だけを直せば strict でも pass する画面
  const onlyTaste = canvas([...Array.from({ length: 6 }, (_, i) => btn(`C${i}`, 840, 100 + i * 100))]);
  const aT = auditUiTree(onlyTaste, "strict");
  const jT = await judgeUi({ brief, tree: onlyTaste, audit: aT, strictness: "strict", askOptions: { ...base, fetch: fake(["CENTERED_MONOTONY"]) } });
  check("好みの指摘だけの画面は keep で passExcludingKept になる", aT.issues.every((i) => i.code === "CENTERED_MONOTONY")
    && jT.passExcludingKept === true && jT.scoreExcludingKept === 100, JSON.stringify({ issues: aT.issues.map((i) => i.code), jT: jT.scoreExcludingKept }));

  reqs.length = 0;
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const r = await judgeUi({ brief, tree, audit, strictness: "strict", askOptions: { baseDir: TMP, fetch: fake(["BUSY_GLOSS"]) } });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし → rules(ネットに出ない)、全部直す = 従来どおり", r.source === "rules" && reqs.length === 0
    && r.findings.every((f) => !f.keep && f.intended === null) && r.scoreExcludingKept === audit.score && r.passExcludingKept === audit.pass);
  const nb = await judgeUi({ brief: null, tree, audit, askOptions: { ...base, fetch: fake(["BUSY_GLOSS"]) } });
  check("Brief なし → rules + briefMissing(ネットに出ない)", nb.source === "rules" && nb.briefMissing === true && reqs.length === 0);
  check("ルール judge 単体", rulesUiJudge({ brief: null, tree, audit }, "x").briefFit === null);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("[5] 評価ケース(*.cases.json)の語が本番の wordifyUi と食い違っていない");
{
  const qs = ["ui.finding_intended", "ui.brief_fit"].map((id) => lib.questions.get(id)!);
  for (const q of qs) {
    const file = JSON.parse(fs.readFileSync(q.casesPath!, "utf8"));
    check(`${q.id}: ケースファイルの形`, validateCases(file).length === 0, validateCases(file).join(" / "));
    check(`${q.id}: 12 件以上`, file.cases.length >= 12, String(file.cases.length));
    check(`${q.id}: question が一致`, file.question === q.id);
    const bad: string[] = [];
    for (const c of file.cases) {
      const facts = c.context?.facts?.ui;
      if (!facts) { bad.push(`${c.name}: facts.ui が無い`); continue; }
      if (!c.context?.brief) bad.push(`${c.name}: brief が無い(Brief 依存の質問なのでルールに落ちる)`);
      if (JSON.stringify(Object.keys(c.context.facts)) !== '["ui"]') bad.push(`${c.name}: facts に ui 以外がある`);
      for (const [k, v] of Object.entries<any>(facts)) {
        if (k === "issues") {
          for (const i of v) if (UI_ISSUE_TEXT[i.code as keyof typeof UI_ISSUE_TEXT] !== i.issue) bad.push(`${c.name}: ${i.code} の issue が UI_ISSUE_TEXT と違う`);
        } else if (!isUiWord(k, v)) bad.push(`${c.name}: ui.${k}=${JSON.stringify(v)}`);
      }
      if (q.type === "noul" && typeof c.expect !== "boolean") bad.push(`${c.name}: expect は true/false`);
      if (q.id === "ui.finding_intended" && !(facts.issues ?? []).some((i: any) => i.code === c.vars?.code)) bad.push(`${c.name}: 聞いている ${c.vars?.code} が issues に無い`);
      if (q.type === "score" && !(Number.isInteger(c.expect) && c.expect >= 0 && c.expect <= 4)) bad.push(`${c.name}: expect は 0..4`);
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

console.log(failed === 0 ? "\nOK: jev/uiJudge テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
