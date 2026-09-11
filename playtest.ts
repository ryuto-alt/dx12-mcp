/**
 * テストプレイの台本・断言・移動能力（純関数）。
 *
 * なぜ要るか（2026-09-10 にユーザーと合意）:
 *   合成入力で AI が自分で遊んで確かめる方法には限界がある。人間と同じ操作はできないし、
 *   `key_down → step_frames → get_entity` を数十往復すると遅いうえ、**各フレームの dt が
 *   実時間**なので同じ台本を流しても毎回結果が変わる（ジャンプが届いたり届かなかったりする）。
 *
 *   そこで 3 つに分けた:
 *     ① 決定論ステップ … dx12_step_frames(deterministic:true) で dt を 1/60 に固定（エンジン側）
 *     ② 台本 + 断言   … 入力タイムラインと合否条件を 1 コールで流す（この file の compile/evaluate）
 *     ③ 移動能力の実測 … 実際に歩かせ跳ばせて速度・跳躍高・跳躍距離を測る（measure* / analyze*）
 *   ③の実測値があって初めて「この隙間は跳べない」を**静的に**言えるようになる。
 *
 * ここには I/O を持たない。エンジンを叩く部分は index.ts 側。
 */

// ─── 台本 ────────────────────────────────────────────────────────────────

export interface ScriptStep {
  /** Play 開始からの秒。昇順でなくてよい（ここで並べ替える） */
  t: number;
  /** 押しっぱなしにするキー */
  down?: string | string[];
  /** 離すキー */
  up?: string | string[];
  /** 1 フレームだけ押す（isKeyPressed が 1 回立つ） */
  press?: string | string[];
  /** カメラの yaw（度）。一人称の向き変更はマウス注入が無いのでここで指定する */
  yaw?: number;
  /** ログに残すメモ */
  note?: string;
}

export interface CompiledEvent {
  frame: number;
  t: number;
  downs: string[];
  ups: string[];
  presses: string[];
  yaw?: number;
  note?: string;
}

