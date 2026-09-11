// デカール(投影テクスチャ)のレシピと、貼り付けの計算。
//
// ★なぜ要るか: 弾痕・焦げ・血だまり・水たまり・苔・汚れは「そこで何かが起きた」を語る。
//   これが 1 つも無い床は、どれだけ光を凝っても【出荷前のショールーム】に見える。
//   エンジンには DecalComponent があるのに MCP から使えず、しかも
//   【シーンにアトラス画像が設定されていないと無言で何も出ない】という罠があって、
//   実質「存在しない機能」になっていた。
//
// ★アトラスは手描きの画像が要る……が、それを待っていると永遠に使われないので、
//   よく使う 16 種を【手続き生成】してしまう(このファイルが PNG を作る)。
//   RGBA で、alpha = 覆う度合い / rgb = 下地に混ぜる色（シェーダ側: albedo = lerp(albedo, tex.rgb*tint, a)）。
//
// このファイルは純関数だけ(エンジンを呼ばない)。テストは decals.test.ts。

import { PNG } from "pngjs";

export type Vec3 = [number, number, number];

/** アトラスの格子。1024px / 4 列 = 1 セル 256px。 */
export const ATLAS_SIZE = 1024;
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const CELL = ATLAS_SIZE / ATLAS_COLS;

export type DecalPreset = {
  id: string;
  title: string;
  summary: string;
  /** アトラスのセル位置 [列, 行]。 */
  cell: [number, number];
  /** 下地に混ぜる色。 */
  tint: Vec3;
  opacity: number;
  /** 既定の大きさ(m)。貼る面に沿った 1 辺。 */
  size: number;
  /** 受け面の粗さ上書き(-1 で触らない)。水たまりは下げる=濡れて見える。 */
  roughness: number;
  /** 受け面の金属感上書き(-1 で触らない)。 */
  metallic: number;
  /** 投影軸と面法線の角度がこれを超えたら消える。 */
  angleFadeDeg: number;
  /** 箱の縁からのフェード幅(ローカル)。 */
  fadeEdge: number;
  /** 自己発光(溶岩の焦げ跡など)。 */
  emissive?: Vec3;
  notes: string[];
};

