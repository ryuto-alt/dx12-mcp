// DXR パストレーサー(地上真値レンダラ。パリティ基盤 Q1a)。設計・仕様・光の単位の対応は docs/PATH_TRACER.md。
//   dx12_render_reference         … リファレンスレンダーを開始(即座に返る。waitSec を付けるとその秒数まで完了を待つ)
//   dx12_render_reference_status  … 状態 / 進捗 / 出力ファイル / 統計
//   dx12_render_reference_cancel  … 中止(save:true でそこまでの結果を保存)
// 進捗の形({phase,pct,message,etaSec})は M6 のジョブ API の Progress と同じ。
//
// 登録の作法はフリート / ジョブ(toolset/fleet.ts / jobs.ts)と同じ:
//   ・legacy 面(旧 220 本のスナップショット = 1 バイトも変えない回帰基準)には出さない
//   ・full 面: 旧 220 本 + フリート 6 + ジョブ 6 の後ろ(末尾)に 3 本 / core・shell 面: tools/list には出さず dx12_call で使う(長尾)
import { z } from "zod";
import { engine, errResult, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY } from "../toolRuntime.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { ERROR_BODY } from "../toolRuntime.ts";

export const PT_TOOLS = ["dx12_render_reference", "dx12_render_reference_status", "dx12_render_reference_cancel"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TERMINAL = new Set(["done", "failed", "cancelled"]);

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}

/** 進捗通知(notifications/progress)。progressToken が無ければ何もしない(ベストエフォート)。 */
function notifier(extra: any): ((st: any) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if ((typeof token !== "string" && typeof token !== "number") || typeof send !== "function") return undefined;
  let last = 0;
  return (st) => {
    const pct = typeof st?.progress?.pct === "number" ? st.progress.pct : null;
    if (last >= 100) return;
    const progress = Math.min(100, Math.max(last + 0.001, pct ?? last));
    last = progress;
    const eta = st?.progress?.etaSec;
    const msg = `[render_reference] ${st?.progress?.message || st?.state}${typeof eta === "number" ? `(残り約 ${Math.round(eta)} 秒)` : ""}`;
    try { void Promise.resolve(send({ method: "notifications/progress", params: { progressToken: token, progress, total: 100, message: msg.slice(0, 300) } })).catch(() => {}); } catch { /* 同上 */ }
  };
}

