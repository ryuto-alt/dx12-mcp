// フリート(複数エンジンの管理)のツール 6 本: dx12_engine_launch / list / stop / attach / refresh / use。
// 中身は fleet/fleet.ts。ここは MCP への登録と、FleetFailure(構造化エラー)の変換だけ。設計は docs/MCP_FLEET_DESIGN.md。
//
//   ・full 面: 旧 220 本の後ろ(tools/list の末尾)に 6 本。core 面: 5 本(use は長尾 = dx12_call)。shell 面: 全部 dx12_call 経由。legacy 面: 出さない。
//   ・エラーは ErrorBody を最初から組んで返す(ERROR_BODY)。dx12_call 経由でも組み直さない。
import { z } from "zod";
import { server, router, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, recordError, ERROR_BODY } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS, CORE_FLEET, FLEET_TOOLS } from "../coreSpec.ts";
import { envelope, type ErrorBody } from "../errors.ts";
import { bodyFromIssues, unknownKeyIssues } from "../validate.ts";
import { FleetFailure } from "../fleet/fleet.ts";
import { getFleet, fleetConfig } from "../fleet/runtime.ts";
import { setFleetToolsEnabled } from "../fleet/enabled.ts";

const cfg0 = fleetConfig();

function errorResult(body: ErrorBody): ToolResult {
  const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
  ERROR_BODY.set(res, body);
  return res;
}

async function fleetRun(tool: string, fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
  } catch (e: any) {
    const body: ErrorBody = e instanceof FleetFailure ? e.body : {
      code: "E_INTERNAL", message: `${tool}: ${e?.message ?? e}`, retryable: false,
      fix: [{ tool: "dx12_doctor", args: {}, why: "フリートの状態と接続を診断する" }],
    };
    recordError({ at: Date.now(), tool, code: body.code, message: body.message });
    return errorResult(body);
  }
}

const refShape = z.union([z.string(), z.number().int()]);

type Def = { title: string; shape: Record<string, z.ZodTypeAny>; annotations: Record<string, unknown>; keywords: string; run: (a: any) => Promise<unknown> | unknown };

