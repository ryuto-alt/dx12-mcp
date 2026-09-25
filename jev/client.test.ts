// jev/client.ts の単体テスト(ネット不要。fetch を差し替える)。
// 守りたいのは 4 つ:
//   1) 再試行は 429 / 529 / ネットワーク断だけ。指数で待つ。それ以外の失敗は 1 回で諦める
//   2) タイムアウトは再試行しない(polish_audit を固めない)
//   3) 失敗は例外でなく {ok:false, kind} で返る(呼ぶ側がフォールバックし忘れない)
//   4) 鍵がエラー文に漏れない

import {
  DEFAULT_TIMEOUT_MS, JEV_MODEL, MAX_STATE_CHARS, USD_PER_INPUT_TOKEN, systemOne,
  type FetchLike,
} from "./client.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const KEY = "apikey_test_do_not_leak_0123456789";
const Q = { a: { type: "noul" as const, instructions: "Is it dark?" } };
const okBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 1000, output_tokens: 20 }, ...extra,
});

/** 応答を順に返す偽 fetch。呼ばれた回数と送られた中身を記録する。 */
function scripted(steps: Array<{ status?: number; body?: string; throws?: Error; retryAfter?: string; hang?: boolean }>) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const s = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (s.hang) {
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        });
      });
    }
    if (s.throws) throw s.throws;
    const status = s.status ?? 200;
    return {
      ok: status >= 200 && status < 300, status,
      text: async () => s.body ?? okBody(),
      headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? s.retryAfter ?? null : null) },
    };
  };
  return { fetch, calls };
}

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

console.log("[1] 鍵が無ければ送らない");
{
  const s = scripted([{}]);
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const r = await systemOne({ state: {}, questions: Q }, { fetch: s.fetch });
  if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  check("kind=no_key", !r.ok && r.kind === "no_key", JSON.stringify(r));
  check("fetch を呼ばない", s.calls.length === 0);
}

console.log("[2] 成功: 形・費用・送った中身");
{
  const s = scripted([{}]);
  const r = await systemOne({ state: { x: 1 }, questions: Q }, { apiKey: KEY, fetch: s.fetch });
  check("ok", r.ok, JSON.stringify(r));
  if (r.ok) {
    check("answers を返す", (r.answers.a as any).noul === 0.9);
    check("usd = 入力トークン × 単価(出力は無料)", Math.abs(r.usd - 1000 * USD_PER_INPUT_TOKEN) < 1e-12, String(r.usd));
    check("1000 トークン = $0.000042", Math.abs(r.usd - 0.000042) < 1e-12);
    check("attempts=1", r.attempts === 1);
    check("ms は数値", typeof r.ms === "number" && r.ms >= 0);
    check("応答のモデル名を返す", r.model === "jev-1.13.0");
  }
  const sent = JSON.parse(s.calls[0].body);
  check("model は jev-latest", sent.model === JEV_MODEL && JEV_MODEL === "jev-latest");
  check("Bearer で送る", s.calls[0].headers.Authorization === `Bearer ${KEY}`);
  check("Content-Type json", s.calls[0].headers["Content-Type"] === "application/json");
  check("既定タイムアウトは 4000ms", DEFAULT_TIMEOUT_MS === 4000);
}

console.log("[3] 429 / 529 は指数バックオフで最大 2 回まで撃ち直す");
{
  const s = scripted([{ status: 429 }, { status: 529 }, {}]);
  const sl = sleeper();
  const r = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s.fetch, sleep: sl.sleep, random: () => 0 });
  check("3 回目で通る", r.ok && r.attempts === 3, JSON.stringify(r));
  check("2 回待った", sl.waits.length === 2, JSON.stringify(sl.waits));
  check("待ち時間が倍々(300 → 600)", sl.waits[0] === 300 && sl.waits[1] === 600, JSON.stringify(sl.waits));

  const s2 = scripted([{ status: 529 }]);
  const sl2 = sleeper();
  const r2 = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s2.fetch, sleep: sl2.sleep, random: () => 0 });
  check("ずっと 529 なら 3 回で諦める", !r2.ok && r2.kind === "http" && r2.status === 529 && s2.calls.length === 3,
    JSON.stringify({ r2, calls: s2.calls.length }));
  check("最後の失敗の後は待たない", sl2.waits.length === 2);
}

