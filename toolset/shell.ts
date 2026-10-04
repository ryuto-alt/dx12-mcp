// shell 5 本(常時ロード): dx12_tool_search / dx12_tool_describe / dx12_call / dx12_doctor / dx12_guide。
// 中身は shellRuntime.ts。ここは MCP への登録と、SDK レベルのエラー(型違い・未知ツール)の構造化だけ。
//
// ★shell 5 本の定義(description / 引数)は固定する。Claude Code は一度ロードした deferred ツールの
//   説明を更新しない(#97369)ので、変わる知識は dx12_tool_describe の返り値で配る。
// ★ツールの並びは shell が先頭(tools/list の先頭 5 本)。旧 220 本の並びは従来どおり後ろに続く。

import { z } from "zod";
import { server, engine, SERVER_VERSION } from "./core.ts";
import { ENHANCED, LIST_CHANGED_ENABLED, SURFACE, TOOL_REGISTRY, recordError } from "../toolRuntime.ts";
import { CORE_DESCRIPTIONS, CORE_GUARDED_TOOL, CORE_ORDER, SHELL_TOOLS } from "../coreSpec.ts";
import { ManifestStore } from "../manifest.ts";
import { ShellRuntime } from "../shellRuntime.ts";
import { envelope } from "../errors.ts";
import { structureError } from "../structure.ts";
import { bodyFromIssues, unknownKeyIssues, validateAgainstShape } from "../validate.ts";
import { getFleet } from "../fleet/runtime.ts";
import { fleetToolsEnabled } from "../fleet/enabled.ts";
import { jobsSummary } from "../jobs/runtime.ts";

export const manifestStore = new ManifestStore(engine);
export const shell = new ShellRuntime({
  engine, registry: TOOL_REGISTRY, manifest: manifestStore, toolset: SURFACE, surface: SURFACE, listChanged: LIST_CHANGED_ENABLED, version: SERVER_VERSION,
  // フリートのツールが有効なときだけ、dx12_doctor にフリートの状態(台数・資源・古い exe コピー・孤児)を載せる。
  fleetStatus: async () => (fleetToolsEnabled() ? getFleet().status() : (null as any)),
  // ジョブ API の状態(動いているジョブ・孤児・直近の失敗)。ジョブを一度も使っていなければ何も作らずに空の要約を返す。
  jobsStatus: () => jobsSummary(),
});

const ALWAYS_LOAD = { "anthropic/alwaysLoad": true };

function regShell(
  name: string, title: string, description: string, shape: Record<string, z.ZodTypeAny>,
  annotations: Record<string, unknown>, handler: (args: any) => Promise<any>,
  meta: Record<string, unknown> = ALWAYS_LOAD,
) {
  const declared = Object.keys(shape);
  // ★未知キーは黙って捨てず弾く。dx12_call の「dry_run」のような打ち間違いが黙って無視されると、
  //   dryRun のつもりで書き込みが実行されてしまう。
  const guarded = async (args: any) => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) {
      return { content: [{ type: "text", text: JSON.stringify(envelope(bodyFromIssues(name, args ?? {}, issues, declared))) }], isError: true };
    }
    return handler(args);
  };
  const registered = server.registerTool(
    name,
    { title, description, inputSchema: z.object(shape).passthrough() as any, annotations: { title, openWorldHint: false, ...annotations }, _meta: meta },
    async (args: any) => guarded(args),
  );
  TOOL_REGISTRY.set(name, {
    name, title, description, shape, annotations, tier: "shell", listed: true, registered,
    invoke: async (args: any) => guarded(args),
  });
}

