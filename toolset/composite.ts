// 合成ツール(エンジンには無い。Node 内で複数 call を順に行う)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import path from "node:path";
import { COMPOSITE_TOOLS, METHOD_KEY_ALIASES, unknownKeyError, unknownParamKeys } from "../paramGuard.ts";
import { planBatchTransaction } from "../batchTx.ts";
import { argError } from "../sceneTools.ts";
import { TOOL_PARAM_KEYS, engine, entityId, entityRef, errResult, imageResult, reg, regRaw, run } from "./core.ts";
import { GUARDED_NAMES } from "../catalog.ts";
import { SURFACE } from "../toolRuntime.ts";
import { idemCtx, newIdemCtx } from "../guardCtx.ts";
import { manifestStore } from "./shell.ts";

// ════════════════════════════════════════════════════════════════
//  合成ツール(エンジンには無い。Node 内で複数 call を順に行う)
// ════════════════════════════════════════════════════════════════

// 決定的な乱数(mulberry32)。同じ seed なら同じ配置=AI のリトライで結果が再現する。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

reg(
  "dx12_scatter",
  "一括配置(散布/グリッド)",
  "プリミティブ/モデル/プレハブを矩形エリアへ一括配置する(木を50本、コインを敷き詰める等を1回の呼び出しで)。placement='random'(seed 付き乱数、同 seed で再現) か 'grid'(等間隔)。randomYaw で向きをばらし、scaleRange でサイズをばらす。snapToGround=true で1体ずつ接地。★Editor 限定(Playing 中は不可)。{entities:[{entityId, name}], count, seed} が返る。多数配置は時間がかかる(1体ずつフレーム境界で生成)。",
  {
    type: z.string().optional().describe("プリミティブ種別(box/sphere/plane/empty 等、dx12_create_entity と同じ)。type/model/prefab のどれか1つ必須。"),
    model: z.string().optional().describe("モデルの assets 相対パス(.gltf/.glb/.fbx/.obj)。"),
    prefab: z.string().optional().describe("プレハブの assets 相対パス(.prefab)。"),
    count: z.number().int().min(1).max(200).describe("配置する個数(1..200)。"),
    area: z.array(z.number()).length(4).describe("配置エリア [minX, minZ, maxX, maxZ](ワールド座標)。"),
    y: z.number().optional().describe("配置する高さ(Y)。既定 0。snapToGround を使うなら地面より上に。"),
    placement: z.enum(["random", "grid"]).optional().describe("random=seed 付き乱数(既定) / grid=等間隔グリッド。"),
    seed: z.number().int().optional().describe("乱数 seed。同じ seed なら同じ配置(既定 1)。"),
    randomYaw: z.boolean().optional().describe("true で各個体の Y 回転をランダムに(既定: random 時 true / grid 時 false)。"),
    scaleRange: z.array(z.number()).length(2).optional().describe("[min, max] の一様スケール倍率をランダム適用。例 [0.8, 1.3]。"),
    snapToGround: z.boolean().optional().describe("true で配置後に1体ずつ snap_to_ground を呼ぶ。"),
    namePrefix: z.string().optional().describe("エンティティ名の接頭辞(連番付与)。省略で種別/ファイル名。"),
  },
  {},
  (args: any) => run(async () => {
    const { count, area, placement = "random", seed = 1, scaleRange, snapToGround } = args;
    const sources = [args.type, args.model, args.prefab].filter((s: any) => s != null);
    if (sources.length !== 1) throw new Error("type / model / prefab のどれか1つだけ指定してください");
    const [minX, minZ, maxX, maxZ] = area;
    const y = args.y ?? 0;
    const randomYaw = args.randomYaw ?? (placement === "random");
    const rng = mulberry32(seed);
    const prefix = args.namePrefix
      ?? (args.type ?? String(args.model ?? args.prefab).split("/").pop()!.replace(/\.[^.]*$/, ""));

    // 位置リストを先に決める(grid は行×列で等間隔、random は seed 付き乱数)
    const positions: [number, number, number][] = [];
    if (placement === "grid") {
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      for (let i = 0; i < count; i++) {
        const cx = i % cols, rz = Math.floor(i / cols);
        const fx = cols > 1 ? cx / (cols - 1) : 0.5;
        const fz = rows > 1 ? rz / (rows - 1) : 0.5;
        positions.push([minX + (maxX - minX) * fx, y, minZ + (maxZ - minZ) * fz]);
      }
    } else {
      for (let i = 0; i < count; i++)
        positions.push([minX + (maxX - minX) * rng(), y, minZ + (maxZ - minZ) * rng()]);
    }

    const entities: any[] = [];
    const errors: any[] = [];
    for (let i = 0; i < count; i++) {
      const nm = `${prefix}_${String(i + 1).padStart(3, "0")}`;
      try {
        let created: any;
        if (args.type)        created = await engine.call("create_entity", { type: args.type, name: nm, position: positions[i] });
        else if (args.model)  created = await engine.call("spawn_model", { path: args.model, name: nm, position: positions[i] });
        else                  created = await engine.call("spawn_prefab", { path: args.prefab, name: nm, position: positions[i] });
        const id = created?.rootEntityId ?? created?.entityId;
        const tf: any = {};
        if (randomYaw) tf.rotation = [0, rng() * 360, 0];
        if (scaleRange) {
          const s = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * rng();
          tf.scale = [s, s, s];
        }
        if (Object.keys(tf).length) await engine.call("set_transform", { entity: id, ...tf });
        if (snapToGround) await engine.call("snap_to_ground", { entity: id });
        entities.push({ entityId: id, name: created?.name ?? nm });
      } catch (e: any) {
        errors.push({ index: i, error: e.message });
        if (errors.length >= 3) break;   // 失敗が3件溜まったら打ち切り(Playing 中など根本原因があるはず)
      }
    }
    const out: any = { entities, count: entities.length, seed, placement };
    if (errors.length) out.errors = errors;
    return out;
  }),
);

