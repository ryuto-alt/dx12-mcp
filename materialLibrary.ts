/**
 * 素材ライブラリ(dx12_material_search / dx12_blender_material_apply / dx12_material_bake の土台)。
 * PolyHaven と ambientCG(どちらも CC0・API キー不要)から PBR 素材を検索・取得し、マップ名を正規化して、
 * ORM(R=AO / G=roughness / B=metallic)を 1 枚に詰めてディスクにキャッシュする。
 *
 * ★罠(実測):
 *   ・PolyHaven の API は User-Agent が無いと 403。必ず付ける。
 *   ・PolyHaven の dimensions は mm、ambientCG の dimensionX/Y は cm(0 は不明)。どちらも m に直して sizeM で返す。
 *   ・PolyHaven のマップ名は Diffuse / Rough / nor_gl / AO / Displacement / arm / Metal …(大文字小文字が混ざる)。
 *     arm があれば ORM はそのまま作れる(Rough/AO/Metal は取らない)。nor_dx と rough_ao / spec / Bump は使わない。
 *   ・ambientCG は zip(Windows 標準の tar.exe = bsdtar で展開できる。Git Bash の GNU tar は zip を読めない)。
 *     中身は <id>_<res>_Color.jpg / _Roughness / _NormalGL / _NormalDX / _Displacement / _AmbientOcclusion / _Metalness / _Opacity / _Emission。
 *   ・ORM の詰めはユーザーの Blender(GUI)を固めないよう、窓なしの別 Blender(-b)でやる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { blenderCandidatePaths } from "./blenderBridge.ts";

// ─── 型・定数 ───────────────────────────────────────────────────────────────

export type MaterialSource = "polyhaven" | "ambientcg";
export const MATERIAL_RESOLUTIONS = ["1k", "2k", "4k", "8k"] as const;
export type MatRes = (typeof MATERIAL_RESOLUTIONS)[number];
/** 正規化したマップ名。arm だけは PolyHaven のものをそのまま持つ */
export type CanonMap = "color" | "roughness" | "metallic" | "normal_gl" | "ao" | "height" | "opacity" | "emission" | "arm";
export type MapPaths = Partial<Record<CanonMap, string>>;

export interface MaterialHit {
  source: MaterialSource;
  id: string;
  name: string;
  tags: string[];
  sizeM: [number, number] | null;
  maxRes: number;
  thumbnailUrl: string;
  license: "CC0";
  url: string;
}

export const UA = "dx12-mcp/1.0 (material library)";
const DAY_MS = 24 * 3600 * 1000;

/** キャッシュの根。DX12_MATERIALS_DIR で変えられる(テスト用)。既定 %LOCALAPPDATA%\UnoEngine\materials */
export function materialsRoot(): string {
  if (process.env.DX12_MATERIALS_DIR) return process.env.DX12_MATERIALS_DIR;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "UnoEngine", "materials");
}
export function materialDir(source: MaterialSource, id: string, res: MatRes): string {
  return path.join(materialsRoot(), source, id, res);
}

// ─── 純関数: 日本語 → 英語 ──────────────────────────────────────────────────

/** 長い語から先に当てる(「コンクリート」を「コン」より先に)。値は英語の検索語 */
const JA_EN: [string, string][] = [
  ["コンクリート", "concrete"], ["コンクリ", "concrete"], ["アスファルト", "asphalt"], ["カーペット", "carpet"], ["プラスチック", "plastic"],
  ["大理石", "marble"], ["石畳", "cobblestone"], ["砂利", "gravel"], ["レンガ", "brick"], ["煉瓦", "brick"], ["タイル", "tile"],
  ["金属", "metal"], ["真鍮", "brass"], ["ガラス", "glass"], ["漆喰", "plaster"], ["舗装", "asphalt"], ["地面", "ground"], ["樹皮", "bark"],
  ["塗装", "paint"], ["木材", "wood"], ["屋根", "roof"], ["ひび", "cracked"], ["汚れ", "dirty"], ["古い", "old"], ["濡れ", "wet"],
  ["さび", "rust"], ["サビ", "rust"], ["錆", "rust"], ["布", "fabric"], ["革", "leather"], ["皮", "leather"], ["土", "ground"], ["砂", "sand"],
  ["草", "grass"], ["壁", "wall"], ["床", "floor"], ["石", "stone"], ["岩", "rock"], ["鉄", "metal"], ["木", "wood"], ["板", "planks"],
  ["雪", "snow"], ["泥", "mud"], ["紙", "paper"], ["金", "gold"], ["銅", "copper"], ["瓦", "roof tiles"],
];

