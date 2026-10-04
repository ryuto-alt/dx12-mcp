// ランタイム物理検証(raycast / overlap)とコンテンツ制作ヘルパー
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { v3 } from "../sceneTools.ts";
import { z } from "zod";
import path from "node:path";
import { engine, entityRef, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  ランタイム物理検証(raycast/overlap/velocity) — 全て同期・読み取り系。
//  bodies は Play 中のみ登録される(RegisterBody は Play 開始/loadScene 時)。
//  Editor 中に呼んでもエラーにはならず hit=false / entities=[] / velocity=[0,0,0] が返る。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_raycast",
  "レイキャスト",
  "origin から direction 方向へ物理レイを飛ばし、最初にヒットしたボディを調べる。★Playing 中のみ意味のある結果(Editor 中は body 未登録なので hit=false)。{hit, distance?, point?, normal?, entityId?, name?}。normal はヒット面の真の法線(Jolt の GetWorldSpaceSurfaceNormal)。当たり判定確認・地面/壁の検出・ラインオブサイトの確認に。",
  {
    origin: v3().describe("[x,y,z] レイの始点。"),
    direction: v3().describe("[x,y,z] レイの方向(正規化不要。エンジン側で正規化される)。"),
    maxDistance: z.number().optional().describe("最大距離(既定 1000)。"),
  },
  { readOnlyHint: true },
  ({ origin, direction, maxDistance }) =>
    run(() => engine.call("raycast", { origin, direction, maxDistance })),
);

reg(
  "dx12_overlap_box",
  "ボックス範囲の物理クエリ",
  "center を中心とする AABB(半幅 halfExtents)と重なっている物理ボディのエンティティを列挙する。★Playing 中のみ意味のある結果。{entities:[{entityId,name}], count}。dx12_query_entities の box(Transform.position ベースの単純判定)とは違い、実際のコライダー形状で判定する。",
  {
    center: v3().describe("[x,y,z]"),
    halfExtents: v3().describe("[x,y,z] AABB の半幅。"),
    maxResults: z.number().int().optional().describe("最大取得数(既定 32、上限 256)。"),
  },
  { readOnlyHint: true },
  ({ center, halfExtents, maxResults }) =>
    run(() => engine.call("overlap_box", { center, halfExtents, maxResults })),
);

reg(
  "dx12_overlap_sphere",
  "球範囲の物理クエリ",
  "center を中心とする半径 radius の球と重なっている物理ボディのエンティティを列挙する。★Playing 中のみ意味のある結果。{entities:[{entityId,name}], count}。爆発範囲・索敵範囲・トリガー代替の確認に。",
  {
    center: v3().describe("[x,y,z]"),
    radius: z.number().describe("半径。"),
    maxResults: z.number().int().optional().describe("最大取得数(既定 32、上限 256)。"),
  },
  { readOnlyHint: true },
  ({ center, radius, maxResults }) =>
    run(() => engine.call("overlap_sphere", { center, radius, maxResults })),
);

reg(
  "dx12_get_physics_state",
  "物理ランタイム状態取得",
  "エンティティの物理ランタイム状態(速度・接地判定)を読む。{entityId, hasRigidBody, velocity:[x,y,z], hasCharacterController, isGrounded}。★Playing 中のみ意味のある結果(Editor 中は velocity=[0,0,0]/isGrounded=false)。RigidBody が無ければ velocity は常に [0,0,0]。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_physics_state", { entity, name })),
);

reg(
  "dx12_audio_state",
  "音の状態を観測",
  "今鳴っている音とミキサーの状態を数値で読む(AI が音を観測できる唯一の口)。{device, listener, limits, buses[](name / volume / mute / lowpass / peakDb / rmsDb / peakNowDb …), voices[](clip / bus / gainDb / distance / occlusion / virtual / virtualReason / priority / positionSec …), bgm, snapshot, reverb, streams}。dB は dBFS で、無音は -120(-inf は JSON に載らないため)。★メーターはフェーダー後の値で、1 フレームに直近 10ms しか見ないので瞬間的なピークは取りこぼし得る。「音が鳴らない」は voices に居るか(居なければ再生されていない)→ virtual(遠い・小さいので仮想化中)→ バスの mute / volume の順に見る。音声デバイスが無い環境でも落ちず device に理由が出る。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("audio_state", {})),
);

reg(
  "dx12_brain_state",
  "ゲームAI(Brain)の状態を観測",
  "Brain コンポーネント(ゲーム AI)の中身を読む。entity / name を省くと Brain を持つエンティティの一覧(今の行動つき)。指定するとその 1 体の {action, decision.actions(行動ごと・考慮事項ごとの得点の内訳=なぜその行動を選んだか), history, blackboard, perception(見えている相手・最後に見た位置・聞いた音), movement}。★Brain は Play 中だけ動くので、実行時の状態は Play 中(dx12_step_frames の deterministic で止めている間も含む)にしか無い。「敵が変な行動をする」は decision.actions の得点から読む。読み取り専用。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("brain_state", { entity, name })),
);

// ════════════════════════════════════════════════════════════════
//  コンテンツ制作ヘルパー拡充
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_read_lua_component",
  "Luaコンポーネント読み取り",
  "既存の .lua コンポーネントのソースをそのまま読む。dx12_create_lua_component は新規/上書き書き込み専用で読み取りが無かったため追加。既存スクリプトを確認してから修正版を dx12_create_lua_component で書き戻す、という編集ループに使う。{path, code}。",
  { path: z.string().describe("assets 相対パス。例: components/Health.lua") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("read_lua_component", { path })),
);

reg(
  "dx12_create_prefab",
  "プレハブ化",
  "エンティティ(+子孫)を .prefab として保存する(Hierarchy 右クリック「プレハブにする」と同じ処理)。path 省略時は assets/prefabs/<エンティティ名>.prefab に保存(重複時は連番)。{path, entityId}。entity(id) か name 指定。",
  {
    ...entityRef,
    path: z.string().optional().describe("assets 相対パス(.prefab 必須)。省略時は assets/prefabs/<name>.prefab。"),
  },
  {},
  ({ entity, name, path }) => run(() => engine.call("create_prefab", { entity, name, path })),
);