const DEFS: Record<string, Def> = {
  dx12_engine_launch: {
    title: "専用エンジンを起動",
    shape: {
      name: z.string().optional().describe("エンジンの名前(英数字・_ . -、40 字以内)。省略で id(e-xxxx)。以後 engine 引数に id の代わりに使える。"),
      project: z.string().optional().describe("プロジェクトのルートフォルダ。省略すると使い捨てプロジェクトを自動で作る(24 時間残る)。指定すると MCP の自動保存でそのフォルダに書き込まれ、同じフォルダを別のエンジンが使っていれば断る。"),
      mode: z.enum(["background", "headless", "visible"]).optional().describe("background(既定)=窓は画面外で前面化しない / headless=窓なし(画面が要らない検証。既定ではディスクへ書かない)/ visible=窓を画面に出す(既定で拒否。DX12_MCP_ALLOW_VISIBLE=1 と confirm:true が要る)。"),
      scene: z.string().optional().describe("起動後に開くシーン(assets 相対)。"),
      dpiScale: z.number().optional().describe("表示倍率(0.75〜3.0)。既定は OS の倍率。"),
      args: z.array(z.string()).optional().describe("追加の起動引数。ポート・owner・idle・project・背景モード(--mcp-port 等)は指定できない。"),
      waitReadyMs: z.number().int().min(1000).max(600000).optional().describe("ping に応答するまで待つ時間(ms、既定 60000)。"),
      confirm: z.boolean().optional().describe("mode:'visible' のときだけ必要。ユーザーの承認を得たときだけ true(実マウス・フォーカスを奪い得る)。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    keywords: "engine launch start spawn fleet 専用エンジン 起動 起動する 立ち上げ 複数 並列 別ポート セッション 衝突 エンジンが無い 繋がらない headless background 自分専用 エージェントごと",
    run: (a) => getFleet().launch(a),
  },
  dx12_engine_list: {
    title: "専用エンジンの一覧",
    shape: { discover: z.boolean().optional().describe("true=手動起動のエンジン(8787・8850〜8859・ポートファイル)も connect だけで探す。") },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "engine engines list running fleet free vram ram memory 一覧 台数 上限 3 台 空き VRAM RAM リソース どのエンジン 誰が使っている 孤児 idle 止める候補 起動中",
    run: (a) => getFleet().list(a),
  },
  dx12_engine_stop: {
    title: "専用エンジンを止める",
    shape: {
      engine: refShape.optional().describe("止めるエンジンの id / name / port。省略すると束縛中(または唯一)の自分のエンジン。"),
      all: z.boolean().optional().describe("true=自分のエンジンを全部止める。"),
      force: z.boolean().optional().describe("他のセッションのエンジンを止める(confirm:true も要る。最後の手段)。"),
      confirm: z.boolean().optional().describe("force のときに必要。ユーザーの承認を得たときだけ true。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "engine stop kill terminate close shutdown 止める 終了 閉じる 落とす 片付け 後始末 枠を空ける",
    run: (a) => getFleet().stop(a),
  },
  dx12_engine_attach: {
    title: "既存エンジンに読み取り専用で繋ぐ",
    shape: {
      port: z.number().int().optional().describe("繋ぐポート(1024〜65535)。手動起動のエンジン(8850〜8859 など)。"),
      engine: refShape.optional().describe("フリートのエンジンの id / name / port(他のセッションのものは読み取り専用で見る)。"),
      readOnly: z.boolean().optional().describe("既定 true=読み取り専用(effect:read の method だけ)。false は confirm:true が要る。"),
      confirm: z.boolean().optional().describe("readOnly:false のときに必要。ユーザーの承認を得たときだけ true。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    keywords: "engine attach connect readonly 読み取り専用 見る 閲覧 手動起動 既存 他のエージェント 他人のエンジン 繋ぐ 接続",
    run: (a) => getFleet().attach(a),
  },
  dx12_engine_refresh: {
    title: "exe コピーを最新へ更新",
    shape: {
      engine: refShape.optional().describe("更新するエンジンの id / name / port。省略で束縛中(または唯一)の自分のエンジン。"),
      waitReadyMs: z.number().int().min(1000).max(600000).optional().describe("ping に応答するまで待つ時間(ms、既定 60000)。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    keywords: "engine refresh update restart rebuild build 更新 再起動 ビルド後 古い exe 最新 入れ替え リフレッシュ stale",
    run: (a) => getFleet().refresh(a),
  },
  dx12_engine_use: {
    title: "既定エンジンを切り替える",
    shape: { engine: refShape.describe("束縛するエンジンの id / name / port。'none' で束縛を外して従来の探索(DX12_MCP_PORT → ポートファイル → 8787)に戻す。") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    keywords: "engine use switch bind select 切り替え 束縛 既定のエンジン 向き先 選ぶ",
    run: (a) => getFleet().use(a),
  },
};

if (ENHANCED && SURFACE !== "legacy" && !cfg0.disabled) {
  setFleetToolsEnabled(true);
  // DX12_FLEET_AUTOLAUNCH=1: 束縛が無く従来の探索も繋がらないとき、最初のエンジン呼び出しで専用エンジンを起動する。
  if (cfg0.autolaunch) router.autolaunch = async () => { await getFleet().launch({}); return true; };

  for (const name of FLEET_TOOLS) {
    const def = DEFS[name];
    const description = CORE_DESCRIPTIONS[name];
    const declared = Object.keys(def.shape);
    const invoke = async (args: any): Promise<ToolResult> => {
      const issues = unknownKeyIssues(args ?? {}, declared);
      if (issues.length > 0) {
        const body = bodyFromIssues(name, args ?? {}, issues, declared);
        return errorResult(body);
      }
      return fleetRun(name, () => def.run(args ?? {}));
    };
    const inCore = CORE_FLEET.includes(name);
    const hidden = SURFACE === "shell" || (SURFACE === "core" && !inCore);
    const registered = server.registerTool(
      name,
      { title: def.title, description, inputSchema: z.object(def.shape).passthrough() as any, annotations: { title: def.title, ...def.annotations } },
      async (args: any) => invoke(args),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title: def.title, description, shape: def.shape, annotations: def.annotations, tier: "core", core: inCore, coreDescription: description,
      extraKeywords: def.keywords, invoke, listed: !hidden, registered,
    });
  }
}