/** 検索語を英語のトークン列にする。英語はそのまま、日本語の語は表で英訳。表に無い日本語は捨てる(全部捨てたら元の文字列を返す) */
export function translateQuery(q: string): string[] {
  let s = String(q ?? "");
  const out: string[] = [];
  for (const [ja, en] of JA_EN) {
    if (s.includes(ja)) { out.push(...en.split(" ")); s = s.split(ja).join(" "); }
  }
  const ascii = s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
  const tokens = [...new Set([...ascii, ...out])];
  return tokens.length > 0 ? tokens : [String(q ?? "").trim().toLowerCase()].filter(Boolean);
}

// ─── 純関数: マップ名の正規化 ───────────────────────────────────────────────

/** PolyHaven の files のキー(Diffuse / nor_gl / arm …) → 正規名。使わないものは null */
export function normalizePolyhavenMap(key: string): CanonMap | null {
  switch (key.toLowerCase()) {
    case "diffuse": case "diff": case "albedo": return "color";
    case "rough": case "roughness": return "roughness";
    case "metal": case "metallic": case "metalness": return "metallic";
    case "nor_gl": return "normal_gl";
    case "ao": return "ao";
    case "displacement": case "disp": return "height";
    case "arm": return "arm";
    case "mask": case "opacity": return "opacity";
    case "emissive": case "emission": return "emission";
    default: return null;   // nor_dx / rough_ao / spec / Bump / blend / gltf / mtlx …
  }
}
/** ambientCG の zip 内ファイル名(<id>_<res>_Color.jpg など) → 正規名。NormalDX や preview は null */
export function normalizeAmbientMap(fileName: string): CanonMap | null {
  const stem = path.basename(fileName).replace(/\.[A-Za-z0-9]+$/, "");
  const suffix = stem.slice(stem.lastIndexOf("_") + 1).toLowerCase();
  switch (suffix) {
    case "color": return "color";
    case "roughness": return "roughness";
    case "metalness": return "metallic";
    case "normalgl": return "normal_gl";
    case "displacement": return "height";
    case "ambientocclusion": return "ao";
    case "opacity": return "opacity";
    case "emission": return "emission";
    default: return null;   // NormalDX / PREVIEW / Specular …
  }
}
export function normalizeMapName(source: MaterialSource, raw: string): CanonMap | null {
  return source === "polyhaven" ? normalizePolyhavenMap(raw) : normalizeAmbientMap(raw);
}

/** 1k/2k/4k/8k → ピクセル数 */
export function resPixels(r: MatRes): number { return parseInt(r, 10) * 1024; }
/** 要求解像度が無いとき、要求以下で最大のもの → 無ければ最小。keys は "1k" 等 */
export function pickResolutionKey(keys: string[], want: MatRes): string | null {
  const px = (k: string) => parseInt(k, 10);
  const valid = keys.filter((k) => /^\d+k$/i.test(k)).sort((a, b) => px(a) - px(b));
  if (valid.length === 0) return null;
  if (valid.includes(want)) return want;
  const lower = valid.filter((k) => px(k) <= px(want));
  return lower.length ? lower[lower.length - 1] : valid[0];
}

export interface PickedFile { url: string; ext: string; size?: number }

/**
 * PolyHaven /files/<id> から、取るファイルを決める(純関数)。
 * ・arm があれば ao / roughness / metallic は取らない(ORM が作れる)
 * ・法線は png 優先(jpg だと圧縮でノイズが乗る)、他は jpg 優先(軽い)。exr は読めないので使わない
 */
