/**
 * 測定系ツール(スクショ / カメラ / 測光)の e2e テスト。ネット不要・エディタ不要。
 *
 * ★何を担保するか（B15 の宿題そのもの）
 *   1) dx12_screenshot_final が登録され、engine の screenshot_final を
 *      {path, deterministic, settleFrames} 付きで叩き、PNG を image コンテンツで返すこと。
 *   2) dx12_screenshot に path / deterministic / settleFrames が生えて、実際に engine まで届くこと
 *      (zod に無いと【黙って捨てられる】のがこの一連の事故の原因だった)。
 *   3) ★測定と目視の食い違いの根治: 絵を「見る/測る」合成ツール
 *      (look_compare / camera_path / focus_and_screenshot / screenshot_from)が
 *      既定で screenshot_final(ポスト後)を撮ること。source:'sceneRT' で従来へ戻せること。
 *   4) look_compare の示唆が本来の形に戻っていること。最終画を測っているときは
 *      post のノブに「映らないから追い込めない」の但し書きが付かない(d993d5a の制約の解除)。
 *   5) get_editor_camera の targetDistance / set_editor_camera の release /
 *      spawn_prefab の idempotency_key が engine まで届くこと。
 *   6) ★assetsDir 推定ハックの撤去: scene_write が dx12_ping の assetsDir を使い、
 *      get_log を一発も撃たないこと。
 *
 * 実行: node captureTools.test.ts
 */

import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.join(here, "index.ts");

let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };

// ── 偽エンジン(TCP) ────────────────────────────────────────────
// 改行区切り JSON。received に届いた method/params を溜めて
// 「どの method を何回・どんな引数で撃ったか」を検証できるようにする。

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
  return {
    server,
    port: (server.address() as net.AddressInfo).port,
    received,
    methods: () => received.map((r) => r.method),
    paramsOf: (m: string) => received.filter((r) => r.method === m).map((r) => r.params),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
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
      env: { ...process.env, DX12_MCP_PORT: String(port), DX12_MCP_HOST: "127.0.0.1", DX12_ASSETS_DIR: "" },
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
      clientInfo: { name: "captureTools.test", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }

  listTools = () => this.send("tools/list", {});
  callTool = (name: string, args: any) => this.send("tools/call", { name, arguments: args });
  kill() { this.proc.kill(); }
}

/** JSON ツールの content[0].text を JSON として読む。 */
function payload(res: any): any {
  const text = res?.result?.content?.[0]?.text;
  assert.ok(typeof text === "string", `content[0].text が無い: ${JSON.stringify(res)}`);
  return JSON.parse(text);
}

/** 画像ツールの結果: content[0] が image、content[1] の text が JSON。 */
function imagePayload(res: any): any {
  const content = res?.result?.content ?? [];
  assert.equal(content[0]?.type, "image", `先頭が image ブロックでない: ${JSON.stringify(res).slice(0, 400)}`);
  assert.equal(content[0]?.mimeType, "image/png");
  assert.ok(content[0]?.data?.length > 0, "image の data が空");
  assert.equal(content[1]?.type, "text", "image の後ろに text(メタ情報)が無い");
  return JSON.parse(content[1].text);
}

// ── テスト用の PNG(偽エンジンが「撮った」ことにするファイル) ────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-capture-test-"));

/** 上半分 hi / 下半分 lo のグレー画像を書き出してパスを返す。 */
function writePng(name: string, w: number, h: number, hi: number, lo: number): string {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = y < h / 2 ? hi : lo;
      const i = (y * w + x) * 4;
      png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
    }
  }
  const p = path.join(TMP, name);
  fs.writeFileSync(p, PNG.sync.write(png));
  return p;
}

// 参照は「硬い」絵、現在は「眠い」絵。look_compare が必ず示唆を出す組み合わせにする。
const REF_PNG   = writePng("reference.png", 32, 24, 250, 5);
const FINAL_PNG = writePng("final.png",     32, 24, 150, 120);
const SCENE_PNG = writePng("scene.png",     32, 24, 150, 120);

// ── 偽エンジン本体 ─────────────────────────────────────────────