// ── 手続きテクスチャの部品 ───────────────────────────────
// 乱数はシード固定(同じアトラスが毎回できる＝差分が出ない)。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 値ノイズ(格子 + 双線形補間)。周波数 freq、シード seed。0..1。 */
export function valueNoise(x: number, y: number, freq: number, seed: number): number {
  const gx = x * freq, gy = y * freq;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const h = (ix: number, iy: number): number => {
    const r = mulberry32((ix * 374761393 + iy * 668265263 + seed * 2654435761) >>> 0);
    return r();
  };
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(fx), v = s(fy);
  const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** オクターブを重ねたノイズ。 */
export function fbm(x: number, y: number, freq: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 0.5, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

/**
 * セル 1 つぶんの α(覆う度合い)を返す関数。u,v は 0..1(セル内)。
 * ★中心から縁へ必ず 0 へ落とすこと。縁が切れているとタイルの継ぎ目が四角く出る。
 */
export type CellShape = (u: number, v: number) => number;

export const SHAPES: Record<string, CellShape> = {
  // 焦げ・煤: 中心が濃く、外へノイズで千切れる
  scorch: (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u, v, 6, 11);
    return clamp01((1 - smoothstep(0.25, 0.95, d + (n - 0.5) * 0.55)) * (0.55 + n * 0.7));
  },
  // ひび: 中心から放射状に伸びる細い線
  crack: (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy) * 2;
    const ang = Math.atan2(dy, dx);
    // 角度方向の高周波ノイズで「線」を作る
    const spokes = Math.abs(Math.sin(ang * 3.5 + fbm(u, v, 5, 23) * 4));
    const line = 1 - smoothstep(0.0, 0.16, spokes);
    const falloff = 1 - smoothstep(0.15, 1.0, d);
    const jitter = 0.6 + fbm(u, v, 12, 31) * 0.8;
    return clamp01(line * falloff * jitter);
  },
  // 水たまり/血だまり: 丸いが縁が有機的に歪む塊
  puddle: (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy) * 2;
    const wob = (fbm(u, v, 3.5, 41) - 0.5) * 0.42;
    return clamp01(1 - smoothstep(0.55, 0.92, d + wob));
  },
  // 飛沫: 中心の塊 + 周りに散る点
  splatter: (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy) * 2;
    const core = 1 - smoothstep(0.2, 0.62, d + (fbm(u, v, 4, 53) - 0.5) * 0.5);
    const dots = smoothstep(0.82, 0.93, fbm(u, v, 14, 67)) * (1 - smoothstep(0.4, 1.05, d));
    return clamp01(Math.max(core, dots));
  },
  // 汚れ: 薄く広い雲
  dirt: (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u, v, 3, 71, 5);
    return clamp01((0.35 + n * 0.85) * (1 - smoothstep(0.35, 1.0, d)));
  },
  // 垂れた跡: 上から下へ落ちる縦筋
  leak: (u, v) => {
    const streak = fbm(u * 6, v * 0.6, 3, 83, 3);
    const line = smoothstep(0.52, 0.78, streak);
    const top = 1 - smoothstep(0.0, 0.25, v);        // 上端は濃い
    const tail = 1 - smoothstep(0.45, 1.0, v);        // 下へ薄れる
    const side = 1 - smoothstep(0.3, 0.5, Math.abs(u - 0.5));
    return clamp01(line * Math.max(top, tail * 0.85) * side);
  },
  // 弾痕: 小さい黒点 + 放射クラック + 粉の輪
  bulletHole: (u, v) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.hypot(dx, dy) * 2;
    const hole = 1 - smoothstep(0.1, 0.2, d);
    const ang = Math.atan2(dy, dx);
    const spokes = Math.abs(Math.sin(ang * 5 + fbm(u, v, 6, 97) * 5));
    const crack = (1 - smoothstep(0.0, 0.25, spokes)) * (1 - smoothstep(0.15, 0.62, d)) * 0.8;
    const dust = (1 - smoothstep(0.2, 0.75, d)) * fbm(u, v, 9, 101) * 0.45;
    return clamp01(Math.max(hole, Math.max(crack, dust)));
  },
  // 苔・草: 斑点の集合
  moss: (u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) * 2;
    const blob = fbm(u, v, 5, 113, 4);
    // ★しきい値を上げすぎると【ほぼ空のセル】になる(最初 0.55/0.85 で中身が消えた)。
    //   斑に見えるのは 0.38〜0.72 くらいの幅。
    const speck = smoothstep(0.38, 0.72, blob);
    return clamp01(speck * (1 - smoothstep(0.35, 1.05, d)));
  },
};

/** アトラスのセル定義。RGB はそのセルの基準色(preset の tint で更に染める)。 */
type CellDef = { shape: CellShape; rgb: Vec3; /** ノイズで rgb を散らす量 */ vary?: number };

export const ATLAS_CELLS: CellDef[] = [
  { shape: SHAPES.scorch,     rgb: [0.06, 0.055, 0.05], vary: 0.05 },   // 0,0 焦げ
  { shape: SHAPES.crack,      rgb: [0.09, 0.09, 0.095], vary: 0.04 },   // 1,0 ひび
  { shape: SHAPES.puddle,     rgb: [0.10, 0.11, 0.13],  vary: 0.03 },   // 2,0 水たまり
  { shape: SHAPES.splatter,   rgb: [0.36, 0.03, 0.03],  vary: 0.10 },   // 3,0 飛沫(血)
  { shape: SHAPES.dirt,       rgb: [0.30, 0.25, 0.18],  vary: 0.10 },   // 0,1 土汚れ
  { shape: SHAPES.leak,       rgb: [0.14, 0.12, 0.10],  vary: 0.06 },   // 1,1 垂れ跡
  { shape: SHAPES.bulletHole, rgb: [0.05, 0.05, 0.05],  vary: 0.05 },   // 2,1 弾痕
  { shape: SHAPES.moss,       rgb: [0.16, 0.30, 0.12],  vary: 0.12 },   // 3,1 苔
  { shape: SHAPES.puddle,     rgb: [0.42, 0.05, 0.04],  vary: 0.08 },   // 0,2 血だまり
  { shape: SHAPES.dirt,       rgb: [0.55, 0.50, 0.42],  vary: 0.10 },   // 1,2 砂/埃
  { shape: SHAPES.scorch,     rgb: [0.28, 0.10, 0.03],  vary: 0.12 },   // 2,2 錆/焼け
  { shape: SHAPES.splatter,   rgb: [0.10, 0.12, 0.16],  vary: 0.06 },   // 3,2 油はね
  { shape: SHAPES.crack,      rgb: [0.20, 0.19, 0.18],  vary: 0.05 },   // 0,3 細かいひび
  { shape: SHAPES.leak,       rgb: [0.22, 0.20, 0.10],  vary: 0.08 },   // 1,3 錆だれ
  { shape: SHAPES.moss,       rgb: [0.30, 0.34, 0.18],  vary: 0.10 },   // 2,3 枯草
  { shape: SHAPES.dirt,       rgb: [0.80, 0.80, 0.82],  vary: 0.06 },   // 3,3 雪/粉
];

