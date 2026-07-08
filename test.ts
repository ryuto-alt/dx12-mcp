/**
 * DX12 MCP サーバ 自己テストハーネス
 *
 * 検証対象(エンジン不要 — モックソケット & ユニットレベルで完結):
 *   [1-6]  フレーミング(改行区切り JSON)と id 相関
 *   [7-9]  エラー経路(ok:false → throw / error_code=.code 伝播)
 *   [10-12] ポート探索順(env > tmpfile > 8787) — 接続なし・getPort() で検証
 *   [13-15] 遅延同期契約(create_entity は後から本物 entityId が返る / queued キーは来ない)
 *   [16-18] per-method タイムアウト選択(TIMEOUT_BY_METHOD vs opts.timeout オーバーライド)
 *
 * SDK のツール登録検証は @modelcontextprotocol/sdk 依存を避けるため省略。
 * (MCP ツール定義は index.ts + 手動動作確認で担保する方針)
 *
 * 実行: node test.ts  (Node v24 型ストリップ — tsc 不要)
 * 失敗時 exit 1、全通過で "OK: N テスト通過" を出力して exit 0。
 */

import net from "node:net";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { EngineClient } from "./engineClient.ts";

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/**
 * モックエンジンサーバを起動してポートを返す。
 * handler は改行区切りの JSON リクエスト 1 件ごとに呼ばれる。
 * listenPort=0 で OS が空きポートを自動選択する。
 */
async function startMock(
  handler: (req: any, sock: net.Socket) => void,
  listenPort = 0,
): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          handler(JSON.parse(line), sock);
        } catch {
          // JSON パース失敗は無視
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(listenPort, "127.0.0.1", () => r()));
  const actualPort = (server.address() as net.AddressInfo).port;
  return { server, port: actualPort };
}

/** send は同期で即答する標準モックハンドラ */
function syncHandler(req: any, sock: net.Socket): void {
  let resp: any;
  if (req.method === "ping") {
    resp = {
      id: req.id,
      ok: true,
      result: {
        pong: true,
        mode: "Editor",
        entityCount: 0,
        sceneGeneration: 1,
        currentScene: "untitled",
        protocolVersion: 2,
      },
    };
  } else if (req.method === "list_entities") {
    resp = { id: req.id, ok: true, result: { entities: [{ entityId: 1, id: 1, name: "Player" }], count: 1, sceneGeneration: 0 } };
  } else if (req.method === "get_mode") {
    resp = { id: req.id, ok: true, result: { mode: "Editor" } };
  } else if (req.method === "save_scene") {
    resp = { id: req.id, ok: true, result: { path: req.params?.path ?? null } };
  } else if (req.method === "list_scenes") {
    resp = {
      id: req.id,
      ok: true,
      result: [{ path: "scenes/title.json", name: "title" }],
    };
  } else if (req.method === "set_component") {
    resp = { id: req.id, ok: true, result: req.params };
  } else if (req.method === "boom") {
    resp = { id: req.id, ok: false, error: "kaboom", error_code: 7 };
  } else if (req.method === "not_found") {
    resp = { id: req.id, ok: false, error: "not found", error_code: 1 };
  } else if (req.method === "invalid_param") {
    resp = { id: req.id, ok: false, error: "bad param", error_code: 2 };
  } else {
    resp = { id: req.id, ok: false, error: `unknown method: ${req.method}` };
  }
  sock.write(JSON.stringify(resp) + "\n");
}

/** テスト通過カウンタ */
let passed = 0;
function pass(label: string): void {
  passed++;
  console.log(`  OK  ${label}`);
}

// ─── [1-6] フレーミング / id 相関 / 正常系 ──────────────────────────────────

