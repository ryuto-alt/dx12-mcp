// jev/playJudge.ts の単体テスト(ネット不要。fetch を差し替える)。
// 守りたいのは:
//   1) 表の整合: 原因の選択肢 ⇔ CAUSES、質問の state、ルールの名前
//   2) 区間の事実の数え方: 止まる / 進もうとして動けない / 行き来 / 落下(ジャンプの着地や階段は入れない)/
//      落ちて戻された / 落下以外で戻された / 見回し / その場ジャンプ / ゴールへの進み
//   3) Jev に渡す言葉に数値が入らない、語彙表に載った語だけ、機械の軌跡は「迷わない」と書く
//   4) ルール(フォールバック)の各分岐
//   5) 判断の組み立て: 人は 2 問・機械は原因だけ・1 リクエスト、困っている線、食い違いは uncertain、
//      見るための視点、ルールへの戻り方

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CAUSES, PLAY_RULES, PLAY_VOCAB, PLAYER_WORD, eventsFromSteps, fromSession, isPlayWord, judgePlay, playMetrics,
  ruleCause, ruleConfusion, staticWords, wordifyPlay,
  type PlayEvent, type PlayFacts, type PlayInput, type PlayPoint, type Vec3,
} from "./playJudge.ts";
import { loadLibrary } from "./library.ts";
import { validateCases } from "./eval.ts";
import type { FetchLike } from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

/** 10Hz の軌跡を区間の組み合わせで作る。各区間は (秒数, 1 秒あたりの移動 [dx,dy,dz], 1 秒あたりの yaw 変化)。 */
function trace(parts: { sec: number; v?: Vec3; yawRate?: number; teleportTo?: Vec3 }[], start: Vec3 = [0, 1.6, 0]): PlayPoint[] {
  const pts: PlayPoint[] = [];
  let p: Vec3 = [...start] as Vec3, t = 0, yaw = 0;
  pts.push({ t, pos: [...p] as Vec3, yaw });
  for (const part of parts) {
    if (part.teleportTo) { t += 0.1; p = [...part.teleportTo] as Vec3; pts.push({ t, pos: [...p] as Vec3, yaw }); }
    const n = Math.round(part.sec * 10);
    for (let i = 0; i < n; i++) {
      t = Math.round((t + 0.1) * 1000) / 1000;
      const v = part.v ?? [0, 0, 0];
      p = [p[0] + v[0] * 0.1, p[1] + v[1] * 0.1, p[2] + v[2] * 0.1];
      yaw += (part.yawRate ?? 0) * 0.1;
      pts.push({ t, pos: [...p] as Vec3, yaw });
    }
  }
  return pts;
}
const human = (points: PlayPoint[], events: PlayEvent[] = [], goal?: Vec3): PlayInput => ({ kind: "human", points, events, goal: goal ?? null });
const whole = (inp: PlayInput) => {
  const m = playMetrics(inp);
  const sum = (k: "revisits" | "falls" | "sentBackAfterFall" | "sentBackOther") => m.sections.reduce((a, s) => a + s[k], 0);
  return { m, revisits: sum("revisits"), falls: sum("falls"), afterFall: sum("sentBackAfterFall"), other: sum("sentBackOther") };
};

const lib = loadLibrary({});

console.log("[1] 表の整合");
{
  const crit = Object.keys((lib.questions.get("play.cause")?.criteria ?? {}) as object).sort();
  check("play.cause の選択肢 = CAUSES のキー", JSON.stringify(crit) === JSON.stringify(Object.keys(CAUSES).sort()), crit.join(","));
  for (const id of ["play.confusion", "play.cause"]) {
    const d = lib.questions.get(id);
    check(`${id} が読める / state は brief + facts.play`, !!d && JSON.stringify(d.state) === '["brief","facts.play"]');
    check(`${id} のフォールバックがルール表にある`, !!d?.fallback && typeof PLAY_RULES[d.fallback] === "function", d?.fallback);
  }
  check("原因のヒントに数字が無い", Object.values(CAUSES).every((c) => !/[0-9]/.test(c.label)));
  check("カメラ・操作は選択肢に入れない(見回しと区別できない)", !Object.keys(CAUSES).some((k) => /camera/.test(k)));
}