export function pickPolyhavenFiles(files: Record<string, any>, want: MatRes): { picked: Partial<Record<CanonMap, PickedFile>>; res: string | null } {
  const byCanon = new Map<CanonMap, { node: any }>();
  for (const [key, node] of Object.entries(files ?? {})) {
    const c = normalizePolyhavenMap(key);
    if (c && node && typeof node === "object") byCanon.set(c, { node });
  }
  const hasArm = byCanon.has("arm");
  const picked: Partial<Record<CanonMap, PickedFile>> = {};
  let usedRes: string | null = null;
  for (const [c, { node }] of byCanon) {
    if (hasArm && (c === "ao" || c === "roughness" || c === "metallic")) continue;
    const rk = pickResolutionKey(Object.keys(node), want);
    if (!rk) continue;
    const byFmt = node[rk] ?? {};
    const order = c === "normal_gl" ? ["png", "jpg"] : ["jpg", "png"];
    const fmt = order.find((f) => byFmt[f]?.url);
    if (!fmt) continue;
    picked[c] = { url: byFmt[fmt].url, ext: fmt, size: byFmt[fmt].size };
    if (c === "color") usedRes = rk;
    else if (!usedRes) usedRes = rk;
  }
  return { picked, res: usedRes };
}

/** ambientCG の downloads[] から zip を選ぶ。attribute は "2K-JPG" など。JPG 優先(PNG は 3 倍重い) */
export function pickAmbientDownload(downloads: any[], want: MatRes): { attribute: string; url: string; size?: number } | null {
  const rows = (downloads ?? []).filter((d) => d && /^\d+K-(JPG|PNG)$/i.test(String(d.attribute)) && d.downloadLink);
  if (rows.length === 0) return null;
  const px = (d: any) => parseInt(String(d.attribute), 10);
  const wantN = parseInt(want, 10);
  const avail = [...new Set(rows.map(px))].sort((a, b) => a - b);
  const useN = avail.includes(wantN) ? wantN : (avail.filter((n) => n <= wantN).pop() ?? avail[0]);
  const cands = rows.filter((d) => px(d) === useN);
  const best = cands.find((d) => /JPG/i.test(d.attribute)) ?? cands[0];
  return { attribute: String(best.attribute), url: String(best.downloadLink), size: best.size };
}

// ─── 純関数: ORM の詰め方 ───────────────────────────────────────────────────

export interface OrmPlan {
  mode: "arm" | "channels";
  arm?: string; ao?: string; roughness?: string; metallic?: string;
  /** 素材に無くて既定値を入れたチャンネル(結果に出す) */
  defaults: string[];
}
/**
 * ORM(R=AO / G=roughness / B=metallic)の元を決める。
 * ・arm があればそのまま(PolyHaven の arm は R=AO G=rough B=metal)
 * ・無ければ ao / roughness / metallic を 1 チャンネルずつ。無いものは AO=1 / roughness=1 / metallic=0
 *   (★rough 単体を metallicRoughness に出すと B に粗さが入って金属になる。必ず B を明示する)
 */
export function ormPlan(maps: MapPaths): OrmPlan {
  if (maps.arm) return { mode: "arm", arm: maps.arm, defaults: [] };
  const defaults: string[] = [];
  if (!maps.ao) defaults.push("R(AO)=1");
  if (!maps.roughness) defaults.push("G(roughness)=1");
  if (!maps.metallic) defaults.push("B(metallic)=0");
  return { mode: "channels", ao: maps.ao, roughness: maps.roughness, metallic: maps.metallic, defaults };
}
/** ORM 1 ピクセル分の規則(ミラー実装。Python 側と同じ。テスト用) */
export function ormPixel(plan: OrmPlan, v: { arm?: [number, number, number]; ao?: number; roughness?: number; metallic?: number }): [number, number, number] {
  if (plan.mode === "arm") return v.arm ?? [1, 1, 0];
  return [plan.ao ? (v.ao ?? 1) : 1, plan.roughness ? (v.roughness ?? 1) : 1, plan.metallic ? (v.metallic ?? 0) : 0];
}

