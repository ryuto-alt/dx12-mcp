// 「書き換えられない正解」(sealed oracles。Q2)の純ロジック。エンジンへは注入された call(method, params) だけで触る。
//
// ★なぜ要るか: フロンティアモデルは、テストや採点器を書き換えて通すことがある(METR 2025)。AI が作る側のとき、
//   「正解」(固定カメラの金画像・性能予算・封印したプレイテスト)を AI が黙って書き換えられると、品質ゲートは意味を失う。
//   そこで正解のハッシュを【プロジェクトの外】(%LOCALAPPDATA%/UnoEngine/oracles)の台帳に封印し、
//   封印後の改ざんをゲートが blocking で検出する。封印(seal)できるのは人の承認(confirm)を通った呼び出しだけ。
//
// 置き場所:
//   <baseDir>/.dx12/oracles/oracles.json   マニフェスト(views / perf / playtests)
//   <baseDir>/.dx12/oracles/views/<name>.png   金画像(封印の対象)
//   <baseDir>/.dx12/oracles/out/<name>.diff.png  差分画像(封印しない)
//   台帳: %LOCALAPPDATA%/UnoEngine/oracles/<baseDir 小文字の sha1 先頭 16 桁>.json(DX12_ORACLE_LEDGER_DIR で上書き)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { diffStats, heatmap, readPng, sideBySide, writePng } from "./testing/visualPng.ts";

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<any>;

export type Vec3 = [number, number, number];
export type OracleCamera = { position: Vec3; target: Vec3 };
export type OracleView = {
  name: string; scene?: string; camera: OracleCamera; width?: number; height?: number;
  tolerance?: { lsb?: number; maxDiffPct?: number };
};
export type PerfMax = { frameMsP95?: number; frameMsAvg?: number; drawCalls?: number; gpuMsTotal?: number };
export type OraclePerf = { name: string; scene?: string; camera?: OracleCamera; frames?: number; max: PerfMax };
export type OracleManifest = { version: 1; views: OracleView[]; perf: OraclePerf[]; playtests: string[] };
export type Ledger = { version: 1; baseDir: string; sealedAt: string; files: Record<string, string> };
export type LedgerStatus = { sealed: boolean; sealedAt?: string; changed: string[]; missing: string[]; extra: string[] };

/** ゲートの GateItem と構造が同じ(jev/qualityGate.ts は oracles.ts を import するので型は複製する)。 */
export type OracleItem = {
  check: string; code: string; level: "error" | "warning" | "suggestion"; blocking: boolean; text: string; name?: string; fix?: string;
};

export const DEFAULT_LSB = 8;
export const DEFAULT_MAX_DIFF_PCT = 0.5;
export const DEFAULT_PERF_FRAMES = 120;
export const DEFAULT_VIEW_W = 640;   // 金画像の既定解像度(省略すると撮影環境のビューポートに依存して再現しないので固定する)
export const DEFAULT_VIEW_H = 360;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const SEAL_FIX = 'dx12_call {name:"dx12_oracle", args:{op:"seal"}, confirm:true}';

// ── パス ─────────────────────────────────────────────────────────────────────────
const slash = (p: string) => p.replace(/\\/g, "/");
export const dx12Root = (baseDir: string) => path.join(baseDir, ".dx12");
export const oracleDir = (baseDir: string) => path.join(baseDir, ".dx12", "oracles");
export const manifestPath = (baseDir: string) => path.join(oracleDir(baseDir), "oracles.json");
export const goldenPath = (baseDir: string, name: string) => path.join(oracleDir(baseDir), "views", `${name}.png`);
export const diffPath = (baseDir: string, name: string) => path.join(oracleDir(baseDir), "out", `${name}.diff.png`);
export const currentPath = (baseDir: string, name: string) => path.join(oracleDir(baseDir), "out", `${name}.current.png`);
const playtestFile = (baseDir: string, name: string) => path.join(baseDir, ".dx12", "playtests", `${name}.json`);

