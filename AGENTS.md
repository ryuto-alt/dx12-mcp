# DX12 MCP サーバ — AI エージェント運用ガイド

Claude Code と Codex の両方が読む運用ルール集。
このファイルを読んだら **「最重要ルール」から先に把握する** こと。

---

## ★ 最重要ルール: entityId は「同じ sceneGeneration の間だけ」安定。

`dx12_create_entity` / `dx12_spawn_model` などの遅延同期ツールは、
フレーム境界での処理完了後に **本物の `entityId`** を直接返す。
**同じシーンを編集している間** はその id をそのまま使い続けてよい(毎回 list で探し直さない)。

```
# 正しいパターン(同一シーン編集中)
result = dx12_create_entity(type:"box", name:"Floor")
# → {entityId: 42, name: "Floor", sceneGeneration: 7}

dx12_set_transform(entity: 42, position:[0,-1,0])   ← 返ってきた entityId をそのまま使う
```

### ただし id が変わる境界がある → `sceneGeneration` を見る

`dx12_stop`(Play→Editor) / `dx12_open_scene` / `dx12_new_scene` は **シーンを丸ごと作り直す**ため、
**全 entity id が変わり** `sceneGeneration` が +1 される。これらの後に古い id を使うと
`NOT_FOUND(1)`(「invalid entity id」)になる。レスポンスの `sceneGeneration` が前回と
変わっていたら、id を取り直すこと。

> 特に **`dx12_stop` の後**は要注意。返ってくる `sceneGeneration` が Play 前と変わる。

### id を持ちたくない / Stop をまたぐなら **name 指定**が使える

エンティティを取る編集系ツール(`dx12_set_transform` / `dx12_set_component` / `dx12_get_entity` /
`dx12_set_pbr` / `dx12_select_entity` / `dx12_delete_entity` / `dx12_set_lua_property` 等)は
`entity`(id) の代わりに `name`(完全一致)でも指定できる。Stop をまたいでも名前は不変なので、
「id が変わって invalid になる」問題を避けられる。

```
dx12_set_transform(name:"Player", position:[0,1,0])   # id を知らなくてよい
dx12_get_lua_component_state(name:"MainCamera")
```

※ `dx12_rename_entity` の `name` は **新しい名前** の意味なので、対象指定は `entity`(id) のみ。

旧仕様の `{queued:true}` はもう返ってこない。

---

## 典型ワークフロー

### 1. コンポーネントを設定する前に describe_components で確認

```
dx12_describe_components({component: "pointLight"})
# → fields: [{name:"color",type:"vec3",...}, {name:"intensity",type:"float",...}, ...]

dx12_set_component({entity: 42, component: "pointLight", data: {color:[1,0.8,0.5], intensity:3.0, range:8.0}})
```

### 2. エンティティ生成 → 配置 → コンポーネント設定

```
# 箱を作る
r = dx12_create_entity(type:"box", name:"RedBox")
# → {entityId: 55, ...}

# 配置
dx12_set_transform(entity: 55, position:[2,0,0], scale:[1,2,1])

# 色を付ける(PBR)
dx12_set_pbr(entity: 55, metallic:0.0, roughness:0.8)

# 基本色(頂点色)を付ける
dx12_set_color(entity: 55, color:[0.9,0.2,0.2])

# ライトを追加
dx12_set_component(entity: 55, component:"pointLight", data:{color:[1,0,0], intensity:5.0, range:10.0})
```

### 2b. 1コールで生成＋整形(おすすめ。足場・壁・コイン)

`dx12_spawn_box` / `dx12_spawn_sphere` は create_entity→set_transform→set_pbr→set_color を内部でまとめて実行する。

```
# 足場(薄い箱)
dx12_spawn_box(name:"Platform_1", position:[0,0,0], scale:[4,0.5,4], color:[0.6,0.6,0.7])

# コイン(金色の薄い円盤 + tag 'coin')
dx12_spawn_coin(name:"Coin_1", position:[0,2,0])

# ボール
dx12_spawn_sphere(name:"Ball", position:[0,5,0], color:[0.2,0.5,1.0], metallic:0.0, roughness:0.4)
```
※ Playing 中は生成系が MODE_CONFLICT。先に `dx12_stop()`。コインの回転/取得判定は Lua か trigger で付ける。