if (ENHANCED) {
  regShell(
    "dx12_tool_search", "ツール検索",
    "dx12 エンジンの全ツール(旧 220 本 + エンジンの全 method)を日本語/英語の自然文で検索する。使う: 目的の操作の名前が分からないとき(例「ブルームを調整」「炎を置く」「元に戻す」)。返り値: hits[{name, summary, category, effect(read/write_scene/…/guarded), mode, example, score}]。次に dx12_tool_describe で引数を確認し dx12_call で実行する。旧ツール名でもヒットする。",
    {
      query: z.string().describe("探したい操作(日本語/英語の自然文・キーワード・旧ツール名)。例: 'スクリーンショット', 'set ssao', '元に戻す'"),
      category: z.string().optional().describe("カテゴリで絞る(entity/render/lighting/terrain/vfx/play/capture/quality/perf/asset/editor_ui/undo/git など)。"),
      effect: z.enum(["read", "write", "runtime", "guarded"]).optional().describe("副作用で絞る。read=状態を変えない / write=シーン・設定・ファイルを変える / runtime=再生状態を変える / guarded=取り返しが付かない・外部に影響する。"),
      tier: z.enum(["core", "all"]).optional().describe("core=shell だけ / all(既定)=全部。"),
      limit: z.number().int().min(1).max(30).optional().describe("返す件数(既定 8)。"),
    },
    { readOnlyHint: true, idempotentHint: true },
    (a) => shell.search(a),
  );

  regShell(
    "dx12_tool_describe", "ツール詳細",
    "ツール/エンジン method の完全な仕様を返す: 引数(型・必須・enum・範囲)・副作用(effect/undo)・タイムアウト・例・次の一手・起こりうるエラー・旧名。callTemplate をそのまま dx12_call に渡せる。旧ツール名/新名/エンジン method 名のどれでも引ける。引数が多いツール(ポストプロセス等)は target に部分文字列を渡すと該当引数を説明つきで返す。",
    {
      name: z.string().describe("ツール名 / エンジン method 名(例 'dx12_set_ssao', 'set_ssao', 'describe_mcp_manifest')。"),
      target: z.string().optional().describe("引数名/説明に含まれる部分文字列(引数が多いツールを絞る)。"),
    },
    { readOnlyHint: true, idempotentHint: true },
    (a) => shell.describe(a),
  );

  const SPLIT_GUARD = SURFACE === "core";
  regShell(
    "dx12_call", "ツール実行",
    "任意のツール/エンジン method を、送信前にスキーマ検証してから実行する。旧ツール名でもエンジンの method 名でもよく、エンジンに後から増えた method も再起動なしで呼べる。args の誤りは往復せず構造化エラー(error_code / cause / fix[{tool,args}] / didYouMean / validValues)で返るので、fix[0] をそのまま撃ち直す。dryRun:true=副作用のある操作は実行せず、対象・破壊性・Undo 可否を返す(native dryRun を持つツールはその結果)。"
    + (SPLIT_GUARD
      ? "guarded な操作(git push / eval_lua / delete_asset / build_game など)はここでは実行できない(E_GUARDED)。dx12_call_guarded から実行する。"
      : "guarded な操作(git push / eval_lua / delete_asset / build_game など)は confirm:true が要る(ユーザーの承認を得てから)。")
    + "成功は {ok:true, result, meta{tool, tookMs, effect, warnings, lateResults}}。",
    {
      name: z.string().describe("呼ぶツール名/メソッド名(dx12_tool_search / dx12_tool_describe で確認)。"),
      args: z.record(z.any()).optional().describe("そのツール/メソッドの引数(オブジェクト)。dx12_tool_describe の callTemplate を埋める。"),
      dryRun: z.boolean().optional().describe("true=実行せず影響だけ返す。読み取りは実行する。"),
      confirm: z.boolean().optional().describe(SPLIT_GUARD
        ? "この面では使えない(guarded は dx12_call_guarded から実行する)。"
        : "guarded な操作に必要。ユーザーの承認を得たときだけ true にする。"),
      timeoutMs: z.number().int().min(100).max(600000).optional().describe("エンジン method 呼び出しのタイムアウト(ms)。旧ツール経由では効かない。"),
      idempotency_key: z.string().optional().describe("冪等キー(別名 idempotencyKey)。write 系の全 method / ツールで、同じキーの再送は前回の結果を返して再実行しない(エンジンが 10 分・256 件まで覚える)。省略しても、エンジン method に 1:1 の write 系は自動で採番し、タイムアウト時に同じキーで再送する(meta.autoRetried)。"),
      idempotencyKey: z.string().optional().describe("idempotency_key の別名。"),
      engine: z.union([z.string(), z.number().int()]).optional().describe("この 1 回だけ向ける専用エンジンの id / name / port(dx12_engine_list で確認)。省略で既定(束縛中)のエンジン。"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (a) => shell.call(a),
  );

  // core 面だけ: guarded な操作の実行口。ユーザーが毎回承認する(requiresUserInteraction)。alwaysLoad ではない(常時ロードは shell 5 本固定)。
  if (SPLIT_GUARD) {
    regShell(
      CORE_GUARDED_TOOL, "guarded 操作の実行",
      CORE_DESCRIPTIONS[CORE_GUARDED_TOOL],
      {
        name: z.string().describe("guarded なツール名/method 名(dx12_git_push / dx12_eval_lua / dx12_delete_asset / dx12_build_game など)。"),
        args: z.record(z.any()).optional().describe("そのツールの引数(オブジェクト)。"),
        dryRun: z.boolean().optional().describe("true=実行せず、対象・破壊性を返す。先にこれで確認する。"),
        idempotency_key: z.string().optional().describe("冪等キー(別名 idempotencyKey)。"),
        idempotencyKey: z.string().optional().describe("idempotency_key の別名。"),
      },
      { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      (a) => shell.callGuarded(a),
      { "anthropic/requiresUserInteraction": true },
    );
  }

  regShell(
    "dx12_doctor", "接続の自己診断",
    "エンジンへの接続と状態を診断する。最初に撃つ入口。ポート(env/ポートファイル/候補)・プロセス・ping・エンジン版・マニフェストの版ずれ・直近エラー・遅延結果・ログ末尾を調べ、問題ごとに原因と直し方(fix: コマンド or ツール+引数)を返す。エンジンが落ちていても動く。エンジンの起動は --background だけを案内する(人のカーソルを奪わない)。",
    { deep: z.boolean().optional().describe("true=候補ポートを広く走査し、エンジンの起動引数とログ末尾 20 行も返す。") },
    { readOnlyHint: true, idempotentHint: true },
    (a) => shell.doctor(a),
  );

  regShell(
    "dx12_guide", "使い方ガイド",
    "目的別の最短手順・危険操作の注意・仮想入力の運用ルールを返す(Markdown)。topic 省略で一覧。トピック: build_scene / scene_spec(仕様 JSON で部屋・ステージ・街を作る) / test / lighting / ui / editor / safety / errors / perf / fleet(専用エンジンの起動・上限・後始末) / jobs(長い処理のジョブ API) / engine_dev(エンジンに method を足したら何をするか)。",
    { topic: z.string().optional().describe("トピック id(省略で一覧)。") },
    { readOnlyHint: true, idempotentHint: true },
    async (a) => shell.guide(a),
  );

  // ── core 面: tools/list の並びを決定的にする(shell 5 本 → Core の固定順 → 動的昇格ぶんは名前順) ──────────
  // 登録順(モジュールの import 順)に依存させない。旧ツールの並びを守る full / legacy には触らない。
  if (SURFACE === "core") {
    try {
      const h: Map<string, (req: any, extra: any) => Promise<any>> | undefined = (server.server as any)._requestHandlers;
      const inner = h?.get("tools/list");
      if (h && inner) {
        const rank = new Map<string, number>([...SHELL_TOOLS, ...CORE_ORDER].map((n, i) => [n, i]));
        h.set("tools/list", async (request: any, extra: any) => {
          const res = await inner(request, extra);
          if (Array.isArray(res?.tools)) {
            res.tools = [...res.tools].sort((a: any, b: any) => {
              const ra = rank.get(a.name) ?? Infinity, rb = rank.get(b.name) ?? Infinity;
              return ra !== rb ? (ra < rb ? -1 : 1) : String(a.name).localeCompare(String(b.name));
            });
          }
          return res;
        });
      }
    } catch { /* 内部表が無い SDK では登録順のまま(動作に影響しない) */ }
  }

  // ── SDK レベルのエラー(型違い/未知ツール)を構造化する ──────────────────────
  // SDK は zod 検証エラー・未知ツールを「MCP error -32602: …」という素の文字列にして返す。
  // 結果の後ろに構造化 JSON を 1 ブロック足す(1 ブロック目は SDK の文言のまま)。SDK の内部表(_requestHandlers)に触るので、
  // 取れなければ何もしない(SDK が変わっても従来どおり動く)。
  try {
    const handlers: Map<string, (req: any, extra: any) => Promise<any>> | undefined = (server.server as any)._requestHandlers;
    const inner = handlers?.get("tools/call");
    if (handlers && inner) {
      handlers.set("tools/call", async (request: any, extra: any) => {
        const res = await inner(request, extra);
        try {
          if (!res?.isError) return res;
          const text: string = res.content?.[0]?.text ?? "";
          const name: string = request?.params?.name ?? "";
          const args = (request?.params?.arguments ?? {}) as Record<string, unknown>;
          if (/^MCP error -32602: Tool .* not found/.test(text)) {
            const body = await structureError(Object.assign(new Error(`unknown method: ${name}`), { code: 8, errName: "E_UNKNOWN_TOOL" }), {
              tool: name, args, suggestNames: () => shell.catalog.names(),
            });
            body.message = `ツール '${name}' は無い`;
            recordError({ at: Date.now(), tool: name, code: body.code, message: body.message });
            res.content.push({ type: "text", text: JSON.stringify(envelope(body)) });
          } else if (/^MCP error -32602: Input validation error/.test(text)) {
            const entry = TOOL_REGISTRY.get(name);
            if (entry) {
              const v = validateAgainstShape(entry.name, entry.shape, args);
              if (!v.ok) {
                recordError({ at: Date.now(), tool: name, code: v.body.code, message: v.body.message });
                res.content.push({ type: "text", text: JSON.stringify(envelope(v.body)) });
              }
            }
          }
        } catch { /* 構造化に失敗しても SDK の本文は返す */ }
        return res;
      });
    }
  } catch { /* 内部表が無い SDK では何もしない */ }
}

