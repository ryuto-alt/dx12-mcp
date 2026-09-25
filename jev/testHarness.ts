// 判断段の e2e テスト用の部品(偽エンジン・偽 Jev・stdio の MCP クライアント)。テスト専用。
//
// ★本物のエディタ(8787)にも本物の Jev にも繋がない: index.ts を子プロセスで起こし、
//   DX12_MCP_PORT を偽エンジンへ、JEV_ENDPOINT を偽 Jev へ、TYPESAFE_API_KEY をテスト用の偽の値へ差し替える。
//   jev/tools.test.ts と同じ作り(あちらは polish_audit / Brief の e2e、こちらは ui / layout / play / gate)。

import net from "node:net";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_TS = path.join(here, "..", "index.ts");

export type EngineHandler = (method: string, params: any) => any;

/** 1 行 1 JSON の偽エンジン。handler が undefined を返した method は NOT_FOUND にする。 */
export async function startFakeEngine(handler: EngineHandler) {
  const received: { method: string; params: any }[] = [];
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
        received.push({ method: req.method, params: req.params ?? {} });
        let result: any;
        try { result = handler(req.method, req.params ?? {}); }
        catch (e: any) {
          sock.write(JSON.stringify({ id: req.id, ok: false, error_code: e?.code ?? 7, error: String(e?.message ?? e) }) + "\n");
          continue;
        }
        sock.write(JSON.stringify(result === undefined
          ? { id: req.id, ok: false, error_code: 1, error: `偽エンジンは ${req.method} を知らない` }
          : { id: req.id, ok: true, result }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port, received };
}

export type JevReq = { auth: string; state: any; questions: Record<string, any> };
export type FakeJevAnswers = {
  /** 質問(instructions の JSON 文字列)→ yes の確率。 */
  noul?: (instructions: string, state: any) => number;
  choice?: (keys: string[], instructions: string, state: any) => { choice: string; confidence: number };
  score?: (instructions: string, state: any) => { score: number; confidence: number };
};

/** 質問の型に合わせて答える偽 Jev(HTTP)。answers は差し替え可能(テストの途中で変えられる)。 */
export async function startFakeJev(answers: FakeJevAnswers = {}) {
  const reqs: JevReq[] = [];
  const cfg = { answers };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const b = JSON.parse(body);
      reqs.push({ auth: String(req.headers.authorization ?? ""), state: b.state, questions: b.questions });
      const out: Record<string, unknown> = {};
      for (const [k, q] of Object.entries<any>(b.questions)) {
        const text = JSON.stringify(q.instructions);
        if (q.type === "noul") out[k] = { type: "noul", noul: cfg.answers.noul?.(text, b.state) ?? 0.1 };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria ?? {});
          const c = cfg.answers.choice?.(keys, text, b.state) ?? { choice: keys[0], confidence: 0.8 };
          out[k] = { type: "choice", choice: c.choice, confidence: c.confidence, probabilities: { [c.choice]: c.confidence } };
        } else {
          const s = cfg.answers.score?.(text, b.state) ?? { score: 3, confidence: 0.9 };
          out[k] = { type: "score", score: s.score, confidence: s.confidence, legend: {}, probabilities: {} };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "jev-fake", answers: out, usage: { input_tokens: 700, output_tokens: 30 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1/systemone`;
  return { server, url, reqs, cfg };
}

/** stdio の MCP クライアント(最小実装)。 */
export class McpStdio {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  stderr = "";
  constructor(opts: { enginePort: number; jevUrl: string; key: string; env?: Record<string, string> }) {
    const env: Record<string, string | undefined> = {
      ...process.env, DX12_MCP_PORT: String(opts.enginePort), DX12_MCP_HOST: "127.0.0.1", DX12_ASSETS_DIR: "",
      TYPESAFE_API_KEY: opts.key, JEV_ENDPOINT: opts.jevUrl, DX12_PROJECT_DIR: "", ...(opts.env ?? {}),
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
  private send(method: string, params: any, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}\n${this.stderr}`)), timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jev.e2e", version: "0" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }
  listTools = () => this.send("tools/list", {});
  call = (name: string, args: any, timeoutMs?: number) => this.send("tools/call", { name, arguments: args }, timeoutMs);
  kill() { this.proc.kill(); }
}

/** JSON ツールは content[0].text、画像付きは最後の text ブロック。エラーなら例外。 */
export function payload(res: any): any {
  if (res?.result?.isError) throw new Error(`ツールがエラーを返した: ${res.result.content?.[0]?.text}`);
  const texts = (res?.result?.content ?? []).filter((c: any) => c.type === "text");
  if (texts.length === 0) throw new Error(`text が無い: ${JSON.stringify(res).slice(0, 400)}`);
  return JSON.parse(texts[texts.length - 1].text);
}