### 3. モデルをスポーン

```
r = dx12_spawn_model(path:"models/enemy.glb", position:[0,0,5], name:"Enemy_01")
# → {entityId: 88, name: "Enemy_01", sceneGeneration: 12}

dx12_set_transform(entity: 88, rotation:[0,180,0])
```

### 4. Lua スクリプトを貼る

```
dx12_create_lua_component(name:"Rotate", code:[[
  function Update(dt)
    local t = entity:GetTransform()
    t.rotation.y = t.rotation.y + 30 * dt
    entity:SetTransform(t)
  end
]])
# → {path: "components/Rotate.lua"}

dx12_attach_lua_component(entity: 88, script:"components/Rotate.lua")
```

### 4b. カスタムシェーダーを作ってメッシュに割り当てる

```
dx12_create_shader(name:"ToonShade", code:[[
Texture2D    g_albedo  : register(t0);
SamplerState g_sampler : register(s0);

cbuffer PerObjectConstants : register(b0) { float4x4 mvp; float4x4 model; };
cbuffer PerFrameConstants  : register(b1) {
    float4x4 view; float4x4 proj;
    float3 lightDir; float time;
    float3 lightColor; float ambientStrength;
};

struct VSInput { float3 position:POSITION; float3 normal:NORMAL; float4 color:COLOR;
                 float2 texCoord:TEXCOORD0; float4 tangent:TANGENT;
                 uint4 boneIndices:BLENDINDICES; float4 boneWeights:BLENDWEIGHT; };
struct PSInput { float4 positionSV:SV_POSITION; float3 worldNormal:NORMAL;
                 float4 color:COLOR; float2 texCoord:TEXCOORD0; };

PSInput VSMain(VSInput input) {
    PSInput o;
    o.positionSV = mul(float4(input.position,1.0f), mvp);
    o.worldNormal = normalize(mul(input.normal,(float3x3)model));
    o.color = input.color; o.texCoord = input.texCoord;
    return o;
}
float4 PSMain(PSInput input) : SV_TARGET {
    float4 albedo = g_albedo.Sample(g_sampler, input.texCoord) * input.color;
    float ndotl = max(dot(normalize(input.worldNormal), normalize(-lightDir)), 0.0f);
    float band = ndotl > 0.5 ? 1.0 : (ndotl > 0.15 ? 0.5 : 0.15);   // トゥーン: 3段階に量子化
    return float4(albedo.rgb * lightColor * band, albedo.a);
}
]])
# → {path:"ToonShade.hlsl", compiled:true}
# compiled:false なら error を読んで直し、dx12_create_shader を撃ち直す(ファイルは残るので反復修正できる)

dx12_set_mesh_shader(entity: 88, shaderPath:"ToonShade.hlsl")
# → {entityId:88, shaderPath:"ToonShade.hlsl", skinnedFallbackWarning:false}

dx12_focus_and_screenshot(entity: 88)   # 見た目を確認
```
※ 静的メッシュのみ有効。スキンドメッシュ(SkeletalAnimation持ち)は `skinnedFallbackWarning:true` が返り既定Forwardへ自動フォールバックする。
既存シェーダーの読み直しは `dx12_read_shader(path:"ToonShade.hlsl")`。詳細は [`docs/AUTHORING.md`](../../docs/AUTHORING.md) の「6. カスタムシェーダー」。

### 5. Play/Stop して確認

```
dx12_play()
# → {mode:"Playing", sceneGeneration:13}

# ゲームが動いているのを確認したら止める
dx12_stop()
# → {mode:"Editor", sceneGeneration:13}
```

### 6. 変更をスクショで確認(検証ループ)

```
dx12_focus_and_screenshot(entity: 88)   # focus_camera + screenshot を自動でやってくれる
dx12_get_log(lines:30)                  # エラー/警告を確認
```

