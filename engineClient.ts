import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GUARDED_METHODS, idemCtx, isGuardApproved, subKeyFor, takesIdempotencyKey } from "./guardCtx.ts";

// エディタ(C++)の TCP ブリッジへ改行区切り JSON を送り、id で応答を相関させる薄いクライアント。
// 遅延接続＋切断時は次回呼び出しで再接続(接続失敗は 0.3/0.6/1.2 秒で再試行)。単一接続で十分(engine は単一クライアントしか捌けない)。
// M2: エラーは errName(E_*)/didYouMean/fix などの構造化フィールドを運ぶ。タイムアウト後に届いた応答は遅延結果ジャーナルへ。
//
// ★遅延同期について:
//   create/spawn/delete/duplicate/open_scene/new_scene/play/stop はエンジンが受信時に即答せず、
//   フレーム境界で実処理した後に【同じ id】で本物の result を返す。
//   こちら側は今まで通り id で待つだけ。{queued:true} はもう来ない＝本物の entityId 等が返る。
//   重い処理は時間がかかるので method 別にタイムアウトを伸ばす(下の TIMEOUT_BY_METHOD)。

// method 別タイムアウト(ms)。ここに無い method は DEFAULT_TIMEOUT_MS。
export const TIMEOUT_BY_METHOD: Record<string, number> = {};
// 読み取り系 + 同期編集系 = 8000ms
for (const m of [
  // 読み取り
  "ping", "list_entities", "get_entity", "find_entity", "query_entities",
  "list_scenes", "list_assets", "get_mode", "get_log", "describe_components",
  "describe_lua_api", "get_scene_settings", "get_lua_component_state",
  "project_world_to_screen", "screenshot_game_view", "perf_stats",
  // 同期編集
  "set_transform", "set_component", "remove_component", "set_parent",
  "rename_entity", "select_entity", "focus_camera", "set_pbr", "set_color", "set_lua_property",
  "set_scene_settings", "save_scene",
  "create_lua_component", "attach_lua_component",
  "create_shader", "read_shader", "set_mesh_shader",
  // 入力シミュレーション(即時)
  "key_down", "key_up", "key_press",
  // シーン編集(同期)
  "get_editor_camera", "set_editor_camera", "get_bounds", "look_at",
  "snap_to_ground", "get_hierarchy",
  // アセット操作(同期・軽量)
  "move_asset", "delete_asset",
  // 精密ピッキング / レイキャスト(同期・読み取り)
  "pick", "raycast_precise",
  // 地形・スカルプトの問い合わせ / 軽い編集(同期)
  "terrain_sample", "terrain_sculpt", "sculpt_brush",
  // 地形レイヤーの円ブラシ塗り(スプラットの一部だけ触るので軽い)
  "terrain_paint",
  // スプラットの要約読み取り(最大 2048^2 テクセルを 1 周するだけ)
  "terrain_splat_info",
  // 影(PCSS)の設定 get/set は即時
  "get_shadow_pcss", "set_shadow_pcss",
  // DXR の設定 get/set も即時(TLAS の再構築は次フレームの描画側で走る)
  "get_dxr", "set_dxr",
  // ライティング(同期)
  "list_lights", "set_sun", "apply_lighting_preset",
  // Git / GitHub(同期)。git のプロセス起動 1〜2 回ぶんで、どれも数百 ms 以内に返る。
  // ★push / pull はネットワークに出るので下で個別に長めのタイムアウトを張る。
  "git_status", "git_branches", "git_checkout", "git_merge", "git_merge_abort",
  "git_commit", "git_fetch",
]) TIMEOUT_BY_METHOD[m] = 8000;
// 地形の一発生成 / 浸食は解像度 512 だと数十万セルを何周もするので長め。
TIMEOUT_BY_METHOD["terrain_generate"] = 30000;
TIMEOUT_BY_METHOD["terrain_erode"]    = 60000;
// autopaint は解像度 512 のスプラット全面を高さ/傾斜から焼き直す(terrain_generate と同じ桁)。
TIMEOUT_BY_METHOD["terrain_autopaint"] = 30000;
// レイヤー割当は .terrainlayers のパース + スプラット新規作成 + autopaint まで走ることがある。
TIMEOUT_BY_METHOD["terrain_set_layers"] = 30000;
// render_debug は最大 120 フレーム描いてからスクショを撮る遅延応答(重い可視化だと 1 フレームが伸びる)。
TIMEOUT_BY_METHOD["render_debug"] = 60000;
// push / pull / fetch はネットワーク越し。認証待ちや大きめの転送で数十秒かかることがある。
TIMEOUT_BY_METHOD["git_push"]  = 120000;
TIMEOUT_BY_METHOD["git_pull"]  = 120000;
TIMEOUT_BY_METHOD["git_fetch"] = 120000;
// ★screenshot / screenshot_final は【遅延同期】。
//   - screenshot_final は素で 1 フレーム待つ(ImGui を描く前にバックバッファをコピーする)。
//   - deterministic:true だと履歴を捨ててから settleFrames(最大 240)ぶん回してから撮る。
//     240 フレームは重いシーンだと数十秒かかるので、render_debug(最大 120 フレームで 60s)と
//     同じ桁を確保する。ここを 8000ms のままにすると settleFrames を上げた瞬間に
//     「エンジンは撮り続けているのに TS 側だけタイムアウト」になる。
TIMEOUT_BY_METHOD["screenshot"]       = 60000;
TIMEOUT_BY_METHOD["screenshot_final"] = 60000;
// 仮想入力モード(imgui_pointer / imgui_key / imgui_screenshot)は遅延応答。積んだ入力が全部フレームに流れ切って
// ImGui が反応してから返る。drag は steps(最大 600)フレームかけるので、重いエディタ(10fps)でも待てる桁を取る。
TIMEOUT_BY_METHOD["imgui_pointer"]    = 90000;
TIMEOUT_BY_METHOD["imgui_key"]        = 30000;
TIMEOUT_BY_METHOD["imgui_screenshot"] = 30000;
TIMEOUT_BY_METHOD["imgui_virtual_input"] = 8000;
TIMEOUT_BY_METHOD["imgui_find"]       = 8000;
// 遅延同期(地形/スカルプトの生成。CPU メッシュ生成 + GPU アップロードをフレーム境界で行う)。
for (const m of ["terrain_create", "sculpt_create", "sculpt_make_editable"])
  TIMEOUT_BY_METHOD[m] = 45000;
