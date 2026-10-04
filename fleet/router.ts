// EngineRouter: 全ツールが使う `engine`(EngineClient と同じ公開面)を「このセッションの束縛先」へ振り分ける薄い層。
//
//   解決順: ① dx12_call {engine} の呼び出し内だけの上書き(AsyncLocalStorage)→ ② セッションの束縛(dx12_engine_launch/use/attach)→ ③ 従来のクライアント
//   束縛が無ければ ③(=ポートファイル/DX12_MCP_PORT/8787 の従来の探索)なので、フリートを使わない運用は 1 バイトも変わらない。
//
//   スロット(束縛できるエンジン):
//     managed  … フリートが起動した自分専用のエンジン。読み書き自由。
//     attached … 他人の/外部のエンジン。既定は読み取り専用(effect:"read" の method だけ通す)。貸し出し接続(最後の応答から 1.5 秒で切断)。
import { AsyncLocalStorage } from "node:async_hooks";
import { EngineClient } from "../engineClient.ts";
import type { EngineCallError, LateResult } from "../engineClient.ts";

export type Slot = {
  id: string;
  name: string;
  kind: "managed" | "attached";
  port: number;
  host: string;
  client: EngineClient;
  readOnly: boolean;
  /** 読み取り専用のとき通してよい method(マニフェストの effect:"read")。null なら名前の前置で判定する。 */
  readMethods: Set<string> | null;
  /** 最後に(ping / describe_mcp_manifest 以外の)呼び出しを通した時刻。アイドル自動終了の基準。 */
  lastCallAt: number;
  createdAt: number;
};

/** 名前の前置で「読み取り」とみなす method(マニフェストが取れない場合の保険)。 */
export const READ_PREFIX = /^(get_|list_|describe_|find_|query_|ping$|perf_stats$|read_|project_world_to_screen$|pick$|raycast_precise$|terrain_sample$|terrain_splat_info$|navmesh_info$|audio_state$)/;

/** アクティビティに数えない method(エンジン側の idle 判定と揃える)。 */
export const PASSIVE_METHODS = new Set(["ping", "describe_mcp_manifest", "describe_mcp_params"]);

export type FleetError = EngineCallError & { errName: string };

export function fleetError(name: string, message: string, extra: Partial<EngineCallError> = {}): FleetError {
  const e = new Error(message) as FleetError;
  e.errName = name;
  Object.assign(e, extra);
  return e;
}

type OverrideStore = { engine: string };

export class EngineRouter {
  private legacy: EngineClient;
  private slots = new Map<string, Slot>();
  private bound: string | null = null;
  private als = new AsyncLocalStorage<OverrideStore>();
  private connectListeners: ((epoch: number, reconnect: boolean) => void)[] = [];
  private switchListeners: ((id: string | null) => void)[] = [];
  /** 束縛が無く、従来の接続先にも繋がらないとき呼ぶ(DX12_FLEET_AUTOLAUNCH=1)。専用エンジンを起動して束縛したら true。 */
  autolaunch: (() => Promise<boolean>) | null = null;
  private autolaunching = false;

  constructor(legacy?: EngineClient) {
    this.legacy = legacy ?? new EngineClient();
  }

  // ── スロット管理 ────────────────────────────────────────────────────
  private registerSlot(slot: Slot) {
    this.slots.set(slot.id, slot);
    for (const cb of this.connectListeners) slot.client.onConnect(cb);
  }

  addManaged(id: string, name: string, port: number, host = "127.0.0.1"): Slot {
    const client = new EngineClient(host, port);
    const slot: Slot = { id, name, kind: "managed", port, host, client, readOnly: false, readMethods: null, lastCallAt: Date.now(), createdAt: Date.now() };
    this.registerSlot(slot);
    return slot;
  }

  addAttached(id: string, port: number, readOnly: boolean, host = "127.0.0.1"): Slot {
    const client = new EngineClient(host, port, 4000, { backoffMs: [] });
    client.setLease(1500);
    const slot: Slot = { id, name: id, kind: "attached", port, host, client, readOnly, readMethods: null, lastCallAt: Date.now(), createdAt: Date.now() };
    this.registerSlot(slot);
    return slot;
  }

  removeSlot(id: string) {
    const s = this.slots.get(id);
    if (!s) return;
    s.client.close();
    this.slots.delete(id);
    if (this.bound === id) this.setBound(null);
  }

  get(id: string): Slot | undefined { return this.slots.get(id); }
  list(): Slot[] { return [...this.slots.values()]; }
  boundId(): string | null { return this.bound; }