const startShape = {
  spp: z.number().int().min(1).max(1048576).optional().describe("画素あたりのサンプル数(目標。既定 256)。誤差は 1/√N で減る。"),
  bounces: z.number().int().min(1).max(64).optional().describe("散乱頂点の上限(既定 8)。1 = 直接光のみ / N = 最大 N-1 回の間接バウンス。"),
  size: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional().describe("出力解像度 [幅, 高さ](既定 [1920,1080])。ビューポートの矩形に依存しない。"),
  camera: z.object({
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    fovDeg: z.number().optional().describe("垂直 FOV(度。既定 45)"),
    lensRadius: z.number().optional().describe("薄レンズの半径(m。被写界深度。既定 0 = ピンホール)"),
    focusDist: z.number().optional().describe("合焦距離(m。lensRadius>0 のとき)"),
  }).optional().describe("カメラ。省略 = 今の描画カメラ(エディタ / ゲーム)。"),
  output: z.string().optional().describe("出力の基準パス(拡張子なし。.pfm/.exr/.png/.json を付けて書く)。省略 = <project>/.dx12/pt/render_<日時>。"),
  seed: z.number().int().min(0).optional().describe("乱数シード(既定 1)。"),
  maxRadiance: z.number().min(0).optional().describe("1 サンプルの放射輝度の上限(ファイアフライ抑制)。既定 0 = クランプ無し(GT)。"),
  frameBudgetMs: z.number().min(0.5).max(200).optional().describe("1 フレームに PT へ使う GPU 時間の上限(ms。既定 12)。"),
  maxSeconds: z.number().min(0).optional().describe("実行時間の上限(秒)。超えたらそこまでの結果を保存して終わる(truncated:true)。既定 0 = 無制限。"),
  formats: z.array(z.enum(["pfm", "exr", "png"])).optional().describe("書き出す形式(既定 [\"pfm\",\"png\"])。メタ JSON は常に書く。"),
  exposure: z.number().positive().optional().describe("プレビュー PNG の露出(倍率)。線形 HDR には掛けない。"),
  lightFalloff: z.enum(["engine", "physical"]).optional().describe("点/スポットの減衰。engine = フォワードと同じ(既定)/ physical = 逆二乗。"),
  sunAngularRadiusDeg: z.number().min(0).max(45).optional().describe("太陽の角半径(度)。省略 = PCSS の設定に従う(OFF ならデルタ光)。"),
  russianRoulette: z.boolean().optional().describe("ロシアンルーレット(不偏。既定 true)。"),
  forceLambert: z.boolean().optional().describe("全材質を純ランバートにする(検証用)。"),
  normalMaps: z.boolean().optional().describe("法線マップを使う(既定 true)。"),
  quantizeLikeForward: z.boolean().optional().describe("材質値(色ティント/不透明度/アルファ閾値/発光)をフォワードと同じ 8bit 量子化にする(既定 true)。"),
  background: z.boolean().optional().describe("カメラから見える空を描く(skybox の設定に従う。既定 true)。false = 黒。"),
  tileSize: z.number().int().min(16).max(2048).optional().describe("1 ディスパッチのタイル辺(画素。既定 256)。TDR 対策の分割単位。"),
  samplesPerDispatch: z.number().int().min(1).max(256).optional().describe("1 ディスパッチで回すサンプル数(既定 1)。"),
  note: z.string().optional().describe("メタ JSON にそのまま入れる自由メモ。"),
  waitSec: z.number().min(0).max(3600).optional().describe("開始後、この秒数まで完了を待って最終状態を返す(既定 0 = 待たない)。待つ間は 2 秒ごとに状態を読み、進捗通知も送る。"),
};

type Def = { title: string; description: string; shape: Record<string, z.ZodTypeAny>; annotations: Record<string, unknown>; keywords: string; run: (a: any, extra?: any) => Promise<unknown> };