### 7. 保存

```
dx12_save_scene()   # 現在のシーンへ上書き
```

---

## batch でまとめ作成(往復削減)

複数のエンティティや設定を一気に送る場合は `dx12_batch` を使う。

```json
{
  "ops": [
    {"method": "create_entity", "params": {"type":"box", "name":"Wall_N", "position":[0,0,-5]}},
    {"method": "create_entity", "params": {"type":"box", "name":"Wall_S", "position":[0,0,5]}},
    {"method": "create_entity", "params": {"type":"box", "name":"Wall_E", "position":[5,0,0]}},
    {"method": "create_entity", "params": {"type":"box", "name":"Wall_W", "position":[-5,0,0]}}
  ],
  "stopOnError": true
}
```

返り値の `results[i].result.entityId` にそれぞれの id が入る。

---

## Lua スクリプトの検証(API 確認 / プロパティ / 入力シミュレーション)

MCP で見えるコンポーネントと Lua から読める API はズレる。Lua を書く前に確認する:

```
dx12_describe_lua_api()   # entity/transform/scene/input/camera/physics/... の使える API 一覧
# → entity から直接読めるのは transform だけ。boxCollider 等は entity.<key> では nil。
```

Lua コンポーネントのプロパティ(.lua の properties 宣言)を MCP から読み書きできる:

```
dx12_get_lua_component_state(name:"MainCamera")
# → {scriptPath, properties:[{name:"height", type:"float", value:3.0, isOverride:false}, ...]}
dx12_set_lua_property(name:"MainCamera", key:"height", value:5.0)
# Playing 中なら即再注入(OnStart 再実行)、Editor 中は保存して次 Play で反映。
```

### ゲーム画面の確認

- `dx12_screenshot_game_view` は **Editor 中でも Play せずにアクティブなゲームカメラの絵**を返す
  (内部で1フレームだけゲームカメラに切り替えて撮影→編集カメラに復元)。カメラ配置・構図の確認に最適。
  アクティブな CameraComponent が無いとエラー(`camera` の `isActive=true` にする)。
- `dx12_screenshot` は **Playing 中はゲームカメラの絵**、Editor 中はエディタのフライカメラ。
  `dx12_focus_and_screenshot` は寄せて撮る用(エディタカメラ)。
- `dx12_project_world_to_screen(name:"Player")` で player のワールド座標を画面ピクセルへ投影。
  `{x, y, visible, depth, width, height}`。`x≈width/2, y≈height/2` なら画面中央。`visible=false` は画面外。

### 入力シミュレーション(当たり判定/操作の回帰確認)

Lua の `input:isKeyDown` / `keyDown()`(prelude)に効く。`isAsyncKeyDown` 系には効かない。Playing 中に使う。

```
dx12_play()
dx12_key_down(key:"D")            # 右移動を押しっぱなし
dx12_step_frames(frames:30)       # 30 フレーム進めてから応答(入力が効く)
dx12_get_entity(name:"Player")    # 右に動いたか / Platform 側面に当たったか確認
dx12_key_up(key:"D")
dx12_key_press(key:"SPACE")       # ジャンプ(1フレームだけ押す=isKeyPressed が1回立つ)
dx12_step_frames(frames:60)
dx12_project_world_to_screen(name:"Player")
```

key は VK 整数か名前(`"W"`,`"D"`,`"SPACE"`,`"UP"`,`"F1"` 等)。
`dx12_step_frames` は決定論ステッパではない(各フレーム dt は実時間)。frames は 1..600。

---

## 物理ランタイム検証(raycast/overlap/velocity)

`dx12_raycast` / `dx12_overlap_box` / `dx12_overlap_sphere` / `dx12_get_physics_state` は
**Playing 中のみ意味のある結果を返す**(RigidBody は Play 開始時にしか物理へ登録されない)。
Editor 中に呼んでもエラーにはならず、hit=false / entities=[] / velocity=[0,0,0] が返るだけ。

