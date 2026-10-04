// テストプレイ(決定論ステップ + 台本 + 断言 + 移動能力の実測)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { analyzePath, capabilityWarnings, compileTimeline, danglingKeys, evaluate, type Expectation, mouseDeltaForYaw, type MovementCapability, scriptDuration, type ScriptStep, type TraceSample, wrapDeg, yawTowards } from "../playtest.ts";
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import path from "node:path";
import fs from "node:fs";
import { pointsFromTrace } from "../jev/playJudge.ts";
import { engine, reg, run } from "./core.ts";
import { judgePlayFor } from "./play.ts";

// ════════════════════════════════════════════════════════════════
//  テストプレイ（決定論ステップ + 台本 + 断言 + 移動能力の実測）
// ════════════════════════════════════════════════════════════════

export const DEFAULT_DT = 1 / 60;

/** プレイヤーらしきエンティティを探す。characterController 持ちが最優先。 */
export async function findPlayerName(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const cc = await engine.call("list_entities", { component_type: "characterController" });
  if (cc?.entities?.length) return cc.entities[0].name;
  const all = await engine.call("list_entities", {});
  const byName = (all?.entities ?? []).find((e: any) => /player|プレイヤー/i.test(e.name));
  if (byName) return byName.name;
  throw new Error(
    "プレイヤーが見つからない。characterController を持つエンティティも 'Player' も無い。" +
    "player 引数で名前を指定すること");
}

/** 1 サンプル取る（位置 + 速度 + 接地 + カメラ yaw）。 */
export async function sampleState(name: string, t: number): Promise<TraceSample> {
  const e = await engine.call("get_entity", { name });
  const pos = e?.transform?.position ?? [0, 0, 0];
  const s: TraceSample = { t, pos: [pos[0], pos[1], pos[2]] };
  try {
    const phys = await engine.call("get_physics_state", { name });
    if (phys) {
      if (Array.isArray(phys.velocity)) s.vel = [phys.velocity[0], phys.velocity[1], phys.velocity[2]];
      if (typeof phys.isGrounded === "boolean") s.grounded = phys.isGrounded;
    }
  } catch { /* Editor 中など。位置だけで続ける */ }
  return s;
}

/**
 * アクティブなカメラの現在 yaw（度）を読む。
 * ★プレイヤーの Transform ではなくカメラを見る。一人称のコントローラは
 *   カメラの rotation に yaw を書くのが普通で、プレイヤー本体は回さないことが多い
 *   （エンジン標準の FpsController がまさにそれ）。
 */
async function readCameraYaw(): Promise<{ name: string; yaw: number } | null> {
  const cams = await engine.call("list_entities", { component_type: "camera" });
  for (const c of cams?.entities ?? []) {
    try {
      const e = await engine.call("get_entity", { name: c.name });
      if (e?.camera && e.camera.isActive === false) continue;
      const rot = e?.transform?.rotation;
      if (Array.isArray(rot)) return { name: c.name, yaw: rot[1] };
    } catch { /* 次のカメラ */ }
  }
  return null;
}

/**
 * マウス移動を注入して、カメラを目標 yaw へ向ける。
 *
 * ★`camera:setYaw()` では向けられない。エンジン標準の FpsController は yaw を
 *   **Lua のローカル変数**で持っていて、毎フレーム `cam.transform.rotation` を
 *   その値で上書きするため、外から書いても次のフレームで戻される（実測で確認）。
 *   視点はどのゲームでも `input:getMouseDeltaX()` から作るので、そこへ注入するのが唯一の道。
 *
 * 感度はゲームごとに違ううえ外から読めないので、**少し回して測ってから比例で詰める**
 * 閉ループにしてある。measured を持ち回せば 2 回目以降は 1〜2 フレームで合う。
 */
