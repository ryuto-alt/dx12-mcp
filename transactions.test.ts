/**
 * Undo / Redo / トランザクション / dx12_batch(atomic)の e2e テスト。ネット不要・エディタ不要。
 *
 * index.ts を子プロセスで起動し、トランザクションの状態を持つ偽エンジンに繋ぐ(部品は jev/testHarness.ts)。
 * 担保すること:
 *   1) dx12_transaction_begin / commit / rollback / status が登録され、そのままエンジンへ届く
 *   2) dx12_undo / dx12_redo は onlyAi を通す(省略時は送らない = エンジンの既定 true)
 *   3) dx12_batch(既定 atomic): begin → 実行 → 全部成功なら commit / 1 つでも失敗したらそこで止めて rollback
 *   4) atomic:false は従来どおり(begin しない・stopOnError に従う)
 *   5) トランザクションの中で使えない op(open_scene 等): atomic 省略なら自動で外す / atomic:true ならエラー
 *   6) 呼ぶ側が既に開いていたらその中で実行し、閉じない / トランザクションの無い古いエンジンなら 1 つずつ確定
 *
 * 実行: node transactions.test.ts
 */

import assert from "node:assert/strict";
import { McpStdio, payload, startFakeEngine } from "./jev/testHarness.ts";
import { TX_UNSAFE_METHODS, planBatchTransaction } from "./batchTx.ts";

let passed = 0;
const pass = (label: string) => { passed++; console.log(`  OK  ${label}`); };

// ── 偽エンジン: トランザクションの開閉と、中で呼ばれた書き込みの数だけを持つ ──
const tx = { open: false, label: "", calls: 0, supported: true };
const err = (code: number, message: string) => Object.assign(new Error(message), { code });
function engineHandler(method: string, params: any): any {
  if (!tx.supported && method.startsWith("transaction_")) throw err(1, `unknown method: ${method}`);
  switch (method) {
    case "transaction_begin":
      if (tx.open) throw err(3, `transaction '${tx.label}' is already open (nesting is not allowed)`);
      Object.assign(tx, { open: true, label: params.label ?? "transaction", calls: 0 });
      return { open: true, label: tx.label, entryName: `AI: ${tx.label}`, undoDepth: 3, idleTimeoutSec: 600 };
    case "transaction_commit":
      if (!tx.open) throw err(3, "no open transaction");
      tx.open = false;
      return { committed: true, label: tx.label, calls: tx.calls, pushed: true, entryName: `AI: ${tx.label}`, humanEditsDuringTransaction: 0 };
    case "transaction_rollback":
      if (!tx.open) throw err(3, "no open transaction");
      tx.open = false;
      return { rolledBack: true, label: tx.label, calls: tx.calls, humanEditsDuringTransaction: 0, sceneGeneration: 9 };
    case "transaction_status": return { open: tx.open, ...(tx.open ? { label: tx.label, calls: tx.calls } : {}), lastClosed: null, mode: "Editor" };
    case "undo": return { undone: true, wasAi: true, onlyAi: params.onlyAi ?? true, undoable: true, willUndo: "AI: set_transform" };
    case "redo": return { redone: true, wasAi: true, onlyAi: params.onlyAi ?? true, redoable: false };
    case "create_entity":
      if (params.name === "BAD") throw err(2, "invalid primitive");
      if (tx.open) tx.calls++;
      return { entityId: 40 + tx.calls, name: params.name, undoEntry: tx.open ? `AI: ${tx.label}` : "AI: create_entity" };
    case "set_transform": if (tx.open) tx.calls++; return { ok: true };
    case "open_scene":
      if (tx.open) throw err(3, "cannot open a scene while a transaction is open");
      return { opened: params.path };
    default: return undefined;
  }
}

const engine = await startFakeEngine(engineHandler);
const mcp = new McpStdio({ enginePort: engine.port, jevUrl: "http://127.0.0.1:9/none", key: "" });
await mcp.init();
const sent = (m: string) => engine.received.filter((x) => x.method === m);
const methodsSince = (n: number) => engine.received.slice(n).map((x) => x.method);

