// 宣言的シーン生成(M11)の幾何: ベクトル・アフィン変換・AABB。純関数(fs も engine も触らない)。
//
// 規約(実エンジンで実測して合わせてある):
//   ・単位はメートル。Euler は度。順序は YXZ = 回転行列 R = Ry(yaw) * Rx(pitch) * Rz(roll)(列ベクトル。v' = R v)。
//   ・scale はローカル軸に先に掛かる(ワールド = pos + R * (S ⊙ p))。親子はワールド行列の積(親 × 子)。
//   ・エンジンの get_bounds は「ローカル AABB の 8 頂点をワールド変換した AABB」。scale[2,3,4]・rot[0,45,0]・pos[1,2,3] の box が
//     min[-1.1213,0.5,0.8787] / max[3.1213,3.5,5.1213] になる(実測)。ここも同じ式なので、置く前に実測と同じ AABB が出せる。
//   ・yaw 0 は +Z、yaw 90 は +X を向く(look_at: yaw=atan2(dx,dz)、pitch=-atan2(dy,hypot(dx,dz)))。

export type Vec3 = [number, number, number];
export type AABB = { min: Vec3; max: Vec3 };
/** 3x3 行列(行優先 9 要素)+ 平行移動。 */
export type Affine = { m: number[]; t: Vec3 };

const D2R = Math.PI / 180;

export const ZERO: Vec3 = [0, 0, 0];
export const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** 有限の数値 3 つか。 */
export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** 丸め(小数 5 桁。計算の揺れを消して、同じ入力なら同じ出力にする)。-0 は 0 にする。 */
export function r5(x: number): number {
  const v = Math.round(x * 1e5) / 1e5;
  return v === 0 ? 0 : v;
}
export const roundVec = (v: Vec3): Vec3 => [r5(v[0]), r5(v[1]), r5(v[2])];

export function mulMat3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

export function mulMat3Vec(a: number[], v: Vec3): Vec3 {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

/** Euler(度・YXZ)→ 回転行列。 */
export function eulerToMat3(rot: Vec3): number[] {
  const [rx, ry, rz] = [rot[0] * D2R, rot[1] * D2R, rot[2] * D2R];
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mulMat3(Ry, mulMat3(Rx, Rz));
}

/** ローカル TRS → アフィン(線形部 = R * S)。 */
export function trs(pos: Vec3, rot: Vec3, scale: Vec3): Affine {
  const R = eulerToMat3(rot);
  const m = [
    R[0] * scale[0], R[1] * scale[1], R[2] * scale[2],
    R[3] * scale[0], R[4] * scale[1], R[5] * scale[2],
    R[6] * scale[0], R[7] * scale[1], R[8] * scale[2],
  ];
  return { m, t: [pos[0], pos[1], pos[2]] };
}

/** a ∘ b(まず b、次に a。ワールド = 親 × 子)。 */
export function mulAffine(a: Affine, b: Affine): Affine {
  const m = mulMat3(a.m, b.m);
  const bt = mulMat3Vec(a.m, b.t);
  return { m, t: [bt[0] + a.t[0], bt[1] + a.t[1], bt[2] + a.t[2]] };
}

export function applyAffine(a: Affine, p: Vec3): Vec3 {
  const v = mulMat3Vec(a.m, p);
  return [v[0] + a.t[0], v[1] + a.t[1], v[2] + a.t[2]];
}

function inv3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    A * id, -(b * i - c * h) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, -(a * f - c * d) * id,
    C * id, -(a * h - b * g) * id, (a * e - b * d) * id,
  ];
}

/** 逆アフィン(特異なら null)。 */
export function invAffine(a: Affine): Affine | null {
  const mi = inv3(a.m);
  if (!mi) return null;
  const t = mulMat3Vec(mi, a.t);
  return { m: mi, t: [-t[0], -t[1], -t[2]] };
}

/** ローカル AABB(8 頂点)を変換した AABB。 */
export function transformAabb(b: AABB, a: Affine): AABB {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
    const w = applyAffine(a, p);
    for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
  }
  return { min, max };
}

export const aabbCenter = (b: AABB): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
export const aabbSize = (b: AABB): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const aabbTranslate = (b: AABB, d: Vec3): AABB => ({ min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]], max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]] });

/** 点(サイズ 0)の AABB。ライト・カメラ・空の親など、メッシュを持たないもの。 */
export const POINT_AABB: AABB = { min: [0, 0, 0], max: [0, 0, 0] };

/** プリミティブのローカル AABB(scale 1)。box は ±0.5、sphere は半径 0.5、plane は一辺 50 で厚み 0。 */
export function primitiveLocalAabb(p: "box" | "sphere" | "plane"): AABB {
  if (p === "plane") return { min: [-25, 0, -25], max: [25, 0, 25] };
  return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
}

/** 2 つの AABB が(体積を持って)交差するか。 */
export function aabbOverlap(a: AABB, b: AABB, eps = 0): boolean {
  return a.max[0] - b.min[0] > eps && b.max[0] - a.min[0] > eps
    && a.max[1] - b.min[1] > eps && b.max[1] - a.min[1] > eps
    && a.max[2] - b.min[2] > eps && b.max[2] - a.min[2] > eps;
}

/** 位置 p から target を向く Euler(度)。look_at と同じ式(yaw=atan2(dx,dz)、pitch=-atan2(dy,水平距離)、roll=0)。 */
export function lookAtEuler(from: Vec3, target: Vec3): Vec3 {
  const dx = target[0] - from[0], dy = target[1] - from[1], dz = target[2] - from[2];
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-9 && Math.abs(dy) < 1e-9) return [0, 0, 0];
  const yaw = horiz < 1e-9 ? 0 : Math.atan2(dx, dz) / D2R;
  const pitch = -Math.atan2(dy, horiz) / D2R;
  return [r5(pitch), r5(yaw), 0];
}

/** 角度差(度。±180 に畳む)。 */
export function angleDiffDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

/** 決定的な乱数(mulberry32)。同じ seed なら同じ並び。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