export async function faceYaw(
  targetYaw: number,
  dt: number,
  state: { degPerPixel: number | null },
  toleranceDeg = 2,
  maxIters = 8,
): Promise<{ ok: boolean; finalYaw: number | null; iters: number }> {
  let cam = await readCameraYaw();
  if (!cam) return { ok: false, finalYaw: null, iters: 0 };

  for (let i = 0; i < maxIters; i++) {
    const err = wrapDeg(targetYaw - cam.yaw);
    if (Math.abs(err) <= toleranceDeg) return { ok: true, finalYaw: cam.yaw, iters: i };

    const dx = mouseDeltaForYaw(cam.yaw, targetYaw, state.degPerPixel);
    const before = cam.yaw;
    await engine.call("mouse_move", { dx, dy: 0 });
    await engine.call("step_frames", { frames: 1, deterministic: true, dt });
    const after = await readCameraYaw();
    if (!after) return { ok: false, finalYaw: null, iters: i + 1 };

    // 実際に何度回ったかから感度を測り直す（最初の 1 回が校正を兼ねる）
    const moved = wrapDeg(after.yaw - before);
    if (Math.abs(dx) > 1e-3 && Math.abs(moved) > 1e-3) state.degPerPixel = moved / dx;
    cam = after;
  }
  return { ok: Math.abs(wrapDeg(targetYaw - cam.yaw)) <= toleranceDeg * 2, finalYaw: cam.yaw, iters: maxIters };
}

/** 押しっぱなしのキーを全部離す（次のテストへ入力を漏らさない）。 */
export async function releaseAll(keys: string[]): Promise<void> {
  for (const k of keys) { try { await engine.call("key_up", { key: k }); } catch { /* 無視 */ } }
}