```
dx12_play()
dx12_key_down(key:"D")
dx12_step_frames(frames:30)
dx12_get_physics_state(name:"Player")          # {velocity, isGrounded, ...}
dx12_raycast(origin:[0,5,0], direction:[0,-1,0], maxDistance:10)  # 足元の地面判定
dx12_overlap_sphere(center:[0,1,0], radius:2)  # 索敵範囲に何がいるか
dx12_key_up(key:"D")
dx12_stop()
```

`dx12_query_entities(box:...)` は Transform.position ベースの単純判定、
`dx12_overlap_box`/`dx12_overlap_sphere` は実際のコライダー形状での物理判定。用途で使い分ける。

---

## Lua 即時実行(eval) — デバッグの近道

`dx12_eval_lua` は任意の Lua を Lua state でその場実行する。スクリプトを書いてアタッチせずに
値を確認・書き換えできる。`dx12_describe_lua_api` にある全バインディングがそのまま使える。

```
dx12_eval_lua(code:"local e = scene:findEntity('Player'); return e.transform.position.y")
# → {result: "3.5"}

dx12_eval_lua(code:"local e = scene:findEntity('Player'); e.transform.position.y = 10")
# → {result: ""}  (return してないので result は空)
```

★ `print()` は捕捉されない。デバッグ出力は `log(msg)` を使うと `dx12_get_log` に出る。
物理系バインディング(`physics:*`)は Playing 中でないと効果が無い(bodies が未登録のため)。

---

## ポストプロセス/SSAO の調整

```
dx12_get_post_process()                                   # 現状値を確認
dx12_set_post_process(vignetteOn:true, vignette:0.6,
                       tintOn:true, tint:[1.0,0.95,0.85])  # 暖色ビネット
dx12_focus_and_screenshot(name:"MainCamera")               # 見た目を確認
```

各エフェクトは `<name>On`(bool) を true にしないとパラメータを変えても反映されない。

---

## シーン検証パイプライン(validate)

`dx12_validate_scene` はヘッドレスの `--validate` を子プロセスとして実行し、参照切れ
(スクリプト不在・entity参照未解決・Trigger target 不明・LoadScene 先不在)を検出する。
編集後は毎回これで確認してから Play するとよい。

```
dx12_save_scene()
dx12_validate_scene()
# → {pass:false, report:"...\n[ERROR] unresolved entity reference: \"Boss\" (trigger action target of WinZone)\n..."}
```

---

## テクスチャ / アニメーション / マルチプレイヤー(v0.5.0 追加)

### テクスチャ割当
```
dx12_list_assets(type:"texture")                       # パスを探す
dx12_set_texture(name:"Wall", path:"textures/brick.png")            # albedo(既定)
dx12_set_texture(name:"Wall", path:"textures/brick_n.png", slot:"normal")
dx12_set_texture(name:"Wall", path:"")                 # 解除(Material 既定に戻す)
```
Inspector の D&D と同じインスタンス単位 override。Material は共有なので他インスタンスに波及しない。
スプライトのテクスチャは `dx12_set_component(component:"sprite2d", data:{texturePath:...})` の方。

### スケルタルアニメーション
```
dx12_get_anim_state(name:"Player")                     # → {clips:["Idle","Walk","Run"]}
dx12_play_anim(name:"Player", clipName:"Run", blend:0.2)
```
アニメーションの時間進行は Play 中。クリップはモデルロード時に読み込まれたもののみ。

### マルチプレイヤーのローカルテストループ
```
# ①複製したいエンティティに複製マークを付ける(Editor 中)
dx12_set_component(name:"Player", component:"networkIdentity", data:{})
dx12_set_component(name:"Player", component:"networkTransform", data:{syncPosition:true})
# ②ロール設定 → Play(EnterPlayMode が自動で Host する)
dx12_net_setup(role:"host")
dx12_play()
# ③2個目のエンジンプロセスを起動して自動接続させる
dx12_net_launch_test_client()
dx12_step_frames(120)                                  # 接続待ち
# ④観測
dx12_net_status()                                      # → players:[{id,rttMs,...}], syncedEntityCount
```
`net_launch_test_client` はホスト Playing 中のみ。終わったら `dx12_stop`(ロールは `net_setup(role:"offline")` で解除)。

