// マルチプレイヤー(ローカルテストループ)とシーン編集の強化(カメラ・境界・向き・接地・階層)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import { engine, entityRef, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  マルチプレイヤー(ローカルテストループを AI から回す)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_net_status",
  "ネットワーク状態取得",
  "マルチプレイヤーの現在状態を返す。{available, role(Offline/Host/Client), isConnected, localClientId, tick, syncedEntityCount, players:[{id, rttMs, bytesSent, bytesReceived}], config:{tickRate, snapshotRate, maxPlayers, defaultPort}, testRole, testJoinAddress}。接続確認・RTT/帯域の観測・複製エンティティ数の検証に。★players はホスト側にしか出ない(ピア表は接続を受理した側だけが持つ)。クライアント側のプロセスで撃つと常に空配列になるので、接続確認は isConnected / localClientId を見ること。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("net_status", {})),
);

reg(
  "dx12_net_setup",
  "ネットワークテストロール設定",
  "次の dx12_play で自動 Host/Join するロールを設定する(ツールバーの Play ロールドロップダウンと同じ)。典型フロー: ①複製したいエンティティに set_component で networkIdentity + networkTransform を付ける → ②net_setup(role='host') → ③dx12_play → ④dx12_net_launch_test_client → ⑤dx12_net_status で players/RTT を確認。role='offline' で解除。",
  {
    role: z.enum(["host", "client", "offline"]).describe("host=リッスンサーバー / client=address へ接続 / offline=マルチプレイ無効。"),
    address: z.string().optional().describe("client 時の接続先 IP。省略で現状維持(既定 127.0.0.1)。"),
    port: z.number().int().optional().describe("client 時の接続先ポート。省略/0 でエンジン設定の defaultPort。"),
  },
  { idempotentHint: true },
  ({ role, address, port }) => run(() => engine.call("net_setup", { role, address, port })),
);

reg(
  "dx12_net_launch_test_client",
  "テストクライアント起動",
  "ホスト中に、同じエンジンをもう1プロセス起動して 127.0.0.1 へ自動接続させる(ツールバーの「テストクライアント起動」ボタンと同じ)。マルチプレイの複製・補間・RPC を1台で動作確認するのに使う。★ホストとして Playing 中でないとエラー(net_setup role=host → play が先)。フレーム境界で起動されるので、直後に dx12_step_frames(60) を挟んでから dx12_net_status で players を確認するとよい。",
  {},
  {},
  () => run(() => engine.call("net_launch_test_client", {})),
);

// ════════════════════════════════════════════════════════════════
//  シーン編集の強化(カメラ操作・境界・向き・接地・階層)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_get_editor_camera",
  "エディタカメラ取得",
  "シーンビューを描いてるカメラの状態を返す。{position, forward, target, targetDistance, yawDeg, pitchDeg, fovYDeg, aspect, nearZ, farZ, orthographic, overridden, mode}。"
  + "Editor 中はフライカメラ、Playing 中はゲームカメラ。"
  + "★target は position + forward * targetDistance。そのまま dx12_set_editor_camera {position, target} へ渡すと同じ yaw/pitch に戻るので、視点の保存 → 復元 → 読み返し検証がこれ 1 組でできる。"
  + "★overridden:true は dx12_set_editor_camera が Play 中のゲームカメラ同期を止めて視点を固定している状態(release で解除)。",
  {
    targetDistance: z.number().optional().describe("target を再構成する距離(m)。既定 10。0.001〜100000。被写体までの距離を入れると target が実際の注視点に近くなる。"),
  },
  { readOnlyHint: true },
  ({ targetDistance }) => run(() => engine.call("get_editor_camera", { targetDistance })),
);

reg(
  "dx12_set_editor_camera",
  "エディタカメラ設定",
  "シーンビューのカメラを任意視点に置く(focus_camera より自由。俯瞰・引き構図・特定アングルの確認用)。position で位置、target で注視点(yaw/pitch を自動逆算)、または yawDeg/pitchDeg を直接指定。"
  + "★Play 中も使える(以前は MODE_CONFLICT だったが解消済み)。Playing 中に呼ぶとアクティブな CameraComponent の毎フレーム同期を止めて視点を固定する(返り値 overridden:true)。"
  + "ゲームカメラへ返すには {release:true}。Play/Stop の遷移でも自動解除されるので、撮影用の固定を持ち越す事故は無い。"
  + "この後 dx12_screenshot_final でその視点の最終画が撮れる(dx12_screenshot_from が一発でやる)。",
  {
    position: v3().optional().describe("カメラ位置 [x,y,z]。省略で現在位置のまま。"),
    target: v3().optional().describe("注視点 [x,y,z]。指定すると yaw/pitch を自動計算(yawDeg/pitchDeg より優先)。"),
    yawDeg: z.number().optional().describe("Y軸回転(度)。target 指定時は無視。"),
    pitchDeg: z.number().optional().describe("X軸回転(度、±89 でクランプ)。target 指定時は無視。"),
    release: z.boolean().optional().describe("true で Play 中のカメラ固定(overridden)を解除してゲームカメラへ返す。他の引数は無視され {released:true, overridden:false} が返る。"),
  },
  { idempotentHint: true },
  ({ position, target, yawDeg, pitchDeg, release }) =>
    run(() => engine.call("set_editor_camera", { position, target, yawDeg, pitchDeg, release })),
);

