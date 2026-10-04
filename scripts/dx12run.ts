// dx12run — AI が書いたスクリプトを、起動中のエンジンに対して 1 回でまとめて実行する(コードモード)。
//
//   node tools/mcp-server/scripts/dx12run.ts <script.mjs> [--port N] [--timeout 秒] [--max-output 文字数] [--allow-guarded]
//   node tools/mcp-server/scripts/dx12run.ts -e "<async 関数の本体。dx が使える>" [同じオプション]
//
// ★なぜ要るか(2026-10-04 の実測): エンジンの往復は 1 回 17ms なのに、MCP のツールを 1 手ずつ呼ぶと
//   1 手ごとにモデルのターン(中央値 3.7 秒)が挟まる。手順をスクリプトに書いて 1 回で流せば、
//   ループ・判定・集計はスクリプトの中で済み、モデルに返るのは要約だけになる(Anthropic「Code execution with MCP」)。
//
// スクリプトの形(.mjs / .ts):
//   export default async (dx) => {
//     await dx.call("set_transform", { name: "Player", position: [0, 2, 0] });   // エンジンの method を直接
//     const ys = [];
//     for (let i = 0; i < 6; i++) { await dx.step(10, { deterministic: true }); ys.push(Number(await dx.lua("return P.transform.position.y"))); }
//     return { ys };                                                               // これだけが JSON で出力される
//   };
//   dx = { call(method, params, opts?), lua(code) → 文字列, step(frames, opts?), log(...args), port }
//
// 出力は 1 行の JSON: {ok, result, logs, calls, elapsedMs}(失敗は {ok:false, error, errName, hint, ...})。
// --max-output(既定 20000 文字)を超えたら切り詰めて truncated を付ける(コンテキストを食わないため)。
//
// 接続先: --port > DX12_MCP_PORT > %TEMP%/dx12_mcp.port(engineClient と同じ)。フリートの専用エンジンは --port で指す。
// ★エンジンのブリッジが複数クライアントに対応した版(2026-10-04 以降)が要る。古い版では MCP サーバが繋いでいる間、
//   ここからの接続は返事が来ずにタイムアウトする。
//
// 承認: eval_lua(dx.lua)は使える(このスクリプトを走らせること自体を人が承認している、という扱い。dx12_eval_lua と同じ)。
//   それ以外の guarded(git push・delete_asset・build_game など)は --allow-guarded を付けたときだけ。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EngineClient } from "../engineClient.ts";
import { GUARDED_METHODS, guardApproval } from "../guardCtx.ts";

type Opts = { file?: string; inline?: string; port?: number; timeoutSec: number; maxOutput: number; allowGuarded: boolean };

function usage(msg?: string): never {
  if (msg) process.stderr.write(`dx12run: ${msg}\n`);
  process.stderr.write("使い方: node tools/mcp-server/scripts/dx12run.ts <script.mjs> | -e \"<本体>\" [--port N] [--timeout 秒] [--max-output 文字数] [--allow-guarded]\n");
  process.exit(2);
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { timeoutSec: 300, maxOutput: 20000, allowGuarded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) usage(`${a} に値が要る`); return argv[++i]; };
    if (a === "-e" || a === "--eval") o.inline = next();
    else if (a === "--port") o.port = Number(next());
    else if (a === "--timeout") o.timeoutSec = Number(next());
    else if (a === "--max-output") o.maxOutput = Number(next());
    else if (a === "--allow-guarded") o.allowGuarded = true;
    else if (a === "-h" || a === "--help") usage();
    else if (!a.startsWith("-") && !o.file) o.file = a;
    else usage(`知らない引数: ${a}`);
  }
  if (!o.file && o.inline === undefined) usage("スクリプトのファイルか -e が要る");
  if (o.port !== undefined && !(o.port > 0)) usage("--port は正の整数");
  return o;
}

async function loadScript(o: Opts): Promise<(dx: any) => Promise<unknown>> {
  if (o.inline !== undefined) {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    return new AsyncFunction("dx", o.inline) as (dx: any) => Promise<unknown>;
  }
  const mod = await import(pathToFileURL(path.resolve(o.file!)).href);
  const fn = mod.default;
  if (typeof fn !== "function") throw Object.assign(new Error("スクリプトは export default async (dx) => {...} の形にする"), { errName: "E_INVALID_PARAM" });
  return fn;
}

function emit(obj: Record<string, unknown>, maxOutput: number): void {
  let s = JSON.stringify(obj);
  if (s.length > maxOutput) {
    const resultText = JSON.stringify(obj.result ?? null);
    s = JSON.stringify({ ...obj, result: resultText.slice(0, Math.max(0, maxOutput - 400)), truncated: true,
      note: `出力が ${s.length} 文字あったので result を切り詰めた。スクリプト側で要約して返すこと` });
  }
  process.stdout.write(s + "\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const client = new EngineClient(undefined, o.port, undefined, { backoffMs: [300, 600] });
  const logs: string[] = [];
  let calls = 0;
  const t0 = Date.now();
  const dx = {
    port: client.getPort(),
    async call(method: string, params: Record<string, unknown> = {}, opts?: { timeout?: number }) {
      if (GUARDED_METHODS.has(method) && method !== "eval_lua" && !o.allowGuarded) {
        throw Object.assign(new Error(`guarded な method '${method}' はスクリプトからは撃てない(--allow-guarded を人が付けたときだけ)`), { errName: "E_GUARDED" });
      }
      calls++;
      return client.call(method, params, opts);
    },
    async lua(code: string): Promise<string> { return (await dx.call("eval_lua", { code }))?.result ?? ""; },
    async step(frames: number, opts: { deterministic?: boolean; dt?: number; hold?: boolean } = {}) { return dx.call("step_frames", { frames, ...opts }); },
    log(...args: unknown[]) { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); },
  };
  const timer = setTimeout(() => {
    emit({ ok: false, error: `スクリプトが ${o.timeoutSec} 秒で終わらなかった`, errName: "E_TIMEOUT", logs, calls, elapsedMs: Date.now() - t0 }, o.maxOutput);
    process.exit(1);
  }, o.timeoutSec * 1000);
  try {
    const fn = await loadScript(o);
    const result = await guardApproval.run({ approved: true, via: "dx12run" }, () => fn(dx));
    clearTimeout(timer);
    emit({ ok: true, result: result ?? null, logs, calls, elapsedMs: Date.now() - t0 }, o.maxOutput);
    client.close();
    process.exit(0);
  } catch (e: any) {
    clearTimeout(timer);
    emit({ ok: false, error: e?.message ?? String(e), errName: e?.errName, hint: e?.hint, method: e?.method,
      didYouMean: e?.didYouMean, logs, calls, elapsedMs: Date.now() - t0 }, o.maxOutput);
    client.close();
    process.exit(1);
  }
}

await main();