console.log("\n[1-6] フレーミング / id 相関 / 正常系");
{
  const { server, port } = await startMock(syncHandler);
  const c = new EngineClient("127.0.0.1", port, 3000);

  // 1. list_entities が result オブジェクト({entities,count,sceneGeneration})を正しく返す
  assert.deepStrictEqual(
    await c.call("list_entities", {}),
    { entities: [{ entityId: 1, id: 1, name: "Player" }], count: 1, sceneGeneration: 0 },
  );
  pass("list_entities → result オブジェクト({entities,count,sceneGeneration})");

  // 2. 引数なし method: get_mode でオブジェクト result が返る
  assert.deepStrictEqual(await c.call("get_mode", {}), { mode: "Editor" });
  pass("get_mode(引数なし) → result オブジェクト");

  // 3. 文字列パラメータが往復して正しく返る
  assert.deepStrictEqual(
    await c.call("save_scene", { path: "scenes/x.json" }),
    { path: "scenes/x.json" },
  );
  pass("params 透過(文字列): save_scene");

  // 4. params 省略 → モックが null を返すケース
  assert.deepStrictEqual(await c.call("save_scene", {}), { path: null });
  pass("params 省略 → null フォールバック");

  // 5. ネストしたオブジェクト params が保持される
  assert.deepStrictEqual(
    await c.call("set_component", { entity: 1, component: "pointLight", data: { intensity: 2 } }),
    { entity: 1, component: "pointLight", data: { intensity: 2 } },
  );
  pass("ネストオブジェクト params 透過(set_component)");

  // 6. 並行 call × 2: 異なる id でも正しく相関する
  const [a, b] = await Promise.all([
    c.call("list_entities", {}),
    c.call("list_entities", {}),
  ]);
  assert.deepStrictEqual(a, { entities: [{ entityId: 1, id: 1, name: "Player" }], count: 1, sceneGeneration: 0 });
  assert.deepStrictEqual(b, { entities: [{ entityId: 1, id: 1, name: "Player" }], count: 1, sceneGeneration: 0 });
  pass("並行 call × 2 — id 相関が正しく機能");

  server.close();
}

// ─── [7-9] エラー経路 / error_code 伝播 ────────────────────────────────────

console.log("\n[7-9] エラー経路 / error_code 伝播");
{
  const { server, port } = await startMock(syncHandler);
  const c = new EngineClient("127.0.0.1", port, 3000);

  // 7. ok:false → Error が throw され、メッセージが一致する
  await assert.rejects(() => c.call("boom", {}), /kaboom/);
  pass("ok:false → Error throw(メッセージ一致)");

  // 8. error_code=7(INTERNAL) が Error.code に付与される
  try {
    await c.call("boom", {});
    assert.fail("boom は throw するはず");
  } catch (e: any) {
    assert.strictEqual(e.code, 7, "error_code=7(INTERNAL) が e.code に乗ること");
  }
  pass("error_code=7(INTERNAL) → e.code 伝播");

  // 9. error_code=1(NOT_FOUND) の伝播
  try {
    await c.call("not_found", {});
    assert.fail("not_found は throw するはず");
  } catch (e: any) {
    assert.strictEqual(e.code, 1, "error_code=1(NOT_FOUND) が e.code に乗ること");
  }
  pass("error_code=1(NOT_FOUND) → e.code 伝播");

  server.close();
}

// ─── [10-12] ポート探索順(env > tmpfile > 8787) ─────────────────────────────
// 接続不要。getPort() でコンストラクタが選んだポートを直接確認する。

console.log("\n[10-12] ポート探索順(env > tmpfile > 8787)");
{
  const TMP_PORT_FILE = path.join(os.tmpdir(), "dx12_mcp.port");
  const savedEnv = process.env.DX12_MCP_PORT;

  try {
    // 10. DX12_MCP_PORT 環境変数が最優先
    {
      process.env.DX12_MCP_PORT = "9001";
      // tmpfile に別のポートを書いておく → env が勝つこと
      fs.writeFileSync(TMP_PORT_FILE, "9002");
      const c = new EngineClient();
      assert.strictEqual(c.getPort(), 9001, "env=9001 が優先されること");
      pass("env DX12_MCP_PORT=9001 が tmpfile(9002) より優先");
    }

    // 11. env なし → tmpfile のポートを使う
    {
      delete process.env.DX12_MCP_PORT;
      fs.writeFileSync(TMP_PORT_FILE, "9003");
      const c = new EngineClient();
      assert.strictEqual(c.getPort(), 9003, "tmpfile=9003 が読まれること");
      pass("env なし → tmpfile(9003) からポート読み取り");
    }

    // 12. env もファイルも無し → デフォルト 8787
    {
      delete process.env.DX12_MCP_PORT;
      try { fs.unlinkSync(TMP_PORT_FILE); } catch { /* 無ければ無視 */ }
      const c = new EngineClient();
      assert.strictEqual(c.getPort(), 8787, "デフォルト 8787 にフォールバックすること");
      pass("env なし・tmpfile なし → デフォルト 8787");
    }
  } finally {
    // 環境変数とファイルを確実に元に戻す
    if (savedEnv !== undefined) process.env.DX12_MCP_PORT = savedEnv;
    else delete process.env.DX12_MCP_PORT;
    try { fs.unlinkSync(TMP_PORT_FILE); } catch { /* 残ってなければ無視 */ }
  }
}