reg(
  "dx12_get_bounds",
  "ワールドAABB取得",
  "エンティティのワールド空間 AABB を返す。{min, max, center, size, hasMesh}。回転・スケール・親子変換込み。「テーブルの上に置く」「壁にぴったり寄せる」等、配置座標を数値で決める時の基礎情報。includeChildren=true で子孫も含めた全体境界。メッシュ無し(ライト等)は位置の点(size=0)。"
    + "★perSubmesh:true でサブメッシュ内訳(名前/マテリアル名/三角形数/ローカル・ワールド AABB)も返る = 「モデルの一部だけ変な位置に飛んでいる。どの部品か」を 1 回で特定できる。",
  {
    ...entityRef,
    includeChildren: z.boolean().optional().describe("true で子孫エンティティの AABB も合成する(モデルルートが empty の時に有効)。"),
    perSubmesh: z.boolean().optional().describe(
      "true でサブメッシュ 1 個ずつの内訳を submeshes[] に返す。既定 false。"
      + "各要素は {index, name, materialName, triangles, localMin/localMax/localSize, worldMin/worldMax/worldCenter/worldSize}。"
      + "index は dx12_pick が返す submeshIndex と同じ並び(= MeshRenderer.meshes の順)なので突き合わせられる。"
      + "★glTF/FBX の JSON 内の並びとは一致しない(エンジンがノード単位に展開するため)。だから name/materialName で照合すること。"
      + "worldSize / worldCenter が他と桁違いの部品が『飛んでいる』もの。largestSubmesh に最大の index が入る。"),
  },
  { readOnlyHint: true },
  ({ entity, name, includeChildren, perSubmesh }) =>
    run(() => engine.call("get_bounds", { entity, name, includeChildren, perSubmesh })),
);

reg(
  "dx12_look_at",
  "エンティティを向ける",
  "エンティティを目標(座標 or 別エンティティ)の方へ回転させる(+Z が正面の想定で rotation Euler を書く)。カメラを被写体へ、敵をプレイヤーへ、砲台を目標へ等。upright=true で水平回転のみ(ピッチ 0=キャラ向け)。★rotation はローカル値なので親が回転してると厳密なワールド向きからずれる。",
  {
    ...entityRef,
    target: v3().optional().describe("目標のワールド座標 [x,y,z]。targetEntity/targetName と排他。"),
    targetEntity: z.number().int().optional().describe("目標エンティティ id。"),
    targetName: z.string().optional().describe("目標エンティティ名(完全一致)。"),
    upright: z.boolean().optional().describe("true でピッチ 0(水平回転のみ)。キャラや車など直立させたい時。"),
  },
  {},
  ({ entity, name, target, targetEntity, targetName, upright }) =>
    run(() => engine.call("look_at", { entity, name, target, targetEntity, targetName, upright })),
);

reg(
  "dx12_snap_to_ground",
  "接地(下の面に置く)",
  "エンティティを直下の床/他メッシュの天面に置く(Editor 中でも動く)。既定は三角形単位の精密レイキャストで真下の【実際の面】に乗せる(斜面・階段・地形の起伏に追従)。真下に三角形が無ければ AABB の天面判定へフォールバックし、それも無ければ y=0 平面へ。offset で浮かせられる。spawn した物が空中に浮いてる/めり込んでる時の修正に。{groundY, movedBy, position, method, groundEntityId?} が返る(method=raycast なら精密、aabb ならフォールバック)。",
  {
    ...entityRef,
    offset: z.number().optional().describe("接地面からの追加オフセット(m)。既定 0。"),
    // エンジンは以前から precise を受けていたのにスキーマに無く、渡しても黙って捨てられていた。
    precise: z.boolean().optional().describe("三角形単位の精密レイキャストで接地面を決める。既定 true。false にすると旧来の AABB 天面判定だけになる(地形の上で山頂の高さに吸い付く)。"),
  },
  { idempotentHint: true },
  ({ entity, name, offset, precise }) =>
    run(() => engine.call("snap_to_ground", { entity, name, offset, precise })),
);

reg(
  "dx12_get_hierarchy",
  "シーン階層ツリー取得",
  "シーン全体の親子ツリーを返す。{roots:[{entityId, name, children:[...]}], count, sceneGeneration}。dx12_list_entities のフラット一覧と違い構造(どれが誰の子か)が分かる。プレハブ/モデルの内部構造確認やシーン整理に。ノードが既定 20000 個を超えると打ち切り、truncated:true と nextRootOffset を付ける(rootOffset で続き・limit:0 で無制限・root で部分木だけ)。",
  {
    limit: z.number().int().min(0).optional().describe("返すノード数の上限(既定 20000・0 で無制限)。超えたら truncated:true と nextRootOffset。"),
    rootOffset: z.number().int().min(0).optional().describe("ルートの何番目から返すか(既定 0。truncated 時の nextRootOffset を渡して続きを取る)。"),
    root: z.union([z.number().int(), z.string()]).optional().describe("このエンティティ(id か名前)の部分木だけを返す。"),
    maxDepth: z.number().int().min(0).max(64).optional().describe("辿る深さの上限(既定 64)。深さで切った節は childCount と collapsed:true を持つ。"),
  },
  { readOnlyHint: true },
  ({ limit, rootOffset, root, maxDepth }) => run(() => engine.call("get_hierarchy", { limit, rootOffset, root, maxDepth })),
);
