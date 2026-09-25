// dx12_batch をトランザクションで包むかの決め方(純関数)。index.ts から使う。
//
// ★トランザクションの中で使えない method がある(エンジンの ApplicationMcpUndo.cpp の約束):
//   Play / シーン切り替え(play / stop / open_scene / new_scene / open_project)は Undo 履歴を消すので、
//   開いたまま進むと rollback できなくなる → エンジンが MODE_CONFLICT で断る。Undo 系と transaction_* は入れ子になる。
//   batch にそれらが混じっていたら包めないので、atomic を省略していれば自動で外し(note に理由)、
//   atomic:true を明示していればエラーにする(黙って包まずに走らせると「戻せるつもり」の事故になる)。

/**
 * dx12_batch をトランザクションで包むか。★トランザクションの中で使えない method(Play / シーン切り替え /
 * Undo 系)が混じっていたら包めない: atomic を省略していれば自動で外し、明示していればエラーにする。
 */
export const TX_UNSAFE_METHODS = ["play", "stop", "open_scene", "new_scene", "open_project",
  "undo", "redo", "transaction_begin", "transaction_commit", "transaction_rollback"] as const;
export function planBatchTransaction(ops: { method: string }[], atomic: boolean | undefined):
  { atomic: boolean; note?: string; error?: string } {
  const unsafe = [...new Set(ops.map((o) => o.method).filter((m) => (TX_UNSAFE_METHODS as readonly string[]).includes(m)))];
  if (atomic === false) return { atomic: false };
  if (unsafe.length && atomic === true) return { atomic: false, error: `atomic:true の batch に、トランザクションの中で使えない ${unsafe.join(", ")} が入っている` };
  if (unsafe.length) return { atomic: false, note: `${unsafe.join(", ")} を含むので atomic を外して 1 つずつ確定した` };
  if (ops.length === 0) return { atomic: false };
  return { atomic: true };
}