const ASSETS_DIR = path.join(TMP, "proj", "assets");
fs.mkdirSync(path.join(ASSETS_DIR, "scenes"), { recursive: true });

function makeEngine(): EngineHandler {
  return (method, params) => {
    switch (method) {
      case "ping":
        return { result: {
          pong: true, mode: "Editor", entityCount: 3, sceneGeneration: 1,
          currentScene: "scenes/main.json",
          assetsDir: ASSETS_DIR, scriptsDir: path.join(ASSETS_DIR, "scripts"),
          baseDir: path.join(TMP, "proj"), projectShaderDir: path.join(ASSETS_DIR, "shaders"),
          cwd: TMP, protocolVersion: 4,
        } };
      // ★ポスト前(シーン RT)。source フィールドでどちらを撮ったか自己申告する。
      case "screenshot":
        return { result: {
          path: SCENE_PNG, width: 32, height: 24,
          source: "sceneRT(pre-post)",
          deterministic: params.deterministic === true,
          note: "テスト用の偽エンジン",
        } };
      // ★ポスト後(バックバッファ)。
      case "screenshot_final":
        return { result: {
          path: FINAL_PNG, width: 32, height: 24,
          source: "backbuffer", postApplied: true,
          deterministic: params.deterministic === true,
          taa: true, mode: "Editor", note: "テスト用の偽エンジン",
        } };
      case "screenshot_game_view":
        return { result: { path: SCENE_PNG, width: 32, height: 24 } };
      case "step_frames":
        return { result: { frames: params.frames ?? 0 } };
      case "focus_camera":
        return { result: { entityId: params.entity ?? 1 } };
      case "get_editor_camera":
        return { result: {
          position: [1, 2, 3], forward: [0, 0, 1],
          target: [1, 2, 3 + (params.targetDistance ?? 10)],
          targetDistance: params.targetDistance ?? 10,
          yawDeg: 0, pitchDeg: 0, fovYDeg: 60, aspect: 1.77, nearZ: 0.1, farZ: 1000,
          orthographic: false, overridden: false, mode: "Editor",
        } };
      case "set_editor_camera":
        return { result: params.release
          ? { released: true, overridden: false, position: [1, 2, 3], forward: [0, 0, 1] }
          : { position: params.position ?? [1, 2, 3], forward: [0, 0, 1],
              yawDeg: 0, pitchDeg: 0, overridden: false, mode: "Editor", note: "" } };
      case "spawn_prefab":
        return { result: {
          entityId: 7, rootEntityId: 7, entityIds: [7, 8, 9],
          name: params.name ?? "enemy", sceneGeneration: 1,
          idempotentReplay: params.idempotency_key === "replay-me",
        } };
      case "list_assets":
        return { result: [] };
      case "list_scenes":
        return { result: [{ path: "scenes/main.json" }] };
      case "get_log":
        // ★推定ハックが復活したらここが撃たれる。撃たれたこと自体をテストで落とす。
        return { result: ["[info] loading C:/somewhere/else/assets/models/x.fbx"] };
      default:
        return { error: { code: 2, message: `unexpected method ${method}` } };
    }
  };
}

