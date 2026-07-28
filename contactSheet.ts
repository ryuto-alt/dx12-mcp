// カメラを動かして撮った N 枚を 1 枚の格子(コンタクトシート)へ焼くための純ロジック。
// MCP/EngineClient に依存しないので contactSheet.test.ts からそのまま検証できる。
//
// なぜ要るか: 静止画 1 枚では TAA のゴースト・LOD ポップ・影のちらつきが分からない。
// カメラを動かした連続フレームを 1 枚にまとめて渡せば、AI は「3 枚目だけ影が飛んでいる」を
// 見つけられる。加えて連続フレーム間の画素差分率を数値で返すので、目で見つける前に
// 「フレーム 4→5 だけ差分 18%」と機械的に当たりを付けられる。

import { PNG } from "pngjs";

export type Vec3 = [number, number, number];

export type Pose = {
  /** カメラ位置 [x,y,z]。 */
  position: Vec3;
  /** 注視点 [x,y,z]。省略時は向きを変えない。 */
  target?: Vec3;
};

export type PathMode = "line" | "orbit";

export type PathOptions = {
  mode?: PathMode;
  /** 撮影枚数(2..24)。既定 6。 */
  frames?: number;
  /** line: 始点カメラ位置。 */
  from?: number[];
  /** line: 終点カメラ位置。 */
  to?: number[];
  /** line: 始点の注視点(省略時は target を使う)。 */
  fromTarget?: number[];
  /** line: 終点の注視点(省略時は target を使う)。 */
  toTarget?: number[];
  /** 共通の注視点。line では固定注視点、orbit では周回の中心。 */
  target?: number[];
  /** orbit: 中心からの水平距離。 */
  radius?: number;
  /** orbit: 中心からの高さオフセット。既定 0。 */
  height?: number;
  /** orbit: 開始方位角(度)。+Z が 0°、+X が 90°(dx12_set_sun の azimuth と同じ向き)。既定 0。 */
  startAngleDeg?: number;
  /** orbit: 終了方位角(度)。既定 360(= 1 周)。 */
  endAngleDeg?: number;
};

function asVec3(v: number[] | undefined, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    throw new Error(`${where} は有限な数値 3 つの配列 [x,y,z] で渡す`);
  }
  return [v[0], v[1], v[2]];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * 撮影するカメラ姿勢の列を作る。エンジンを一切呼ばない純関数。
 * - line : from → to を等間隔で補間(注視点も fromTarget → toTarget で補間)。
 * - orbit: target を中心に radius/height の円周上を startAngleDeg → endAngleDeg で回る。
 *          1 周(360°)のときは終端が始端と重ならないよう最後の 1 枚分を詰める。
 */
export function planCameraPath(opts: PathOptions): Pose[] {
  const mode: PathMode = opts.mode ?? "line";
  const frames = Math.max(2, Math.min(24, Math.round(opts.frames ?? 6)));

  if (mode === "orbit") {
    const center = asVec3(opts.target, "target(orbit の中心)");
    const radius = opts.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
      throw new Error("orbit には radius(> 0)が必要。被写体の大きさは dx12_get_bounds で測る");
    }
    const height = opts.height ?? 0;
    const a0 = opts.startAngleDeg ?? 0;
    const a1 = opts.endAngleDeg ?? 360;
    // 全周なら最後の 1 枚が始端と同じ絵になるので、分母を frames にして重複を避ける。
    const closed = Math.abs(Math.abs(a1 - a0) - 360) < 1e-6;
    const denom = closed ? frames : frames - 1;
    const out: Pose[] = [];
    for (let i = 0; i < frames; i++) {
      const deg = a0 + ((a1 - a0) * i) / denom;
      const rad = (deg * Math.PI) / 180;
      out.push({
        position: [
          center[0] + radius * Math.sin(rad),
          center[1] + height,
          center[2] + radius * Math.cos(rad),
        ],
        target: [center[0], center[1], center[2]],
      });
    }
    return out;
  }

  const from = asVec3(opts.from, "from(line の始点)");
  const to = asVec3(opts.to, "to(line の終点)");
  const tFrom = opts.fromTarget ?? opts.target;
  const tTo = opts.toTarget ?? opts.target;
  const out: Pose[] = [];
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const pose: Pose = { position: lerp3(from, to, t) };
    if (tFrom !== undefined || tTo !== undefined) {
      const a = asVec3(tFrom ?? tTo, "fromTarget/target");
      const b = asVec3(tTo ?? tFrom, "toTarget/target");
      pose.target = lerp3(a, b, t);
    }
    out.push(pose);
  }
  return out;
}

// ── 3x5 ビットマップフォント(タイル番号の焼き込み用。凝らない) ───────────
const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "/": ["001", "001", "010", "100", "100"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["000", "000", "000", "000", "100"],
  " ": ["000", "000", "000", "000", "000"],
};
const GLYPH_W = 3, GLYPH_H = 5, GLYPH_GAP = 1;

function setPx(png: PNG, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
}

function fillRect(png: PNG, x0: number, y0: number, w: number, h: number,
                  r: number, g: number, b: number, alpha = 1): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const i = (y * png.width + x) * 4;
      png.data[i]     = Math.round(png.data[i]     * (1 - alpha) + r * alpha);
      png.data[i + 1] = Math.round(png.data[i + 1] * (1 - alpha) + g * alpha);
      png.data[i + 2] = Math.round(png.data[i + 2] * (1 - alpha) + b * alpha);
      png.data[i + 3] = 255;
    }
  }
}

/** テキストの描画幅(px)。scale 倍の 3x5 フォント + 1px 字間。 */
export function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return text.length * GLYPH_W * scale + (text.length - 1) * GLYPH_GAP * scale;
}

