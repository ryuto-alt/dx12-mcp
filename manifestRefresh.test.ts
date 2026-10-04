// 再起動不要のツール追加テスト(設計書 §5.2 M1 合否基準 ③)。
//   MCP サーバのプロセスを【再起動せず】、偽エンジンに method を足す(= エンジンを再ビルド・再起動したのと同じ:
//   ping.manifestHash が変わる)→ 次の dx12_tool_search / dx12_tool_describe / dx12_call がそれを扱える。
//   TS ラッパも、Claude Code の再起動も要らない。
// 実行: node manifestRefresh.test.ts

import "./testEnv.ts";   // フリートのレジストリを一時フォルダへ隔離(実ユーザーの %LOCALAPPDATA% を触らない)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startMockEngine } from "./mockEngine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockEngine({});
const proc = spawn(process.execPath, [path.join(here, "index.ts")], {
  env: { ...process.env, DX12_MCP_PORT: String(mock.port), DX12_MCP_CONNECT_BACKOFF_MS: "0" }, stdio: ["pipe", "pipe", "pipe"],
});
let buf = ""; let nid = 1; const pend = new Map<number, (m: any) => void>();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (d: string) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { const m = JSON.parse(l); pend.get(m.id)?.(m); } } });
const rpc = (method: string, params: any = {}) => new Promise<any>((res, rej) => { const id = nid++; const t = setTimeout(() => rej(new Error("timeout " + method)), 30000); pend.set(id, (m) => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name: string, args: any = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content.slice(-1)[0].text);
const pid = proc.pid;

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "refresh.test", version: "0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const tools0 = (await rpc("tools/list")).result.tools;

  console.log("[1] 追加前");
  const hash0 = mock.manifestHash();
  const before = await call("dx12_tool_describe", { name: "make_fog_bank" });
  check("追加前: 未知の method は E_UNKNOWN_TOOL", before.error_code === "E_UNKNOWN_TOOL", before);
  const d0 = await call("dx12_doctor", {});
  check("追加前: doctor がエンジンのマニフェスト(live)と版を報告", d0.ok === true && d0.engine.manifestHash === hash0 && d0.versions.manifestSource === "live", d0.versions);

  console.log("[2] エンジンに method を足す(TS・MCP サーバは触らない)");
  mock.addMethod({
    name: "make_fog_bank", category: "render", summary: "霧の塊を置く(テスト用の新 method)", keywords: "fog bank mist 霧 もや", effect: "write_scene", mode: "any",
    timeoutMs: 4000, idempotent: true,
    params: [
      { name: "name", type: "string", required: true, desc: "作る霧の名前" },
      { name: "density", type: "number", min: 0, max: 5, default: 1, desc: "濃さ" },
      { name: "shape", type: "enum", enum: ["sphere", "box"], default: "sphere" },
    ],
    examples: [{ args: { name: "Fog1", density: 2 }, note: "球状の霧" }], source: "meta",
    handler: (p: any) => ({ created: p.name, density: p.density ?? 1, shape: p.shape ?? "sphere" }),
  } as any);
  check("マニフェストのハッシュが変わった", mock.manifestHash() !== hash0);
  await sleep(3200);   // 確認の間引き(3 秒)を越える。実運用でも新 method を撃つ側は force で取り直すので待たなくてよい

  console.log("[3] 追加後: 再起動なしで発見・確認・実行");
  const s = await call("dx12_tool_search", { query: "make_fog_bank" });
  check("dx12_tool_search でヒット(先頭)", s.hits[0]?.name === "make_fog_bank" && s.catalog.source === "live", s.hits?.map((h: any) => h.name));
  const s2 = await call("dx12_tool_search", { query: "霧の塊を置く" });
  check("日本語の説明でもヒット", s2.hits.some((h: any) => h.name === "make_fog_bank"), s2.hits.map((h: any) => h.name));
  const d = await call("dx12_tool_describe", { name: "make_fog_bank" });
  check("dx12_tool_describe: 引数(型・必須・範囲・enum)・例・callTemplate", d.kind === "method" && d.params.find((p: any) => p.name === "density")?.max === 5 && d.params.find((p: any) => p.name === "shape")?.enum?.includes("box") && d.examples[0]?.args?.name === "Fog1" && d.callTemplate.args.name, d);
  const r = await call("dx12_call", { name: "make_fog_bank", args: { name: "Fog1", density: 3 } });
  check("dx12_call で実行できる", r.ok === true && r.result.created === "Fog1" && r.result.density === 3 && r.meta.method === "make_fog_bank", r);
  const bad = await call("dx12_call", { name: "make_fog_bank", args: { name: "Fog1", shape: "spher" } });
  check("追加した method にもスキーマ検証(enum 違い → E_BAD_ENUM + didYouMean)がかかる", bad.error_code === "E_BAD_ENUM" && bad.validValues?.includes("box") && bad.didYouMean?.[0] === "sphere" && bad.fix?.[0]?.args?.shape === "sphere", bad);
  const dry = await call("dx12_call", { name: "make_fog_bank", args: { name: "Fog2" }, dryRun: true });
  check("追加した method の dryRun は実行しない", dry.dryRun === true && dry.executed === false && !mock.received.some((x) => x.method === "make_fog_bank" && x.params.name === "Fog2"), dry);
  const d1 = await call("dx12_doctor", {});
  check("doctor のマニフェストのハッシュが更新され、エンジンと一致", d1.engine.manifestHash === mock.manifestHash() && d1.versions.hashMatch === true, d1.versions);
  const tools1 = (await rpc("tools/list")).result.tools;
  check("tools/list は変えずに済む(list_changed に依存しない)", tools1.length === tools0.length);
  check("同じ MCP サーバのプロセスのまま(再起動していない)", proc.exitCode === null && proc.pid === pid);

  console.log("[4] エンジンが method を消して再起動(切断 → 自動再接続)");
  mock.removeMethod("make_fog_bank");
  mock.dropConnections();
  await sleep(150);
  const gone = await call("dx12_call", { name: "make_fog_bank", args: { name: "Fog3" } });
  check("消えた method は E_UNKNOWN_TOOL(エンジンが知らない)。マニフェストも取り直す", gone.error_code === "E_UNKNOWN_TOOL", gone);
  await sleep(300);
  const s3 = await call("dx12_tool_search", { query: "make_fog_bank" });
  check("取り直し後は検索にも出ない", !s3.hits.some((h: any) => h.name === "make_fog_bank"), s3.hits.map((h: any) => h.name));

  console.log("[5] マニフェストを持たない古いエンジン");
  mock.state.legacyEngine = true;
  mock.dropConnections();
  await sleep(150);
  const old = await call("dx12_doctor", {});
  check("doctor: E_ENGINE_TOO_OLD を warn で知らせる(直し方つき)", old.issues.some((i: any) => i.code === "E_ENGINE_TOO_OLD" && i.severity === "warn" && i.fix?.length), old.issues);
  const od = await call("dx12_tool_describe", { name: "list_entities" });
  check("古いエンジンでも describe_mcp_params から型だけのマニフェストで動く(旧ツールは TS の定義が正)", od.name === "dx12_list_entities" && od.params.length > 0, od.name);
  const oc = await call("dx12_call", { name: "dx12_list_entities", args: {} });
  check("古いエンジンでも dx12_call は動く", oc.ok === true, oc);
} finally {
  proc.kill();
  await mock.close();
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: 再起動不要テスト ${total} 項目すべて通過`);
process.exit(0);
