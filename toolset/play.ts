// プレイテストの判断段 / 入力シミュレーション(key_* / mouse_move)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { fromSession, judgePlay, type PlayInput, type Vec3 as PlayVec3 } from "../jev/playJudge.ts";
import { readBrief } from "../jev/brief.ts";
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { OUT, engine, jevProjectBaseDir, reg, regRaw, run } from "./core.ts";

// ── プレイテストの判断段(jev/playJudge.ts)──────────────────────────
// ★到達判定・リプレイ比較の合否はルールのまま。Jev は「なぜ・どれくらい困っているか」の説明だけ。
//   judge を返すのは get_play_session / record_playtest(人のプレイ: 困り度 + 原因)と
//   autoplay / run_playtests(機械の軌跡: 原因だけ。機械は迷わないので困り度は聞かない)。

/** 目標の座標(goal をそのまま / goalName は子を含む AABB の中心)。分からなければ null。 */
export async function goalPosition(goal?: number[], goalName?: string): Promise<PlayVec3 | null> {
  if (Array.isArray(goal) && goal.length >= 3) return [goal[0], goal[1], goal[2]];
  if (!goalName) return null;
  const b = await engine.call("get_bounds", { name: goalName, includeChildren: true }).catch(() => null) as any;
  return Array.isArray(b?.center) ? [b.center[0], b.center[1], b.center[2]] : null;
}

/** プレイの判断段(Brief を読んで 1 往復)。例外は投げない。 */
export async function judgePlayFor(input: PlayInput): Promise<unknown> {
  const baseDir = await jevProjectBaseDir();
  const brief = baseDir ? readBrief(baseDir).brief : null;
  return judgePlay({ ...input, brief, askOptions: { baseDir } })
    .catch((e: any) => ({ source: "rules", reason: `判断段で想定外の失敗: ${e?.message ?? e}` }));
}

regRaw(
  "dx12_get_play_session",
  {
    title: "人間のプレイ記録を取る",
    description:
      "直近の Play 1 回ぶんの記録を返す。★dx12_play を押した時点で自動的に記録が始まる(開始ツールは無い)。Stop 後も次の Play まで残るので、人間に遊んでもらってから取りに来ればよい。返る形: {started, recording, durationSec, frames, fpsMin, summary:{errors,warnings,inputEvents,...}, events:[{t,kind,detail}], samples:[{t,fps,camPos,camYaw,camPitch,mouse}], judge?}。kind は key_down/key_up/pad_down/pad_up(操作) と error/warn/lua(ログ)。detail のキー名は dx12_key_press にそのまま渡せる。samples は 10Hz。★挙動のデバッグは AI が合成入力で動かすより、人間に遊ばせてこれを読む方が正確。"
      + "★judge は判断段: 区間ごとの事実(止まっていた割合・進もうとして動けない割合・行き来・落下・戻された回数・見回し・その場ジャンプ・ゴールへの進み)を言葉にして"
      + "作品の意図(dx12_brief)と一緒に Jev へ 1 往復で聞き、{source, confusion:{value(0..4), level, troubled}, cause:{id, label, hint, confidence}, words, uncertain[{id, why, look}], cost} を返す。"
      + "ホラーの慎重な歩きのように Brief が狙う振る舞いは困りごとに数えない。goal / goalName を渡すとゴールへの進みも数える。judge:false で止める。",
    inputSchema: {
      maxEvents: z.number().int().optional().describe("返すイベント数の上限(既定 400、最大 8000)。新しい方から残す。"),
      maxSamples: z.number().int().optional().describe("返すサンプル数の上限(既定 200、最大 4000)。新しい方から残す。"),
      goal: v3().optional().describe("判断段用: ゴールの座標(ゴールへの進みと残りの距離を数える)。"),
      goalName: z.string().optional().describe("判断段用: ゴールのエンティティ名(goal の代わり)。"),
      judge: z.boolean().optional().describe("false で判断段(Jev に Brief と照らして聞く段)を止める。既定 true。"),
    },
    outputSchema: OUT,
    annotations: { title: "人間のプレイ記録を取る", readOnlyHint: true, openWorldHint: true },
  },
  ({ maxEvents, maxSamples, goal, goalName, judge }) => run(async () => {
    const s = await engine.call("get_play_session", { maxEvents, maxSamples });
    if (judge === false || !s?.started) return s;
    // ★判断は間引いていない全体で数える(返す本体は従来どおり maxEvents / maxSamples で切ったもの)。
    const full = (maxEvents ?? 0) >= 8000 && (maxSamples ?? 0) >= 4000
      ? s : await engine.call("get_play_session", { maxEvents: 8000, maxSamples: 4000 });
    return { ...s, judge: await judgePlayFor(fromSession(full, await goalPosition(goal, goalName))) };
  }),
);

// ── 入力シミュレーション(Playing 中の挙動確認用)─────────────────
// Lua の input:isKeyDown/isKeyPressed(prelude の keyDown/keyPressed)に効く。
// GetAsyncKeyState を読む isAsyncKeyDown 系には効かない。エンジンウィンドウがフォーカスを
// 失うと合成キーはクリアされる(WM_KILLFOCUS)。

reg(
  "dx12_key_down",
  "キー押下(保持)",
  "キーを押した状態にする(key_up を呼ぶまで保持)。次フレーム以降の Lua input:isKeyDown / keyDown() が true になる。横移動など「押しっぱなし」の挙動確認に。key は VK 整数 or 名前(\"W\",\"D\",\"SPACE\",\"UP\" 等)。Playing 中に使う(isAsyncKeyDown 系には効かない)。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名(\"W\",\"SPACE\",\"UP\",\"F1\" 等)") },
  {},
  ({ key }) => run(() => engine.call("key_down", { key })),
);

reg(
  "dx12_key_up",
  "キー離す",
  "dx12_key_down で押したキーを離す。key は VK 整数 or 名前。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名") },
  {},
  ({ key }) => run(() => engine.call("key_up", { key })),
);

reg(
  "dx12_key_press",
  "キータップ(1フレーム)",
  "キーを1フレームだけ押して離す(isKeyPressed / keyPressed() が1回立つ)。ジャンプ(SPACE)などのタップ操作の確認に。key は VK 整数 or 名前。押しっぱなしにはならない。",
  { key: z.union([z.number().int(), z.string()]).describe("VK コード(int)か キー名(\"SPACE\" 等)") },
  {},
  ({ key }) => run(() => engine.call("key_press", { key })),
);

reg(
  "dx12_mouse_move",
  "マウス移動の注入",
  "合成マウス移動を【次の 1 フレームぶん】注入する。一人称の視点操作はこれが唯一の口: ★camera:setYaw() では向きを変えられない(エンジン標準の FpsController は yaw を Lua のローカル変数で持っていて、毎フレーム cam.transform.rotation を上書きするため)。視点はどのゲームでも input:getMouseDeltaX() から作るので、そこへ raw の移動量として乗せる。押しっぱなしの概念は無いので、回し続けるには step_frames と交互に撃つこと。感度はゲームごとに違うため、目標角度へ向けたいなら dx12_play_script の yaw / dx12_autoplay を使う方が確実(そちらは実測して比例で詰める閉ループになっている)。",
  {
    dx: z.number().optional().describe("水平の移動量(生のピクセル相当)。正で右回り(実装依存)。"),
    dy: z.number().optional().describe("垂直の移動量。正で下(実装依存)。"),
  },
  {},
  ({ dx, dy }) => run(() => engine.call("mouse_move", { dx: dx ?? 0, dy: dy ?? 0 })),
);