console.log("[2] 区間の事実の数え方");
{
  const still = whole(human(trace([{ sec: 10 }, { sec: 5, v: [0, 0, 4] }])));
  check("止まっていた割合(10 秒立ち止まって 5 秒歩く = 1 区間の 3 分の 2)", still.m.sections.length === 1
    && Math.abs(still.m.sections[0].stillShare - 2 / 3) < 0.05, JSON.stringify(still.m.sections[0]));

  const fall = whole(human(trace([{ sec: 3, v: [0, 0, 4] }, { sec: 1, v: [0, -8, 1] }, { sec: 2, teleportTo: [0, 1.6, 0] }])));
  check("8m を 1 秒で落ちて戻された = 落下 1・落ちて戻された 1", fall.falls === 1 && fall.afterFall === 1 && fall.other === 0, JSON.stringify(fall));

  const killed = whole(human(trace([{ sec: 4, v: [0, 0, 4] }, { sec: 3, teleportTo: [0, 1.6, 0] }])));
  check("落ちずに戻された(敵・罠)= 落下以外で戻された 1", killed.falls === 0 && killed.other === 1, JSON.stringify(killed));

  const jumpLand = whole(human(trace([{ sec: 2, v: [0, 0, 4] }, { sec: 0.5, v: [0, 4, 2] }, { sec: 0.5, v: [0, -4, 2] }, { sec: 2, v: [0, 0, 4] }])));
  check("ジャンプの着地(2m 程度)は落下に数えない", jumpLand.falls === 0, JSON.stringify(jumpLand));
  const stairs = whole(human(trace([{ sec: 4, v: [0, -1, 2] }])));
  check("ゆっくり降りる階段(4m を 4 秒)は落下に数えない", stairs.falls === 0);

  const back = whole(human(trace([{ sec: 3, v: [0, 0, 4] }, { sec: 3, v: [0, 0, -4] }, { sec: 3, v: [0, 0, 4] }, { sec: 3, v: [0, 0, -4] }])));
  check("行って戻ってを繰り返す = 行き来 2 回以上", back.revisits >= 2, JSON.stringify(back));
  const straight = whole(human(trace([{ sec: 12, v: [0, 0, 4] }])));
  check("まっすぐ歩くだけなら行き来 0・止まり ほぼ 0", straight.revisits === 0 && straight.m.sections[0].stillShare < 0.05);

  const pushEv: PlayEvent[] = [{ t: 0.05, kind: "key_down", detail: "W" }, { t: 9.9, kind: "key_up", detail: "W" }];
  const push = playMetrics(human(trace([{ sec: 2, v: [0, 0, 4] }, { sec: 8 }]), pushEv));
  check("W を押しているのに動かない割合", Math.abs((push.sections[0].pushStuckShare ?? 0) - 0.8) < 0.05, JSON.stringify(push.sections[0]));
  const noInput = playMetrics(human(trace([{ sec: 10 }])));
  check("入力が 1 つも無ければ「進もうとしていたか」は分からない(null)", noInput.sections[0].pushStuckShare === null);

  const jumps: PlayEvent[] = [3, 4, 5, 6, 7].map((t) => ({ t, kind: "key_down", detail: "SPACE" }));
  const jm = playMetrics(human(trace([{ sec: 10 }]), jumps));
  check("その場ジャンプ 5 回", jm.sections[0].jumpsInPlace === 5, JSON.stringify(jm.sections[0]));
  const jRun = playMetrics(human(trace([{ sec: 10, v: [0, 0, 4] }]), jumps));
  check("走りながらのジャンプはその場ジャンプに数えない", jRun.sections[0].jumpsInPlace === 0);

  const spin = playMetrics(human(trace([{ sec: 10, yawRate: 90 }])));
  check("見回し 90 度/秒", Math.abs((spin.sections[0].lookRate ?? 0) - 90) < 1, String(spin.sections[0].lookRate));
  const steer = playMetrics(human(trace([{ sec: 10, v: [0, 0, 4], yawRate: 90 }])));
  check("歩きながらの向き変え(舵取り)は見回しに数えない", steer.sections[0].lookRate === 0, String(steer.sections[0].lookRate));
  const mixed = playMetrics(human(trace([{ sec: 5, v: [0, 0, 4], yawRate: 40 }, { sec: 5, yawRate: 60 }])));
  check("見回しは立ち止まっている間の振りの速さ(60 度/秒)", Math.abs((mixed.sections[0].lookRate ?? 0) - 60) < 2, String(mixed.sections[0].lookRate));

  const toGoal = playMetrics(human(trace([{ sec: 10, v: [0, 0, 3] }]), [], [0, 1.6, 40]));
  check("ゴールへ近づいた(40m → 10m)", (toGoal.sections[0].goalStart ?? 0) > (toGoal.sections[0].goalEnd ?? 99) + 20);

  const long = playMetrics(human(trace([{ sec: 70, v: [0, 0, 1] }])));
  check("長いプレイは最大 4 区間(序盤…終盤)", long.sections.length === 4 && long.sections[0].label === "序盤" && long.sections[3].label === "終盤");
  check("短すぎる軌跡は区間を作らない", playMetrics(human([{ t: 0, pos: [0, 0, 0] }])).sections.length === 0);
}