// ═══════════════════════════════════════════════════════════════
console.log("[1] tools/list — 新ツール登録 / $ref なし / 名前重複なし");
const eng = await startFakeEngine(makeEngine());
const mcp = new McpStdio(eng.port);
await mcp.init();
{
  const list = await mcp.listTools();
  const tools = list?.result?.tools ?? [];
  assert.ok(tools.length >= 100, `ツール数が少なすぎる: ${tools.length}`);

  const names = tools.map((t: any) => t.name);
  const dup = names.filter((n: string, i: number) => names.indexOf(n) !== i);
  assert.equal(dup.length, 0, `名前が重複: ${dup.join(",")}`);
  pass(`tools/list が ${tools.length} 件返る(名前の重複なし)`);

  // ★$ref は「同じ zod インスタンスを使い回した」印。解決しないクライアントで
  //   その引数が一生渡せなくなるので、スキーマ全体から追放する。
  //   captureParams() / captureSourceSchema() をファクトリにしてあるのはこのため。
  const withRef = tools.filter((t: any) => JSON.stringify(t.inputSchema ?? {}).includes("$ref"));
  assert.equal(withRef.length, 0, `$ref を含むツール: ${withRef.map((t: any) => t.name).join(",")}`);
  pass("どの inputSchema にも $ref が無い(captureParams / captureSourceSchema がファクトリ)");

  const shot = tools.find((t: any) => t.name === "dx12_screenshot");
  const final = tools.find((t: any) => t.name === "dx12_screenshot_final");
  assert.ok(final, "dx12_screenshot_final が登録されていない");
  const want = ["deterministic", "path", "settleFrames"];
  assert.deepEqual(Object.keys(final.inputSchema?.properties ?? {}).sort(), want);
  assert.deepEqual(Object.keys(shot.inputSchema?.properties ?? {}).sort(), want);
  pass("dx12_screenshot / dx12_screenshot_final が {path, deterministic, settleFrames} を宣言");

  // 「どっちを使うのか」が説明から読み取れること(AI はここだけ見て選ぶ)。
  assert.match(final.description, /ポスト適用後|最終画/);
  assert.match(shot.description, /dx12_screenshot_final/,
    "ポスト前スクショの説明に「見た目を判断するなら final」の誘導が無い");
  pass("説明文がポスト前/ポスト後の使い分けを明示している");

  // look_compare / camera_path の source(撮り方の切り替え)。
  for (const n of ["dx12_look_compare", "dx12_camera_path"]) {
    const t = tools.find((x: any) => x.name === n);
    const src = t?.inputSchema?.properties?.source;
    assert.ok(src, `${n} に source が無い`);
    assert.deepEqual(src.enum, ["final", "sceneRT"], `${n} の source の有効値が違う`);
  }
  pass("dx12_look_compare / dx12_camera_path が source:'final'|'sceneRT' を持つ");

  // 既存ツールへ足した引数。
  const getCam = tools.find((t: any) => t.name === "dx12_get_editor_camera");
  const setCam = tools.find((t: any) => t.name === "dx12_set_editor_camera");
  const prefab = tools.find((t: any) => t.name === "dx12_spawn_prefab");
  assert.ok(getCam.inputSchema?.properties?.targetDistance, "get_editor_camera に targetDistance が無い");
  assert.ok(setCam.inputSchema?.properties?.release, "set_editor_camera に release が無い");
  assert.ok(prefab.inputSchema?.properties?.idempotency_key, "spawn_prefab に idempotency_key が無い");
  // Play 中に使えるようになったので「Editor 限定 / MODE_CONFLICT」の案内は残っていないこと。
  assert.doesNotMatch(setCam.description, /★Editor 限定/,
    "set_editor_camera の説明に古い『Editor 限定』が残っている(Play 中も使える)");
  pass("targetDistance / release / idempotency_key が生えていて、古い Editor 限定の案内が消えている");
}

console.log("\n[2] dx12_screenshot_final — 引数が engine まで届き、image で返る");
{
  const before = eng.received.length;
  const res = await mcp.callTool("dx12_screenshot_final",
    { path: "shots/a.png", deterministic: true, settleFrames: 32 });
  const meta = imagePayload(res);
  assert.equal(meta.source, "backbuffer");
  assert.equal(meta.postApplied, true);
  assert.equal(meta.deterministic, true);
  assert.equal(meta.width, 32);

  const sent = eng.received.slice(before);
  assert.deepEqual(sent.map((s) => s.method), ["screenshot_final"]);
  assert.deepEqual(sent[0].params, { path: "shots/a.png", deterministic: true, settleFrames: 32 });
  pass("path / deterministic / settleFrames がそのまま engine へ渡り、PNG が image で返る");
}

