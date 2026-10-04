// インスタンス分離: exe コピー一式 / データ領域 / 使い捨てプロジェクト。
//
//   instances/<id>/bin/    DX12Engine.exe + *.dll + shaders/ + assets/(cwd。dx12_engine.log・imgui.ini はここに出る)
//   instances/<id>/data/   DX12E_DATA_DIR
//   projects/<id>/         使い捨てプロジェクト(停止後も 24 時間は残す)
//
// ★exe は実コピー。実行中イメージはハードリンク名でも上書き・削除できないので、リンクにするとビルドの LNK1104 が消えない。
//   ハードリンクにするのは dxcompiler.dll / dxil.dll(再ビルドされないサードパーティ製の大きい DLL)と GameRuntime.exe(エンジンは実行せず、
//   dx12_build_game が出力へコピーする材料)だけ。shaders / assets はビルドが上書きするので実コピー。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FleetConfig } from "./config.ts";
import { sleepSync } from "./registry.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ENGINE_EXE = "DX12Engine.exe";
// ハードリンクにしてよいファイル: 再ビルドされない大きい DLL と、実行されない GameRuntime.exe(dx12_build_game が出力へコピーする材料。
// エンジンは GameRuntime.exe を実行しないので、リンクしても上書き・削除をロックしない)。
const LINKABLE_DLLS = new Set(["dxcompiler.dll", "dxil.dll", "gameruntime.exe"]);

export type SourceBuild = {
  dir: string;
  exe: string;
  mtimeMs: number;
  sizeBytes: number;
  assetsDir: string | null;
  shadersDir: string | null;
  /** どの候補から見つけたか(DX12_FLEET_BUILD_DIR / repo build\release / installed)。 */
  origin: string;
};

function statOrNull(p: string): fs.Stats | null { try { return fs.statSync(p); } catch { return null; } }

export function statBuild(dir: string, origin: string): SourceBuild | null {
  const exe = path.join(dir, ENGINE_EXE);
  const st = statOrNull(exe);
  if (!st || !st.isFile()) return null;
  // assets: exe の隣 → リポジトリ直下(<repo>/build/release の 2 つ上)
  const candidates = [path.join(dir, "assets"), path.join(dir, "..", "..", "assets")];
  const assetsDir = candidates.find((c) => statOrNull(c)?.isDirectory()) ?? null;
  const sh = path.join(dir, "shaders");
  return { dir, exe, mtimeMs: st.mtimeMs, sizeBytes: st.size, assetsDir: assetsDir ? path.resolve(assetsDir) : null, shadersDir: statOrNull(sh)?.isDirectory() ? sh : null, origin };
}

/** exe の元を探す。DX12_FLEET_BUILD_DIR → リポジトリの build\release → %LOCALAPPDATA%\DX12Engine。 */
export function locateBuild(cfg: Pick<FleetConfig, "buildDir">, env: NodeJS.ProcessEnv = process.env): { build: SourceBuild | null; tried: string[] } {
  const tried: string[] = [];
  const cands: [string, string][] = [];
  if (cfg.buildDir) cands.push([cfg.buildDir, "DX12_FLEET_BUILD_DIR"]);
  else {
    cands.push([path.join(here, "..", "..", "..", "build", "release"), "repo build\\release"]);
    if (env.LOCALAPPDATA) cands.push([path.join(env.LOCALAPPDATA, "DX12Engine"), "installed"]);
  }
  for (const [dir, origin] of cands) {
    const abs = path.resolve(dir);
    tried.push(abs);
    const b = statBuild(abs, origin);
    if (b) return { build: b, tried };
  }
  return { build: null, tried };
}

export class BuildInProgress extends Error {
  constructor(msg: string) { super(msg); this.name = "BuildInProgress"; }
}

