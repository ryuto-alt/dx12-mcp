/**
 * 人のプレイを回帰テストへ変える（記録 → 保存 → 再生 → 比較）。純関数のみ。
 *
 * なぜ要るか（2026-09-10 にユーザーと合意）:
 *   コードは ctest 49/49 で守られているのに、**遊びは誰も守っていない**。
 *   ジャンプ力を変えた、コライダーをずらした、Lua を直した——それでステージが
 *   クリアできなくなっても、誰も気づかないまま先へ進んでしまう。
 *
 *   材料はもう揃っていた: dx12_play を押した時点から人の入力が時刻付きで記録されており
 *   （PlaySession）、決定論ステップ（dt 固定）で同じ入力を同じだけ流せる。
 *   ＝**人が 1 回遊べば、それが 1 本の回帰テストになる**。
 *
 * 判定の考え方:
 *   経路をピクセル単位で一致させようとすると、物理の丸めや 1 フレームのずれで毎回落ちて
 *   誰も見なくなる。見るのは「ちゃんと同じ所へ行き着くか」だけにする:
 *     ① 終点が基準と `endTolerance` 以内
 *     ② 途中の経路が基準から `pathTolerance` 以上離れない
 *     ③ 再生中に Lua が死んでいない
 *   ①②が壊れるのは「行けなくなった / 別の所へ落ちた」ときだけで、それが見たいこと。
 *
 * ★基準（reference）は【人の軌跡そのものではなく、初回再生の軌跡】を使う。
 *   人が遊んだときの時刻は実時間、再生は固定 dt なので、入力のタイミングが同じでも
 *   軌跡は構造的に少しずれる（実測で 3m ずれた: 記録は空中、再生は着地後）。
 *   人のプレイからは【入力】だけを受け取り、期待する軌跡は「同じ仕組みで 1 回走らせた結果」
 *   にするのが、決定論リプレイのテストとして正しい形。人の軌跡は humanReference に
 *   参考として残し、初回再生がそこから大きく外れたら warning を出す。
 */

import type { Expectation, ScriptStep, TraceSample } from "./playtest.ts";

export const PLAYTEST_VERSION = 1;

const dist3 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface LookKey {
  t: number;
  yaw: number;
}

export interface PathPoint {
  t: number;
  pos: [number, number, number];
}

export interface PlaytestFile {
  version: number;
  name: string;
  scene: string;
  recordedAt: string;
  durationSec: number;
  /** キーの押し離しタイムライン（そのまま dx12_play_script に渡せる形） */
  steps: ScriptStep[];
  /** 10Hz の yaw 目標。マウス注入の閉ループで追いかける */
  look: LookKey[];
  /** 突き合わせの基準。★初回再生（ゴールデンラン）の軌跡。 */
  reference: PathPoint[];
  /** 人が遊んだときの軌跡（参考）。基準としては使わない。 */
  humanReference?: PathPoint[];
  /** 初回再生が人の軌跡からどれだけ離れたか（m）。大きいと入力だけでは再現できていない印。 */
  humanDrift?: number;
  /** 判定のゆるさ（m） */
  endTolerance: number;
  pathTolerance: number;
  /** 追加の断言（人が後から足せる） */
  expect: Expectation[];
  note?: string;
}

/** get_play_session の生 JSON（必要な所だけ） */
export interface RawSession {
  durationSec?: number;
  frames?: number;
  events?: { t: number; kind: string; detail: string }[];
  samples?: { t: number; camPos: number[]; camYaw: number; camPitch?: number }[];
  summary?: { errors?: number; warnings?: number; inputEvents?: number };
  droppedEvents?: number;
  skippedEvents?: number;
}

export interface ConvertOptions {
  name: string;
  scene: string;
  endTolerance?: number;
  pathTolerance?: number;
  /** look を間引く間隔（秒）。細かすぎると再生が遅い */
  lookInterval?: number;
  note?: string;
}

export class PlaytestConvertError extends Error {}

/**
 * 記録された 1 プレイを .playtest に変換する。
 * ★入力が 1 つも無い記録は保存しない。「Play しただけで何もしていない」記録を
 *   テストとして残すと、常に合格する無意味なテストが増えるだけ。
 */