// 診断は textures/models を外しても数秒、全部やると assets 全走査で数十秒〜。
TIMEOUT_BY_METHOD["diagnose"] = 180000;
// アセット操作(重め): probe は Assimp の読込、import はフォルダコピー、read_texture は変換。
TIMEOUT_BY_METHOD["asset_info"]   = 30000;
TIMEOUT_BY_METHOD["import_asset"] = 60000;
TIMEOUT_BY_METHOD["read_texture"] = 15000;
// step_frames は最大 600 フレーム(~10s)回ってから返るので長めに。
TIMEOUT_BY_METHOD["step_frames"] = 30000;
// 知覚層: 指定視点へ切り替え → 決定論で settleFrames(最大 240)落ち着かせる → ID パスの読み戻しと集計。
// 普段 0.1〜0.4 秒だが、settleFrames を大きくしたときと重いシーンのために長めに取る。
TIMEOUT_BY_METHOD["perceive"] = 30000;
// Undo / Redo / トランザクションの確定・巻き戻しは遅延応答。巻き戻しは消した物のモデルを読み直す(guid ごと復元)ので、
// 生成系(spawn_model = 45000)と同じ桁を取る。
for (const m of ["undo", "redo", "transaction_commit", "transaction_rollback"]) TIMEOUT_BY_METHOD[m] = 45000;
// 遅延同期(エンティティ生成/削除/複製) = 15000ms
for (const m of ["create_entity", "delete_entity", "duplicate_entity"]) TIMEOUT_BY_METHOD[m] = 15000;
// 遅延同期(モデル/プレハブ読込・シーン遷移、GPU/IO が重い) = 45000ms
for (const m of ["spawn_model", "spawn_prefab", "open_scene", "new_scene"]) TIMEOUT_BY_METHOD[m] = 45000;
// 遅延同期(再生切替、スナップショット復元あり) = 20000ms
for (const m of ["play", "stop"]) TIMEOUT_BY_METHOD[m] = 20000;

