import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// UI 素材(フォント等)導入のための pure ヘルパ群。MCP/EngineClient に依存しない。
// Google Fonts CSS2 API から .ttf を解決してローカルへ落とすところまでを担当し、
// assets への取り込み(import_asset)は index.ts 側のツール登録が engine.call で行う。

// 古い UA を名乗ると Google Fonts は woff2 でなく truetype(.ttf) の @font-face を返す。
// (woff2 非対応ブラウザ向けフォールバックの仕組みを利用)
const LEGACY_UA = "Mozilla/5.0 (Windows NT 6.1)";

// Google Fonts CSS2 API から指定ファミリー/ウェイトの .ttf URL を解決する。
// weight 省略時は既定ウェイト(400 相当)を要求する。
export async function resolveGoogleFontTtfUrl(family: string, weight?: number): Promise<string> {
  const fam = family.trim();
  if (!fam) throw new Error("family が空です。例: 'Roboto', 'Noto Sans JP'");
  let spec = encodeURIComponent(fam).replace(/%20/g, "+");
  if (weight != null) spec += `:wght@${weight}`;
  const cssUrl = `https://fonts.googleapis.com/css2?family=${spec}`;
  const res = await fetch(cssUrl, { headers: { "User-Agent": LEGACY_UA } });
  if (!res.ok) {
    throw new Error(`Google Fonts がフォントを返しません (HTTP ${res.status})。ファミリー名 '${fam}' やウェイト ${weight ?? "(既定)"} が正しいか確認して。`);
  }
  const css = await res.text();
  // 古い UA なら src: url(https://fonts.gstatic.com/...ttf) format('truetype') の形で来る。
  const m = css.match(/url\((https:\/\/[^)]+?\.ttf)\)/);
  if (!m) throw new Error(`CSS 内に .ttf URL が見つかりません。API 仕様変更の可能性あり。取得 CSS 先頭: ${css.slice(0, 200)}`);
  return m[1];
}

// ttf を os.tmpdir() へダウンロードする。fileName は "<family>-<weight>.ttf"(スペース除去)。
export async function downloadFont(family: string, weight?: number): Promise<{ tmpPath: string; fileName: string }> {
  const url = await resolveGoogleFontTtfUrl(family, weight);
  const res = await fetch(url, { headers: { "User-Agent": LEGACY_UA } });
  if (!res.ok) throw new Error(`フォントのダウンロードに失敗 (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // TTF: 0x00010000 / 'true'、OTF: 'OTTO' のマジックで最低限の健全性チェック。
  const magic = buf.subarray(0, 4).toString("latin1");
  const isSfnt = (buf.readUInt32BE(0) === 0x00010000) || magic === "OTTO" || magic === "true";
  if (!isSfnt) throw new Error("ダウンロードした内容が TTF/OTF ではありません。");
  const fileName = `${family.replace(/\s+/g, "")}-${weight ?? 400}.ttf`;
  const tmpPath = path.join(os.tmpdir(), fileName);
  await fs.writeFile(tmpPath, buf);
  return { tmpPath, fileName };
}
