// Core ツール面(M3): 統合ツール 6 本の登録 + マニフェストの expose:"core" による動的な昇格。
//
//   ・統合ツール(dx12_get/set_render_settings / dx12_get_perf / dx12_capture / dx12_edit_terrain / dx12_imgui)は、
//     旧ツールの登録済みハンドラをそのまま呼ぶ薄いルーターで、返り値の形は旧ツールのまま。
//     core 面だけ MCP の tools/list に出る。それ以外の面でも TOOL_REGISTRY には入る(dx12_tool_describe / dx12_call から引ける)。
//   ・動的昇格: エンジンの method に expose:"core" が付いていたら、再起動なしで tools/list に載せて
//     notifications/tools/list_changed を送る(SDK が registerTool / remove で自動送信)。
//     ★Claude Code がこの通知を deferred 索引へ反映するかは未確認。反映されなくても dx12_tool_describe / dx12_call で使える
//       (それが主経路)。DX12_MCP_LIST_CHANGED=0 でこの動的昇格を丸ごと止められる。
//
// ★all.ts で旧ツールの全モジュールより後に import すること(統合ツールは旧ツールの登録表を引く)。

import { z } from "zod";
import { server, engine, run, errResult, type ToolResult } from "./core.ts";
import { manifestStore, shell } from "./shell.ts";
import { ENHANCED, LIST_CHANGED_ENABLED, SURFACE, TOOL_REGISTRY, callContext, recordError } from "../toolRuntime.ts";
import { CONSOLIDATED, CORE_DESCRIPTIONS, RENDER_SETTING_TARGETS, rewriteFixToCore, routeConsolidated, type Consolidated } from "../coreSpec.ts";
import { unknownParamKeys, unknownKeyError } from "../paramGuard.ts";
import { bodyFromIssues, unknownKeyIssues, validateAgainstShape } from "../validate.ts";
import { envelope, nearest, type ErrorBody } from "../errors.ts";
import type { Manifest, ManifestMethod, ManifestParam } from "../manifest.ts";

// ── 統合ツール ───────────────────────────────────────────────────────────

function textError(body: ErrorBody): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
}

/** 統合ツールを MCP から直接呼ばれたとき: 旧ツールの登録済みハンドラへ振り分けて、旧ツールの返り値をそのまま返す。 */
function directHandler(spec: Consolidated) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (spec.name === "dx12_get_render_settings" && (args.target === undefined || args.target === null || args.target === "")) {
      return run(() => shell.readAllRenderSettings());
    }
    const routed = routeConsolidated(spec, args ?? {});
    if (!routed.ok) {
      const didYouMean = typeof routed.received === "string" ? nearest(routed.received, routed.validValues, 3, { liberal: true }) : undefined;
      const body: ErrorBody = {
        code: routed.code, message: routed.message, cause: routed.message,
        validValues: routed.validValues.length ? routed.validValues : undefined, didYouMean,
        fix: [
          ...(didYouMean?.[0] ? [{ tool: spec.name, args: { ...args, [routed.param]: didYouMean[0] }, why: `'${routed.param}' に最も近い値で撃ち直す` }] : []),
          { tool: "dx12_tool_describe", args: { name: spec.name }, why: "引数の一覧・型・例を確認する" },
        ],
        docs: `dx12_tool_describe {name:'${spec.name}'}`,
      };
      recordError({ at: Date.now(), tool: spec.name, code: body.code, message: body.message });
      return textError(body);
    }
    const entry = TOOL_REGISTRY.get(routed.legacy);
    if (!entry) {
      return textError({ code: "E_ENGINE_TOO_OLD", message: `${spec.name}: 振り分け先の ${routed.legacy} が登録されていない`, fix: [{ tool: "dx12_doctor", args: {}, why: "MCP サーバの版を確認する" }] });
    }
    const v = validateAgainstShape(entry.name, entry.shape, routed.legacyArgs);
    if (!v.ok) {
      const body = { ...v.body, fix: rewriteFixToCore(v.body.fix, routed.legacy) };
      recordError({ at: Date.now(), tool: spec.name, code: body.code, message: body.message });
      return textError(body);
    }
    // dx12_call 経由(mode:"call")ならそのまま。直接呼びなら旧ツールが構造化エラーを足す。文脈のツール名は統合ツールにしておく。
    const cur = callContext.getStore();
    return callContext.run({ tool: spec.name, args, mode: cur?.mode ?? "direct" }, () => entry.invoke(v.data));
  };
}

