// 旧 220 ツールの「表面」(tools/list)を固定するスナップショットを作る/検査する。
//   node scripts/gen_legacy_snapshot.mjs            … legacy-tools.snapshot.json を作り直す(意図して旧ツールを変えたときだけ)
//   node scripts/gen_legacy_snapshot.mjs --check    … 現在の tools/list(DX12_MCP_TOOLSET=legacy)とスナップショットの一致を検査
//
// スナップショットの中身: ツールごとに { name, sha256(tools/list の 1 ツール分の JSON), argKeys, annotations } と、
// 全体の { count, totalBytes }。M0 時点(index.ts 分割前)の値を基準にしている。
// 旧ツールの名前・引数・説明・スキーマが 1 バイトでも変わるとハッシュが変わる(意図した変更なら --update)。

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const snapPath = path.join(root, "legacy-tools.snapshot.json");

export async function listTools(toolset = "legacy") {   // toolset = DX12_MCP_SURFACE の値(legacy / full / core / shell)
  const proc = spawn(process.execPath, [path.join(root, "index.ts")], {
    cwd: root, env: { ...process.env, DX12_MCP_SURFACE: toolset, DX12_MCP_TOOLSET: "", DX12_MCP_PORT: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = ""; const pend = new Map(); let id = 1;
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { const m = JSON.parse(l); pend.get(m.id)?.(m); } } });
  const rpc = (method, params = {}) => new Promise((res, rej) => { const n = id++; const t = setTimeout(() => rej(new Error("timeout " + method)), 30000); pend.set(n, (m) => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "snapshot", version: "0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const r = await rpc("tools/list");
    return { tools: r.result.tools, bytes: Buffer.byteLength(JSON.stringify(r.result)) };
  } finally { proc.kill(); }
}

// M3 で tools/list の annotations に destructiveHint:true を足した guarded な旧ツール(ヒントを足しただけで、許可・確認は緩めていない)。
// 旧ツールの「意味的な同一性」の比較では、この 1 キーだけを両側から外す(足したこと自体は toolSurface.test.ts が別に検査する)。
export const M3_DESTRUCTIVE_HINT_ADDED = [
  "dx12_eval_lua", "dx12_net_launch_test_client", "dx12_git_checkout", "dx12_git_merge", "dx12_git_merge_abort",
  "dx12_git_commit", "dx12_git_push", "dx12_git_pull",
];

/**
 * 旧ツールの「意味的な同一性」用の正規化: 情報の無い共通 outputSchema({result:any})と、M3 が足した destructiveHint を外す。
 * 名前・title・説明・inputSchema・(それ以外の)annotations・_meta が 1 バイトでも変わればハッシュが変わる。
 */
export function semanticView(t) {
  const { outputSchema: _o, ...rest } = t;
  if (M3_DESTRUCTIVE_HINT_ADDED.includes(t.name) && rest.annotations) {
    const { destructiveHint: _d, ...ann } = rest.annotations;
    return { ...rest, annotations: ann };
  }
  return rest;
}
export const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

export function summarize(tools, bytes) {
  return {
    _doc: "旧 220 ツールの tools/list を固定したスナップショット(scripts/gen_legacy_snapshot.mjs で生成/--check で検査)。sha256 は M0 時点の tools/list の 1 ツール分の JSON.stringify(legacy モードと完全一致)。semSha256 は outputSchema と M3 が足した destructiveHint を外した『意味的な同一性』のハッシュ(full / core 面の旧ツールはこちらで比較)。outputSchemaBytes は M3 で削った outputSchema の JSON バイト数。",
    count: tools.length,
    totalBytes: bytes,
    outputSchemaBytesTotal: tools.reduce((a, t) => a + (t.outputSchema ? Buffer.byteLength(JSON.stringify(t.outputSchema)) : 0), 0),
    tools: tools.map((t) => ({
      name: t.name,
      sha256: sha(t),
      semSha256: sha(semanticView(t)),
      outputSchemaBytes: t.outputSchema ? Buffer.byteLength(JSON.stringify(t.outputSchema)) : 0,
      argKeys: Object.keys(t.inputSchema?.properties ?? {}),
      annotations: t.annotations ?? {},
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { tools, bytes } = await listTools("legacy");
  const cur = summarize(tools, bytes);
  if (process.argv.includes("--check")) {
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    const diffs = [];
    if (snap.count !== cur.count) diffs.push(`count ${snap.count} -> ${cur.count}`);
    if (snap.totalBytes !== cur.totalBytes) diffs.push(`totalBytes ${snap.totalBytes} -> ${cur.totalBytes}`);
    const byName = new Map(snap.tools.map((t) => [t.name, t]));
    for (const t of cur.tools) { const s = byName.get(t.name); if (!s) diffs.push(`新規: ${t.name}`); else if (s.sha256 !== t.sha256) diffs.push(`変更: ${t.name}`); }
    for (const s of snap.tools) if (!cur.tools.some((t) => t.name === s.name)) diffs.push(`消失: ${s.name}`);
    if (JSON.stringify(snap.tools.map((t) => t.name)) !== JSON.stringify(cur.tools.map((t) => t.name))) diffs.push("並びが変わった");
    if (diffs.length) { console.log("NG: 旧 220 ツールの表面が変わっている\n" + diffs.slice(0, 20).join("\n")); process.exit(1); }
    console.log(`OK: legacy ${cur.count} ツール / ${cur.totalBytes} バイトがスナップショットと一致`);
  } else {
    fs.writeFileSync(snapPath, JSON.stringify(cur, null, 1) + "\n");
    console.log(`wrote ${snapPath}: ${cur.count} tools, ${cur.totalBytes} bytes`);
  }
}
