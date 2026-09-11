// 演出(カットシーン/シーケンス)を【宣言的な台本】から Lua コンポーネントへ落とす。
//
// ★なぜ要るか: 「ボスが現れる」「必殺技が決まる」のような演出は、
//   カメラ・ポスト・時間・エフェクト・音が【同じ時間軸で噛み合って】初めて成立する。
//   AI に Lua を直接書かせると、毎回ちがう自己流の状態機械が生えて、
//   時間の進め方(スケール適用/未適用)もバラバラになり、スローモ演出で破綻する。
//   台本(JSON)→ 生成コード に固定すれば、時間の扱いも後始末も 1 箇所で正しくできる。
//
// ★時間の規約: 演出の時計は【time.realDt()(スケール非適用)】で進める。
//   スローモ(timeScale)を掛けた瞬間に演出まで遅くなると、
//   「0.2 倍速の 3 秒後」が実時間 15 秒になって台本が壊れるため。
//
// このファイルは純関数だけ(エンジンを呼ばない)。テストは sequence.test.ts。

import { VFX_IDS, findVfxPreset, resolveVfx, type LayerSpec } from "./vfx.ts";

export type Vec3 = [number, number, number];

export const EASES = ["linear", "in", "out", "inOut", "outBack", "outBounce"] as const;
export type Ease = (typeof EASES)[number];

export type Track =
  | { t: number; type: "camera"; to: Vec3; from?: Vec3; lookAt?: Vec3; lookAtName?: string;
      dur?: number; ease?: Ease }
  | { t: number; type: "fade"; to: "black" | "white" | "clear"; dur?: number }
  | { t: number; type: "post"; set: Record<string, number>; dur?: number; ease?: Ease }
  | { t: number; type: "timeScale"; value: number; dur?: number }
  | { t: number; type: "shake"; amp?: number; freq?: number; dur?: number }
  | { t: number; type: "vfx"; preset: string; at?: Vec3; atName?: string; scale?: number }
  | { t: number; type: "sound"; path: string; volume?: number; bgm?: boolean; loop?: boolean }
  | { t: number; type: "move"; target: string; to: Vec3; from?: Vec3; dur?: number; ease?: Ease }
  | { t: number; type: "rotate"; target: string; to: Vec3; dur?: number; ease?: Ease }
  | { t: number; type: "light"; target: string; intensity?: number; color?: Vec3; dur?: number }
  | { t: number; type: "event"; name: string; value?: number }
  | { t: number; type: "scene"; path: string; fade?: number }
  | { t: number; type: "log"; text: string };

export type SequenceSpec = {
  /** 生成するコンポーネント名(ファイル名になる)。 */
  name: string;
  /** 動かすカメラエンティティ名(CameraComponent 付き)。camera トラックを使うなら必須。 */
  camera?: string;
  /** 台本。t は秒(開始からの絶対時刻)。順不同でよい(生成時に並べ替える)。 */
  tracks: Track[];
  /** 既定 false。true でループ。 */
  loop?: boolean;
  /** 終了時に発火するイベント名(既定 "<name>:done")。 */
  doneEvent?: string;
};

export const TRACK_TYPES = [
  "camera", "fade", "post", "timeScale", "shake", "vfx", "sound",
  "move", "rotate", "light", "event", "scene", "log",
] as const;