const targetEnum = z.enum(RENDER_SETTING_TARGETS as [string, ...string[]]);

const SHAPES: Record<string, { title: string; shape: Record<string, z.ZodTypeAny>; annotations: Record<string, unknown> }> = {
  dx12_get_render_settings: {
    title: "描画設定を読む",
    shape: { target: targetEnum.optional().describe("読む設定。省略で全 target をまとめて返す。") },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  dx12_set_render_settings: {
    title: "描画設定を変える",
    shape: {
      target: targetEnum.describe("変える設定。"),
      values: z.record(z.any()).optional().describe("その設定の値(キー: 値。必須。旧ツールの引数をここに入れる)。有効キーは dx12_tool_describe {name:'dx12_set_render_settings', target:'<target>'}。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  dx12_get_perf: {
    title: "性能を測る",
    shape: {
      mode: z.enum(["snapshot", "benchmark"]).optional().describe("snapshot(既定)=直近フレームの統計 / benchmark=frames フレーム計測。"),
      window: z.any().optional().describe("snapshot: 集計するフレーム数(既定 60)。"),
      frames: z.any().optional().describe("benchmark: 計測するフレーム数(既定 300)。"),
      uncap: z.any().optional().describe("benchmark: 計測中だけ FPS 上限を外す(既定 true)。"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  dx12_capture: {
    title: "スクリーンショット",
    shape: {
      view: z.enum(Object.keys(CONSOLIDATED.dx12_capture.routes) as [string, ...string[]]).optional()
        .describe("final(既定=ポスト後の最終画)/ scene / game / ui / debug / texture / from / focus。省略時は position・target があれば from、entity・name があれば focus、mode があれば debug。"),
      path: z.any().optional().describe("保存先(省略で既定の場所)。texture は assets 相対のテクスチャパス。"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  dx12_edit_terrain: {
    title: "地形を編集する",
    shape: {
      op: z.enum(Object.keys(CONSOLIDATED.dx12_edit_terrain.routes) as [string, ...string[]]).describe("編集の種類。他のキーは op ごとの引数。"),
      entity: z.any().optional().describe("対象の地形エンティティ id(name と排他)。"),
      name: z.any().optional().describe("対象の名前(create / sculpt_create では新しく作る名前)。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  dx12_imgui: {
    title: "エディタ UI を仮想入力で操作",
    shape: {
      op: z.enum(Object.keys(CONSOLIDATED.dx12_imgui.routes) as [string, ...string[]]).describe("virtual_input / find / pointer / key / screenshot。他のキーは op ごとの引数。"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
};

function regConsolidated(spec: Consolidated) {
  const def = SHAPES[spec.name];
  const description = CORE_DESCRIPTIONS[spec.name];
  const handler = directHandler(spec);
  const invoke = async (args: any): Promise<ToolResult> => handler(args ?? {});
  let registered: { enable(): void; disable(): void; remove(): void } | undefined;
  // core 面だけ MCP の tools/list に出す。それ以外は登録表にだけ入れる(dx12_tool_describe / dx12_call が引く)。
  if (SURFACE === "core") {
    registered = server.registerTool(
      spec.name,
      {
        title: def.title, description,
        inputSchema: z.object(def.shape).passthrough() as any,
        annotations: { title: def.title, openWorldHint: false, ...def.annotations },
      },
      async (args: any) => callContext.run({ tool: spec.name, args, mode: "direct" }, () => invoke(args)),
    );
  }
  TOOL_REGISTRY.set(spec.name, {
    name: spec.name, title: def.title, description, shape: def.shape, annotations: def.annotations,
    tier: "core", core: true, coreDescription: description, consolidated: spec, extraKeywords: spec.keywords,
    invoke, listed: SURFACE === "core", registered,
  });
}

if (ENHANCED) for (const spec of Object.values(CONSOLIDATED)) regConsolidated(spec);

// ── 動的昇格(マニフェストの expose:"core") ─────────────────────────────────────────────

function zodForParam(p: ManifestParam): z.ZodTypeAny {
  let t: z.ZodTypeAny;
  switch (p.type) {
    case "bool": case "boolean": t = z.boolean(); break;
    case "int": case "integer": { let n = z.number().int(); if (p.min != null) n = n.min(p.min); if (p.max != null) n = n.max(p.max); t = n; break; }
    case "number": case "float": { let n = z.number(); if (p.min != null) n = n.min(p.min); if (p.max != null) n = n.max(p.max); t = n; break; }
    case "string": case "assetPath": t = z.string(); break;
    case "entityRef": t = z.union([z.number().int(), z.string()]); break;
    case "vec2": t = z.array(z.number()).length(2); break;
    case "vec3": t = z.array(z.number()).length(3); break;
    case "vec4": t = z.array(z.number()).length(4); break;
    case "enum": t = p.enum?.length ? z.enum(p.enum as [string, ...string[]]) : z.string(); break;
    case "array": t = z.array(z.any()); break;
    case "object": t = z.record(z.any()); break;
    default: t = z.any();
  }
  const desc = [p.desc, p.default !== undefined ? `既定 ${JSON.stringify(p.default)}` : ""].filter(Boolean).join("。");
  if (desc) t = t.describe(desc);
  return p.required ? t : t.optional();
}

/** マニフェストの params → zod の shape(トップレベルのキーだけ。"親.子" は親を any で受ける)。 */
export function shapeFromManifest(params: ManifestParam[] | undefined): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of params ?? []) {
    if (p.name.includes(".")) { const parent = p.name.split(".")[0]; if (!(parent in shape)) shape[parent] = z.any().optional(); continue; }
    shape[p.name] = zodForParam(p);
  }
  return shape;
}

const EFFECT_LABEL: Record<string, string> = {
  read: "なし(読み取りのみ)", write_scene: "シーン変更(Undo 可)", write_setting: "設定変更(Undo 可)",
  write_file: "ファイル書込み(Undo 不可)", runtime: "実行状態が変わる", guarded: "取り返しが付かない/外部へ出る",
};

/** 動的ツールの説明(Core テンプレ: 1 文 / 副作用 / 注意 / 次)。 */
export function dynamicDescription(mf: ManifestMethod): string {
  const name = "dx12_" + mf.name;
  const lines = [
    mf.summary.replace(/\s+/g, " ").trim(),
    `副作用: ${EFFECT_LABEL[mf.effect] ?? mf.effect}。モード: ${mf.mode ?? "any"}。`,
    `注意: エンジンに後から追加された method(expose:"core")。引数の詳細と例は dx12_tool_describe {name:'${name}'}。`,
  ];
  const next = (mf.next ?? []).slice(0, 2).map((n) => n.tool + (n.when ? `(${n.when})` : "")).join(" / ");
  if (next) lines.push(`次: ${next}。`);
  const d = lines.join("\n");
  return d.length > 600 ? d.slice(0, 597) + "…" : d;
}

function annotationsForEffect(mf: ManifestMethod): Record<string, unknown> {
  const read = mf.effect === "read";
  return { title: mf.name, openWorldHint: false, readOnlyHint: read, ...(read ? {} : { destructiveHint: false }), ...(mf.idempotent ? { idempotentHint: true } : {}) };
}

export type PromotionResult = { added: string[]; removed: string[]; enabled: string[]; disabled: string[]; skipped: { method: string; reason: string }[] };

const promotedLegacy = new Set<string>();   // expose:"core" によって tools/list へ出した(もともとは隠れていた)旧ツール

/**
 * マニフェストの expose:"core" を tools/list へ反映する。
 *   - TS ラッパの無い method → dx12_<method> を動的に登録(SDK が list_changed を送る)
 *   - core 面で隠れている旧ツール(dx12_<method> が同名)→ 表に出す
 *   - expose:"core" でなくなった/エンジンから消えた method → 外す
 * guarded な method は昇格させない(guarded は dx12_call_guarded の背後に置く)。
 */
export function syncPromotions(m: Manifest | null): PromotionResult {
  const res: PromotionResult = { added: [], removed: [], enabled: [], disabled: [], skipped: [] };
  if (!LIST_CHANGED_ENABLED || SURFACE === "legacy" || SURFACE === "shell" || !m) return res;
  const wanted = new Map<string, ManifestMethod>();
  for (const mf of m.methods.values()) if (mf.expose === "core") wanted.set(mf.name, mf);

  for (const [method, mf] of wanted) {
    const toolName = "dx12_" + method;
    if (mf.effect === "guarded") { res.skipped.push({ method, reason: "guarded は昇格しない(dx12_call_guarded から使う)" }); continue; }
    const existing = TOOL_REGISTRY.get(toolName);
    if (existing && !existing.dynamic) {
      // TS ラッパがある。core 面で隠れていれば出す。
      if (SURFACE === "core" && !existing.listed && existing.registered) {
        existing.registered.enable(); existing.listed = true; existing.core = true; promotedLegacy.add(toolName); res.enabled.push(toolName);
      }
      continue;
    }
    const description = dynamicDescription(mf);
    const shape = shapeFromManifest(mf.params);
    const declared = Object.keys(shape);
    const timeout = mf.timeoutMs;
    const invoke = async (args: any): Promise<ToolResult> => {
      const unknown = unknownParamKeys(args, declared);
      if (unknown.length > 0) {
        const res2 = errResult(unknownKeyError(toolName, unknown, declared));
        if (ENHANCED && callContext.getStore()?.mode !== "call") res2.content.push({ type: "text", text: JSON.stringify(envelope(bodyFromIssues(toolName, args ?? {}, unknownKeyIssues(args ?? {}, declared), declared))) });
        return res2;
      }
      return run(() => engine.call(method, args ?? {}, timeout ? { timeout } : undefined));
    };
    if (existing?.dynamic) {
      // 同じ名前で定義(引数・説明)が変わった: 登録し直す
      existing.registered?.remove();
      TOOL_REGISTRY.delete(toolName);
    }
    const registered = server.registerTool(
      toolName,
      { title: mf.name, description, inputSchema: z.object(shape).passthrough() as any, annotations: annotationsForEffect(mf) },
      async (args: any) => callContext.run({ tool: toolName, args, mode: "direct" }, () => invoke(args)),
    );
    TOOL_REGISTRY.set(toolName, {
      name: toolName, title: mf.name, description, shape, annotations: annotationsForEffect(mf),
      tier: "core", core: true, coreDescription: description, extraKeywords: mf.keywords, dynamic: true,
      invoke, listed: true, registered,
    });
    res.added.push(toolName);
  }

  // 外す: expose:"core" でなくなった / エンジンから消えた
  for (const [toolName, entry] of [...TOOL_REGISTRY]) {
    const method = toolName.replace(/^dx12_/, "");
    if (wanted.has(method)) continue;
    if (entry.dynamic) {
      entry.registered?.remove();
      TOOL_REGISTRY.delete(toolName);
      res.removed.push(toolName);
    } else if (promotedLegacy.has(toolName)) {
      entry.registered?.disable(); entry.listed = false; promotedLegacy.delete(toolName); res.disabled.push(toolName);
    }
  }
  return res;
}

/** 最後の同期結果(dx12_doctor などが読む)。 */
export let lastPromotion: PromotionResult & { at: number; hash: string | null } | null = null;

function runSync(m: Manifest | null) {
  try {
    const r = syncPromotions(m);
    lastPromotion = { ...r, at: Date.now(), hash: m?.manifestHash ?? null };
    if (r.added.length || r.removed.length || r.enabled.length || r.disabled.length) {
      // stderr は MCP のログに出る(stdout は JSON-RPC 専用)
      process.stderr.write(`[dx12-mcp] tools/list を更新した: +${r.added.join(",") || "-"} -${r.removed.join(",") || "-"} 表示:${r.enabled.join(",") || "-"} 非表示:${r.disabled.join(",") || "-"}\n`);
    }
  } catch (e: any) {
    process.stderr.write(`[dx12-mcp] 動的昇格に失敗した(dx12_call は使える): ${e?.message ?? e}\n`);
  }
}

if (ENHANCED && LIST_CHANGED_ENABLED && SURFACE !== "shell") {
  // 起動時: 同梱スナップショットに expose:"core" があれば(通常は無い)接続前に登録する。
  runSync(manifestStore.current);
  // マニフェストが取り直されるたび(ping.manifestHash の変化)に反映する。
  manifestStore.onChange((m) => runSync(m));
  // core 面だけ: エンジンに(再)接続したら、shell ツールを呼ばれるのを待たずマニフェストを確認する
  // (Core ツールだけを使っている AI にも、エンジンを再ビルド・再起動した直後の最初の呼び出しで新しい method が届く)。
  // full 面ではやらない(旧ツールの呼び出しでエンジンへ余計な ping / describe_mcp_manifest を撃たない = 現状互換)。
  if (SURFACE === "core") engine.onConnect(() => { setTimeout(() => { void shell.refresh(true); }, 0); });
}
