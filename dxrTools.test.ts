/**
 * DXR ツール(dx12_get_dxr / dx12_set_dxr)の e2e テスト。ネット不要・エディタ不要。
 *
 * ★何を担保するか
 *   1) 偽エンジン(TCP スタブ)を立てて index.ts を stdio で起動し、tools/list が
 *      全ツールを返すこと・$ref が無いこと・名前が重複していないことを見る。
 *      ($ref は sceneTools.ts の v3() 事故と同じ罠。$ref を解決しないクライアントで
 *       「received string」の誤判定になり、その引数が一生渡せなくなる)
 *   2) ★非対応 GPU の経路。set_dxr はエンジンが error_code:2 で必ず落とす。
 *      これを素のエラーで返すと引数不正と区別が付かず、AI が値を変えて撃ち直し続ける。
 *      ここでは「エラーではない結果 + retryable:false + 代替手段」で返り、
 *      しかも【set_dxr を一発も撃たない】(get_dxr で先に確定させる)ことを固定する。
 *   3) 対応 GPU の経路。applyAndVerify で読み返し、エンジンがクランプしたら
 *      applied:false + mismatched になること(「入ったつもり」で嘘をつかない)。
 *   4) dx12_render_debug が新モード rt / rtDiff を弾かずエンジンまで通すこと。
 *
 * 実行: node dxrTools.test.ts
 */

import assert from "node:assert/strict";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.join(here, "index.ts");

let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };

// ── 偽エンジン(TCP) ────────────────────────────────────────────
// 改行区切り JSON。received に届いた method を溜めて「何回撃ったか」を検証できるようにする。

type EngineHandler = (method: string, params: any) => { result?: any; error?: { code: number; message: string; hint?: string } };

async function startFakeEngine(handler: EngineHandler) {
  const received: { method: string; params: any }[] = [];
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("error", () => { /* テスト終了時の切断は無視 */ });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        received.push({ method: req.method, params: req.params });
        const r = handler(req.method, req.params ?? {});
        const resp = r.error
          ? { id: req.id, ok: false, error_code: r.error.code, error: r.error.message, error_hint: r.error.hint }
          : { id: req.id, ok: true, result: r.result ?? null };
        sock.write(JSON.stringify(resp) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port, received };
}

// ── MCP クライアント(stdio・最小実装) ──────────────────────────

class McpStdio {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  stderr = "";