const DEFAULT_DUR: Record<string, number> = {
  camera: 2.0, fade: 0.6, post: 1.0, timeScale: 0.0, shake: 0.4,
  move: 1.0, rotate: 1.0, light: 0.5,
};

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Lua のリテラルへ。数値は丸め、文字列はエスケープする。 */
export function luaValue(v: unknown): string {
  if (typeof v === "number") return String(round4(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `{ ${v.map(luaValue).join(", ")} }`;
  if (v === null || v === undefined) return "nil";
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

const v3 = (v: Vec3): string => `${round4(v[0])}, ${round4(v[1])}, ${round4(v[2])}`;

export type ValidationResult = {
  errors: string[];
  warnings: string[];
  /** 台本全体の長さ(秒)。 */
  duration: number;
  /** t 順に並べ替えた台本。 */
  sorted: Track[];
};

export function trackDuration(tr: Track): number {
  const d = (tr as any).dur;
  return Math.max(0, num(d, DEFAULT_DUR[tr.type] ?? 0));
}

export function validateSpec(spec: SequenceSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!spec.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.name)) {
    errors.push(`name "${spec.name}" は英数字とアンダースコアだけ(先頭は数字以外)。ファイル名になる。`);
  }
  if (!Array.isArray(spec.tracks) || spec.tracks.length === 0) {
    errors.push("tracks が空。1 つ以上の演出を入れること。");
    return { errors, warnings, duration: 0, sorted: [] };
  }

  const sorted = [...spec.tracks].sort((a, b) => num(a.t, 0) - num(b.t, 0));
  let duration = 0;
  let usesCamera = false;

  for (const [i, tr] of sorted.entries()) {
    const at = `tracks[${i}](type=${(tr as any).type}, t=${(tr as any).t})`;
    if (!TRACK_TYPES.includes((tr as any).type)) {
      errors.push(`${at}: 知らない type。使えるのは ${TRACK_TYPES.join(" / ")}`);
      continue;
    }
    if (typeof tr.t !== "number" || !Number.isFinite(tr.t) || tr.t < 0) {
      errors.push(`${at}: t は 0 以上の秒。`);
    }
    const ease = (tr as any).ease;
    if (ease !== undefined && !EASES.includes(ease)) {
      errors.push(`${at}: 知らない ease "${ease}"。使えるのは ${EASES.join(" / ")}`);
    }
    duration = Math.max(duration, num(tr.t, 0) + trackDuration(tr));

    switch (tr.type) {
      case "camera": {
        usesCamera = true;
        if (!Array.isArray(tr.to) || tr.to.length !== 3) errors.push(`${at}: to は [x,y,z]。`);
        if (tr.lookAt && tr.lookAtName) {
          warnings.push(`${at}: lookAt と lookAtName の両方がある。lookAtName(動く被写体を追う)を優先する。`);
        }
        if (!tr.lookAt && !tr.lookAtName) {
          warnings.push(`${at}: 注視点が無い。カメラは位置だけ動いて向きは前のまま＝被写体が画面外に出やすい。`);
        }
        break;
      }
      case "fade":
        if (!["black", "white", "clear"].includes(tr.to)) {
          errors.push(`${at}: to は "black" / "white" / "clear"。`);
        }
        break;
      case "post": {
        if (!tr.set || Object.keys(tr.set).length === 0) errors.push(`${at}: set が空。`);
        for (const [k, v] of Object.entries(tr.set ?? {})) {
          if (typeof v !== "number") errors.push(`${at}: post の ${k} は数値のみ(色や bool は不可)。`);
        }
        break;
      }
      case "timeScale":
        if (typeof tr.value !== "number" || tr.value < 0) errors.push(`${at}: value は 0 以上。`);
        if (tr.value === 0 && !sorted.some((o) => o.type === "timeScale" && o.t > tr.t && (o as any).value > 0)) {
          warnings.push(`${at}: 時間を止めたまま戻していない。終了時に自動で 1.0 へ戻すが、途中で戻すなら timeScale をもう 1 つ置くこと。`);
        }
        break;
      case "vfx": {
        if (!VFX_IDS.includes(tr.preset)) {
          errors.push(`${at}: 知らない VFX プリセット "${tr.preset}"。dx12_vfx_library で一覧。`);
        }
        if (!tr.at && !tr.atName) errors.push(`${at}: at([x,y,z]) か atName(エンティティ名)のどちらかが要る。`);
        break;
      }
      case "sound":
        if (!tr.path) errors.push(`${at}: path が空(assets 相対)。`);
        break;
      case "move":
      case "rotate":
        if (!tr.target) errors.push(`${at}: target(エンティティ名)が要る。`);
        if (!Array.isArray((tr as any).to) || (tr as any).to.length !== 3) errors.push(`${at}: to は [x,y,z]。`);
        break;
      case "light":
        if (!tr.target) errors.push(`${at}: target(ライトのエンティティ名)が要る。`);
        if (tr.intensity === undefined && !tr.color) errors.push(`${at}: intensity か color のどちらかを指定すること。`);
        break;
      case "event":
        if (!tr.name) errors.push(`${at}: name(イベント名)が要る。`);
        break;
      case "scene":
        if (!tr.path) errors.push(`${at}: path(シーンの assets 相対パス)が要る。`);
        if (i !== sorted.length - 1) {
          warnings.push(`${at}: シーン遷移の後にまだ台本が続いている。遷移でこのスクリプトごと消えるので後ろは実行されない。`);
        }
        break;
      case "log":
        if (!tr.text) errors.push(`${at}: text が空。`);
        break;
    }
  }

  if (usesCamera && !spec.camera) {
    errors.push("camera トラックがあるのに spec.camera(動かすカメラエンティティ名)が無い。");
  }
  if (spec.loop && sorted.some((t) => t.type === "scene")) {
    warnings.push("loop とシーン遷移は両立しない(遷移した時点で終わる)。");
  }
  // 同じ対象を同時に動かす台本は、後勝ちで上書きし合って意図しない絵になる
  const camTracks = sorted.filter((t) => t.type === "camera") as Extract<Track, { type: "camera" }>[];
  for (let i = 1; i < camTracks.length; i++) {
    const prev = camTracks[i - 1];
    if (num(camTracks[i].t, 0) < num(prev.t, 0) + trackDuration(prev) - 1e-6) {
      warnings.push(
        `カメラのトラックが重なっている(t=${prev.t} の ${trackDuration(prev)}秒 と t=${camTracks[i].t})。`
        + "後のトラックが毎フレーム上書きするので、前の動きは見えなくなる。",
      );
      break;
    }
  }
  return { errors, warnings, duration: round4(duration), sorted };
}

// ════════════════════════════════════════════════════════════════
//  Lua 生成
// ════════════════════════════════════════════════════════════════

/** VFX レシピの 1 レイヤーを fx:burst{...} のテーブルへ落とす。 */
export function layerToBurst(l: LayerSpec, pos: string, scale: number): string {
  // ワンショットは duration ぶん、連続放出は 0.3 秒ぶんを 1 回で撒く
  const span = l.looping === false ? (l.duration ?? 0.3) : 0.3;
  const count = Math.max(1, Math.min(600, Math.round(l.rate * span)));
  const kv: string[] = [];
  const off = l.offset ?? [0, 0, 0];
  kv.push(`x = ${pos}.x + ${round4(off[0] * scale)}`);
  kv.push(`y = ${pos}.y + ${round4(off[1] * scale)}`);
  kv.push(`z = ${pos}.z + ${round4(off[2] * scale)}`);
  kv.push(`count = ${count}`);
  kv.push(`kind = ${l.kind}`);
  kv.push(`blend = ${l.blend ?? 0}`);
  if (l.orient) kv.push(`orient = ${l.orient}`);
  const dir = l.dir ?? [0, 1, 0];
  kv.push(`dx = ${round4(dir[0])}, dy = ${round4(dir[1])}, dz = ${round4(dir[2])}`);
  kv.push(`spread = ${round4(l.spread ?? 0.4)}`);
  kv.push(`speed = ${round4((l.speed ?? 3) * scale)}, speedVar = ${round4((l.speedVar ?? 0.4) * scale)}`);
  kv.push(`size = ${round4(l.size * scale)}, sizeEnd = ${round4((l.sizeEnd ?? 0) * scale)}`);
  if ((l.sizeMid ?? -1) >= 0) kv.push(`sizeMid = ${round4((l.sizeMid as number) * scale)}`);
  kv.push(`life = ${round4(l.life)}, lifeVar = ${round4(l.lifeVar ?? 0.3)}`);
  kv.push(`r = ${round4(l.color[0])}, g = ${round4(l.color[1])}, b = ${round4(l.color[2])}`);
  kv.push(`rEnd = ${round4(l.colorEnd[0])}, gEnd = ${round4(l.colorEnd[1])}, bEnd = ${round4(l.colorEnd[2])}`);
  if (l.colorMid) {
    kv.push(`rMid = ${round4(l.colorMid[0])}, gMid = ${round4(l.colorMid[1])}, bMid = ${round4(l.colorMid[2])}`);
  }
  kv.push(`intensity = ${round4(l.intensity ?? 3)}`);
  kv.push(`gravity = ${round4((l.gravity ?? 0) * scale)}, drag = ${round4(l.drag ?? 1)}`);
  if (l.up) kv.push(`up = ${round4(l.up * scale)}`);
  if (l.stretch) kv.push(`stretch = ${round4(l.stretch)}`);
  if (l.turbStrength) kv.push(`turbStrength = ${round4(l.turbStrength)}, turbFreq = ${round4(l.turbFreq ?? 1)}`);
  if (l.flicker) kv.push(`flicker = ${round4(l.flicker)}, flickerFreq = ${round4(l.flickerFreq ?? 18)}`);
  if (l.distort) kv.push(`distort = ${round4(l.distort)}`);
  if (l.light) kv.push(`light = true, lightRange = ${round4((l.lightRange ?? 3) * scale)}`);
  if (l.gpu) kv.push(`gpu = true`);
  if (l.texturePath) kv.push(`texture = ${luaValue(l.texturePath)}`);
  return `fx:burst{ ${kv.join(", ")} }`;
}

const EASE_LUA = `local EASE = {
  linear   = function(k) return k end,
  ["in"]   = function(k) return k * k end,
  out      = function(k) return 1 - (1 - k) * (1 - k) end,
  inOut    = function(k) return k < 0.5 and 2*k*k or 1 - (-2*k + 2)^2 / 2 end,
  outBack  = function(k) local c = 1.70158; local f = k - 1; return 1 + (c+1) * f*f*f + c * f*f end,
  outBounce = function(k)
    local n, d = 7.5625, 2.75
    if k < 1/d then return n*k*k
    elseif k < 2/d then k = k - 1.5/d; return n*k*k + 0.75
    elseif k < 2.5/d then k = k - 2.25/d; return n*k*k + 0.9375
    else k = k - 2.625/d; return n*k*k + 0.984375 end
  end,
}`;

/** 台本 → Lua コンポーネントのソース。 */
export function generateLua(spec: SequenceSpec): string {
  const { sorted, duration } = validateSpec(spec);
  const doneEvent = spec.doneEvent ?? `${spec.name}:done`;
  const L: string[] = [];
  const cues: string[] = [];     // 一度きり
  const tracks: string[] = [];   // 時間で連続に効く

  const easeOf = (tr: any): string => luaValue(tr.ease ?? "inOut");
  let seenFade = false;

  for (const [i, tr] of sorted.entries()) {
    const t0 = round4(num(tr.t, 0));
    const dur = trackDuration(tr);
    const t1 = round4(t0 + dur);
    const id = i + 1;

    switch (tr.type) {
      case "camera": {
        const look = tr.lookAtName
          ? `local lt = findE(${luaValue(tr.lookAtName)}); if lt then aimAt(cam, lt.transform.position.x, lt.transform.position.y, lt.transform.position.z) end`
          : tr.lookAt
            ? `aimAt(cam, ${v3(tr.lookAt)})`
            : "";
        const from = tr.from
          ? `{ ${v3(tr.from)} }`
          : `nil`;   // nil = 開始時のカメラ位置を使う
        tracks.push(
          `  { t0 = ${t0}, t1 = ${t1}, ease = ${easeOf(tr)}, apply = function(self, k)\n`
          + `      local cam = self._cam; if not cam then return end\n`
          + `      local from = grab(self, ${id}, function()\n`
          + `        local f = ${from}\n`
          + `        if f then return f end\n`
          + `        local p = cam.transform.position; return { p.x, p.y, p.z }\n`
          + `      end)\n`
          + `      local to = { ${v3(tr.to)} }\n`
          + `      cam.transform.position = Vec3.new(from[1] + (to[1]-from[1])*k,\n`
          + `                                        from[2] + (to[2]-from[2])*k,\n`
          + `                                        from[3] + (to[3]-from[3])*k)\n`
          + (look ? `      ${look}\n` : "")
          + `    end },`,
        );
        break;
      }
      case "fade": {
        // 露出で暗転/復帰する(ライトを全部触らないので確実で安い)。白は露出を上げて飛ばす。
        const toV = tr.to === "black" ? 0.0 : tr.to === "white" ? 8.0 : 1.0;
        // ★先行する fade が無い "clear" は「黒から明ける」意図。今の露出(=1.0)から始めると
        //   何も起きないので、開始の瞬間に 0 へ落としてから上げる。
        const openFromBlack = tr.to === "clear" && !seenFade;
        seenFade = true;
        tracks.push(
          `  { t0 = ${t0}, t1 = ${t1}, ease = "linear", apply = function(self, k)\n`
          + `      local from = grab(self, ${id}, ${openFromBlack
                ? `function() post.set("exposureOn", true); post.set("exposure", 0.0); return 0.0 end`
                : `function() post.set("exposureOn", true); return post.get("exposure") or 1.0 end`})
`
          + `      post.set("exposure", from + (${toV} - from) * k)\n`
          + `    end },`,
        );
        break;
      }
      case "post": {
        const lines = Object.entries(tr.set).map(([k, v], j) =>
          `      local f${j} = grab(self, ${id * 100 + j}, function() post.set(${luaValue(`${k}On`)}, true); return post.get(${luaValue(k)}) or 0 end)\n`
          + `      post.set(${luaValue(k)}, f${j} + (${round4(v)} - f${j}) * k)`).join("\n");
        tracks.push(
          `  { t0 = ${t0}, t1 = ${t1}, ease = ${easeOf(tr)}, apply = function(self, k)\n${lines}\n    end },`,
        );
        break;
      }
      case "timeScale": {
        if (dur > 0) {
          tracks.push(
            `  { t0 = ${t0}, t1 = ${t1}, ease = "linear", apply = function(self, k)\n`
            + `      local from = grab(self, ${id}, function() return time.getScale() end)\n`
            + `      time.setScale(from + (${round4(tr.value)} - from) * k)\n`
            + `    end },`,
          );
        } else {
          cues.push(`  { t = ${t0}, fire = function(self) time.setScale(${round4(tr.value)}) end },`);
        }
        break;
      }
      case "shake": {
        const amp = round4(num(tr.amp, 0.25));
        const freq = round4(num(tr.freq, 22));
        cues.push(
          `  { t = ${t0}, fire = function(self)\n`
          + `      self._shake = { amp = ${amp}, freq = ${freq}, left = ${round4(dur || 0.4)}, dur = ${round4(dur || 0.4)} }\n`
          + `    end },`,
        );
        break;
      }
      case "vfx": {
        const r = resolveVfx(tr.preset, { scale: tr.scale });
        const scale = tr.scale ?? 1;
        const posExpr = tr.atName
          ? `local e = findE(${luaValue(tr.atName)}); if not e then return end; local p = e.transform.position`
          : `local p = { x = ${v3(tr.at as Vec3)} }`;
        const bursts = r.preset.layers.map((l) => `      ${layerToBurst(l, "p", scale)}`).join("\n");
        cues.push(
          `  { t = ${t0}, fire = function(self)\n`
          + `      ${posExpr}\n${bursts}\n`
          + `    end },`,
        );
        break;
      }
      case "sound": {
        const call = tr.bgm
          ? `audio:playBGM(${luaValue(tr.path)}, ${tr.loop !== false})`
          : `audio:playSFX(${luaValue(tr.path)}, ${tr.loop === true}, ${round4(num(tr.volume, 1))})`;
        cues.push(`  { t = ${t0}, fire = function(self) ${call} end },`);
        break;
      }
      case "move": {
        const from = tr.from ? `{ ${v3(tr.from)} }` : "nil";
        tracks.push(
          `  { t0 = ${t0}, t1 = ${t1}, ease = ${easeOf(tr)}, apply = function(self, k)\n`
          + `      local e = findE(${luaValue(tr.target)}); if not e then return end\n`
          + `      local from = grab(self, ${id}, function()\n`
          + `        local f = ${from}\n`
          + `        if f then return f end\n`
          + `        local p = e.transform.position; return { p.x, p.y, p.z }\n`
          + `      end)\n`
          + `      local to = { ${v3(tr.to)} }\n`
          + `      e.transform.position = Vec3.new(from[1] + (to[1]-from[1])*k,\n`
          + `                                      from[2] + (to[2]-from[2])*k,\n`
          + `                                      from[3] + (to[3]-from[3])*k)\n`
          + `    end },`,
        );
        break;
      }
      case "rotate": {
        tracks.push(
          `  { t0 = ${t0}, t1 = ${t1}, ease = ${easeOf(tr)}, apply = function(self, k)\n`
          + `      local e = findE(${luaValue(tr.target)}); if not e then return end\n`
          + `      local from = grab(self, ${id}, function()\n`
          + `        local r = e.transform.rotation; return { r.x, r.y, r.z }\n`
          + `      end)\n`
          + `      local to = { ${v3(tr.to)} }\n`
          + `      e.transform.rotation = Vec3.new(from[1] + (to[1]-from[1])*k,\n`
          + `                                      from[2] + (to[2]-from[2])*k,\n`
          + `                                      from[3] + (to[3]-from[3])*k)\n`
          + `    end },`,
        );
        break;
      }
      case "light": {
        const parts: string[] = [];
        if (tr.intensity !== undefined) {
          parts.push(`Lighting.tweenIntensity(lt, ${round4(tr.intensity)}, ${round4(dur || 0.5)})`);
        }
        if (tr.color) {
          parts.push(`Lighting.tweenColor(lt, ${v3(tr.color)}, ${round4(dur || 0.5)})`);
        }
        cues.push(
          `  { t = ${t0}, fire = function(self)\n`
          + `      local e = findE(${luaValue(tr.target)}); if not e then return end\n`
          + `      local lt = findLight(e); if not lt then logWarn("${spec.name}: ${tr.target} にライトが無い"); return end\n`
          + parts.map((p) => `      ${p}`).join("\n") + "\n"
          + `    end },`,
        );
        break;
      }
      case "event":
        cues.push(
          `  { t = ${t0}, fire = function(self) events:emit(${luaValue(tr.name)}, { value = ${round4(num(tr.value, 0))} }) end },`,
        );
        break;
      case "scene":
        cues.push(
          `  { t = ${t0}, fire = function(self) fadeToScene(${luaValue(tr.path)}, ${round4(num(tr.fade, 0.6))}) end },`,
        );
        break;
      case "log":
        cues.push(`  { t = ${t0}, fire = function(self) log(${luaValue(tr.text)}) end },`);
        break;
    }
  }

  L.push(`-- ${spec.name}: 自動生成された演出(dx12_sequence_author)。`);
  L.push(`-- 台本の長さ ${duration} 秒 / トラック ${sorted.length} 本。`);
  L.push(`-- ★時計は time.realDt()(タイムスケール非適用)で進む。スローモを掛けても台本は実時間で流れる。`);
  L.push(`-- ★手で直してもよいが、同じ名前で dx12_sequence_author を撃つと上書きされる。`);
  L.push(``);
  L.push(`properties = {`);
  L.push(`  { name = "autoPlay",   type = "bool",  default = true,  label = "Play 開始で自動再生" },`);
  L.push(`  { name = "startDelay", type = "float", default = 0.0, min = 0, max = 60, label = "開始までの待ち(秒)" },`);
  L.push(`  { name = "loopPlay",   type = "bool",  default = ${spec.loop ? "true" : "false"}, label = "ループ再生" },`);
  L.push(`}`);
  L.push(``);
  L.push(`local TOTAL = ${duration}`);
  L.push(`local CAMERA = ${luaValue(spec.camera ?? "")}`);
  L.push(`local DONE_EVENT = ${luaValue(doneEvent)}`);
  L.push(``);
  L.push(EASE_LUA);
  L.push(``);
  L.push(`-- 名前でエンティティを引く。★scene:findEntity は見つからなくても nil を返さない`);
  L.push(`--   (無効な Entity が返る)ので、必ず isValid() で確かめる。`);
  L.push(`local function findE(name)`);
  L.push(`  if name == nil or name == "" then return nil end`);
  L.push(`  local e = scene:findEntity(name)`);
  L.push(`  if e and e:isValid() then return e end`);
  L.push(`  logWarn("${spec.name}: エンティティ '" .. tostring(name) .. "' が見つからない")`);
  L.push(`  return nil`);
  L.push(`end`);
  L.push(``);
  L.push(`-- 注視点から Transform の euler を作る。`);
  L.push(`-- ★カメラ同期は rotation.x を【反転した pitch】として読む(ApplyCameraTransformToGlobal)。`);
  L.push(`--   ここで符号を合わせておかないと上下が逆さまに向く。`);
  L.push(`local function aimAt(cam, tx, ty, tz)`);
  L.push(`  local p = cam.transform.position`);
  L.push(`  local dx, dy, dz = tx - p.x, ty - p.y, tz - p.z`);
  L.push(`  local flat = math.sqrt(dx*dx + dz*dz)`);
  L.push(`  local yaw   = math.deg(math.atan(dx, dz))`);
  L.push(`  local pitch = math.deg(math.atan(dy, math.max(flat, 1e-5)))`);
  L.push(`  cam.transform.rotation = Vec3.new(-pitch, yaw, 0)`);
  L.push(`end`);
  L.push(``);
  L.push(`-- トラックの「開始値」を最初の 1 回だけ捕まえる(今の値から動かすため)。`);
  L.push(`local function grab(self, id, get)`);
  L.push(`  local v = self._from[id]`);
  L.push(`  if v == nil then v = get(); self._from[id] = v end`);
  L.push(`  return v`);
  L.push(`end`);
  L.push(``);
  L.push(`-- 時間で連続に効くもの(カメラ移動・フェード・グレーディング…)`);
  L.push(`local TRACKS = {`);
  L.push(...tracks);
  L.push(`}`);
  L.push(``);
  L.push(`-- 一度きりのきっかけ(エフェクト・音・イベント…)`);
  L.push(`local CUES = {`);
  L.push(...cues);
  L.push(`}`);
  L.push(``);
  L.push(`local function reset(self)`);
  L.push(`  self._t = -(self.startDelay or 0)`);
  L.push(`  self._next = 1`);
  L.push(`  self._from = {}`);
  L.push(`  self._shake = nil`);
  L.push(`  self._shakeOff = nil`);
  L.push(`end`);
  L.push(``);
  const playEvent = `${spec.name}:play`;
  const stopEvent = `${spec.name}:stop`;
  L.push(`function OnStart(self)`);
  L.push(`  reset(self)`);
  L.push(`  self._cam = findE(CAMERA)`);
  L.push(`  self._playing = (self.autoPlay ~= false)`);
  L.push(`  -- 他のスクリプトから鳴らす/止める:`);
  L.push(`  --   events:emit(${luaValue(playEvent)})  /  events:emit(${luaValue(stopEvent)})`);
  L.push(`  -- ★購読は OnStart の中でしかできない(EventBus は Play 中だけ有効)。`);
  L.push(`  events:on(${luaValue(playEvent)}, function() reset(self); self._playing = true end)`);
  L.push(`  events:on(${luaValue(stopEvent)}, function() self._playing = false end)`);
  L.push(`end`);
  L.push(``);
  L.push(`local function finish(self)`);
  L.push(`  if self.loopPlay then reset(self); return end`);
  L.push(`  self._playing = false`);
  L.push(`  -- ★後始末: 時間スケールを戻す。演出がスローモのまま終わるとゲームが壊れる。`);
  L.push(`  time.setScale(1.0)`);
  L.push(`  events:emit(DONE_EVENT, { value = 1 })`);
  L.push(`end`);
  L.push(``);
  L.push(`function OnUpdate(self)`);
  L.push(`  if not self._playing then return end`);
  L.push(`  local dt = time.realDt()`);
  L.push(``);
  L.push(`  -- ★前フレームの揺れを先に戻す。戻さずに足し続けると、カメラのトラックが`);
  L.push(`  --   終わった後もオフセットが累積してカメラが漂っていく。`);
  L.push(`  if self._shakeOff and self._cam then`);
  L.push(`    local p = self._cam.transform.position`);
  L.push(`    self._cam.transform.position = Vec3.new(p.x - self._shakeOff[1],`);
  L.push(`                                            p.y - self._shakeOff[2],`);
  L.push(`                                            p.z - self._shakeOff[3])`);
  L.push(`    self._shakeOff = nil`);
  L.push(`  end`);
  L.push(`  local prev = self._t`);
  L.push(`  self._t = self._t + dt`);
  L.push(``);
  L.push(`  while self._next <= #CUES and CUES[self._next].t <= self._t do`);
  L.push(`    CUES[self._next].fire(self)`);
  L.push(`    self._next = self._next + 1`);
  L.push(`  end`);
  L.push(``);
  L.push(`  for _, tr in ipairs(TRACKS) do`);
  L.push(`    if self._t >= tr.t0 and prev <= tr.t1 then`);
  L.push(`      local span = tr.t1 - tr.t0`);
  L.push(`      local k = span > 0.0001 and (self._t - tr.t0) / span or 1.0`);
  L.push(`      if k < 0 then k = 0 elseif k > 1 then k = 1 end`);
  L.push(`      tr.apply(self, (EASE[tr.ease] or EASE.linear)(k))`);
  L.push(`    end`);
  L.push(`  end`);
  L.push(``);
  L.push(`  -- 画面揺れ: カメラのトラックが位置を決めた【後】に足す(順序が逆だと揺れが消える)`);
  L.push(`  local sh = self._shake`);
  L.push(`  if sh and self._cam then`);
  L.push(`    sh.left = sh.left - dt`);
  L.push(`    if sh.left <= 0 then`);
  L.push(`      self._shake = nil`);
  L.push(`    else`);
  L.push(`      local decay = sh.left / sh.dur`);
  L.push(`      local a = sh.amp * decay * decay`);
  L.push(`      local ph = self._t * sh.freq`);
  L.push(`      local off = { math.sin(ph * 1.7) * a, math.sin(ph * 2.3 + 1.1) * a, math.sin(ph * 1.3 + 2.7) * a }`);
  L.push(`      local p = self._cam.transform.position`);
  L.push(`      self._cam.transform.position = Vec3.new(p.x + off[1], p.y + off[2], p.z + off[3])`);
  L.push(`      self._shakeOff = off`);
  L.push(`    end`);
  L.push(`  end`);
  L.push(``);
  L.push(`  if self._t >= TOTAL then finish(self) end`);
  L.push(`end`);
  L.push(``);
  return L.join("\n");
}

/** 台本が参照しているエンティティ名(存在確認に使う)。 */
export function referencedEntities(spec: SequenceSpec): string[] {
  const names = new Set<string>();
  if (spec.camera) names.add(spec.camera);
  for (const tr of spec.tracks ?? []) {
    const t = tr as any;
    for (const key of ["target", "atName", "lookAtName"]) {
      if (typeof t[key] === "string" && t[key]) names.add(t[key]);
    }
  }
  return [...names];
}

/** 台本が使っている VFX プリセット(存在確認・警告用)。 */
export function referencedVfx(spec: SequenceSpec): string[] {
  const out = new Set<string>();
  for (const tr of spec.tracks ?? []) {
    if ((tr as any).type === "vfx" && (tr as any).preset) out.add((tr as any).preset);
  }
  return [...out];
}

/** 台本の例(AI がゼロから書けるようにツール説明へ載せる)。 */
export const SEQUENCE_EXAMPLE: SequenceSpec = {
  name: "BossReveal",
  camera: "CutsceneCam",
  tracks: [
    { t: 0.0, type: "fade", to: "clear", dur: 0.8 },
    { t: 0.0, type: "camera", from: [0, 6, 14], to: [0, 2.2, 6], lookAtName: "Boss", dur: 3.2, ease: "inOut" },
    { t: 0.4, type: "sound", path: "audio/boss_theme.wav", bgm: true },
    { t: 2.6, type: "vfx", preset: "explosion", atName: "Boss", scale: 1.4 },
    { t: 2.6, type: "shake", amp: 0.35, freq: 26, dur: 0.7 },
    { t: 2.6, type: "timeScale", value: 0.25 },
    { t: 3.1, type: "timeScale", value: 1.0, dur: 0.4 },
    { t: 3.2, type: "post", set: { saturation: 1.35, contrast: 1.2 }, dur: 1.0 },
    { t: 4.4, type: "event", name: "bossFightStart" },
  ],
};

/** VFX プリセット名が実在するか(ツールのエラーを親切にするため)。 */
export function unknownVfxPresets(spec: SequenceSpec): string[] {
  return referencedVfx(spec).filter((id) => !findVfxPreset(id));
}