/**
 * 3x5 ビットマップフォントで文字列を焼き込む。未知の文字は空白扱い。
 * 下地が何色でも読めるよう、暗いプレートを敷いてから明るい字を置く。
 */
export function drawLabel(png: PNG, text: string, x: number, y: number, scale: number): void {
  const pad = 2 * scale;
  const w = textWidth(text, scale);
  fillRect(png, x - pad, y - pad, w + pad * 2, GLYPH_H * scale + pad * 2, 0, 0, 0, 0.72);
  let cx = x;
  for (const ch of text) {
    const rows = GLYPHS[ch] ?? GLYPHS[" "];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (rows[gy][gx] !== "1") continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++)
            setPx(png, cx + gx * scale + sx, y + gy * scale + sy, 255, 214, 0);
      }
    }
    cx += (GLYPH_W + GLYPH_GAP) * scale;
  }
}

/** nearest neighbor リサイズ(uiCompare と同じ方針。比較用途にはこれで十分)。 */
export function resizeNearest(src: PNG, width: number, height: number): PNG {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

/** 同サイズ 2 枚の RGB 距離ベース差分率(%)。uiCompare の定義と揃えてある。 */
export function diffRatioPercent(a: PNG, b: PNG, threshold: number): number {
  const total = Math.min(a.width * a.height, b.width * b.height);
  if (total === 0) return 0;
  const t2 = threshold * threshold;
  let diff = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i + 1] - b.data[i + 1];
    const db = a.data[i + 2] - b.data[i + 2];
    if (dr * dr + dg * dg + db * db > t2) diff++;
  }
  return (diff / total) * 100;
}

export type SheetOptions = {
  /** 格子の列数。既定 3。 */
  columns?: number;
  /** タイル 1 枚の幅(px)。既定 min(元画像幅, 480)。 */
  tileWidth?: number;
  /** タイル間の隙間(px)。既定 4。 */
  gap?: number;
  /** 連続フレーム差分の RGB 距離閾値。既定 30。 */
  diffThreshold?: number;
  /** false でフレーム番号の焼き込みを省く。既定 true。 */
  label?: boolean;
};

export type SheetResult = {
  /** 格子に並べた合成 PNG。 */
  sheetPng: Buffer;
  columns: number;
  rows: number;
  tile: { width: number; height: number };
  /** 連続フレーム間の画素差分率(%)。要素数 = frames - 1。i 番目は frame i → i+1。 */
  frameDiffs: number[];
  /** frameDiffs の最大値と、それが起きたフレーム境界(1 始まりの「n→n+1」の n)。 */
  maxDiff: { percent: number; fromFrame: number; toFrame: number } | null;
};

/**
 * PNG 群を格子に並べた 1 枚へ合成し、各タイルにフレーム番号を焼き込む。
 * タイルサイズは 1 枚目のアスペクト比に揃える(全部同じ画角で撮る前提)。
 */
export function buildContactSheet(pngBuffers: Buffer[], opts: SheetOptions = {}): SheetResult {
  if (pngBuffers.length === 0) throw new Error("画像が 1 枚もありません。");
  const imgs = pngBuffers.map((b) => PNG.sync.read(b));
  const first = imgs[0];
  if (first.width <= 0 || first.height <= 0) throw new Error("PNG のサイズが 0 です。");

  const columns = Math.max(1, Math.min(8, Math.round(opts.columns ?? 3)));
  const gap = Math.max(0, Math.round(opts.gap ?? 4));
  const tileW = Math.max(16, Math.round(opts.tileWidth ?? Math.min(first.width, 480)));
  const tileH = Math.max(16, Math.round((tileW * first.height) / first.width));
  const rows = Math.ceil(imgs.length / columns);
  const showLabel = opts.label !== false;

  const tiles = imgs.map((im) =>
    im.width === tileW && im.height === tileH ? im : resizeNearest(im, tileW, tileH));

  // 連続フレーム差分は「タイルへ正規化した後」で測る(元解像度が違っても比較できるように)。
  const threshold = opts.diffThreshold ?? 30;
  const frameDiffs: number[] = [];
  for (let i = 1; i < tiles.length; i++) {
    frameDiffs.push(Number(diffRatioPercent(tiles[i - 1], tiles[i], threshold).toFixed(2)));
  }
  let maxDiff: SheetResult["maxDiff"] = null;
  for (let i = 0; i < frameDiffs.length; i++) {
    if (maxDiff == null || frameDiffs[i] > maxDiff.percent) {
      maxDiff = { percent: frameDiffs[i], fromFrame: i + 1, toFrame: i + 2 };
    }
  }

  const outW = columns * tileW + (columns + 1) * gap;
  const outH = rows * tileH + (rows + 1) * gap;
  const out = new PNG({ width: outW, height: outH });
  // 背景は濃いグレー(タイル境界が分かるように)。
  fillRect(out, 0, 0, outW, outH, 24, 24, 28, 1);

  const labelScale = Math.max(2, Math.round(tileW / 160));
  for (let i = 0; i < tiles.length; i++) {
    const cx = i % columns;
    const cy = Math.floor(i / columns);
    const x0 = gap + cx * (tileW + gap);
    const y0 = gap + cy * (tileH + gap);
    const t = tiles[i];
    for (let y = 0; y < tileH; y++) {
      t.data.copy(out.data, ((y0 + y) * outW + x0) * 4, (y * tileW) * 4, (y * tileW + tileW) * 4);
    }
    if (showLabel) {
      drawLabel(out, `${i + 1}/${tiles.length}`, x0 + 4 * labelScale, y0 + 4 * labelScale, labelScale);
    }
  }

  return {
    sheetPng: PNG.sync.write(out),
    columns,
    rows,
    tile: { width: tileW, height: tileH },
    frameDiffs,
    maxDiff,
  };
}