const asArray = (v?: string | string[]): string[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

/**
 * 台本をフレーム番号に落とす。同じフレームに落ちた指示はまとめる。
 * ★時刻→フレームは floor ではなく round。0.05 秒を dt=1/60 で floor すると 2 フレーム目に
 *   なり、「0.05 秒に押した」つもりが 0.0333 秒になる。round なら最も近いフレームに乗る。
 */
export function compileTimeline(steps: ScriptStep[], dt: number): CompiledEvent[] {
  if (!(dt > 0)) throw new Error("dt must be > 0");
  const byFrame = new Map<number, CompiledEvent>();
  for (const s of steps) {
    if (!Number.isFinite(s.t) || s.t < 0) throw new Error(`step.t が不正: ${s.t}`);
    const frame = Math.round(s.t / dt);
    let e = byFrame.get(frame);
    if (!e) {
      e = { frame, t: frame * dt, downs: [], ups: [], presses: [] };
      byFrame.set(frame, e);
    }
    e.downs.push(...asArray(s.down));
    e.ups.push(...asArray(s.up));
    e.presses.push(...asArray(s.press));
    if (s.yaw != null) e.yaw = s.yaw;
    if (s.note) e.note = e.note ? `${e.note} / ${s.note}` : s.note;
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** 台本の最後の指示が終わる時刻。until 未指定のときの既定の走行時間に使う。 */
export function scriptDuration(steps: ScriptStep[]): number {
  return steps.reduce((m, s) => Math.max(m, s.t), 0);
}

/** 台本が押しっぱなしにしたまま終わるキー（走行後に必ず離す＝次のテストへ漏らさない）。 */
export function danglingKeys(steps: ScriptStep[]): string[] {
  const held = new Set<string>();
  for (const s of [...steps].sort((a, b) => a.t - b.t)) {
    for (const k of asArray(s.down)) held.add(k.toUpperCase());
    for (const k of asArray(s.up)) held.delete(k.toUpperCase());
  }
  return [...held];
}

// ─── トレースと断言 ──────────────────────────────────────────────────────

export interface TraceSample {
  t: number;
  pos: [number, number, number];
  vel?: [number, number, number];
  grounded?: boolean;
  yaw?: number;
}

export interface Expectation {
  /** この時刻**ちょうど**（最も近いサンプル）で満たすこと */
  at?: number;
  /** この時刻**までのどこか**で満たせばよい（既定。省略時は走行全体） */
  by?: number;
  /** 指定座標の radius 以内に居ること */
  near?: [number, number, number];
  radius?: number;
  /** y がこの値より上 / 下 */
  yAbove?: number;
  yBelow?: number;
  /** 接地しているか */
  grounded?: boolean;
  /** 開始位置からの水平移動距離がこの値以上 */
  movedAtLeast?: number;
  /** 人が読むためのラベル */
  label?: string;
}

export interface ExpectResult {
  label: string;
  pass: boolean;
  /** 満たした時刻（by 条件のとき） */
  atT?: number;
  detail: string;
}

const dist2 = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[2] - b[2]);
const dist3 = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function describe(e: Expectation): string {
  if (e.label) return e.label;
  const parts: string[] = [];
  if (e.near) parts.push(`[${e.near.map((n) => n.toFixed(1)).join(",")}] の ${e.radius ?? 1}m 以内`);
  if (e.yAbove != null) parts.push(`y > ${e.yAbove}`);
  if (e.yBelow != null) parts.push(`y < ${e.yBelow}`);
  if (e.grounded != null) parts.push(e.grounded ? "接地している" : "接地していない");
  if (e.movedAtLeast != null) parts.push(`${e.movedAtLeast}m 以上動く`);
  const when = e.at != null ? `t=${e.at}s で` : e.by != null ? `t=${e.by}s までに` : "走行中どこかで";
  return `${when} ${parts.join(" かつ ") || "（条件なし）"}`;
}

function satisfies(s: TraceSample, e: Expectation, origin: [number, number, number]): boolean {
  if (e.near && dist3(s.pos, e.near) > (e.radius ?? 1)) return false;
  if (e.yAbove != null && !(s.pos[1] > e.yAbove)) return false;
  if (e.yBelow != null && !(s.pos[1] < e.yBelow)) return false;
  if (e.grounded != null && s.grounded !== e.grounded) return false;
  if (e.movedAtLeast != null && dist2(s.pos, origin) < e.movedAtLeast) return false;
  return true;
}

/**
 * トレースに対して断言を評価する。
 * `at` は「その時刻に最も近いサンプル 1 点」、`by`（と省略時）は「その時刻までのどれか 1 点」。
 */
export function evaluate(trace: TraceSample[], expectations: Expectation[]): ExpectResult[] {
  if (trace.length === 0)
    return expectations.map((e) => ({ label: describe(e), pass: false, detail: "サンプルが 1 点も無い" }));
  const origin = trace[0].pos;

  return expectations.map((e) => {
    const label = describe(e);
    if (e.at != null) {
      let best = trace[0];
      for (const s of trace) if (Math.abs(s.t - e.at) < Math.abs(best.t - e.at)) best = s;
      const ok = satisfies(best, e, origin);
      return {
        label, pass: ok, atT: best.t,
        detail: ok
          ? `t=${best.t.toFixed(2)}s で満たした`
          : `t=${best.t.toFixed(2)}s の実測は pos=[${best.pos.map((n) => n.toFixed(2)).join(",")}]` +
            (best.grounded != null ? ` grounded=${best.grounded}` : ""),
      };
    }
    const limit = e.by ?? Infinity;
    for (const s of trace) {
      if (s.t > limit) break;
      if (satisfies(s, e, origin)) return { label, pass: true, atT: s.t, detail: `t=${s.t.toFixed(2)}s で満たした` };
    }
    // 落ちた理由を具体的に出す（「一番惜しかった点」を添える）
    const inWindow = trace.filter((s) => s.t <= limit);
    let hint = "";
    if (e.near && inWindow.length) {
      let best = inWindow[0];
      for (const s of inWindow) if (dist3(s.pos, e.near) < dist3(best.pos, e.near)) best = s;
      hint = `最接近は t=${best.t.toFixed(2)}s で ${dist3(best.pos, e.near).toFixed(2)}m`;
    } else if (e.yAbove != null && inWindow.length) {
      const top = inWindow.reduce((m, s) => (s.pos[1] > m.pos[1] ? s : m), inWindow[0]);
      hint = `最高到達は t=${top.t.toFixed(2)}s の y=${top.pos[1].toFixed(2)}`;
    } else if (e.movedAtLeast != null && inWindow.length) {
      const far = inWindow.reduce((m, s) => (dist2(s.pos, origin) > dist2(m.pos, origin) ? s : m), inWindow[0]);
      hint = `最大移動は ${dist2(far.pos, origin).toFixed(2)}m`;
    }
    return { label, pass: false, detail: hint || "一度も満たさなかった" };
  });
}

// ─── 移動能力（実測値）と到達性 ──────────────────────────────────────────

export interface MovementCapability {
  /** 水平移動速度 m/s */
  walkSpeed: number;
  /** ジャンプの最高到達高さ m（足元基準） */
  jumpHeight: number;
  /** 走りながら跳んだときの水平到達距離 m */
  jumpDistance: number;
  /** 登れる段差 m（characterController.stepHeight） */
  stepHeight: number;
  /** 登れる斜面 度 */
  maxSlopeDeg: number;
  measuredAt?: string;
  note?: string;
}

/** ジャンプの高さから跳べる隙間の目安を出す。安全率を掛けて「跳べる」と言い切らない。 */
export const JUMP_SAFETY = 0.85;

export interface GapIssue {
  fromIndex: number;
  /** 水平距離 m */
  gap: number;
  /** 高低差 m（正 = 登り） */
  rise: number;
  reason: string;
}

/**
 * 経路の各区間が移動能力で越えられるかを見る。
 * navmesh の経路は「歩ける面」の上しか通らないので、**経路が途切れた所**（＝穴・段差）と、
 * 経路点どうしの高低差が能力を超えている所を拾う。
 */
export function analyzePath(
  points: [number, number, number][],
  cap: MovementCapability,
): GapIssue[] {
  const issues: GapIssue[] = [];
  const maxGap = cap.jumpDistance * JUMP_SAFETY;
  const maxRise = Math.max(cap.stepHeight, cap.jumpHeight * JUMP_SAFETY);
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const gap = dist2(a, b);
    const rise = b[1] - a[1];
    if (rise > maxRise)
      issues.push({
        fromIndex: i, gap, rise,
        reason: `${rise.toFixed(2)}m の登りがある。実測のジャンプ高 ${cap.jumpHeight.toFixed(2)}m ` +
                `(安全率込み ${maxRise.toFixed(2)}m) では登れない`,
      });
    // 大きく落ちる区間は「落ちたら戻れない」= 一方通行の警告
    if (rise < -Math.max(3, cap.jumpHeight * 3))
      issues.push({
        fromIndex: i, gap, rise,
        reason: `${(-rise).toFixed(2)}m 落下する区間。落ちたら自力で戻れない（詰みになりうる）`,
      });
    if (gap > maxGap && Math.abs(rise) > 0.1)
      issues.push({
        fromIndex: i, gap, rise,
        reason: `水平 ${gap.toFixed(2)}m の跳び越しが要る。実測のジャンプ距離 ` +
                `${cap.jumpDistance.toFixed(2)}m (安全率込み ${maxGap.toFixed(2)}m) では届かない`,
      });
  }
  return issues;
}

/**
 * 経路点を追いかけるためのカメラ yaw（度）を出す。
 * このエンジンの一人称テンプレートは「カメラの向き基準で WASD が動く」ので、
 * yaw を目標へ向けて W を押しっぱなしにすれば経路をなぞれる。
 * ★マウス注入が無いので、向きは Lua の camera:setYaw で与えるしかない。
 *
 * yaw の定義はエンジンに合わせる: +Z が前、右回りが正（degrees）。
 */
export function yawTowards(from: [number, number, number], to: [number, number, number]): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}