/** 窓なしの別 Blender で ORM を詰める Python(純粋: 文字列を返すだけ)。引数は JSON ファイル({out, plan, size})。 */
export function buildOrmPackScript(): string {
  return `
import bpy, sys, json
import numpy as np

spec = json.load(open(sys.argv[sys.argv.index("--") + 1], "r", encoding="utf-8"))
plan = spec["plan"]

def load(path):
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = 'Non-Color'
    return im

def px(im, w, h):
    if tuple(im.size) != (w, h):
        im.scale(w, h)
    a = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(h, w, 4)

srcs = {k: plan.get(k) for k in ("arm", "ao", "roughness", "metallic") if plan.get(k)}
ims = {k: load(v) for k, v in srcs.items()}
W = max(im.size[0] for im in ims.values())
H = max(im.size[1] for im in ims.values())
out = np.ones((H, W, 4), dtype=np.float32)
if plan["mode"] == "arm":
    a = px(ims["arm"], W, H)
    out[..., 0:3] = a[..., 0:3]
else:
    out[..., 0] = px(ims["ao"], W, H)[..., 0] if "ao" in ims else 1.0
    out[..., 1] = px(ims["roughness"], W, H)[..., 0] if "roughness" in ims else 1.0
    out[..., 2] = px(ims["metallic"], W, H)[..., 0] if "metallic" in ims else 0.0
out[..., 3] = 1.0
o = bpy.data.images.new("orm", W, H, alpha=False, float_buffer=False, is_data=True)
o.colorspace_settings.name = 'Non-Color'
o.pixels.foreach_set(out.ravel())
o.filepath_raw = spec["out"]
o.file_format = 'PNG'
o.save()
print(json.dumps({"ok": True, "size": [W, H], "mean": [float(out[..., i].mean()) for i in range(3)], "out": spec["out"]}))
`.trim();
}

// ─── 検索 ───────────────────────────────────────────────────────────────────

export interface SearchDeps {
  /** URL から JSON を取る(キャッシュ込み)。テストで差し替える */
  getJson: (url: string, opts?: { cacheKey?: string; maxAgeMs?: number }) => Promise<any>;
}

/** 24 時間ディスクキャッシュ付きの JSON 取得(既定の実装) */
export async function cachedGetJson(url: string, opts: { cacheKey?: string; maxAgeMs?: number } = {}): Promise<any> {
  const maxAge = opts.maxAgeMs ?? DAY_MS;
  const key = opts.cacheKey ?? crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
  const file = path.join(materialsRoot(), "_cache", `${key}.json`);
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs < maxAge) return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch { /* キャッシュ無し */ }
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const json = await res.json();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(json), "utf8");
  return json;
}

const mmToM = (d: any): [number, number] | null =>
  Array.isArray(d) && d.length >= 2 && d[0] > 0 && d[1] > 0 ? [round3(d[0] / 1000), round3(d[1] / 1000)] : null;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** PolyHaven の一覧(/assets?t=textures)を語で絞って点数順に(純関数)。全語に当たるものを優先、無ければどれか 1 語 */