try {
  console.log("[0] batch をトランザクションで包むかの決め方(純関数)");
  {
    assert.deepEqual(planBatchTransaction([{ method: "create_entity" }], undefined), { atomic: true });
    assert.deepEqual(planBatchTransaction([{ method: "create_entity" }], false), { atomic: false });
    assert.equal(planBatchTransaction([{ method: "open_scene" }], undefined).atomic, false);
    assert.match(planBatchTransaction([{ method: "open_scene" }], undefined).note ?? "", /open_scene/);
    assert.match(planBatchTransaction([{ method: "play" }], true).error ?? "", /play/);
    assert.deepEqual(planBatchTransaction([], undefined), { atomic: false });
    assert.ok(["play", "open_scene", "undo", "transaction_commit"].every((m) => (TX_UNSAFE_METHODS as readonly string[]).includes(m)));
    pass("既定は包む / false は包まない / 使えない op は省略なら外し、明示ならエラー / 空は包まない");
  }

  console.log("[1] トランザクションの 4 ツールと undo / redo");
  {
    const names = (await mcp.listTools()).result.tools.map((t: any) => t.name);
    for (const n of ["dx12_transaction_begin", "dx12_transaction_commit", "dx12_transaction_rollback", "dx12_transaction_status"]) assert.ok(names.includes(n), n);
    const b = payload(await mcp.call("dx12_transaction_begin", { label: "書斎を組む" }));
    assert.equal(b.entryName, "AI: 書斎を組む");
    assert.equal(payload(await mcp.call("dx12_transaction_status", {})).open, true);
    const rb = payload(await mcp.call("dx12_transaction_rollback", {}));
    assert.equal(rb.rolledBack, true);
    const again = await mcp.call("dx12_transaction_commit", {});
    assert.equal(again.result.isError, true, "閉じた後の commit は MODE_CONFLICT がそのまま返る");
    pass("begin / status / rollback / commit がそのままエンジンへ届き、エラーも素通し");

    payload(await mcp.call("dx12_undo", {}));
    assert.deepEqual(sent("undo").pop()!.params, {}, "onlyAi を省略したら送らない(エンジンの既定 true)");
    const u = payload(await mcp.call("dx12_undo", { onlyAi: false }));
    assert.equal(sent("undo").pop()!.params.onlyAi, false);
    assert.equal(u.onlyAi, false);
    payload(await mcp.call("dx12_redo", { onlyAi: true }));
    assert.equal(sent("redo").pop()!.params.onlyAi, true);
    pass("undo / redo は onlyAi を通す(省略時は送らない)");
  }

  console.log("[2] dx12_batch(既定 atomic)");
  {
    let n = engine.received.length;
    const ok = payload(await mcp.call("dx12_batch", { ops: [
      { method: "create_entity", params: { type: "box", name: "Floor" } },
      { method: "set_transform", params: { name: "Floor", position: [0, 0, 0] } },
    ] }));
    assert.deepEqual(methodsSince(n), ["transaction_begin", "create_entity", "set_transform", "transaction_commit"]);
    assert.equal(sent("transaction_begin").pop()!.params.label, "batch(2)");
    assert.equal(ok.transaction.committed, true);
    assert.equal(ok.transaction.calls, 2);
    assert.ok(ok.results.every((r: any) => r.ok));
    pass("全部成功: begin → 実行 → commit(Undo 1 エントリ)");

    n = engine.received.length;
    const bad = payload(await mcp.call("dx12_batch", { label: "壁を立てる", ops: [
      { method: "create_entity", params: { type: "box", name: "Wall_N" } },
      { method: "create_entity", params: { type: "box", name: "BAD" } },
      { method: "create_entity", params: { type: "box", name: "Wall_S" } },
    ] }));
    assert.deepEqual(methodsSince(n), ["transaction_begin", "create_entity", "create_entity", "transaction_rollback"]);
    assert.equal(bad.transaction.rolledBack, true);
    assert.equal(bad.results[2].skipped, true, "失敗したら残りは実行しない(戻すので続けても意味が無い)");
    assert.equal(bad.results[1].error_code, 2);
    assert.equal(tx.open, false);
    pass("1 つ失敗: そこで止めて rollback(begin 前へ丸ごと戻る)。残りは skipped");

    n = engine.received.length;
    const plain = payload(await mcp.call("dx12_batch", { atomic: false, ops: [
      { method: "create_entity", params: { type: "box", name: "BAD" } },
      { method: "create_entity", params: { type: "box", name: "Crate" } },
    ] }));
    assert.deepEqual(methodsSince(n), ["create_entity", "create_entity"], "atomic:false は begin しない");
    assert.equal(plain.transaction, undefined);
    assert.equal(plain.results[1].ok, true, "stopOnError を付けなければ続ける(従来どおり)");
    pass("atomic:false は従来どおり(begin しない・stopOnError に従う)");
  }

  console.log("[3] トランザクションの中で使えない op / 既に開いている / 古いエンジン");
  {
    let n = engine.received.length;
    const auto = payload(await mcp.call("dx12_batch", { ops: [
      { method: "open_scene", params: { path: "scenes/a.json" } },
      { method: "create_entity", params: { type: "box", name: "A" } },
    ] }));
    assert.deepEqual(methodsSince(n), ["open_scene", "create_entity"]);
    assert.match(auto.transaction.note, /open_scene/);
    pass("open_scene を含む batch は atomic を省略していれば自動で外す(理由を note に)");

    const forced = await mcp.call("dx12_batch", { atomic: true, ops: [{ method: "open_scene", params: { path: "scenes/a.json" } }] });
    assert.equal(forced.result.isError, true);
    assert.match(forced.result.content[0].text, /open_scene/);
    pass("atomic:true を明示して open_scene を入れたらエラー(戻せるつもりの事故を起こさない)");

    payload(await mcp.call("dx12_transaction_begin", { label: "外側" }));
    n = engine.received.length;
    const inner = payload(await mcp.call("dx12_batch", { ops: [{ method: "create_entity", params: { type: "box", name: "Chair" } }] }));
    assert.deepEqual(methodsSince(n), ["transaction_begin", "create_entity"], "commit も rollback もしない");
    assert.equal(tx.open, true, "呼んだ側のトランザクションは開いたまま");
    assert.match(inner.transaction.note, /既に開いている/);
    payload(await mcp.call("dx12_transaction_commit", {}));
    pass("呼ぶ側が既に開いていたら、その中で実行して閉じない(閉じるのは呼んだ側)");

    tx.supported = false;
    n = engine.received.length;
    const old = payload(await mcp.call("dx12_batch", { ops: [{ method: "create_entity", params: { type: "box", name: "Old" } }] }));
    tx.supported = true;
    assert.deepEqual(methodsSince(n), ["transaction_begin", "create_entity"]);
    assert.equal(old.results[0].ok, true);
    assert.match(old.transaction.note, /1 つずつ確定/);
    pass("トランザクションの無い古いエンジンでは 1 つずつ確定(note に理由)");
  }
} catch (e) {
  console.log(`  NG  ${(e as Error).message}`);
  mcp.kill(); engine.server.close();
  process.exit(1);
}

mcp.kill();
engine.server.close();
console.log(`\nOK: トランザクション e2e テスト ${passed} 項目すべて通過`);
process.exit(0);
