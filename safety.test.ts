// 副作用の安全性(M5)の TS 側テスト。偽エンジン(mockEngine.ts の safety モード = 実エンジンの docs/MCP.md §13 と同じ約束)+ MCP サーバを別プロセスで起動。
//   [1] guarded ゲート: 承認済みの経路だけが確認トークンを取る / dx12_batch は全ての面で拒否 / エンジン側の最終ゲート(トークン無し・再利用は拒否)/ 古いエンジン
//   [2] 冪等キー: 再送は前回の結果(Replay)・別引数は衝突・別名 idempotencyKey・旧ツールと合成ツールのサブキー・自動採番・タイムアウト時の同じキーでの自動再送
//   [3] dryRun: エンジンのプレビュー(実行しない)・プレビューが無い method・guarded・dx12_batch の op ごと
//   [4] batch: 主トランザクション(途中失敗で丸ごとロールバック・journal を運ぶ・ファイルを書く op の警告)
//   [5] TS のジャーナルの書き手(エンジンの journal と同じフォルダ形式)
// 実行: node safety.test.ts
import fs from "node:fs";
import path from "node:path";
import "./testEnv.ts";
import { startMcp, type McpClient } from "./stdioClient.ts";
import { startMockEngine } from "./mockEngine.ts";
import { EngineClient } from "./engineClient.ts";
import { guardApproval, GUARDED_METHODS, subKeyFor, newIdemCtx, takesIdempotencyKey } from "./guardCtx.ts";
import { GUARDED_NAMES } from "./catalog.ts";
import { writeJournalEntry } from "./journalTs.ts";
import { tmpDir, rmTree } from "./fleetTestKit.ts";

let failed = 0, total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 900)}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const dirs: string[] = [];
const mk = (l: string) => { const d = tmpDir(l); dirs.push(d); return d; };
const project = mk("project");

const M = (name: string, effect: string, extra: Record<string, unknown> = {}) => ({ name, category: "test", summary: name, effect, mode: "any", timeoutMs: 8000, params: [], source: "meta", ...extra }) as any;
const mock = await startMockEngine({
  safety: true,
  previewMethods: new Set(["set_transform", "delete_entity", "create_lua_component"]),
  pingExtra: () => ({ baseDir: project }),
  methods: [
    M("set_transform", "write_scene", { dryRun: "preview" }), M("delete_entity", "write_scene", { dryRun: "preview" }), M("set_component", "write_scene"),
    M("create_entity", "write_scene"), M("get_entity", "read"),
    M("create_lua_component", "write_file", { dryRun: "preview", journal: true }), M("terrain_generate", "write_file"),
    M("transaction_begin", "runtime", { }), M("transaction_commit", "runtime"), M("transaction_rollback", "runtime"),
    { ...M("transaction_begin", "runtime"), handler: (p: any) => ({ label: p.label, entryName: "AI: " + p.label }) },
    { ...M("transaction_rollback", "runtime"), handler: () => ({ calls: 2, journal: { id: "000001-tx", restored: ["assets/components/a.lua"], complete: true } }) },
    { ...M("transaction_commit", "runtime"), handler: () => ({ calls: 2, entryName: "AI: batch", journal: { id: "000002-tx", restored: [] } }) },
    M("git_push", "guarded"), M("eval_lua", "guarded"), M("custom_op", "write_scene", { params: [{ name: "n", type: "int" }] }),
  ],
});
const clients: McpClient[] = [];
function server(surface: "full" | "core", extra: Record<string, string> = {}): McpClient {
  const c = startMcp({ DX12_MCP_SURFACE: surface, DX12_MCP_PORT: String(mock.port), DX12_MCP_PORT_FILE: path.join(mk("pf"), "none.port"), DX12_JOBS_DIR: mk("jobs"), ...extra });
  clients.push(c);
  return c;
}
const reset = () => { mock.received.length = 0; mock.state.exec = {}; mock.state.tokens.clear(); mock.state.idem.clear(); };
const sent = (m: string) => mock.received.filter((r) => r.method === m);