export const DEFAULT_TIMEOUT_MS = 10000;

/** method の実効タイムアウト(ms)。opts.timeout > 表 > 既定。マニフェストの timeoutMs は呼び出し側が opts.timeout に載せる。 */
export function methodTimeoutMs(method: string, fallback: number = DEFAULT_TIMEOUT_MS): number {
  return TIMEOUT_BY_METHOD[method] ?? fallback;
}

// ポート探索: DX12_MCP_PORT(env) → <os.tmpdir()>/dx12_mcp.port(エンジンが起動時に書く) → 既定 8787。
// どれも読めなくても落ちない。
export function portFilePath(): string {
  // DX12_MCP_PORT_FILE で場所を差し替えられる(テスト用。実エンジンのポートファイルを触らないため)。
  return process.env.DX12_MCP_PORT_FILE || path.join(os.tmpdir(), "dx12_mcp.port");
}

export function discoverPort(): number {
  const env = process.env.DX12_MCP_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  try {
    const txt = fs.readFileSync(portFilePath(), "utf8").trim();
    const n = Number(txt);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  } catch {
    // ファイル無し/読めない時は黙って既定へフォールバック。
  }
  return 8787;
}

/** connect だけ試す(ping は送らない。単一クライアントのエンジンを邪魔しない)。dx12_doctor の診断用。 */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<"open" | "refused" | "timeout" | "error"> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (r: "open" | "refused" | "timeout" | "error") => { s.destroy(); resolve(r); };
    const t = setTimeout(() => done("timeout"), timeoutMs);
    s.once("connect", () => { clearTimeout(t); done("open"); });
    s.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); done(e.code === "ECONNREFUSED" ? "refused" : "error"); });
  });
}

/** 接続が失敗した時に順に待つ時間(ms)。エンジンの再起動直後の窓を埋める短い再試行。 */
const CONNECT_BACKOFF_MS = [300, 600, 1200];

/** call() が投げるエラー。旧来の code/hint/valid_values に加えて構造化エラー用のフィールドを運ぶ。 */
export type EngineCallError = Error & {
  /** 旧来の数値 error_code(エンジンが付けたもの)。TS が作ったエラー(接続/タイムアウト)には無い。 */
  code?: number;
  hint?: string;
  valid_values?: string[];
  /** 文字列コード(E_*)。エンジンが error_name を付けた場合、または TS が作ったエラーで必ず付く。 */
  errName?: string;
  errCause?: string;
  didYouMean?: string[];
  errFix?: { tool?: string; args?: Record<string, unknown>; why?: string }[];
  errDetails?: Record<string, unknown>;
  retryable?: boolean;
  method?: string;
  elapsedMs?: number;
};

/** タイムアウト後に届いた応答(遅延結果ジャーナル)。 */
export type LateResult = {
  id: number; method: string; at: number; elapsedMs: number; ok: boolean;
  result?: unknown; error?: string; errorCode?: number; seen: boolean;
};

