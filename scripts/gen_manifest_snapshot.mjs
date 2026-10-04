// エンジンのマニフェスト(describe_mcp_manifest)を manifest.snapshot.json に保存する。
//   node scripts/gen_manifest_snapshot.mjs [--port 8850]
//
// 用途: エンジンに繋がっていない間の dx12_tool_search / dx12_tool_describe の代役(オフライン起動・CI)。
// 実行中はエンジンのマニフェストが常に優先される(ping.manifestHash が違えば取り直す)ので、
// スナップショットが古くても壊れない(dx12_doctor が版ずれを知らせる)。
// エンジンに method を足したらリポジトリ側で 1 度更新して一緒にコミットする。
//
// ★エンジンは必ず --background で起動しておく(人のカーソルを奪わない):
//   DX12Engine.exe --background --project <プロジェクトのフォルダ> --mcp-port 8850
// ★接続は 1 本だけ。他の MCP セッションがエンジンを握っていると応答が来ない。

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "manifest.snapshot.json");

function discoverPort() {
  const i = process.argv.indexOf("--port");
  if (i >= 0) return Number(process.argv[i + 1]);
  if (process.env.DX12_MCP_PORT) return Number(process.env.DX12_MCP_PORT);
  try { return Number(fs.readFileSync(path.join(os.tmpdir(), "dx12_mcp.port"), "utf8").trim()); } catch { return 8787; }
}

const port = discoverPort();
const sock = net.connect(port, "127.0.0.1");
let buf = "";
const result = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout: エンジンが応答しない(別セッションが握っていないか確認)")), 15000);
  sock.on("error", (e) => reject(new Error(`エンジンに繋がらない (127.0.0.1:${port}): ${e.message}`)));
  sock.on("connect", () => sock.write(JSON.stringify({ id: 1, method: "describe_mcp_manifest", params: {} }) + "\n"));
  sock.on("data", (d) => {
    buf += d.toString();
    const i = buf.indexOf("\n");
    if (i < 0) return;
    clearTimeout(t);
    const m = JSON.parse(buf.slice(0, i));
    if (m.ok === false) reject(new Error(`describe_mcp_manifest が失敗: ${m.error}`)); else resolve(m.result);
  });
});
sock.destroy();

const methods = result.methods.map((m) => "  " + JSON.stringify(m));
const head = { protocol: result.protocol, manifestHash: result.manifestHash, engineVersion: result.engineVersion, count: result.count, categories: result.categories };
const text = JSON.stringify(head).slice(0, -1) + `,"methods":[\n${methods.join(",\n")}\n]}\n`;
fs.writeFileSync(out, text);
console.log(`wrote ${out}: ${result.count} methods, hash ${result.manifestHash}, ${Buffer.byteLength(text)} bytes`);