const DEFS: Record<string, Def> = {
  dx12_render_reference: {
    title: "リファレンスレンダー(パストレーサー)",
    description:
      "DXR パストレーサー(地上真値)でシーンを描き、線形 HDR(PFM / EXR)+ プレビュー PNG + メタ JSON を書く。"
      + "フォワード + DDGI/SSGI/SSR との比較の基準画像(UE の並べ比較の代わり)。"
      + "\n■ 即座に返る(state:\"requested\")。進捗は dx12_render_reference_status。waitSec を付けるとその秒数まで完了を待って最終状態を返す。"
      + "\n■ エンジンを固めない: 1 フレームに使う GPU 時間は frameBudgetMs(既定 12ms)まで。無人で急ぐなら 40 程度に上げる。"
      + "\n■ 決定論: 同じシード + 同じ設定 = 同じ結果。bounces=1 は直接光のみ、N は最大 N-1 回の間接バウンス。"
      + "\n■ 材質は【フォワードと同じ BRDF】(GGX + Lambert / エネルギー保存なし)なので、差は光輸送のアルゴリズム差だけになる。"
      + "光の単位はエンジンのまま(点/スポットは saturate(1-d/range)^2。lightFalloff:\"physical\" で逆二乗)。"
      + "\n■ 制約: 仮想ジオメトリはプロキシ(低ポリ)でトレースされる / スプラット地形・カスタムシェーダは標準 PBR で近似 / "
      + "スキンドは法線マップ無し(滑らかな法線は近似)。詳細は docs/PATH_TRACER.md。",
    shape: startShape,
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    keywords: "path tracer pathtracer reference ground truth render パストレーサー リファレンス 地上真値 基準画像 gt レイトレ 比較 hdr pfm exr unreal parity ue 並べ比較",
    run: async (a, extra) => {
      const { waitSec, ...params } = a;
      const started: any = await engine.call("render_reference", params);
      if (!waitSec || waitSec <= 0) return started;
      const notify = notifier(extra);
      const deadline = Date.now() + waitSec * 1000;
      let st: any = null;
      while (Date.now() < deadline) {
        await sleep(2000);
        st = await engine.call("render_reference_status", {});
        notify?.(st);
        if (TERMINAL.has(st?.state)) return { started, ...st };
      }
      return { started, ...(st ?? {}), note: `waitSec(${waitSec}s)以内に終わらなかった。dx12_render_reference_status で続きを読む` };
    },
  },
  dx12_render_reference_status: {
    title: "リファレンスレンダーの状態",
    description:
      "dx12_render_reference の状態。{state: idle|requested|preparing|running|finalizing|done|failed|cancelled, "
      + "progress{phase,pct,message,etaSec}, samples{done,target}, gpu{msPerSpp}, output{base,files[],truncated,sppDone,nanSamples}, scene{...}, error}。"
      + "preview:true で今までの累積を <output>.preview.png(簡易トーンマップ)へ書く(GPU の完了待ちで数十 ms 止まる)。"
      + "waitSec を付けると終わるまで(最大その秒数)待つ。",
    shape: {
      preview: z.boolean().optional().describe("true = 途中経過のプレビュー PNG を書く(running のときだけ)。"),
      waitSec: z.number().min(0).max(3600).optional().describe("終わるまで最大この秒数だけ待つ(既定 0 = 待たない)。"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "path tracer reference status progress 進捗 リファレンス パストレーサー",
    run: async (a, extra) => {
      let st: any = await engine.call("render_reference_status", a.preview ? { preview: true } : {});
      if (!a.waitSec || a.waitSec <= 0) return st;
      const notify = notifier(extra);
      const deadline = Date.now() + a.waitSec * 1000;
      while (!TERMINAL.has(st?.state) && st?.state !== "idle" && Date.now() < deadline) {
        await sleep(2000);
        st = await engine.call("render_reference_status", {});
        notify?.(st);
      }
      return st;
    },
  },
  dx12_render_reference_cancel: {
    title: "リファレンスレンダーを中止",
    description: "実行中のリファレンスレンダーを止める。save:true でそこまでの累積(spp は目標未満)を保存する(既定は捨てる)。",
    shape: { save: z.boolean().optional().describe("そこまでの結果を保存する(既定 false)。") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    keywords: "path tracer reference cancel stop 中止 キャンセル パストレーサー",
    run: async (a) => engine.call("render_reference_cancel", a.save ? { save: true } : {}),
  },
};

if (ENHANCED && SURFACE !== "legacy") {
  for (const name of PT_TOOLS) {
    const def = DEFS[name];
    const declared = Object.keys(def.shape);
    const invoke = async (args: any, extra?: any): Promise<ToolResult> => {
      const issues = unknownKeyIssues(args ?? {}, declared);
      if (issues.length > 0) return errorResult(bodyFromIssues(name, args ?? {}, issues, declared));
      try {
        const data = await def.run(args ?? {}, extra);
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
      } catch (e: any) {
        return errResult(e);
      }
    };
    const hidden = SURFACE === "shell" || SURFACE === "core";
    const registered = server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: z.object(def.shape).passthrough() as any, annotations: { title: def.title, ...def.annotations } },
      async (args: any, extra: any) => invoke(args, extra),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title: def.title, description: def.description, shape: def.shape, annotations: def.annotations, tier: "core", core: false, coreDescription: def.description,
      extraKeywords: def.keywords, invoke: (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}