console.log("[3] 事実 → 言葉");
{
  const pushEv: PlayEvent[] = [{ t: 0.05, kind: "key_down", detail: "W" }];
  const inp = human(trace([{ sec: 8, v: [0, 0, 3] }, { sec: 12, yawRate: 70 }, { sec: 3, v: [0, -6, 1] }, { sec: 5, teleportTo: [0, 1.6, 0] }, { sec: 10, v: [0, 0, -3] }]),
    [...pushEv, { t: 20.5, kind: "error", detail: "lua error" }], [0, 1.6, 60]);
  const { play } = wordifyPlay(inp);
  const flat = JSON.stringify(play);
  check("数字を含む語が無い", !/[0-9０-９]/.test(flat), flat);
  check("全部の語が語彙表に載っている", Object.entries(play).every(([k, v]) => isPlayWord(k, v)),
    Object.entries(play).filter(([k, v]) => !isPlayWord(k, v)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" / "));
  check("区間の語のキーは語彙表にある", play.sections.every((s) => Object.keys(s).every((k) => k in PLAY_VOCAB)));
  check("人のプレイと書く / ゴールに着かなかった", play.player === PLAYER_WORD.human && play.outcome === "ゴールに着かなかった");
  check("一番困っている区間を名指しする", typeof play.hardestSection === "string", JSON.stringify(play));
  const auto = wordifyPlay({ kind: "autoplay", points: trace([{ sec: 5, v: [0, 0, 2] }, { sec: 4 }]), goal: [0, 1.6, 30], cleared: false }).play;
  check("機械の軌跡は「迷うことはない」と書く", /迷うことはない/.test(auto.player) && auto.outcome === "ゴールに着かなかった");
  check("autoplay は前進キーを押しっぱなし = 止まり = 進もうとして動けない",
    auto.sections.some((s) => s.pushingWithoutMoving === s.standingStill && s.standingStill !== "ほぼ無い"), JSON.stringify(auto.sections));
  const rep = wordifyPlay({ kind: "replay", points: trace([{ sec: 20, v: [0, 0, 2] }]), events: [],
    deviation: { pass: false, maxDeviationAt: 15, maxDeviation: 6 } }).play;
  check("リプレイのずれは区間の言葉で(数値を出さない)", rep.deviation === "後半で記録の経路から大きく外れた", String(rep.deviation));
  check("静的解析の理由は言葉へ(数値を落とす)", JSON.stringify(staticWords([{ reason: "水平 6.20m の跳び越しが要る。実測のジャンプ距離 4.05m では届かない" }]))
    === '["実測のジャンプ距離では届かない隙間がある"]');
  const ev = eventsFromSteps([{ t: 0, down: "W" }, { t: 2, press: "SPACE" }, { t: 3, up: ["W"] }]);
  check("台本 → 入力イベント(press は down + up)", ev.length === 4 && ev.filter((e) => e.detail === "SPACE").length === 2);
  const fs1 = fromSession({ samples: [{ t: 0, camPos: [1, 2, 3], camYaw: 10 }, { t: 0.1, camPos: [1, 2, 3.4], camYaw: 12 }], events: [{ t: 0, kind: "key_down", detail: "W" }] });
  check("get_play_session → 人のプレイ(camPos と camYaw)", fs1.points.length === 2 && fs1.points[1].yaw === 12 && fs1.events!.length === 1);
}