/** アトラス PNG を作る(1024x1024 RGBA)。同じ入力なら毎回同じ画像。 */
export function buildAtlasPng(): Buffer {
  const png = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE });
  for (let ci = 0; ci < ATLAS_CELLS.length; ci++) {
    const col = ci % ATLAS_COLS, row = Math.floor(ci / ATLAS_COLS);
    const def = ATLAS_CELLS[ci];
    const ox = col * CELL, oy = row * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const u = (x + 0.5) / CELL, v = (y + 0.5) / CELL;
        // ★縁は必ず 0 へ落とす。切れたまま並べると、セルの四角い継ぎ目が絵に出る。
        const edge = smoothstep(0.0, 0.06, u) * smoothstep(0.0, 0.06, 1 - u)
                   * smoothstep(0.0, 0.06, v) * smoothstep(0.0, 0.06, 1 - v);
        const a = clamp01(def.shape(u, v)) * edge;
        const n = def.vary ? (fbm(u, v, 8, 7 + ci) - 0.5) * 2 * def.vary : 0;
        const i = ((oy + y) * ATLAS_SIZE + (ox + x)) * 4;
        png.data[i]     = Math.round(clamp01(def.rgb[0] + n) * 255);
        png.data[i + 1] = Math.round(clamp01(def.rgb[1] + n) * 255);
        png.data[i + 2] = Math.round(clamp01(def.rgb[2] + n) * 255);
        png.data[i + 3] = Math.round(a * 255);
      }
    }
  }
  return PNG.sync.write(png);
}

/** セル位置 → atlasUV [u0, v0, du, dv]。 */
export function cellUV(cell: [number, number]): [number, number, number, number] {
  const [c, r] = cell;
  return [c / ATLAS_COLS, r / ATLAS_ROWS, 1 / ATLAS_COLS, 1 / ATLAS_ROWS];
}

// ── レシピ ───────────────────────────────────────────────

