// shell 5 本(dx12_tool_search / dx12_tool_describe / dx12_call / dx12_doctor / dx12_guide)の中身。
// MCP への登録は toolset/shell.ts。ここは依存を注入できる形にして、単体でテストする(shell.test.ts / errors.test.ts)。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineClient } from "./engineClient.ts";
import { methodTimeoutMs } from "./engineClient.ts";
import type { Manifest } from "./manifest.ts";
import { ManifestStore } from "./manifest.ts";
import { Catalog, CONDITIONAL_GUARDED, CONDITIONAL_WRITE, buildCatalog, type ParamDoc, type ToolDoc, type ToolEntry } from "./catalog.ts";
import { CONSOLIDATED, CORE_GUARDED_TOOL, RENDER_SETTING_TARGETS, rewriteFixToCore, routeConsolidated, toCoreCall } from "./coreSpec.ts";
import { SearchIndex } from "./search.ts";
import { envelope, nearest, type ErrorBody, type Fix } from "./errors.ts";
import { structureError } from "./structure.ts";
import { validateAgainstParams, validateAgainstShape } from "./validate.ts";
import { runDoctor } from "./doctor.ts";
import { ERROR_BODY, ERROR_SOURCE, callContext, recentErrors, recordError } from "./toolRuntime.ts";
import { autoKey, guardApproval, idemCtx, newIdemCtx } from "./guardCtx.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GUIDES_DIR = path.join(here, "guides");

export type ShellResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export type ShellDeps = {
  engine: EngineClient;
  registry: Map<string, ToolEntry>;
  manifest: ManifestStore;
  toolset: string;
  /** ツール面(full / core / shell / legacy)。core のときだけ guarded は dx12_call_guarded から実行する。 */
  surface?: string;
  /** 動的登録(expose:"core" → tools/list / list_changed)が有効か(dx12_doctor が表示する)。 */
  listChanged?: boolean;
  version: string;
  guidesDir?: string;
  /** テスト用: dx12_doctor の外部依存(ポート走査・プロセス一覧・ログ)を差し替える。 */
  doctorHooks?: Record<string, unknown>;
  /** フリートの状態(台数・資源・古い exe コピー・孤児)。dx12_doctor に統合する。無ければ出さない。 */
  fleetStatus?: () => Promise<Record<string, unknown>>;
  /** ジョブ API の状態(動いているジョブ・件数・上限)。dx12_doctor に統合する。無ければ出さない。 */
  jobsStatus?: () => Record<string, unknown> | null;
};

/** EngineRouter(または、それと同じ withEngine を持つクライアント)。dx12_call の engine 引数で 1 回だけ向き先を切り替える。 */
type Routed = { withEngine?: <T>(ref: string, fn: () => Promise<T>) => Promise<T>; find?: (ref: string | number) => unknown; list?: () => { id: string; name?: string }[]; overrideActive?: () => boolean };

const textResult = (obj: unknown, isError = false): ShellResult => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }],
  ...(isError ? { isError: true } : {}),
});

const errorResult = (body: ErrorBody): ShellResult => textResult(envelope(body), true);

// ── 引数テンプレ(callTemplate) ────────────────────────────────────────

function placeholderFor(p: ParamDoc): unknown {
  if (p.default !== undefined) return p.default;
  if (p.enum?.length) return p.enum[0];
  const t = p.type;
  if (t.startsWith("boolean") || t === "bool") return false;
  if (t.startsWith("integer") || t === "int") return p.min ?? 0;
  if (t.startsWith("number") || t === "float") {
    const m = /\[(\d+)\]/.exec(t);
    if (m) return Array.from({ length: Number(m[1]) }, () => 0);
    if (t.includes("[]")) return [];
    return p.min ?? 0;
  }
  const vec = /^vec([234])$/.exec(t);
  if (vec) return Array.from({ length: Number(vec[1]) }, () => 0);
  if (t.includes("[")) { const m = /\[(\d+)\]/.exec(t); return m ? Array.from({ length: Number(m[1]) }, () => placeholderScalar(t)) : []; }
  if (t === "array") return [];
  if (t === "object") return {};
  if (t.includes("|")) return placeholderFor({ ...p, type: t.split("|")[0] });
  if (t === "entityRef") return 0;
  return `<${p.name}>`;
}
function placeholderScalar(t: string): unknown { return t.startsWith("string") ? "" : 0; }

export function templateArgs(params: ParamDoc[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) if (p.required) out[p.name] = placeholderFor(p);
  return out;
}

const NEXT_BY_CATEGORY: Record<string, { tool: string; when: string }[]> = {
  render: [{ tool: "dx12_screenshot_final", when: "見た目を確認する" }],
  lighting: [{ tool: "dx12_screenshot_final", when: "見た目を確認する" }, { tool: "dx12_polish_audit", when: "仕上がりを測る" }],
  entity: [{ tool: "dx12_get_entity", when: "反映された値を読み返す" }, { tool: "dx12_validate_layout", when: "配置の検査(埋まり/浮き/重なり)" }],
  scene: [{ tool: "dx12_validate_layout", when: "配置の検査" }, { tool: "dx12_quality_gate", when: "作業の区切りの総合検査" }],
  play: [{ tool: "dx12_get_log", when: "エラーの有無を確認する" }],
  vfx: [{ tool: "dx12_vfx_preview", when: "本当に出ているか連写で確かめる" }],
  terrain: [{ tool: "dx12_screenshot_from", when: "指定視点から見た目を確認する" }],
  lua: [{ tool: "dx12_get_script_errors", when: "スクリプトのエラーを確認する" }],
  capture: [],
};

function errorsFor(doc: ToolDoc): { code: string; fix: string }[] {
  const out: { code: string; fix: string }[] = [];
  if (doc.params.some((p) => p.required)) out.push({ code: "E_MISSING_PARAM", fix: "callTemplate の必須引数を埋める" });
  if (doc.params.some((p) => p.enum?.length)) out.push({ code: "E_BAD_ENUM", fix: "validValues のどれかに直す(didYouMean が最も近い値)" });
  if (doc.params.some((p) => p.min != null || p.max != null)) out.push({ code: "E_OUT_OF_RANGE", fix: "範囲内に収める" });
  if (doc.params.some((p) => p.name === "entity" || p.name === "name" || p.name === "parentName")) out.push({ code: "E_NOT_FOUND_ENTITY", fix: "didYouMean の名前で撃ち直す / dx12_list_entities で確認" });
  if (doc.mode !== "any") out.push({ code: "E_MODE_CONFLICT", fix: `${doc.mode} モードでのみ実行できる。dx12_ping で mode を確認` });
  if (doc.effectClass === "guarded") out.push({ code: "E_GUARDED", fix: "ユーザーの承認を取って confirm:true を付ける" });
  out.push({ code: "E_ENGINE_UNREACHABLE", fix: "dx12_doctor で診断" });
  return out;
}