  constructor(port: number) {
    this.proc = spawn(process.execPath, [INDEX_TS], {
      env: { ...process.env, DX12_MCP_PORT: String(port), DX12_MCP_HOST: "127.0.0.1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => { this.stderr += d; });
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const p = msg.id != null ? this.pending.get(msg.id) : undefined;
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }

  private send(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}\n${this.stderr}`)), 20000);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: any) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async init() {
    const r = await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dxrTools.test", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }

  listTools = () => this.send("tools/list", {});
  callTool = (name: string, args: any) => this.send("tools/call", { name, arguments: args });
  kill() { this.proc.kill(); }
}

/** ツール結果の content[0].text を JSON として読む。 */
function payload(res: any): any {
  const text = res?.result?.content?.[0]?.text;
  assert.ok(typeof text === "string", `content[0].text が無い: ${JSON.stringify(res)}`);
  return JSON.parse(text);
}

// ── 偽エンジンの DXR 状態 ───────────────────────────────────────

const DXR_DEFAULTS = {
  shadowEnabled: false, shadowSunAngle: 0.53, shadowNormalBias: 0.02,
  shadowMaxDistance: 0, shadowIntensity: 1,
  aoEnabled: false, aoRadius: 1, aoRayCount: 2, aoIntensity: 1, aoPower: 1.5,
  aoCombineWithSsao: false, aoDenoise: true, aoDenoiseRadius: 8,
  maxInstances: 0, forceBuildTlas: false,
  // DDGI（計画09 Step 6 / 段階1）。既定は DdgiSettings（src/renderer/DdgiVolume.h）と同じ。
  ddgiEnabled: false, ddgiSpacing: 2, ddgiProbeCountX: 8, ddgiProbeCountY: 4, ddgiProbeCountZ: 8,
  ddgiOriginX: -8, ddgiOriginY: 0.5, ddgiOriginZ: -8,
  ddgiRayLength: 30, ddgiHysteresis: 0.97, ddgiIntensity: 1, ddgiNormalBias: 0.02,
};

/** エンジンと同じクランプ(Application.cpp を写したもの)。 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function makeDxrEngine(supported: boolean) {
  const state: Record<string, any> = { ...DXR_DEFAULTS };
  const getResult = () => ({
    supported,
    raytracingTier: supported ? "1.2" : "none",
    highestShaderModel: supported ? "6.8" : "6.0",
    ...state,
    shadowActive: supported && state.shadowEnabled,
    tlasReady: supported,
    stats: {
      instances: 0, blasCount: 0, blasBytes: 0, blasTriangles: 0, tlasBytes: 0,
      scratchBytes: 0, instanceDescBytes: 0, skippedSkinned: 0, skippedTransparent: 0,
      droppedOverLimit: 0, bytesPerTriangle: 0,
    },
    applied: false,
    note: "テスト用の偽エンジン",
  });
  const handler: EngineHandler = (method, params) => {
    if (method === "get_dxr") return { result: getResult() };
    if (method === "set_dxr") {
      if (!supported) {
        return { error: {
          code: 2,
          message: "this GPU does not support inline raytracing",
          hint: "DXR Tier 1.1 かつ Shader Model 6.5 が必要",
        } };
      }
      for (const k of Object.keys(DXR_DEFAULTS)) if (params[k] !== undefined) state[k] = params[k];
      if (params.aoRayCount !== undefined) state.aoRayCount = clamp(params.aoRayCount, 1, 8);
      if (params.shadowSunAngle !== undefined) state.shadowSunAngle = clamp(params.shadowSunAngle, 0, 20);
      return { result: { ...getResult(), applied: true } };
    }
    if (method === "render_debug") {
      return { result: { path: "(no capture)", mode: params.mode, mode_engine: 99, width: 0, height: 0,
                         toneMapped: false, warnings: [] } };
    }
    return { error: { code: 2, message: `unexpected method ${method}` } };
  };
  return handler;
}

// ═══════════════════════════════════════════════════════════════
console.log("[1] tools/list — 全ツール登録 / $ref なし / 名前重複なし");
{
  const eng = await startFakeEngine(makeDxrEngine(true));
  const mcp = new McpStdio(eng.port);
  await mcp.init();
  const list = await mcp.listTools();
  const tools = list?.result?.tools ?? [];
  assert.ok(tools.length >= 100, `ツール数が少なすぎる: ${tools.length}`);
  pass(`tools/list が ${tools.length} 件返る`);

  const names = tools.map((t: any) => t.name);
  const dup = names.filter((n: string, i: number) => names.indexOf(n) !== i);
  assert.equal(dup.length, 0, `名前が重複: ${dup.join(",")}`);
  pass("ツール名の重複なし");

  // ★$ref は「同じ zod インスタンスを 1 ツール内で使い回した」印。解決しない
  //   クライアントでその引数が一生渡せなくなるので、スキーマ全体から追放する。
  const withRef = tools.filter((t: any) => JSON.stringify(t.inputSchema ?? {}).includes("$ref"));
  assert.equal(withRef.length, 0, `$ref を含むツール: ${withRef.map((t: any) => t.name).join(",")}`);
  pass("どの inputSchema にも $ref が無い");

  const get = tools.find((t: any) => t.name === "dx12_get_dxr");
  const set = tools.find((t: any) => t.name === "dx12_set_dxr");
  assert.ok(get && set, "dx12_get_dxr / dx12_set_dxr が登録されている");
  assert.deepEqual(Object.keys(get.inputSchema?.properties ?? {}), [], "get は引数を取らない");
  assert.deepEqual(
    Object.keys(set.inputSchema?.properties ?? {}).sort(),
    Object.keys(DXR_DEFAULTS).sort(),
    "set の引数がエンジンのフィールドと一致");
  pass("dx12_get_dxr / dx12_set_dxr のシグネチャが engine と一致");

  // エンジンの引数表(McpDefine の申告表)を AI から引ける入口。schemaDrift.test.ts が
  // 静的に読んでいるのと同じ表を、実行時に返すもの。
  assert.ok(tools.some((t: any) => t.name === "dx12_describe_mcp_params"),
    "dx12_describe_mcp_params が登録されている");
  pass("dx12_describe_mcp_params が登録されている");

  // render_debug の enum に rt / rtDiff が入っていること(zod が弾かない)
  const rd = tools.find((t: any) => t.name === "dx12_render_debug");
  const modes: string[] = rd?.inputSchema?.properties?.mode?.enum ?? [];
  assert.ok(modes.includes("rt") && modes.includes("rtDiff"), `mode enum=${modes.join(",")}`);
  pass("dx12_render_debug の mode enum に rt / rtDiff がある");

  mcp.kill();
  eng.server.close();
}

console.log("\n[2] 非対応 GPU — 「バグ」ではなく「正常な非対応」として返す");
{
  const handler = makeDxrEngine(false);
  const eng = await startFakeEngine(handler);
  const mcp = new McpStdio(eng.port);
  await mcp.init();

  const get = payload(await mcp.callTool("dx12_get_dxr", {}));
  assert.equal(get.supported, false);
  assert.equal(get.raytracingTier, "none");
  pass("dx12_get_dxr は非対応 GPU でも成功して supported:false を返す");

  const res = await mcp.callTool("dx12_set_dxr", { shadowEnabled: true, aoEnabled: true });
  assert.notEqual(res.result?.isError, true, "非対応はツールエラーにしない(引数ミスと区別が付かなくなる)");
  const p = payload(res);
  assert.equal(p.applied, false, "適用していないと言い切る");
  assert.equal(p.supported, false);
  assert.equal(p.retryable, false, "★撃ち直しても無駄だと明示する");
  assert.ok(String(p.reason).includes("引数ミスでもない"), `reason=${p.reason}`);
  assert.ok(String(p.next).includes("dx12_set_shadow_pcss"), "代替手段(PCSS/SSAO)を案内する");
  assert.equal(p.raytracingTier, "none");
  assert.deepEqual(p.requestedKeys.sort(), ["aoEnabled", "shadowEnabled"]);
  assert.ok(p.current && p.current.supported === false, "現在値も添える");
  pass("dx12_set_dxr は applied:false / retryable:false / 理由 / 代替手段 / 現在値を返す");

  // ★撃つ前に get で確定させているので set_dxr は一発も飛ばない。
  //   飛ばしていたら「非対応環境で毎回エラーを取りに行く」= AI のリトライ源になる。
  const sets = eng.received.filter((r) => r.method === "set_dxr");
  assert.equal(sets.length, 0, `非対応なのに set_dxr を撃っている: ${sets.length} 回`);
  assert.ok(eng.received.some((r) => r.method === "get_dxr"), "get_dxr で先に確かめている");
  pass("非対応と分かっている環境では set_dxr を一発も撃たない");

  mcp.kill();
  eng.server.close();
}

console.log("\n[3] 対応 GPU — 適用して読み返す / クランプは mismatched で正直に返す");
{
  const eng = await startFakeEngine(makeDxrEngine(true));
  const mcp = new McpStdio(eng.port);
  await mcp.init();

  const okRes = payload(await mcp.callTool("dx12_set_dxr", {
    shadowEnabled: true, shadowSunAngle: 0, aoEnabled: true, aoRadius: 2.5,
  }));
  assert.equal(okRes.applied, true, `applied:true のはず: ${JSON.stringify(okRes)}`);
  assert.deepEqual(okRes.requestedKeys.sort(), ["aoEnabled", "aoRadius", "shadowEnabled", "shadowSunAngle"]);
  assert.equal(okRes.current.shadowEnabled, true);
  assert.equal(okRes.current.shadowActive, true);
  assert.equal(okRes.mismatched, undefined);
  pass("対応 GPU では applied:true + 読み返した current を返す");

  // エンジンが 1..8 にクランプする → 要求 99 は入らない。ここで applied:true を返すと嘘になる。
  const clamped = payload(await mcp.callTool("dx12_set_dxr", { aoRayCount: 99 }));
  assert.equal(clamped.applied, false, "クランプされたら applied:false");
  assert.equal(clamped.current.aoRayCount, 8);
  assert.equal(clamped.mismatched?.[0]?.key, "aoRayCount");
  assert.ok(String(clamped.hint).length > 0, "次の一手が本文にある");
  pass("エンジンにクランプされたら applied:false + mismatched(嘘をつかない)");

  // 未知キーは黙って捨てず、近い正解つきで弾く(passthrough + unknownParamKeys)
  const unknown = await mcp.callTool("dx12_set_dxr", { shadowEnable: true });
  assert.equal(unknown.result?.isError, true);
  const text = unknown.result.content[0].text as string;
  assert.ok(text.includes("shadowEnable") && text.includes("shadowEnabled"), text);
  pass("未知キー shadowEnable は shadowEnabled を提案して弾かれる");

  // 新モードがエンジンまで届く(zod enum で落ちない)
  const rd = await mcp.callTool("dx12_render_debug", { mode: "rtDiff", gain: 20 });
  assert.notEqual(rd.result?.isError, true, JSON.stringify(rd));
  assert.ok(eng.received.some((r) => r.method === "render_debug" && r.params.mode === "rtDiff"),
    "rtDiff がエンジンまで届いている");
  pass("dx12_render_debug の mode:\"rtDiff\" がエンジンまで通る");

  mcp.kill();
  eng.server.close();
}

console.log(`\nOK: DXR ツール e2e テスト ${passed} 項目すべて通過`);