---

## シーン編集の強化 + アセット操作(v0.6.0 追加)

### 数値で配置を決める(get_bounds が基礎)

「上に置く」「隣に並べる」は目分量でなく AABB から計算する:

```
dx12_get_bounds(name:"Table")
# → {min:[-1,0,-0.5], max:[1,0.8,0.5], center:[0,0.4,0], size:[2,0.8,1], hasMesh:true}
dx12_create_entity(type:"box", name:"Cup", position:[0, 0.9, 0])   # 天面(max.y=0.8)より上へ
dx12_snap_to_ground(name:"Cup")                                     # 底面をテーブル天面へぴったり
```

浮いてる/めり込んでる物の修正は `dx12_snap_to_ground` 一発。床が無ければ y=0 へ落ちる。
向きは `dx12_look_at(name:"Turret", targetName:"Player")`(upright:true で水平回転のみ)。

### 任意視点で見る(検証ループの強化)

```
dx12_screenshot_from(position:[0, 30, -30], target:[0, 0, 0])   # 俯瞰でレイアウト全体
dx12_screenshot_from(position:[0, 1.7, -5], target:[0, 1.7, 0]) # プレイヤー目線の高さ
```
戻す時は事前に `dx12_get_editor_camera` で保存 → `dx12_set_editor_camera` で復元。

### 一括配置(scatter)

```
# 木を 30 本、シード付き乱数で自然にばらまく(同 seed で再現可能)
dx12_scatter(model:"models/tree.glb", count:30, area:[-20,-20,20,20],
             seed:7, randomYaw:true, scaleRange:[0.8,1.3], snapToGround:true)
# コインを等間隔グリッドで敷く
dx12_scatter(type:"box", count:25, area:[-5,-5,5,5], placement:"grid", namePrefix:"Coin")
```
1体ずつフレーム境界で生成するので多数配置は時間がかかる。★Editor 限定。

### アセットの取り込み・確認

```
dx12_import_asset(sourcePath:"C:/Users/me/Downloads/rock", destPath:"models/rock", overwrite:false)
# → .gltf は .bin/テクスチャを同階層参照するのでフォルダごと import する

dx12_asset_info(path:"models/rock/rock.gltf")
# → {totalFaces, aabbMin/Max, hasSkeleton, animations, ...} spawn 前にサイズ・アニメ有無を確認

dx12_preview_model(path:"models/rock/rock.gltf")   # 見た目を画像で確認(シーンは変更されない)
dx12_view_texture(path:"textures/rust.dds")         # dds/tga も PNG 変換して見られる
```

### アセット整理の注意

`dx12_move_asset` / `dx12_delete_asset` は**シーン/プレハブ内の参照パスを自動更新しない**。
参照中のアセットを動かす/消すとロードが壊れる。`dx12_list_entities(verbose:true)` →
`dx12_get_entity` で modelPath / texturePath を確認してから触ること。

---

## MODE_CONFLICT(3): Playing 中は生成系が失敗する

Playing 中に `create_entity` / `spawn_model` / `delete_entity` / `open_scene` 等を呼ぶと
`error_code=3(MODE_CONFLICT)` が返る。

**対処**: 先に `dx12_stop()` で Editor モードに戻してから再試行する。

```
dx12_get_mode()         # 現在のモードを確認
# → {mode:"Playing"}

dx12_stop()             # 先に止める
dx12_create_entity(...)  # その後に生成
```

---

## よくある間違い

### transform は remove 不可

`dx12_remove_component(component:"transform")` は常にエラー(core 不変)。
transform の変更は `dx12_set_transform` または `dx12_set_component(component:"transform", data:{...})` を使う。

### meshRenderer は set/remove 不可

メッシュは `dx12_spawn_model` でモデルごとスポーンする。
既存の meshRenderer を差し替えたい場合は `delete_entity` → `spawn_model` の手順で。