export function searchPolyhavenList(list: Record<string, any>, tokens: string[], limit: number): MaterialHit[] {
  const scored: { id: string; score: number; pop: number }[] = [];
  for (const [id, v] of Object.entries(list ?? {})) {
    const idName = `${id} ${v?.name ?? ""}`.toLowerCase();
    const tags = ((v?.tags ?? []) as string[]).map((t) => t.toLowerCase());
    const cats = ((v?.categories ?? []) as string[]).map((t) => t.toLowerCase());
    let hit = 0, score = 0;
    for (const t of tokens) {
      const s = (idName.includes(t) ? 3 : 0) + (tags.some((x) => x.includes(t)) ? 2 : 0) + (cats.some((x) => x.includes(t)) ? 1 : 0);
      if (s > 0) hit++;
      score += s;
    }
    if (hit === 0) continue;
    scored.push({ id, score: score + (hit === tokens.length ? 100 : 0), pop: Number(v?.download_count ?? 0) });
  }
  scored.sort((a, b) => b.score - a.score || b.pop - a.pop || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map(({ id }) => {
    const v = list[id];
    const mr = Array.isArray(v?.max_resolution) ? Number(v.max_resolution[0]) : 0;
    return {
      source: "polyhaven" as const, id, name: String(v?.name ?? id), tags: [...(v?.tags ?? []), ...(v?.categories ?? [])].slice(0, 12),
      sizeM: mmToM(v?.dimensions), maxRes: mr || 0,
      thumbnailUrl: String(v?.thumbnail_url ?? `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`),
      license: "CC0" as const, url: `https://polyhaven.com/a/${id}`,
    };
  });
}

/** ambientCG の foundAssets[] → MaterialHit(純関数)。dimensionX/Y は cm、0 は不明 */
export function ambientAssetsToHits(found: any[]): MaterialHit[] {
  return (found ?? []).map((a) => {
    const dx = Number(a?.dimensionX), dy = Number(a?.dimensionY);
    const downloads: any[] = a?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? [];
    const maxRes = Math.max(0, ...downloads.map((d) => parseInt(String(d?.attribute), 10) || 0)) * 1024;
    const thumb = a?.previewImage?.["256-JPG-FFFFFF"] ?? a?.previewImage?.["256-PNG"] ?? Object.values(a?.previewImage ?? {})[0] ?? "";
    return {
      source: "ambientcg" as const, id: String(a.assetId), name: String(a.displayName || a.assetId), tags: ((a.tags ?? []) as string[]).slice(0, 12),
      sizeM: dx > 0 && dy > 0 ? [round3(dx / 100), round3(dy / 100)] as [number, number] : null,
      maxRes, thumbnailUrl: String(thumb), license: "CC0" as const, url: String(a.shortLink ?? `https://ambientcg.com/a/${a.assetId}`),
    };
  });
}

export function ambientSearchUrl(q: string, limit: number): string {
  return `https://ambientcg.com/api/v2/full_json?type=Material&q=${encodeURIComponent(q)}&limit=${limit}&sort=Popular&include=downloadData,displayData,dimensionsData,tagData`;
}

export async function searchMaterials(
  opts: { query: string; source?: "all" | MaterialSource; limit?: number },
  deps: SearchDeps = { getJson: cachedGetJson },
): Promise<{ query: string; english: string[]; results: MaterialHit[]; warnings: string[] }> {
  const limit = Math.max(1, Math.min(30, Math.floor(opts.limit ?? 10)));
  const src = opts.source ?? "all";
  const tokens = translateQuery(opts.query);
  const warnings: string[] = [];
  const jobs: Promise<MaterialHit[]>[] = [];
  if (src === "all" || src === "polyhaven")
    jobs.push(deps.getJson("https://api.polyhaven.com/assets?t=textures", { cacheKey: "polyhaven_textures" })
      .then((l) => searchPolyhavenList(l, tokens, limit))
      .catch((e) => { warnings.push(`PolyHaven の検索に失敗: ${(e as Error).message}`); return []; }));
  if (src === "all" || src === "ambientcg")
    jobs.push((async () => {
      try {
        // ambientCG の q は 1 語のほうが当たる。全語で 0 件なら先頭語で撮り直す
        let r = await deps.getJson(ambientSearchUrl(tokens.join(" "), limit));
        if (!(r?.foundAssets?.length) && tokens.length > 1) r = await deps.getJson(ambientSearchUrl(tokens[0], limit));
        return ambientAssetsToHits(r?.foundAssets ?? []);
      } catch (e) { warnings.push(`ambientCG の検索に失敗: ${(e as Error).message}`); return []; }
    })());
  const lists = await Promise.all(jobs);
  // 交互に混ぜる(片方に偏らない)
  const merged: MaterialHit[] = [];
  for (let i = 0; merged.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && merged.length < limit) merged.push(l[i]);
  return { query: opts.query, english: tokens, results: merged, warnings };
}

// ─── ダウンロード・キャッシュ・ORM ──────────────────────────────────────────

export function findBlenderExe(): string | null {
  if (process.env.DX12_BLENDER_EXE && fs.existsSync(process.env.DX12_BLENDER_EXE)) return process.env.DX12_BLENDER_EXE;
  return blenderCandidatePaths().find((p) => fs.existsSync(p)) ?? null;
}

async function download(url: string, dest: string): Promise<number> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`ダウンロードに失敗 HTTP ${res.status}: ${url}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  await fs.promises.rename(tmp, dest);
  return (await fs.promises.stat(dest)).size;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} が失敗: ${err.message}\n${String(stderr).slice(-800)}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** zip を展開(Windows 標準の bsdtar。GNU tar は zip を読めないので System32 を直指定) */
export async function extractZip(zip: string, dir: string): Promise<void> {
  const sys = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  await fs.promises.mkdir(dir, { recursive: true });
  await run(fs.existsSync(sys) ? sys : "tar", ["-xf", zip, "-C", dir], 10 * 60_000);
}

/** 窓なしの別 Blender で ORM を詰める。ユーザーの Blender(GUI)は触らない */
export async function packOrm(plan: OrmPlan, out: string): Promise<{ size: [number, number]; mean: number[] }> {
  const exe = findBlenderExe();
  if (!exe) throw new Error("blender.exe が見つからない(ORM の詰めに窓なしの別 Blender を使う)。DX12_BLENDER_EXE で指定できる");
  const tmpDir = path.join(materialsRoot(), "_cache");
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const stamp = `${process.pid}_${Date.now()}`;
  const py = path.join(tmpDir, `pack_orm_${stamp}.py`), spec = path.join(tmpDir, `pack_orm_${stamp}.json`);
  await fs.promises.writeFile(py, buildOrmPackScript(), "utf8");
  await fs.promises.writeFile(spec, JSON.stringify({ out: out.replace(/\\/g, "/"), plan }), "utf8");
  try {
    const { stdout } = await run(exe, ["-b", "-noaudio", "--factory-startup", "--python-exit-code", "1", "--python", py, "--", spec], 10 * 60_000);
    const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("{") && l.includes('"ok"'));
    if (!line) throw new Error(`ORM 詰めの結果を読めなかった: ${stdout.slice(-400)}`);
    const j = JSON.parse(line);
    return { size: j.size, mean: j.mean };
  } finally {
    await fs.promises.rm(py, { force: true }); await fs.promises.rm(spec, { force: true });
  }
}

export interface MaterialMeta {
  source: MaterialSource; id: string; name: string; license: "CC0"; url: string;
  sizeM: [number, number] | null; resolution: string; requestedResolution: MatRes;
  maps: Record<string, string>;          // 正規名 → ファイル名(ディレクトリ内)
  orm: { mode: "arm" | "channels"; defaults: string[]; mean: number[]; size: [number, number] };
  fetchedAt: string; complete: boolean; downloadBytes?: number; warnings?: string[];
}
export interface EnsuredMaterial {
  dir: string; maps: MapPaths; orm: string; meta: MaterialMeta; cached: boolean; warnings: string[];
}

/** 8k は数百 MB。結果で警告する */
export function resolutionWarning(res: MatRes, bytes?: number): string | null {
  if (res !== "8k") return null;
  return `8k は大きい(${bytes ? Math.round(bytes / 1048576) + " MB" : "数百 MB"})。1 UV あたり 8192px はエンジンのメモリも食う。必要がなければ 2k か 4k で足りる`;
}

async function readMeta(dir: string): Promise<MaterialMeta | null> {
  try { const m = JSON.parse(await fs.promises.readFile(path.join(dir, "meta.json"), "utf8")); return m?.complete ? m : null; } catch { return null; }
}

export interface EnsureDeps {
  getJson: SearchDeps["getJson"];
  download: typeof download;
  extractZip: typeof extractZip;
  packOrm: typeof packOrm;
}
const REAL_DEPS: EnsureDeps = { getJson: cachedGetJson, download, extractZip, packOrm };

/**
 * 素材を取って(キャッシュ済みなら取らず)ORM まで作る。
 * 保存先: <root>\<source>\<id>\<res>\ { color.jpg, normal_gl.png, height.jpg, orm.png, meta.json, … }
 * orm.png が既にあれば作り直さない。
 */
export async function ensureMaterial(
  opts: { source: MaterialSource; id: string; resolution?: MatRes; hit?: MaterialHit },
  deps: EnsureDeps = REAL_DEPS,
): Promise<EnsuredMaterial> {
  const want: MatRes = opts.resolution ?? "2k";
  const dir = materialDir(opts.source, opts.id, want);
  const warnings: string[] = [];
  const cachedMeta = await readMeta(dir);
  const ormPath = path.join(dir, "orm.png");
  if (cachedMeta && fs.existsSync(ormPath)) {
    const maps: MapPaths = {};
    for (const [k, f] of Object.entries(cachedMeta.maps)) maps[k as CanonMap] = path.join(dir, f);
    const w = resolutionWarning(want); if (w) warnings.push(w);
    return { dir, maps, orm: ormPath, meta: cachedMeta, cached: true, warnings };
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};     // 正規名 → ファイル名
  let totalBytes = 0, usedRes = want as string, name = opts.hit?.name ?? opts.id, sizeM = opts.hit?.sizeM ?? null;
  const url = opts.hit?.url ?? (opts.source === "polyhaven" ? `https://polyhaven.com/a/${opts.id}` : `https://ambientcg.com/a/${opts.id}`);

  if (opts.source === "polyhaven") {
    const [info, list] = await Promise.all([
      deps.getJson(`https://api.polyhaven.com/info/${encodeURIComponent(opts.id)}`, { cacheKey: `polyhaven_info_${opts.id}` }),
      deps.getJson(`https://api.polyhaven.com/files/${encodeURIComponent(opts.id)}`, { cacheKey: `polyhaven_files_${opts.id}` }),
    ]);
    name = String(info?.name ?? name);
    sizeM = mmToM(info?.dimensions) ?? sizeM;
    const { picked, res } = pickPolyhavenFiles(list, want);
    if (!picked.color) throw new Error(`PolyHaven ${opts.id} に Diffuse が無い(テクスチャ素材ではない?)`);
    if (res && res !== want) warnings.push(`${want} が無いので ${res} で取った`);
    usedRes = res ?? want;
    for (const [c, f] of Object.entries(picked) as [CanonMap, PickedFile][]) {
      const fn = `${c}.${f.ext}`;
      totalBytes += await deps.download(f.url, path.join(dir, fn));
      files[c] = fn;
    }
  } else {
    const r = await deps.getJson(`https://ambientcg.com/api/v2/full_json?type=Material&id=${encodeURIComponent(opts.id)}&include=downloadData,dimensionsData`, { cacheKey: `ambientcg_asset_${opts.id}` });
    const a = (r?.foundAssets ?? []).find((x: any) => x.assetId === opts.id);
    if (!a) throw new Error(`ambientCG に ${opts.id} が無い(ID は大文字小文字を区別する。例 Bricks075A)`);
    name = String(a.displayName || a.assetId);
    const dx = Number(a.dimensionX), dy = Number(a.dimensionY);
    if (dx > 0 && dy > 0) sizeM = [round3(dx / 100), round3(dy / 100)];
    const pick = pickAmbientDownload(a?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? [], want);
    if (!pick) throw new Error(`ambientCG ${opts.id} に zip のダウンロードが無い`);
    usedRes = pick.attribute.split("-")[0].toLowerCase();
    if (usedRes !== want) warnings.push(`${want} が無いので ${usedRes} で取った`);
    const zip = path.join(dir, "_download.zip");
    totalBytes += await deps.download(pick.url, zip);
    const ex = path.join(dir, "_zip");
    await fs.promises.rm(ex, { recursive: true, force: true });
    await deps.extractZip(zip, ex);
    for (const f of await fs.promises.readdir(ex)) {
      const c = normalizeAmbientMap(f);
      if (!c) continue;
      const fn = `${c}${path.extname(f).toLowerCase()}`;
      await fs.promises.rename(path.join(ex, f), path.join(dir, fn));
      files[c] = fn;
    }
    await fs.promises.rm(ex, { recursive: true, force: true });
    await fs.promises.rm(zip, { force: true });
    if (!files.color) throw new Error(`ambientCG ${opts.id} の zip に Color が無かった`);
  }

  const maps: MapPaths = {};
  for (const [c, f] of Object.entries(files)) maps[c as CanonMap] = path.join(dir, f);
  const plan = ormPlan(maps);
  const packed = await deps.packOrm(plan, ormPath);
  const w = resolutionWarning(want, totalBytes); if (w) warnings.push(w);
  const meta: MaterialMeta = {
    source: opts.source, id: opts.id, name, license: "CC0", url, sizeM, resolution: usedRes, requestedResolution: want,
    maps: files, orm: { mode: plan.mode, defaults: plan.defaults, mean: packed.mean, size: packed.size },
    fetchedAt: new Date().toISOString(), complete: true, downloadBytes: totalBytes, ...(warnings.length ? { warnings } : {}),
  };
  await fs.promises.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return { dir, maps, orm: ormPath, meta, cached: false, warnings };
}