reg(
  "dx12_play_script",
  "台本プレイ(決定論)",
  "入力タイムラインと合否条件を 1 コールで走らせる。★dt を 1/60 に固定して進めるので【同じ台本なら毎回同じ結果】になる(実時間 dt だと同じ入力・同じフレーム数でも進む距離が変わり、ジャンプが届いたり届かなかったりする)。key_down→step_frames→get_entity を数十往復する従来のやり方の置き換え。steps は {t 秒, down/up/press キー, yaw 度} の配列。yaw(度) はマウス移動の注入で合わせる(★camera:setYaw では向けられない。エンジン標準の FpsController は yaw を Lua のローカル変数で持っていて毎フレーム上書きするため)。感度はゲームごとに違うので『少し回して測ってから比例で詰める』閉ループで合わせる。+Z が前、右回りが正。expect は {at|by 秒, near:[x,y,z]+radius, yAbove, yBelow, grounded, movedAtLeast} で、落ちたら『最接近 2.3m』のように【どれだけ足りなかったか】が返る。走行後は押しっぱなしのキーを必ず離す。返り値 {pass, results[], trace[], durationSec}。",
  {
    steps: z.array(z.object({
      t: z.number().describe("Play 開始からの秒。"),
      down: z.union([z.string(), z.array(z.string())]).optional().describe("押しっぱなしにするキー。"),
      up: z.union([z.string(), z.array(z.string())]).optional().describe("離すキー。"),
      press: z.union([z.string(), z.array(z.string())]).optional().describe("1 フレームだけ押す。"),
      yaw: z.number().optional().describe("カメラの yaw(度)。+Z が前、右回りが正。"),
      note: z.string().optional(),
    })).describe("入力タイムライン。順不同でよい。"),
    expect: z.array(z.object({
      at: z.number().optional().describe("この時刻ちょうどで満たすこと。"),
      by: z.number().optional().describe("この時刻までのどこかで満たせばよい。"),
      near: v3().optional().describe("この座標の radius 以内に居ること。"),
      radius: z.number().optional(),
      yAbove: z.number().optional(),
      yBelow: z.number().optional(),
      grounded: z.boolean().optional(),
      movedAtLeast: z.number().optional().describe("開始位置からの水平移動距離(m)。"),
      label: z.string().optional(),
    })).optional().describe("合否条件。省略すると trace だけ返す。"),
    player: z.string().optional().describe("追跡するエンティティ名。省略で characterController 持ちを自動選択。"),
    until: z.number().optional().describe("走行時間(秒)。省略で台本の最終指示 + 1 秒。"),
    sampleHz: z.number().optional().describe("トレースの取得頻度(既定 10Hz)。"),
    dt: z.number().optional().describe("固定 dt(既定 1/60)。"),
    autoPlay: z.boolean().optional().describe("Editor なら自動で Play する(既定 true)。"),
  },
  { destructiveHint: false },
  ({ steps, expect, player, until, sampleHz, dt, autoPlay }) =>
    run(async () => {
      const step = dt ?? DEFAULT_DT;
      const hz = sampleHz ?? 10;
      const total = until ?? scriptDuration(steps as ScriptStep[]) + 1;
      const name = await findPlayerName(player);

      const mode = await engine.call("get_mode", {});
      if (mode?.mode !== "Playing") {
        if (autoPlay === false) throw new Error("Playing でない。先に dx12_play するか autoPlay:true にする");
        await engine.call("play", {});
      }

      const events = compileTimeline(steps as ScriptStep[], step);
      const totalFrames = Math.ceil(total / step);
      const framesPerSample = Math.max(1, Math.round(1 / (hz * step)));

      const trace: TraceSample[] = [];
      const look = { degPerPixel: null as number | null };
      const yawNotes: string[] = [];
      let frame = 0;
      let ei = 0;
      trace.push(await sampleState(name, 0));

      while (frame < totalFrames) {
        // このフレームに来ている指示を全部適用する
        while (ei < events.length && events[ei].frame <= frame) {
          const ev = events[ei++];
          for (const k of ev.downs) await engine.call("key_down", { key: k });
          for (const k of ev.ups) await engine.call("key_up", { key: k });
          for (const k of ev.presses) await engine.call("key_press", { key: k });
          if (ev.yaw != null) {
            const r = await faceYaw(ev.yaw, step, look);
            if (!r.ok)
              yawNotes.push(
                `t=${ev.t.toFixed(2)}s: yaw ${ev.yaw} へ向けきれなかった` +
                (r.finalYaw == null
                  ? "（アクティブなカメラが見つからない）"
                  : `（実際は ${r.finalYaw.toFixed(1)} 度で止まった）`));
          }
        }
        // 次の指示かサンプル境界のどちらか早い方まで進める
        const nextEvent = ei < events.length ? events[ei].frame : totalFrames;
        const nextSample = frame + framesPerSample;
        const to = Math.min(nextEvent, nextSample, totalFrames);
        const n = Math.max(1, to - frame);
        await engine.call("step_frames", { frames: n, deterministic: true, dt: step });
        frame += n;
        trace.push(await sampleState(name, frame * step));
      }

      await releaseAll(danglingKeys(steps as ScriptStep[]));

      const results = expect?.length ? evaluate(trace, expect as Expectation[]) : [];
      const pass = results.every((r) => r.pass);
      const out: Record<string, unknown> = {
        pass, player: name, durationSec: frame * step, dt: step,
        results, trace, samples: trace.length,
        ...(look.degPerPixel != null ? { mouseDegPerPixel: Number(look.degPerPixel.toFixed(4)) } : {}),
        ...(yawNotes.length ? { yawWarnings: yawNotes } : {}),
      };
      if (!pass) out.next = "落ちた条件の detail に『どれだけ足りなかったか』が入っている。" +
                            "配置が原因なら dx12_validate_layout、操作が原因なら台本の yaw / タイミングを疑う";
      return out;
    }),
);