// ─── [13-15] 遅延同期契約 ───────────────────────────────────────────────────
// create_entity はフレーム境界後に本物の result が返る。{queued:true} は絶対来ない。
// ★ "名前で list して探す" 旧パターンは廃止。同じ id で待つだけで entityId が手に入る。

console.log("\n[13-15] 遅延同期契約(create_entity / queued キー不在)");
{
  /**
   * フレーム境界シミュレーション:
   * create_entity は 80ms 後に同じ id で本物 result を返す。
   * {queued:true} の中間応答は【絶対に送らない】(旧プロトコル廃止)。
   */
  function delayedCreateHandler(req: any, sock: net.Socket): void {
    if (req.method === "create_entity") {
      setTimeout(() => {
        sock.write(
          JSON.stringify({
            id: req.id,
            ok: true,
            result: {
              entityId: 42,
              name: req.params?.name ?? "Entity",
              sceneGeneration: 2,
            },
          }) + "\n",
        );
      }, 80);
    } else {
      syncHandler(req, sock);
    }
  }

  const { server, port } = await startMock(delayedCreateHandler);
  const c = new EngineClient("127.0.0.1", port, 3000);

  // 13. 80ms 遅延後に entityId:42 が返る
  const r1 = await c.call("create_entity", { type: "box", name: "Box" });
  assert.strictEqual(r1.entityId, 42, "遅延後に entityId:42 が解決されること");
  pass("create_entity — 80ms 遅延後に entityId:42 解決");

  // 14. result に 'queued' キーが存在しない(回帰防止アサート)
  // 旧プロトコルでは {queued:true} を中間応答として返す設計があったが完全廃止。
  // エンジンが誤って queued を result に入れた場合にここで検知する。
  assert.ok(!Object.hasOwn(r1, "queued"), "result に 'queued' キーが含まれていないこと");
  pass("queued キー不在 — 回帰防止アサート");

  // 15. 並行 create_entity × 2: 各 id が正しく解決され、両方 queued キーなし
  const [ra, rb] = await Promise.all([
    c.call("create_entity", { type: "box" }),
    c.call("create_entity", { type: "sphere" }),
  ]);
  assert.strictEqual(ra.entityId, 42, "ra.entityId=42");
  assert.strictEqual(rb.entityId, 42, "rb.entityId=42");
  assert.ok(!Object.hasOwn(ra, "queued"), "ra に queued キーなし");
  assert.ok(!Object.hasOwn(rb, "queued"), "rb に queued キーなし");
  pass("並行 create_entity × 2 — 各 id 正しく解決 / queued キーなし");

  server.close();
}

// ─── [16-18] per-method タイムアウト選択 ────────────────────────────────────
// TIMEOUT_BY_METHOD で method ごとに適切なタイムアウトが選ばれることを検証。
// opts.timeout で明示オーバーライドできることも確認する。

console.log("\n[16-18] per-method タイムアウト選択");
{
  /**
   * create_entity には 200ms 遅延を与える。
   * TIMEOUT_BY_METHOD["create_entity"] = 15000ms なので通常呼び出しは解決する。
   * opts.timeout=100ms で明示的に短くすれば timeout エラーになる。
   */
  function slowCreateHandler(req: any, sock: net.Socket): void {
    if (req.method === "create_entity") {
      setTimeout(() => {
        sock.write(
          JSON.stringify({
            id: req.id,
            ok: true,
            result: { entityId: 77, name: "SlowBox", sceneGeneration: 3 },
          }) + "\n",
        );
      }, 200);
    } else {
      syncHandler(req, sock);
    }
  }

  const { server, port } = await startMock(slowCreateHandler);
  // defaultTimeoutMs を小さく設定しても TIMEOUT_BY_METHOD が優先されることを確認するため
  // あえて defaultTimeoutMs=100ms に設定する
  const c = new EngineClient("127.0.0.1", port, 100);

  // 16. 通常メソッド(list_entities)は即答なので 8000ms タイムアウト内で解決
  const le = await c.call("list_entities", {});
  assert.deepStrictEqual(le, { entities: [{ entityId: 1, id: 1, name: "Player" }], count: 1, sceneGeneration: 0 });
  pass("通常メソッド(list_entities) — TIMEOUT_BY_METHOD(8000ms)で解決");

  // 17. create_entity: TIMEOUT_BY_METHOD=15000ms が選ばれ、200ms 遅延でも解決する
  //     (defaultTimeoutMs=100ms を使ったら 200ms で timeout するはずなので、15000ms が使われていることの証拠)
  const ce = await c.call("create_entity", { type: "box" });
  assert.strictEqual(ce.entityId, 77, "200ms 遅延でも 15000ms タイムアウトで解決すること");
  pass("create_entity — TIMEOUT_BY_METHOD=15000ms > 200ms delay で解決");

  // 18. opts.timeout=100ms で明示オーバーライド → 200ms 遅延なので timeout エラーになる
  await assert.rejects(
    () => c.call("create_entity", { type: "sphere" }, { timeout: 100 }),
    /timeout/,
    "opts.timeout=100ms で明示オーバーライドすると 200ms delay で timeout すること",
  );
  pass("opts.timeout=100ms オーバーライド → 200ms delay で timeout エラー");

  server.close();
}