export const DECAL_PRESETS: DecalPreset[] = [
  {
    id: "scorch", title: "焦げ跡", summary: "爆発や火の跡。中心が濃く外へ千切れる。",
    cell: [0, 0], tint: [1, 1, 1], opacity: 0.9, size: 1.6,
    roughness: 0.95, metallic: -1, angleFadeDeg: 65, fadeEdge: 0.12,
    notes: ["爆発を置いた場所に必ず残すと『何かが起きた』が伝わる。"],
  },
  {
    id: "crack", title: "ひび割れ", summary: "コンクリ/石の亀裂。放射状。",
    cell: [1, 0], tint: [1, 1, 1], opacity: 0.85, size: 2.0,
    roughness: -1, metallic: -1, angleFadeDeg: 60, fadeEdge: 0.1,
    notes: ["柱の根元・床の継ぎ目・衝撃のあった場所に。大きさを変えて 2〜3 枚重ねると自然。"],
  },
  {
    id: "puddle", title: "水たまり", summary: "濡れた床。roughness を下げるので反射する。",
    cell: [2, 0], tint: [0.5, 0.55, 0.6], opacity: 0.8, size: 1.8,
    roughness: 0.08, metallic: -1, angleFadeDeg: 40, fadeEdge: 0.18,
    notes: [
      "★roughness を 0.08 に落とすので、SSR(dx12_set_ssr)を有効にすると景色が映り込む。",
      "床の低い所(凹み)に置くと説得力が出る。angleFade を 40 度にして壁には貼らないようにしてある。",
    ],
  },
  {
    id: "blood_splatter", title: "血しぶき", summary: "飛び散った跡。中心の塊 + 点。",
    cell: [3, 0], tint: [1, 1, 1], opacity: 0.9, size: 1.2,
    roughness: 0.35, metallic: -1, angleFadeDeg: 75, fadeEdge: 0.08,
    notes: ["壁にも床にも貼れる。血の VFX(blood_burst)と同じ場所に置いて跡を残す。"],
  },
  {
    id: "blood_pool", title: "血だまり", summary: "溜まった血。濡れて光る。",
    cell: [0, 2], tint: [1, 1, 1], opacity: 0.95, size: 1.4,
    roughness: 0.12, metallic: -1, angleFadeDeg: 35, fadeEdge: 0.15,
    notes: ["床専用(angleFade 35 度)。水たまりと同じく濡れた反射が出る。"],
  },
  {
    id: "dirt", title: "土汚れ", summary: "薄く広い汚れ。境界をぼかす役。",
    cell: [0, 1], tint: [1, 1, 1], opacity: 0.55, size: 2.4,
    roughness: 0.9, metallic: -1, angleFadeDeg: 70, fadeEdge: 0.25,
    notes: ["★一番使う。床と壁の境・柱の根元・扉の周りに薄く敷くだけで新品感が消える。"],
  },
  {
    id: "leak", title: "垂れ跡", summary: "壁を伝った汚れ。上から下へ。",
    cell: [1, 1], tint: [1, 1, 1], opacity: 0.7, size: 1.6,
    roughness: 0.85, metallic: -1, angleFadeDeg: 75, fadeEdge: 0.12,
    notes: ["★向きが意味を持つ。壁に貼るときは rotationDeg で『下向き』に合わせること。"],
  },
  {
    id: "bullet_hole", title: "弾痕", summary: "小さい穴 + 放射クラック + 粉。",
    cell: [2, 1], tint: [1, 1, 1], opacity: 1.0, size: 0.28,
    roughness: 0.8, metallic: -1, angleFadeDeg: 70, fadeEdge: 0.06,
    notes: ["小さいので size は 0.2〜0.35。複数まとめて散らすと銃撃戦の跡になる。"],
  },
  {
    id: "moss", title: "苔", summary: "湿った所に生える緑の斑点。",
    cell: [3, 1], tint: [1, 1, 1], opacity: 0.75, size: 1.8,
    roughness: 0.95, metallic: -1, angleFadeDeg: 80, fadeEdge: 0.2,
    notes: ["石・レンガ・木の根元に。日の当たらない側に寄せると自然。"],
  },
  {
    id: "rust", title: "錆", summary: "金属の腐食。赤茶の滲み。",
    cell: [2, 2], tint: [1, 1, 1], opacity: 0.8, size: 1.2,
    roughness: 0.9, metallic: 0.0, angleFadeDeg: 75, fadeEdge: 0.15,
    notes: ["★metallic を 0 に落とす(錆びた所は金属反射を失う)。鉄の継ぎ目・ボルト周りに。"],
  },
  {
    id: "oil", title: "油はね", summary: "黒く光る油。機械の下に。",
    cell: [3, 2], tint: [1, 1, 1], opacity: 0.85, size: 1.0,
    roughness: 0.1, metallic: -1, angleFadeDeg: 40, fadeEdge: 0.12,
    notes: ["床専用。濡れ反射が出るので暗い床でも存在が分かる。"],
  },
  {
    id: "dust", title: "砂・埃", summary: "明るい粉。乾いた場所の堆積。",
    cell: [1, 2], tint: [1, 1, 1], opacity: 0.5, size: 2.2,
    roughness: 0.95, metallic: -1, angleFadeDeg: 45, fadeEdge: 0.25,
    notes: ["床の隅・棚の上に。薄く広く敷くのがコツ(opacity 0.3〜0.5)。"],
  },
  {
    id: "snow", title: "雪・粉", summary: "白い堆積。上向きの面にだけ乗せる。",
    cell: [3, 3], tint: [1, 1, 1], opacity: 0.85, size: 2.4,
    roughness: 0.8, metallic: -1, angleFadeDeg: 30, fadeEdge: 0.22,
    notes: ["angleFade 30 度＝真上を向いた面にしか乗らない(雪の積もり方と同じ)。"],
  },
  {
    id: "grass_dry", title: "枯草", summary: "乾いた草の斑。地面の境界をぼかす。",
    cell: [2, 3], tint: [1, 1, 1], opacity: 0.65, size: 2.0,
    roughness: 0.95, metallic: -1, angleFadeDeg: 55, fadeEdge: 0.25,
    notes: ["地形のレイヤー境界に重ねると、塗り分けの直線が消える。"],
  },
];