/**
 * dx12_batch の op(engine method 直叩き)に対して、対応するツールが宣言している
 * 引数キーを返す。合成ツール(engine と 1:1 でない)と未知 method は null = 検査しない。
 */
function batchDeclaredKeys(method: string): string[] | null {
  const toolName = `dx12_${method}`;
  if (COMPOSITE_TOOLS.has(toolName)) return null;
  const declared = TOOL_PARAM_KEYS.get(toolName);
  if (!declared) return null;   // ツール未登録の method(read_texture 等)はエンジンに任せる
  return [...declared, ...(METHOD_KEY_ALIASES[method] ?? [])];
}

/** 冪等キー(idempotency_key)が渡されたら、その文脈の中で実行する(op ごとにサブキーが付き、再送しても完了済みの op は二重実行されない)。 */
const withIdem = (h: (a: any) => Promise<any>) => (args: any) => {
  const key = args?.idempotency_key ?? args?.idempotencyKey;
  return key && !idemCtx.getStore() ? idemCtx.run(newIdemCtx(String(key)), () => h(args)) : h(args);
};

reg(
  "dx12_batch",
  "一括実行",
  "複数のエンジン操作を順番に実行して往復を減らす。各 op は engine の method 名(dx12_ 接頭辞なし。例 create_entity)と params。結果は {results:[{index, ok, result?|error?, error_code?, skipped?}], transaction?}。"
  + "★atomic(既定 true)はトランザクションで包む: transaction_begin → 順に実行 → どれかが失敗したらそこで止めて transaction_rollback(begin 前へ丸ごと戻る)、"
  + "全部成功したら transaction_commit(Undo 1 回で丸ごと戻せる 1 エントリ)。atomic のときは stopOnError に関係なく最初の失敗で止まる(戻すので続けても意味が無い)。"
  + "atomic:false は従来どおり 1 つずつ確定し、stopOnError=true なら最初の失敗で打ち切って残りを skipped 記録。"
  + "★play / stop / open_scene / new_scene / open_project と undo / redo / transaction_* はトランザクションの中で使えない: atomic を省略したら自動で atomic:false にし、"
  + "atomic:true を明示していたらエラーにする。呼ぶ側が既にトランザクションを開いていたら、その中で実行する(閉じるのは呼んだ側)。"
  + "★params のキーは対応する dx12_<method> ツールと同じ。知らないキーが混じっていたらそのopは実行せずエラーにする(エンジンは知らないキーを黙って無視するため)。",
  {
    ops: z.array(z.object({
      method: z.string().describe("エンジン method 名(dx12_ 接頭辞なし)。例: create_entity, set_component"),
      params: z.record(z.any()).optional().describe("その method の params。省略で {}。"),
    })).describe("順に実行する操作の配列。"),
    stopOnError: z.boolean().optional().describe("atomic:false のとき: true なら最初の失敗で打ち切り、残りを skipped 記録。atomic のときは常に最初の失敗で止まる。"),
    atomic: z.boolean().optional().describe("true(既定)= トランザクションで包み、失敗したら丸ごと戻す / false = 1 つずつ確定(従来)。"),
    label: z.string().optional().describe("atomic のときの Undo 履歴の名前(「AI: <label>」)。省略で batch(<件数>)。"),
  },
  {},
  withIdem(({ ops, stopOnError, atomic, label }) => run(async () => {
    // ★atomic の既定を true にした理由: batch は「部屋を 1 つ組む」のようなまとまった編集に使われるが、
    //   途中で 1 つ失敗すると半端な状態(床だけある・壁が 3 枚)がシーンに残り、AI は何を消せば元に戻るか
    //   分からなかった。トランザクションで包めば失敗時は begin 前へ丸ごと戻り、成功時も Undo 1 回で戻せる。
    // ★guarded な method(git push / eval_lua / delete_asset / build_game …)を batch 経由で撃たせない。
    //   batch の op はエンジン method 直叩きなので、ここで見ないと dx12_call_guarded / confirm のゲートを素通りできてしまう。
    //   M5: 全ての面で拒否する(旧: core / shell 面だけ)。さらにエンジン側の最終ゲート(confirm_token)が二重に止める:
    //   batch の op は承認済みの文脈(guardCtx)で撃たれないのでトークンが付かず、エンジンが E_GUARDED で拒否する。
    {
      const guardedOps = [...new Set(ops.map((o) => o.method).filter((m) => GUARDED_NAMES.has("dx12_" + m) || manifestStore.get(m)?.effect === "guarded"))];
      if (guardedOps.length) {
        const e: any = argError(
          `dx12_batch に guarded な method が入っている: ${guardedOps.join(", ")}(取り返しが付かない/外部に影響する操作は batch では実行しない)`,
          SURFACE === "core" ? "guarded な操作は dx12_call_guarded から 1 つずつ実行する(先に dryRun:true)" : "guarded な操作は dx12_call {confirm:true} から 1 つずつ実行する(ユーザーの承認を得てから)。dx12_batch には入れられない",
        );
        e.errName = "E_GUARDED";
        e.errFix = guardedOps.map((m) => ({ tool: SURFACE === "core" ? "dx12_call_guarded" : "dx12_call", args: { name: "dx12_" + m, args: {}, dryRun: true }, why: `${m} を単独で dryRun してから、承認を得て実行する` }));
        throw e;
      }
    }
    const txPlan = planBatchTransaction(ops, atomic);
    if (txPlan.error) throw argError(txPlan.error, "該当の op を別の呼び出しに分けるか、atomic:false にする");
    let tx: Record<string, unknown> | undefined;
    let ownTx = false;
    if (txPlan.atomic) {
      try {
        const b = await engine.call("transaction_begin", { label: label ?? `batch(${ops.length})` });
        ownTx = true;
        tx = { label: b?.label ?? label, entryName: b?.entryName };
        // ファイルを書く op: journal 対応(save_scene / create_lua_component / create_shader / move_asset / delete_asset / import_asset / create_prefab)は
        // rollback でファイルも戻る。対応していない write_file(地形の保存など)は、失敗して rollback してもファイルが戻らない。
        const fileOps = [...new Set(ops.map((o) => o.method).filter((m) => manifestStore.get(m)?.effect === "write_file"))];
        const notRestorable = fileOps.filter((m) => !manifestStore.get(m)?.journal);
        if (fileOps.length) tx = { ...tx, fileWrites: { restorableOnRollback: fileOps.filter((m) => manifestStore.get(m)?.journal), notRestorable } };
        if (notRestorable.length) tx = { ...tx, warning: `${notRestorable.join(", ")} が書くファイルは、失敗して rollback しても元に戻らない(journal 未対応)。シーンのメモリだけが戻る` };
      } catch (e: any) {
        // 既に開いている(呼んだ側が begin 済み)ならその中で実行する。閉じるのは呼んだ側。
        if (/already open/i.test(String(e?.message ?? ""))) tx = { label: null, note: "既に開いているトランザクションの中で実行した(commit / rollback は呼んだ側で)" };
        // トランザクションの無い古いエンジン / Play 中などは従来どおり 1 つずつ確定する(何が起きたかは note に残す)
        else tx = { atomic: false, note: `トランザクションを開けなかったので 1 つずつ確定した: ${e?.message ?? e}` };
      }
    } else if (txPlan.note) {
      tx = { atomic: false, note: txPlan.note };
    }
    const stopFirst = ownTx || !!stopOnError;
    const results: any[] = [];
    let aborted = false;
    for (let i = 0; i < ops.length; i++) {
      if (aborted) { results.push({ index: i, ok: false, skipped: true }); continue; }
      const op = ops[i];
      try {
        // batch はツールのスキーマを通らない = 未知キーがそのままエンジンへ流れて
        // 黙って無視される唯一の抜け道。ここで同じ検査をかける。
        const declared = batchDeclaredKeys(op.method);
        if (declared) {
          const bad = unknownParamKeys(op.params, declared);
          if (bad.length > 0) throw unknownKeyError(`dx12_batch ops[${i}] (${op.method})`, bad, declared);
        }
        const r = await engine.call(op.method, op.params ?? {});
        results.push({ index: i, ok: true, result: r });
      } catch (e: any) {
        const entry: any = { index: i, ok: false, error: e.message };
        if (e.code != null) entry.error_code = e.code;
        results.push(entry);
        if (stopFirst) aborted = true;
      }
    }
    if (ownTx) {
      const failed = results.some((r) => !r.ok);
      try {
        if (failed) {
          const rb = await engine.call("transaction_rollback", {});
          tx = { ...tx, rolledBack: true, calls: rb?.calls, humanEditsDuringTransaction: rb?.humanEditsDuringTransaction, ...(rb?.journal ? { journal: rb.journal } : {}),
                 note: "失敗したので begin 前へ丸ごと戻した(成功した op の変更も残っていない。journal 対応のファイルも元の内容へ戻した)" };
        } else {
          const cm = await engine.call("transaction_commit", {});
          tx = { ...tx, committed: true, calls: cm?.calls, entryName: cm?.entryName ?? tx?.entryName, ...(cm?.journal ? { journal: cm.journal } : {}),
                 note: "1 エントリとして Undo に積んだ(dx12_undo 1 回で丸ごと戻せる)" };
        }
      } catch (e: any) {
        // 人の Play / シーン切り替えで確定扱いに自動で閉じられた等。変更は残っている(Undo 1 回で戻せる)
        tx = { ...tx, closeError: String(e?.message ?? e), note: "閉じるときに失敗した。dx12_transaction_status の lastClosed を見る" };
      }
    }
    return { results, ...(tx ? { transaction: tx } : {}) };
  })),
);