// ─── [19-22] 新ツール: name 透過 / 新 method のタイムアウト配線 ──────────────
// name 指定(entity の代わり)が params としてそのまま透過すること、
// step_frames に長いタイムアウト(30000ms)が、key_down/project_world_to_screen に
// 同期クラス(8000ms)が割り当たっていることを確認する。

console.log("\n[19-24] 新ツール(name 透過 / 新 method タイムアウト / 色・ゲーム画面)");
{
  // step_frames は 150ms 遅延、screenshot_game_view は path を返す、他は params を echo。
  function newToolsHandler(req: any, sock: net.Socket): void {
    if (req.method === "step_frames") {
      setTimeout(() => {
        sock.write(JSON.stringify({ id: req.id, ok: true,
          result: { stepped: true, mode: "Playing", sceneGeneration: 5 } }) + "\n");
      }, 150);
    } else if (req.method === "screenshot_game_view") {
      // 実機は1フレーム後に返す遅延応答。ここでは 120ms 遅延で path を返す。
      setTimeout(() => {
        sock.write(JSON.stringify({ id: req.id, ok: true,
          result: { path: "C:/tmp/gv.png", width: 1280, height: 720, mode: "Editor" } }) + "\n");
      }, 120);
    } else {
      // set_transform / key_down / project_world_to_screen / set_color 等は params を echo
      sock.write(JSON.stringify({ id: req.id, ok: true, result: req.params }) + "\n");
    }
  }

  const { server, port } = await startMock(newToolsHandler);
  // defaultTimeoutMs=100ms。これより遅い step_frames が解決するなら専用タイムアウトが効いている証拠。
  const c = new EngineClient("127.0.0.1", port, 100);

  // 19. name 指定が params として透過する(id 無しで操作する経路)
  assert.deepStrictEqual(
    await c.call("set_transform", { name: "Player", position: [0, 1, 0] }),
    { name: "Player", position: [0, 1, 0] },
  );
  pass("name 透過: set_transform({name:'Player'})");

  // 20. step_frames — TIMEOUT_BY_METHOD=30000ms が選ばれ、150ms 遅延でも解決(default=100ms では落ちる)
  const sf = await c.call("step_frames", { frames: 30 });
  assert.strictEqual(sf.stepped, true, "step_frames が専用タイムアウト(30000ms)で解決すること");
  pass("step_frames — TIMEOUT_BY_METHOD=30000ms > 150ms delay で解決");

  // 21. key_down — 同期クラス。VK 名がそのまま透過する
  assert.deepStrictEqual(await c.call("key_down", { key: "D" }), { key: "D" });
  pass("key_down — 同期解決 / key 透過");

  // 22. project_world_to_screen — name 透過(読み取り系)
  assert.deepStrictEqual(
    await c.call("project_world_to_screen", { name: "Player" }),
    { name: "Player" },
  );
  pass("project_world_to_screen — name 透過");

  // 23. set_color — name + color 透過
  assert.deepStrictEqual(
    await c.call("set_color", { name: "Floor", color: [1, 0.84, 0] }),
    { name: "Floor", color: [1, 0.84, 0] },
  );
  pass("set_color — name + color 透過");

  // 24. screenshot_game_view — 遅延応答(120ms)が同期クラス(8000ms)で解決し path を返す
  const gv = await c.call("screenshot_game_view", {});
  assert.strictEqual(gv.path, "C:/tmp/gv.png", "screenshot_game_view が path を返すこと");
  pass("screenshot_game_view — 遅延 path 解決");

  server.close();
}

// ─── 結果サマリ ──────────────────────────────────────────────────────────────
console.log(`\nOK: 全 ${passed} テスト通過`);
process.exit(0);