reg(
  "dx12_measure_player",
  "移動能力の実測",
  "プレイヤーを実際に歩かせ・跳ばせて【歩行速度 / ジャンプ高 / ジャンプ距離】を測る。characterController の宣言値(stepHeight / maxSlopeDeg)も一緒に返す。★ここで測った値が dx12_check_reachable の判定根拠になる。宣言値ではなく実測なのは、移動そのものは Lua が実装していてコンポーネントの値と一致しないため。結果は <project>/.dx12/movement.json に保存し、次回から使い回せる。{walkSpeed, jumpHeight, jumpDistance, stepHeight, maxSlopeDeg, warnings}。",
  {
    player: z.string().optional().describe("プレイヤーのエンティティ名。省略で自動選択。"),
    forwardKey: z.string().optional().describe("前進キー(既定 W)。"),
    jumpKey: z.string().optional().describe("ジャンプキー(既定 SPACE)。"),
    save: z.boolean().optional().describe("false で .dx12/movement.json に保存しない。"),
  },
  { destructiveHint: false },
  ({ player, forwardKey, jumpKey, save }) =>
    run(async () => {
      const fwd = forwardKey ?? "W";
      const jmp = jumpKey ?? "SPACE";
      const name = await findPlayerName(player);
      const dt = DEFAULT_DT;

      const mode = await engine.call("get_mode", {});
      if (mode?.mode !== "Playing") await engine.call("play", {});
      await engine.call("step_frames", { frames: 30, deterministic: true, dt });

      const measure = async (fn: () => Promise<void>, sec: number) => {
        const before = await sampleState(name, 0);
        const samples: TraceSample[] = [before];
        await fn();
        const frames = Math.ceil(sec / dt);
        const chunk = Math.max(1, Math.round(frames / 20));
        for (let f = 0; f < frames; f += chunk) {
          await engine.call("step_frames", { frames: Math.min(chunk, frames - f), deterministic: true, dt });
          samples.push(await sampleState(name, (f + chunk) * dt));
        }
        return samples;
      };

      // ① 歩行速度: 前進 1 秒の水平距離
      const walk = await measure(async () => { await engine.call("key_down", { key: fwd }); }, 1.0);
      await engine.call("key_up", { key: fwd });
      const w0 = walk[0].pos, w1 = walk[walk.length - 1].pos;
      const walkSpeed = Math.hypot(w1[0] - w0[0], w1[2] - w0[2]);
      await engine.call("step_frames", { frames: 30, deterministic: true, dt });

      // ② ジャンプ高: その場で跳んで最高到達 - 開始 y
      const jump = await measure(async () => { await engine.call("key_press", { key: jmp }); }, 1.5);
      const baseY = jump[0].pos[1];
      const jumpHeight = Math.max(0, Math.max(...jump.map((s) => s.pos[1])) - baseY);
      await engine.call("step_frames", { frames: 30, deterministic: true, dt });

      // ③ ジャンプ距離: 走りながら跳んで、接地するまでの水平距離
      const start = await sampleState(name, 0);
      await engine.call("key_down", { key: fwd });
      await engine.call("step_frames", { frames: 20, deterministic: true, dt });
      const liftoff = await sampleState(name, 0);
      await engine.call("key_press", { key: jmp });
      let landed = liftoff;
      for (let f = 0; f < Math.ceil(2.0 / dt); f += 6) {
        await engine.call("step_frames", { frames: 6, deterministic: true, dt });
        const s = await sampleState(name, 0);
        landed = s;
        if (s.grounded === true && f > 12) break;      // 跳び上がってから再接地したら終わり
      }
      await engine.call("key_up", { key: fwd });
      const jumpDistance = Math.hypot(landed.pos[0] - liftoff.pos[0], landed.pos[2] - liftoff.pos[2]);

      // 宣言値（characterController）は実測できないものだけ拾う
      let stepHeight = 0.3, maxSlopeDeg = 50;
      try {
        const ent = await engine.call("get_entity", { name });
        const cc = ent?.characterController;
        if (cc) {
          if (typeof cc.stepHeight === "number") stepHeight = cc.stepHeight;
          if (typeof cc.maxSlopeDeg === "number") maxSlopeDeg = cc.maxSlopeDeg;
        }
      } catch { /* 無ければ既定値 */ }

      const cap: MovementCapability = {
        walkSpeed, jumpHeight, jumpDistance, stepHeight, maxSlopeDeg,
        measuredAt: new Date().toISOString(),
        note: `player=${name} forward=${fwd} jump=${jmp}`,
      };
      const warnings = capabilityWarnings(cap);

      let savedTo: string | undefined;
      if (save !== false) {
        try {
          const ping = await engine.call("ping", {});
          const dir = path.join(ping.baseDir, ".dx12");
          await fs.promises.mkdir(dir, { recursive: true });
          savedTo = path.join(dir, "movement.json");
          await fs.promises.writeFile(savedTo, JSON.stringify(cap, null, 2), "utf8");
        } catch (e) { warnings.push(`movement.json を保存できなかった: ${(e as Error).message}`); }
      }
      return { ...cap, warnings, savedTo, startPos: start.pos };
    }),
);