export function ledgerDir(): string {
  const env = process.env.DX12_ORACLE_LEDGER_DIR;
  if (env) return env;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "UnoEngine", "oracles");
}
/** baseDir を正規化(絶対パス・/ 区切り・末尾の / なし・小文字)。台帳のキーと中身の baseDir に使う。 */
export function normalizeBaseDir(baseDir: string): string {
  return slash(path.resolve(baseDir)).replace(/\/+$/, "").toLowerCase();
}
export function ledgerPath(baseDir: string): string {
  const h = crypto.createHash("sha1").update(normalizeBaseDir(baseDir)).digest("hex").slice(0, 16);
  return path.join(ledgerDir(), `${h}.json`);
}

// ── マニフェスト ─────────────────────────────────────────────────────────────────
export function emptyManifest(): OracleManifest { return { version: 1, views: [], perf: [], playtests: [] }; }

function isVec3(v: unknown): v is Vec3 { return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)); }
function isCamera(c: any): c is OracleCamera { return !!c && isVec3(c.position) && isVec3(c.target); }

/** マニフェストの形を検査して、悪い所を日本語で返す(空なら OK)。 */
export function validateManifest(m: any): string[] {
  const bad: string[] = [];
  if (!m || typeof m !== "object") return ["oracles.json がオブジェクトではない"];
  if (m.version !== 1) bad.push("version は 1");
  const seen = new Set<string>();
  for (const v of Array.isArray(m.views) ? m.views : []) {
    if (!v || typeof v.name !== "string" || !NAME_RE.test(v.name)) { bad.push(`views[].name が不正(英数字・_・- の 1〜64 文字): ${JSON.stringify(v?.name)}`); continue; }
    if (seen.has("v:" + v.name)) bad.push(`views の名前が重複: ${v.name}`);
    seen.add("v:" + v.name);
    if (!isCamera(v.camera)) bad.push(`views[${v.name}].camera は {position:[x,y,z], target:[x,y,z]}`);
    if ((v.width === undefined) !== (v.height === undefined)) bad.push(`views[${v.name}] の width と height は両方指定する`);
  }
  for (const p of Array.isArray(m.perf) ? m.perf : []) {
    if (!p || typeof p.name !== "string" || !NAME_RE.test(p.name)) { bad.push(`perf[].name が不正: ${JSON.stringify(p?.name)}`); continue; }
    if (seen.has("p:" + p.name)) bad.push(`perf の名前が重複: ${p.name}`);
    seen.add("p:" + p.name);
    if (p.camera !== undefined && !isCamera(p.camera)) bad.push(`perf[${p.name}].camera は {position, target}`);
    if (!p.max || typeof p.max !== "object" || Object.keys(p.max).length === 0) bad.push(`perf[${p.name}].max に予算が 1 つも無い`);
  }
  for (const n of Array.isArray(m.playtests) ? m.playtests : []) if (typeof n !== "string" || !NAME_RE.test(n)) bad.push(`playtests に不正な名前: ${JSON.stringify(n)}`);
  return bad;
}

/** マニフェストを読む。無ければ null。壊れていれば throw(メッセージに理由)。 */
export function readManifest(baseDir: string): OracleManifest | null {
  const p = manifestPath(baseDir);
  if (!fs.existsSync(p)) return null;
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e: any) { throw new Error(`oracles.json が読めない: ${e?.message ?? e}`); }
  const bad = validateManifest(raw);
  if (bad.length) throw new Error(`oracles.json が不正: ${bad.join(" / ")}`);
  return { version: 1, views: raw.views ?? [], perf: raw.perf ?? [], playtests: raw.playtests ?? [] };
}

/** 封印済みの読み取り専用ファイルでも書けるようにしてから書く。 */
export function unlockFile(p: string): void { try { if (fs.existsSync(p)) fs.chmodSync(p, 0o666); } catch { /* 無視 */ } }

