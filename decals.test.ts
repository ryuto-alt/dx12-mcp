// decals.ts の単体テスト(エンジン不要)。
// 守りたいのは 3 つ:
//   1) 貼り付けの姿勢が【エンジンの規約】と合っている
//      (投影軸 = ローカル +Y / euler は YXZ。ここがズレると壁に何も出ない)
//   2) 生成するアトラスが「使える画像」になっている(セルが空でない・縁が切れていない)
//   3) 無理な貼り方(水たまりを壁に)は黙って消えず、先に警告する

import {
  ATLAS_COLS, ATLAS_ROWS, ATLAS_SIZE, CELL, DECAL_IDS, DECAL_PRESETS,
  buildAtlasPng, cellUV, describeDecals, eulerFromNormal, findDecal, planDecal,
} from "./decals.ts";
import { PNG } from "pngjs";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const DEG = Math.PI / 180;

/** YXZ euler(度) からローカル +Y のワールド方向を復元する(エンジンと同じ式)。 */
function localUpFromEuler(e: [number, number, number]): [number, number, number] {
  const p = e[0] * DEG, y = e[1] * DEG, r = e[2] * DEG;
  // R = Ry(yaw) * Rx(pitch) * Rz(roll) を (0,1,0) に適用
  const x0 = -Math.sin(r), y0 = Math.cos(r) * Math.cos(p), z0 = Math.cos(r) * Math.sin(p);
  return [
    x0 * Math.cos(y) + z0 * Math.sin(y),
    y0,
    -x0 * Math.sin(y) + z0 * Math.cos(y),
  ];
}

console.log("[1] 姿勢: ローカル +Y が面法線を向く");
{
  const cases: Array<[string, [number, number, number]]> = [
    ["床(+Y)", [0, 1, 0]],
    ["天井(-Y)", [0, -1, 0]],
    ["壁 +X", [1, 0, 0]],
    ["壁 -X", [-1, 0, 0]],
    ["壁 +Z", [0, 0, 1]],
    ["壁 -Z", [0, 0, -1]],
    ["斜面", [0.5, 0.7, -0.51]],
    ["斜め壁", [0.7, 0.1, 0.7]],
  ];
  for (const [label, n] of cases) {
    const len = Math.hypot(...n);
    const nn = n.map((v) => v / len) as [number, number, number];
    const e = eulerFromNormal(nn);
    const up = localUpFromEuler(e);
    const err = Math.hypot(up[0] - nn[0], up[1] - nn[1], up[2] - nn[2]);
    check(`${label}: 投影軸が法線と一致`, err < 1e-3,
      `euler=${JSON.stringify(e)} → up=${up.map((v) => v.toFixed(3))} / n=${nn.map((v) => v.toFixed(3))}`);
  }
  // ★面内回転(spin)は【法線まわり】。euler の roll に素直に入れると投影軸ごと傾いて
  //   「壁に貼ったのに薄くなる」になる。どの角度でも投影軸が法線と一致すること。
  for (const spin of [0, 30, 90, 180, 275]) {
    for (const n of [[1, 0, 0], [0, 1, 0], [0.3, 0.6, -0.74]] as Array<[number, number, number]>) {
      const nn = (() => { const l = Math.hypot(...n); return n.map((v) => v / l) as [number, number, number]; })();
      const up = localUpFromEuler(eulerFromNormal(nn, spin));
      const err = Math.hypot(up[0] - nn[0], up[1] - nn[1], up[2] - nn[2]);
      if (err >= 1e-3) {
        check(`spin=${spin}° / n=${JSON.stringify(nn.map((v) => +v.toFixed(2)))} でも投影軸は法線`, false,
          `up=${up.map((v) => v.toFixed(3))}`);
      }
    }
  }
  console.log("  (上に NG が無ければ面内回転は投影軸を傾けない)");
}

