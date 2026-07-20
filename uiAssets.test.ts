import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveGoogleFontTtfUrl, downloadFont } from "./uiAssets.ts";

// ★実ネットワークを使うテスト(Google Fonts API)。オフラインでは失敗する。

// TTF/OTF の sfnt マジック判定
const isFontMagic = (buf: Buffer) => {
  const tag = buf.subarray(0, 4).toString("latin1");
  return buf.readUInt32BE(0) === 0x00010000 || tag === "OTTO" || tag === "true";
};

// URL 解決: Roboto(既定ウェイト) と Noto Sans JP(700)
const robotoUrl = await resolveGoogleFontTtfUrl("Roboto");
assert.match(robotoUrl, /^https:\/\/fonts\.gstatic\.com\/.+\.ttf$/);

const notoUrl = await resolveGoogleFontTtfUrl("Noto Sans JP", 700);
assert.match(notoUrl, /^https:\/\/fonts\.gstatic\.com\/.+\.ttf$/);

// 存在しないファミリーはエラー
await assert.rejects(() => resolveGoogleFontTtfUrl("NoSuchFontFamilyXyz123"));

// ダウンロード: 先頭バイトが TTF/OTF マジックであること・ファイル名形式
const roboto = await downloadFont("Roboto", 700);
assert.equal(roboto.fileName, "Roboto-700.ttf");
assert.ok(isFontMagic(fs.readFileSync(roboto.tmpPath)));

const noto = await downloadFont("Noto Sans JP");
assert.equal(noto.fileName, "NotoSansJP-400.ttf");
const notoBuf = fs.readFileSync(noto.tmpPath);
assert.ok(isFontMagic(notoBuf));
assert.ok(notoBuf.length > 100_000, "日本語フォントとしてサイズが小さすぎる");

console.log("OK: UIアセット(フォント導入)テスト通過");
