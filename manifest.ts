// エンジンのマニフェスト(McpMeta の一覧)をこちらへ取り込む層。
//
// ★再起動不要の核: エンジンに新しい method を足して再ビルド・再起動しても、この MCP サーバ(Node)は
//   生きたまま次の呼び出しで再接続し、ping.manifestHash の変化を見て describe_mcp_manifest を取り直す。
//   取り直した一覧は dx12_tool_search / dx12_tool_describe / dx12_call がそのまま使える(TS の改修も
//   Claude Code の再起動も要らない)。
//
// 取得元の優先順位:
//   live      … 実行中のエンジンの describe_mcp_manifest(正)
//   fallback  … 古いエンジン(manifest 無し)は describe_mcp_params で {key,type} だけ組む
//   snapshot  … エンジンに繋がらない間の代役(manifest.snapshot.json。リポジトリ同梱。scripts/gen_manifest_snapshot.mjs で更新)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineClient } from "./engineClient.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export type ManifestParam = {
  name: string; type: string; required?: boolean; enum?: string[];
  min?: number; max?: number; default?: unknown; desc?: string; enforce?: boolean;
};

export type EffectName = "read" | "write_scene" | "write_setting" | "write_file" | "runtime" | "guarded";

export type ManifestMethod = {
  name: string;
  category: string;
  summary: string;
  keywords?: string;
  effect: EffectName;
  mode?: string;                     // any | editor | playing
  timeoutMs?: number;
  idempotent?: boolean;
  deferred?: boolean;
  dryRun?: string;                   // none | native | preview(エンジンが dryRun:true で実際に何が起こるかを返す。M5)
  journal?: boolean;                 // ファイルを書く前に元の内容を退避する(.dx12/journal/。journal_restore で戻せる。M5)
  group?: string;
  target?: string;
  aliases?: string[];                // 旧 TS ツール名(dx12_xxx)
  expose?: string;                   // "core" = tools/list へ動的に昇格させる(未指定 = dx12_tool_search / dx12_call で使う)
  params?: ManifestParam[];
  next?: { tool: string; when?: string }[];
  examples?: { args: Record<string, unknown>; note?: string }[];
  source?: string;                   // meta | derived | fallback
};

export type Manifest = {
  protocol: number;
  manifestHash: string | null;
  engineVersion?: string;
  count: number;
  methods: Map<string, ManifestMethod>;
  categories: { id: string; count: number }[];
  fetchedAt: number;
  source: "live" | "fallback" | "snapshot";
};

export const SNAPSHOT_PATH = path.join(here, "manifest.snapshot.json");

function toManifest(raw: any, source: Manifest["source"]): Manifest {
  const methods = new Map<string, ManifestMethod>();
  for (const m of raw?.methods ?? []) {
    if (m && typeof m.name === "string") methods.set(m.name, m as ManifestMethod);
  }
  return {
    protocol: Number(raw?.protocol ?? 1),
    manifestHash: typeof raw?.manifestHash === "string" ? raw.manifestHash : null,
    engineVersion: typeof raw?.engineVersion === "string" ? raw.engineVersion : undefined,
    count: methods.size,
    methods,
    categories: Array.isArray(raw?.categories) ? raw.categories : [],
    fetchedAt: Date.now(),
    source,
  };
}

/** 同梱スナップショットを読む(無ければ null)。 */
export function loadSnapshot(file: string = SNAPSHOT_PATH): Manifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const m = toManifest(raw, "snapshot");
    return m.count > 0 ? m : null;
  } catch {
    return null;
  }
}

/** describe_mcp_params の結果から、型だけのマニフェストを組む(古いエンジン向けの代役)。 */
export function manifestFromParams(result: any): Manifest {
  const methods: any[] = [];
  for (const [name, keys] of Object.entries<any>(result?.methods ?? {})) {
    methods.push({
      name, category: "uncategorized", summary: "", effect: "write_scene", source: "fallback",
      params: (Array.isArray(keys) ? keys : []).map((k: any) => ({ name: String(k.key), type: String(k.type ?? "any") })),
    });
  }
  return toManifest({ protocol: 0, manifestHash: null, methods }, "fallback");
}