console.log("\n[3] dx12_screenshot — 足した引数が黙って捨てられない");
{
  const before = eng.received.length;
  const meta = imagePayload(await mcp.callTool("dx12_screenshot",
    { path: "shots/b", deterministic: true, settleFrames: 8 }));
  assert.equal(meta.source, "sceneRT(pre-post)");
  assert.equal(meta.deterministic, true);
  const sent = eng.received.slice(before);
  assert.deepEqual(sent.map((s) => s.method), ["screenshot"]);
  assert.deepEqual(sent[0].params, { path: "shots/b", deterministic: true, settleFrames: 8 });
  pass("dx12_screenshot の path / deterministic / settleFrames が engine へ届く");

  // ★未知キーは黙って捨てず、近い正解つきで弾く(paramGuard の担保がここでも効くこと)。
  const bad = await mcp.callTool("dx12_screenshot", { deterministc: true });
  assert.equal(bad?.result?.isError, true, "打ち間違いキーが素通りしている");
  assert.match(bad.result.content[0].text, /deterministic/);
  pass("打ち間違い(deterministc)は『deterministic のことか?』付きで弾かれる");
}

console.log("\n[4] 絵を見る/測る合成ツールが既定で最終画(ポスト後)を撮る");
{
  for (const [tool, args] of [
    ["dx12_focus_and_screenshot", { entity: 1 }],
    ["dx12_screenshot_from", { position: [0, 5, -10], target: [0, 0, 0] }],
  ] as const) {
    const before = eng.received.length;
    const meta = imagePayload(await mcp.callTool(tool, args));
    const used = eng.received.slice(before).map((s) => s.method);
    assert.ok(used.includes("screenshot_final"), `${tool} が screenshot_final を撮っていない: ${used}`);
    assert.ok(!used.includes("screenshot"), `${tool} がまだポスト前の screenshot を撮っている: ${used}`);
    assert.equal(meta.source, "backbuffer");
  }
  pass("dx12_focus_and_screenshot / dx12_screenshot_from が screenshot_final を撮る");

  // camera_path: TAA の解決結果はポスト前の sceneRT に出ないので、ゴースト探しは final でないと見えない。
  const before = eng.received.length;
  const meta = imagePayload(await mcp.callTool("dx12_camera_path",
    { mode: "line", frames: 2, columns: 2, from: [0, 1, -5], to: [0, 1, 5], target: [0, 0, 0], tileWidth: 32 }));
  const used = eng.received.slice(before).map((s) => s.method);
  assert.equal(used.filter((m) => m === "screenshot_final").length, 2, `連写が final でない: ${used}`);
  assert.ok(!used.includes("screenshot"), `camera_path がまだポスト前を撮っている: ${used}`);
  assert.equal(meta.source, "final");
  assert.equal(meta.measuredOn, "backbuffer");
  assert.equal(meta.frames, 2);
  pass("dx12_camera_path が既定で screenshot_final を連写する(TAA 解決結果が見える側)");

  // 逃げ道: source:'sceneRT' で従来のポスト前へ戻せる。
  const before2 = eng.received.length;
  const meta2 = imagePayload(await mcp.callTool("dx12_camera_path",
    { mode: "line", frames: 2, columns: 2, from: [0, 1, -5], to: [0, 1, 5], target: [0, 0, 0],
      tileWidth: 32, source: "sceneRT" }));
  const used2 = eng.received.slice(before2).map((s) => s.method);
  assert.equal(used2.filter((m) => m === "screenshot").length, 2, `sceneRT 指定が効いていない: ${used2}`);
  assert.ok(!used2.includes("screenshot_final"));
  assert.equal(meta2.source, "sceneRT");
  pass("source:'sceneRT' でポスト前(従来の screenshot)に戻せる");
}