/**
 * source / id / query から素材を 1 つに決める。id があればそれ(source 省略なら PolyHaven → ambientCG の順で存在確認)、
 * 無ければ query の検索 1 位。
 */
export async function resolveMaterial(
  opts: { source?: "all" | MaterialSource; id?: string; query?: string },
  deps: SearchDeps = { getJson: cachedGetJson },
): Promise<MaterialHit> {
  if (opts.id) {
    const src = opts.source && opts.source !== "all" ? opts.source : undefined;
    if (src === "polyhaven" || (!src && /^[a-z0-9_]+$/.test(opts.id))) {
      try {
        const info = await deps.getJson(`https://api.polyhaven.com/info/${encodeURIComponent(opts.id)}`, { cacheKey: `polyhaven_info_${opts.id}` });
        if (info?.name) return { source: "polyhaven", id: opts.id, name: String(info.name), tags: [...(info.tags ?? [])].slice(0, 12), sizeM: mmToM(info.dimensions), maxRes: Array.isArray(info.max_resolution) ? info.max_resolution[0] : 0, thumbnailUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${opts.id}.png?width=256&height=256`, license: "CC0", url: `https://polyhaven.com/a/${opts.id}` };
      } catch { if (src) throw new Error(`PolyHaven に ${opts.id} が無い`); }
    }
    const r = await deps.getJson(`https://ambientcg.com/api/v2/full_json?type=Material&id=${encodeURIComponent(opts.id)}&include=downloadData,displayData,dimensionsData,tagData`, { cacheKey: `ambientcg_hit_${opts.id}` });
    const hits = ambientAssetsToHits((r?.foundAssets ?? []).filter((a: any) => a.assetId === opts.id));
    if (hits.length) return hits[0];
    throw new Error(`素材 ${opts.id} が見つからない。dx12_material_search で ID を確かめる`);
  }
  if (!opts.query) throw new Error("id か query のどちらかが要る");
  const r = await searchMaterials({ query: opts.query, source: opts.source ?? "all", limit: 1 }, deps);
  if (!r.results.length) throw new Error(`素材が見つからない: ${opts.query}(英訳: ${r.english.join(" ")})${r.warnings.length ? " / " + r.warnings.join(" / ") : ""}`);
  return r.results[0];
}