// ── ShellRuntime ─────────────────────────────────────────────────────

export class ShellRuntime {
  readonly deps: ShellDeps;
  private catalogCache: { key: string; catalog: Catalog; index: SearchIndex } | null = null;
  private reconnectNotice = false;

  constructor(deps: ShellDeps) {
    this.deps = deps;
    // エンジンの再接続(再起動・切断からの復帰)を検知したら、次の結果に注意書きを載せる。
    deps.engine.onConnect((_epoch, reconnect) => { if (reconnect) this.reconnectNotice = true; });
  }

  /** 現在のマニフェストと登録表からカタログを作る(マニフェストが変わったときだけ作り直す)。 */
  private ensure(): { catalog: Catalog; index: SearchIndex } {
    const m = this.deps.manifest.current;
    const key = `${this.deps.registry.size}|${m ? `${m.source}:${m.manifestHash}:${m.count}:${m.fetchedAt}` : "none"}`;
    if (!this.catalogCache || this.catalogCache.key !== key) {
      const catalog = buildCatalog(this.deps.registry, m);
      this.catalogCache = { key, catalog, index: new SearchIndex(catalog) };
    }
    return this.catalogCache;
  }

  get catalog(): Catalog { return this.ensure().catalog; }
  get index(): SearchIndex { return this.ensure().index; }

  /** マニフェストを(必要なら)取り直す。エンジンが落ちていても throw しない。dx12_call {engine} の呼び出し内では触らない(別エンジンの表で上書きしない)。 */
  async refresh(force = false) {
    if ((this.deps.engine as unknown as Routed).overrideActive?.()) return null;
    try { return await this.deps.manifest.refresh({ force, maxAgeMs: 3000 }); }
    catch { return null; }
  }

  private manifestInfo() {
    const m = this.deps.manifest.current;
    return { source: m?.source ?? "none", hash: m?.manifestHash ?? null, engineMethods: m?.count ?? 0 };
  }

  // ── dx12_tool_search ────────────────────────────────────────────────
  async search(input: { query?: string; category?: string; effect?: string; tier?: string; limit?: number }): Promise<ShellResult> {
    const q = String(input.query ?? "").trim();
    if (!q && !input.category) {
      return errorResult({ code: "E_MISSING_PARAM", message: "dx12_tool_search: query が空", fix: [{ tool: "dx12_tool_search", args: { query: "スクリーンショット" }, why: "探したい操作を日本語/英語で書く。カテゴリ一覧は dx12_guide" }], validValues: undefined });
    }
    await this.refresh();
    const { index, catalog } = this;
    const res = index.search(q || (input.category ?? ""), { category: input.category, effect: input.effect, tier: input.tier, limit: input.limit });
    const cats = [...new Set(catalog.docs.map((d) => d.category))].sort();
    return textResult({ ...res, query: q, catalog: { tools: catalog.size, ...this.manifestInfo() }, ...(input.category && !cats.includes(input.category) ? { unknownCategory: input.category, categories: cats, didYouMean: nearest(input.category, cats, 3) } : {}) });
  }

