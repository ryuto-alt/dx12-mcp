// Undo / Redo / トランザクション
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { definedOnly } from "../paramGuard.ts";
import path from "node:path";
import { engine, entityRef, reg, run } from "./core.ts";

// ── Undo / Redo / トランザクション(エンジンは ebd7b32 から MCP の編集を Undo に積む) ──
// ★MCP の書き込みは 1 呼び出し = 1 エントリ「AI: <method>」として積まれ、応答に undoEntry が載る。
//   まとまった編集は dx12_transaction_begin 〜 commit で 1 エントリにまとめ、失敗したら rollback で丸ごと戻す。
// ★undo / redo の onlyAi は既定 true: 一番上が人の編集なら戻さずに MODE_CONFLICT(3)+ ヒントを返す。
//   AI が undo を呼ぶのはほぼ「自分の直前の変更を取り消したい」ときで、人の作業を黙って消すと
//   人には理由が分からない(画面の外で AI がやったこと)。人の編集ごと戻すときだけ onlyAi:false を明示する。

reg(
  "dx12_undo",
  "Undo",
  "エディタの Undo スタックを 1 つ戻す(フレーム境界で適用される遅延応答)。"
    + "返り値 {undone, wasAi, onlyAi, undoable, willUndo, next:{undo, redo}}(互換で queuedUndo も残る)。スタックが空なら ok で undoable:false。"
    + "★MCP の編集は 1 呼び出し = 1 エントリ「AI: <method>」として積まれる(トランザクション中は「AI: <label>」の 1 エントリ)ので、"
    + "直前の自分の変更はそのまま undo で戻せる。"
    + "★onlyAi は既定 true: 一番上が人の編集なら戻さずに MODE_CONFLICT(3)+ ヒントを返す(人の作業を黙って消さない)。"
    + "人の編集ごと戻すときだけ onlyAi:false を明示すること。既定を信じて、MODE_CONFLICT が返ったら人に確かめる。"
    + "トランザクションが開いている / Play 中も MODE_CONFLICT(開いているなら rollback か commit で閉じてから)。",
  { onlyAi: z.boolean().optional().describe("true(既定)= 一番上が AI の編集のときだけ戻す / false = 人の編集でも戻す。") },
  {},
  ({ onlyAi }) => run(() => engine.call("undo", definedOnly({ onlyAi }))),
);

reg(
  "dx12_redo",
  "Redo",
  "取り消した操作をやり直す(遅延応答)。返り値 {redone, wasAi, onlyAi, redoable, willRedo, next:{undo, redo}}(互換で queuedRedo も残る)。"
    + "onlyAi は既定 true(一番上が人の操作なら MODE_CONFLICT)。トランザクションが開いている / Play 中は MODE_CONFLICT。",
  { onlyAi: z.boolean().optional().describe("true(既定)= AI の操作だけやり直す / false = 人の操作でもやり直す。") },
  {},
  ({ onlyAi }) => run(() => engine.call("redo", definedOnly({ onlyAi }))),
);

reg(
  "dx12_transaction_begin",
  "トランザクション開始",
  "以降の MCP の編集(生成・削除・複製・Transform・コンポーネント・親子・名前・色/PBR/テクスチャ・Lua プロパティ・地形/スカルプト)を"
    + " 1 つの Undo エントリ「AI: <label>」へまとめ始める。返り値 {open, label, entryName, undoDepth, idleTimeoutSec}。"
    + "★まとまった編集(部屋を 1 つ組む・レベルの一区画を直す)は begin 〜 commit で囲む。途中で失敗したら dx12_transaction_rollback で"
    + " begin 前へ丸ごと戻せる。入れ子は不可・Play 中は不可(MODE_CONFLICT)。開いている間の MCP の play / open_scene / new_scene / open_project は断られる。"
    + "人の Play・シーン切り替え・Ctrl+Z、または 600 秒放置で「確定扱い」に自動で閉じる(理由は dx12_transaction_status の lastClosed)。"
    + "dx12_batch は既定(atomic:true)でこれを自動で撃つ。",
  { label: z.string().optional().describe("Undo 履歴に出る名前(「AI: <label>」)。省略で transaction。") },
  {},
  ({ label }) => run(() => engine.call("transaction_begin", definedOnly({ label }))),
);