console.log("[4] ルール(フォールバック)");
{
  const sec = (o: Record<string, string>) => ({ section: "全体", standingStill: "一部", backtracking: "なし", falls: "なし",
    sentBackAfterFall: "なし", sentBackWithoutFall: "なし", lookingAround: "少し見回す", ...o });
  const f = (o: Record<string, string>, extra: Partial<PlayFacts> = {}): PlayFacts =>
    ({ player: PLAYER_WORD.human, outcome: "ゴールは指定されていない", sections: [sec(o)], ...extra });
  check("落下以外で 2 回戻された → unfair_hazard", ruleCause(f({ sentBackWithoutFall: "少し" })) === "unfair_hazard");
  check("落下 2 回 → jump_too_hard", ruleCause(f({ falls: "少し" })) === "jump_too_hard");
  check("その場ジャンプがいくつも → jump_too_hard", ruleCause(f({ jumpsInPlace: "いくつも" })) === "jump_too_hard");
  check("静的解析で届かない隙間 → jump_too_hard", ruleCause(f({}, { staticCheck: ["実測のジャンプ距離では届かない隙間がある"] })) === "jump_too_hard");
  check("進もうとして動けない半分 → stuck_geometry", ruleCause(f({ pushingWithoutMoving: "半分くらい" })) === "stuck_geometry");
  check("行き来 + よく見回す → lost_way", ruleCause(f({ backtracking: "少し", lookingAround: "よく見回す" })) === "lost_way");
  check("機械は lost_way にしない", ruleCause(f({ backtracking: "少し", lookingAround: "よく見回す" }, { player: PLAYER_WORD.autoplay })) === "none");
  check("ゴールに一度も近づかず着かない → unclear_goal", ruleCause(f({ towardGoal: "変わらない" }, { outcome: "ゴールに着かなかった" })) === "unclear_goal");
  check("何も無ければ none", ruleCause(f({})) === "none");
  check("困り度: 印の数(止まり大半・行き来・落下・着かない = 4)",
    ruleConfusion(f({ standingStill: "大半", backtracking: "少し", falls: "少し" }, { outcome: "ゴールに着かなかった" })) === 4);
  check("困り度: 何も無ければ 0", ruleConfusion(f({})) === 0);
}