### tags は文字列配列で渡す

jsonKey は `tags`(複数形)。`tag` は無効で `UNKNOWN_COMPONENT(6)` になる。

```
# 正しい
dx12_set_component({entity:42, component:"tags", data:["enemy","dynamic"]})

# 間違い(キー名 / オブジェクト形式)
dx12_set_component({entity:42, component:"tag",  data:["enemy"]})        # tag は無効
dx12_set_component({entity:42, component:"tags", data:{tags:["enemy"]}}) # data は配列で渡す
```

### rigidBody と characterController は排他

同一エンティティに両方はアタッチできない。どちらか一方を選ぶ。

### quaternion と rotation は同時に指定しない

`dx12_set_transform` で `rotation`(Euler度) と `quaternion` の両方を送った場合の動作は不定。
どちらか一方だけ使う。

### idempotency_key はリトライ時だけ使う

通常の生成に付ける必要はない。タイムアウト等でリトライするときに同じキーを再利用して
重複を防ぐための仕組み。

---

## Stop / シーンを開き直したら entityId を取り直す(or name 指定)

`dx12_stop` / `dx12_open_scene` / `dx12_new_scene` の後は以前の `entityId` は無効になる
(`sceneGeneration` が +1 される)。古い id を使うと `NOT_FOUND(1)` が返る。
各レスポンスの `sceneGeneration` を見て、変わっていたら引き直す:

```
dx12_ping()             # sceneGeneration を確認
dx12_list_entities()    # 現在のエンティティ一覧を再取得
# または最初から name 指定で操作する(Stop をまたいでも変わらない):
dx12_set_transform(name:"Player", position:[0,1,0])
```

※ `error_code=4 (STALE_SCENE)` は将来用に予約されているが現状は未送出。今は上記のとおり
`NOT_FOUND(1)` + `sceneGeneration` の変化で判断する。`invalid entity id` のエラー文には
「list し直すか name 指定で」というヒントが入る。

### Stop 後に list_entities が 0 件になったら
スナップショット復元の失敗時は **自動でディスク上の現在シーンから読み直す**ようになった
(以前は空のままだった)。それでも 0 件なら `dx12_get_log` を確認:
`snapshot restore failed; reloading from disk` が出ていれば自動復旧済み、
`scene is empty after Stop` が出ていればディスクにも有効なシーンが無い状態
(未保存の新規シーンを Play→Stop した等)。その場合は `dx12_open_scene` で開き直す。

---

## ゲーム内 UI を組む（タイトル画面・設定画面・HUD）

基本ループ: **設計方針 → 制約付き生成 → 自動監査 → 見た目確認 → 保存** を回す。

新規画面は原則として次の順で作る:

1. `dx12_ui_design_brief(genre, screen)` で画面目的に合う構図とアンチパターンを得る
2. `dx12_ui_compose(blueprint)` の `dock` / `stack` / `grid` を使って骨格を作る
3. `dx12_ui_audit(strictness:"strict")` が pass するまで entityId 付き issue を修正する
4. `dx12_ui_screenshot()` で視線誘導・作品固有性・余白を目視する
5. `dx12_save_scene()`

`ui_audit` の pass は美しさを保証しない。数値的な崩れを除いた後、スクリーンショットで
「主役が1つか」「全要素が同じ角丸カードになっていないか」「青紫ネオン/グラデ/影を
無意味に重ねていないか」「作品固有の構図か」を必ず判断する。

手動で細部を組む場合の基本:

1. `dx12_create_entity(type: "ui_canvas")` — UI ルート。既にあれば省略（`dx12_ui_tree` で確認）
2. `dx12_create_entity(type: "ui_button", name: "StartButton", parent: <canvasId>)` —
   ボタンは背景+ラベル子つきで生成される（`ui_slider` / `ui_toggle` / `ui_scrollview` / `ui_image` / `ui_text` も同様）
