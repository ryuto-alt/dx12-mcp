// jev/readJudge.ts の単体テスト(ネット不要。fetch を差し替える)。
// 守りたいのは:
//   1) 表の整合: 原因の選択肢 ⇔ READ_PROBLEMS、質問の state、ルールの名前
//   2) facts.read: 名前の数字は潰す・role を渡す・lit_side を出すときは必ず brightness / contrast も並ぶ(litFacing の癖)
//   3) ルールの原因が JUNCTION の実測(2026-09-08 の 3 件)を名指しする: 黒い板 = unlit_side / 深さが見えない = no_shape /
//      画面を埋める = fills_view。litFacing が「照らされている」でも真っ暗なら too_dark
//   4) 判断の組み立て: 1 視点 = 1 リクエスト、uncertain は同じ視点から撮るツール、ルールへの戻り方
//   5) 評価ケース(*.cases.json)の語が本番の wordifyRead と食い違っていない

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PerceiveRaw, PerceiveStatsRaw } from "../perceive.ts";
import { READ_PROBLEMS, READ_RULES, judgeRead, lookForRead, planRead, ruleProblem, wordifyRead } from "./readJudge.ts";
import { loadLibrary } from "./library.ts";
import { validateCases } from "./eval.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

// ── JUNCTION の実測値(perceive.test.ts と同じ。2026-09-25, stagedemo3, fov 72) ──
const base = (o: Partial<PerceiveStatsRaw>): PerceiveStatsRaw => ({
  name: "x", pixels: 1000, share: 0.01, bbox: [0.4, 0.4, 0.6, 0.6], center: [0.5, 0.5], luma: 0.5, lumaStd: 0.05,
  lumaRing: 0.5, contrast: 1, saturation: 0.1, distance: 5, fullyInView: true, projectedExtent: [0.2, 0.2],
  occlusion: 0, litFacing: 1, backFacing: 0, mainLight: null, ...o,
});
const shardLit = base({ name: "C6_p0", pixels: 22414, share: 0.0366, center: [0.5897, 0.504], luma: 0.3829, lumaStd: 0.0202,
  lumaRing: 0.537, contrast: 0.7374, saturation: 0.17, distance: 4.114, litFacing: 0.9768, mainLight: { name: "C6_fill", facing: 0.9897 } });
const shardDark = base({ ...shardLit, luma: 0.2706, lumaStd: 0.05, lumaRing: 0.6807, contrast: 0.4387, litFacing: 0.0006, mainLight: { name: "C6_fill", facing: 0 } });
const pitOn = base({ name: "W5_pit", pixels: 53288, share: 0.087, center: [0.6166, 0.4149], luma: 0.3446, lumaStd: 0.1248,
  lumaRing: 0.3817, contrast: 0.9143, distance: 16.7252, fullyInView: false, projectedExtent: [2.0181, 0.6323], occlusion: 0.8607,
  litFacing: 1, mainLight: { name: "W5_pl281", facing: 1 } });
const pitOff = base({ ...pitOn, luma: 0.1757, lumaStd: 0.0161, lumaRing: 0.3224, contrast: 0.6059 });
const shardFill = base({ name: "C6_p0", pixels: 612241, share: 1, center: [0.5, 0.5], luma: 0.1624, lumaStd: 0.0276,
  lumaRing: null, contrast: null, distance: 1.0621, fullyInView: false, projectedExtent: [1.3039, 1.5029] });
const scene = (): PerceiveRaw["scene"] => ({ empty: 0.02, farthest: 31.5,
  regions: { top: { empty: 0.04, luma: 0.55, lumaStd: 0.08, distance: 9 }, bottom: { empty: 0, luma: 0.6, lumaStd: 0.07, distance: 4 },
             left: { empty: 0.02, luma: 0.58, lumaStd: 0.07, distance: 7 }, right: { empty: 0.02, luma: 0.57, lumaStd: 0.08, distance: 6 } },
  luma: { mean: 0.57, p5: 0.3, p50: 0.58, p95: 0.8, crushed: 0.001, clipped: 0.004 } });
const raw = (targets: PerceiveStatsRaw[]): PerceiveRaw => ({ mode: "Editor", camera: { source: "explicit" }, scene: scene(), targets,
  top: [{ ...shardLit, name: "C6_wall", share: 0.41 }] });

const lib = loadLibrary({});

console.log("[1] 表の整合");
{
  const crit = Object.keys((lib.questions.get("read.main_problem")?.criteria ?? {}) as object).sort();
  check("read.main_problem の選択肢 = READ_PROBLEMS のキー", JSON.stringify(crit) === JSON.stringify(Object.keys(READ_PROBLEMS).sort()), crit.join(","));
  for (const id of ["read.noticeable", "read.main_problem"]) {
    const d = lib.questions.get(id);
    check(`${id} が読める / state は brief + facts.read`, !!d && JSON.stringify(d.state) === '["brief","facts.read"]');
    check(`${id} のフォールバックがルール表にある`, !!d?.fallback && typeof READ_RULES[d.fallback] === "function", d?.fallback);
  }
  check("原因の名前に数字が無い", Object.values(READ_PROBLEMS).every((p) => !/[0-9]/.test(p.label)));
}

