// 差分計画の適用(M11)。1 トランザクション(M5 の transaction_begin / commit / rollback)で、波(phase)ごとに並列に撃つ。
//
//   ・エンジンは 1 フレームで溜まった要求を全部処理する(McpBridge::Poll は溜まった行を全部処理する)ので、同じ波の要求を並列に撃てば
//     「create_entity を 1 体ずつ待つ(1 体 1 フレーム)」が消える。生成は遅延(フレーム境界)なので、生成の波を待ってから次の波(親子・Transform・部品)へ。
//   ・失敗したら波の途中でも止めて transaction_rollback(begin 前のシーンへ丸ごと戻る。消した物も guid ごと復元される)。
//   ・設定系(ポスト・スカイボックス・ナビメッシュなど。エンジンの rollback では戻らない)は、検証が通ってコミットした後に撃つ。
import { pmap, PHASE, type EngineLike, type Step, type Plan } from "./plan.ts";

export type StepError = { method: string; entity?: string; message: string; code?: number | string; phase: number; errName?: string; didYouMean?: string[]; params?: Record<string, unknown> };

export type ApplyProgress = (p: { phase: string; pct: number; message: string }) => void;

export type ApplyState = {
  ok: boolean;
  /** create 系の結果から控えた entityId(名前 → id)。 */
  ids: Map<string, number>;
  errors: StepError[];
  stepsRun: number;
  transaction: { begun: boolean; joined?: boolean; label?: string; note?: string };
  ms: number;
};

const PHASE_LABEL: Record<number, string> = {
  [PHASE.groups]: "グループの根を作る", [PHASE.delete]: "削除", [PHASE.create]: "エンティティを生成", [PHASE.parent]: "親子を設定",
  [PHASE.transform]: "Transform を設定", [PHASE.props]: "色・材質・部品・タグを設定", [PHASE.snap]: "接地(snap_to_ground)", [PHASE.scriptProps]: "スクリプトの値を設定",
};

const errInfo = (e: any) => ({ message: String(e?.message ?? e), code: e?.code ?? e?.error_code ?? e?.errName, errName: typeof e?.errName === "string" ? e.errName : undefined, didYouMean: Array.isArray(e?.didYouMean) ? (e.didYouMean as string[]) : undefined });

/** トランザクションを開く。既に開いていれば、その中で実行する(閉じるのは呼んだ側)。 */
export async function beginTx(engine: EngineLike, label: string): Promise<{ begun: boolean; joined?: boolean; note?: string }> {
  try {
    await engine.call("transaction_begin", { label });
    return { begun: true };
  } catch (e: any) {
    if (/already open/i.test(String(e?.message ?? ""))) return { begun: false, joined: true, note: "既に開いているトランザクションの中で実行した(commit / rollback は呼んだ側で)" };
    // トランザクションを持たない古いエンジン / Play 中など。原子性が無いので、呼び出し側に知らせる。
    return { begun: false, note: `トランザクションを開けなかった(${errInfo(e).message})。失敗しても自動では戻らない` };
  }
}

/**
 * Step を波ごとに撃つ。最初の失敗の波で止める(その波の残りの結果は捨てず errors に全部集める)。
 * ids: 既存のエンティティ id(シーンの実測)。create 系の結果で更新される。
 */