// ─────────────────────────────────────────────────────────────────────────────
console.log("[1] guarded ゲート");
{
  check("guardCtx.GUARDED_METHODS は catalog の GUARDED_NAMES(dx12_ 除く)と同じ 11 件", GUARDED_METHODS.size === 11 && [...GUARDED_NAMES].every((n) => GUARDED_METHODS.has(n.replace(/^dx12_/, ""))) && [...GUARDED_METHODS].every((m) => GUARDED_NAMES.has("dx12_" + m)));
  // エンジンクライアント単体(承認の文脈がある / 無い)
  const cl = new EngineClient("127.0.0.1", mock.port, 3000, { backoffMs: [] });
  reset();
  const e0: any = await cl.call("git_push", {}).catch((e) => e);
  check("承認されていない呼び出し(dx12_batch の op 相当)は、エンジンが E_GUARDED で拒否(details.gate=engine・実行されない)", e0?.errName === "E_GUARDED" && e0.errDetails?.gate === "engine" && !mock.state.exec.git_push && sent("guard_token").length === 0, { name: e0?.errName, exec: mock.state.exec });
  const ok = await guardApproval.run({ approved: true, via: "test" }, () => cl.call("git_push", {}));
  check("承認済みの文脈では guard_token → confirm_token 付きで実行される(1 回)", ok?.ok === true && mock.state.exec.git_push === 1 && sent("guard_token").length === 1 && typeof sent("git_push").at(-1)?.params.confirm_token === "string", sent("git_push").map((r) => r.params));
  const tok = sent("git_push").at(-1)!.params.confirm_token;
  const reuse: any = await cl.call("git_push", { confirm_token: tok }).catch((e) => e);
  check("使用済みのトークンの再利用は拒否される(1 回限り)", reuse?.errName === "E_GUARDED" && mock.state.exec.git_push === 1);
  const unknownGuarded = await guardApproval.run({ approved: true, via: "test" }, () => { mock.state.guardedMethods.add("set_component"); return cl.call("set_component", { name: "Floor" }); });
  check("一覧に無い guarded な method も、承認済みなら拒否 → トークンを取り直して 1 回再送で通る", unknownGuarded?.applied === true && mock.state.exec.set_component === 1 && sent("guard_token").length === 2, { r: unknownGuarded, exec: mock.state.exec, g: sent("guard_token").length });
  mock.state.guardedMethods.delete("set_component");
  // 古いエンジン(guard_token が無い・ゲートも無い)
  mock.state.safety = false;
  const oldEng = await guardApproval.run({ approved: true, via: "test" }, () => cl.call("git_push", {}));
  check("guard_token を持たない古いエンジンでは、トークン無しでそのまま撃つ(ゲートが無いので通る)", oldEng?.ok === true);
  mock.state.safety = true;
  // 冪等キーの自動付与は文脈が無ければ何もしない
  reset();
  await cl.call("set_transform", { name: "Floor" });
  check("idemCtx が無ければ idempotency_key を付けない(従来と同じ)", sent("set_transform")[0].params.idempotency_key === undefined);
  cl.close();
}