  setBound(id: string | null) {
    if (id !== null && !this.slots.has(id)) return;
    if (this.bound === id) return;
    this.bound = id;
    for (const cb of this.switchListeners) { try { cb(id); } catch { /* 通知失敗は無視 */ } }
  }
  onSwitch(cb: (id: string | null) => void) { this.switchListeners.push(cb); }

  /** id / name / ポート(数値または "8862" / "port:8862")から探す。 */
  find(ref: string | number): Slot | undefined {
    const r = String(ref).trim();
    if (!r) return undefined;
    if (this.slots.has(r)) return this.slots.get(r);
    for (const s of this.slots.values()) if (s.name === r) return s;
    const m = /^(?:port:|x-)?(\d{2,5})$/.exec(r);
    if (m) { const p = Number(m[1]); for (const s of this.slots.values()) if (s.port === p) return s; }
    return undefined;
  }

  /** いま有効なスロット(呼び出し内の上書き → 束縛)。無ければ null(=従来のクライアント)。 */
  current(): Slot | null {
    const ov = this.als.getStore();
    if (ov) { const s = this.find(ov.engine); if (s) return s; }
    return this.bound ? (this.slots.get(this.bound) ?? null) : null;
  }

  /** dx12_call {engine} 用: fn の間だけ engine へ向ける。 */
  withEngine<T>(engineRef: string, fn: () => Promise<T>): Promise<T> {
    return this.als.run({ engine: engineRef }, fn);
  }
  overrideActive(): boolean { return !!this.als.getStore(); }

  // ── EngineClient と同じ公開面 ───────────────────────────────────────
  private target(): EngineClient { return this.current()?.client ?? this.legacy; }
  getPort(): number { return this.target().getPort(); }
  getHost(): string { return this.target().getHost(); }
  isConnected(): boolean { return this.target().isConnected(); }
  getConnectEpoch(): number { return this.target().getConnectEpoch(); }
  getLastConnectError(): string | null { return this.target().getLastConnectError(); }
  drainLateResults(): LateResult[] { return this.target().drainLateResults(); }
  getLateResults(): LateResult[] { return this.target().getLateResults(); }
  /** 束縛の有無に関わらず、従来のクライアント(ポート探索)。テスト・診断用。 */
  legacyClient(): EngineClient { return this.legacy; }

  onConnect(cb: (epoch: number, reconnect: boolean) => void) {
    this.connectListeners.push(cb);
    this.legacy.onConnect(cb);
    for (const s of this.slots.values()) s.client.onConnect(cb);
  }

  private isReadMethod(slot: Slot, method: string): boolean {
    if (slot.readMethods) return slot.readMethods.has(method);
    return READ_PREFIX.test(method);
  }

  async call(method: string, params: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }): Promise<any> {
    const slot = this.current();
    if (slot) {
      if (slot.readOnly && !this.isReadMethod(slot, method)) {
        throw fleetError("E_FLEET_READONLY", `エンジン ${slot.id}(port ${slot.port})は読み取り専用で繋いでいるため、'${method}' は送らない`, {
          method,
          errCause: "dx12_engine_attach の既定は読み取り専用(effect:\"read\" の method だけ通す)。他人のエンジンや手動起動のエンジンを書き換えないための制限",
          errFix: [
            { tool: "dx12_engine_launch", args: {}, why: "書き込みが必要なら、自分専用のエンジンを起動する(推奨)" },
            { tool: "dx12_engine_attach", args: { port: slot.port, readOnly: false, confirm: true }, why: "手動起動のエンジンを自分で使うと決めているなら、書き込み権つきで繋ぎ直す(ユーザーの承認を得てから)" },
          ],
          errDetails: { engine: slot.id, port: slot.port, method },
          retryable: false,
        });
      }
      if (!PASSIVE_METHODS.has(method)) slot.lastCallAt = Date.now();
      return slot.client.call(method, params, opts);
    }
    // 束縛なし: 従来どおり。DX12_FLEET_AUTOLAUNCH=1 のときだけ、繋がらなければ専用エンジンを起動して 1 回だけ撃ち直す。
    try {
      return await this.legacy.call(method, params, opts);
    } catch (e: any) {
      if (this.autolaunch && !this.autolaunching && e?.errName === "E_ENGINE_UNREACHABLE" && !this.overrideActive()) {
        this.autolaunching = true;
        try {
          if (await this.autolaunch()) return await this.call(method, params, opts);
        } finally { this.autolaunching = false; }
      }
      throw e;
    }
  }
}