/** 角度差を -180..180 に畳む（359 度と 1 度の差を 2 度と見る）。 */
export function wrapDeg(a: number): number {
  let d = ((a + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * 目標 yaw へ向けるのに必要なマウス移動量を出す。
 *
 * ★感度は分からない前提で組む。ゲームごとに sens も反転も違ううえ、
 *   エンジン標準の FpsController は yaw を **Lua のローカル変数**で持っていて
 *   外から読めない。なので「少し回して、どれだけ変わったか測って、比例で詰める」
 *   閉ループにする（1 回の呼び出しで決めない）。
 *
 * degPerPixel が未知(null)のときは probe 量を返し、呼び出し側が実測して次から使う。
 */
export function mouseDeltaForYaw(
  currentYaw: number,
  targetYaw: number,
  degPerPixel: number | null,
  probePixels = 120,
): number {
  const err = wrapDeg(targetYaw - currentYaw);
  if (degPerPixel == null || !Number.isFinite(degPerPixel) || Math.abs(degPerPixel) < 1e-6)
    return err >= 0 ? probePixels : -probePixels;
  const px = err / degPerPixel;
  // 1 フレームで回しすぎると行き過ぎて振動する。上限を掛けて数フレームに分ける。
  const cap = 800;
  return Math.max(-cap, Math.min(cap, px));
}

/** 実測値が「明らかにおかしい」ときに測り直しを促す（0 速度など）。 */
export function capabilityWarnings(cap: MovementCapability): string[] {
  const w: string[] = [];
  if (cap.walkSpeed < 0.1)
    w.push("歩行速度がほぼ 0。プレイヤーが動いていない（操作 Lua が W を見ていない / 別のキー割当 / Play していない）");
  if (cap.jumpHeight < 0.05)
    w.push("ジャンプ高がほぼ 0。SPACE でジャンプしない実装か、接地判定が false のままの可能性");
  if (cap.jumpDistance < cap.walkSpeed * 0.2 && cap.jumpHeight > 0.05)
    w.push("跳躍距離が歩行速度に対して極端に短い。空中で移動入力が効かない実装かもしれない");
  return w;
}
