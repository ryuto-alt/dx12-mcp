// Jev(TypeSafe System One)への薄い HTTP 層。判断(型付きの答え)だけを返すモデルを叩く。
//
// ★なぜ Jev か: polish_audit などの「良し悪し」は今まで手書きの閾値だけで決めていた。
//   閾値は作品の意図(Brief)を知らないので、ホラーの暗さも明るいパズルの暗さも同じ
//   「黒つぶれ」と言ってしまう。Jev は 0.3〜1 秒・出力無料で「この Brief に照らして」
//   の判断を返せるうえ、質問を何個束ねても並列評価で遅延が増えない。
//   ただし配布ゲームには入れない(開発時の MCP サーバ専用)。
//
// ★失敗を例外で投げない: 呼ぶ側(library.ts)は失敗したら必ずルールへ落とす。
//   try/catch を呼び出し側に散らすより、{ok:false, kind} を値として返す方が
//   「フォールバックし忘れ」が起きない。
//
// ★鍵(TYPESAFE_API_KEY)はこのファイルの外へ一切出さない。エラー文にもログにも入れない。
//
// このファイルは fetch を注入できる(テストはネット無しで回す)。

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
/** 入力トークン単価(USD)。出力は無料。2026-09 時点の公式価格 $0.042 / 100 万トークン。 */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const DEFAULT_TIMEOUT_MS = 4000;
export const DEFAULT_RETRIES = 2;
/**
 * state が大きすぎるものは送る前に止める。公式の上限は state 32k トークン / 全体 64k。
 * トークン数は手元で正確に数えられないので、文字数で保守的に切る(日本語は 1 文字 ≒ 1 トークン強)。
 */
export const MAX_STATE_CHARS = 30_000;

export type JevType = "noul" | "choice" | "score";

export type JevQuestion = {
  type: JevType;
  instructions: unknown;
  criteria?: unknown;
};

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; legend?: Record<string, unknown>; probabilities?: Record<string, number> };

export type JevUsage = { input_tokens: number; output_tokens: number };

export type JevOk = {
  ok: true;
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  ms: number;
  usd: number;
  attempts: number;
};

export type JevFailKind = "no_key" | "http" | "timeout" | "network" | "bad_response" | "too_large";

export type JevFail = {
  ok: false;
  kind: JevFailKind;
  error: string;
  status?: number;
  ms: number;
  attempts: number;
};

export type JevResponse = JevOk | JevFail;

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

export type ClientOptions = {
  /** 省略時は process.env.TYPESAFE_API_KEY。 */
  apiKey?: string;
  /** 省略時は process.env.JEV_ENDPOINT → JEV_ENDPOINT。テストで偽サーバへ向けるため。 */
  endpoint?: string;
  model?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** バックオフの基準(ms)。n 回目の再試行は base * 2^(n-1) + ゆらぎ。 */
  backoffMs?: number;
  /** テストで待ち時間を潰すための差し替え口。 */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export function apiKeyFromEnv(): string | undefined {
  const k = process.env.TYPESAFE_API_KEY;
  return k && k.trim() ? k.trim() : undefined;
}

export function hasApiKey(opts: { apiKey?: string } = {}): boolean {
  return !!(opts.apiKey ?? apiKeyFromEnv());
}

export function usdOf(usage: Partial<JevUsage> | undefined): number {
  return (usage?.input_tokens ?? 0) * USD_PER_INPUT_TOKEN;
}

/** 429(混雑) と 529(過負荷) は待てば通る。それ以外の 4xx/5xx は撃ち直しても同じ。 */
function retryableStatus(status: number): boolean {
  return status === 429 || status === 529;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After(秒 or HTTP 日付)を ms に。読めなければ null。長すぎる指示は上限で切る。 */
function retryAfterMs(h: string | null | undefined): number | null {
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec)) return Math.min(5000, Math.max(0, sec * 1000));
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.min(5000, Math.max(0, at - Date.now()));
  return null;
}