export function writeManifest(baseDir: string, m: OracleManifest): void {
  const p = manifestPath(baseDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  unlockFile(p);
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
}

// ── 台帳と封印 ───────────────────────────────────────────────────────────────────
export function sha256File(p: string): string { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

/** 封印の対象ファイル(.dx12 からの相対パス → 絶対パス)。マニフェスト・views/*.png・マニフェストが挙げたプレイテスト。 */
export function sealTargets(baseDir: string, m: OracleManifest | null): { files: Map<string, string>; missingPlaytests: string[] } {
  const files = new Map<string, string>();
  const missingPlaytests: string[] = [];
  if (fs.existsSync(manifestPath(baseDir))) files.set("oracles/oracles.json", manifestPath(baseDir));
  const vdir = path.join(oracleDir(baseDir), "views");
  let pngs: string[] = [];
  try { pngs = fs.readdirSync(vdir).filter((f) => f.toLowerCase().endsWith(".png")).sort(); } catch { /* 無い */ }
  for (const f of pngs) files.set(`oracles/views/${f}`, path.join(vdir, f));
  for (const n of m?.playtests ?? []) {
    const p = playtestFile(baseDir, n);
    if (fs.existsSync(p)) files.set(`playtests/${n}.json`, p); else missingPlaytests.push(n);
  }
  return { files, missingPlaytests };
}

export function readLedger(baseDir: string): Ledger | null {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerPath(baseDir), "utf8"));
    if (l && l.version === 1 && l.files && typeof l.files === "object") return l as Ledger;
  } catch { /* 無い・壊れている */ }
  return null;
}

/** いまのファイルのハッシュで台帳を書き、対象を読み取り専用にする。 */
export function writeLedger(baseDir: string, now: () => Date = () => new Date()): { sealedAt: string; files: number; missingPlaytests: string[] } {
  const m = readManifest(baseDir);
  if (!m) throw new Error("oracles.json が無い(封印するものが無い)。先に dx12_oracle {op:\"add_view\"} などで正解を作る");
  const { files, missingPlaytests } = sealTargets(baseDir, m);
  const hashes: Record<string, string> = {};
  for (const [rel, abs] of files) hashes[rel] = sha256File(abs);
  const sealedAt = now().toISOString();
  const ledger: Ledger = { version: 1, baseDir: normalizeBaseDir(baseDir), sealedAt, files: hashes };
  const lp = ledgerPath(baseDir);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  fs.writeFileSync(lp, JSON.stringify(ledger, null, 2) + "\n");
  for (const abs of files.values()) { try { fs.chmodSync(abs, 0o444); } catch { /* 無視 */ } }
  return { sealedAt, files: files.size, missingPlaytests };
}

