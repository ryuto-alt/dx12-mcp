/**
 * 判断段(Jev)と Brief の MCP ツール e2e テスト。ネット不要・エディタ不要。
 *
 * index.ts を子プロセスで起動し、偽エンジン(TCP)と偽 Jev(HTTP, JEV_ENDPOINT で向ける)に繋ぐ。
 * ★本物のエディタ(8787)にも本物の Jev にも繋がない: DX12_MCP_PORT を偽エンジンへ、
 *   TYPESAFE_API_KEY をテスト用の偽の値へ差し替えて起動する。
 *
 * 担保すること:
 *   1) 4 ツール(dx12_brief / dx12_jev_ask / dx12_jev_eval / dx12_jev_status)が登録され、呼べる
 *   2) Brief は dx12_ping の baseDir 直下に読み書きされる(get / set / patch / 形の誤り)
 *   3) jev_ask は context に brief が無ければ brief.json を自動で入れ、偽 Jev へ 1 リクエストで届く
 *   4) 鍵が無いプロセスでは Jev へ一切出ず、ルールで返る
 *   5) status は鍵の値を出さず、記録(log.jsonl)から累計を返す
 *   6) jev_eval はケースファイルを流して正解率と誤差を返す
 *   7) polish_audit の判断段: 1 リクエストで 3 種の質問が届き、judge が付く。judge:false で止まる。
 *      Brief が無ければ judge.source="rules" + briefMissing。既存の score/verdict/findings は壊れない
 *
 * 実行: node jev/tools.test.ts
 */

import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.join(here, "..", "index.ts");
const FAKE_KEY = "apikey_e2e_fake_value_not_real_42";

let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };

// ── 偽エンジン ────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dx12-jev-tools-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, "assets"), { recursive: true });

// 最終画: 7 割が真っ黒・残りが暗い灰色(黒つぶれ + 眠い + 無彩色の指摘が出る絵)
const DARK_PNG = path.join(TMP, "dark.png");
{
  const png = new PNG({ width: 40, height: 20 });
  for (let i = 0; i < 40 * 20; i++) {
    const v = i % 10 < 7 ? 1 : 55;
    png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(DARK_PNG, PNG.sync.write(png));
}

type EngineHandler = (method: string, params: any) => any;
async function startFakeEngine(handler: EngineHandler) {
  const received: string[] = [];
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        received.push(req.method);
        const result = handler(req.method, req.params ?? {});
        sock.write(JSON.stringify(result === undefined
          ? { id: req.id, ok: false, error_code: 1, error: `偽エンジンは ${req.method} を知らない` }
          : { id: req.id, ok: true, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port, received };
}

/** polish_audit が集める「死んだ絵」の設定一式(ルールの指摘が出る状態)。 */
function engineHandler(method: string, _params: any): any {
  switch (method) {
    case "ping":
      return { pong: true, mode: "Editor", protocolVersion: 4, baseDir: PROJ, assetsDir: path.join(PROJ, "assets"), cwd: TMP };
    case "get_scene_settings": return { skybox: { envMapPath: "__procedural_sky__", iblIntensity: 1, drawSkybox: false } };
    case "list_lights": return { lights: [{ type: "Point", intensity: 0.8, castShadows: true }] };
    case "get_volumetric_fog": return { enabled: false, density: 0 };
    case "get_post_process": return { vignetteOn: true, grainOn: true, bloomOn: false };
    case "get_ssao": return { enabled: true };
    case "get_contact_shadow": return { enabled: true };
    case "list_entities": return { entities: [
      { entityId: 1, name: "Floor", componentTypes: ["transform", "meshRenderer"] },
      { entityId: 2, name: "Dirt", componentTypes: ["transform", "decal"] },
    ] };
    case "get_entity": return { material: { roughness: 0.8, metallic: 0 }, materialTextureOverrides: [{ normal: "t.png" }] };
    case "screenshot_final": return { path: DARK_PNG, width: 40, height: 20 };
    default: return undefined;
  }
}

// ── 偽 Jev(HTTP) ────────────────────────────────────────────
type JevReq = { auth: string; state: any; questions: Record<string, any> };
const jevReqs: JevReq[] = [];
const jevServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const b = JSON.parse(body);
    jevReqs.push({ auth: String(req.headers.authorization ?? ""), state: b.state, questions: b.questions });
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries<any>(b.questions)) {
      const text = JSON.stringify(q.instructions);
      if (q.type === "noul") {
        // CRUSHED_BLACKS は「意図どおり」、それ以外は「直す」と答える偽物
        answers[k] = { type: "noul", noul: text.includes("CRUSHED_BLACKS") ? 0.93 : 0.12 };
      } else if (q.type === "choice") {
        const keys = Object.keys(q.criteria ?? {});
        const pick = keys.includes("add_fog") ? "add_fog" : keys[0];
        answers[k] = { type: "choice", choice: pick, confidence: 0.82, probabilities: { [pick]: 0.82 } };
      } else {
        answers[k] = { type: "score", score: 3.4, confidence: 0.9, legend: {}, probabilities: {} };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "jev-fake", answers, usage: { input_tokens: 700, output_tokens: 30 } }));
  });
});
await new Promise<void>((r) => jevServer.listen(0, "127.0.0.1", () => r()));
const JEV_URL = `http://127.0.0.1:${(jevServer.address() as net.AddressInfo).port}/v1/systemone`;

