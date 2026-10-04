// 人のプレイを回帰テストにする(記録 → 保存 → 再生 → 比較)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { bakeGoldenRun, compareReplay, playtestDir, type PlaytestFile, safeName, sessionToPlaytest, validatePlaytest } from "../playtestStore.ts";
import path from "node:path";
import { compileTimeline, danglingKeys, type ScriptStep, type TraceSample } from "../playtest.ts";
import { verdict } from "../polish.ts";
import { z } from "zod";
import fs from "node:fs";
import { eventsFromSteps, fromSession, type PlayInput, pointsFromTrace } from "../jev/playJudge.ts";
import { engine, reg, run } from "./core.ts";
import { DEFAULT_DT, faceYaw, findPlayerName, releaseAll, sampleState } from "./testplay.ts";
import { goalPosition, judgePlayFor } from "./play.ts";

// ════════════════════════════════════════════════════════════════
//  人のプレイを回帰テストにする（記録 → 保存 → 再生 → 比較）
// ════════════════════════════════════════════════════════════════

/** .playtest の保存先。プロジェクト直下に固定して CI が拾えるようにする。 */
async function playtestPaths(name?: string): Promise<{ dir: string; file?: string }> {
  const ping = await engine.call("ping", {});
  const dir = playtestDir(ping.baseDir);
  return { dir, file: name ? path.join(dir, `${safeName(name)}.json`) : undefined };
}

/**
 * .playtest を 1 本再生して結果を返す。
 * ★キー列は記録どおり、向きは記録した yaw をマウス注入の閉ループで追いかける。
 *   記録に残っているのは「10Hz の yaw の値」であって毎フレームのマウス移動量ではないので、
 *   移動量をそのまま流し直すことはできない（感度も違う）。角度を目標にする方が確実。
 */
export async function replayPlaytest(pt: PlaytestFile, dt = DEFAULT_DT) {
  await engine.call("stop", {});
  await engine.call("open_scene", { path: pt.scene });
  await engine.call("play", {});
  await engine.call("step_frames", { frames: 30, deterministic: true, dt });

  const player = await findPlayerName();
  const events = compileTimeline(pt.steps as ScriptStep[], dt);
  const look = { degPerPixel: null as number | null };
  // ★記録した長さ「ちょうど」で止める（余韻を足すと空中で終わったジャンプが着地してずれる）
  const totalFrames = Math.ceil(pt.durationSec / dt);
  const sampleFrames = Math.max(1, Math.round(0.1 / dt));   // 記録と同じ 10Hz

  const trace: TraceSample[] = [await sampleState(player, 0)];
  let frame = 0;
  let ei = 0;
  let li = 0;

  while (frame < totalFrames) {
    const t = frame * dt;
    while (ei < events.length && events[ei].frame <= frame) {
      const ev = events[ei++];
      for (const k of ev.downs) await engine.call("key_down", { key: k });
      for (const k of ev.ups) await engine.call("key_up", { key: k });
      for (const k of ev.presses) await engine.call("key_press", { key: k });
    }
    // その時刻の yaw 目標へ向ける（追い越した分は捨てる）。
    // ★向きを合わせるのに使ったフレームも数える。数えないとマウスを振った回数ぶん
    //   余計にシミュレーションが進み、同じ入力なのに記録より遠くまで行ってしまう。
    while (li + 1 < pt.look.length && pt.look[li + 1].t <= t) li++;
    if (li < pt.look.length) frame += (await faceYaw(pt.look[li].yaw, dt, look, 3, 4)).iters;
    if (frame >= totalFrames) break;

    const nextEvent = ei < events.length ? events[ei].frame : totalFrames;
    const to = Math.min(nextEvent, frame + sampleFrames, totalFrames);
    const n = Math.max(1, to - frame);
    await engine.call("step_frames", { frames: n, deterministic: true, dt });
    frame += n;
    trace.push(await sampleState(player, frame * dt));
  }

  await releaseAll(danglingKeys(pt.steps as ScriptStep[]));
  let scriptErrors = 0;
  try { scriptErrors = (await engine.call("get_script_errors", {}))?.count ?? 0; } catch { /* 無視 */ }
  await engine.call("stop", {});

  return { verdict: compareReplay(pt, trace, scriptErrors), trace, player };
}

