/**
 * 判断段を足したツールの e2e テスト。ネット不要・エディタ不要。
 *
 * index.ts を子プロセスで起動し、偽エンジン(TCP)と偽 Jev(HTTP)に繋ぐ(部品は jev/testHarness.ts)。
 * 担保すること:
 *   [ui] dx12_ui_audit: 1 往復で brief_fit + 好みの指摘コードが届き、judge が付く。既存フィールドは壊れない。
 *        judge:false で Jev に出ない。Brief が無ければ judge.source="rules" + briefMissing。
 *   [layout] dx12_validate_layout: 聞く種類(OVERLAP 等)だけが 1 往復で届き、明らかな欠陥(Z_FIGHT)は聞かない。
 *        大きさはその物だけ get_bounds で測る。エンジンの結果(pass / errors / issues)は壊れない。judge:false で止まる。
 *   [play] get_play_session / record_playtest(人のプレイ: 困り度 + 原因の 2 問)と autoplay / run_playtests
 *        (機械の軌跡: 原因の 1 問だけ)に judge が付く。到達・再生の合否はルールのまま変わらない。
 *        偽エンジンは W を押している間だけプレイヤーを前へ進める(blocked のときは進まない=詰まり)。
 *   [perceive] dx12_perceive: 引数はそのままエンジンへ、返りは {facts(数値を含まない言葉), raw(数値)}。
 *   [gate] dx12_quality_gate: 全検査の質問が 1 往復に束なり、{pass, blocking, keep, suggestions, uncertain, cost} が返る。
 *        ルールの error は blocking、Jev の keep は blocking から外れて keep に判断が残る。judge:false はルールだけ。
 *
 * 実行: node jev/judgeTools.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdio, payload, startFakeEngine, startFakeJev } from "./testHarness.ts";

const FAKE_KEY = "apikey_e2e_judge_tools_fake_value_77";
let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-judge-tools-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, "assets"), { recursive: true });
fs.writeFileSync(path.join(PROJ, "brief.json"), JSON.stringify({
  genre: "ソシャゲのガチャ画面", mood: ["にぎやか", "きらきら"], avoid: ["地味な画面"], ui: "光って動くボタン",
}));

// ── 偽エンジンの UI: 中央揃えのボタン 6 個(うち 1 個は光沢が速い)+ 小さすぎるボタン 1 個 ──
const button = (id: number, name: string, rect: number[], img: any = {}) => ({
  entityId: id, name, resolvedRect: rect, uiRect: { visible: true }, components: ["uiImage", "uiButton"],
  uiButton: { interactable: true, onClickEvent: "go" },
  uiImage: { color: [0.2, 0.2, 0.2, 1], gradientDir: 0, outlineWidth: 0, shadowAlpha: 0, shape: 0, ...img },
});
const UI_TREE = { canvases: [{ entityId: 1, name: "Canvas", uiCanvas: { refWidth: 1920, refHeight: 1080 }, children: [
  ...Array.from({ length: 6 }, (_, i) => button(10 + i, `UI_Gacha_0${i + 1}`, [840, 200 + i * 100, 240, 64],
    i === 0 ? { gradientScrollSpeed: 0.8 } : {})),
  { entityId: 30, name: "UI_Tiny", resolvedRect: [1700, 1000, 40, 30], uiRect: { visible: true }, components: ["uiButton"],
    uiButton: { interactable: true, onClickEvent: "x" } },
] }] };

// ── 偽エンジンの配置: 本棚の中の本(OVERLAP・意図どおり)/ 壁に埋まったスライム(OVERLAP)/ 床と絨毯のちらつき(Z_FIGHT) ──
const LAYOUT_REPORT = { pass: false, checked: 6, errors: 2, warnings: 1, fixed: 0, sceneGeneration: 3, issues: [
  { kind: "OVERLAP", level: "error", text: "ENV_Book_07 が ENV_Bookshelf_01 に体積比 100% めり込んでいる。どちらかをずらすか片方を消すこと",
    fixed: false, entityId: 22, name: "ENV_Book_07", otherEntityId: 21, otherName: "ENV_Bookshelf_01" },
  { kind: "OVERLAP", level: "warning", text: "GP_Enemy_Slime_01 が LVL_Wall_02 に体積比 45% めり込んでいる。どちらかをずらすか片方を消すこと",
    fixed: false, entityId: 30, name: "GP_Enemy_Slime_01", otherEntityId: 11, otherName: "LVL_Wall_02" },
  { kind: "Z_FIGHT", level: "error", text: "LVL_Floor と ENV_Rug の面が Y 軸で 0.00mm しか離れていない", fixed: false,
    entityId: 25, name: "ENV_Rug", otherEntityId: 10, otherName: "LVL_Floor" },
] };
const ENTS = [
  { entityId: 1, name: "LVL" }, { entityId: 2, name: "ENV" }, { entityId: 3, name: "GAMEPLAY" },
  { entityId: 10, name: "LVL_Floor", parent: 1 }, { entityId: 11, name: "LVL_Wall_02", parent: 1 },
  { entityId: 21, name: "ENV_Bookshelf_01", parent: 2 }, { entityId: 22, name: "ENV_Book_07", parent: 2 },
  { entityId: 25, name: "ENV_Rug", parent: 2 }, { entityId: 30, name: "GP_Enemy_Slime_01", parent: 3 },
];
const hierNode = (id: number): any => ({ entityId: id, children: ENTS.filter((e) => e.parent === id).map((e) => hierNode(e.entityId)) });

// ── 偽エンジンのプレイヤー: W を押している間だけ +Z へ 4m/s。blocked のときは動かない(壁に詰まった) ──
const sim = { mode: "Editor", held: new Set<string>(), pos: [0, 1, 0] as number[], blocked: false };
const resetSim = () => { sim.held.clear(); sim.pos = [0, 1, 0]; };
// 人のプレイ記録(10Hz・5 秒): W で前へ進み、途中で 2 回 8m 落ちて戻される
const HUMAN_SESSION = (() => {
  const samples: any[] = [];
  let z = 0, y = 1.6;
  for (let i = 0; i <= 150; i++) {
    const t = i / 10;
    if ((i > 30 && i <= 40) || (i > 90 && i <= 100)) y -= 0.8;          // 1 秒で 8m 落ちる
    else if (i === 41 || i === 101) { y = 1.6; z = 0; }                  // 戻される
    else z += 0.4;
    samples.push({ t, fps: 60, camPos: [0, y, z], camYaw: 0, camPitch: 0, mouse: [0, 0] });
  }
  return { started: true, recording: false, durationSec: 15, frames: 900, fpsMin: 60,
           summary: { errors: 0, warnings: 0, inputEvents: 2 },
           events: [{ t: 0.1, kind: "key_down", detail: "W" }, { t: 14.9, kind: "key_up", detail: "W" }], samples };
})();

// ── 偽エンジンの知覚層: JUNCTION の実測(破片 C6_p0 の灯りを裏へ回した「真っ黒な板」)──
const SHARD_DARK = { name: "C6_p0", pixels: 22414, share: 0.0366, bbox: [0.55, 0.47, 0.63, 0.54], center: [0.5897, 0.504],
  luma: 0.2706, lumaStd: 0.05, lumaRing: 0.6807, contrast: 0.4387, saturation: 0.1714, distance: 4.114, distanceMin: 3.9,
  fullyInView: true, projectedExtent: [0.08, 0.07], occlusion: 0, litFacing: 0.0006, backFacing: 0,
  mainLight: { name: "C6_fill", facing: 0 }, isolatedPixels: 22414 };
const PERCEIVE_RAW = { mode: "Editor", camera: { source: "explicit", position: [14, 5.1, 122], forward: [0, 0, 1], fovDeg: 72 },
  scene: { empty: 0.02, regions: { top: { empty: 0.04, luma: 0.55, lumaStd: 0.08, distance: 9 }, bottom: { empty: 0, luma: 0.6, lumaStd: 0.07, distance: 4 },
                                   left: { empty: 0.02, luma: 0.58, lumaStd: 0.07, distance: 7 }, right: { empty: 0.02, luma: 0.57, lumaStd: 0.08, distance: 6 } },
           luma: { mean: 0.57, p5: 0.3, p50: 0.58, p95: 0.8, crushed: 0.001, clipped: 0.004 }, farthest: 31.5, visibleEntities: 40 },
  targets: [SHARD_DARK], top: [{ ...SHARD_DARK, name: "C6_wall", share: 0.41, occlusion: null }] };

function engineHandler(method: string, params: any): any {
  switch (method) {
    case "perceive": return PERCEIVE_RAW;
    // ── 品質ゲートが集めるもの(polish の材料・シーン検証・診断) ──
    case "validate_scene": return { pass: true, exitCode: 0, scenePath: "scenes/main.json", report: "PASS" };
    case "diagnose": return { summary: { errors: 0, warnings: 0, ok: true }, checks: [] };
    case "get_scene_settings": return { skybox: { envMapPath: "__procedural_sky__", iblIntensity: 1, drawSkybox: false } };
    case "list_lights": return { lights: [{ type: "Point", intensity: 0.8, castShadows: true }] };
    case "get_volumetric_fog": return { enabled: false, density: 0 };
    case "get_post_process": return { vignetteOn: true };
    case "get_ssao": case "get_contact_shadow": return { enabled: true };
    case "get_play_session": return HUMAN_SESSION;
    case "get_mode": return { mode: sim.mode };
    case "play": sim.mode = "Playing"; resetSim(); return { mode: "Playing", sceneGeneration: 4 };
    case "stop": sim.mode = "Editor"; resetSim(); return { mode: "Editor", sceneGeneration: 5 };
    case "open_scene": resetSim(); return { opened: params.path };
    case "step_frames": {
      const n = Number(params.frames ?? 1);
      if (!sim.blocked && sim.held.has("W")) sim.pos[2] += (4 / 60) * n;
      return { stepped: true, frames: n };
    }
    case "key_down": sim.held.add(String(params.key).toUpperCase()); return { ok: true };
    case "key_up": sim.held.delete(String(params.key).toUpperCase()); return { ok: true };
    case "key_press": case "mouse_move": return { ok: true };
    case "get_script_errors": return { count: 0, errors: [] };
    case "get_physics_state": return { velocity: [0, 0, sim.held.has("W") && !sim.blocked ? 4 : 0], isGrounded: true };
    case "navmesh_path": return { points: [[0, 1, 10]], reached: true };
    case "get_entity":
      if (params.name === "CAM") return { camera: { isActive: true }, transform: { rotation: [0, 0, 0] } };
      return { transform: { position: [...sim.pos], rotation: [0, 0, 0] } };
    case "ping": return { pong: true, mode: "Editor", protocolVersion: 4, baseDir: PROJ, assetsDir: path.join(PROJ, "assets"), cwd: TMP };
    case "ui_tree": return UI_TREE;
    case "validate_layout": return LAYOUT_REPORT;
    case "get_bounds":
      if (params.name === "GP_Goal") return { size: [1, 1, 1], center: [0, 1, 40], min: [0, 0, 39], max: [1, 2, 41] };
      return { size: params.entity === 21 ? [2, 2.2, 0.4] : [0.5, 0.5, 0.5], center: [0, 0, 0], min: [0, 0, 0], max: [1, 1, 1] };
    case "list_entities":
      if (params.component_type === "characterController") return { entities: [{ entityId: 99, name: "GP_Player" }] };
      if (params.component_type === "camera") return { entities: [{ entityId: 98, name: "CAM" }] };
      return { entities: ENTS.map((e) => ({ entityId: e.entityId, name: e.name, componentTypes: [] })) };
    case "get_hierarchy": return { roots: ENTS.filter((e) => e.parent === undefined).map((e) => hierNode(e.entityId)) };
    default: return undefined;
  }
}

const engine = await startFakeEngine(engineHandler);
// 光沢(BUSY_GLOSS)だけ「意図どおり」と答える偽 Jev
const jev = await startFakeJev({
  noul: (text) => (text.includes("BUSY_GLOSS") ? 0.94 : 0.08),
  score: () => ({ score: 3.3, confidence: 0.85 }),
});
const mcp = new McpStdio({ enginePort: engine.port, jevUrl: jev.url, key: FAKE_KEY });
await mcp.init();

try {
  console.log("[ui] dx12_ui_audit の判断段");
  {
    const before = jev.reqs.length;
    const r = payload(await mcp.call("dx12_ui_audit", { strictness: "strict", screen: "title" }));
    assert.equal(typeof r.score, "number");
    assert.equal(typeof r.grade, "string");
    assert.equal(r.pass, false);
    assert.ok(Array.isArray(r.issues) && r.metrics, "既存の issues / metrics は従来どおり");
    const codes = new Set(r.issues.map((i: any) => i.code));
    assert.ok(codes.has("BUSY_GLOSS") && codes.has("CENTERED_MONOTONY") && codes.has("SMALL_HIT_TARGET"), [...codes].join(","));
    pass("pass / score / grade / issues / metrics は従来どおり");

    assert.equal(jev.reqs.length - before, 1, "判断段は 1 往復");
    const req = jev.reqs[jev.reqs.length - 1];
    assert.equal(req.auth, `Bearer ${FAKE_KEY}`);
    assert.equal(req.state.brief.genre, "ソシャゲのガチャ画面", "brief.json が state に入る");
    assert.deepEqual(Object.keys(req.state.facts), ["ui"]);
    assert.equal(req.state.facts.ui.screen, "タイトル画面");
    assert.ok(!/[0-9]/.test(JSON.stringify({ ...req.state.facts.ui, issues: [] })), "ui の語に数字が無い");
    const askedCodes = Object.values<any>(req.questions).map((q) => (JSON.stringify(q.instructions).match(/screen: ([A-Z_]+)/) ?? [])[1]).filter(Boolean);
    assert.ok(!askedCodes.includes("SMALL_HIT_TARGET"), "機能の欠陥は聞かない");
    assert.equal(Object.keys(req.questions).length, 1 + askedCodes.length);
    pass("1 リクエストで brief_fit + 好みの指摘コードだけ。state は Brief + 数値を含まない言葉");

    const j = r.judge;
    assert.equal(j.source, "jev");
    assert.equal(j.briefFit.value, 3.3);
    assert.deepEqual(j.findings.filter((f: any) => f.keep).map((f: any) => f.code), ["BUSY_GLOSS"]);
    assert.ok(j.notAsked.includes("SMALL_HIT_TARGET"));
    assert.ok(j.scoreExcludingKept > r.score);
    assert.equal(j.passExcludingKept, false, "エラー(小さすぎるボタン)は keep でも消えない");
    assert.equal(j.cost.requests, 1);
    pass("judge: {source:jev, briefFit, findings[keep], notAsked, scoreExcludingKept, cost}");

    const before2 = jev.reqs.length;
    const off = payload(await mcp.call("dx12_ui_audit", { judge: false }));
    assert.equal(off.judge, undefined);
    assert.equal(jev.reqs.length, before2);
    pass("judge:false で判断段を止める(Jev に出ない)");

    fs.renameSync(path.join(PROJ, "brief.json"), path.join(PROJ, "brief.json.bak"));
    try {
      const nb = payload(await mcp.call("dx12_ui_audit", {}));
      assert.equal(jev.reqs.length, before2, "Brief が無ければ聞かない");
      assert.equal(nb.judge.source, "rules");
      assert.equal(nb.judge.briefMissing, true);
      assert.equal(nb.judge.scoreExcludingKept, nb.score);
      pass("Brief が無い → judge.source:rules + briefMissing(従来どおり全部直す)");
    } finally {
      fs.renameSync(path.join(PROJ, "brief.json.bak"), path.join(PROJ, "brief.json"));
    }

    const unknown = await mcp.call("dx12_ui_audit", { judgee: false });
    assert.equal(unknown.result.isError, true, "未知の引数は近い正解つきのエラー");
    pass("未知の引数は弾く(regRaw の流儀)");
  }

  console.log("[layout] dx12_validate_layout の判断段");
  {
    // 本棚の本(ref A)だけ「意図どおり」と答える
    jev.cfg.answers = { noul: (text) => (text.includes("flagged issue A ") ? 0.93 : 0.05) };
    const before = jev.reqs.length;
    const boundsBefore = engine.received.filter((r) => r.method === "get_bounds").length;
    const r = payload(await mcp.call("dx12_validate_layout", {}));
    assert.equal(r.pass, false);
    assert.equal(r.errors, 2);
    assert.equal(r.issues.length, 3, "エンジンの issues は従来どおり");
    pass("pass / errors / issues はエンジンの返り値のまま");

    assert.equal(jev.reqs.length - before, 1, "判断段は 1 往復");
    const req = jev.reqs[jev.reqs.length - 1];
    assert.deepEqual(Object.keys(req.state.facts), ["layout"]);
    assert.equal(Object.keys(req.questions).length, 2, "OVERLAP 2 件だけ聞く(Z_FIGHT は聞かない)");
    assert.ok(!/[0-9]/.test(JSON.stringify(req.state.facts.layout)), "layout の語に数字が無い");
    const measured = engine.received.filter((x) => x.method === "get_bounds").slice(boundsBefore).map((x) => x.params.entity).sort((a: number, b: number) => a - b);
    assert.deepEqual(measured, [11, 21, 22, 30], "大きさは聞く指摘に出てくる物だけ測る");
    pass("1 リクエストで聞く種類の指摘だけ。state は Brief + 数値を含まない言葉");

    const j = r.judge;
    assert.equal(j.source, "jev");
    assert.deepEqual(j.findings.filter((f: any) => f.keep).map((f: any) => f.name), ["ENV_Book_07"]);
    assert.deepEqual(j.notAsked, ["Z_FIGHT"]);
    assert.equal(j.errorsExcludingKept, 1, "本棚の本(エラー)は keep で外れ、Z_FIGHT は残る");
    assert.equal(j.passExcludingKept, false);
    pass("judge: {source:jev, findings[keep], notAsked:[Z_FIGHT], errorsExcludingKept, passExcludingKept}");

    const before2 = jev.reqs.length;
    const off = payload(await mcp.call("dx12_validate_layout", { judge: false, fix: "none" }));
    assert.equal(off.judge, undefined);
    assert.equal(jev.reqs.length, before2);
    const sent = engine.received.filter((x) => x.method === "validate_layout").pop()!;
    assert.equal(sent.params.judge, undefined, "judge はエンジンへ送らない");
    assert.equal(sent.params.fix, "none");
    pass("judge:false で止まる。judge はエンジンへ渡さない");
  }

  console.log("[play] プレイテストの判断段");
  {
    const questionTypes = (req: any) => Object.values<any>(req.questions).map((q) => q.type).sort().join(",");
    jev.cfg.answers = {
      score: () => ({ score: 3.2, confidence: 0.8 }),
      choice: (keys) => ({ choice: keys.includes("jump_too_hard") ? "jump_too_hard" : keys[0], confidence: 0.82 }),
    };

    // ① 人のプレイ: get_play_session
    let before = jev.reqs.length;
    const gp = engine.received.filter((x) => x.method === "get_play_session").length;
    const s = payload(await mcp.call("dx12_get_play_session", { maxSamples: 20, goalName: "GP_Goal" }));
    assert.equal(s.started, true);
    assert.equal(s.samples.length, 151, "偽エンジンは間引かないので本体はそのまま");
    const calls = engine.received.filter((x) => x.method === "get_play_session").slice(gp);
    assert.equal(calls.length, 2, "本体(maxSamples:20)+ 判断用の全体(8000/4000)");
    assert.equal(calls[1].params.maxSamples, 4000);
    assert.equal(jev.reqs.length - before, 1);
    assert.equal(questionTypes(jev.reqs[jev.reqs.length - 1]), "choice,score", "人のプレイは困り度 + 原因の 2 問");
    const pf = jev.reqs[jev.reqs.length - 1].state.facts.play;
    assert.ok(!/[0-9]/.test(JSON.stringify(pf)), "play の語に数字が無い");
    assert.equal(pf.player, "人のプレイ");
    assert.ok(pf.sections.some((x: any) => x.falls !== "なし"), "落下を数えている");
    assert.equal(s.judge.source, "jev");
    assert.equal(s.judge.cause.id, "jump_too_hard");
    assert.equal(s.judge.confusion.value, 3.2);
    pass("get_play_session: 全体で数えて 1 往復(困り度 + 原因)、goalName でゴールへの進みも数える");

    before = jev.reqs.length;
    const off = payload(await mcp.call("dx12_get_play_session", { judge: false }));
    assert.equal(off.judge, undefined);
    assert.equal(jev.reqs.length, before);
    pass("get_play_session: judge:false で止まる");

    // ② 機械の軌跡: autoplay が壁に詰まる
    sim.blocked = true;
    before = jev.reqs.length;
    const ap = payload(await mcp.call("dx12_autoplay", { goal: [0, 1, 10] }, 60000));
    assert.equal(ap.cleared, false, "到達判定はルールのまま");
    assert.ok(ap.stuckAt, "詰まった座標もルールのまま");
    assert.equal(jev.reqs.length - before, 1);
    assert.equal(questionTypes(jev.reqs[jev.reqs.length - 1]), "choice", "機械の軌跡は原因だけ");
    assert.match(jev.reqs[jev.reqs.length - 1].state.facts.play.player, /迷うことはない/);
    assert.equal(ap.judge.confusion, null);
    assert.ok(ap.judge.cause?.id);
    pass("autoplay: 届かなかったら原因だけ 1 問。cleared / stuckAt はルールのまま");

    // ③ 保存済みの .playtest を再生して落ちる(壁に詰まって記録どおり進めない)
    const dir = path.join(PROJ, ".dx12", "playtests");
    fs.mkdirSync(dir, { recursive: true });
    const ref = Array.from({ length: 51 }, (_, i) => ({ t: i / 10, pos: [0, 1, (i / 10) * 4] }));
    fs.writeFileSync(path.join(dir, "blocked_run.json"), JSON.stringify({
      version: 1, name: "blocked_run", scene: "scenes/main.json", recordedAt: "2026-09-25T00:00:00Z", durationSec: 5,
      steps: [{ t: 0, down: "W" }, { t: 4.9, up: "W" }], look: [], reference: ref, endTolerance: 1, pathTolerance: 2, expect: [],
    }));
    before = jev.reqs.length;
    const rp = payload(await mcp.call("dx12_run_playtests", { name: "blocked_run" }, 60000));
    assert.equal(rp.failed, 1, "再生の合否はルールのまま");
    assert.ok(rp.results[0].reasons.some((r: string) => /ずれた/.test(r)));
    assert.equal(jev.reqs.length - before, 1);
    assert.equal(questionTypes(jev.reqs[jev.reqs.length - 1]), "choice");
    assert.match(jev.reqs[jev.reqs.length - 1].state.facts.play.player, /再生/);
    assert.ok(rp.results[0].judge?.cause, "落ちたテストに原因が付く");
    pass("run_playtests: 落ちたテストだけ原因を 1 問。合否と reasons はルールのまま");

    // ④ 人のプレイを保存(record_playtest): 再生して基準を焼き、人の記録そのものの困り度を聞く
    sim.blocked = false;
    before = jev.reqs.length;
    const rec = payload(await mcp.call("dx12_record_playtest", { name: "human_run" }, 60000));
    assert.ok(fs.existsSync(rec.saved), "保存はこれまでどおり");
    assert.equal(jev.reqs.length - before, 1);
    assert.equal(questionTypes(jev.reqs[jev.reqs.length - 1]), "choice,score");
    assert.equal(rec.judge.cause.id, "jump_too_hard");
    pass("record_playtest: 保存はそのまま、人の記録の困り度 + 原因を 1 往復で");
  }

  console.log("[perceive] dx12_perceive");
  {
    const r = payload(await mcp.call("dx12_perceive", { camera: { position: [14, 5.1, 122], target: [14, 5, 126], fovDeg: 72 }, targets: ["C6_p0"] }));
    const sent = engine.received.filter((x) => x.method === "perceive").pop()!;
    assert.deepEqual(sent.params.camera, { position: [14, 5.1, 122], target: [14, 5, 126], fovDeg: 72 });
    assert.deepEqual(sent.params.targets, ["C6_p0"]);
    assert.equal(r.raw.targets[0].litFacing, 0.0006, "raw はエンジンの数値のまま");
    const f = r.facts.targets[0];
    assert.equal(f.name, "C6_p0");
    assert.equal(f.facts.lit_side, "影（灯りは裏側から当たっている）");
    assert.equal(f.facts.brightness, "暗い");
    // 名前(C6_fill / C6_wall)は識別子なので除いて見る
    assert.ok(!/[0-9]/.test(JSON.stringify({ ...f.facts, main_light: "" })) && !/[0-9]/.test(JSON.stringify({ ...r.facts.scene, dominant: "" })), "facts に数値が無い");
    pass("引数はそのままエンジンへ、返りは facts(言葉)+ raw(数値)");
    const bad = await mcp.call("dx12_perceive", { camera: "sideways" });
    assert.equal(bad.result.isError, true, "camera は editor / game / {position,target}");
    pass("camera の形が違えばスキーマで弾く");
  }

  console.log("[gate] dx12_quality_gate");
  {
    jev.cfg.answers = {
      noul: (text) => (text.includes("flagged issue A ") ? 0.93 : 0.05),
      score: () => ({ score: 3, confidence: 0.9 }),
      choice: (keys) => ({ choice: keys.includes("enable_ssao") ? "enable_ssao" : keys[0], confidence: 0.8 }),
    };
    const before = jev.reqs.length;
    const g = payload(await mcp.call("dx12_quality_gate", { screenshot: false }, 60000));
    for (const k of ["pass", "blocking", "keep", "suggestions", "uncertain", "cost", "checks", "judge", "next"]) assert.ok(k in g, `${k} が無い`);
    assert.deepEqual(Object.keys(g.cost).sort(), ["ms", "requests", "tokens", "usd"]);
    pass("{pass, blocking[], keep[], suggestions[], uncertain[], cost:{requests, tokens, usd, ms}} の形");

    // ★配置の 2 問は [layout] と同じ state なのでキャッシュから返る(リクエストは polish と ui の 2 本)
    const mine = jev.reqs.slice(before);
    const domains = mine.map((r) => Object.keys(r.state.facts).sort().join("+"));
    assert.ok(domains.every((d) => ["findings+look", "ui", "layout"].includes(d)), `検査をまたいだ state がある: ${JSON.stringify(domains)}`);
    assert.ok(domains.includes("findings+look") && domains.includes("ui"), JSON.stringify(domains));
    assert.equal(g.cost.requests, mine.length);
    const layJudge = g.checks.find((c: any) => c.id === "layout")?.judge;
    assert.ok(["cache", "jev"].includes(layJudge?.source), JSON.stringify(layJudge));
    assert.equal(g.judge.bundle, "perDomain");
    const before1 = jev.reqs.length;
    const one = payload(await mcp.call("dx12_quality_gate", { screenshot: false, bundle: "one" }, 60000));
    assert.equal(jev.reqs.length - before1, 1, "bundle:one なら全検査の質問が 1 リクエスト");
    assert.deepEqual(Object.keys(jev.reqs[jev.reqs.length - 1].state.facts).sort(), ["findings", "layout", "look", "ui"]);
    assert.equal(one.cost.requests, 1);
    pass("既定は検査ごとの state で並列(1 往復ぶんの待ち)、bundle:one で本当に 1 リクエスト");

    assert.equal(g.pass, false);
    const bl = g.blocking.map((b: any) => b.code);
    assert.ok(bl.includes("Z_FIGHT") && bl.includes("SMALL_HIT_TARGET"), bl.join(","));
    assert.ok(!g.blocking.some((b: any) => b.name === "ENV_Book_07"), "keep した本棚の本は blocking から外れる");
    const kb = g.keep.find((k: any) => k.name === "ENV_Book_07");
    assert.ok(kb && kb.judge.value === 0.93 && ["jev", "cache"].includes(kb.judge.source) && kb.judge.confidence === 0.93, JSON.stringify(g.keep));
    assert.ok(g.suggestions.some((s: any) => s.tool === "dx12_set_ssao"), "polish の次の一手");
    const vl = engine.received.filter((x) => x.method === "validate_layout").pop()!;
    assert.equal(vl.params.fix, "none", "ゲートは検査だけ(勝手に直さない)");
    pass("ルールの error は blocking、keep は外れて判断と確信度が残る。ゲートは勝手に直さない");

    const before2 = jev.reqs.length;
    const r = payload(await mcp.call("dx12_quality_gate", { judge: false, screenshot: false, checks: ["layout"] }, 60000));
    assert.equal(jev.reqs.length, before2);
    assert.equal(r.keep.length, 0);
    assert.ok(r.blocking.some((b: any) => b.name === "ENV_Book_07"), "ルールだけなら本棚の本も blocking");
    assert.equal(r.checks.length, 1);
    pass("judge:false はルールだけ(Jev に出ない)。checks で絞れる");

    const rd = payload(await mcp.call("dx12_quality_gate", { screenshot: false, checks: ["readability"],
      readability: [{ label: "継ぎ目 F の焦点", camera: { position: [14, 5.1, 122], target: [14, 5, 126] }, targets: [{ name: "C6_p0", role: "見つけてほしい破片" }] }] }, 60000));
    const pv = engine.received.filter((x) => x.method === "perceive").pop()!;
    assert.deepEqual(pv.params.targets, ["C6_p0"]);
    assert.ok(rd.suggestions.some((s: any) => s.check === "readability" && /C6_p0/.test(s.text)), JSON.stringify(rd.suggestions));
    assert.equal(rd.blocking.length, 0, "読みにくさは blocking にしない");
    pass("readability: 視点ごとに perceive → 気づけない対象を suggestions で名指し(blocking にはしない)");

    const bad = await mcp.call("dx12_quality_gate", { checks: ["nope"] });
    assert.equal(bad.result.isError, true, "知らない検査はエラー");
    pass("知らない検査 id はスキーマで弾く");
  }
} catch (e) {
  console.log(`  NG  ${(e as Error).message}`);
  mcp.kill(); engine.server.close(); jev.server.close();
  process.exit(1);
}

mcp.kill();
engine.server.close();
jev.server.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nOK: 判断段ツール e2e テスト ${passed} 項目すべて通過`);
process.exit(0);