reg(
  "dx12_transaction_commit",
  "トランザクション確定",
  "begin 以降の MCP の編集を 1 エントリとして Undo に積んで閉じる(遅延応答)。"
    + "返り値 {committed, label, calls, pushed, entryName, humanEditsDuringTransaction, top}。以後 dx12_undo 1 回で丸ごと戻せる。"
    + "★応答が返る前に次の書き込みを送ると MODE_CONFLICT(内外どちらか決められないため)。開いていなければ MODE_CONFLICT + 直前に閉じた理由。",
  {},
  {},
  () => run(() => engine.call("transaction_commit", {})),
);

reg(
  "dx12_transaction_rollback",
  "トランザクション巻き戻し",
  "begin 以降の MCP の編集を全部逆順に戻して閉じる(遅延応答。消した物も guid ごと復元される)。"
    + "返り値 {rolledBack, label, calls, humanEditsDuringTransaction, top, sceneGeneration}。"
    + "★途中で人が編集していたら humanEditsDuringTransaction に数が出る(人の編集は戻さない)。Play 中は不可。",
  {},
  { destructiveHint: true },
  () => run(() => engine.call("transaction_rollback", {})),
);

reg(
  "dx12_transaction_status",
  "トランザクションの状態",
  "開いているか・中身・放置時間・直前に閉じた理由を返す。"
    + "{open, label?, calls?, callNames?, ageSec?, idleSec?, autoCloseInSec?, humanEditsDuringTransaction?, closePending, lastClosed:{label, reason, calls, agoSec}|null, top:{undo, redo}, undoDepth, redoDepth, mode}。"
    + "commit / rollback が「開いていない」で弾かれたら、lastClosed.reason(commit / rollback / 人の操作 / 放置)を見る。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("transaction_status", {})),
);

reg(
  "dx12_save_scene",
  "シーン保存",
  "現在のシーンを保存する。path は assets 相対(例 scenes/title.json)。省略時は現在開いてるシーンへ上書き。{path} を返す。",
  { path: z.string().optional().describe("assets 相対パス。例: scenes/title.json。省略で上書き保存。") },
  { idempotentHint: true },
  ({ path }) => run(() => engine.call("save_scene", { path })),
);

reg(
  "dx12_create_lua_component",
  "Luaコンポーネント作成",
  "Lua コンポーネント(.lua)を assets/components/ に作成する。書き込み前に構文検証され、エラーなら書かず error を返す。返り値 {path} を dx12_attach_lua_component の script に渡す。",
  {
    name: z.string().describe("コンポーネント名(拡張子・パス区切りなし)。例: Health"),
    code: z.string().describe("Lua コード全体。properties / OnStart / OnUpdate を含められる。"),
  },
  {},
  ({ name, code }) => run(() => engine.call("create_lua_component", { name, code })),
);

reg(
  "dx12_attach_lua_component",
  "Luaコンポーネントアタッチ",
  "Lua コンポーネントをエンティティにアタッチする。エディタ上では貼るだけで、実際の初期化/実行は Play 時(OnStart/OnUpdate)。script は assets 相対(assets 配下限定)。即時反映で ok を返す。",
  {
    ...entityRef,
    script: z.string().describe("assets 相対パス。例: components/Health.lua"),
  },
  {},
  ({ entity, name, script }) => run(() => engine.call("attach_lua_component", { entity, name, script })),
);