console.log("[2] 配置の計算");
{
  const pl = planDecal("dirt", { position: [1, 0, 2], normal: [0, 1, 0], size: 2 });
  check("大きさは面に沿った 2 辺に入る", pl.scale[0] === 2 && pl.scale[2] === 2, JSON.stringify(pl.scale));
  check("厚みは Y(投影軸)方向", pl.scale[1] > 0 && pl.scale[1] < 2, JSON.stringify(pl.scale));
  // ★箱は面をまたぐ(中心 = 面)。ずらすと面が底面に来て、縁フェードで消える
  check("箱の中心が面の上に来る", Math.abs(pl.position[1] - 0) < 1e-6, JSON.stringify(pl.position));
  check("床なら無回転", pl.rotation[0] === 0 && pl.rotation[1] === 0);
  check("atlasUV がセルを指す", JSON.stringify(pl.decal.atlasUV) === JSON.stringify(cellUV([0, 1])));

  const wall = planDecal("leak", { position: [0, 2, -3], normal: [0, 0, 1], size: 1.5, rotationDeg: 0 });
  check("壁でも中心は面の上", Math.abs(wall.position[2] - (-3)) < 1e-6,
    `${JSON.stringify(wall.position)} scale=${JSON.stringify(wall.scale)}`);

  const custom = planDecal("dirt", { position: [0, 0, 0], opacity: 0.3, tint: [1, 0.5, 0.5], sortOrder: 3 });
  check("opacity/tint/sortOrder を上書きできる",
    custom.decal.opacity === 0.3 && (custom.decal.tint as number[])[1] === 0.5 && custom.decal.sortOrder === 3);

  let threw = false;
  try { planDecal("nope", { position: [0, 0, 0] }); } catch (e: any) {
    threw = e.message.includes("nope") && e.message.includes("dirt");
  }
  check("未知の id はエラー + 使える id の一覧", threw);
}

console.log("[3] 消えるだけの貼り方は先に言う");
{
  const wallPuddle = planDecal("puddle", { position: [0, 1, 0], normal: [1, 0, 0] });
  check("水たまりを壁に貼ったら警告", wallPuddle.warnings.length > 0, JSON.stringify(wallPuddle.warnings));
  check("代わりに何を使うか言う", wallPuddle.warnings[0].includes("dirt"));

  const floorPuddle = planDecal("puddle", { position: [0, 0, 0], normal: [0, 1, 0] });
  check("床なら警告しない", floorPuddle.warnings.length === 0);

  const wallDirt = planDecal("dirt", { position: [0, 1, 0], normal: [1, 0, 0] });
  check("壁にも貼れるレシピは警告しない", wallDirt.warnings.length === 0);
}

console.log("[4] レシピの健全性");
{
  check("レシピが 10 種以上", DECAL_PRESETS.length >= 10, `${DECAL_PRESETS.length}`);
  check("id が重複していない", new Set(DECAL_IDS).size === DECAL_IDS.length);
  for (const p of DECAL_PRESETS) {
    if (p.cell[0] < 0 || p.cell[0] >= ATLAS_COLS || p.cell[1] < 0 || p.cell[1] >= ATLAS_ROWS) {
      check(`${p.id}: セルがアトラス内`, false, JSON.stringify(p.cell));
    }
    if (!(p.opacity > 0 && p.opacity <= 1)) check(`${p.id}: opacity は 0..1`, false, `${p.opacity}`);
    if (!(p.size > 0)) check(`${p.id}: size > 0`, false, `${p.size}`);
    if (p.notes.length === 0) check(`${p.id}: 注意書きがある`, false, "");
  }
  console.log("  (上に NG が無ければ全レシピ健全)");
  check("一覧に『床専用か』が出る",
    describeDecals().some((d: any) => String(d.surface).includes("床")));
  check("findDecal が引ける", findDecal("bullet_hole")?.size! < 0.5);
}

console.log("[5] 生成アトラス");
{
  const buf = buildAtlasPng();
  const png = PNG.sync.read(buf);
  check("サイズが 1024x1024", png.width === ATLAS_SIZE && png.height === ATLAS_SIZE);

  // 各セルが「中身がある」「縁が透明」ことを見る
  for (const p of DECAL_PRESETS) {
    const ox = p.cell[0] * CELL, oy = p.cell[1] * CELL;
    let maxA = 0, sumA = 0, edgeMax = 0;
    for (let y = 0; y < CELL; y += 2) {
      for (let x = 0; x < CELL; x += 2) {
        const a = png.data[((oy + y) * ATLAS_SIZE + (ox + x)) * 4 + 3];
        maxA = Math.max(maxA, a);
        sumA += a;
        const onEdge = x < 2 || y < 2 || x >= CELL - 2 || y >= CELL - 2;
        if (onEdge) edgeMax = Math.max(edgeMax, a);
      }
    }
    const mean = sumA / ((CELL / 2) * (CELL / 2));
    if (maxA < 120) check(`${p.id}: セルに中身がある`, false, `maxAlpha=${maxA}`);
    if (mean < 4) check(`${p.id}: 薄すぎない`, false, `meanAlpha=${mean.toFixed(1)}`);
    // 縁が不透明だと隣のセルと地続きに見え、四角い継ぎ目が出る
    if (edgeMax > 40) check(`${p.id}: 縁が透明(継ぎ目が出ない)`, false, `edgeMaxAlpha=${edgeMax}`);
  }
  console.log("  (上に NG が無ければ全セルが使える形)");

  check("同じ内容が毎回できる(シード固定)",
    buildAtlasPng().equals(buf), "差分が出ると無駄なコミットになる");
}

console.log(failed === 0 ? "\nOK: decals テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