3. `dx12_set_component(component: "uiRect", data: {anchorMin:[0.5,0.5], anchorMax:[0.5,0.5], offsetMin:[-110,-32], offsetMax:[110,32]})` — 配置。
   解決式は `rectMin = parentMin + parentSize*anchorMin + offsetMin`。全面ストレッチ = anchor [0,0]-[1,1] + offset 0
4. `dx12_ui_tree` — 全要素の解決済み矩形（キャンバス空間 px）を数値で確認。重なり/はみ出しはここで分かる
5. `dx12_ui_screenshot` — エディタウィンドウごと撮って見た目を確認（`dx12_screenshot` には UI は写らない）

- ラベル文言は子の `uiText` を `set_component`（子の id と現在の文言は `dx12_ui_tree` の `children` / `text` で分かる）
- クリック/値変更は Lua の `events:on(イベント名, fn)` で受ける（`uiButton.onClickEvent` / `uiSlider.onChangeEvent`。`e.value` に実値）
- 兄弟の描画順 = `uiRect.order`（大きいほど手前）、親変更 = `dx12_set_parent`、リストは `uiScrollView` の子にぶら下げる
- 見た目の装飾も `dx12_set_component` で設定できる: `uiRect` の `rotation`/`skewX`（度。例: `rotation: -8` で斜めバナー＝ペルソナ風 UI。子孫ごと回る見た目の変換）、
  `uiImage` の `gradientDir`+`gradientColor2`（グラデ）/ `gradientScrollSpeed`（≠0 で光帯がグラデ方向へ流れるグロススイープ＝ガチャボタンの光沢流し。周回/秒）/
  `outlineWidth`+`outlineColor`（枠線）/ `shadowColor`+`shadowOffset`+`shadowSoftness`（影）、
  `uiText` の `outlineWidth`（縁取り）/ `shadowColor`（影）/ `fontPath`（assets 相対 .ttf/.otf）/ `typewriterSpeed`（文字/秒。Play 中に1文字ずつ＝会話文タイプライター）
- 動きは `uiAnimator`（出現 8=bounceDrop/9=flipIn/10=shakeIn 含む）と Lua `scene:tweenUi`（scaleX/scaleY・color フラッシュ・shake 対応）、
  定番演出は prelude の `uifx.punch/flash/shake/hit/bounceIn/flipIn/popOut/fadeIn/fadeOut`（`dx12_describe_lua_api` 参照）
- 回転したパネルの中に `ui_scrollview` を置くのは非対応（逆にスクロールビュー内の回転要素は OK）
- ゲームパッド/キーボードのフォーカスナビは自動で効く（設定不要）

### UI監査の計測lint (dx12_ui_audit)

`dx12_ui_audit` は主観ヒューリスティックに加えて、resolvedRect から測定する「AIっぽいUI」検出ルールを持つ:

- `SIBLING_MISALIGNMENT` (warning): 同じ親の兄弟の左端/上端が **1〜3pxだけ** ズレているペア。0px(整列済み)と4px以上(意図的な差)は対象外。fix に揃えるべき座標が入る。
- `OFF_GRID_SPACING` (suggestion): 縦積み/横並びの隣接兄弟の間隔が4pxグリッドに乗っていない(gap%4≠0)。64px超の間隔は領域分割とみなし対象外。
- `FONT_SIZE_SPRAWL` (suggestion): 表示中の uiText.fontSize が5種類を超えた(タイポスケールの乱れ)。
- `CENTERED_MONOTONY` (suggestion): 操作+テキスト要素が6個以上あり、その80%以上が水平中央揃え(キャンバス中心±2px)。全部中央はAI的構図の典型。

返り値には issue にならなくても常に `metrics` が付く:
`{ fontSizes: [{size,count}...], colorGroups: [{color,count,examples}...], centeredRatio, gapValues }`
colorGroups は近似色(RGB 1/8刻み)をまとめた代表色・使用回数・使用エンティティ名の例。UI生成後はこの metrics を見てスケール/パレット/構図を整えること。

### dx12_ui_compare — 参照UIとの横並び比較