console.log("[5] 判断の組み立て");
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-play-"));
  const reqs: any[] = [];
  const fake = (o: { score?: number; conf?: number; choice?: string; cconf?: number }): FetchLike => async (_u, init) => {
    const b = JSON.parse(init.body);
    reqs.push(b);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      if (q.type === "score") answers[k] = { type: "score", score: o.score ?? 3.1, confidence: o.conf ?? 0.8 };
      if (q.type === "choice") answers[k] = { type: "choice", choice: o.choice ?? "jump_too_hard", confidence: o.cconf ?? 0.8, probabilities: {} };
    }
    return { ok: true, status: 200, headers: { get: () => null },
             text: async () => JSON.stringify({ model: "m", answers, usage: { input_tokens: 600, output_tokens: 10 } }) };
  };
  const brief = { genre: "3D アクション", mood: ["軽快"], player_should_feel: "気持ちよく跳び回る" };
  const base = { baseDir: TMP, apiKey: "k", cache: "off" as const };
  const pts = trace([{ sec: 5, v: [0, 0, 4] }, { sec: 1, v: [0, -8, 1] }, { sec: 4, teleportTo: [0, 1.6, 0] }, { sec: 1, v: [0, -8, 1] }, { sec: 4, teleportTo: [0, 1.6, 0] }]);
  const ev: PlayEvent[] = [{ t: 0.05, kind: "key_down", detail: "W" }];

  const j = await judgePlay({ kind: "human", points: pts, events: ev, brief, askOptions: { ...base, fetch: fake({}) }, confusionPass: 2 });
  check("人のプレイ: 1 リクエストで困り度 + 原因の 2 問", reqs.length === 1 && Object.keys(reqs[0].questions).length === 2);
  check("state は brief + facts.play だけ", JSON.stringify(Object.keys(reqs[0].state.facts)) === '["play"]' && !!reqs[0].state.brief);
  check("confusion: 0..4 と言葉、合格線以上で troubled", j.confusion?.value === 3.1 && j.confusion.troubled === true && j.confusion.level === "強く困っている",
    JSON.stringify(j.confusion));
  check("cause: 選択肢 → 名前と次の一手", j.cause?.id === "jump_too_hard" && !!j.cause.hint && j.cause.confidence === 0.8);
  check("共通の形(findings は空: プレイは keep を出さない)", Array.isArray(j.findings) && j.findings.length === 0 && j.source === "jev" && j.cost.requests === 1);
  check("words に渡した言葉が残る", j.words.player === PLAYER_WORD.human && j.words.sections.length > 0);

  reqs.length = 0;
  const a = await judgePlay({ kind: "autoplay", points: trace([{ sec: 4, v: [0, 0, 3] }, { sec: 5 }]), goal: [0, 1.6, 40], cleared: false,
    brief, askOptions: { ...base, fetch: fake({ choice: "stuck_geometry" }) } });
  check("機械の軌跡: 原因だけ 1 問(困り度は聞かない)", reqs.length === 1 && Object.keys(reqs[0].questions).length === 1
    && a.confusion === null && a.cause?.id === "stuck_geometry");

  const u1 = await judgePlay({ kind: "human", points: pts, events: ev, brief, askOptions: { ...base, fetch: fake({ score: 3.2, choice: "none" }) }, confusionPass: 2 });
  check("困っているのに原因が「問題なし」→ uncertain", u1.uncertain.some((u) => /問題なし/.test(u.why)), JSON.stringify(u1.uncertain));
  const u2 = await judgePlay({ kind: "human", points: pts, events: ev, brief, askOptions: { ...base, fetch: fake({ cconf: 0.2 }) }, confusionPass: 2 });
  const lk = u2.uncertain.find((u) => u.id === "play.cause")?.look;
  check("原因の confidence が低い → uncertain + 困った場所を見る視点", lk?.tool === "dx12_screenshot_from" && Array.isArray((lk.args as any).target),
    JSON.stringify(u2.uncertain));

  reqs.length = 0;
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const r = await judgePlay({ kind: "human", points: pts, events: ev, brief, askOptions: { baseDir: TMP, fetch: fake({}) }, confusionPass: 2 });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("鍵なし → ネットに出ず、ルールで原因と困り度", reqs.length === 0 && r.source === "rules" && r.cause?.id === "jump_too_hard"
    && typeof r.confusion?.value === "number", JSON.stringify({ cause: r.cause, confusion: r.confusion }));
  const nb = await judgePlay({ kind: "human", points: pts, events: ev, brief: null, askOptions: { ...base, fetch: fake({}) } });
  check("Brief なし → ネットに出ない + briefMissing", reqs.length === 0 && nb.briefMissing === true);
  const short = await judgePlay({ kind: "human", points: [{ t: 0, pos: [0, 0, 0] }], brief, askOptions: { ...base, fetch: fake({}) } });
  check("短すぎる軌跡は聞かない", reqs.length === 0 && short.cause === null && /短すぎ/.test(short.reason ?? ""));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("[6] 評価ケース(*.cases.json)の語が本番の wordifyPlay と食い違っていない");
{
  const qs = ["play.confusion", "play.cause"].map((id) => lib.questions.get(id)!);
  for (const q of qs) {
    const file = JSON.parse(fs.readFileSync(q.casesPath!, "utf8"));
    check(`${q.id}: ケースファイルの形`, validateCases(file).length === 0, validateCases(file).join(" / "));
    check(`${q.id}: 12 件以上`, file.cases.length >= 12, String(file.cases.length));
    check(`${q.id}: question が一致`, file.question === q.id);
    const bad: string[] = [];
    for (const c of file.cases) {
      const facts = c.context?.facts?.play;
      if (!facts) { bad.push(`${c.name}: facts.play が無い`); continue; }
      if (!c.context?.brief) bad.push(`${c.name}: brief が無い(Brief 依存の質問なのでルールに落ちる)`);
      if (JSON.stringify(Object.keys(c.context.facts)) !== '["play"]') bad.push(`${c.name}: facts に play 以外がある`);
      for (const [k, v] of Object.entries<any>(facts)) if (!isPlayWord(k, v)) bad.push(`${c.name}: play.${k}=${JSON.stringify(v)}`);
      if (q.type === "noul" && typeof c.expect !== "boolean") bad.push(`${c.name}: expect は true/false`);
      if (q.id === "play.confusion" && facts.player !== PLAYER_WORD.human) bad.push(`${c.name}: 困り度は人のプレイだけ聞く`);
      if (q.type === "choice") for (const e of Array.isArray(c.expect) ? c.expect : [c.expect]) if (!(e in CAUSES)) bad.push(`${c.name}: 選択肢に無い ${e}`);
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

console.log(failed === 0 ? "\nOK: jev/playJudge テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