// ── MCP クライアント(stdio・最小実装) ──────────────────────────
class McpStdio {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  stderr = "";
  constructor(port: number, key: string) {
    const env: Record<string, string | undefined> = {
      ...process.env, DX12_MCP_PORT: String(port), DX12_MCP_HOST: "127.0.0.1", DX12_ASSETS_DIR: "",
      TYPESAFE_API_KEY: key, JEV_ENDPOINT: JEV_URL, DX12_PROJECT_DIR: "",
    };
    this.proc = spawn(process.execPath, [INDEX_TS], { env: env as any, stdio: ["pipe", "pipe", "pipe"] });
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
  async init() {
    await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jev.tools.test", version: "0" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }
  listTools = () => this.send("tools/list", {});
  call = (name: string, args: any) => this.send("tools/call", { name, arguments: args });
  kill() { this.proc.kill(); }
}

/** JSON ツールは content[0].text、画像付き(polish_audit)は最後の text ブロック。 */
function payload(res: any): any {
  const texts = (res?.result?.content ?? []).filter((c: any) => c.type === "text");
  assert.ok(texts.length > 0, `text が無い: ${JSON.stringify(res).slice(0, 400)}`);
  return JSON.parse(texts[texts.length - 1].text);
}

const engine = await startFakeEngine(engineHandler);
const mcp = new McpStdio(engine.port, FAKE_KEY);
await mcp.init();

try {
  console.log("[1] 4 ツールが登録されている");
  {
    const names = (await mcp.listTools()).result.tools.map((t: any) => t.name);
    for (const n of ["dx12_brief", "dx12_jev_ask", "dx12_jev_eval", "dx12_jev_status"]) assert.ok(names.includes(n), `${n} が無い`);
    pass("dx12_brief / dx12_jev_ask / dx12_jev_eval / dx12_jev_status");
  }

  console.log("[2] Brief は ping の baseDir 直下に読み書きされる");
  {
    const g = payload(await mcp.call("dx12_brief", {}));
    assert.equal(g.exists, false);
    assert.ok(g.example?.genre, "無いときは手本を返す");
    assert.equal(g.path, path.join(PROJ, "brief.json"));
    pass("無ければ exists:false + 手本(example)");

    const s = payload(await mcp.call("dx12_brief", { action: "set", brief: { genre: "一人称ホラー", mood: ["暗い"], avoid: ["明るく均一な照明"] } }));
    assert.equal(s.written, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(PROJ, "brief.json"), "utf8")).genre, "一人称ホラー");
    pass("set で <baseDir>/brief.json に書く");

    const p = payload(await mcp.call("dx12_brief", { action: "patch", brief: { player_should_feel: "進むのが怖い", avoid: null } }));
    assert.equal(p.brief.player_should_feel, "進むのが怖い");
    assert.equal(p.brief.genre, "一人称ホラー");
    assert.ok(!("avoid" in p.brief), "null はキーを消す");
    pass("patch は浅いマージ、null で削除");

    const bad = await mcp.call("dx12_brief", { action: "set", brief: { mood: "暗い" } });
    assert.equal(bad.result.isError, true);
    assert.ok(bad.result.content[0].text.includes("mood"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(PROJ, "brief.json"), "utf8")).genre, "一人称ホラー", "壊れた Brief で上書きしない");
    pass("形の誤りはエラーで、既存の brief.json を壊さない");