console.log("[2] facts.read");
{
  const vp = { label: "継ぎ目 F の焦点", camera: { position: [14, 5.1, 122], target: [14, 5, 126] },
               targets: [{ name: "C6_p0", role: "見つけてほしい破片" }, "W5_pit", "Missing_01"] };
  const { read, refs } = wordifyRead(raw([shardDark, pitOn]), vp);
  check("ref は英字で対象の順", refs.map((r) => r.ref).join() === "A,B,C" && refs[0].name === "C6_p0" && refs[0].role === "見つけてほしい破片");
  check("名前の数字は # に潰す(C6_p0 → C#_p#)", read.targets[0].name === "C#_p#" && read.targets[0].role === "見つけてほしい破片");
  check("数字を含む語が無い", !/[0-9０-９]/.test(JSON.stringify(read)), JSON.stringify(read));
  check("lit_side を出すときは brightness / contrast も並ぶ(litFacing はカスタムシェーダを見ないので)",
    read.targets.every((t) => !t.lit_side || (!!t.brightness && !!t.contrast)), JSON.stringify(read.targets));
  check("perceive に居ない対象は「見えていない」だけ", read.targets[2].visibility === "見えていない" && Object.keys(read.targets[2]).length === 3);
  check("視点の名前を渡す", read.viewpoint?.startsWith("継ぎ目 F の焦点") === true, read.viewpoint);
  check("同じ視点から撮るツール", lookForRead(vp).tool === "dx12_screenshot_from" && lookForRead({ targets: [], camera: "game" }).tool === "dx12_screenshot_game_view");
}

console.log("[3] ルールの原因が 9/8 の欠陥を名指しする");
{
  const f = (s: PerceiveStatsRaw) => wordifyRead(raw([s]), { targets: [s.name] }).read.targets[0];
  check("灯りが手前の破片は fine", ruleProblem(f(shardLit)) === "fine", JSON.stringify(f(shardLit)));
  check("灯りを裏へ回した破片(黒い板)は unlit_side", ruleProblem(f(shardDark)) === "unlit_side");
  // ★井戸は縁で 86% 隠れる(見下ろす物の宿命)ので、ルールは灯りの有無にかかわらず occluded と言ってしまう。
  //   「底の灯りを消すと深さが読めない」を分けるのは Jev の仕事(評価ケースで測る)。ルールの限界としてここに固定する
  check("井戸はルールだと灯りの有無にかかわらず occluded(ルールの限界)", ruleProblem(f(pitOn)) === "occluded" && ruleProblem(f(pitOff)) === "occluded");
  const flatDark = base({ name: "Mural", share: 0.08, luma: 0.2, lumaStd: 0.02, lumaRing: 0.35, contrast: 0.63, occlusion: 0 });
  check("遮られていない暗くのっぺりした面は no_shape", ruleProblem(f(flatDark)) === "no_shape", JSON.stringify(f(flatDark)));
  check("寄りすぎて画面を埋める破片は fills_view", ruleProblem(f(shardFill)) === "fills_view");
  const lie = base({ name: "Door", luma: 0.07, lumaRing: 0.08, contrast: 0.92, litFacing: 0.95, lumaStd: 0.02 });
  check("litFacing が「照らされている」でも真っ暗なら too_dark(カスタムシェーダの癖)", ruleProblem(f(lie)) === "too_dark", JSON.stringify(f(lie)));
  check("小さすぎる", ruleProblem(f(base({ name: "Key", share: 0.001 }))) === "too_small");
  check("溶ける", ruleProblem(f(base({ name: "Key", share: 0.03, contrast: 1.05 }))) === "blends_in");
  check("視野の外", ruleProblem(f(base({ name: "Key", pixels: 0, share: 0, center: null, fullyInView: false }))) === "out_of_view");
  check("遮られている", ruleProblem(f(base({ name: "Key", share: 0.03, occlusion: 0.97 }))) === "occluded");
}