reg(
  "dx12_record_playtest",
  "プレイを回帰テストとして保存",
  "直前の 1 プレイ(dx12_get_play_session の記録)を .playtest として保存する。★人が 1 回遊べば回帰テストが 1 本増える、が狙い。コードは ctest で守られているのに遊びは誰も守っていない、という穴を埋めるための機能。保存先は <project>/.dx12/playtests/<name>.json で、キーの押し離しタイムライン・10Hz の yaw 目標・カメラ軌跡(基準)が入る。判定は『終点が endTolerance 以内・途中の経路が pathTolerance 以内・再生中に Lua が死なない』の 3 つだけ(経路をピクセル単位で一致させようとすると毎回落ちて誰も見なくなる)。★入力が 1 つも無い記録と、リング上限でこぼれた記録は拒否する。手順: dx12_play → 人に遊んでもらう → dx12_stop → これ。",
  {
    name: z.string().describe("テスト名(英数字。ファイル名になる)。"),
    endTolerance: z.number().optional().describe("終点のずれの許容(m)。既定 1.0（実測のゆらぎは 0.002m）。"),
    pathTolerance: z.number().optional().describe("経路のずれの許容(m)。既定 2.0。ランダム要素があるゲームは緩める。"),
    note: z.string().optional().describe("何を確かめるテストかのメモ。"),
    goalName: z.string().optional().describe("判断段用: ゴールのエンティティ名(人のプレイがゴールへ近づいたかを数える)。"),
    judge: z.boolean().optional().describe("false で判断段(人のプレイの困り度と原因を Jev に聞く段)を止める。既定 true。"),
  },
  { destructiveHint: false },
  ({ name, endTolerance, pathTolerance, note, goalName, judge }) =>
    run(async () => {
      const ping = await engine.call("ping", {});
      const session = await engine.call("get_play_session", { maxEvents: 8000, maxSamples: 4000 });
      if (!session?.started)
        throw new Error("記録がない。dx12_play で遊んでから撃つこと");

      const draft = sessionToPlaytest(session, {
        name, scene: ping.currentScene, endTolerance, pathTolerance, note,
      });

      // ★人の軌跡はそのまま基準にしない。人のプレイは実時間、再生は固定 dt なので、
      //   入力のタイミングが同じでも軌跡は構造的にずれる（実測で 3m）。
      //   ここで 1 回再生し、その結果を基準（ゴールデンラン）として焼き込む。
      //   ＝以後の再生は「同じ仕組みで走らせた結果」と比べることになり、
      //   ずれたら本当にゲーム側が変わったときだけになる。
      const first = await replayPlaytest(draft);
      const pt = bakeGoldenRun(draft, first.trace);

      const warnings: string[] = [];
      if ((pt.humanDrift ?? 0) > 8)
        warnings.push(
          `初回再生が人の軌跡から最大 ${pt.humanDrift}m 離れた。入力だけでは再現しきれていない` +
          "（マウス視点を細かく振るプレイは再現性が落ちる）。基準は再生側なのでテストとしては" +
          "成立するが、人の遊びを再現しているとは限らない");

      const { dir, file } = await playtestPaths(name);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file!, JSON.stringify(pt, null, 2), "utf8");
      // 判断段: 人が遊んだ記録そのもの(再生ではない)がどれくらい困っていたか。保存の成否には関係しない。
      const judged = judge === false ? undefined
        : await judgePlayFor(fromSession(session, await goalPosition(undefined, goalName)));
      return {
        ...(judged !== undefined ? { judge: judged } : {}),
        saved: file, name: safeName(name), scene: pt.scene,
        durationSec: Number(pt.durationSec.toFixed(2)),
        inputs: pt.steps.length, samples: pt.reference.length,
        humanDrift: pt.humanDrift, warnings,
        next: "dx12_run_playtests で再生して確かめる。CI からは ciClient.ts --playtests で回る",
      };
    }),
);

reg(
  "dx12_run_playtests",
  "回帰テストの再生",
  "保存済みの .playtest を再生して、記録どおりに動くか確かめる。キー列は記録どおり、向きは記録した yaw をマウス注入の閉ループで追いかける(記録にあるのは 10Hz の角度であって毎フレームのマウス移動量ではないため、移動量の流し直しはできない)。落ちたときは【いつ・どれだけ】ずれたかを返す: 『t=4.20s で経路が 6.10m ずれた』『終点が 8.30m ずれた(記録は [0,1.6,20]、今回は [3,0.1,12])』。ジャンプ力を変えた・コライダーをずらした・Lua を直した、でステージがクリアできなくなったのを機械が拾うための機能。name 省略で全部走らせる。",
  {
    name: z.string().optional().describe("走らせるテスト名。省略で全部。"),
    judge: z.boolean().optional().describe("false で判断段(落ちたテストの原因を Jev に聞く段)を止める。既定 true。"),
  },
  { destructiveHint: false },
  ({ name, judge }) =>
    run(async () => {
      const { dir } = await playtestPaths();
      let files: string[];
      try {
        files = (await fs.promises.readdir(dir))
          .filter((f) => f.endsWith(".json"))
          .filter((f) => !name || f === `${safeName(name)}.json`);
      } catch {
        return { ran: 0, results: [], note: `.playtest がまだ 1 本も無い（${dir}）`,
                 next: "dx12_play → 遊ぶ → dx12_stop → dx12_record_playtest で作る" };
      }
      if (files.length === 0) throw new Error(`該当する .playtest が無い（${dir}）`);

      const results: any[] = [];
      const judgeLater: { index: number; input: PlayInput }[] = [];
      for (const f of files) {
        const raw = JSON.parse(await fs.promises.readFile(path.join(dir, f), "utf8"));
        const bad = validatePlaytest(raw);
        if (bad.length) {
          results.push({ name: f, pass: false, reasons: bad });
          continue;
        }
        const pt = raw as PlaytestFile;
        const { verdict, trace } = await replayPlaytest(pt);
        results.push({
          name: pt.name, scene: pt.scene, pass: verdict.pass,
          endDistance: verdict.endDistance, maxDeviation: verdict.maxDeviation,
          maxDeviationAt: verdict.maxDeviationAt, reasons: verdict.reasons,
        });
        // 落ちたものだけ、なぜ落ちたか(原因)を後でまとめて聞く(再生はエンジンを占有するので先に全部回す)
        if (!verdict.pass && judge !== false) {
          judgeLater.push({ index: results.length - 1, input: {
            kind: "replay", points: pointsFromTrace(trace), events: eventsFromSteps(pt.steps as any), deviation: verdict,
          } });
        }
      }
      const judged = await Promise.all(judgeLater.map((j) => judgePlayFor(j.input)));
      judgeLater.forEach((j, i) => { results[j.index].judge = judged[i]; });
      const failed = results.filter((r) => !r.pass);
      return {
        ran: results.length, passed: results.length - failed.length, failed: failed.length,
        results,
        ...(failed.length ? { next: "reasons の『いつ・どれだけ』を見て、配置か操作かを切り分ける。" +
                                    "配置なら dx12_validate_layout、到達性なら dx12_check_reachable" } : {}),
      };
    }),
);