export const DECAL_IDS: string[] = DECAL_PRESETS.map((p) => p.id);

export function findDecal(id: string): DecalPreset | undefined {
  return DECAL_PRESETS.find((p) => p.id === id);
}

// ── 貼り付けの計算 ───────────────────────────────────────

const RAD2DEG = 180 / Math.PI;

type Mat3Rows = [Vec3, Vec3, Vec3];   // 行 = ローカル X / Y / Z のワールド方向(行ベクトル規約)

const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * 行(ローカル X / Y / Z のワールド方向)から Transform の euler(度)を取り出す。
 *
 * ★エンジンと同じ式にすること。GetWorldMatrix は
 *   XMMatrixRotationRollPitchYaw(pitch=rotation.x, yaw=rotation.y, roll=rotation.z)
 *   ＝ 行ベクトルに Rz → Rx → Ry の順で掛ける。抽出は Components.cpp の
 *   QuaternionToEulerDegrees と同じ成分を見る(sp = -m32 など)。
 *   自前で三角関数を展開し直すと規約を取り違えるので、必ずこの形を保つこと。
 */
export function eulerFromBasis(rows: Mat3Rows): Vec3 {
  const [X, Y, Z] = rows;
  const sp = Math.max(-1, Math.min(1, -Z[1]));           // -m32
  const pitch = Math.asin(sp);
  let yaw: number, roll: number;
  if (Math.abs(sp) < 0.9999) {
    yaw  = Math.atan2(Z[0], Z[2]);                        // atan2(m31, m33)
    roll = Math.atan2(X[1], Y[1]);                        // atan2(m12, m22)
  } else {
    yaw  = Math.atan2(-X[2], X[0]);                       // ジンバルロック: roll を 0 へ畳む
    roll = 0;
  }
  const r3 = (v: number) => Math.round(v * RAD2DEG * 1000) / 1000;
  return [r3(pitch), r3(yaw), r3(roll)];
}

/**
 * 面法線 n へ「ローカル +Y」を向ける euler(度)。spinDeg は【面の中での回転】。
 *
 * ★エンジンの決まり: デカールの投影軸は【ローカル +Y のワールド方向】
 *   (ApplicationRender.cpp: axisW = world.r[1])。ここを間違えると
 *   「床には出るのに壁には出ない」になる(投影軸が面に平行になるため)。
 * ★面内回転を euler の roll(rotation.z)で書いてはいけない。YXZ では roll が
 *   投影軸そのものを傾けてしまう(法線から外れて薄くなる)。法線まわりに
 *   基底を回してから euler を取り出すこと。
 */