/** 台帳と現物を突き合わせる。台帳が無ければ sealed:false。 */
export function verifyLedger(baseDir: string): LedgerStatus {
  const ledger = readLedger(baseDir);
  if (!ledger) return { sealed: false, changed: [], missing: [], extra: [] };
  const changed: string[] = [], missing: string[] = [], extra: string[] = [];
  let m: OracleManifest | null = null;
  try { m = readManifest(baseDir); } catch { /* 壊れたマニフェストは changed として出る */ }
  const dx = dx12Root(baseDir);
  for (const [rel, hash] of Object.entries(ledger.files)) {
    const abs = path.join(dx, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    try { if (sha256File(abs) !== hash) changed.push(rel); } catch { changed.push(rel); }
  }
  for (const rel of sealTargets(baseDir, m).files.keys()) if (!(rel in ledger.files)) extra.push(rel);
  return { sealed: true, sealedAt: ledger.sealedAt, changed: changed.sort(), missing: missing.sort(), extra: extra.sort() };
}
export const isTampered = (s: LedgerStatus) => s.sealed && (s.changed.length > 0 || s.missing.length > 0 || s.extra.length > 0);

// ── シーンの照合 ─────────────────────────────────────────────────────────────────
const normScene = (s: string) => slash(s).replace(/^\.\//, "").toLowerCase();
/** view / perf の scene が、いま開いているシーンと同じか(scene 未指定は常に true)。 */
export function sceneMatches(want: string | undefined, current: string | null): boolean {
  if (!want) return true;
  if (!current) return false;
  const a = normScene(want), b = normScene(current);
  return a === b || a.endsWith("/" + b) || b.endsWith("/" + a);
}

// ── カメラ付きで何かを撮る/測る ──────────────────────────────────────────────────
type PrevCamera = { position: Vec3; target: Vec3 } | null;

async function readEditorCamera(call: EngineCall): Promise<{ cam: PrevCamera; mode: string | null }> {
  try {
    const c = await call("get_editor_camera", {});
    return { cam: isVec3(c?.position) && isVec3(c?.target) ? { position: c.position, target: c.target } : null, mode: typeof c?.mode === "string" ? c.mode : null };
  } catch { return { cam: null, mode: null }; }
}

/** カメラを置いて fn を実行し、元のカメラへ戻す(戻せない Playing は上書き解除)。 */
export async function withCamera<T>(call: EngineCall, camera: OracleCamera | undefined, fn: () => Promise<T>): Promise<T> {
  if (!camera) return fn();
  const { cam: prev, mode } = await readEditorCamera(call);
  await call("set_editor_camera", { position: camera.position, target: camera.target });
  try { return await fn(); }
  finally {
    try {
      if (prev) await call("set_editor_camera", { position: prev.position, target: prev.target });
      else if (mode === "Playing") await call("set_editor_camera", { release: true });
    } catch { /* 戻せなくても結果は返す */ }
  }
}

/** 固定カメラで決定論的に撮って outPath へ PNG を書く。返り値は screenshot_final の結果。 */
export async function captureView(call: EngineCall, view: OracleView, outPath: string): Promise<{ path: string; width: number; height: number }> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  unlockFile(outPath);
  const width = view.width ?? DEFAULT_VIEW_W, height = view.height ?? DEFAULT_VIEW_H;
  const shot = await withCamera(call, view.camera, () => call("screenshot_final", { deterministic: true, width, height, path: outPath }));
  const written = typeof shot?.path === "string" ? shot.path : outPath;
  if (path.resolve(written) !== path.resolve(outPath) && fs.existsSync(written)) fs.copyFileSync(written, outPath);
  if (!fs.existsSync(outPath)) throw new Error(`screenshot_final が ${outPath} に画像を書かなかった`);
  return { path: outPath, width: shot?.width ?? width, height: shot?.height ?? height };
}

export type CompareResult =
  | { ok: false; reason: "size"; golden: { width: number; height: number }; current: { width: number; height: number } }
  | { ok: boolean; reason?: undefined; diffPct: number; maxDiffPct: number; lsb: number; maxDelta: number; diffPixels: number; diffImage?: string };

/** 金画像と今の画像を比べる。範囲外なら 金|今|ヒートマップ の並べ画像を diffOut へ書く。 */
export function compareView(goldenFile: string, currentFile: string, diffOut: string, tol: OracleView["tolerance"] = {}): CompareResult {
  const g = readPng(goldenFile), c = readPng(currentFile);
  if (g.width !== c.width || g.height !== c.height) {
    return { ok: false, reason: "size", golden: { width: g.width, height: g.height }, current: { width: c.width, height: c.height } };
  }
  const lsb = tol?.lsb ?? DEFAULT_LSB, maxDiffPct = tol?.maxDiffPct ?? DEFAULT_MAX_DIFF_PCT;
  const st = diffStats(g, c, lsb);
  const diffPct = st.diffRatio * 100;
  const ok = !(diffPct > maxDiffPct);
  let diffImage: string | undefined;
  if (!ok) {
    fs.mkdirSync(path.dirname(diffOut), { recursive: true });
    writePng(diffOut, sideBySide([g, c, heatmap(g, c)], Math.min(480, g.width)));
    diffImage = diffOut;
  }
  return { ok, diffPct: Number(diffPct.toFixed(4)), maxDiffPct, lsb, maxDelta: st.maxDelta, diffPixels: st.diffPixels, ...(diffImage ? { diffImage } : {}) };
}

// ── 性能予算 ─────────────────────────────────────────────────────────────────────
export type PerfActual = { frameMsP95?: number; frameMsAvg?: number; drawCalls?: number; gpuMsTotal?: number };
export type PerfResult = { actual: PerfActual; over: { key: keyof PerfMax; actual: number | null; max: number }[]; frames: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export async function runPerf(call: EngineCall, perf: OraclePerf): Promise<PerfResult> {
  const frames = Math.max(30, perf.frames ?? DEFAULT_PERF_FRAMES);
  const r = await withCamera(call, perf.camera, () => call("benchmark", { frames }));
  const actual: PerfActual = {
    frameMsP95: num(r?.frameMs?.p95), frameMsAvg: num(r?.frameMs?.avg), drawCalls: num(r?.drawCalls), gpuMsTotal: num(r?.gpuPassMs?.total),
  };
  const over: PerfResult["over"] = [];
  for (const key of ["frameMsP95", "frameMsAvg", "drawCalls", "gpuMsTotal"] as const) {
    const max = perf.max[key];
    if (max === undefined) continue;
    const a = actual[key];
    if (a === undefined) over.push({ key, actual: null, max });   // 測れなかった予算は通ったことにしない
    else if (a > max) over.push({ key, actual: a, max });
  }
  return { actual, over, frames };
}

// ── ゲート用の検査本体 ───────────────────────────────────────────────────────────
export type OracleCollected = { skipped?: string; summary?: Record<string, unknown>; items: OracleItem[] };

const TAMPER_FIX = "正解を AI が書き換えてはいけない。意図した更新なら人が確認して封印し直す(dx12_oracle {op:\"seal\"} は人の承認が要る)";

export async function collectOracleItems(call: EngineCall, baseDir: string | null, mode: string | null): Promise<OracleCollected> {
  if (!baseDir) return { skipped: "プロジェクトの場所(baseDir)が分からない", items: [] };
  let m: OracleManifest | null;
  try { m = readManifest(baseDir); }
  catch (e: any) {
    return { items: [{ check: "oracles", code: "ORACLE_MANIFEST_INVALID", level: "error", blocking: true, text: String(e?.message ?? e), fix: TAMPER_FIX }] };
  }
  if (!m) return { skipped: `正解(oracles.json)が無い(${manifestPath(baseDir)})`, items: [] };

  const items: OracleItem[] = [];
  const ledger = verifyLedger(baseDir);
  const summary: Record<string, unknown> = { sealed: ledger.sealed, ...(ledger.sealedAt ? { sealedAt: ledger.sealedAt } : {}) };
  if (!ledger.sealed) {
    items.push({ check: "oracles", code: "ORACLE_UNSEALED", level: "warning", blocking: false,
      text: "正解(金画像・性能予算)がまだ封印されていない。封印するまで AI が書き換えても検出できない",
      fix: `人が金画像と予算を確認してから ${SEAL_FIX} で封印する` });
  } else if (isTampered(ledger)) {
    const parts = [
      ...ledger.changed.map((f) => `変更: ${f}`), ...ledger.missing.map((f) => `消失: ${f}`), ...ledger.extra.map((f) => `未封印の追加: ${f}`),
    ];
    summary.tampered = { changed: ledger.changed, missing: ledger.missing, extra: ledger.extra };
    items.push({ check: "oracles", code: "ORACLE_TAMPERED", level: "error", blocking: true,
      text: `封印後に正解が変わっている(${parts.length} 件): ${parts.slice(0, 12).join(" / ")}${parts.length > 12 ? " …" : ""}`, fix: TAMPER_FIX });
  }

  const skipped: string[] = [];
  if (mode === "Playing") {
    summary.skipped = ["views/perf は Playing 中は測らない(dx12_stop してから回す)"];
    return { summary, items };
  }
  const ping = await call("ping", {}).catch(() => null);
  const scene: string | null = typeof ping?.currentScene === "string" ? ping.currentScene : (typeof ping?.currentScenePath === "string" ? ping.currentScenePath : null);

  const viewResults: Record<string, unknown>[] = [];
  for (const v of m.views) {
    if (!sceneMatches(v.scene, scene)) { skipped.push(`view:${v.name}(シーン ${v.scene} が開いていない)`); continue; }
    const golden = goldenPath(baseDir, v.name);
    if (!fs.existsSync(golden)) {
      items.push({ check: "oracles", code: "ORACLE_VIEW_MISSING", level: "error", blocking: true, name: v.name,
        text: `${v.name}: 金画像が無い(${golden})`, fix: `dx12_oracle {op:"capture", name:"${v.name}"} で撮り直し、人が確認して封印する` });
      continue;
    }
    const cur = currentPath(baseDir, v.name);
    try {
      await captureView(call, v, cur);
      const r = compareView(golden, cur, diffPath(baseDir, v.name), v.tolerance);
      if (r.reason === "size") {
        items.push({ check: "oracles", code: "ORACLE_VIEW_SIZE", level: "error", blocking: true, name: v.name,
          text: `${v.name}: 金画像 ${r.golden.width}x${r.golden.height} と今の絵 ${r.current.width}x${r.current.height} の大きさが違う`,
          fix: "views の width/height を金画像に合わせる(金画像を撮り直すなら人が確認して封印し直す)" });
        viewResults.push({ name: v.name, ok: false, size: true });
      } else {
        viewResults.push({ name: v.name, ok: r.ok, diffPct: r.diffPct });
        if (!r.ok) items.push({ check: "oracles", code: "ORACLE_VIEW_DIFF", level: "error", blocking: true, name: v.name,
          text: `${v.name}: 金画像との差 ${r.diffPct}% > 許容 ${r.maxDiffPct}%(tolerance ${r.lsb}LSB。差分 ${r.diffImage})`,
          fix: `差分画像を見て直す。意図した変更なら人が確認して金画像を撮り直し封印し直す。金画像を AI が書き換えて通してはいけない` });
      }
    } catch (e: any) {
      items.push({ check: "oracles", code: "ORACLE_VIEW_ERROR", level: "error", blocking: true, name: v.name, text: `${v.name}: 撮影に失敗: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }

  const perfResults: Record<string, unknown>[] = [];
  for (const p of m.perf) {
    if (!sceneMatches(p.scene, scene)) { skipped.push(`perf:${p.name}(シーン ${p.scene} が開いていない)`); continue; }
    try {
      const r = await runPerf(call, p);
      perfResults.push({ name: p.name, actual: r.actual, over: r.over.length });
      if (r.over.length) items.push({ check: "oracles", code: "ORACLE_PERF_OVER", level: "error", blocking: true, name: p.name,
        text: `${p.name}: 性能予算超過 ${r.over.map((o) => `${o.key} ${o.actual ?? "計測不能"} > ${o.max}`).join(", ")}`,
        fix: "重い所を直す(dx12_perf_stats で犯人を探す)。予算を緩めるのは人の判断で、封印し直しが要る" });
    } catch (e: any) {
      items.push({ check: "oracles", code: "ORACLE_PERF_ERROR", level: "error", blocking: true, name: p.name, text: `${p.name}: 計測に失敗: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  summary.views = viewResults;
  summary.perf = perfResults;
  if (skipped.length) summary.skipped = skipped;
  return { summary, items };
}