const full = server("full");
await full.initialize();
{
  reset();
  const g0 = await full.call("dx12_call", { name: "dx12_git_push", args: {} });
  check("full 面: confirm 無しの guarded は TS が E_GUARDED(エンジンへ届かない)", g0.error_code === "E_GUARDED" && mock.received.filter((r) => r.method === "git_push" || r.method === "guard_token").length === 0, g0);
  const g1 = await full.call("dx12_call", { name: "dx12_git_push", args: {}, confirm: true });
  check("full 面: dx12_call {confirm:true} → guard_token → confirm_token 付きで git_push が実行される", g1.ok === true && mock.state.exec.git_push === 1 && sent("guard_token").length === 1, g1);
  reset();
  const g2 = await full.call("dx12_eval_lua", { code: "return 1" });
  check("full 面: 旧ツール dx12_eval_lua の直接呼び出しは(そのツールの呼び出し自体が承認)エンジンのゲートも通る", !g2.error_code && mock.state.exec.eval_lua === 1, g2);
  reset();
  const b1 = await full.call("dx12_batch", { ops: [{ method: "set_transform", params: { name: "Floor", position: [0, 1, 0] } }, { method: "git_push", params: {} }] });
  check("dx12_batch に guarded を混ぜると、full 面でも E_GUARDED で 1 つも実行しない(トランザクションも開かない)", b1.isError === true || b1.error_code === "E_GUARDED" || /E_GUARDED|guarded/.test(JSON.stringify(b1)), b1);
  check("…set_transform も transaction_begin もエンジンへ届いていない", mock.received.filter((r) => ["set_transform", "transaction_begin", "git_push"].includes(r.method)).length === 0, mock.received.map((r) => r.method));
  const raw = await full.raw("dx12_batch", { ops: [{ method: "git_push", params: {} }] });
  check("旧ツールの直接呼び出し(dx12_batch)も E_GUARDED の構造化 JSON", raw.isError === true && /E_GUARDED/.test(raw.content.map((c: any) => c.text).join("")), raw.content.map((c: any) => c.text.slice(0, 80)));
}
const core = server("core");
await core.initialize();
{
  reset();
  const c0 = await core.call("dx12_call", { name: "dx12_git_push", args: {}, confirm: true });
  check("core 面: dx12_call は guarded を(confirm:true でも)通さない", c0.error_code === "E_GUARDED" && sent("git_push").length === 0, c0);
  const c1 = await core.call("dx12_call_guarded", { name: "dx12_git_push", args: {} });
  check("core 面: dx12_call_guarded なら guard_token → confirm_token 付きで実行される", c1.ok === true && mock.state.exec.git_push === 1 && sent("guard_token").length === 1, c1);
  const c2 = await core.call("dx12_batch", { ops: [{ method: "eval_lua", params: { code: "return 1" } }] });
  check("core 面: dx12_batch の guarded も従来どおり拒否", c2.error_code === "E_GUARDED" || /E_GUARDED/.test(JSON.stringify(c2)), c2);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[2] 冪等キー");
{
  reset();
  const a1 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [0, 1, 0] }, idempotency_key: "k1" });
  const a2 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [0, 1, 0] }, idempotency_key: "k1" });
  check("同じキーの再送は前回の結果(idempotentReplay)を返し、エンジンは 1 回しか実行しない", a1.ok === true && a2.ok === true && a2.meta?.idempotentReplay === true && a2.result?.idempotentReplay === true && mock.state.exec.set_transform === 1, { exec: mock.state.exec, a2 });
  // ラッパの無い method(引数としてキーをそのままエンジンへ渡す)で、同じキーの別の要求は衝突する。
  const c1 = await full.call("dx12_call", { name: "custom_op", args: { n: 1 }, idempotency_key: "kc" });
  const c2 = await full.call("dx12_call", { name: "custom_op", args: { n: 2 }, idempotency_key: "kc" });
  check("同じキーで別の引数は E_IDEMPOTENCY_CONFLICT(再送不可・実行されない)", c1.ok === true && c2.error_code === "E_IDEMPOTENCY_CONFLICT" && c2.retryable === false && mock.state.exec.custom_op === 1, c2);
  const a3 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [9, 9, 9] }, idempotency_key: "k1" });
  check("旧ツール(サブキー)は引数が違えば別の要求(サブキーが変わる)= 新しく実行される。同じ引数の再送だけが Replay", a3.ok === true && !a3.meta?.idempotentReplay && mock.state.exec.set_transform === 2, a3);
  const a4 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [0, 2, 0] }, idempotencyKey: "k-alias" });
  const a5 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [0, 2, 0] }, idempotencyKey: "k-alias" });
  check("別名 idempotencyKey も同じ(再送は Replay)", a4.ok && a5.meta?.idempotentReplay === true && mock.state.exec.set_transform === 3, { m: a5.meta, e: mock.state.exec });

  // 旧ツール(zod が idempotency_key を宣言していない)= サブキー
  reset();
  const w1 = await full.call("dx12_call", { name: "dx12_set_transform", args: { name: "Floor", position: [1, 1, 1] }, idempotency_key: "k2" });
  const w2 = await full.call("dx12_call", { name: "dx12_set_transform", args: { name: "Floor", position: [1, 1, 1] }, idempotency_key: "k2" });
  const sk = sent("set_transform").map((r) => r.params.idempotency_key);
  check("旧ツール(dx12_set_transform)にもキーが効く: エンジンへは <key>:<method>:<引数のハッシュ>:<出現順> のサブキーが付き、2 回目は Replay", w1.ok && w2.ok && mock.state.exec.set_transform === 1 && /^k2:set_transform:[0-9a-f]{8}:1$/.test(sk[0]) && sk[0] === sk[1], { sk, exec: mock.state.exec });
  // 合成ツール(dx12_batch)= op ごとのサブキー(同じ引数の繰り返しでも衝突しない)
  reset();
  const ops = [{ method: "create_entity", params: { type: "box", name: "B" } }, { method: "create_entity", params: { type: "box", name: "B" } }];
  const b1 = await full.call("dx12_call", { name: "dx12_batch", args: { ops, atomic: false }, idempotency_key: "kb" });
  const b2 = await full.call("dx12_call", { name: "dx12_batch", args: { ops, atomic: false }, idempotency_key: "kb" });
  const bk = sent("create_entity").map((r) => r.params.idempotency_key);
  check("dx12_batch を同じキーで再送しても、完了済みの op は二重実行されない(2 回分 = 2 実行のまま)。同じ引数の 2 op は別のサブキー(:1 / :2)", b1.ok && b2.ok && mock.state.exec.create_entity === 2 && bk[0] !== bk[1] && bk[0] === bk[2] && bk[1] === bk[3] && /:1$/.test(bk[0]) && /:2$/.test(bk[1]), { bk, exec: mock.state.exec });
  // 自動採番
  reset();
  await full.call("dx12_call", { name: "set_transform", args: { name: "Floor" } });
  await full.call("dx12_call", { name: "get_entity", args: { name: "Floor" } });
  await full.call("dx12_call", { name: "dx12_batch", args: { ops: [{ method: "create_entity", params: { type: "box", name: "C" } }], atomic: false } });
  check("キー省略でも、エンジン method に 1:1 の write 系は自動採番(auto-…)。読み取りと合成ツール(batch)は付けない", /^auto-[0-9a-f]{12}(:set_transform:[0-9a-f]{8}:1)?$/.test(sent("set_transform")[0].params.idempotency_key) && sent("get_entity")[0].params.idempotency_key === undefined && sent("create_entity")[0].params.idempotency_key === undefined, mock.received.map((r) => [r.method, r.params.idempotency_key]));

  // タイムアウト → 同じキーで自動再送 → 処理中エラーを待つ → 完了後は Replay(二重実行なし)
  reset();
  mock.state.delayOnce.custom_op = 1600;
  const t0 = Date.now();
  const t1 = await full.call("dx12_call", { name: "custom_op", args: { n: 5 }, timeoutMs: 400 });
  const keys = sent("custom_op").map((r) => r.params.idempotency_key);
  check(`エンジンの応答が遅れて E_ENGINE_TIMEOUT でも、同じ自動キーで再送して成功する(${Date.now() - t0} ms)・meta.autoRetried ≥ 1・エンジンの実行は 1 回だけ`, t1.ok === true && (t1.meta?.autoRetried ?? 0) >= 1 && mock.state.exec.custom_op === 1 && new Set(keys).size === 1 && keys.length >= 2 && t1.result?.idempotentReplay === true, { t1, keys, exec: mock.state.exec });
  // 再送しても終わらないときは、原因つきのエラー(details.autoRetried / idempotencyKey)
  reset();
  mock.state.delayOnce.custom_op = 20000;
  const t2 = await full.call("dx12_call", { name: "custom_op", args: { n: 6 }, timeoutMs: 300 });
  check("再送しても完了しなければ E_ENGINE_TIMEOUT / E_IDEMPOTENCY_IN_FLIGHT のまま返り、details に idempotencyKey と再送回数が載る", ["E_ENGINE_TIMEOUT", "E_IDEMPOTENCY_IN_FLIGHT"].includes(t2.error_code) && t2.details?.autoRetried === 3 && /^auto-/.test(t2.details?.idempotencyKey), t2);
  mock.state.delayOnce = {};
  check("subKeyFor / takesIdempotencyKey の純関数(読み取りは付けない・同じ引数の繰り返しは出現順で区別・引数の順序に依らない)", (() => {
    const c = newIdemCtx("K");
    const a = subKeyFor(c, "set_transform", { name: "A", position: [1, 2, 3] });
    const b = subKeyFor(c, "set_transform", { position: [1, 2, 3], name: "A" });
    return a.endsWith(":1") && b.endsWith(":2") && a.slice(0, -2) === b.slice(0, -2) && !takesIdempotencyKey("get_entity") && !takesIdempotencyKey("ping") && takesIdempotencyKey("set_transform") && takesIdempotencyKey("transaction_begin");
  })());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[3] dryRun");
{
  reset();
  const d1 = await full.call("dx12_call", { name: "set_transform", args: { name: "Floor", position: [1, 0, 0] }, dryRun: true });
  check("エンジンのプレビュー: 実行されず(exec 0)、dryRunMode:engine・preview(summary / count / destructive / targets)が返る", d1.ok === true && d1.dryRun === true && d1.executed === false && d1.dryRunMode === "engine" && d1.preview?.summary === "mock preview set_transform" && d1.preview?.count === 1 && !mock.state.exec.set_transform, d1);
  check("エンジンへは dryRun:true が付いて 1 回だけ届く(キーは付かない)", sent("set_transform").length === 1 && sent("set_transform")[0].params.dryRun === true && sent("set_transform")[0].params.idempotency_key === undefined, sent("set_transform").map((r) => r.params));
  const d2 = await full.call("dx12_call", { name: "dx12_delete_entity", args: { name: "Floor" }, dryRun: true });
  check("旧ツール(dx12_delete_entity)の dryRun もエンジンのプレビュー(destructive:true)", d2.dryRunMode === "engine" && d2.preview?.destructive === true && !mock.state.exec.delete_entity, d2);
  reset();
  const d3 = await full.call("dx12_call", { name: "set_component", args: { name: "Floor", component: "x", data: {} }, dryRun: true });
  check("プレビューを持たない write の dryRun は従来の静的な予測(実行しない・supported に明記)", d3.executed === false && /static/.test(d3.preview?.supported ?? "") && !mock.state.exec.set_component && d3.dryRunMode === undefined, d3);
  const d4 = await full.call("dx12_call", { name: "dx12_git_push", args: {}, dryRun: true });
  check("guarded の dryRun は承認不要・実行しない・トークンも取らない", d4.executed === false && d4.preview?.destructive === true && sent("guard_token").length === 0 && !mock.state.exec.git_push, d4);
  reset();
  const db = await full.call("dx12_call", { name: "dx12_batch", args: { ops: [
    { method: "set_transform", params: { name: "Floor", position: [0, 0, 0] } }, { method: "set_component", params: { name: "Floor" } },
    { method: "git_push", params: {} }, { method: "get_entity", params: { name: "Floor" } }, { method: "no_such_method", params: {} },
  ] }, dryRun: true });
  const ops5: any[] = db.preview?.ops ?? [];
  check("dx12_batch の dryRun: op ごとに、プレビュー / プレビュー無し / guarded は blocked / 読み取りは実行時に実行 / 未知 method を返す・何も実行しない", db.dryRunMode === "engine-per-op" && ops5.length === 5 && ops5[0].preview?.summary && ops5[1].supported === false && ops5[2].blocked === true && ops5[3].effect === "read" && ops5[4].supported === false && db.preview.willFail === true && Object.keys(mock.state.exec).length === 0, db);
  const desc = await full.call("dx12_tool_describe", { name: "create_lua_component" });
  const desc2 = await full.call("dx12_tool_describe", { name: "set_component" });
  check("dx12_tool_describe: dryRun の種別(preview / static)と journal の有無が出る", /^preview/.test(desc.dryRun) && /あり/.test(desc.journal ?? "") && /^static/.test(desc2.dryRun) && desc2.journal === undefined, { a: desc.dryRun, j: desc.journal, b: desc2.dryRun });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[4] dx12_batch: 主トランザクション");
{
  reset();
  const r = await full.call("dx12_batch", { ops: [
    { method: "create_lua_component", params: { name: "A", code: "return {}" } },
    { method: "set_transform", params: { name: "NoSuchEntity_xyz", position: [0, 0, 0] } },
    { method: "set_transform", params: { name: "Floor", position: [1, 1, 1] } },
  ] });
  const seq = mock.received.map((x) => x.method).filter((m) => ["transaction_begin", "create_lua_component", "set_transform", "transaction_rollback", "transaction_commit"].includes(m));
  check("途中の失敗で最初の失敗の op で止まり、begin → op1 → op2(失敗)→ rollback(残りは実行しない・commit しない)", JSON.stringify(seq) === JSON.stringify(["transaction_begin", "create_lua_component", "set_transform", "transaction_rollback"]) && r.results?.[1]?.ok === false && r.results?.[2]?.skipped === true && r.transaction?.rolledBack === true, { seq, r });
  check("rollback の応答の journal(ファイルの復元結果)が transaction.journal に載る・journal 対応の write_file は警告なし", r.transaction?.journal?.id === "000001-tx" && r.transaction.journal.restored?.[0] === "assets/components/a.lua" && r.transaction.warning === undefined && r.transaction.fileWrites?.restorableOnRollback?.[0] === "create_lua_component", r.transaction);
  reset();
  const ok = await full.call("dx12_batch", { ops: [{ method: "create_lua_component", params: { name: "B", code: "return {}" } }, { method: "set_transform", params: { name: "Floor", position: [1, 1, 1] } }] });
  check("全部成功なら commit・journal を運ぶ・Undo 1 エントリ", ok.transaction?.committed === true && ok.transaction.journal?.id === "000002-tx" && ok.results.every((x: any) => x.ok), ok);
  reset();
  const w = await full.call("dx12_batch", { ops: [{ method: "terrain_generate", params: {} }, { method: "set_transform", params: { name: "Floor", position: [0, 0, 0] } }] });
  check("journal 未対応の write_file(terrain_generate)を含むと、rollback しても戻らない旨を transaction.warning / fileWrites.notRestorable に明記", /terrain_generate/.test(w.transaction?.warning ?? "") && w.transaction.fileWrites?.notRestorable?.[0] === "terrain_generate", w.transaction);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("[5] TS のジャーナルの書き手(エンジンの journal と同じ形式)");
{
  const base = mk("jbase");
  fs.mkdirSync(path.join(base, "assets", "scenes"), { recursive: true });
  const f1 = path.join(base, "assets", "scenes", "a.json");
  fs.writeFileSync(f1, '{"entities":[1]}');
  const f2 = path.join(base, "assets", "scenes", "new.json");
  const e1 = writeJournalEntry(base, "scene_write", "テスト", [{ absPath: f1, prev: fs.readFileSync(f1) }, { absPath: f2, prev: null }], 1234567);
  const e2 = writeJournalEntry(base, "scene_write", "2 件目", [{ absPath: f1, prev: Buffer.from("x") }]);
  const man = JSON.parse(fs.readFileSync(path.join(e1!.dir, "manifest.json"), "utf8"));
  check("エントリのフォルダ名 = <seq 6 桁>-<method>・seq は既存の最大 + 1", e1?.id === "000001-scene_write" && e2?.id === "000002-scene_write", [e1?.id, e2?.id]);
  check("manifest.json: version / id / method / label / createdAt / state:committed / txLabel:null / complete / files", man.version === 1 && man.id === e1!.id && man.method === "scene_write" && man.label === "テスト" && man.createdAt === 1234567 && man.state === "committed" && man.txLabel === null && man.complete === true && man.files.length === 2, man);
  check("files: project 相対('/' 区切り)・既存は existed:true + backup(files/0.bin)+ bytes、新規は existed:false・backup:null", man.files[0].path === "assets/scenes/a.json" && man.files[0].existed === true && man.files[0].backup === "files/0.bin" && man.files[0].bytes === 16 && man.files[1].path === "assets/scenes/new.json" && man.files[1].existed === false && man.files[1].backup === null, man.files);
  check("退避したバイト列が元の内容と一致", fs.readFileSync(path.join(e1!.dir, "files", "0.bin"), "utf8") === '{"entities":[1]}');
  const outside = writeJournalEntry(base, "scene_write", "外", [{ absPath: path.join(mk("outside"), "x.json"), prev: null }]);
  const mo = JSON.parse(fs.readFileSync(path.join(outside!.dir, "manifest.json"), "utf8"));
  check("project の外のファイルは絶対パスで記録する", path.isAbsolute(mo.files[0].path.replace(/\//g, path.sep)) && !mo.files[0].path.startsWith(".."), mo.files[0].path);
}

// ── 後始末 ─────────────────────────────────────────────────────────────────
for (const c of clients) { try { c.proc.stdin!.end(); } catch { /* 無視 */ } }
await sleep(300);
for (const c of clients) { try { c.close(); } catch { /* 無視 */ } }
await mock.close();
for (const d of dirs) rmTree(d);
if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: safety テスト ${total} 項目すべて通過`);
process.exit(0);