export function sessionToPlaytest(session: RawSession, opts: ConvertOptions): PlaytestFile {
  const events = session.events ?? [];
  const samples = session.samples ?? [];

  const steps: ScriptStep[] = [];
  for (const e of events) {
    if (e.kind === "key_down") steps.push({ t: e.t, down: e.detail });
    else if (e.kind === "key_up") steps.push({ t: e.t, up: e.detail });
  }
  if (steps.length === 0)
    throw new PlaytestConvertError(
      "キー入力が 1 つも記録されていない。Play して実際に遊んでから記録すること" +
      "（パッド入力だけの記録は今は再生できない）");

  if ((session.droppedEvents ?? 0) > 0)
    throw new PlaytestConvertError(
      `記録が上限で ${session.droppedEvents} 件こぼれている。長すぎるプレイは再生できない` +
      "（区切って録り直すこと）");

  // ★記録の時刻は【実時間】、再生は【固定 dt】。人が普通に遊んだ記録なら
  //   「実時間 = シミュレーション時間」なので噛み合うが、記録中に
  //   dx12_step_frames(deterministic:true) を使うと 1 秒の実時間で何秒ぶんも
  //   シミュレーションが進み、時刻が意味を失う（実際にそれで再生が 7m ずれた）。
  //   フレーム数と秒数の比が現実離れしていたら、それが起きた印なので受け付けない。
  const dur = session.durationSec ?? 0;
  const fps = dur > 0.2 ? (session.frames ?? 0) / dur : 0;
  if (fps > 200)
    throw new PlaytestConvertError(
      `記録が実時間と噛み合っていない（${fps.toFixed(0)} フレーム/秒）。` +
      "記録中に dx12_step_frames(deterministic:true) を使うと時刻が意味を失う。" +
      "回帰テストにする記録は、人が普通に遊ぶか、deterministic を付けずに取ること");

  const interval = opts.lookInterval ?? 0.1;
  const look: LookKey[] = [];
  let lastT = -Infinity;
  for (const s of samples) {
    if (s.t - lastT < interval - 1e-6) continue;
    lastT = s.t;
    look.push({ t: s.t, yaw: s.camYaw });
  }

  const reference: PathPoint[] = samples.map((s) => ({
    t: s.t,
    pos: [s.camPos[0], s.camPos[1], s.camPos[2]] as [number, number, number],
  }));
  if (reference.length < 2)
    throw new PlaytestConvertError("軌跡のサンプルが足りない（記録が短すぎる）");

  return {
    version: PLAYTEST_VERSION,
    name: opts.name,
    scene: opts.scene,
    recordedAt: new Date().toISOString(),
    durationSec: session.durationSec ?? reference[reference.length - 1].t,
    steps,
    look,
    reference,
    // ★実測のゆらぎは 0.002m（決定論ステップが往復の間も時間を止めるようになってから）。
    //   500 倍のマージンを取ってこの値。ランダム要素のあるゲームなら呼び出し側で緩める。
    //   緩すぎる既定にすると「壊れているのに合格する」テストになるので、実測に合わせる。
    endTolerance: opts.endTolerance ?? 1.0,
    pathTolerance: opts.pathTolerance ?? 2.0,
    expect: [],
    note: opts.note,
  };
}

/**
 * 初回再生の軌跡を基準として焼き込む（ゴールデンラン）。
 * 人の軌跡は humanReference へ退避し、どれだけ離れたかを humanDrift に残す。
 */
export function bakeGoldenRun(pt: PlaytestFile, replayTrace: TraceSample[]): PlaytestFile {
  if (replayTrace.length < 2)
    throw new PlaytestConvertError("初回再生のサンプルが足りない（再生に失敗している）");
  const human = pt.reference;
  const golden: PathPoint[] = replayTrace.map((s) => ({ t: s.t, pos: s.pos }));
  let drift = 0;
  for (const s of replayTrace) {
    const d = dist3(s.pos, referenceAt(human, s.t));
    if (d > drift) drift = d;
  }
  return {
    ...pt,
    reference: golden,
    humanReference: human,
    humanDrift: Number(drift.toFixed(2)),
  };
}