// 画像を返す合成ツール(focus → 1フレーム描画 → 撮影)。outputSchema は宣言しない(構造化結果ではなく image)。
regRaw(
  "dx12_focus_and_screenshot",
  {
    title: "寄せて撮影",
    description: "カメラを対象エンティティに寄せてからスクショを撮り、PNG 画像で返す(dx12_focus_camera + dx12_screenshot_final の合成)。entity(id) か name 指定。配置や見た目を自分の目で確認するのに使う。"
      + "★撮るのは【ポスト適用後の最終画】なのでグレーディング/ブルーム/TAA 込みの見た目が確認できる。image ブロック + text(path/サイズ)を返す。",
    inputSchema: {
      ...entityRef,
      gizmos: z.boolean().optional().describe(
        "false でこの 1 枚だけエディタのデバッグ描画(視錐台の線 / 選択枠 / アイコン / グリッド)を止めて撮る。既定 true。次の 1 枚では自動で元に戻る。"),
    },
    annotations: { title: "寄せて撮影", openWorldHint: false, idempotentHint: true },
  },
  async ({ entity, name, gizmos }) => {
    try {
      await engine.call("focus_camera", { entity, name });
      const shot = await engine.call("screenshot_final", { gizmos });
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      return imageResult(shot.path, {
        entity, width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer", postApplied: shot.postApplied,
        gizmos: shot.gizmos ?? true,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);