console.log("\n[5] dx12_look_compare — 最終画を測り、示唆が本来の形へ戻っている");
{
  const before = eng.received.length;
  const meta = imagePayload(await mcp.callTool("dx12_look_compare", { referencePath: REF_PNG }));
  const used = eng.received.slice(before).map((s) => s.method);
  assert.ok(used.includes("screenshot_final"), `look_compare が final を撮っていない: ${used}`);
  assert.ok(!used.includes("screenshot"), `look_compare がまだポスト前を測っている: ${used}`);
  assert.match(meta.measuredOn, /screenshot_final|バックバッファ/);
  assert.equal(meta.notReflected, null, "最終画なのに『映らないもの』が残っている");
  pass("既定で screenshot_final を測り、notReflected が消える");

  // ★d993d5a で入れた歪みの解除。ポストのノブを勧める行に「映らない/追い込めない」が付かないこと。
  const posts = meta.suggestions.filter((s: string) => /dx12_set_post_process/.test(s));
  assert.ok(posts.length > 0, `post のノブを 1 つも勧めていない: ${JSON.stringify(meta.suggestions)}`);
  for (const s of posts) {
    assert.doesNotMatch(s, /映らない|この数値では追い込めない/,
      `最終画を測っているのに「映らない」制約が残っている: ${s}`);
  }
  // 絵作りの順序(まず光で作る)は測り方に関係なく維持する。
  const con = meta.suggestions.find((s: string) => s.startsWith("コントラスト:"));
  assert.ok(con && /ambient/.test(con), "コントラストの示唆が『まず光で作る』から始まっていない");
  assert.match(con, /dx12_set_post_process の contrast/);
  pass("post のグレーディングを但し書き無しで勧められる(先に光で作る順序は維持)");

  // 逃げ道側: source:'sceneRT' では但し書きが復活する(無限ループ防止は生きている)。
  const before2 = eng.received.length;
  const meta2 = imagePayload(await mcp.callTool("dx12_look_compare",
    { referencePath: REF_PNG, source: "sceneRT" }));
  const used2 = eng.received.slice(before2).map((s) => s.method);
  assert.ok(used2.includes("screenshot") && !used2.includes("screenshot_final"), `${used2}`);
  assert.ok(meta2.notReflected && /映らない/.test(meta2.notReflected));
  for (const s of meta2.suggestions.filter((x: string) => /dx12_set_post_process の (contrast|saturation|warmth)/.test(x))) {
    assert.match(s, /この数値では追い込めない/, `sceneRT なのに但し書きが無い: ${s}`);
  }
  pass("source:'sceneRT' では『この数値では追い込めない』の但し書きが復活する");
}

console.log("\n[6] カメラ / プレハブへ足した引数が engine まで届く");
{
  const before = eng.received.length;
  await mcp.callTool("dx12_get_editor_camera", { targetDistance: 4.5 });
  await mcp.callTool("dx12_set_editor_camera", { release: true });
  await mcp.callTool("dx12_spawn_prefab", { path: "prefabs/enemy.prefab", idempotency_key: "replay-me" });
  const sent = eng.received.slice(before);
  assert.equal(sent[0].params.targetDistance, 4.5);
  assert.equal(sent[1].params.release, true);
  assert.equal(sent[2].params.idempotency_key, "replay-me");
  pass("targetDistance / release / idempotency_key が engine へ渡る");

  // spawn_prefab のリプレイ応答(rootEntityId / entityIds / idempotentReplay)がそのまま通ること。
  const r = payload(await mcp.callTool("dx12_spawn_prefab",
    { path: "prefabs/enemy.prefab", idempotency_key: "replay-me" }));
  assert.equal(r.idempotentReplay, true);
  assert.equal(r.rootEntityId, 7);
  assert.deepEqual(r.entityIds, [7, 8, 9]);
  pass("リプレイ応答の idempotentReplay / rootEntityId / entityIds が結果に載る");
}

console.log("\n[7] assetsDir はエンジンに聞く(ログからの推定ハックが消えている)");
{
  const before = eng.received.length;
  const r = payload(await mcp.callTool("dx12_scene_write",
    { path: "scenes/written.json", sceneJson: { entities: [] } }));
  const used = eng.received.slice(before).map((s) => s.method);
  assert.ok(used.includes("ping"), `ping で assetsDir を聞いていない: ${used}`);
  // ★ここが本丸。get_log を撃った時点で推定ハックが生きている。
  assert.ok(!used.includes("get_log"),
    `ログからの assetsDir 推定ハックが残っている(get_log を撃った): ${used}`);
  assert.equal(r.assetsDir, ASSETS_DIR.replace(/\\/g, "/"));
  assert.match(r.assetsDirResolvedBy, /dx12_ping/);
  assert.ok(fs.existsSync(path.join(ASSETS_DIR, "scenes", "written.json")), "シーンが書かれていない");
  pass("dx12_ping の assetsDir を正として使い、get_log を一発も撃たない");
}

mcp.kill();
await eng.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nOK: 測定系ツール e2e テスト ${passed} 項目すべて通過`);