    const unknown = await mcp.call("dx12_brief", { action: "get", breif: {} });
    assert.equal(unknown.result.isError, true);
    pass("未知の引数は近い正解つきのエラー(regRaw の流儀)");
  }

  console.log("[3] dx12_jev_ask");
  {
    const before = jevReqs.length;
    const r = payload(await mcp.call("dx12_jev_ask", {
      questions: ["look.brief_fit", "look.next_fix", { id: "finding.intended", vars: { code: "CRUSHED_BLACKS" } }],
      context: { facts: { look: { brightness: "とても暗い" }, findings: [{ code: "CRUSHED_BLACKS", issue: "黒つぶれ" }] } },
    }));
    assert.equal(jevReqs.length - before, 1, "同じ state の 3 問は 1 リクエスト");
    const req = jevReqs[jevReqs.length - 1];
    assert.equal(Object.keys(req.questions).length, 3);
    assert.equal(req.auth, `Bearer ${FAKE_KEY}`);
    assert.equal(req.state.brief.genre, "一人称ホラー", "brief.json が自動で入る");
    assert.equal(r.briefFrom, path.join(PROJ, "brief.json"));
    pass("3 問を 1 リクエストに束ね、brief.json を自動で state に入れる");
    assert.deepEqual(r.results.map((x: any) => x.source), ["jev", "jev", "jev"]);
    assert.equal(r.results[2].id, "finding.intended#CRUSHED_BLACKS");
    assert.equal(r.results[2].decided, true);
    assert.equal(r.results[1].value, "add_fog");
    pass("結果は共通型(source / value / decided)");

    const raw = payload(await mcp.call("dx12_jev_ask", {
      raw: { state: { a: "b" }, questions: { ok: { type: "noul", instructions: "ok?" } } },
    }));
    assert.equal(raw.results[0].id, "ok");
    assert.equal(raw.results[0].source, "jev");
    pass("raw の直接質問");

    const again = payload(await mcp.call("dx12_jev_ask", {
      question: "look.brief_fit", context: { facts: { look: { brightness: "とても暗い" }, findings: [{ code: "CRUSHED_BLACKS", issue: "黒つぶれ" }] } },
    }));
    assert.equal(again.results[0].source, "cache");
    pass("同じ質問・同じ state は 2 回目からキャッシュ");

    const none = await mcp.call("dx12_jev_ask", {});
    assert.equal(none.result.isError, true);
    pass("質問が無ければエラー");
  }

  console.log("[4] dx12_jev_status");
  {
    const st = payload(await mcp.call("dx12_jev_status", {}));
    assert.equal(st.keyPresent, true);
    assert.ok(!JSON.stringify(st).includes(FAKE_KEY), "鍵の値を出さない");
    assert.equal(st.baseDir, PROJ);
    assert.equal(st.brief.exists, true);
    assert.ok(["look.brief_fit", "look.next_fix", "finding.intended"].every((id) => st.questions.some((q: any) => q.id === id)));
    assert.ok(st.log.requests >= 2 && st.log.inputTokens >= 1400, JSON.stringify(st.log));
    assert.ok(st.log.cacheHits >= 1);
    assert.ok(st.cacheEntries >= 4, String(st.cacheEntries));
    assert.equal(st.jevDir, path.join(PROJ, ".dx12", "jev"));
    pass("鍵の有無(値は出さない)・質問一覧・記録からの累計・キャッシュ件数");
    const log = fs.readFileSync(path.join(PROJ, ".dx12", "jev", "log.jsonl"), "utf8");
    assert.ok(!log.includes("一人称ホラー") && !log.includes(FAKE_KEY), "記録に state と鍵が無い");
    pass("log.jsonl に state 本文と鍵を書かない");
  }

  console.log("[5] dx12_jev_eval");
  {
    const cases = path.join(TMP, "fit.cases.json");
    fs.writeFileSync(cases, JSON.stringify({ question: "look.brief_fit", cases: [
      { name: "c1", context: { brief: { genre: "パズル" }, facts: { look: { brightness: "明るい" }, findings: [] } },
        expect: 3, labelSource: "human" },
    ] }));
    const r = payload(await mcp.call("dx12_jev_eval", { casesPath: cases }));
    assert.equal(r.question, "look.brief_fit");
    assert.equal(r.n, 1);
    assert.equal(r.accuracy, 1, "3.4 は最寄りの段 3 で正解");
    assert.equal(r.mae, 0.4);
    assert.equal(r.cases[0].source, "jev");
    pass("ケースファイルを流して正解率と平均絶対誤差を返す");
  }

  console.log("[6] dx12_polish_audit の判断段");
  {
    const before = jevReqs.length;
    const res = await mcp.call("dx12_polish_audit", {});
    assert.equal(res.result.content[0].type, "image", "最終画は従来どおり先頭に付く");
    const r = payload(res);
    // 既存のフィールドは壊さない(後方互換)
    assert.equal(typeof r.score, "number");
    assert.equal(typeof r.verdict, "string");
    assert.ok(Array.isArray(r.findings) && r.findings.length > 0);
    assert.ok(r.findings.every((f: any) => f.code && f.what && f.why && f.fix), "指摘は code 付きで、what/why/fix は従来どおり");
    const codes = r.findings.map((f: any) => f.code);
    assert.ok(codes.includes("CRUSHED_BLACKS"), codes.join(","));
    pass("score / verdict / findings(what, why, fix)は従来どおり、指摘に code が増えた");

    assert.equal(jevReqs.length - before, 1, "判断段は 1 往復");
    const req = jevReqs[jevReqs.length - 1];
    assert.equal(Object.keys(req.questions).length, 2 + codes.length, "brief_fit + next_fix + 指摘ごとの intended");
    assert.equal(req.state.brief.genre, "一人称ホラー");
    assert.ok(!/\d/.test(JSON.stringify(req.state.facts.look)), `look に数値が入っている: ${JSON.stringify(req.state.facts.look)}`);
    assert.equal(req.state.facts.look.dirtAndWearDecals, "ひとつ", "デカールの有無も言葉で渡る");
    pass("1 リクエストで 2 + 指摘数の質問。state は Brief + 数値を含まない言葉");

    const j = r.judge;
    assert.equal(j.source, "jev");
    assert.equal(j.briefFit.value, 3.4);
    assert.deepEqual(j.findings.filter((f: any) => f.keep).map((f: any) => f.code), ["CRUSHED_BLACKS"]);
    assert.equal(j.nextFix.id, "add_fog");
    assert.equal(j.nextFix.tool, "dx12_set_volumetric_fog");
    assert.ok(j.scoreExcludingKept > r.score);
    assert.ok(r.facts.words && r.facts.words.brightness, "Jev に渡した言葉を facts.words に返す");
    pass("judge: {source:jev, briefFit, findings[keep], nextFix(ツールと引数), scoreExcludingKept}");

    const before2 = jevReqs.length;
    const off = payload(await mcp.call("dx12_polish_audit", { judge: false, screenshot: false }));
    assert.equal(off.judge, undefined);
    assert.equal(jevReqs.length, before2);
    pass("judge:false で判断段を止める(Jev に出ない)");

    fs.renameSync(path.join(PROJ, "brief.json"), path.join(PROJ, "brief.json.bak"));
    try {
      const nb = payload(await mcp.call("dx12_polish_audit", { screenshot: false }));
      assert.equal(jevReqs.length, before2, "Brief が無ければ聞かない");
      assert.equal(nb.judge.source, "rules");
      assert.equal(nb.judge.briefMissing, true);
      assert.equal(nb.judge.nextFix.id !== undefined, true);
      assert.equal(nb.judge.scoreExcludingKept, nb.score, "ルールのときはスコアも従来どおり");
      pass("Brief が無い → judge.source:rules + briefMissing、nextFix は効く順の先頭");
    } finally {
      fs.renameSync(path.join(PROJ, "brief.json.bak"), path.join(PROJ, "brief.json"));
    }
  }

  console.log("[7] 鍵の無いプロセスは Jev へ出ない");
  {
    const noKey = new McpStdio(engine.port, "");
    await noKey.init();
    try {
      const before = jevReqs.length;
      const r = payload(await noKey.call("dx12_jev_ask", {
        question: "finding.intended", vars: { code: "NO_FOG" }, context: { facts: { look: { fog: "なし" } } }, cache: "off",
      }));
      assert.equal(jevReqs.length, before);
      assert.equal(r.results[0].source, "rules");
      assert.equal(r.results[0].decided, false);
      assert.equal(r.keyPresent, false);
      pass("鍵なし → source:rules(finding.intended は既定で「直す」)、偽 Jev に 1 本も届かない");
      const pa = payload(await noKey.call("dx12_polish_audit", { screenshot: false }));
      assert.equal(jevReqs.length, before);
      assert.equal(pa.judge.source, "rules");
      assert.ok(!pa.judge.briefMissing, "Brief はあるので briefMissing ではない");
      pass("鍵なしの polish_audit も judge.source:rules で従来の結論");
    } finally { noKey.kill(); }
  }
} catch (e) {
  console.log(`  NG  ${(e as Error).message}`);
  mcp.kill(); engine.server.close(); jevServer.close();
  process.exit(1);
}

mcp.kill();
engine.server.close();
jevServer.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nOK: Jev ツール e2e テスト ${passed} 項目すべて通過`);
process.exit(0);