reg(
  "dx12_check_reachable",
  "到達性の検査",
  "ナビメッシュの経路と【実測した移動能力】で『そこへ行けるか』を判定する。Play しないので何度でも撃てる。経路が無ければその旨、あれば各区間の登り・隙間を移動能力と突き合わせて『LVL_Platform_07 まで水平 6.2m の跳び越しが要る。実測のジャンプ距離 4.1m では届かない』のように名指しで返す。★先に dx12_measure_player を撃つこと(実測値が無ければ .dx12/movement.json を読み、それも無ければ保守的な既定値を使い warning を出す)。ナビメッシュが無ければ dx12_navmesh_build。{reachable, pathPoints, issues[], capability}。",
  {
    from: v3().optional().describe("開始座標。省略でプレイヤーの現在地。"),
    fromName: z.string().optional().describe("開始エンティティ名。"),
    to: v3().optional().describe("目標座標。"),
    toName: z.string().optional().describe("目標エンティティ名(ゴール・鍵・コイン等)。"),
  },
  { readOnlyHint: true },
  ({ from, fromName, to, toName }) =>
    run(async () => {
      const warnings: string[] = [];
      const posOf = async (name: string): Promise<[number, number, number]> => {
        const b = await engine.call("get_bounds", { name, includeChildren: true });
        if (b?.center) return [b.center[0], b.center[1], b.center[2]];
        const e = await engine.call("get_entity", { name });
        const p = e?.transform?.position ?? [0, 0, 0];
        return [p[0], p[1], p[2]];
      };
      let start: [number, number, number];
      if (from) start = [from[0], from[1], from[2]];
      else start = await posOf(fromName ?? (await findPlayerName()));
      if (!to && !toName) throw new Error("to か toName のどちらかが要る");
      const goal: [number, number, number] = to ? [to[0], to[1], to[2]] : await posOf(toName!);

      // 移動能力: 実測 → 保存値 → 保守的な既定
      let cap: MovementCapability = {
        walkSpeed: 4, jumpHeight: 1.0, jumpDistance: 3.0, stepHeight: 0.3, maxSlopeDeg: 50,
      };
      try {
        const ping = await engine.call("ping", {});
        const raw = await fs.promises.readFile(path.join(ping.baseDir, ".dx12", "movement.json"), "utf8");
        cap = { ...cap, ...JSON.parse(raw) };
      } catch {
        warnings.push("移動能力の実測値が無いので保守的な既定値を使っている。" +
                      "dx12_measure_player を先に撃つと判定が正確になる");
      }

      // ★統計は stats の下。エンジンの navmesh_info は {config, stats, debugDraw} を返す。
      const info = await engine.call("navmesh_info", {});
      const stats = info?.stats ?? {};
      if (stats.built === false || (stats.polyCount ?? 0) === 0)
        return { reachable: false, warnings,
                 reason: "ナビメッシュが焼かれていない。先に dx12_navmesh_build を撃つこと",
                 capability: cap };

      // ★引数名は from / to（start / end ではない）。points で返る。
      const pathRes = await engine.call("navmesh_path", { from: start, to: goal });
      const pts: [number, number, number][] =
        (pathRes?.points ?? []).map((p: number[]) => [p[0], p[1], p[2]]);
      if (!pts.length)
        return {
          reachable: false, warnings, capability: cap, start, goal,
          reason: "ナビメッシュ上に経路が無い。歩いて行ける床が繋がっていない" +
                  "(穴・段差・ナビメッシュの焼き漏れのどれか)",
          next: "dx12_navmesh_debug で焼けている面を見るか、間の足場を置き直すこと",
        };
      // ★reached=false は「目標へ行けないので一番近い所までを返した」意味。
      //   これを見ないと、途中で切れた経路を「通れる」と誤って報告する。
      if (pathRes?.reached === false)
        return {
          reachable: false, warnings, capability: cap, start, goal, pathPoints: pts,
          reason: "経路が目標まで届いていない（navmesh の reached=false）。" +
                  `一番近づけるのは [${pts[pts.length - 1].map((n) => n.toFixed(1)).join(",")}] まで`,
          next: "そこから先が段差・隙間・未生成のどれかで分断されている。" +
                "dx12_navmesh_debug で焼けている面を見ること",
        };

      const issues = analyzePath(pts, cap);
      let length = 0;
      for (let i = 0; i + 1 < pts.length; i++)
        length += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][2] - pts[i][2]);
      return {
        reachable: issues.length === 0, warnings, capability: cap, start, goal,
        pathPoints: pts, pathLength: Number(length.toFixed(2)), issues,
        estimatedWalkSec: cap.walkSpeed > 0 ? Number((length / cap.walkSpeed).toFixed(1)) : null,
        ...(issues.length ? { next: "issues の区間に足場を足すか、隙間を詰めること" } : {}),
      };
    }),
);