  // ── dx12_tool_describe ──────────────────────────────────────────────
  async describe(input: { name?: string; target?: string }): Promise<ShellResult> {
    const name = String(input.name ?? "").trim();
    if (!name) return errorResult({ code: "E_MISSING_PARAM", message: "dx12_tool_describe: name が空", fix: [{ tool: "dx12_tool_search", args: { query: "..." }, why: "まず検索して名前を得る" }] });
    await this.refresh();
    let doc = this.catalog.resolve(name);
    if (!doc) { await this.refresh(true); doc = this.catalog.resolve(name); }
    if (!doc) return errorResult(this.unknownToolBody(name, {}));
    let params = doc.params;
    const t = String(input.target ?? "").trim().toLowerCase();
    let shown: unknown = params;
    let note: string | undefined;
    let routed: { key: string; legacy: string } | null = null;
    let opRouted: { key: string; method: string } | null = null;
    // 統合ツール(dx12_set_render_settings など)の target には、振り分け先の旧ツールの引数を返す。
    if (t && doc.consolidated) {
      const key = Object.keys(doc.consolidated.routes).find((k) => k.toLowerCase() === t || doc!.consolidated!.routes[k].toLowerCase() === t || doc!.consolidated!.routes[k].toLowerCase() === "dx12_" + t);
      const legacyDoc = key ? this.catalog.resolve(doc.consolidated.routes[key]) : null;
      if (key && legacyDoc) {
        routed = { key, legacy: legacyDoc.id };
        params = legacyDoc.params;
        shown = params;
        note = `${doc.id} の ${doc.consolidated.param}='${key}' の引数(実体は ${legacyDoc.id})`
          + (doc.consolidated.nested ? `。値は ${doc.consolidated.nested}: {…} に入れる` : "。他のキーはそのまま並べる");
        if (params.length > 30) {
          shown = params.map((p) => `${p.name}:${p.type}${p.required ? "*" : ""}${p.enum ? `{${p.enum.join("|")}}` : ""}`);
          note += `。引数が ${params.length} 個ある(名前:型だけ)。説明つきは dx12_tool_describe {name:'${legacyDoc.id}', target:'<部分文字列>'}`;
        }
      } else {
        note = `${doc.consolidated.param} の候補: ${Object.keys(doc.consolidated.routes).join(", ")}`;
      }
    } else if (t && doc.opTable && (doc.opTable.normalize?.(t) ?? (t in doc.opTable.ops ? t : null)) && doc.opTable.ops[doc.opTable.normalize?.(t) ?? t]) {
      // op でエンジンの method 群を束ねたツール(dx12_sequence)の target = op 名: その op の引数だけを返す(必須つき)。
      const key = (doc.opTable.normalize?.(t) ?? t) as string;
      const o = doc.opTable.ops[key];
      const allowed = new Set([...o.required, ...o.optional]);
      params = [
        { name: doc.opTable.param, type: "enum", required: true, enum: Object.keys(doc.opTable.ops), default: key, desc: `操作。ここでは '${key}'` },
        ...doc.params.filter((p) => allowed.has(p.name)).map((p) => ({ ...p, required: o.required.includes(p.name) })),
        ...(o.dryRun === "read" ? [] : doc.params.filter((p) => p.name === "dryRun")),
      ];
      shown = params;
      opRouted = { key, method: o.method };
      note = `${doc.id} の ${doc.opTable.param}='${key}' の引数(エンジン method ${o.method}。${o.summary})`;
    } else if (t) {
      const f = params.filter((p) => p.name.toLowerCase().includes(t) || (p.desc ?? "").toLowerCase().includes(t));
      shown = f; note = `target='${input.target}' を含む引数 ${f.length}/${params.length} 件`;
    } else if (params.length > 30) {
      shown = params.map((p) => `${p.name}:${p.type}${p.required ? "*" : ""}${p.enum ? `{${p.enum.join("|")}}` : ""}`);
      note = `引数が ${params.length} 個ある。名前:型だけ表示。説明つきで見るには target に部分文字列を渡す(例 target:"bloom")`;
    }
    const entry = this.deps.registry.get(doc.id);
    const out: Record<string, unknown> = {
      name: doc.id, kind: doc.kind, tier: doc.tier, category: doc.category,
      summary: doc.summary,
      description: doc.description.length > 3500 ? doc.description.slice(0, 3500) + "…(以下省略)" : doc.description,
      mode: doc.mode, effect: doc.effect, effectClass: doc.effectClass,
      destructive: doc.destructive ?? doc.effectClass === "guarded",
      idempotent: doc.idempotent ?? null,
      timeoutMs: doc.timeoutMs ?? (doc.method ? methodTimeoutMs(doc.method) : undefined),
      deferred: doc.deferred ?? null,
      cancellable: false,
      dryRun: doc.dryRun === "native" || entry?.shape?.dryRun ? "native" : doc.dryRun === "preview" ? "preview(エンジンが実行せずに、対象・件数・破壊性・書くファイルを返す。dx12_call {dryRun:true})" : doc.effectClass === "read" ? "none(読み取りのみ)" : "static(実行せず影響を予測。dx12_call {dryRun:true})",
      journal: doc.journal === true ? "あり(ファイルを書く前に元の内容を退避。dx12_call {name:'journal_list'} / {name:'journal_restore', args:{id}} で戻せる)" : undefined,
      params: shown,
      examples: doc.examples,
      next: [...doc.next, ...(NEXT_BY_CATEGORY[doc.category] ?? [])],
      errors: errorsFor(doc),
      legacy: { aliases: doc.aliases, method: doc.method ?? null, composite: doc.composite },
      callTemplate: { name: doc.id, args: templateArgs(params) },
      source: doc.source,
    };
    // Core(tools/list に直接載る面)。旧ツールのまま入る Core は、説明テンプレを別に持つ(description は旧文のまま)。
    if (doc.core) out.core = true;
    if (doc.coreDescription && doc.coreDescription !== doc.description) out.coreDescription = doc.coreDescription;
    if (doc.opTable) {
      out.ops = Object.fromEntries(Object.entries(doc.opTable.ops).map(([k, o]) => [k, { method: o.method, effect: o.effect, required: o.required, optional: o.optional, dryRun: o.dryRun, summary: o.summary }]));
      out.note = out.note ?? `${doc.opTable.param} でエンジンの method を選ぶ(ops に一覧)。引数は op ごと: dx12_tool_describe {name:'${doc.id}', target:'<op>'}。effect は op ごとに違う(${doc.id} 全体の effect は最も重い値)`;
    }
    if (doc.consolidated) out.consolidated = { param: doc.consolidated.param, values: Object.keys(doc.consolidated.routes), nested: doc.consolidated.nested ?? null, replaces: Object.values(doc.consolidated.routes) };
    if (doc.replacedBy) {
      const c = toCoreCall(doc.id, (out.callTemplate as any).args);
      out.replacedBy = { tool: doc.replacedBy.tool, key: doc.replacedBy.key, call: c, note: "旧名のままでも呼べる(名前・引数・返り値は不変)。Core では統合ツールから同じことができる" };
    }
    if (routed && doc.consolidated) {
      const tpl = templateArgs(params);
      (out.callTemplate as any).args = doc.consolidated.nested ? { [doc.consolidated.param]: routed.key, [doc.consolidated.nested]: tpl } : { [doc.consolidated.param]: routed.key, ...tpl };
      out.routedTo = routed.legacy;
    }
    if (opRouted && doc.opTable) {
      (out.callTemplate as any).args = { [doc.opTable.param]: opRouted.key, ...templateArgs(params.filter((p) => p.name !== doc.opTable!.param)) };
      out.routedTo = opRouted.method;
      out.effect = doc.opTable.ops[opRouted.key].effect;
    }
    if (note) out.note = note;
    if (doc.tier === "shell") out.note = "shell ツール。MCP から直接呼ぶ(dx12_call 経由では呼べない)";
    return textResult(out);
  }

  private unknownToolBody(name: string, args: Record<string, unknown>): ErrorBody {
    const names = this.catalog.names();
    const bare = name.replace(/^dx12_/, "");
    const near = nearest(bare, names.map((n) => n.replace(/^dx12_/, "")), 5).map((n) => this.catalog.resolve(n)?.id ?? n);
    const hits = this.index.search(bare.replace(/_/g, " "), { limit: 3 }).hits.map((h) => h.name);
    const dym = [...new Set([...near, ...hits])].slice(0, 5);
    const fix: Fix[] = [];
    // 綴りが近い名前があるときだけ「撃ち直す」を先頭にする。意味だけの近さ(検索ヒット)は確信度が低いので検索の後ろに置く。
    if (near[0]) fix.push({ tool: near[0], args, why: `'${name}' に最も近い名前で撃ち直す` });
    fix.push({ tool: "dx12_tool_search", args: { query: bare.replace(/_/g, " ") }, why: "名前で検索する" });
    if (!near[0] && hits[0]) fix.push({ tool: hits[0], args, why: `意味の近い候補(確信度は低い。dx12_tool_describe で引数を確認してから使う)` });
    return {
      code: "E_UNKNOWN_TOOL", message: `ツール/メソッド '${name}' は無い`, cause: "名前の打ち間違いか、エンジンにまだ無い method",
      didYouMean: dym, fix, docs: "dx12_tool_search {query}",
      details: { manifest: this.manifestInfo(), hint: "エンジンに method を足した直後なら、エンジンを再ビルド・再起動してからもう一度撃つ(MCP サーバの再起動は不要)" },
    };
  }

