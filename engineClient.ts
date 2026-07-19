import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// エディタ(C++)の TCP ブリッジへ改行区切り JSON を送り、id で応答を相関させる薄いクライアント。
// 遅延接続＋切断時は次回呼び出しで再接続。単一接続で十分(engine は単一クライアントしか捌けない)。
//
// ★遅延同期について:
//   create/spawn/delete/duplicate/open_scene/new_scene/play/stop はエンジンが受信時に即答せず、
//   フレーム境界で実処理した後に【同じ id】で本物の result を返す。
//   こちら側は今まで通り id で待つだけ。{queued:true} はもう来ない＝本物の entityId 等が返る。
//   重い処理は時間がかかるので method 別にタイムアウトを伸ばす(下の TIMEOUT_BY_METHOD)。

// method 別タイムアウト(ms)。ここに無い method は DEFAULT_TIMEOUT_MS。
const TIMEOUT_BY_METHOD: Record<string, number> = {};
// 読み取り系 + 同期編集系 = 8000ms
for (const m of [
  // 読み取り
  "ping", "list_entities", "get_entity", "find_entity", "query_entities",
  "list_scenes", "list_assets", "get_mode", "get_log", "describe_components",
  "describe_lua_api", "get_scene_settings", "get_lua_component_state",
  "project_world_to_screen", "screenshot", "screenshot_game_view",
  // 同期編集
  "set_transform", "set_component", "remove_component", "set_parent",
  "rename_entity", "select_entity", "focus_camera", "set_pbr", "set_color", "set_lua_property",
  "set_scene_settings", "undo", "redo", "save_scene",
  "create_lua_component", "attach_lua_component",
  "create_shader", "read_shader", "set_mesh_shader",
  // 入力シミュレーション(即時)
  "key_down", "key_up", "key_press",
  // シーン編集(同期)
  "get_editor_camera", "set_editor_camera", "get_bounds", "look_at",
  "snap_to_ground", "get_hierarchy",
  // アセット操作(同期・軽量)
  "move_asset", "delete_asset",
]) TIMEOUT_BY_METHOD[m] = 8000;
// アセット操作(重め): probe は Assimp の読込、import はフォルダコピー、read_texture は変換。
TIMEOUT_BY_METHOD["asset_info"]   = 30000;
TIMEOUT_BY_METHOD["import_asset"] = 60000;
TIMEOUT_BY_METHOD["read_texture"] = 15000;
// step_frames は最大 600 フレーム(~10s)回ってから返るので長めに。
TIMEOUT_BY_METHOD["step_frames"] = 30000;
// 遅延同期(エンティティ生成/削除/複製) = 15000ms
for (const m of ["create_entity", "delete_entity", "duplicate_entity"]) TIMEOUT_BY_METHOD[m] = 15000;
// 遅延同期(モデル/プレハブ読込・シーン遷移、GPU/IO が重い) = 45000ms
for (const m of ["spawn_model", "spawn_prefab", "open_scene", "new_scene"]) TIMEOUT_BY_METHOD[m] = 45000;
// 遅延同期(再生切替、スナップショット復元あり) = 20000ms
for (const m of ["play", "stop"]) TIMEOUT_BY_METHOD[m] = 20000;

const DEFAULT_TIMEOUT_MS = 10000;

// ポート探索: DX12_MCP_PORT(env) → <os.tmpdir()>/dx12_mcp.port(エンジンが起動時に書く) → 既定 8787。
// どれも読めなくても落ちない。
function discoverPort(): number {
  const env = process.env.DX12_MCP_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  }
  try {
    const portFile = path.join(os.tmpdir(), "dx12_mcp.port");
    const txt = fs.readFileSync(portFile, "utf8").trim();
    const n = Number(txt);
    if (Number.isFinite(n) && n > 0 && n <= 65535) return n;
  } catch {
    // ファイル無し/読めない時は黙って既定へフォールバック。
  }
  return 8787;
}

export class EngineClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private host: string;
  private port: number;
  private explicitPort: boolean;   // 呼び出し側がポートを固定したか（test.ts 等）。固定時は再探索しない。
  private defaultTimeoutMs: number;

  // Node の型ストリップ実行はパラメータプロパティ非対応なので明示代入。
  // 引数省略時はポート自動探索。test.ts は (host, port, timeout) を明示指定してくる。
  constructor(host?: string, port?: number, timeoutMs?: number) {
    this.host = host ?? process.env.DX12_MCP_HOST ?? "127.0.0.1";
    this.explicitPort = port != null;
    this.port = port ?? discoverPort();
    this.defaultTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getPort(): number { return this.port; }
  getHost(): string { return this.host; }

  private failAll(e: Error) {
    this.sock = null;
    this.connecting = null;
    this.buf = "";   // 切断時の受信途中バッファは無効。残すと再接続後の最初の応答が連結で壊れる。
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
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
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p.resolve(msg); }
    }
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    // single-flight: 接続確立中の Promise を共有。並行 call が複数ソケットを張るのを防ぐ
    // (engine は単一クライアントしか捌けないため2本目以降がハングする)。
    if (this.connecting) return this.connecting;
    // 再接続のたびにポートを再探索する（固定指定が無い場合）。ビルド等で一時的に死にポートを
    // 掴んでも、エディタの正しいポートが %TEMP%/dx12_mcp.port に戻れば再起動なしで自己回復する。
    if (!this.explicitPort) this.port = discoverPort();
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setEncoding("utf8");
      s.on("data", (d: string) => this.onData(d));
      s.on("error", (e: Error) => this.failAll(e));
      s.on("close", () => this.failAll(new Error("engine connection closed")));
      s.once("connect", () => { this.sock = s; this.connecting = null; resolve(s); });
      s.once("error", (e: Error) => {
        this.connecting = null;
        reject(new Error(`エディタに繋がらへん (${this.host}:${this.port}) — エディタ起動してる? : ${e.message}`));
      });
    });
    return this.connecting;
  }

  // method を呼んで result を返す。engine が ok:false なら error を throw(error_code は .code に載せる)。
  // opts.timeout で method 別タイムアウトを上書きできる。
  async call(method: string, params: Record<string, unknown>, opts?: { timeout?: number }): Promise<any> {
    const s = await this.connect();
    const id = this.nextId++;
    const timeoutMs = opts?.timeout ?? TIMEOUT_BY_METHOD[method] ?? this.defaultTimeoutMs;
    const msg: any = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      s.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`engine timeout (${method}, ${timeoutMs}ms) — まだ処理中かもしれん。重い生成/読込は時間かかるで。`));
        }
      }, timeoutMs);
    });
    if (msg.ok === false) {
      // error_code をそのまま Error.code に載せて投げる(Node は型チェックせず実行するので any 経由で代入)。
      const err: any = new Error(msg.error || "engine error");
      if (msg.error_code != null) err.code = msg.error_code;
      throw err;
    }
    return msg.result ?? null;
  }
}