reg(
  "dx12_create_shader",
  "カスタムシェーダー作成",
  "カスタムシェーダー(.hlsl)を assets/shaders/ に作成/上書きする(MeshRenderer::shaderPath 割当用)。★Lua と違い書く前の静的検証はできない(DXC はファイルからしかコンパイルできない)ので、まず書き込んでから即コンパイルを試し、成否をそのまま返す(失敗しても書いたファイルは残る=直して dx12_create_shader を撃ち直す反復修正が前提)。エントリポイントは VSMain(vs_6_0)/PSMain(ps_6_0)固定、静的メッシュ用の共有 RootSignature(b0=PerObject mvp+model, b1=PerFrameの先頭部分, t0+s0=アルベド)に合わせて書く。返り値 {path, compiled, error?}。compiled=false なら error を読んで直し、再度このツールで書き戻す。エンティティへの割当は dx12_set_mesh_shader。",
  {
    name: z.string().describe("シェーダー名(拡張子・パス区切りなし)。例: ToonShade"),
    code: z.string().optional().describe("HLSL コード全体(VSMain/PSMain を含む)。dx12_read_shader で既存のテンプレ/ソースを読んでから書き換えるとよい。template を渡すなら省略できる。"),
    template: z.string().optional()
      .describe("雛形から起こす場合のテンプレート id（water / ocean / particle_ember。一覧は dx12_list_shader_templates）。code を省略したときだけ使われ、両方あれば code が勝つ。"),
  },
  {},
  // ★template を engine へ渡すこと。以前は destructure から漏れていて、
  //   「template だけ渡す」呼び方が missing 'code' で必ず失敗していた(説明文だけが嘘をついていた)。
  ({ name, code, template }) => run(() => engine.call("create_shader", { name, code, template })),
);

reg(
  "dx12_read_shader",
  "カスタムシェーダー読み取り",
  "既存のカスタムシェーダー(.hlsl)のソースをそのまま読む。dx12_create_shader は新規/上書き書き込み専用で読み取りが無いため、既存シェーダーを確認してから修正版を書き戻す編集ループに使う。{path, code, compiled}(compiled は直近の既知のコンパイル成否)。",
  { path: z.string().describe("assets/shaders 相対パス。例: ToonShade.hlsl") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("read_shader", { path })),
);

reg(
  "dx12_list_shader_templates",
  "シェーダー雛形一覧",
  "同梱のシェーダー雛形(water / ocean / particle_ember 等)を {name, title, summary} で列挙する。"
  + "★白紙から 200 行の HLSL を書くのは失敗率が高い。『水を作って』と言われたら、まずここから "
  + "dx12_create_shader(template:<name>) で【動くもの】を作って、そこから削っていくこと。"
  + "雛形はコンパイルが通ることが確認済みで、b0/b1 の契約にも合っている。",
  {},
  { readOnlyHint: true, idempotentHint: true },
  () => run(() => engine.call("list_shader_templates", {})),
);

reg(
  "dx12_describe_shader_contract",
  "シェーダーの契約を読む",
  "カスタムシェーダーが使える定数(b0/b1)・テクスチャ・入出力・注意点を kind ごとに返す。"
  + "★cbuffer は【オフセットで対応が決まる】ので、1 つでもズレるとコンパイルは通るのに値だけ化ける"
  + "(エラーが出ないので気付けない)。書き始める前に必ずこれを読むこと。"
  + "kind: 'mesh'(MeshRenderer 用・既定) / 'particle'(ParticleLayer::shaderPath 用。mesh とは別契約) / "
  + "'sprite'(Sprite2D 用) / 'screen'(CameraComponent::screenShaderPath 用の画面フィルタ)。"
  + "共有ヘッダ(UnoCustom.hlsli / UnoParticle.hlsli)を include すれば宣言を自分で書かなくてよい。",
  {
    kind: z.enum(["mesh", "particle", "sprite", "screen"]).optional()
      .describe("契約の種別。既定 'mesh'。メッシュ用の雛形を粒に貼っても動かない(別のルートシグネチャ)。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ kind }) => run(() => engine.call("describe_shader_contract", { kind })),
);