/** src のビルドを dstBin へコピーする。コピー中に元が変わったら(リンク中)再試行し、駄目なら BuildInProgress。 */
export function materializeBin(src: SourceBuild, dstBin: string): { exePath: string; sizeBytes: number; sourceMtimeMs: number; linked: string[]; copiedBytes: number } {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const before = fs.statSync(src.exe);
      fs.rmSync(dstBin, { recursive: true, force: true });
      fs.mkdirSync(dstBin, { recursive: true });
      const linked: string[] = [];
      let copiedBytes = 0;
      for (const f of fs.readdirSync(src.dir)) {
        const from = path.join(src.dir, f);
        const st = statOrNull(from);
        if (!st?.isFile()) continue;
        const lower = f.toLowerCase();
        if (lower === ENGINE_EXE.toLowerCase() || (lower.endsWith(".dll") && !LINKABLE_DLLS.has(lower))) {
          fs.copyFileSync(from, path.join(dstBin, f));
          copiedBytes += st.size;
        } else if (LINKABLE_DLLS.has(lower)) {
          try { fs.linkSync(from, path.join(dstBin, f)); linked.push(f); }
          catch { fs.copyFileSync(from, path.join(dstBin, f)); copiedBytes += st.size; }
        }
      }
      if (src.shadersDir) fs.cpSync(src.shadersDir, path.join(dstBin, "shaders"), { recursive: true, force: true });
      if (src.assetsDir) fs.cpSync(src.assetsDir, path.join(dstBin, "assets"), { recursive: true, force: true });
      const after = fs.statSync(src.exe);
      const copied = fs.statSync(path.join(dstBin, ENGINE_EXE));
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || copied.size !== after.size) throw new BuildInProgress("コピー中に元の exe が変わった(ビルド中)");
      return { exePath: path.join(dstBin, ENGINE_EXE), sizeBytes: copied.size, sourceMtimeMs: after.mtimeMs, linked, copiedBytes };
    } catch (e: any) {
      lastErr = e;
      // ビルドが exe を書いている最中は EBUSY / EPERM / サイズ不一致になる。少し待って取り直す。
      if (e instanceof BuildInProgress || e?.code === "EBUSY" || e?.code === "EPERM" || e?.code === "EACCES" || e?.code === "UNKNOWN") sleepSync(600 + attempt * 400);
      else throw e;
    }
  }
  if (lastErr instanceof BuildInProgress) throw lastErr;
  throw new BuildInProgress(`元の exe を読めない(ビルド中の可能性): ${(lastErr as any)?.message ?? lastErr}`);
}

/** 元の exe が、コピー時点より新しい(=ビルドし直された)か。 */
export function isStale(entryExe: { sourcePath: string; sourceMtimeMs: number }): { stale: boolean; sourceMtimeMs: number | null } {
  const st = statOrNull(entryExe.sourcePath);
  if (!st) return { stale: false, sourceMtimeMs: null };
  return { stale: st.mtimeMs > entryExe.sourceMtimeMs + 1, sourceMtimeMs: st.mtimeMs };
}

// ── 使い捨てプロジェクト ───────────────────────────────────────────────
const DISPOSABLE_SCENE = `{
  "entities": [
    { "name": "Sun",
      "directionalLight": { "direction": [-0.4, -1.0, -0.35], "color": [1.0, 0.97, 0.9], "intensity": 1.1, "ambient": 0.4 },
      "transform": { "position": [0.0, 12.0, 0.0], "rotation": [55.0, -30.0, 0.0], "scale": [1.0, 1.0, 1.0] } },
    { "name": "MainCamera",
      "camera": { "fovDegrees": 60.0, "nearClip": 0.1, "farClip": 1000.0, "isActive": true },
      "transform": { "position": [0.0, 8.0, -12.0], "rotation": [28.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0] } },
    { "name": "Grid", "gridPlane": { "size": 50.0 },
      "transform": { "position": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0] } }
  ],
  "postProcess": { "enabled": true, "fxaaOn": true },
  "ssao": { "enabled": true },
  "shadows": true
}
`;

export function createDisposableProject(dir: string, name: string): { dir: string; scene: string } {
  fs.mkdirSync(path.join(dir, "assets", "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_") || "fleet";
  fs.writeFileSync(path.join(dir, `${safe}.dx12proj`), JSON.stringify({
    name: safe, version: "0.1.0", defaultScene: "scenes/main.json", lastOpenedScene: "scenes/main.json", assetsDir: "assets", scriptsDir: "scripts",
  }, null, 2));
  fs.writeFileSync(path.join(dir, "assets", "scenes", "main.json"), DISPOSABLE_SCENE);
  return { dir, scene: "scenes/main.json" };
}

/** 同じプロジェクトかの比較用に正規化(小文字化・区切り統一・末尾の区切りを除く)。 */
export function normalizeProjectDir(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** ディレクトリの実サイズ(ハードリンクで共有しているファイルは数えない)。 */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const st = fs.statSync(p); if (st.nlink <= 1) total += st.size; } catch { /* 無視 */ } }
    }
  };
  try { walk(dir); } catch { /* 無視 */ }
  return total;
}

export function rmRetry(dir: string, attempts = 8): boolean {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); if (!fs.existsSync(dir)) return true; }
    catch { /* EBUSY: プロセスの終了直後はハンドルが残ることがある */ }
    sleepSync(150 + i * 100);
  }
  return !fs.existsSync(dir);
}