console.log("[4] Retry-After を尊重する(上限 5 秒)");
{
  const s = scripted([{ status: 429, retryAfter: "2" }, {}]);
  const sl = sleeper();
  await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s.fetch, sleep: sl.sleep, random: () => 0 });
  check("2 秒待つ", sl.waits[0] === 2000, JSON.stringify(sl.waits));
  const s2 = scripted([{ status: 429, retryAfter: "600" }, {}]);
  const sl2 = sleeper();
  await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s2.fetch, sleep: sl2.sleep, random: () => 0 });
  check("長すぎる指示は 5 秒で切る", sl2.waits[0] === 5000, JSON.stringify(sl2.waits));
}

console.log("[5] 撃ち直しても無駄な失敗は 1 回で諦める");
{
  for (const status of [400, 401, 403, 500]) {
    const s = scripted([{ status, body: `{"error":"bad"}` }]);
    const sl = sleeper();
    const r = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s.fetch, sleep: sl.sleep });
    check(`${status} は再試行しない`, !r.ok && r.kind === "http" && s.calls.length === 1 && sl.waits.length === 0,
      JSON.stringify({ r, calls: s.calls.length }));
  }
}

console.log("[6] ネットワーク断は撃ち直す / タイムアウトは撃ち直さない");
{
  const s = scripted([{ throws: new TypeError("fetch failed") }, {}]);
  const sl = sleeper();
  const r = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s.fetch, sleep: sl.sleep, random: () => 0 });
  check("ネットワーク断の次で通る", r.ok && r.attempts === 2, JSON.stringify(r));

  const h = scripted([{ hang: true }]);
  const sl2 = sleeper();
  const r2 = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: h.fetch, sleep: sl2.sleep, timeoutMs: 30 });
  check("kind=timeout", !r2.ok && r2.kind === "timeout", JSON.stringify(r2));
  check("タイムアウトは 1 回だけ", h.calls.length === 1 && sl2.waits.length === 0, String(h.calls.length));
}

console.log("[7] 壊れた応答・大きすぎる state");
{
  const s = scripted([{ body: "<html>gateway</html>" }]);
  const r = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s.fetch });
  check("JSON でない応答は bad_response", !r.ok && r.kind === "bad_response", JSON.stringify(r));
  const s2 = scripted([{ body: `{"model":"x"}` }]);
  const r2 = await systemOne({ state: {}, questions: Q }, { apiKey: KEY, fetch: s2.fetch });
  check("answers の無い応答も bad_response", !r2.ok && r2.kind === "bad_response");
  const s3 = scripted([{}]);
  const r3 = await systemOne({ state: { big: "あ".repeat(MAX_STATE_CHARS + 10) }, questions: Q }, { apiKey: KEY, fetch: s3.fetch });
  check("大きすぎる state は送らない", !r3.ok && r3.kind === "too_large" && s3.calls.length === 0, JSON.stringify(r3).slice(0, 200));
}

console.log("[8] 鍵がエラー文に漏れない");
{
  const outs: string[] = [];
  for (const step of [{ status: 401, body: "unauthorized" }, { throws: new TypeError("socket hang up") }, { body: "nope" }]) {
    const s = scripted([step]);
    outs.push(JSON.stringify(await systemOne({ state: {}, questions: Q },
      { apiKey: KEY, fetch: s.fetch, sleep: async () => {}, retries: 0 })));
  }
  check("どの失敗にも鍵が含まれない", outs.every((o) => !o.includes(KEY)), outs.join("\n"));
}

console.log(failed === 0 ? "\nOK: jev/client テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