/** 保存されたファイルが今の形式で読めるか。壊れたまま走らせて謎の失敗を出さない。 */
export function validatePlaytest(pt: unknown): string[] {
  const errs: string[] = [];
  const p = pt as Partial<PlaytestFile>;
  if (!p || typeof p !== "object") return ["ファイルの中身がオブジェクトではない"];
  if (p.version !== PLAYTEST_VERSION)
    errs.push(`version が ${p.version}（期待 ${PLAYTEST_VERSION}）。録り直すこと`);
  if (!p.scene) errs.push("scene が無い");
  if (!Array.isArray(p.steps) || p.steps.length === 0) errs.push("steps が空");
  if (!Array.isArray(p.reference) || p.reference.length < 2) errs.push("reference が足りない");
  return errs;
}

/** 時刻 t での基準位置（線形補間）。再生のサンプル時刻は基準と一致しないので必ず補間する。 */
export function referenceAt(reference: PathPoint[], t: number): [number, number, number] {
  if (reference.length === 0) return [0, 0, 0];
  if (t <= reference[0].t) return reference[0].pos;
  const last = reference[reference.length - 1];
  if (t >= last.t) return last.pos;
  for (let i = 0; i + 1 < reference.length; i++) {
    const a = reference[i], b = reference[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return [
        a.pos[0] + (b.pos[0] - a.pos[0]) * k,
        a.pos[1] + (b.pos[1] - a.pos[1]) * k,
        a.pos[2] + (b.pos[2] - a.pos[2]) * k,
      ];
    }
  }
  return last.pos;
}

export interface ReplayVerdict {
  pass: boolean;
  endDistance: number;
  maxDeviation: number;
  maxDeviationAt: number;
  reasons: string[];
}

/**
 * 再生結果を記録と突き合わせる。
 * ★「どこで」ずれたかを必ず返す。合否だけ返すテストは直すのに使えない。
 */
export function compareReplay(
  pt: PlaytestFile,
  actual: TraceSample[],
  scriptErrors = 0,
): ReplayVerdict {
  const reasons: string[] = [];
  if (actual.length === 0)
    return { pass: false, endDistance: Infinity, maxDeviation: Infinity, maxDeviationAt: 0,
             reasons: ["再生のサンプルが 1 点も無い"] };

  let maxDev = 0;
  let maxAt = 0;
  for (const s of actual) {
    const ref = referenceAt(pt.reference, s.t);
    const d = dist3(s.pos, ref);
    if (d > maxDev) { maxDev = d; maxAt = s.t; }
  }

  const endRef = pt.reference[pt.reference.length - 1].pos;
  const endActual = actual[actual.length - 1].pos;
  const endDist = dist3(endActual, endRef);

  if (endDist > pt.endTolerance)
    reasons.push(
      `終点が記録から ${endDist.toFixed(2)}m ずれた（許容 ${pt.endTolerance}m）。` +
      `記録は [${endRef.map((n) => n.toFixed(1)).join(",")}]、` +
      `今回は [${endActual.map((n) => n.toFixed(1)).join(",")}]`);
  if (maxDev > pt.pathTolerance)
    reasons.push(
      `t=${maxAt.toFixed(2)}s で経路が ${maxDev.toFixed(2)}m ずれた（許容 ${pt.pathTolerance}m）。` +
      "そこで引っかかったか落ちた可能性");
  if (scriptErrors > 0)
    reasons.push(`再生中に Lua が ${scriptErrors} 件死んだ（dx12_get_script_errors で中身を見る）`);

  return {
    pass: reasons.length === 0,
    endDistance: Number(endDist.toFixed(3)),
    maxDeviation: Number(maxDev.toFixed(3)),
    maxDeviationAt: Number(maxAt.toFixed(2)),
    reasons,
  };
}

/** 保存先（プロジェクト直下）。CI が拾えるよう固定の場所に置く。 */
export function playtestDir(projectBaseDir: string): string {
  const sep = projectBaseDir.endsWith("/") || projectBaseDir.endsWith("\\") ? "" : "/";
  return `${projectBaseDir}${sep}.dx12/playtests`;
}

/** ファイル名に使える名前へ（人が付けた名前をそのまま使わない）。 */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) throw new PlaytestConvertError("name に使える文字が無い（英数字で付けること）");
  return s.slice(0, 64);
}