console.log("[4] 判断の組み立て");
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-read-"));
  const reqs: any[] = [];
  const fake = (byRef: Record<string, { n: number; c: string; conf?: number }>): FetchLike => async (_u, init) => {
    const b = JSON.parse(init.body);
    reqs.push(b);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      const ref = (JSON.stringify(q.instructions).match(/target ([A-L])\b/) ?? [])[1] ?? "";
      const a = byRef[ref] ?? { n: 0.9, c: "fine" };
      if (q.type === "noul") answers[k] = { type: "noul", noul: a.n };
      else answers[k] = { type: "choice", choice: a.c, confidence: a.conf ?? 0.8, probabilities: {} };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             text: async () => JSON.stringify({ model: "m", answers, usage: { input_tokens: 900, output_tokens: 10 } }) };
  };
  const brief = { genre: "リミナル空間の錯覚パズル", player_should_feel: "見え方の継ぎ目に気づいたとき背筋が冷える" };
  const vp = { label: "焦点", camera: { position: [14, 5.1, 122], target: [14, 5, 126] }, targets: [{ name: "C6_p0", role: "見つけてほしい破片" }, "W5_pit"] };
  const base2 = { baseDir: TMP, apiKey: "k", cache: "off" as const };
  const j = await judgeRead({ brief, raw: raw([shardDark, pitOn]), viewpoint: vp,
    askOptions: { ...base2, fetch: fake({ A: { n: 0.1, c: "unlit_side" }, B: { n: 0.9, c: "fine" } }) } });
  check("1 視点 = 1 リクエストに対象 × 2 問", reqs.length === 1 && Object.keys(reqs[0].questions).length === 4);
  check("state は brief + facts.read だけ", JSON.stringify(Object.keys(reqs[0].state.facts)) === '["read"]' && !!reqs[0].state.brief);
  check("気づけない対象を名指しし、原因と直し方が付く", JSON.stringify(j.unreadable) === '["C6_p0"]'
    && j.targets[0].mainProblem?.id === "unlit_side" && !!j.targets[0].mainProblem.hint, JSON.stringify(j.targets));
  check("source=jev / cost", j.source === "jev" && j.cost.requests === 1);
  const u = await judgeRead({ brief, raw: raw([shardDark]), viewpoint: { ...vp, targets: ["C6_p0"] },
    askOptions: { ...base2, fetch: fake({ A: { n: 0.1, c: "fine" } }) } });
  check("気づけないのに原因が「問題なし」→ uncertain + 同じ視点から撮る", u.uncertain.some((x) => /問題なし/.test(x.why) && x.look?.tool === "dx12_screenshot_from"),
    JSON.stringify(u.uncertain));
  reqs.length = 0;
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const flat = base({ name: "Mural", share: 0.08, luma: 0.2, lumaStd: 0.02, lumaRing: 0.35, contrast: 0.63, occlusion: 0 });
  const r = await judgeRead({ brief, raw: raw([shardDark, flat]), viewpoint: { ...vp, targets: ["C6_p0", "Mural"] }, askOptions: { baseDir: TMP, fetch: fake({}) } });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし → ネットに出ずルール(黒い板は unlit_side、のっぺりした暗い面は no_shape)", reqs.length === 0 && r.source === "rules"
    && r.targets[0].mainProblem?.id === "unlit_side" && r.targets[1].mainProblem?.id === "no_shape" && r.unreadable.length === 2, JSON.stringify(r.targets));
  const nb = await judgeRead({ brief: null, raw: raw([shardDark]), viewpoint: { targets: ["C6_p0"] }, askOptions: { ...base2, fetch: fake({}) } });
  check("Brief なし → ネットに出ない + briefMissing", reqs.length === 0 && nb.briefMissing === true);
  const none = await judgeRead({ brief, raw: raw([]), viewpoint: { targets: [] }, askOptions: { ...base2, fetch: fake({}) } });
  check("対象が無ければ聞かない", reqs.length === 0 && none.targets.length === 0);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("[5] 評価ケース(*.cases.json)の語が本番の wordifyRead と食い違っていない");
{
  for (const id of ["read.noticeable", "read.main_problem"]) {
    const q = lib.questions.get(id)!;
    if (!q.casesPath || !fs.existsSync(q.casesPath)) { check(`${id}: ケースファイルがある`, false, q.casesPath); continue; }
    const file = JSON.parse(fs.readFileSync(q.casesPath, "utf8"));
    check(`${id}: ケースファイルの形`, validateCases(file).length === 0, validateCases(file).join(" / "));
    check(`${id}: 12 件以上`, file.cases.length >= 12, String(file.cases.length));
    const bad: string[] = [];
    for (const c of file.cases) {
      const read = c.context?.facts?.read;
      if (!read) { bad.push(`${c.name}: facts.read が無い`); continue; }
      if (!c.context?.brief) bad.push(`${c.name}: brief が無い`);
      if (/[0-9０-９]/.test(JSON.stringify(read))) bad.push(`${c.name}: 数字がある`);
      if (!(read.targets ?? []).some((t: any) => t.ref === c.vars?.ref)) bad.push(`${c.name}: 聞いている ref が無い`);
      // 周囲が無い(画面を埋める)ときは contrast が出ないので、明るさだけは必ず並ぶことを見る
      for (const t of read.targets ?? []) if (t.lit_side && !t.brightness) bad.push(`${c.name}: lit_side だけで brightness が無い`);
      if (q.type === "choice") for (const e of Array.isArray(c.expect) ? c.expect : [c.expect]) if (!(e in READ_PROBLEMS)) bad.push(`${c.name}: 選択肢に無い ${e}`);
      if (q.type === "noul" && typeof c.expect !== "boolean") bad.push(`${c.name}: expect は true/false`);
    }
    check(`${id}: 全ケースの語・期待値が本番と一致`, bad.length === 0, bad.join("\n      "));
    const briefs = new Set(file.cases.map((c: any) => JSON.stringify(c.context?.brief)));
    check(`${id}: Brief が 3 種以上`, briefs.size >= 3, String(briefs.size));
  }
}

console.log(failed === 0 ? "\nOK: jev/readJudge テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