export function eulerFromNormal(n: Vec3, spinDeg = 0): Vec3 {
  const Y = norm(n);
  // n と平行でない参照軸から接線を作る
  const ref: Vec3 = Math.abs(Y[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  let X = norm([
    ref[0] - Y[0] * dot(ref, Y),
    ref[1] - Y[1] * dot(ref, Y),
    ref[2] - Y[2] * dot(ref, Y),
  ]);
  let Z = cross(X, Y);   // det=+1 になる並び(単位行列で検算済み)
  if (spinDeg) {
    const a = spinDeg / RAD2DEG, c = Math.cos(a), s = Math.sin(a);
    const X2: Vec3 = [X[0] * c + Z[0] * s, X[1] * c + Z[1] * s, X[2] * c + Z[2] * s];
    X = norm(X2);
    Z = cross(X, Y);
  }
  return eulerFromBasis([X, Y, Z]);
}

export type DecalPlacement = {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  decal: Record<string, unknown>;
  warnings: string[];
};

export type DecalOptions = {
  /** 貼る面の点。 */
  position: Vec3;
  /** 面の法線(raycast の worldNormal をそのまま渡す)。省略で真上 [0,1,0]。 */
  normal?: Vec3;
  /** 1 辺の大きさ(m)。省略でレシピの既定。 */
  size?: number;
  /** 投影の厚み(m)。面の凹凸より厚くする。省略で size*0.35。 */
  depth?: number;
  /** 面内での回転(度)。垂れ跡や文字を向けるとき。 */
  rotationDeg?: number;
  opacity?: number;
  tint?: Vec3;
  /** 重なり順(小さいものが下)。 */
  sortOrder?: number;
};

/**
 * レシピ + 面の情報 → そのまま set_component / create_entity に渡せる形。
 * ★位置は面から法線方向へ depth/2 だけ浮かせる。箱の【中】に面が入らないと投影されない。
 */
export function planDecal(id: string, opt: DecalOptions): DecalPlacement {
  const p = findDecal(id);
  if (!p) throw new Error(`未知のデカール "${id}"。使えるのは: ${DECAL_IDS.join(", ")}`);
  const warnings: string[] = [];
  const n: Vec3 = opt.normal ?? [0, 1, 0];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const nn: Vec3 = [n[0] / len, n[1] / len, n[2] / len];

  const size = opt.size ?? p.size;
  const depth = opt.depth ?? Math.max(0.05, size * 0.35);
  const rot = eulerFromNormal(nn, opt.rotationDeg ?? 0);

  // ★箱は面を【またぐ】ように置く(中心 = 面の上)。
  //   法線方向へ depth/2 ずらすと面が箱の【底面】に来てしまい、
  //   縁フェード(3 軸すべてに掛かる)で 0 になって【何も描かれない】(実機で踏んだ)。
  //   中心に置けば、面の凹凸に対して上下 depth/2 の余裕ができる。
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const position: Vec3 = [r3(opt.position[0]), r3(opt.position[1]), r3(opt.position[2])];

  // 角度フェードの外なら、貼っても消えるので先に言う
  const upness = nn[1];
  const angleToUp = Math.acos(Math.max(-1, Math.min(1, upness))) * RAD2DEG;
  if (p.angleFadeDeg < 45 && angleToUp > p.angleFadeDeg) {
    warnings.push(
      `"${p.id}" は角度フェードが ${p.angleFadeDeg}° (ほぼ水平面専用)。`
      + `この面は真上から ${angleToUp.toFixed(0)}° 傾いているので、薄くなるか消える。`
      + "壁に貼るなら dirt / leak / blood_splatter を使うこと。",
    );
  }

  const decal: Record<string, unknown> = {
    atlasUV: cellUV(p.cell),
    tint: opt.tint ?? p.tint,
    opacity: opt.opacity ?? p.opacity,
    roughness: p.roughness,
    metallic: p.metallic,
    angleFadeDeg: p.angleFadeDeg,
    fadeEdge: p.fadeEdge,
    sortOrder: opt.sortOrder ?? 0,
  };
  if (p.emissive) decal.emissive = p.emissive;

  return {
    position,
    rotation: rot,
    scale: [r3(size), r3(depth), r3(size)],
    decal,
    warnings,
  };
}

/** ライブラリ一覧(ツールの返り値用)。 */
export function describeDecals(): Array<Record<string, unknown>> {
  return DECAL_PRESETS.map((p) => ({
    id: p.id, title: p.title, summary: p.summary,
    defaultSize: p.size, opacity: p.opacity,
    surface: p.angleFadeDeg <= 45 ? "床(ほぼ水平面)専用" : "床でも壁でも可",
    changes: [
      p.roughness >= 0 ? `roughness→${p.roughness}` : null,
      p.metallic >= 0 ? `metallic→${p.metallic}` : null,
    ].filter(Boolean),
    notes: p.notes,
  }));
}