`dx12_ui_compare(referencePath, grid?)` は、ユーザーが渡した参照ゲームのUIスクショ(PNG絶対パス)と、現在のエディタUI(`ui_screenshot`)を**1枚の横並び画像**(左=参照、右=現在、間に4px区切り線)に合成して返す。AIは2枚別々の画像より1枚に合成された画像の方が正確に比較できる、というのが設計動機。

- 返り値: image ブロック + text に `{path, diffRatio, refSize, curSize}`。diffRatio は同サイズに正規化した上での RGB 距離ベースのピクセル差分率(%)。
- `grid: true` で右側(現在)にだけ8pxグリッド線を薄く重畳。整列・余白のズレ確認に使う。
- **推奨ループ**: 合成画像を見て「参照と違う点を3つ」挙げる → 直す → 再度 dx12_ui_compare。diffRatio の減少を目安にしつつ、最終判断は目視で行う。
- 実装は `uiCompare.ts`(pure、pngjs 依存)。テストは `node uiCompare.test.ts`。

### UI 素材ワークフロー(フォント / 9-slice / アイコン)

ゲーム UI の見た目を上げる素材導入は以下の流れで行う。

**フォント導入 (dx12_install_font)**
1. `dx12_install_font { family: "Noto Sans JP", weight: 700 }` — Google Fonts から .ttf を落として `assets/fonts/` へ自動取り込み。`{fontPath}` が返る。
2. 返った `fontPath` をテキストに設定: `dx12_set_component { component: "uiText", data: { fontPath: "fonts/NotoSansJP-700.ttf" } }`。
3. ★日本語 UI には必ず日本語対応フォント(Noto Sans JP / M PLUS Rounded 1c / Zen Kaku Gothic New 等)。欧文フォントだと日本語が豆腐(□)になる。見出し 700、本文 400 の 2 ウェイト運用が基本。

**9-slice パネル / アイコン (dx12_import_asset)**
- 画像素材は `dx12_import_asset { sourcePath: "<絶対パス>", destPath: "ui/panel.png" }` で assets へ取り込み、`uiImage.texturePath` に設定する。
- 9-slice はエンジン実装済み: `uiImage` に `texturePath` + `sliceBorder: [左, 上, 右, 下]`(px)を設定すると、角を保ったままパネルが伸縮する。角丸枠・装飾フレームはこれで 1 枚のテクスチャから任意サイズに展開できる。
- アイコンは正方形 PNG を `texturePath` に設定するだけ(sliceBorder 不要)。

導入後は `dx12_ui_screenshot` で実際の描画を確認すること。

---

## エラーコード早見表

| コード | 意味 | 典型的な対処 |
|--------|------|------------|
| 1 | NOT_FOUND | entityId / path / jsonKey を確認 |
| 2 | INVALID_PARAM | describe_components でフィールド型を確認 |
| 3 | MODE_CONFLICT | dx12_stop → 再試行 |
| 4 | STALE_SCENE | dx12_ping → dx12_list_entities で引き直し |
| 6 | UNKNOWN_COMPONENT | dx12_describe_components で jsonKey を確認 |
| 7 | INTERNAL | dx12_get_log でエンジンログを確認 |

---

## 禁止事項まとめ

- **同一シーン編集中に毎回 `dx12_list_entities` で id を引き直す** → 不要。create/spawn の返り値を使い回す。
  (ただし name 指定で直接操作するのは OK。Stop/シーン再読込をまたぐなら name 指定が安全。)
- **Stop / open_scene / new_scene の後に古い id を使う** → NOT_FOUND。sceneGeneration の変化を見て引き直すか name 指定。
- **Playing 中に生成系を呼ぶ** → MODE_CONFLICT。先に stop する。
- **transform / name を remove_component で消す** → core 不変。不可。
- **meshRenderer を set_component で差し替える** → 不可。delete → spawn_model で。
- **`entity.boxCollider` 等を Lua で読もうとする** → nil。Lua から entity 直読みできるのは transform だけ
  (`dx12_describe_lua_api` で確認。collider/rigidBody は `physics:getVelocity(e)` 等の別 API 経由)。