export class EngineClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // タイムアウトで諦めた要求(id → 情報)。あとで応答が届いたら遅延結果として残す。
  private abandoned = new Map<number, { method: string; startedAt: number }>();
  private lateJournal: LateResult[] = [];
  private host: string;
  private port: number;
  private explicitPort: boolean;   // 呼び出し側がポートを固定したか（test.ts 等）。固定時は再探索しない。
  private defaultTimeoutMs: number;
  private backoff: number[];
  private connectEpoch = 0;        // 接続が確立するたびに +1(再接続の検知用)
  private lastConnectError: string | null = null;
  private connectListeners: ((epoch: number, reconnect: boolean) => void)[] = [];
  // 貸し出し接続(フリートの attach): 最後の応答から leaseMs で切断し、次の呼び出しで繋ぎ直す。
  // エンジンのブリッジは単一クライアントなので、見るだけの接続が枠を塞がないようにする。0 なら従来どおり保持し続ける。
  private leaseMs = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  // Node の型ストリップ実行はパラメータプロパティ非対応なので明示代入。
  // 引数省略時はポート自動探索。test.ts は (host, port, timeout) を明示指定してくる。
  constructor(host?: string, port?: number, timeoutMs?: number, opts?: { backoffMs?: number[] }) {
    this.host = host ?? process.env.DX12_MCP_HOST ?? "127.0.0.1";
    this.explicitPort = port != null;
    this.port = port ?? discoverPort();
    this.defaultTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // DX12_MCP_CONNECT_BACKOFF_MS="0"(または "100,200")で再試行の間隔を変えられる(テスト用)。
    const envBackoff = process.env.DX12_MCP_CONNECT_BACKOFF_MS;
    this.backoff = opts?.backoffMs ?? (envBackoff !== undefined
      ? envBackoff.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : CONNECT_BACKOFF_MS);
  }

  /** 貸し出し接続にする(ms > 0)。最後の応答から ms で切断し、次の呼び出しで再接続する(再接続は「再起動」として通知しない)。 */
  setLease(ms: number) { this.leaseMs = Math.max(0, ms); }
  /** ソケットを閉じる(待機中の呼び出しは切断エラーで終わる)。次の call() でまた繋ぐ。 */
  close() {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    const s = this.sock;
    if (s && !s.destroyed) s.destroy();
  }
  private scheduleRelease() {
    if (this.leaseMs <= 0) return;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.pending.size === 0 && this.sock && !this.sock.destroyed) this.sock.destroy();
    }, this.leaseMs);
    this.releaseTimer.unref?.();
  }

  getPort(): number { return this.port; }
  getHost(): string { return this.host; }
  isConnected(): boolean { return !!this.sock && !this.sock.destroyed; }
  getConnectEpoch(): number { return this.connectEpoch; }
  getLastConnectError(): string | null { return this.lastConnectError; }
  /** 接続が確立するたびに呼ばれる。reconnect=true は 2 回目以降(エンジン再起動や切断からの復帰)。 */
  onConnect(cb: (epoch: number, reconnect: boolean) => void) { this.connectListeners.push(cb); }

  /** タイムアウト後に届いた応答のうち、まだ見せていないもの(見せたら seen になる)。 */
  drainLateResults(): LateResult[] {
    const out = this.lateJournal.filter((l) => !l.seen);
    for (const l of out) l.seen = true;
    return out;
  }
  getLateResults(): LateResult[] { return [...this.lateJournal]; }

  private failAll(e: Error) {
    this.sock = null;
    this.connecting = null;
    this.buf = "";   // 切断時の受信途中バッファは無効。残すと再接続後の最初の応答が連結で壊れる。
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.abandoned.clear();   // 切断したので遅延応答はもう来ない
  }

  private disconnectError(msg: string): EngineCallError {
    const err: EngineCallError = new Error(msg);
    err.errName = "E_ENGINE_UNREACHABLE";
    err.retryable = true;
    err.hint = "エンジンとの接続が切れた(エンジンが終了した/再起動した可能性)。dx12_doctor で状態を診断できる。次の呼び出しで自動的に再接続する";
    err.errDetails = { host: this.host, port: this.port, disconnected: true };
    return err;
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      // 進捗の中間行({"id":N,"progress":{...}}, ok 無し)は最終応答ではないので待ちを解かない(M6 の先取り)。
      if (msg.progress !== undefined && msg.ok === undefined) continue;
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.resolve(msg); continue; }
      const late = this.abandoned.get(msg.id);
      if (late) {
        this.abandoned.delete(msg.id);
        this.lateJournal.push({
          id: msg.id, method: late.method, at: Date.now(), elapsedMs: Date.now() - late.startedAt,
          ok: msg.ok !== false, result: msg.ok === false ? undefined : (msg.result ?? null),
          error: msg.ok === false ? String(msg.error ?? "") : undefined,
          errorCode: msg.ok === false ? msg.error_code : undefined, seen: false,
        });
        if (this.lateJournal.length > 50) this.lateJournal.shift();
      }
    }
  }

  private connectOnce(): Promise<net.Socket> {
    // 再接続のたびにポートを再探索する（固定指定が無い場合）。ビルド等で一時的に死にポートを
    // 掴んでも、エディタの正しいポートが %TEMP%/dx12_mcp.port に戻れば再起動なしで自己回復する。
    if (!this.explicitPort) this.port = discoverPort();
    return new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setEncoding("utf8");
      // 接続確立前のエラーは再試行ループへ返すだけ(failAll で connecting を落とすと並行 call が二重に接続を張る)。
      s.once("error", (e: Error) => reject(e));
      s.once("connect", () => {
        s.removeAllListeners("error");
        s.on("data", (d: string) => this.onData(d));
        s.on("error", (e: Error) => this.failAll(this.disconnectError(e.message)));
        s.on("close", () => this.failAll(this.disconnectError("engine connection closed")));
        this.sock = s;
        resolve(s);
      });
    });
  }

  private connect(retry = true): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    // single-flight: 接続確立中の Promise を共有。並行 call が複数ソケットを張るのを防ぐ
    // (engine は単一クライアントしか捌けないため2本目以降がハングする)。
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let lastErr: any;
      const attempts = retry ? this.backoff.length : 0;
      for (let attempt = 0; attempt <= attempts; attempt++) {
        try {
          const s = await this.connectOnce();
          const reconnect = this.connectEpoch > 0 && this.leaseMs <= 0;
          this.connectEpoch++;
          this.lastConnectError = null;
          this.connecting = null;
          for (const cb of this.connectListeners) { try { cb(this.connectEpoch, reconnect); } catch { /* 通知失敗で接続を落とさない */ } }
          return s;
        } catch (e: any) {
          lastErr = e;
          if (attempt < attempts) await new Promise((r) => setTimeout(r, this.backoff[attempt]));
        }
      }
      this.connecting = null;
      this.lastConnectError = String(lastErr?.message ?? lastErr);
      const err: EngineCallError = new Error(
        `エディタに繋がりません (${this.host}:${this.port}) — エディタは起動していますか? : ${lastErr?.message ?? lastErr}`);
      err.errName = "E_ENGINE_UNREACHABLE";
      err.retryable = true;
      err.hint = "dx12_doctor で原因を診断できる(ポート・プロセス・ログを調べて起動手順を返す)";
      err.errDetails = { host: this.host, port: this.port, portFile: portFilePath(), connectError: String(lastErr?.code ?? lastErr?.message ?? lastErr) };
      throw err;
    })();
    return this.connecting;
  }

  // method を呼んで result を返す。engine が ok:false なら error を throw(error_code は .code に載せる)。
  // opts.timeout で method 別タイムアウトを上書きできる。
  // opts.retry:false は接続失敗時の再試行(0.3/0.6/1.2 秒)を省く(診断用。すぐ結果が欲しいとき)。
  /**
   * method を呼んで result を返す(公開の入口)。M5 の 2 つの仕掛けをここに置く:
   *  ・冪等キー: dx12_call {idempotency_key} の文脈(idemCtx)の中で write 系を撃つときは、サブキーを付ける(再送しても二重実行しない)
   *  ・guarded ゲート: 承認済みの文脈(guardApproval)で guarded な method を撃つときは、エンジンから 1 回限りの確認トークンを取って confirm_token を付ける
   *    (エンジン側の最終ゲート。承認されていない呼び出し = dx12_batch の op など は、トークンが無いのでエンジンが拒否する)
   */
  async call(method: string, params: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }): Promise<any> {
    let p = params ?? {};
    const idem = idemCtx.getStore();
    if (idem && takesIdempotencyKey(method) && p.idempotency_key === undefined && p.idempotencyKey === undefined) p = { ...p, idempotency_key: subKeyFor(idem, method, p) };
    const approved = isGuardApproved();
    if (approved && GUARDED_METHODS.has(method) && p.confirm_token === undefined) p = await this.withToken(method, p);
    try {
      return await this.callRaw(method, p, opts);
    } catch (e: any) {
      // 一覧に無い guarded な method(エンジンに後から増えたもの)は、承認済みのときだけ、拒否された理由がトークン不足なら 1 回だけ取り直して再送する。
      if (approved && e?.errName === "E_GUARDED" && e?.errDetails?.gate === "engine" && p.confirm_token === undefined && method !== "guard_token") {
        return this.callRaw(method, await this.withToken(method, p), opts);
      }
      throw e;
    }
  }

  private async withToken(method: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const r = await this.callRaw("guard_token", { method }, { timeout: 8000 });
      return typeof r?.token === "string" ? { ...p, confirm_token: r.token } : p;
    } catch (e: any) {
      // guard_token を持たない古いエンジン(M5 より前)はゲートも無い。トークン無しでそのまま撃つ。
      if (e?.errName === "E_UNKNOWN_TOOL" || e?.code === 8) return p;
      throw e;
    }
  }

  private async callRaw(method: string, params: Record<string, unknown>, opts?: { timeout?: number; retry?: boolean }): Promise<any> {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    const s = await this.connect(opts?.retry !== false);
    const id = this.nextId++;
    const timeoutMs = opts?.timeout ?? TIMEOUT_BY_METHOD[method] ?? this.defaultTimeoutMs;
    const startedAt = Date.now();
    const msg: any = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      s.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          // エンジンは処理を続けている可能性がある。遅れて届いた応答を捨てずに遅延結果として残す。
          this.abandoned.set(id, { method, startedAt });
          const err: EngineCallError = new Error(
            `engine timeout (${method}, ${timeoutMs}ms) — エンジンがまだ処理中の可能性がある。重い生成/読込は時間がかかる。`);
          err.errName = "E_ENGINE_TIMEOUT";
          err.retryable = true;
          err.method = method;
          err.elapsedMs = Date.now() - startedAt;
          err.hint = "エンジンがまだ処理中の可能性がある。撃ち直す前に dx12_ping で応答を確認し、"
            + "生成/削除系は dx12_list_entities で結果を確かめること。遅れて届いた結果は次の dx12_call の meta.lateResults に出る";
          err.errDetails = { method, timeoutMs, elapsedMs: err.elapsedMs, host: this.host, port: this.port };
          reject(err);
        }
      }, timeoutMs);
    });
    this.scheduleRelease();
    if (msg.ok === false) {
      // error_code をそのまま Error.code に載せて投げる(Node は型チェックせず実行するので any 経由で代入)。
      // error_hint / error_values(エンジンが「次の一手」と有効値を添えてきた場合)も運ぶ。
      const err: EngineCallError = new Error(msg.error || "engine error");
      if (msg.error_code != null) err.code = msg.error_code;
      if (msg.error_hint) err.hint = msg.error_hint;
      if (Array.isArray(msg.error_values)) err.valid_values = msg.error_values;
      // M2: 構造化フィールド(エンジンが付けたときだけ。旧エンジンには無い)
      if (typeof msg.error_name === "string") err.errName = msg.error_name;
      if (typeof msg.error_cause === "string") err.errCause = msg.error_cause;
      if (Array.isArray(msg.error_did_you_mean)) err.didYouMean = msg.error_did_you_mean;
      if (Array.isArray(msg.error_fix)) err.errFix = msg.error_fix;
      if (msg.error_details && typeof msg.error_details === "object") err.errDetails = msg.error_details;
      err.method = method;
      throw err;
    }
    return msg.result ?? null;
  }
}