export type RefreshResult = {
  changed: boolean;
  source: Manifest["source"] | "none";
  hash: string | null;
  previousHash: string | null;
  /** エンジンが manifest を持たない(古い)。 */
  engineTooOld?: boolean;
  error?: string;
  /** ping で得たエンジン情報(doctor が使う)。 */
  ping?: any;
};

export class ManifestStore {
  current: Manifest | null;
  readonly snapshot: Manifest | null;
  private lastCheckAt = 0;
  private inflight: Promise<RefreshResult> | null = null;
  private listeners: ((m: Manifest) => void)[] = [];
  lastError: string | null = null;

  private engine: EngineClient;

  // Node の型ストリップ実行はパラメータプロパティ非対応なので明示代入。
  constructor(engine: EngineClient, snapshotFile: string = SNAPSHOT_PATH) {
    this.engine = engine;
    this.snapshot = loadSnapshot(snapshotFile);
    this.current = this.snapshot;
  }

  onChange(cb: (m: Manifest) => void) { this.listeners.push(cb); }

  /** 現在の一覧(live > fallback > snapshot)。無ければ空。 */
  methods(): ManifestMethod[] { return this.current ? [...this.current.methods.values()] : []; }

  get(name: string): ManifestMethod | undefined {
    if (!this.current) return undefined;
    const direct = this.current.methods.get(name);
    if (direct) return direct;
    // 別名(dx12_xxx)
    if (name.startsWith("dx12_")) return this.current.methods.get(name.slice(5));
    return undefined;
  }

  /**
   * エンジンの manifestHash を見て、変わっていれば取り直す。
   * maxAgeMs 以内に確認済みなら何もしない(shell ツールが毎回 ping しないため)。force で必ず確認。
   */
  refresh(opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<RefreshResult> {
    const maxAge = opts.maxAgeMs ?? 3000;
    if (!opts.force && this.current?.source !== "snapshot" && Date.now() - this.lastCheckAt < maxAge) {
      return Promise.resolve({ changed: false, source: this.current?.source ?? "none", hash: this.current?.manifestHash ?? null, previousHash: this.current?.manifestHash ?? null });
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async doRefresh(): Promise<RefreshResult> {
    const previousHash = this.current?.manifestHash ?? null;
    const base = (extra: Partial<RefreshResult>): RefreshResult => ({
      changed: false, source: this.current?.source ?? "none", hash: this.current?.manifestHash ?? null, previousHash, ...extra,
    });
    let pong: any;
    try {
      pong = await this.engine.call("ping", {}, { timeout: 2500 });
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      return base({ error: this.lastError });
    }
    this.lastCheckAt = Date.now();
    this.lastError = null;
    const hash = typeof pong?.manifestHash === "string" ? pong.manifestHash : null;
    if (hash && this.current?.source === "live" && this.current.manifestHash === hash) {
      return base({ ping: pong });
    }
    if (hash) {
      try {
        const raw = await this.engine.call("describe_mcp_manifest", {}, { timeout: 8000 });
        this.current = toManifest(raw, "live");
        if (!this.current.manifestHash) this.current.manifestHash = hash;
        for (const cb of this.listeners) { try { cb(this.current); } catch { /* 通知失敗は無視 */ } }
        return { changed: previousHash !== this.current.manifestHash || this.current.source !== "live", source: "live", hash: this.current.manifestHash, previousHash, ping: pong };
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
        return base({ error: this.lastError, ping: pong });
      }
    }
    // manifestHash の無い(古い)エンジン: describe_mcp_params で型だけ組む。
    try {
      const raw = await this.engine.call("describe_mcp_params", {}, { timeout: 8000 });
      this.current = manifestFromParams(raw);
      for (const cb of this.listeners) { try { cb(this.current); } catch { /* 通知失敗は無視 */ } }
      return { changed: true, source: "fallback", hash: null, previousHash, engineTooOld: true, ping: pong };
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      return base({ error: this.lastError, engineTooOld: true, ping: pong });
    }
  }
}