reg(
  "dx12_autoplay",
  "自動走破(クリアできるかの実証)",
  "ナビメッシュの経路を【実際の入力】でなぞって、本当にゴールへ行けるかを確かめる。経路点ごとにマウス移動を注入してカメラを向け、前進キーを押す(このエンジンのテンプレートはカメラ相対 WASD)。詰まったら少し跳んで、それでも進まなければ『どこで詰まったか』を座標付きで返す。★これは dx12_check_reachable(静的判定)の実証版。静的に通っても実際は詰まる(見えない当たり判定・傾斜・キャラの幅)ことがあるので、クリア可能を主張する前にこれを通すこと。{cleared, stuckAt, progress, trace[]}。",
  {
    goal: v3().optional().describe("目標座標。"),
    goalName: z.string().optional().describe("目標エンティティ名。"),
    player: z.string().optional(),
    forwardKey: z.string().optional().describe("前進キー(既定 W)。"),
    jumpKey: z.string().optional().describe("ジャンプキー(既定 SPACE)。"),
    arriveRadius: z.number().optional().describe("到達とみなす距離(既定 1.5m)。"),
    timeoutSec: z.number().optional().describe("打ち切り時間(既定 60 秒ぶんのシミュレーション)。"),
    judge: z.boolean().optional().describe("false で判断段(届かなかった原因を Jev に聞く段)を止める。既定 true。"),
  },
  { destructiveHint: false },
  ({ goal, goalName, player, forwardKey, jumpKey, arriveRadius, timeoutSec, judge }) =>
    run(async () => {
      const fwd = forwardKey ?? "W";
      const jmp = jumpKey ?? "SPACE";
      const radius = arriveRadius ?? 1.5;
      const limit = timeoutSec ?? 60;
      const dt = DEFAULT_DT;
      const name = await findPlayerName(player);

      const posOf = async (n: string): Promise<[number, number, number]> => {
        const b = await engine.call("get_bounds", { name: n, includeChildren: true });
        return [b.center[0], b.center[1], b.center[2]];
      };
      if (!goal && !goalName) throw new Error("goal か goalName のどちらかが要る");
      const target: [number, number, number] = goal ? [goal[0], goal[1], goal[2]] : await posOf(goalName!);

      const mode = await engine.call("get_mode", {});
      if (mode?.mode !== "Playing") await engine.call("play", {});
      await engine.call("step_frames", { frames: 30, deterministic: true, dt });

      const here = await sampleState(name, 0);
      // ★引数名は from / to。返りは points で、reached=false なら途中までの折れ線。
      let pathRes: any = null;
      try { pathRes = await engine.call("navmesh_path", { from: here.pos, to: target }); }
      catch { /* ナビメッシュ未生成。直進で試す */ }
      let waypoints: [number, number, number][] =
        (pathRes?.points ?? []).map((p: number[]) => [p[0], p[1], p[2]]);
      if (!waypoints.length) waypoints = [target];   // ナビメッシュが無くても直進は試す
      const pathReached = pathRes?.reached !== false;

      const trace: TraceSample[] = [here];
      const look = { degPerPixel: null as number | null };
      const notes: string[] = [];
      if (!pathReached)
        notes.push("ナビメッシュの経路が目標まで届いていない（reached=false）。" +
                   "最後の点まで行っても届かない見込み。dx12_check_reachable で原因を見ること");
      let yawFailed = false;
      let t = 0;
      let wi = 0;
      let stuckFor = 0;
      // ★last は位置の配列ではなくサンプル(下で last.pos を読む)。以前は here.pos を入れていて、
      //   最初の 1 歩で last.pos[0] が undefined になり autoplay が必ず例外で落ちていた(e2e で発覚)。
      let last = here;
      await engine.call("key_down", { key: fwd });
      try {
        while (t < limit && wi < waypoints.length) {
          const wp = waypoints[wi];
          const cur = await sampleState(name, t);
          const d = Math.hypot(cur.pos[0] - wp[0], cur.pos[2] - wp[2]);
          if (d < radius) { wi++; stuckFor = 0; continue; }

          const face = await faceYaw(yawTowards(cur.pos, wp), dt, look);
          if (!face.ok && !yawFailed) {
            yawFailed = true;
            notes.push("カメラを目標方向へ向けきれなかった。" +
                       "一人称でない / カメラが非アクティブ / 視点がマウス以外で作られている可能性");
          }
          await engine.call("step_frames", { frames: 12, deterministic: true, dt });
          t += 12 * dt;
          const after = await sampleState(name, t);
          trace.push(after);

          const moved = Math.hypot(after.pos[0] - last.pos[0], after.pos[2] - last.pos[2]);
          last = after;
          if (moved < 0.05) {
            stuckFor += 12 * dt;
            // 段差かもしれないので跳んでみる
            if (stuckFor > 0.4) { await engine.call("key_press", { key: jmp }); }
            if (stuckFor > 3.0) {
              await engine.call("key_up", { key: fwd });
              const stuck = {
                cleared: false, player: name, goal: target, notes,
                stuckAt: after.pos, stuckAtWaypoint: wi, waypoints, trace,
                elapsedSec: Number(t.toFixed(2)),
                reason: `[${after.pos.map((n) => n.toFixed(1)).join(",")}] で 3 秒進めなくなった`,
                next: "その座標を dx12_screenshot_from で見る。壁・段差・隙間のどれかが塞いでいる。" +
                      "dx12_check_reachable で区間の登り/隙間も確認できる",
              };
              // 判断段: なぜ詰まったか(原因だけ。機械は迷わないので困り度は聞かない)
              if (judge === false) return stuck;
              return { ...stuck, judge: await judgePlayFor({ kind: "autoplay", points: pointsFromTrace(trace), goal: target, cleared: false }) };
            }
          } else stuckFor = 0;
        }
      } finally {
        await engine.call("key_up", { key: fwd });
      }

      const end = await sampleState(name, t);
      const remain = Math.hypot(end.pos[0] - target[0], end.pos[2] - target[2]);
      const cleared = remain < radius;
      const result = {
        cleared, player: name, goal: target, finalPos: end.pos, notes,
        remainingDistance: Number(remain.toFixed(2)),
        waypointsReached: wi, waypoints: waypoints.length, trace,
        elapsedSec: Number(t.toFixed(2)),
        ...(cleared ? {} : { reason: `打ち切り(${limit}s)までにゴールへ届かなかった`,
                             next: "timeoutSec を伸ばすか、dx12_check_reachable で経路の問題を見る" }),
      };
      // 判断段は届かなかったときだけ(届いたなら説明することが無い)
      if (judge === false || cleared) return result;
      return { ...result, judge: await judgePlayFor({ kind: "autoplay", points: pointsFromTrace(trace), goal: target, cleared }) };
    }),
);