  // ── dx12_call ───────────────────────────────────────────────────────
  async call(input: { name?: unknown; args?: unknown; dryRun?: boolean; confirm?: boolean; timeoutMs?: number; idempotency_key?: string; idempotencyKey?: string; viaGuardedTool?: boolean; engine?: unknown }): Promise<ShellResult> {
    // engine 引数: この 1 回だけ、別のエンジン(id / name / port)へ向ける。束縛は変えない。
    if (input.engine !== undefined && input.engine !== null && String(input.engine) !== "") {
      const r = this.deps.engine as unknown as Routed;
      const ref = String(input.engine);
      if (typeof r.withEngine !== "function" || !r.find) {
        return errorResult({ code: "E_UNSUPPORTED", message: "dx12_call: engine 引数はこのサーバでは使えない(フリートが無効)", fix: [{ tool: "dx12_call", args: { name: input.name, args: input.args }, why: "engine 引数を外して撃ち直す" }] });
      }
      if (!r.find(ref)) {
        const ids = (r.list?.() ?? []).map((s) => s.id);
        const cands = [...new Set((r.list?.() ?? []).flatMap((s) => [s.id, s.name ?? s.id]))];
        return errorResult({
          code: "E_FLEET_NOT_FOUND", message: `dx12_call: engine '${ref}' は束縛できるエンジンに無い`, validValues: ids, didYouMean: nearest(ref, cands, 3, { liberal: true }),
          cause: "engine に指定できるのは、このセッションが起動(dx12_engine_launch)または attach したエンジンの id / name / port",
          fix: [{ tool: "dx12_engine_list", args: {}, why: "選べるエンジンを確認する" }, { tool: "dx12_engine_attach", args: { port: Number(ref) || undefined, engine: Number(ref) ? undefined : ref }, why: "他のエンジンを読み取り専用で見るなら attach する" }],
        });
      }
      const { engine: _e, ...rest } = input;
      return r.withEngine(ref, () => this.call(rest));
    }
    const t0 = Date.now();
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return errorResult({ code: "E_MISSING_PARAM", message: "dx12_call: name が空(呼ぶツール名/メソッド名)", fix: [{ tool: "dx12_tool_search", args: { query: "..." }, why: "検索して名前を得る" }] });

    // 引数の正規化(JSON 文字列で渡された場合は直す)
    let args: Record<string, unknown> = {};
    if (input.args === undefined || input.args === null) args = {};
    else if (typeof input.args === "string") {
      try { const v = JSON.parse(input.args); if (v && typeof v === "object" && !Array.isArray(v)) args = v; else throw new Error("not object"); }
      catch { return errorResult({ code: "E_BAD_TYPE", message: "dx12_call: args は JSON オブジェクトでなければならない", fix: [{ tool: "dx12_call", args: { name, args: {} }, why: "args をオブジェクトで渡す" }] }); }
    } else if (typeof input.args === "object" && !Array.isArray(input.args)) args = input.args as Record<string, unknown>;
    else return errorResult({ code: "E_BAD_TYPE", message: "dx12_call: args は JSON オブジェクトでなければならない", fix: [{ tool: "dx12_call", args: { name, args: {} }, why: "args をオブジェクトで渡す" }] });

    await this.refresh();
    let doc = this.catalog.resolve(name);
    if (!doc) { await this.refresh(true); doc = this.catalog.resolve(name); }   // エンジンに増えた method を取り込む
    if (!doc) { const b = this.unknownToolBody(name, args); recordError({ at: Date.now(), tool: name, code: b.code, message: b.message }); return errorResult(b); }
    if (doc.kind === "shell") return errorResult({ code: "E_INVALID_PARAM", message: `${doc.id} は shell ツール。dx12_call 経由では呼べない`, fix: [{ tool: doc.id, args, why: "MCP から直接呼ぶ" }] });

    // 統合ツール(dx12_set_render_settings / dx12_capture / dx12_edit_terrain など): 旧ツールへ振り分けて同じ経路で実行する。
    // 検証・副作用ゲート・dryRun は振り分け先の旧ツールの定義で行い、返り値の形は旧ツールのまま(meta.via に統合ツール名を残す)。
    if (doc.consolidated) return this.callConsolidated(doc, args, input, t0);

    const entry = this.deps.registry.get(doc.id);
    const mf = this.deps.manifest.get(doc.method ?? doc.id);
    const warnings: string[] = [];

    // 事前検証(往復なし)
    let callArgs: Record<string, unknown> = args;
    // 冪等キー(M5)。指定(idempotency_key / idempotencyKey)が最優先。無ければ、エンジン method に 1:1 の write 系だけ自動採番する
    // (E_ENGINE_TIMEOUT / E_IDEMPOTENCY_IN_FLIGHT のとき、同じキーで再送しても二重実行にならない)。
    //   ・method 直撃、または旧ツールが idempotency_key を宣言しているもの(create_entity など)は、引数としてそのまま渡す(エンジンの冪等層が扱う)
    //   ・それ以外の旧ツール / 合成ツールは、呼び出しの文脈(idemCtx)にキーを置き、中でエンジンへ撃つ write 系にサブキーを付ける(EngineClient)
    const userKey = (input.idempotency_key ?? input.idempotencyKey) || undefined;
    const writeOneToOne = !!doc.method && (doc.effect === "write_scene" || doc.effect === "write_setting" || doc.effect === "write_file");
    const idemKey: string | undefined = userKey ?? (writeOneToOne && !input.dryRun ? autoKey() : undefined);
    const declaresKey = !entry || "idempotency_key" in entry.shape;
    if (idemKey && declaresKey && !("idempotency_key" in callArgs)) callArgs = { ...callArgs, idempotency_key: idemKey };
    const v = entry ? validateAgainstShape(entry.name, entry.shape, callArgs)
      : validateAgainstParams(doc.method ?? doc.id, mf?.params ?? [], callArgs, { checkUnknown: mf?.source !== "fallback" });
    if (!v.ok) {
      recordError({ at: Date.now(), tool: doc.id, code: v.body.code, message: v.body.message });
      return errorResult({ ...v.body, fix: (v.body.fix ?? []).map((f) => (f.tool === doc!.id ? { ...f, tool: doc!.id } : f)) });
    }
    if (entry) callArgs = v.data;   // zod の既定値・変換を反映(SDK 経由と同じ)

    // 副作用ゲート。core 面では guarded の実行口を dx12_call_guarded に分ける(名前ベースの許可で dx12_call を許可しても guarded が通らないように)。
    // dx12_call では confirm:true を付けても通さない。それ以外の面(full / shell)は従来どおり confirm:true で通す。
    const splitGuard = this.deps.surface === "core";
    const guardedNow = doc.effectClass === "guarded" || !!CONDITIONAL_GUARDED[doc.id]?.(callArgs);   // 引数しだいで guarded(dx12_job_start {kind:"external"})
    if (guardedNow && !(splitGuard ? input.viaGuardedTool : input.confirm)) {
      const via = splitGuard ? CORE_GUARDED_TOOL : "dx12_call";
      const b: ErrorBody = {
        code: "E_GUARDED", message: `${doc.id} は取り返しの付かない/外部に影響する操作(effect=${guardedNow && doc.effectClass !== "guarded" ? "guarded" : doc.effect})。ユーザーの承認が要る`,
        cause: splitGuard
          ? `guarded な操作は dx12_call では実行しない(confirm:true でも通らない)。${CORE_GUARDED_TOOL} から実行する(ユーザーが毎回承認する)`
          : "guarded な操作は confirm:true を付けないと dx12_call では実行しない",
        fix: [{ tool: via, args: { name: doc.id, args, dryRun: true }, why: "まず dryRun:true で影響を確認する" },
              { tool: via, args: splitGuard ? { name: doc.id, args } : { name: doc.id, args, confirm: true }, why: "ユーザーの承認を得たあとで実行する" }],
        details: { effect: doc.effect, ...(splitGuard ? { via } : {}) },
      };
      recordError({ at: Date.now(), tool: doc.id, code: b.code, message: b.message });
      if (!input.dryRun) return errorResult(b);
    }

    // 未保存の変更を消す操作の事前警告
    const bare = doc.method ?? doc.id.replace(/^dx12_/, "");
    let sceneDirty: boolean | null = null;
    if (["open_scene", "new_scene", "open_project"].includes(bare)) {
      try {
        const pong = await this.deps.engine.call("ping", {}, { timeout: 2000, retry: false });
        sceneDirty = !!pong?.sceneDirty;
        if (sceneDirty) warnings.push(`未保存の変更がある(sceneDirty:true)。${bare} は現在のシーンを閉じる。MCP 接続中は自動保存されるが、外部でシーン JSON を書き換えた直後なら先に dx12_save_scene で確定するか、意図した変更か確認すること`);
      } catch { /* 警告が取れなくても続行 */ }
    }

    // dryRun
    if (input.dryRun) return this.dryRun(doc, entry, callArgs, warnings, sceneDirty, t0);

    // 実行
    const ctxTool = doc.id;
    let result: ShellResult | null = null;
    let thrown: unknown = null;
    // ゲートを通った guarded な呼び出しの中だけ「承認済み」にする(guardCtx.ts。dx12_batch や合成ツールの内部呼び出しは承認済みにならない)
    const approval = guardedNow ? { approved: true as const, via: splitGuard ? CORE_GUARDED_TOOL : "dx12_call" } : null;
    const exec = async () => {
      if (entry) {
        result = await callContext.run({ tool: entry.name, args: callArgs, mode: "call" }, () => entry.invoke(callArgs));
      } else {
        const timeout = input.timeoutMs ?? mf?.timeoutMs ?? methodTimeoutMs(doc!.method ?? doc!.id);
        const raw = await this.deps.engine.call(doc!.method ?? doc!.id, callArgs, { timeout });
        result = { content: [{ type: "text", text: JSON.stringify({ ok: true, result: raw ?? null, meta: {} }) }] };
        (result as any)._raw = raw ?? null;
      }
    };
    const runOnce = async () => {
      result = null; thrown = null;
      try {
        const inner = () => (approval ? guardApproval.run(approval, exec) : exec());
        if (idemKey && entry && !declaresKey) await idemCtx.run(newIdemCtx(idemKey), inner); else await inner();
      } catch (e) { thrown = e; }
    };
    await runOnce();
    let attempts = 0;
    let tookMs = Date.now() - t0;
    while (thrown || result?.isError) {
      const src = thrown ?? (result ? ERROR_SOURCE.get(result) : undefined);
      let body: ErrorBody;
      const prebuilt = result ? (ERROR_BODY.get(result) as ErrorBody | undefined) : undefined;   // dx12_engine_* など、最初から構造化して返すツール
      if (prebuilt) body = { ...prebuilt };
      else if (src) body = await structureError(src, { tool: ctxTool, args: callArgs, engine: this.deps.engine, suggestNames: () => this.catalog.names() });
      else {
        const msg = (result?.content ?? []).filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
        body = { code: "E_INVALID_PARAM", message: msg || `${doc.id} が失敗した`, retryable: false, fix: [{ tool: "dx12_tool_describe", args: { name: doc.id }, why: "引数と注意点を確認する" }] };
      }
      if (this.reconnectNotice) { body.details = { ...(body.details ?? {}), note: "エンジンへ再接続した(再起動の可能性)。entityId は失効している" }; }
      // タイムアウト / 処理中は、同じ冪等キーで再送する(エンジンは完了済みなら前回の結果を返す = 二重実行にならない)。最大 3 回。
      if (idemKey && attempts < 3 && (body.code === "E_ENGINE_TIMEOUT" || body.code === "E_IDEMPOTENCY_IN_FLIGHT")) {
        attempts++;
        await this.waitEngineResponsive(attempts);
        await runOnce();
        continue;
      }
      if (attempts > 0) body.details = { ...(body.details ?? {}), idempotencyKey: idemKey, autoRetried: attempts, note: "同じ冪等キーで再送したが完了しなかった。エンジンがまだ処理中の可能性がある。dx12_ping で応答を確認し、dx12_list_entities 等で実際の状態を見てから、同じ idempotency_key で撃ち直す" };
      recordError({ at: Date.now(), tool: doc.id, code: body.code, message: body.message });
      // 未知の method(エンジンに無い)なら、マニフェストが古い可能性があるので取り直しておく
      if (body.code === "E_UNKNOWN_TOOL") {
        void this.refresh(true);
        // TS ラッパ(旧ツール)が呼んだ method をエンジンが知らない = エンジンが古い/別のビルド。名前の打ち間違いではない。
        if (entry && doc.method) {
          body.code = "E_ENGINE_TOO_OLD";
          body.message = `エンジンが method '${doc.method}' を持たない(${doc.id} が呼ぶ method)`;
          body.cause = "エンジンが古いか、この method を含まないビルド。名前の打ち間違いではない";
          body.retryable = false;
          body.didYouMean = undefined;
          body.fix = [{ tool: "dx12_doctor", args: {}, why: "エンジンの版とマニフェストを確認する" }, { why: "エンジンを更新(または最新をビルド)して再起動する。MCP サーバ(Node)の再起動は要らない" }];
        }
      }
      const late = this.deps.engine.drainLateResults();
      const env = envelope(body);
      if (late.length) env.meta = { lateResults: late };
      return textResult(env, true);
    }

    tookMs = Date.now() - t0;
    // 成功: 旧ツールの返り値の形(JSON 文字列 / 文字列 / 画像+text)を result に入れ、meta を足す
    const images = (result!.content as any[]).filter((c) => c.type === "image");
    const texts = (result!.content as any[]).filter((c) => c.type === "text").map((c) => c.text as string);
    let payload: unknown;
    if ((result as any)._raw !== undefined) payload = (result as any)._raw;
    else {
      const last = texts[texts.length - 1] ?? "";
      try { payload = JSON.parse(last); } catch { payload = last; }
    }
    // op でエンジンの method 群を束ねたツール(dx12_sequence)は、呼んだ op の副作用を meta に出す(ツール全体の effect は最も重い値)。
    const opKeyNow = doc.opTable ? (doc.opTable.normalize?.(callArgs[doc.opTable.param]) ?? null) : null;
    const meta: Record<string, unknown> = { tool: doc.id, method: doc.method ?? null, effect: (opKeyNow && doc.opTable?.ops[opKeyNow]?.effect) || doc.effect, tookMs, ...(opKeyNow && doc.opTable ? { op: opKeyNow, engineMethod: doc.opTable.ops[opKeyNow]?.method } : {}) };
    if (this.deps.manifest.current?.manifestHash) meta.manifestHash = this.deps.manifest.current.manifestHash;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as any).undoEntry === "string") meta.undoEntry = (payload as any).undoEntry;
    if (userKey) meta.idempotencyKey = userKey;
    if (attempts > 0) { meta.autoRetried = attempts; meta.idempotencyKey = idemKey; }
    if (payload && typeof payload === "object" && (payload as any).idempotentReplay === true) meta.idempotentReplay = true;
    if (this.reconnectNotice) { warnings.push("エンジンへ再接続した(再起動の可能性)。前の entityId は失効している。dx12_list_entities で引き直すこと"); this.reconnectNotice = false; }
    if (warnings.length) meta.warnings = warnings;
    const late = this.deps.engine.drainLateResults();
    if (late.length) meta.lateResults = late.map((l) => ({ method: l.method, elapsedMs: l.elapsedMs, ok: l.ok, result: l.result, error: l.error }));
    const env = { ok: true, result: payload ?? null, meta };
    return { content: [...images, { type: "text", text: JSON.stringify(env) }] };
  }

  /** タイムアウト / 処理中のあと、エンジンが応答するのを待つ(冪等キーつきの再送の前)。 */
  private async waitEngineResponsive(attempt: number) {
    await new Promise((r) => setTimeout(r, Math.min(3000, 600 * attempt)));
    for (let i = 0; i < 8; i++) {
      try { await this.deps.engine.call("ping", {}, { timeout: 2500, retry: false }); return; }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  }

  /** 統合ツールの dx12_call。振り分け先の旧ツールを dx12_call と同じ経路で呼び、meta.via / fix を統合ツールの形に直す。 */
  private async callConsolidated(doc: ToolDoc, args: Record<string, unknown>, input: { dryRun?: boolean; confirm?: boolean; timeoutMs?: number; idempotency_key?: string; viaGuardedTool?: boolean }, t0: number): Promise<ShellResult> {
    const spec = CONSOLIDATED[doc.id];
    // target 省略の dx12_get_render_settings は全 target をまとめて読む(読み取りのみ)
    if (doc.id === "dx12_get_render_settings" && (args[spec.param] === undefined || args[spec.param] === null || args[spec.param] === "")) {
      const all = await this.readAllRenderSettings();
      const meta = { tool: doc.id, method: null, effect: "read", tookMs: Date.now() - t0 };
      return textResult({ ok: true, result: all, meta });
    }
    const routed = routeConsolidated(spec, args);
    if (!routed.ok) {
      const b: ErrorBody = {
        code: routed.code, message: routed.message, cause: routed.message, validValues: routed.validValues.length ? routed.validValues : undefined,
        didYouMean: typeof routed.received === "string" ? nearest(routed.received, routed.validValues, 3, { liberal: true }) : undefined,
        fix: [{ tool: "dx12_tool_describe", args: { name: doc.id }, why: "引数の一覧・型・例を確認する" }],
        docs: `dx12_tool_describe {name:'${doc.id}'}`,
      };
      if (b.didYouMean?.[0]) b.fix = [{ tool: doc.id, args: { ...args, [routed.param]: b.didYouMean[0] }, why: `'${routed.param}' に最も近い値で撃ち直す` }, ...(b.fix ?? [])];
      recordError({ at: Date.now(), tool: doc.id, code: b.code, message: b.message });
      return errorResult(b);
    }
    const r = await this.call({ ...input, name: routed.legacy, args: routed.legacyArgs });
    try {
      const last = r.content[r.content.length - 1];
      if (last?.type === "text") {
        const env = JSON.parse(last.text);
        if (env && typeof env === "object") {
          if (env.meta && typeof env.meta === "object") env.meta.via = doc.id;
          if (Array.isArray(env.fix)) env.fix = rewriteFixToCore(env.fix, routed.legacy);
          return { ...r, content: [...r.content.slice(0, -1), { type: "text", text: JSON.stringify(env) }] };
        }
      }
    } catch { /* そのまま返す */ }
    return r;
  }

  /** dx12_get_render_settings を target 省略で撃ったとき: 全 target の現在値を読む(1 つ失敗しても残りは返す)。 */
  async readAllRenderSettings(): Promise<{ targets: Record<string, unknown>; errors?: Record<string, string> }> {
    const targets: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const t of RENDER_SETTING_TARGETS) {
      const legacy = CONSOLIDATED.dx12_get_render_settings.routes[t];
      const entry = this.deps.registry.get(legacy);
      if (!entry) { errors[t] = `${legacy} が登録されていない`; continue; }
      try {
        const res: any = await callContext.run({ tool: legacy, args: {}, mode: "call" }, () => entry.invoke({}));
        const text = (res?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        if (res?.isError) { errors[t] = text.slice(0, 300); continue; }
        try { targets[t] = JSON.parse(text); } catch { targets[t] = text; }
      } catch (e: any) { errors[t] = String(e?.message ?? e).slice(0, 300); }
    }
    return { targets, ...(Object.keys(errors).length ? { errors } : {}) };
  }

  /** dx12_call_guarded: guarded な操作だけを実行する(ユーザーの毎回の承認はクライアント側の requiresUserInteraction が取る)。 */
  async callGuarded(input: { name?: unknown; args?: unknown; dryRun?: boolean; timeoutMs?: number; idempotency_key?: string; idempotencyKey?: string }): Promise<ShellResult> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return errorResult({ code: "E_MISSING_PARAM", message: `${CORE_GUARDED_TOOL}: name が空(呼ぶツール名)`, fix: [{ tool: "dx12_tool_search", args: { query: "git push", effect: "guarded" }, why: "guarded な操作を探す" }] });
    await this.refresh();
    let doc = this.catalog.resolve(name);
    if (!doc) { await this.refresh(true); doc = this.catalog.resolve(name); }
    const gArgs = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? (input.args as Record<string, unknown>) : {};
    if (doc && doc.effectClass !== "guarded" && !CONDITIONAL_GUARDED[doc.id]?.(gArgs)) {
      return errorResult({
        code: "E_INVALID_PARAM", message: `${doc.id} は guarded ではない(effect=${doc.effect})。${CORE_GUARDED_TOOL} は guarded な操作専用`,
        cause: "通常の操作は dx12_call で実行する(承認の要る口を通常操作に使わない)",
        fix: [{ tool: "dx12_call", args: { name: doc.id, args: input.args ?? {} }, why: "通常の操作は dx12_call で実行する" }],
      });
    }
    // 名前が引けない場合も dx12_call と同じ構造化エラー(didYouMean 付き)にする
    return this.call({ ...input, confirm: true, viaGuardedTool: true });
  }

  /** 実行せずに「何が起こるか」を返す。読み取り専用の問い合わせ(get_entity 等)だけをエンジンへ撃つ。 */
  private async dryRun(doc: ToolDoc, entry: ToolEntry | undefined, args: Record<string, unknown>, warnings: string[], sceneDirty: boolean | null, t0: number): Promise<ShellResult> {
    const base: Record<string, unknown> = { ok: true, dryRun: true };
    const meta = { tool: doc.id, method: doc.method ?? null, effect: doc.effect, tookMs: 0 } as Record<string, unknown>;
    // 読み取りはそのまま実行して構わない(副作用が無い)。ただし引数しだいで書くツール(validate_layout の fix など)は実行しない。
    if (doc.effectClass === "read" && !CONDITIONAL_WRITE[doc.id]?.(args)) {
      const r = await this.call({ name: doc.id, args, dryRun: false });
      try {
        const env = JSON.parse((r.content[r.content.length - 1] as any).text);
        if (env && typeof env === "object") { env.dryRun = "ignored(read-only: 実行した)"; return { ...r, content: [...r.content.slice(0, -1), { type: "text", text: JSON.stringify(env) }] }; }
      } catch { /* そのまま返す */ }
      return r;
    }
    // dx12_batch: 各 op をエンジンのプレビューに通して、まとめて返す(実行しない)
    if (doc.id === "dx12_batch") return this.dryRunBatch(args, warnings, t0);
    // ネイティブの dryRun を持つツール(look_apply / vfx_apply / decal_apply / sequence_author / organize_scene など)
    if (entry?.shape && "dryRun" in entry.shape) {
      const r = await this.call({ name: doc.id, args: { ...args, dryRun: true }, dryRun: false, confirm: true });
      try {
        const env = JSON.parse((r.content[r.content.length - 1] as any).text);
        if (env && typeof env === "object") {
          env.dryRunMode = "native"; env.executed = false;
          // エラー時の fix に、こちらが足した dryRun:true を残さない(fix を撃ち直すときは元の呼び方に戻す)
          if (Array.isArray(env.fix)) for (const f of env.fix) if (f?.args && f.tool === doc.id && !("dryRun" in args)) delete f.args.dryRun;
          return { ...r, content: [...r.content.slice(0, -1), { type: "text", text: JSON.stringify(env) }] };
        }
      } catch { /* そのまま返す */ }
      return r;
    }
    // エンジンのプレビュー(M5。マニフェストの dryRun:"preview")。エンジンが実行せずに「実際に何が起こるか」(対象・件数・破壊性・書くファイル)を返す。副作用ゼロ。
    if (doc.dryRun === "preview" && doc.method) {
      try {
        const raw = await this.deps.engine.call(doc.method, { ...args, dryRun: true }, { timeout: 8000, retry: false });
        meta.tookMs = Date.now() - t0;
        if (warnings.length) meta.warnings = warnings;
        return textResult({ ...base, executed: false, dryRunMode: "engine", preview: { tool: doc.id, method: doc.method, effect: doc.effect, ...(raw?.preview ?? raw ?? {}) }, meta });
      } catch (e: any) {
        // エンジンが古い/引数が合わない等でプレビューが取れなければ、下の静的な予測へ落とす(理由を warnings に残す)
        warnings.push(`エンジンのプレビューを取れなかったので静的な予測にした: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    }
    // 静的な影響予測 + 対象の存在確認(読み取りのみ)
    const targets: Record<string, unknown>[] = [];
    const ref: Record<string, unknown> = {};
    if (typeof args.entity === "number") ref.entity = args.entity;
    if (typeof args.name === "string") ref.name = args.name;
    if (Object.keys(ref).length && doc.params.some((p) => p.name === "entity" || p.name === "name")) {
      try {
        const e = await this.deps.engine.call("get_entity", ref, { timeout: 3000, retry: false });
        targets.push({ kind: "entity", ref, exists: true, entityId: e?.entityId ?? null, componentTypes: e?.componentTypes ?? null });
      } catch (err: any) {
        const b = await structureError(err, { tool: doc.id, args, engine: this.deps.engine });
        targets.push({ kind: "entity", ref, exists: false, didYouMean: b.didYouMean ?? [] });
        warnings.push(`対象のエンティティが見つからない(${JSON.stringify(ref)})。実行すると失敗する`);
      }
    }
    const condWrite = doc.effectClass === "read" && !!CONDITIONAL_WRITE[doc.id]?.(args);   // 例 validate_layout {fix:'safe'}
    const undoable = doc.effect === "write_scene" || doc.effect === "write_setting" || condWrite;
    const filesWritten = doc.effect === "write_file";
    const destructive = doc.effectClass === "guarded" || doc.destructive === true || /(^|_)(delete|remove|clear|reset)(_|$)/.test(doc.id);
    meta.tookMs = Date.now() - t0;
    if (warnings.length) meta.warnings = warnings;
    const preview = {
      tool: doc.id, method: doc.method ?? null, effect: doc.effect, mode: doc.mode,
      destructive, undoable: undoable ? "Undo 1 エントリ(AI: <method>)で戻せる(Editor モードのみ)" : filesWritten ? "ファイルを書く。Undo では戻らない(.dx12/backups と git で復元)" : doc.effectClass === "runtime" ? "実行状態を変える(Play/Stop がスナップショットに戻す)" : "戻せない",
      targets, sceneDirty,
      args,
      notes: [
        "実行はしていない。読み取り専用の問い合わせ(対象の存在確認)だけを行った",
        ...(destructive ? ["破壊的な操作。実行前にユーザーの意図を確認すること"] : []),
        ...(doc.mode === "editor" ? ["Editor モードでのみ実行できる(Play 中は E_MODE_CONFLICT)"] : []),
      ],
      supported: "static(このメソッドは native dryRun を持たない。影響の予測と対象の確認まで)",
    };
    return textResult({ ...base, executed: false, preview, meta });
  }

  /** dx12_call {name:"dx12_batch", dryRun:true}: 各 op の method をエンジンのプレビュー(マニフェストの dryRun:"preview")へ通す。実行しない。 */
  private async dryRunBatch(args: Record<string, unknown>, warnings: string[], t0: number): Promise<ShellResult> {
    const ops: any[] = Array.isArray(args.ops) ? (args.ops as any[]) : [];
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < ops.length; i++) {
      const m = String(ops[i]?.method ?? "");
      const mf = this.deps.manifest.get(m);
      if (!mf) { items.push({ index: i, method: m, supported: false, note: "エンジンのマニフェストに無い method(古いエンジン/打ち間違い)" }); continue; }
      if (mf.effect === "read") { items.push({ index: i, method: m, effect: "read", supported: true, note: "読み取り: 実行時にそのまま実行される(dryRun では撃たない)" }); continue; }
      if (mf.effect === "guarded") { items.push({ index: i, method: m, effect: "guarded", blocked: true, note: "guarded な method は dx12_batch では実行できない(E_GUARDED)" }); continue; }
      if (mf.dryRun === "preview") {
        try {
          const raw = await this.deps.engine.call(m, { ...(ops[i]?.params ?? {}), dryRun: true }, { timeout: 8000, retry: false });
          items.push({ index: i, method: m, effect: mf.effect, supported: true, preview: raw?.preview ?? raw });
        } catch (e: any) { items.push({ index: i, method: m, effect: mf.effect, supported: true, error: String(e?.message ?? e).slice(0, 200) }); }
      } else items.push({ index: i, method: m, effect: mf.effect, supported: false, note: "この method は dryRun のプレビューを持たない(実行するまで結果は分からない)" });
    }
    const unsupported = items.filter((x) => x.supported === false).length;
    const blocked = items.filter((x) => x.blocked === true).length;
    const meta = { tool: "dx12_batch", method: null, effect: "write_scene", tookMs: Date.now() - t0, ...(warnings.length ? { warnings } : {}) };
    return textResult({
      ok: true, dryRun: true, executed: false, dryRunMode: "engine-per-op",
      preview: {
        tool: "dx12_batch", count: ops.length, unsupportedOps: unsupported, blockedOps: blocked,
        destructive: items.some((x: any) => x.preview?.destructive === true),
        willFail: items.some((x: any) => x.preview?.willFail === true || x.blocked === true || x.error),
        ops: items,
        notes: [
          "実行はしていない。各 op を『いまのシーンに対して』プレビューした(前の op が作るものを参照する op は、この時点では存在しないので willFail になりうる)",
          ...(blocked ? ["guarded な op を含むので、実行するとバッチ全体が E_GUARDED で拒否される(1 つも実行されない)"] : []),
          ...(unsupported ? [`${unsupported} 個の op はプレビューを持たない`] : []),
        ],
      },
      meta,
    });
  }

  // ── dx12_doctor ─────────────────────────────────────────────────────
  async doctor(input: { deep?: boolean }): Promise<ShellResult> {
    const docs = this.catalog.docs;
    const ms = this.deps.manifest;
    const report = await runDoctor({
      engine: this.deps.engine, toolset: this.deps.toolset, tsVersion: this.deps.version, surface: this.deps.surface, listChanged: this.deps.listChanged,
      toolCounts: { legacy: docs.filter((d) => d.tier === "legacy").length, shell: docs.filter((d) => d.tier === "shell").length, core: docs.filter((d) => d.core).length, total: docs.length },
      // getter にする: runDoctor が refresh(マニフェストの取り直し)した後の値を読むため。
      manifest: {
        get source() { return ms.current?.source ?? "none"; },
        get hash() { return ms.current?.manifestHash ?? null; },
        get snapshotHash() { return ms.snapshot?.manifestHash ?? null; },
        get count() { return ms.current?.count ?? 0; },
        get lastError() { return ms.lastError; },
      },
      refresh: async () => { const r = await this.deps.manifest.refresh({ force: true }); return { ping: r.ping, engineTooOld: r.engineTooOld, changed: r.changed }; },
      recentErrors: () => recentErrors(),
      ...(this.deps.fleetStatus ? { fleet: this.deps.fleetStatus } : {}),
      ...(this.deps.jobsStatus ? { jobs: this.deps.jobsStatus } : {}),
      lateResults: () => this.deps.engine.getLateResults().map((l) => ({ method: l.method, elapsedMs: l.elapsedMs, ok: l.ok, at: l.at })),
      ...(this.deps.doctorHooks as object ?? {}),
    }, { deep: input.deep });
    return textResult(report, report.ok === false);
  }

  // ── dx12_guide ──────────────────────────────────────────────────────
  guideTopics(): { id: string; title: string; summary: string }[] {
    const dir = this.deps.guidesDir ?? GUIDES_DIR;
    const out: { id: string; title: string; summary: string }[] = [];
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
        const body = fs.readFileSync(path.join(dir, f), "utf8");
        const title = /^#\s+(.+)$/m.exec(body)?.[1] ?? f;
        const summary = /^>\s*(.+)$/m.exec(body)?.[1] ?? "";
        out.push({ id: f.replace(/\.md$/, ""), title, summary });
      }
    } catch { /* ガイドが無い配布形態 */ }
    return out;
  }

  guide(input: { topic?: string }): ShellResult {
    const topics = this.guideTopics();
    const t = String(input.topic ?? "").trim().toLowerCase();
    if (!t) return textResult({ topics, hint: "dx12_guide {topic} で本文(Markdown)を返す。迷ったら dx12_doctor → dx12_tool_search" });
    const hit = topics.find((x) => x.id === t) ?? topics.find((x) => x.id.includes(t) || x.title.toLowerCase().includes(t));
    if (!hit) {
      return errorResult({
        code: "E_BAD_ENUM", message: `dx12_guide: トピック '${input.topic}' は無い`, validValues: topics.map((x) => x.id),
        didYouMean: nearest(t, topics.map((x) => x.id), 3),
        fix: [{ tool: "dx12_guide", args: { topic: nearest(t, topics.map((x) => x.id), 1)[0] ?? topics[0]?.id }, why: "最も近いトピック" }],
      });
    }
    const body = fs.readFileSync(path.join(this.deps.guidesDir ?? GUIDES_DIR, hit.id + ".md"), "utf8");
    return { content: [{ type: "text", text: body }] };
  }
}