export async function runSteps(engine: EngineLike, steps: Step[], ids: Map<string, number>, hooks: { onProgress?: ApplyProgress; signal?: AbortSignal } = {}): Promise<{ errors: StepError[]; stepsRun: number }> {
  const phases = [...new Set(steps.map((s) => s.phase))].sort((a, b) => a - b);
  const errors: StepError[] = [];
  let stepsRun = 0;
  for (let pi = 0; pi < phases.length; pi++) {
    if (hooks.signal?.aborted) { errors.push({ method: "(abort)", message: "キャンセルされた", phase: phases[pi], code: "E_CANCELLED" }); break; }
    const ph = phases[pi];
    const group = steps.filter((s) => s.phase === ph);
    hooks.onProgress?.({ phase: PHASE_LABEL[ph] ?? `phase ${ph}`, pct: Math.round((pi / phases.length) * 100), message: `${PHASE_LABEL[ph] ?? ph}(${group.length} 件)` });
    // モデル / プレハブの生成は GPU ロードを伴う(同じフレーム境界で順に処理される)。まとめて撃つ数を絞り、待ちの上限も長くする。
    const heavy = group.some((s) => s.method === "spawn_model" || s.method === "spawn_prefab");
    const timeout = group.some((s) => s.captureId) ? 180_000 : undefined;
    const res = await pmap(group, async (s) => {
      const params = { ...s.params };
      if (s.method === "set_parent" && typeof params.parentName === "string") {
        const pid = ids.get(params.parentName);
        delete params.parentName;
        if (pid === undefined) return { s, error: { message: `親 '${s.params.parentName}' の entityId が分からない(親が作られていない)`, code: "E_NOT_FOUND_ENTITY" } };
        params.parent = pid;
      }
      // 名前で指す(id は Stop / シーン切り替えで変わるので name が安定)。create 系は name を渡している。
      try {
        const r = await engine.call(s.method, params, timeout ? { timeout } : undefined);
        stepsRun++;
        if (s.captureId && s.entity) {
          const id = r?.rootEntityId ?? r?.entityId;
          if (typeof id === "number") ids.set(s.entity, id);
          if (typeof r?.name === "string" && r.name !== s.entity) return { s, error: { message: `'${s.entity}' を作ったが、エンジンが '${r.name}' に改名した(同名のエンティティが既にある)`, code: "E_SPEC_DUPLICATE_NAME" } };
        }
        return { s, result: r };
      } catch (e: any) { return { s, error: errInfo(e) }; }
    }, heavy ? 48 : undefined);
    for (const r of res) if ("error" in r && r.error) errors.push({ method: r.s.method, entity: r.s.entity, message: r.error.message, code: r.error.code, phase: ph, errName: (r.error as any).errName, didYouMean: (r.error as any).didYouMean, params: r.s.params });
    if (errors.length) break;
  }
  return { errors, stepsRun };
}

/** 計画を 1 トランザクションで適用する。commit / rollback は呼び出し側(検証の後)が決める。 */
export async function applySteps(engine: EngineLike, plan: Plan, idsIn: Map<string, number>, label: string, hooks: { onProgress?: ApplyProgress; signal?: AbortSignal } = {}): Promise<ApplyState> {
  const t0 = Date.now();
  const ids = new Map(idsIn);
  const tx = await beginTx(engine, label);
  const st: ApplyState = { ok: true, ids, errors: [], stepsRun: 0, transaction: { begun: tx.begun, joined: tx.joined, label, note: tx.note }, ms: 0 };
  const r = await runSteps(engine, plan.steps, ids, hooks);
  st.errors = r.errors; st.stepsRun = r.stepsRun; st.ok = r.errors.length === 0;
  st.ms = Date.now() - t0;
  return st;
}

export async function commitTx(engine: EngineLike, tx: ApplyState["transaction"]): Promise<Record<string, unknown>> {
  if (!tx.begun) return { committed: false, note: tx.note ?? "トランザクションの外で実行した" };
  try {
    const cm = await engine.call("transaction_commit", {});
    return { committed: true, calls: cm?.calls, entryName: cm?.entryName, note: "1 エントリとして Undo に積んだ(dx12_undo 1 回で丸ごと戻せる)" };
  } catch (e: any) {
    return { committed: false, closeError: errInfo(e).message, note: "閉じるときに失敗した。dx12_transaction_status を見る(変更は残っている可能性がある)" };
  }
}

export async function rollbackTx(engine: EngineLike, tx: ApplyState["transaction"]): Promise<Record<string, unknown>> {
  if (!tx.begun) return { rolledBack: false, note: tx.note ?? "トランザクションを開いていないので戻せない(一部の変更が残っている可能性がある)" };
  try {
    const rb = await engine.call("transaction_rollback", {});
    return { rolledBack: true, calls: rb?.calls, ...(rb?.journal ? { journal: rb.journal } : {}), note: "失敗したので begin 前へ丸ごと戻した(成功した操作の変更も残っていない)" };
  } catch (e: any) {
    return { rolledBack: false, rollbackError: errInfo(e).message, note: "ロールバックに失敗した。dx12_undo か dx12_transaction_status で状態を確認する" };
  }
}