/** 応答の形を最低限検査する。答えの中身の正しさは保証されないが、形が崩れた物を下流へ流さない。 */
function looksLikeResponse(d: any): d is { model: string; answers: Record<string, JevAnswer>; usage?: JevUsage } {
  return d && typeof d === "object" && d.answers && typeof d.answers === "object";
}

/**
 * 1 リクエスト。state 1 つに質問を何個でも束ねてよい(並列評価なので遅延は増えない)。
 *
 * 再試行するのは 429 / 529 / ネットワーク断だけ。
 * ★タイムアウトは再試行しない: 4 秒待ってさらに 2 回だと polish_audit が 12 秒以上固まる。
 *   判断段にはルールのフォールバックがあるので、遅いときは早く諦めた方が全体は速い。
 */
export async function systemOne(
  req: { state: unknown; questions: Record<string, JevQuestion> },
  opts: ClientOptions = {},
): Promise<JevResponse> {
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const apiKey = opts.apiKey ?? apiKeyFromEnv();
  if (!apiKey) return { ok: false, kind: "no_key", error: "TYPESAFE_API_KEY が未設定", ms: 0, attempts: 0 };

  const body = JSON.stringify({ state: req.state, model: opts.model ?? JEV_MODEL, questions: req.questions });
  const stateChars = JSON.stringify(req.state ?? null).length;
  if (stateChars > MAX_STATE_CHARS) {
    return {
      ok: false, kind: "too_large", ms: 0, attempts: 0,
      error: `state が大きすぎる(${stateChars} 文字 > ${MAX_STATE_CHARS})。質問に要るフィールドだけへ射影すること`,
    };
  }

  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const endpoint = opts.endpoint ?? process.env.JEV_ENDPOINT ?? JEV_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
  const backoff = opts.backoffMs ?? 300;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;

  let last: JevFail = { ok: false, kind: "network", error: "未送信", ms: 0, attempts: 0 };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let waitHint: number | null = null;
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 本文は 300 文字まで(サーバのエラー文は長いことがある。鍵は送っても返ってこない)。
        last = {
          ok: false, kind: "http", status: res.status, ms: elapsed(), attempts: attempt + 1,
          error: `TypeSafe ${res.status}: ${text.slice(0, 300)}`,
        };
        if (!retryableStatus(res.status)) return last;
        waitHint = retryAfterMs(res.headers?.get("retry-after"));
      } else {
        let data: any;
        try { data = JSON.parse(text); } catch {
          return { ok: false, kind: "bad_response", error: `JSON として読めない応答: ${text.slice(0, 200)}`,
                   ms: elapsed(), attempts: attempt + 1 };
        }
        if (!looksLikeResponse(data)) {
          return { ok: false, kind: "bad_response", error: `answers の無い応答: ${text.slice(0, 200)}`,
                   ms: elapsed(), attempts: attempt + 1 };
        }
        const usage: JevUsage = {
          input_tokens: Number(data.usage?.input_tokens ?? 0),
          output_tokens: Number(data.usage?.output_tokens ?? 0),
        };
        return {
          ok: true, model: String(data.model ?? opts.model ?? JEV_MODEL), answers: data.answers, usage,
          ms: elapsed(), usd: usdOf(usage), attempts: attempt + 1,
        };
      }
    } catch (e: any) {
      if (e?.name === "AbortError" || ac.signal.aborted) {
        return { ok: false, kind: "timeout", error: `${timeoutMs}ms でタイムアウト`, ms: elapsed(), attempts: attempt + 1 };
      }
      last = { ok: false, kind: "network", error: `通信失敗: ${String(e?.message ?? e)}`, ms: elapsed(), attempts: attempt + 1 };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      const expo = backoff * 2 ** attempt + Math.floor(random() * backoff * 0.3);
      await sleep(Math.max(expo, waitHint ?? 0));
    }
  }
  return last;
}
