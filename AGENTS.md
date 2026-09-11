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

## ★ ヘッドレス実行と CI — 検査は「思い出したらやる」から「必ず回る」へ

窓を出さずにエンジンを起動して MCP だけ開ける。人が作業している画面を奪わないし、
複数インスタンスを並べられるし、CI でシーンを検証できる。

```
DX12Engine.exe --headless --project <dir> --mcp-port 8850 --scene scenes/main.json
```

| 引数 | 意味 |
|---|---|
| `--headless` | 窓もスプラッシュも出さない。**`--project` が必須**（ランチャーは人が押す前提の UI なので） |
| `--mcp-port N` | 待受ポートを固定。**指定すると `%TEMP%/dx12_mcp.port` を書き換えない**＝人が開いているエディタの接続を奪わない |
| `--scene <rel>` | プロジェクトを開いた直後にこのシーンを開く（assets 相対） |
| `--allow-autosave` | ヘッドレスでもディスクへ書く。**既定は読み取り専用** |

- ★**撮影系は `path` を明示する**: `dx12_screenshot` / `dx12_screenshot_final` / `dx12_render_debug` / `dx12_screenshot_game_view` は省略するとエンジンの CWD へ書くので、書けない場所（`C:\Windows\System32` 等）で起動していると `WIC stream open failed` で撮影ごと失敗する。
- **ヘッドレスは既定でディスクへ書かない。** 検証しただけでプロジェクトが書き換わるのは事故なので、
  MCP の自動保存を止めてある（`navmesh_build` は編集扱いなので、これが無いと検証を回すだけで
  シーンが書き直される）。背景でエージェントに作らせるときだけ `--allow-autosave` を付ける。
- 窓は作るが `Show` しない（隠し窓）。D3D12 のスワップチェーンは可視性を要求しないので、
  描画・物理・Lua・スクショまで全部そのまま動く。

### 1 コマンドで検証する — `ciClient.ts`

```
node tools/mcp-server/ciClient.ts --launch <projectDir> \
     --scenes scenes/main.json,scenes/title.json --goals GP_Goal,GP_Key
```

空きポートを自分で探してヘッドレス起動 → 各シーンで `validate_layout` と到達性を見る →
**終了コード 0/1** を返してエンジンを落とす。出力例:

```
FAIL scenes/main.json  検査15 エラー1 注意6
       [Z_FIGHT] Crate_1 と Crate_2 の面が Y 軸で 0.00mm しか離れていない…
ok   scenes/title.json  検査5 エラー0 注意2
```

- **落とすのは error と到達不能だけ。** 警告で落とすと誰も直さなくなる。
- 目標（`--goals`）は**そのシーンに存在するものだけ**を見る。タイトル画面にゴールもプレイヤーも
  無いのは正しいので、無いことを不合格にしない。
- 既に動いているエンジンに繋ぐなら `--port 8850`（対話中のエディタでもよい）。
- 並列に回せる。`findFreePort` が衝突しないポートを選ぶ。
- **`--playtests` を足すと、保存済みの `.playtest`（人が遊んだ記録）も再生して突き合わせる。**
  配置の破綻と遊びの破綻を 1 コマンドで見られる。

---

## ★ 置いたら必ず検査する — `dx12_validate_layout`

**AI が作ったシーンが壊れる原因の大半は「見れば分かるが AI は見ない」たぐいの破綻**
（モデルが地面に埋まっている / 面が重なってちらつく / 同じ物を 2 回置いた / 当たり判定が無い）。
測る道具は前からあったが、AI が自分で思いつかないと検査されなかった。だから
**`dx12_play` と `dx12_save_scene` の返り値に `layout` が必ず載る**ようにしてある。

```
dx12_save_scene()
# → {"path": "...", "layout": {"checked": 9, "errors": 4, "warnings": 1,
#      "top": ["COLLIDER_WITHOUT_BODY: LVL_Wall_01: コライダーはあるが rigidBody が無い…",
#              "Z_FIGHT: ENV_Rug_01 と LVL_Floor_01 の面が Y 軸で 0.50mm しか離れていない…"],
#      "next": "dx12_validate_layout(fix:\"safe\") で自動修正できるものを直してから続けること"}}
```

**`layout.errors > 0` のまま先へ進まないこと。** 直し方は 1 行で書いてある。

| kind | 意味 | `fix:"safe"` で直る |
|---|---|---|
| `BURIED` | 地面へ 25% 以上 / 50cm 以上 沈んでいる | ○ 接地させる |
| `FLOATING` | 地面から浮いている | ○ 接地させる |
| `Z_FIGHT` | 2 つの面が 1mm 以内で重なっている＝**描画がちらつく正体** | ○ 小さい方を 5mm 逃がす |
| `OVERLAP` | 体積比 30% 以上めり込んでいる | × 設計判断なので人/AI が決める |
| `DUPLICATE` | 同じ大きさの物が同じ場所に 2 つ（**リトライで 2 回撃った**） | × `dx12_delete_entity` で片方を消す |
| `COLLIDER_WITHOUT_BODY` | コライダーはあるが `rigidBody` が無い | ○ 静的 rigidBody を付ける |
| `NO_COLLIDER` | 人がぶつかる大きさなのに当たり判定が無い | × 飾りなら無視してよい |
| `SCALE_ANOMALY` / `NAN_TRANSFORM` | 一辺 1km 超 / 5mm 未満 / 負スケール / NaN | × 単位の取り違えを疑う |

- **★`COLLIDER_WITHOUT_BODY` はこのエンジン固有の罠**。`boxCollider` を付けただけでは Jolt に
  載らない＝当たり判定は効いていない。`rigidBody{motionType:0, mass:0}` を足して初めて効く。
  付け忘れるとプレイヤーは床をすり抜けて落ち続ける（y=-2400 になった実例がある）。
- **Editor 限定**。Playing 中は物理が動かした後の位置を測ることになるので `MODE_CONFLICT` で弾かれる。
- `NO_COLLIDER` は**シーンが物理を使っているときだけ**出る（当たり判定を 1 つも使っていない
  見せ物シーンで全オブジェクトに「すり抜ける」と言い続けても意味が無いため）。
- 検出内容はエンジンログにも `配置検査 [KIND] …` として残る（後から共同開発者が追える）。

---

## ★ グループ分けと命名規則 — 共同開発者が読めるシーンにする

ルート直下は **7 つの空グループだけ**。全エンティティはそのどれかにぶら下げる。
名前は **`<PREFIX>_<Kind>_<NN>`**（例 `ENV_Rock_03` / `LVL_Platform_07` / `GP_Enemy_Slime_01`）。

| ルート | 接頭辞 | 入れるもの |
|---|---|---|
| `LVL` | `LVL_` | 床・壁・足場・階段・坂。**当たり判定を持つ**のが原則 |
| `ENV` | `ENV_` | 背景・装飾。当たり判定が要らない見せ物（岩・草・家具・小物） |
| `LIGHT` | `LGT_` | ライト（directional / point / spot） |
| `GAMEPLAY` | `GP_` | プレイヤー・敵・アイテム・トリガー・スポーン地点 |
| `FX` | `FX_` | パーティクル・トレイル・デカール |
| `UI` | `UI_` | ゲーム内 UI（uiCanvas 以下） |
| `CAMERA` | `CAM_` | カメラ |

- Kind は**英数字のみ**（空白・日本語・ドットは使わない）。`grep` と Lua の `findEntity` が効かなくなる。
- `NN` は 2 桁ゼロ埋めの通し番号。唯一のものは省略してよい（`GP_Player`）。

```
# ① シーンを作り始める前に骨格を作る（既にあるものは作らない＝何度撃っても安全）
dx12_scene_scaffold()
# → {groups:[{key:"LVL", root:"LVL", entityId:12, created:true}, ...], convention:"..."}

# ② 生成時に group を渡す（これが一番安い。後から整理しなくて済む）
dx12_spawn_box(name:"LVL_Platform_01", position:[0,0,0], scale:[4,0.5,4], group:"LVL")
dx12_spawn_sphere(name:"ENV_Rock_01", position:[3,0,2], group:"ENV")

# ③ 既存の散らかったシーンは一括整理（★既定は計画を返すだけ）
dx12_organize_scene()                 # dryRun。moves[] を読んで内容を確認する
dx12_organize_scene(dryRun:false)     # 適用

# ④ 崩れ具合を数える
dx12_validate_naming()
# → {pass:false, counts:{DEFAULT_NAME:7, NOT_IN_GROUP:12, DUPLICATE_NAME:1}, issues:[...]}
```

- **分類はコンポーネントを名前より優先する**（名前は嘘をつくがコンポーネントは嘘をつかない）。
  `pointLight` が付いていれば名前が `Floor` でも `LGT` になる。
- **`dx12_organize_scene` は冪等**。既に規約どおりのものは触らないので、撃ち直しても名前が伸びない。
  連番は既存の規約名を見て衝突しないよう採番する。
- 子（グループ以外の親を持つもの）は**親ごと動く**ので触らない。
- **グループのルートは必ず原点・無回転・スケール 1 の空エンティティ**。`set_parent` はワールド座標を
  保持しない（子はローカルとして解釈される）ので、単位変換でないルートにぶら下げると物がワープする。
  `dx12_scene_scaffold` / `group` 引数が作るルートは原点なので安全（実測で位置が動かないことを確認済み）。
- `DUPLICATE_NAME` は実害がある: `name` 指定の MCP 操作も Lua の `scene:findEntity` も
  どちらに当たるか不定になる。

---

## ★ テストプレイ — 台本で流す。1 手ずつ動かさない

`key_down` → `step_frames` → `get_entity` を数十往復するやり方は**遅いうえ再現しない**。
各フレームの dt が実時間なので、同じ入力を同じフレーム数だけ与えても進む距離が毎回変わる
（ジャンプが届いたり届かなかったりする）。3 段構えで置き換える。

### ⓪ 向きはマウス注入で変える — `dx12_mouse_move`

★**`camera:setYaw()` では向きを変えられない。** エンジン標準の `FpsController` は yaw を
**Lua のローカル変数**で持っていて、毎フレーム `cam.transform.rotation` をその値で上書きする
（外から書いても次のフレームで戻される。2026-09-10 に実測で確認）。
視点はどのゲームでも `input:getMouseDeltaX()` から作るので、そこへ生の移動量を注入するのが唯一の道。

```
dx12_mouse_move(dx:200)            # 次の 1 フレームぶんだけ乗る
dx12_step_frames(frames:1, deterministic:true)
# 実測: 200px で 24 度 回った（感度はゲームごとに違う）
```

感度は外から読めないので、**目標角度へ向けたいなら `dx12_play_script` の `yaw` か
`dx12_autoplay` を使う**こと。そちらは「少し回して測って比例で詰める」閉ループになっていて、
実測では 1〜2 フレームで目標 yaw に合う。

### ① 決定論ステップ — `dx12_step_frames(deterministic:true)`

```
dx12_step_frames(frames:60, deterministic:true)   # dt=1/60 固定 → 必ず 1.00 秒ぶん進む
# → {stepped:true, deterministic:true, dt:0.016667, simulatedSec:1.0, held:true}
```
物理はもともと 60Hz 固定ステップなので `dt=1/60` なら端数が出ない（1 フレーム = 1 物理ステップ）。

★**`deterministic:true` は進めた後に時間を止める**（次の `step_frames` まで進まない）。
これが無いと、応答を待つ **MCP の往復の間もエンジンが回り続けて**不定な数のフレームが
余計に進み、dt を固定しても再生が毎回 1〜2m ずれる。**実測: 止めるようにしたら
再生のゆらぎが 1.6m → 0.002m になった**（800 倍）。止まるのはシミュレーションだけなので、
この間にスクショも設定の読み書きもできる。`hold:false` で従来どおり走らせ続けられる。
`dx12_play` / `dx12_stop` で必ず解除されるので、止まったままになることはない。

### ② 台本 + 断言 — `dx12_play_script`

入力タイムラインと合否条件を **1 コール**で流す。

```
dx12_play_script(
  steps: [{t:0, yaw:0, down:"W"}, {t:1.2, press:"SPACE"}, {t:2.5, up:"W"}],
  expect: [{by:4.0, near:[0,2,18], radius:2, label:"ゴールへ着く"},
           {by:2.0, yAbove:1.5, label:"ジャンプで 1.5m 以上上がる"}],
  until: 5)
# → {pass:false, results:[{label:"ゴールへ着く", pass:false,
#      detail:"最接近は t=3.10s で 4.62m"}, ...], trace:[...]}
```

- **落ちたときに「どれだけ足りなかったか」が返る**（最接近距離 / 最高到達 y / 最大移動距離）。
  そこから足場を足すのか台本のタイミングを直すのかが決まる。
- `at` は「その時刻ちょうど」、`by` は「その時刻までのどこか」。省略すると走行全体。
- **向きは `yaw`（度）で指定する**。マウス注入が無いので、内部で `camera:setYaw` を撃っている
  （このエンジンのテンプレートはカメラ相対 WASD）。+Z が前、右回りが正。
- 走行後は押しっぱなしのキーを**必ず離す**（次のテストに入力を漏らさない）。

### ③ 移動能力の実測 → 到達性の判定

```
dx12_measure_player()
# → {walkSpeed:6.47, jumpHeight:2.07, jumpDistance:7.50, stepHeight:0.3, maxSlopeDeg:50}
#   （FPS テンプレートでの実測値。同じ入力を 2 回流して 6.469m / 6.514m ＝再現する）
#   実測値は <project>/.dx12/movement.json に保存され、以後 check_reachable が読む

dx12_navmesh_build()
dx12_check_reachable(fromName:"GP_Player", toName:"GP_Goal")
# → {reachable:false,
#    issues:[{fromIndex:3, gap:6.2, rise:0.4,
#             reason:"水平 6.2m の跳び越しが要る。実測のジャンプ距離 4.05m
#                     (安全率込み 3.44m) では届かない"}]}
```

- **宣言値ではなく実測**なのが肝。移動そのものは Lua が実装していて、
  `characterController` の値とは一致しない。
- `analyzePath` は「登れない段差」「届かない隙間」に加えて
  **「落ちたら自力で戻れない区間」**（＝詰み）も拾う。
- Play 不要なので何度でも撃てる。まずこれで潰してから実走に行くのが速い。

### ★ 人のプレイを回帰テストにする — `dx12_record_playtest` / `dx12_run_playtests`

**コードは ctest 49/49 で守られているのに、遊びは誰も守っていない。** ジャンプ力を変えた、
コライダーをずらした、Lua を直した——それでステージがクリアできなくなっても誰も気づかない。
材料は揃っていた（`dx12_play` を押した時点から入力が時刻付きで記録されている＋決定論ステップ）ので、
**人が 1 回遊べばテストが 1 本増える**形にした。

```
dx12_play()                       # ここから記録が始まる
（人に遊んでもらう。AI は何もしない）
dx12_stop()
dx12_record_playtest(name:"boss_route")
# → {saved:"…/.dx12/playtests/boss_route.json", inputs:42, humanDrift:2.07}

dx12_run_playtests()              # 保存済みを全部再生して突き合わせる
# → {ran:3, passed:2, failed:1,
#    results:[{name:"boss_route", pass:false,
#              reasons:["t=4.20s で経路が 6.10m ずれた（許容 2m）。そこで引っかかったか落ちた可能性"]}]}
```

**★基準は「人の軌跡」ではなく「初回再生の軌跡」（ゴールデンラン）。**
人のプレイは実時間、再生は固定 dt なので、入力のタイミングが同じでも軌跡は構造的にずれる
（実測 2m。記録は空中でジャンプ中、再生は着地後、といった差が出る）。
人のプレイからは**入力だけ**を受け取り、期待する軌跡は同じ仕組みで 1 回走らせた結果にする。
人の軌跡は `humanReference` に参考として残り、離れすぎたら warning が出る。

判定はこの 3 つだけ（経路をピクセル単位で一致させようとすると毎回落ちて誰も見なくなる）:

| 見るもの | 既定 | 実測のゆらぎ |
|---|---|---|
| 終点が基準からどれだけ離れたか | 1.0m | **0.002m** |
| 途中の経路の最大ずれ | 2.0m | 0.003m |
| 再生中に Lua が死んだ数 | 0 | — |

- **記録中に `deterministic:true` を使ってはいけない。** 記録の時刻は実時間なので、
  1 秒の実時間で何秒ぶんもシミュレーションが進むと時刻が意味を失う。
  変換のときにフレーム/秒が現実離れしていたら弾くようにしてある。
- 向きは記録した yaw をマウス注入の閉ループで追いかける（記録にあるのは 10Hz の**角度**で、
  毎フレームのマウス移動量ではない。感度もゲームごとに違うので移動量の流し直しはできない）。
- 入力が 1 つも無い記録、リング上限でこぼれた記録は保存を拒否する
  （常に合格する無意味なテストを増やさないため）。
- CI からは `node ciClient.ts --launch <projectDir> --playtests` で回る。

### ④ 実際に走破させる — `dx12_autoplay`

```
dx12_autoplay(goalName:"GP_Goal")
# → {cleared:false, stuckAt:[3.2,0.1,11.8], stuckAtWaypoint:4,
#    reason:"[3.2,0.1,11.8] で 3 秒進めなくなった",
#    next:"その座標を dx12_screenshot_from で見る…"}
```

ナビメッシュの経路を**実際の入力**でなぞる。詰まったら少し跳んでみて、
それでも進まなければ座標付きで諦める。★静的に通っても実際は詰まる
（見えない当たり判定・傾斜・キャラの幅）ことがあるので、
**「クリアできる」と言う前にこれを通すこと**。

### ⑤ 人間のプレイを読む（従来どおり）

「操作感がおかしい」「たまに変になる」の類は合成入力では再現しない。
`dx12_play` を押して人間に遊んでもらい、`dx12_get_play_session` で読む（この文書の別項）。

---

## ★ モデルが足りない — Blender を自分で起動して作る

```
# ① 何が足りないか
dx12_asset_gap()

# ② 規約を読む（作り始める前に必ず）
dx12_model_brief(kind:"prop")

# ③ Blender を起こす（人に開いてもらう必要は無い。PolyHaven も自動で有効になる）
dx12_blender_ensure()

# ④ 形を作る（mcp__blender__execute_blender_code 等）

# ⑤ ★仕上げる ← ここを飛ばすと「うすぺらい」物ができる
dx12_blender_polish(objects:["Barrel"])

# ⑥ ★素材を貼る ← ここを飛ばすと【真っ白】になる
dx12_blender_material(objects:["Barrel"], keyword:"wood")

# ⑦ 規約どおりに書き出して取り込む
dx12_blender_export(objects:["Barrel"], destPath:"models/barrel/barrel.gltf")

# ⑧ 置いて検査（見栄えを判断する前に環境光を入れる）
dx12_scene_env(keyword:"studio")
dx12_spawn_model(path:"models/barrel/barrel.gltf", group:"ENV")
dx12_validate_layout(fix:"safe")
```

### なぜ「うすぺらい」「安っぽい」のか（2026-09-11 に実物で確かめた）

| 症状 | 原因 | 直し方 |
|---|---|---|
| 紙細工に見える | **角にベベルが無い**。完全に鋭い角は光を一切拾わない | `dx12_blender_polish`（3〜4mm / 2 段 / harden normals） |
| 模様の大きさが物と合わない | **プリミティブの既定 UV は面ごとに 0..1**。60cm の箱にも 6m の壁にもテクスチャが 1 枚 | polish が実寸で切り直す（1 UV = 1m） |
| 板が紙に見える / ちらつく | 厚みゼロの面 | polish が Solidify を掛ける |
| **真っ白な物が出る** | エンジンは glTF の `baseColorFactor` を読まない。テクスチャ無しは白 | `dx12_blender_material`（PolyHaven の CC0 素材） |
| 木や布が金属に見える | `rough` 単体を metallicRoughness として出すと **B（= metallic）に粗さが入る** | material が `arm` を優先、無ければ B=0 で合成 |
| 全部に青が乗って彩度が低い | 環境光が既定の**手続き空** | `dx12_scene_env`（PolyHaven の HDRI） |
| 仕上げてもシルエットが角ばる | **分割が足りない**。ベベルは角を丸めるだけ | 作る時点で 24〜32 分割にする（polish が面数を警告する） |

★**素材の入手先は既定で全部 OFF だった**（PolyHaven / Hyper3D / Sketchfab / Hunyuan3D）。
その状態だと AI は素材を一切持たずにプリミティブだけで組むことになる。
`dx12_blender_ensure` が **PolyHaven（CC0・API キー不要・テクスチャ 859 種 + HDRI）を自動で有効にする**。
Hyper3D と Sketchfab は API キーが要るので状態だけ報告する。

**`dx12_blender_export` に埋めてある罠**（全部実際に踏んだもの。手で書き出すと再発する）:

- `use_selection=False` は **.blend 内の全シーン**を書き出す（glTF の `scenes` は配列なので合法）。
- **`export_format` を渡さないと既定の GLB になる**。`models/rock.gltf` を頼んだのに `rock.glb` ができて、
  参照が全部切れる（`spawn_model` が "model not found" で落ちる）。拡張子から決めて必ず渡し、
  書き出し後に**頼んだパスに本当にできたか**を確かめる。
- Blender 5.2 の glTF エクスポータは画像を **`tmpXXXX.jpg`** という一時名で出す。
  再書き出しで名前が変わり、**前に出したモデルの参照が切れる**（額縁が白・絨毯が黒になった）。
- **エンジンは `baseColorFactor` を読まない**。画像テクスチャの無いマテリアルは**真っ白**になる
  → 書き出し時に警告が出る。
- シェイプキーが `.bin` の大半を占めることがある（実例: 75MB のうち 70MB）→ 既定で捨てる。
- **アルファ抜きが無い**。葉・枝カード・角膜のような α 前提の面は Blender で消してから出す。
- 取り込み後に `dx12_asset_info` で実寸を読み返すので、**cm/m の取り違えはその場で分かる**。

---

## 未保存の確認モーダルはもう出ない（自動保存）

MCP クライアントが繋がっている間、エンジンは**最後の書き込みから 2 秒アイドルしたら
現在シーンをディスクへ本保存する**。だから:

- 「保存していない変更があります」「保存されていない自動保存が見つかりました」は**出ない**
  （AI はモーダルを押せないので、出るとツール呼び出しが 8 秒でタイムアウトしてハングと区別が付かなかった）。
- `dx12_ping` の `sceneDirty` は一瞬しか true にならない。`aiAutoSave:true` がこの機構が
  効いていることの印で、`savePending:true` は「この後 2 秒以内に書かれる」の意味。
- **保存先が未設定の新規シーンには `scenes/_mcp_untitled_<時刻>.json` が自動で割り当たる。**
  人が後から本来の名前で `dx12_save_scene(path:...)` し直してよい。
- **AI が最初に上書きする前のシーンは `<project>/.dx12/backups/<名前>_<時刻>.json` に 1 本残る**
  （直近 20 世代）。壊した時はここから戻す。
- 副作用: 古い形式で保存されていたシーンは、最初の自動保存で**現在の形式に書き直される**
  （新しいキーが増える）。中身は同じだが git の差分は出る。

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

**書き始める前に 2 つ読む**（白紙から 200 行を書くのは失敗率が高い）:

```
dx12_list_shader_templates()                     # 動く雛形(water / ocean / particle_ember)
dx12_describe_shader_contract(kind:"mesh")       # b0/b1 の中身・テクスチャ・入出力・落とし穴
# kind: mesh(既定) / particle / sprite / screen。★契約が全部違うので取り違えないこと
dx12_create_shader(name:"Sea", template:"ocean") # 雛形から起こす(code 省略可)
```

★**割り当てただけでは動かない**。b0 の自由枠(effectValue / shaderParams / shaderParamsB)は
最初 0 なので、波の高さ 0・流速 0 の水面のように「貼ったのに何も起きない」状態になる。

```
dx12_set_mesh_shader(name:"Sea_Plane", shaderPath:"Sea.hlsl")
dx12_set_mesh_shader_params(name:"Sea_Plane", effect:1.0, params:[0.6, 1.2, 0.35, 0], paramsB:[0.2, 0, 0])
# → 現在値が全部返る。意味は各シェーダーのヘッダコメント(dx12_read_shader で読める)
```

時間で動かす(溶ける・波が高くなる)口は 3 つ:
- Lua: **`shader.set("Sea", { effect = 0.4, p1 = 0.6 })`** / `shader.get(target)`(v1.18.0+。渡した項目だけ書く)
- 演出: `dx12_sequence_author` の `shaderParam` トラック(現在値から目標値へイージングで動かす)
- 配線: Trigger の `AnimShaderParam`(actions の type:12)

自分で全部書く場合:

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

## 品質判断系(絵を「見る」のではなく「測る」)

スクショを 1 枚見て「いい感じ」と言うのは当てにならない。数値で差を出して、数値で詰める。

### 参照画像に寄せる — `dx12_look_compare`

`dx12_ui_compare` の 3D 版。参照(実写写真 / 参考ゲームのスクショ)と今の絵を横並びにするだけでなく、
**何をどっちへ何倍動かせばいいか**を返す。リアル系のライティング詰めはこれが本体。

```
dx12_look_compare(referencePath:"C:/ref/forest_dusk.png", position:[0,2,-8], target:[0,1,0])
# → 画像(左=参照 / 右=現在) +
#   delta: {exposureEV:-0.83, contrastRatio:0.78, saturationRatio:1.31, cctDeltaK:-1200, histogramEmdEV:0.62, ...}
#   suggestions: [
#     "露出: 参照より平均輝度が -0.83EV 暗い。dx12_set_sun の intensity を現在値の ×1.78 に…",
#     "コントラスト: … ×0.78 で眠い。まず光で作る: ambient を下げて影を締める…",
#     "色温度: 参照より 1200K 暖色寄り。dx12_set_sun の kelvin を 6100 にする…" ]
```

#### ★ 何が映る絵を測っているのかを絶対に間違えないこと

スクショは 3 種類あり、**撮る先が違う**。ここを間違えると「測定と目視が食い違う」。

| | `dx12_screenshot`<br>(シーン RT・ポスト前) | `dx12_screenshot_final`<br>(バックバッファ・ポスト後) | `dx12_ui_screenshot`<br>(ウィンドウ全体) |
|---|---|---|---|
| ライト・環境光・材質・IBL・影・SSAO | ○ | ○ | ○ |
| post の `exposure` / `tonemapper` | ○ | ○ | ○ |
| post のグレーディング(`contrast` `brightness` `saturation` `warmth` `hueShift` `tint`) | **× 映らない** | ○ | ○ |
| ブルーム・ゴッドレイ・ビネット・LUT・FXAA・デバンド | **× 映らない** | ○ | ○ |
| **TAA の解決結果**(ゴースト) | **× 映らない** | ○ | ○ |
| ImGui のパネル / ギズモ | × | × | ○ |

**`dx12_look_compare` / `dx12_camera_path` / `dx12_screenshot_from` /
`dx12_focus_and_screenshot` は既定で `screenshot_final`(ポスト後)を撮る。**
＝人間がビューポートで見ている絵と同じものを測るので、**どのノブを動かしても数値が動く**。

- 数値で追い込むノブに制限は無い。ただし**順序は変えない**: まずライト側
  (`dx12_set_sun` の intensity / kelvin / ambient、ライトの色、材質の albedo / roughness、IBL)
  で作り、post のグレーディングは「一律に効かせる最後の手段」。
  ライティングの破綻をグレーディングで塗り潰すのは絵作りとして間違い。
- `source:"sceneRT"` に切り替えると従来のポスト前を測る。**ポストの化粧を剥がして
  幾何とライティングの素の値だけ見たいとき**に使う。このときだけ suggestions の post 案に
  「この数値では追い込めない」の但し書きが付く。
- 例外: `gameView:true` は `screenshot_game_view` = **常にポスト前**(エンジンに
  「ゲームカメラ視点のバックバッファ」を撮る method が無いため)。ポスト込みのゲーム画面を
  測りたいなら `dx12_play` してから `gameView` なしで呼ぶ(Playing 中の最終画はゲームカメラの絵そのもの)。

> ⚠️ 2026-07-26 より前は `dx12_screenshot`(ポスト前)しか無く、
> 「`saturation` を下げても数値が 1 ミリも動かない → もっと下げる」の無限ループを避けるため
> **suggestions が post のノブを勧めないよう歪めてあった**。`screenshot_final` の追加で解消済み。

#### ★ ピクセル差分で A/B を取るなら `deterministic:true`

**同じ設定で 2 回撮っても絵は一致しない。** 犯人は実測で 3 つ:

| 原因 | 効く先 | 実測(1920x1032・同一設定 2 枚) |
|---|---|---|
| deband ディザ / フィルムグレイン(`time` 依存の TPDF ノイズ) | `screenshot_final` のみ | 画面の **66%** が ±1〜2 LSB |
| TAA のジッタ | 両方 | `screenshot` で **9.4%** / max 140 |
| SSGI・ボリュメトリックフォグの時間ジッタ + 履歴蓄積 | 両方 | SSGI 1.5% / フォグ 5.9% |

`{"deterministic": true, "settleFrames": 8}` で time を固定し、TAA/フォグ/SSGI の位相を 0 に、
履歴を捨ててから固定フレーム数回してから撮る → **2 枚が完全一致(diff 0.00%)**。
止まるのは**レンダラの時間依存だけ**なので、Play 中のゲームシミュレーション(移動/物理/アニメ)は
止まらない。厳密に比べるなら `dx12_stop` してから撮ること。

#### そのほかの読み方

- **1 回で寄せきろうとしない。** suggestions のうち**露出 → コントラスト → 色温度 → 彩度**の順で
  1 つずつ動かして撮り直す(同時に触ると何が効いたか分からなくなる)。
- `exposure` / `contrast` / `saturation` の示唆は**現在値への倍率**で出る。`dx12_get_post_process` で
  現在値を読んでから掛ける。各エフェクトは `<name>On:true` にしないと効かない。
- `cct` が `null` で返ることがある。これは**推定できなかった**という意味で、`cctNote` に理由が入る
  (黒体軌跡から離れすぎ = 強いカラーライトの色被り / 絵が暗すぎる)。
  null の時に色温度をいじっても迷走するので、先に色被りか露出を外す。
- 数値が全部許容内なら suggestions は「ほぼ一致」1 本になる。そこから先は合成画像を見て
  構図・素材・法線マップの差を探す仕事。

### 動かして初めて出るアラ — `dx12_camera_path`

静止画では TAA のゴースト・LOD ポップ・影のちらつき・カリング抜けが**絶対に**分からない。

```
# 被写体のまわりを 1 周(8 枚を 4 列の格子で)
dx12_get_bounds(name:"Boss", includeChildren:true)      # → center と size を先に測る
dx12_camera_path(mode:"orbit", target:[0,1,0], radius:12, height:4, frames:8, columns:4)
# → 格子画像 + frameDiffs:[3.1, 2.9, 3.4, 18.7, 3.0, 2.8, 3.2]
#   → 4→5 だけ突出 = そこで何かがポップした。その視点を dx12_screenshot_from で撮り直して確認
```

- `frameDiffs` はカメラ移動量に比例するので、**絶対値ではなく周囲との差**を見る。
- `settleFrames` は既定 0。**TAA のゴーストを見たいなら 0 のまま**(進めると収束して消える)。
  逆に「収束後の最終画質」を見たい時だけ 4〜8 にする。
- Editor 限定。撮り終わると元のカメラ位置へ戻す(`restore:false` で戻さない)。

---

## 大量配置はシーン JSON を直接書く — `dx12_scene_write`

`dx12_create_entity` / `dx12_spawn_model` は**遅延同期＝1 体につき 1 フレーム**かかる。
数十体以上を並べるなら JSON を書いて `open_scene` 1 回の方が桁違いに速い。

```
dx12_scene_write(
  path: "scenes/level1.json",
  open: true,
  sceneJson: {
    version: 1,
    entities: [
      {name:"Floor", transform:{position:[0,0,0],rotation:[0,0,0],scale:[40,1,40]}, primitive:"plane"},
      {name:"Sun",   transform:{position:[0,20,0],rotation:[0,0,0],scale:[1,1,1]},
       directionalLight:{color:[1,0.95,0.9], intensity:3}},
      {name:"Tree_00", transform:{position:[3,0,5],rotation:[0,0,0],scale:[1,1,1]},
       meshRenderer:{modelPath:"models/tree.gltf"}, parent:0}
    ]
  })
```

**書く前に必ず検証が走る**(エラーが 1 つでもあれば書かずに全部返す):

- `entities` の有無 / `name` 欠落 / `transform` の要素型
- `parent` は **entities 配列のインデックス**(entityId でも name でもない)。範囲外・自己参照・循環を弾く
- `meshRenderer.modelPath` / `luaScript.scriptPath` を `dx12_list_assets` と突き合わせて実在確認
  (**参照切れのモデルはエンティティごと消える**ので、これを黙って通すと「置いたはずの木が無い」になる)
- **エンジンが無言で無視するキーの打ち間違い**(`meshrenderer` / `rotaton` / `shadow` …)を近い正解つきで警告

上書き時は既存内容を読んでから書き、`replaced.summary`(上書き前のエンティティ数など)と
`%TEMP%` に取った `backupPath` を返す。**何を壊したかが返り値に残る。**

- `path` は assets 相対(`scenes/xxx.json`)推奨。絶対パスも可。
- assets ディレクトリは **`dx12_ping` がエンジンの正を返す**(`protocolVersion 4` 以降。
  `assetsDir` / `scriptsDir` / `baseDir` / `projectShaderDir` / `cwd`)。
  解決順は `assetsDir` 引数 → 環境変数 `DX12_ASSETS_DIR` → `dx12_ping`。
  以前あった「エンジンログの絶対パスから推定する」ハックは**撤去済み**(別プロジェクトの古いログを
  掴む事故があった)。絶対パスが要るときはログを漁らず `dx12_ping` を引くこと。
- 書いた後は `dx12_open_scene`(または `open:true`)で読み込む。開くまでエディタの絵は変わらない。

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
- `dx12_screenshot_final` は **Playing 中はゲームカメラの絵**、Editor 中はエディタのフライカメラ。
  どちらも**ポスト適用後**なので「実際にプレイヤーが見る絵」の判断はこれで行う。
  `dx12_screenshot`(ポスト前)は幾何/ライティングの素の値を見たいときだけ。
  `dx12_focus_and_screenshot` は寄せて撮る用。
- `dx12_set_editor_camera` は **Play 中も使える**(アクティブな `CameraComponent` の毎フレーム
  同期を止めて視点を固定する = `overridden:true`)。撮り終わったら `{"release":true}` で
  ゲームカメラへ返す(Play/Stop の遷移でも自動解除)。Play 中の絵で `dx12_look_compare` /
  `dx12_camera_path` を回すための機能。
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

## ★ ゲームの挙動デバッグは「自分で操作せず、人間のプレイを読む」

合成入力(`dx12_key_*`)で AI が自分で動かして確かめるのは、**当たりを付ける段階まで**。
「操作感がおかしい」「たまに変になる」の類は合成入力では再現しない(人間は AI と違う入力をする)。

**正しい手順はこれ:**

```
dx12_play                     ← あなたはこれを押すだけ
（ここで人間に遊んでもらう。あなたは何も操作しない）
dx12_stop                     ← 人間が遊び終えたら（人間が自分で止めてもよい）
dx12_get_play_session          ← 1 回のプレイを丸ごと読む
```

`dx12_play` を押した時点で**自動的に記録が始まる**(開始用のツールは無い)。
Stop 後も次の Play まで記録は残るので、遊び終えてから取りに来ればよい。

返るもの:
- `events[]` … `key_down`/`key_up`/`pad_down`/`pad_up`(人間の操作) と `error`/`warn`/`lua`(ログ)。
  `t` は Play 開始からの秒。`detail` のキー名は `dx12_key_press` にそのまま渡せる
  （怪しい所だけ手で再現したい時に使う）
- `samples[]` … 10Hz で `fps` / `camPos` / `camYaw` / `camPitch` / `mouse`(移動量)。
  fps が落ちた瞬間・プレイヤーがどこに居たか・止まっていたかが時系列で分かる
- `summary` … errors / warnings / inputEvents の件数。`fpsMin` で最悪フレームが分かる

読み方のコツ: **入力イベントの時刻とログ/fps の時刻を突き合わせる**。
「ジャンプした 0.2 秒後に必ず warn が出ている」のような対応が取れれば原因はほぼ確定する。
Lua の `print()` / `log()` も `lua` として同じ時間軸に載るので、
怪しい所に `log()` を仕込んでもう 1 回遊んでもらうのが一番速い。

---

## Lua が壊れたとき — エンジンを再起動しない

- **`dx12_play` の結果の `scriptErrors`** … 0 でなければその数だけ Lua が死んでいる。
  **Play 自体は成功して返る**ので、絵を見る前にここを見ること
- **`dx12_get_script_errors`** … 壊れている LuaScript を全部返す
  (`entityId` / `name` / `scriptPath` / `message`。message は traceback 込み)。
  どのエンティティが壊れたか分からない状態ではこれを使う
  (`dx12_get_lua_component_state` は entity を 1 個ずつ聞くので使えない)
- **直したら `.lua` を保存するだけ**。0.5 秒以内にホットリロードされ、
  そのスクリプトを使う全エンティティが作り直される。
  **Play を止める必要も、エディタを再起動する必要も無い**。
  一度エラーで停止したコンポーネントも、保存し直せばそのまま復活する
- `dx12_create_lua_component` は書き込み前に構文チェックする(実行時エラーは当然弾けない)

---

## 「シーンビューが真っ暗 / カメラが何も映らない」

推測でライトやカメラを触る前に、**必ずこれを 1 回撃つ**:

```
dx12_diagnose { only: ["render_health"] }
```

原因を名指しで返す(速い):

| 出るもの | 意味 |
|---|---|
| デバッグ可視化が出したまま | `dx12_render_debug {mode:"off"}` で戻る。`rtDiff`/`rtHit` は真っ黒が正常な表示 |
| 露出が 0 / ティントが黒 | ポストが最終色を 0 倍している。**シーン JSON に保存されるので再起動しても直らない** |
| 自動露出のレンジが逆転 | `aeLogMin >= aeLogMax` |
| 光が 1 つも無い | 太陽 0 + IBL 0 + スカイボックス非表示 |
| シーン矩形が潰れている | ドックレイアウト再構築直後なら次フレームで戻る |
| SRV ヒープが枯渇寸前 | **この後の読み込みで描画が止まり、以後戻らなくなる予告**。エディタを再起動する |
| カメラが NaN / 極端な座標 | 全部カリングされて背景色だけが残る |
| MCP がカメラを握ったまま | `dx12_set_editor_camera {release:true}` で返す |

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
# ★scene:findEntity は見つからなくても nil を返さない(無効な Entity)。
#   そのまま .transform を触ると例外になるので :isValid() で確かめる。
dx12_eval_lua(code:"local e = scene:findEntity('Player'); if not e:isValid() then return 'no Player' end; return e.transform.position.y")
# → {result: "3.5"}

dx12_eval_lua(code:"local e = scene:findEntity('Player'); if e:isValid() then e.transform.position.y = 10 end")
# → {result: ""}  (return してないので result は空)
```

★ `print()` も `log(msg)` も `dx12_get_log` に出る(print は Logger へ差し替え済み)。
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

`dx12_set_*`(post_process / ssao / ssr / ssgi / contact_shadow / taa / volumetric_fog /
scene_settings)は適用後に **エンジンから読み返した実値** を `current` に入れて返す。
要求と食い違ったフィールドは `mismatched` に出て `applied:false` になる
(＝「成功したように見えるのに何も変わっていない」が起きない)。

```
dx12_set_taa(enabled:true, sampleCount:16)
# → {applied:true,  requestedKeys:[...], current:{enabled:true, sampleCount:16, active:true, ...}}
# → {applied:false, mismatched:[{key:"sampleCount", requested:16, actual:8}], ...}  ← 同じ呼び出しを繰り返しても無駄
```

### 引数名を間違えると「無言で無視」ではなくエラーになる

かつては zod がスキーマに無いキーを黙って捨て、それでも `{applied:true}` が返っていた
(`tonemapper` / `godraysOn` / `dofOn` 等が長期間そうなっていた)。今は未知キーを
**近い正解つきのエラー**で返す。`dx12_batch` の `params` も同じ検査を通る。

```
dx12_set_post_process(godrays:true)
# → エラー(code=2): 知らない引数 godrays(→ godraysOn のことか?) が来た(このまま実行すると黙って無視される)
```

**エンジンの現物を確かめる — `dx12_describe_mcp_params`**: 「知らない引数」と弾かれた / 設定したのに
変わらないときは、これでエンジンが**実際に受け付けるキーと型**を引ける
（`dx12_describe_mcp_params(method:"set_dxr")` → `{methods:{set_dxr:[{key:"shadowEnabled",type:"any"},...]}}`。
`method` は `dx12_` 接頭辞なし、省略で全件）。docs や zod スキーマが古くてもこちらが正。

**メンテナ向け**: エンジン側の MCP ハンドラにフィールドを足したら `index.ts` の
`inputSchema` にも足すこと。忘れると `npm test`(`schemaDrift.test.ts`)が
`Application.cpp:<行> / index.ts:<行>` 付きで落ちる。
エンジンのハンドラは `McpDefine("名前", "キー:型,...", ...)` のディスパッチ表になっており、
`schemaDrift.ts` はその**申告表とハンドラ本文の両方**を読んで和集合を取る（どちらの書き忘れも拾う）。

### 影を柔らかくする — `dx12_set_shadow_pcss`

CSM の固定幅 3x3 PCF を「ブロッカー探索 → 可変ペナンブラ」に置き換える。
接地部は鋭く、離れるほど柔らかい影になる。**OFF に戻すと従来の PCF と絵がビット一致**するので、
「影のせいで変なのか」の切り分けにそのまま使える。

```
dx12_get_shadow_pcss()
# → {enabled:false, lightTanAngle:0.05, maxPenumbraTexels:16, blockerSearchTexels:8,
#    temporalDither:false, active:false, temporalDitherActive:false}
dx12_set_shadow_pcss(enabled:true, lightTanAngle:0.02)
```

- `enabled:true` なのに **`active:false`** なら効いていない ＝ シーンの影が切れているか、
  正射 / 2D ビューになっている（`active` はその 2 条件を見た結果）。
- `lightTanAngle` は太陽の角半径の tan。既定 `0.05` は誇張値で、**実際の太陽は 0.0044**（ほぼ硬い影）。
  ぼやけすぎたらここを下げる。
- `temporalDither` は **TAA 有効時だけ**効く（無効だとチラつくだけなのでエンジンが自動で切り、
  `temporalDitherActive:false` が返る）。設定はシーン JSON の `shadowPcss` に保存される。

---

## 「絵がなんか変」の切り分け — `dx12_render_debug`

最終画だけ見て原因を当てにいかないこと。**中間バッファを 1 枚ずつ見るのが最短**。
呼ぶ前と後でシーンの設定は**完全に同じ**（一時的に ON にした機能は必ず戻る）ので、
何度撃っても副作用が残らない。可視化はポスト前の `m_sceneRT` へ描くので、
`dx12_screenshot` でも必ず写る（この 1 点だけは `screenshot_final` でなくてよい）。

```
dx12_render_debug(mode:"normal")                       # 法線が飛んでないか
dx12_render_debug(mode:"depth", depthRange:60)         # 手前が潰れてないか(青=近→赤=遠)
dx12_render_debug(mode:"velocity", gain:20, frames:8)  # 静止時に一様なグレーなら正常
dx12_render_debug(mode:"lightComplexity")              # 白いところは 128 灯で切り捨て中
dx12_render_debug(mode:"ssr", frames:16)               # 時間蓄積があるので frames を増やす
dx12_render_debug(mode:"rtDiff", gain:20)              # ★加速構造の検証。黒=RT とラスタが一致
dx12_render_debug(mode:"off")                          # 撮らずに全部戻すだけ(リセット用)
```

- **`warnings` を必ず読む。** 真っ黒な絵の理由はだいたいここに出る
  （「フォグが無効なので何も出ない」「デカールが 1 枚も無い」「TAA を一時的に ON にした」）。
- `normal` / `roughness` / `metallic` / `velocity` は**深度+速度プリパスでしか書かれない**ので、
  TAA も SSR も SSGI も OFF なら**エンジンが TAA を一時 ON にして**撮る（`warnings` に出る）。
  この 4 モードが「ジオメトリだけの粗い絵」に見えるのは**仕様**。
  なお G-Buffer は**幾何法線**なので、`normal` に法線マップは載っていない
  （`roughness` / `metallic` も同じくスカラー値のみで ORM テクスチャは載らない）。
- `toneMapped:false` のモードは**トーンマップ / 露出を掛けずに** 8bit へ落とすので、
  **PNG のピクセル値がそのままバッファの値**として読める。
- **`albedo` と `overdraw` は意図的に非対応**。撃つと「なぜ無いか + 代わりに何を見ればいいか」を
  添えて弾かれる（`albedo` は前方レンダラなので G-Buffer が存在しない。`overdraw` は専用パスが要る）。
  代わりに最終画は `dx12_screenshot_final`、描画負荷は `dx12_perf_stats` の `draws`/`tris`、
  ライトの重なりは `mode:"lightComplexity"` を見ること。
- **`rt` / `rtDiff` は DXR 用**。`rt` はプライマリレイのヒット距離（空/ミスは黒、`depthRange` で正規化）、
  `rtDiff` は **|RT のヒット距離 − ラスタの距離|**（**黒 = 完全一致**、マゼンタ = 片方だけヒット）。
  **加速構造（BLAS/TLAS）が正しいかの検証はこれが本命**で、行列の転置ミスやノード変換の付け忘れを一発で炙り出す。
  `gain:20` くらいにすると 5cm でフルスケール。RT 影 / RT-AO が OFF でも TLAS を一時的に建てて撮る。
  **スキンドと半透明は TLAS に入らない仕様なのでマゼンタになるのが正常**。BLAS は LOD0 固定なので、
  遠くて低 LOD で描かれている物に数 cm の差が出るのも正常。
  DXR 非対応 GPU では**真っ黒になるだけでエラーにはならない**（`warnings` に理由が出る）。

---

## レイトレーシング — `dx12_get_dxr` / `dx12_set_dxr`

DXR 1.1 の inline raytracing（RayQuery）。**RT サン影**は既存のコンタクトシャドウ枠(t11)、
**RT-AO** は既存の SSAO 枠(t8) へ書くので、ルートシグネチャは 1 DWORD も増えない。
設定はシーン JSON の `raytracing` に保存される（`forceBuildTlas` だけは保存しない一時トグル）。

```
dx12_get_dxr()
# → {supported:true, raytracingTier:"1.2", highestShaderModel:"6.8",
#    shadowEnabled:false, shadowSunAngle:0.53, ..., shadowActive:false, tlasReady:true,
#    stats:{instances:412, blasCount:37, blasBytes:..., skippedSkinned:3, droppedOverLimit:0, ...}}
dx12_set_dxr(shadowEnabled:true, shadowSunAngle:0, aoEnabled:true, aoRayCount:4)
```

- **★まず `supported` を見る。** 非対応 GPU（DXR Tier 1.1 / SM 6.5 未満）では `dx12_set_dxr` は
  適用できない。その場合は**エラーではなく** `{applied:false, supported:false, retryable:false, reason, next}`
  が返る。**引数を変えて撃ち直しても永久に通らない**ので、`next` に従って
  `dx12_set_shadow_pcss`（CSM + PCSS）と `dx12_set_ssao` / `dx12_set_contact_shadow` で作ること。
  `dx12_get_dxr` の方は非対応 GPU でも**成功する**（`supported:false` が返るだけ）。
- `shadowEnabled:true` なのに **`shadowActive:false`** なら効いていない。`tlasReady` と `supported`、
  カメラ（正射）を疑う。
- **PCSS と併用するときは `shadowSunAngle:0`**（ハード）にして半影は PCSS に任せるのが正しい。
- **スキンドメッシュと半透明は加速構造に入らない**。そこは従来どおり CSM が担当し、フォワードの
  `min()` で合成される（`stats.skippedSkinned` / `skippedTransparent` に本数が出る）。
- `stats.droppedOverLimit > 0` なら TLAS のインスタンス上限に引っかかっている → `maxInstances` を上げる。
- コストは `dx12_perf_stats` の `gpuPassMs.raytracing`（BLAS/TLAS の構築）と `gpuPassMs.rtScreen`
  （RT 影 / RT-AO / RT デバッグのスクリーン空間パス）で見る。
- 加速構造そのものの正しさは `dx12_render_debug(mode:"rtDiff", gain:20)`、
  設定の矛盾は `dx12_diagnose(only:["dxr"])`。

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

### ★PBR マテリアルは 1 発で当てる — `dx12_material_apply`

`set_texture` を 3 回叩くのは往復が多いうえ、**後述の罠を踏むと ORM が効かない**。
素材フォルダを渡せば用途を推定して全部やってくれるこちらを既定にする。

```
dx12_material_apply(name:"Wall", dir:"textures/red_brick_03", uvScale:4)
# → {applied:true,
#     slots:{albedo:".../red_brick_03_diff.jpg",
#            normal:".../red_brick_03_nor_gl.png",
#            metalRoughness:".../red_brick_03_arm.png"},
#     pbrRequested:{metallic:-1, roughness:-1, uvScaleU:4, uvScaleV:4},
#     ignored:[{path:".../red_brick_03_disp.png", reason:"メッシュに高さ/変位テクスチャのスロットが無い…"}],
#     warnings:["ORM を有効にするため metallic/roughness の数値上書きを -1 へ戻した"]}

# 複数エンティティ / 個別指定 / サブメッシュ
dx12_material_apply(entities:[12,"Floor","Wall_02"], dir:"textures/concrete_02")
dx12_material_apply(entity:12, baseColor:"textures/a_diff.jpg", orm:"textures/a_arm.png", submesh:1)
```

**用途の推定規則**（`dir` を渡したとき。ファイル名を `_` `-` `.` で割って**最後に**当たった語を採る）:

| 用途 | 拾う語 | set_texture の slot |
|---|---|---|
| BaseColor | `diff` `diffuse` `albedo` `basecolor` `color` `col` | `albedo` |
| Normal | `nor` `normal` `norm` `nrm`（`nor_gl` を含む） | `normal` |
| ORM/ARM | `arm` `orm` `rma` `mra` `metalroughness` … | `metalRoughness` |
| Height | `disp` `displacement` `height` `bump` | **無し**（後述） |

推定できなかったファイルは**黙って捨てず** `ignored:[{path, reason}]` に理由付きで返る。
`nor_dx`（DirectX 規約の法線）は理由付きで**弾く** — このエンジンのシェーダは OpenGL 規約なので
`nor_gl` を使うこと。`ao` / `rough` / `metal` 単体も「ORM にパックしたものを使え」と理由が出る。
`disp`(height) はメッシュに割当先が無い（`set_texture` の slot は 3 つだけ）。変位を使えるのは
地形の `.terrainlayers` だけ。

**★踏みやすい罠: metallic/roughness の数値上書きが ORM テクスチャを殺す**

エンジンは `overrideMetallic >= 0 || overrideRoughness >= 0` のときに PBR flags から
metalRoughness テクスチャのビットを落とす（`Application.cpp` の `hasOverride`）。
`dx12_spawn_model` で読み込んだモデルはシーン JSON の `material.metallic/roughness` から
この上書きが入っていることが多く、**ORM を貼っても絵が変わらない**。

- `dx12_material_apply` は ORM を割り当てるとき **自動で `metallic:-1 / roughness:-1`**（= 上書き解除）
  を書くので、そのままで ORM が効く。`warnings` に何をしたか出る。
- 逆に `metallic` / `roughness` を**明示指定すると ORM は無効になる**。指定は尊重するが警告が出る。
  数値で金属感を作るか、テクスチャに任せるかのどちらかで、両取りはできない。
- `dx12_set_texture` を手で叩くときは、**自分で `dx12_set_pbr(metallic:-1, roughness:-1)` を撃つこと**。

適用後は `dx12_get_entity` で読み返して照合し、食い違えば `applied:false` + `mismatched` を返す。
`.dxmat` が割り当たっているエンティティや、法線/ORM を貼ったプリミティブには
`targets[].warning` で「割り当てても絵が変わらない理由」が付く。

### スケルタルアニメーション
```
dx12_get_anim_state(name:"Player")                     # → {clips:["Idle","Walk","Run"]}
dx12_play_anim(name:"Player", clipName:"Run", blend:0.2)
```
アニメーションの時間進行は Play 中。クリップはモデルロード時に読み込まれたもののみ。

#### ステートマシン(.animfsm / AnimatorController)
```
dx12_describe_anim_graph(entity:42)                    # → graph.layers[].states / graph.parameters
dx12_describe_anim_graph(path:"animations/player.animfsm")   # ファイルを直接読む(エンティティ不要)
dx12_play_anim(entity:42, state:"Run", blend:0.2)      # FSM のステート遷移(clip 経路ではなく)
dx12_play_anim(entity:42, state:"Wave", layer:1)       # 上半身レイヤーだけ差し替える
dx12_get_anim_state(entity:42)                         # → layers[].state / parameters(現在値)
```
`state` を渡さなければ従来どおりクリップ経路（完全後方互換）。ステート名は `dx12_describe_anim_graph` で確認する。

#### FSM のパラメータを外から叩く — `dx12_set_anim_param`
```
dx12_set_anim_param(name:"Player", param:"Speed", value:4.5)   # Float
dx12_set_anim_param(entity:42, param:"Grounded", value:true)   # Bool
dx12_set_anim_param(entity:42, param:"Jump", trigger:true)     # Trigger
dx12_get_anim_state(entity:42)                                 # → parameters で現在値を確認
```
**パラメータ名は `param`**。`name` は他ツールと同じ「エンティティ名」（`entity` と排他）。
エンジンには「`param` を省略したときだけ `name` をパラメータ名として読む」後方互換が残っているが、
**新しい呼び出しは必ず `param` を使うこと**（`{entity, name:"Speed"}` は動くが読む人が混乱する）。
遷移が実際に進むのは Play 中だけ。パラメータ名の一覧は `dx12_describe_anim_graph` の `graph.parameters`。

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

### terrain / sculptMesh / gridPlane も set_component 不可（B11）

`UNKNOWN_COMPONENT(6)` になるが、これは「知らない名前」ではなく**設計上そうしてある**。
コンポーネントを作り直すと、生きている高さ配列（`.hf`）／頂点配列（`.smsh`）とメッシュ・
コライダーの結び付きが切れるため。`dx12_describe_components` も `settable:false` と申告している。
名前を変えて撃ち直しても通らないので、**専用ツールを使うこと**。

| jsonKey | 代わりに使うもの |
|---|---|
| `terrain` | `dx12_terrain_create`（worldSize/maxHeight/uvScale/color の更新も兼ねる冪等ツール）/ `dx12_terrain_generate` / `dx12_terrain_sculpt` / `dx12_terrain_erode` / `dx12_terrain_paint` / `dx12_terrain_autopaint` / `dx12_terrain_sample` |
| `sculptMesh`（JSON 上のキーは `sculpt`） | `dx12_sculpt_create` / `dx12_sculpt_make_editable` / `dx12_sculpt_brush` |
| `gridPlane` | 触る必要が無い（読み込み時に `size` を無視して常に最新値で作り直す）。床が欲しいなら `dx12_create_entity(type:"plane")` か `dx12_terrain_create` |

**どうしても JSON のフィールドを書きたい場合**（例: `terrain.layerSetPath` に `.terrainlayers` を
割り当てる）は `dx12_scene_write` でシーン JSON を直接書いて `dx12_open_scene` で開き直す。

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
5. `dx12_ui_screenshot` — エディタウィンドウごと撮って見た目を確認（ゲーム内 UI は `dx12_screenshot`(シーン RT) には写らない。`dx12_screenshot_final` にはゲーム内 UI 画像は写るが ImGui のパネルは写らない）

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

## 地形・スカルプト・ライティング・診断（v0.7 追加）

### 画面の「ここ」を指して聞く / 触る — dx12_pick

スクショを見て「この物体は何？」「ここの床の高さは？」に答える口。**エディタの左クリック選択と
同じ実装（`RaycastScene`）**を通るので、AI が見たものと人が選ぶものが一致する。

```
dx12_screenshot_final()                 # 1280x720 の絵が返る
dx12_pick(x: 640, y: 400)               # そのピクセルに何があるか
# → {hits:[{entityId:42, name:"Rock", submeshIndex:0, distance:12.3,
#           worldPos:[3.2,1.1,-8.0], worldNormal:[0,1,0], isIcon:false}], count:1}

dx12_pick(u: 0.5, v: 0.5, all: true)    # 画面中央の重なりを手前から全部
```

`worldPos` はそのまま `dx12_set_transform` の position や `dx12_sculpt_brush` の position に使える。
ライト/カメラ/空オブジェクトはアイコン当たり（`isIcon:true`）で拾う。

真下の高さを知りたいだけなら `dx12_raycast_precise`:

```
dx12_raycast_precise(origin:[10, 200, -4], direction:[0,-1,0])
# → hits[0].worldPos[1] が地面の実際の高さ、worldNormal が傾き
```

★ `dx12_raycast`（物理コライダー基準・**Playing 中のみ**）とは別物。
`dx12_raycast_precise` は描画メッシュ基準で **Editor でも動く**（地形の起伏に正しく当たる）。

### ワークフロー: 山を作って木を配置する

```
# ① 地形を作る（同名があれば設定更新なので撃ち直しても安全）
dx12_terrain_create(name:"Terrain", resolution:128, worldSize:400, maxHeight:120)
# → {entityId: 88, created:true, ...}

# ② 土台の形を一発生成（★彫る前に必ずこっちを先に。高さを丸ごと作り直すので後からやると彫りが消える）
dx12_terrain_generate(entity:88, preset:"mountains", seed:7, amplitude:60, edgeFalloff:0.6)
# → {minHeight:-2.1, maxHeight:58.4, params:{...}}   同じ seed なら毎回同じ地形

# ③ 浸食で「CG くさい斜面」を自然にする
dx12_terrain_erode(entity:88, iterations:24, talusDeg:32)

# ④ 平地を作る（絶対値なので何回撃っても同じ形に収束する＝冪等寄り）
dx12_terrain_sculpt(entity:88, brush:"flatten", point:[0,0], radius:40, strength:2, flattenHeight:10)

# ⑤ 見た目を確認（★彫った結果は次フレームで反映されるので step_frames を挟む）
dx12_step_frames(frames:2)
dx12_screenshot_from(position:[0,180,-260], target:[0,0,0])

# ⑥ 木を地形に沿って置く: まず候補点の高さと傾きを聞く
dx12_terrain_sample(entity:88, points:[[-40,-20],[10,35],[60,-5]])
# → samples:[{x:-40,z:-20,worldY:23.4,slopeDeg:12.1,inside:true}, ...]

# ⑦ 急斜面(slopeDeg 大)を避けて worldY へ置く
dx12_spawn_model(path:"models/tree.glb", position:[-40, 23.4, -20], name:"Tree_1")

# ⑧ ばら撒くなら scatter + snap（snap_to_ground は三角形精密なので地形の起伏に吸い付く）
dx12_scatter(model:"models/tree.glb", count:40, area:[-150,-150,150,150],
             seed:3, randomYaw:true, scaleRange:[0.8,1.3], snapToGround:true)

dx12_save_scene()
```

★地形の編集は**すべて Editor 限定**（Playing 中は `MODE_CONFLICT(3)` → 先に `dx12_stop`）。
高さ配列は `assets/terrain/<name>.hf` に自動保存され、Jolt の当たり判定も同じ配列を読むので
彫れば衝突も一緒に動く。

### ワークフロー: 地形にテクスチャを塗る（4 層スプラット）

`terrain.layerSetPath` に `.terrainlayers`（4 層の PBR 素材）が割り当たっている地形だけが対象。
**未割当なら `INVALID_PARAM(2)`**。割当は **`dx12_terrain_set_layers` が唯一の MCP 経路**
（`dx12_set_component(component:"terrain")` は使えない → 後述の B11）。

```
# ⓪ レイヤーセットを割り当てる（初回だけ。スプラットが無ければ作って自動で塗る）
dx12_terrain_set_layers(name:"Terrain", layerSetPath:"terrain/alpine.terrainlayers")
# → {layerCount:4, layerNames:["grass","dirt","rock","snow"], splatCreated:true, splatSize:512}
#   ★ここが無いと terrain_paint / terrain_autopaint は永遠に INVALID_PARAM で弾かれる。
#   layerSetPath:"" を渡すと割当を外して従来の頂点色の見た目へ戻る。
#   uvScale / triplanar / pom / macro / distTiling 等のマテリアル設定もここで一緒に触れる
#   （省略したものは触らない＝冪等）。★Editor 限定。

# ① 傾斜と標高から全面を焼き直す（★冪等。手で塗った内容は消える）
dx12_terrain_autopaint(entity:88, rockSlopeStart:0.35, rockSlopeEnd:0.6,
                       snowHeightStart:45, snowHeightEnd:70, noiseStrength:0.25)
# → {entityId:88, splatSize:512}

# ② 道・崖・広場だけ手で上書き（★相対操作。2 回撃つと 2 回ぶん塗れる）
dx12_terrain_paint(entity:88, layer:1, points:[[-40,-20],[-10,0],[20,25]],
                   radius:8, strength:1, falloff:0.3)
# → {layer:1, points:3, changed:true, splatSize:512}

# ③ 絵を見ずに数値で確認する（読み取り専用。Playing 中も可）
dx12_terrain_splat_info(entity:88, gridSize:8, point:[-10,0])
# → {coverage:[0.42,0.31,0.19,0.08], dominantRatio:[...],
#    grid:["00112233", ...],            # grid[z][x] = '0'..'3' の支配レイヤー
#    samples:[{world:[-10,0], texel:[228,256], weights:[0,1,0,0], dominant:1}]}

dx12_step_frames(frames:2)
dx12_screenshot_from(position:[0,180,-260], target:[0,0,0])
```

- `layer` は `.terrainlayers` の並び順（既定は 0=草 / 1=土 / 2=岩 / 3=雪）。
- 座標は**ワールド XZ**。`dx12_pick` の `worldPos:[x,y,z]` をそのまま渡してよい（y は無視）。
  `point` / `points` / `worldPos` は MCP 側で `points` に畳んでから送るので**二度塗りにならない**。
- `strength:1` を 1 回でそのレイヤー 100%。他レイヤーは合計 1 を保つよう比例縮小される。
- **高さを彫り直したら重みは追従しない**。`terrain_generate` / `terrain_sculpt` / `terrain_erode` の
  後は `autopaint` をやり直すこと。順序は「generate → erode → autopaint → paint」。

### ワークフロー: 洞窟・アーチ・岩みたいな異形を作る（スカルプト）

地形（ハイトフィールド）は XZ グリッドなので**オーバーハングが作れない**。せり出した岩・
アーチ・洞窟はこっち。

```
# ① 素体（岩なら sphere、アーチ/柱なら cylinder、崖なら box）
dx12_sculpt_create(name:"Rock_A", primitive:"sphere", subdivisions:20, size:4, position:[0,2,0])
# → {entityId: 91, vertexCount: 1682, ...}

# ② 彫る場所は画面から拾うのが確実
dx12_focus_and_screenshot(entity:91)
dx12_pick(u:0.5, v:0.5)          # → worldPos:[0.1, 3.8, -1.6]

# ③ ブラシ（position はワールド。radius/strength は★メッシュのローカル単位）
dx12_sculpt_brush(entity:91, brush:"draw",   position:[0.1,3.8,-1.6], radius:1.2, strength:0.6)
dx12_sculpt_brush(entity:91, brush:"noise",  position:[0.1,3.8,-1.6], radius:2.0, strength:0.3)
dx12_sculpt_brush(entity:91, brush:"smooth", position:[0.1,3.8,-1.6], radius:1.5, strength:1.0)
# 左右対称に彫るなら symmetryX:true

# ④ 既存モデルを彫れるようにする（元の .glb は書き換えない。コピーができる）
dx12_sculpt_make_editable(name:"Statue")
# → {entityId: 95, name:"Statue_Sculpt", created:true, vertexCount:...}

dx12_step_frames(frames:2)
dx12_focus_and_screenshot(entity:91)
```

★ブラシは**相対操作**（撃つたびに彫れる）。狙いすぎず「少し撃つ → 見る」を繰り返すのが速い。

### ワークフロー: ライティングを詰める

```
# ① まず現状把握。★ここで「上限超過」が出てたら何をやっても暗いままなので最初に見る
dx12_list_lights()
# → budget:{point:{used:11,max:8}, ...}, warnings:["ポイントライトが上限超過 (11/8)。超えた分は無言で描画されない..."]
#    各ライトの overBudget / effective で、どれが効いていないか分かる

# ② 土台をプリセットで決める（エディタの「ライティング」窓と同じ実装＝人の操作と結果が一致する）
dx12_apply_lighting_preset(preset:"dusk")   # day / dusk / night / indoor / horror / studio

# ③ 太陽を絶対値で詰める（冪等。何回撃っても同じ結果）
dx12_set_sun(timeOfDay: 17.2)                       # 時刻カーブで向き/色/強度/環境光を一括
dx12_set_sun(azimuth: -35, elevation: 12)           # 方位/高度を直接（太陽が見える方向）
dx12_set_sun(kelvin: 2900, intensity: 2.4)          # 電球色にする

# ④ ポストで仕上げ
dx12_set_post_process(bloomOn:true, bloom:0.45, vignetteOn:true, vignette:0.35)

# ⑤ 目で見る
dx12_screenshot_game_view()
```

★灯数の上限はクラスタードライティング(Forward+)で **点+スポット合計 1024 灯**（点/スポットの
個別上限は無い）。ただし画面を割ったクラスタ 1 マスあたりは **128 灯**までで、ライトが密集して
超えた所は無言で切り捨てられる（MCP からは検出できないので、エディタの
「ツール > ライティング > クラスタデバッグ表示 > ライト複雑度」で白く飽和する所を見るしかない）。
**影が落ちるのは spot 4 / point 2 のまま**＝灯数の上限が消えても影の上限は消えていない。
**超えた分は無言で描画されない**（パーティクルの発光ライトも枠を使う）。
「増やしたのに明るくならない」はほぼこれ。

### ワークフロー: ルック(絵作り)を決める — 光・空気・グレーディングを 1 セットで

ポストは約 90 フィールドある。1 つずつ触っても「それっぽい絵」にはならない
（bloom と exposure だけ上げて終わる、が典型）。映画的な絵は
**光 → 空気(フォグ) → グレーディング** の 3 段が噛み合って初めて出る。

```
dx12_look_library()                        # 13 種。tag で絞る(night / stylized / indoor …)
dx12_look_library(id:"neon_noir")          # 1 つの全フィールドの実値と注意書き

dx12_look_apply(preset:"golden_hour")                    # 太陽 + フォグ + 空 + ポストを全部
dx12_look_apply(preset:"horror_candle", strength:0.6)    # ポストだけ 6 割の効き
dx12_look_apply(preset:"neon_noir", parts:["post"])      # 今の光は壊さずグレーディングだけ乗せる
dx12_look_apply(preset:"clean_studio", dryRun:true)      # 何も変えずに適用値を見る
```

- `strength`(0..1) は**ポストにだけ**効き、0 に向かって **無味無臭の値**へ寄る
  （0 になるのではない。contrast を 0 にしたら灰色になってしまう）。太陽とフォグは常に指定どおり。
- 当てた後は **必ずエンジンから読み返して** `currentPost` を返す。
  食い違いは `mismatched` に出る（＝「当てたのに変わらない」を AI 自身が検知できる）。
- `dx12_apply_lighting_preset`(エンジンの 6 種)は**土台**（エディタのライティング窓と同じ実装）。
  `dx12_look_apply` はその上に乗せる**仕上げ**。両方使ってよい。

**ルック一覧**: golden_hour / blue_hour / moonlit_night / overcast_gloom / neon_noir /
horror_candle / clean_studio / anime_daylight / desert_heat / underwater / film_noir /
dreamy_soft / retro_vhs。それぞれ `pairsWith` に相性の良い VFX が入っている
（neon_noir なら rain + steam_vent、horror_candle なら candle + ground_mist）。

#### 絵作りで踏む罠

- **暗いルックは「光源を置いてから」当てる**。真っ暗なシーンに horror を当てても真っ黒なだけ。
  `dx12_look_apply` は、太陽を消すルックなのにライトが 1 つも無いと警告を返す。
- **envMap(HDRI)があると `DirectionalLight.ambient` は無視される**。暗くならないときはこれ。
  `dx12_set_scene_settings` で `iblIntensity` を下げるか、`parts` に `sky` を含めること。
- **フォグとゴッドレイを両方強くすると太陽の散乱が二重に乗る**。どちらかを主役にする。
- **`<name>On` を立てないと数値は効かない**。ルックは必ずスイッチ込みで当てる（テストで担保）。
- **彩度の高い光源(ネオン/魔法)が ACES で色割れする**ときは `tonemapper:1`(AgX)。
  neon_noir / anime_daylight / dreamy_soft は既にそうしてある。

### ワークフロー: エフェクト(VFX)を置く — レシピ → 置く → 時間で見る

炎・煙・魔法・爆発・雨のようなパーティクルは **1 レイヤーでは絶対にそれらしくならない**
（本物の炎は「炎＋煙＋火の粉」）。レシピ集から複数レイヤーごと置くのが速い。

```
# ① 何が作れるか（33 レシピ。tag で絞れる: fire/smoke/magic/impact/weather/water/electric/trail/ambient）
dx12_vfx_library(tag:"fire")
# → presets:[{id:"torch", title:"松明の炎", layers:3, layerNames:["Flame","Smoke","Sparks"], ...}]
dx12_vfx_library(id:"campfire")        # 1 つの全レイヤーの実値と注意書きまで見る

# ② 置く（新規エンティティを作るか、既存へ付ける。倍率で調整）
dx12_vfx_apply(preset:"torch", position:[3, 2.1, -4], parentName:"FX")
dx12_vfx_apply(preset:"magic_circle", position:[0,0.05,0], scale:1.5, color:[0.9,0.2,0.2])
dx12_vfx_apply(preset:"explosion", name:"Boss_DeathFX")     # 既存エンティティに付ける
dx12_vfx_apply(preset:"torch", dryRun:true)                  # 何も変えずに適用値だけ見る

# ③ ★時間で見る（静止画 1 枚では「出ていない」のか「たまたま写っていない」のか分からない）
dx12_vfx_preview(name:"FX_torch", seconds:2, frames:6, distance:3)
# → 格子画像 + {visible, sceneLuma, stats:[{changedPct, effectPeak, blownAreaPct, motionPct}], suggestions}
dx12_vfx_preview(name:"FX_explosion", fire:true, seconds:1, frames:8)   # ワンショットを試し撃ち
```

`dx12_vfx_preview` は **先に放出器を一時的に遠くへ退けて「効果が無いときの絵」を 1 枚撮り**、
それとの差で効果の面積・明るさ・白飛びを数える（撮り終わったら必ず元へ戻す）。
フレーム間の差だけで測ると、**同じ場所で燃え続ける炎を「出ていない」と誤判定する**ため。

**倍率**: `scale`(大きさ。size/speed/offset/lightRange) / `rate`(密度) / `intensity`(HDR 強度) /
`color`(加算レイヤーの主色だけ。煙は元の色のまま・終了色は明度比を保って追従) / `oneShot` / `life` / `light`。

#### ★パーティクルで「安っぽく」なる 3 つの原因（実測して分かった）

1. **密度 × 強度の掛けすぎ**。加算ブレンドは重なった枚数だけ足し算になるので、
   `rate` を上げたまま `intensity` を上げると **芯が真っ白に潰れて色も形も消える**
   （松明を intensity 4.0 で置くと、暗い部屋でもただの白い球にしかならなかった）。
   粒が重なる層は **rate × intensity ≒ 50** が目安（rate 34 → 1.6 / rate 55 → 1.0 / rate 80 → 0.9）。
   逆に**火の粉・星屑のような細かくて重ならない粒は intensity 6〜8 で構わない**。
   「点が光っている」ように見せる唯一の作り方で、炎の中の粒立ちもこれで出す。
2. **大きい Glow を強くする**。`kind:0`(Glow) は 1 枚でも画面を覆うので、size 0.5 以上なら
   intensity は 1.2 まで。魔法陣の中心を size 0.9 / intensity 2.0 にしたら、
   リングが見えない **白いドーム** になった。
3. **色が淡い**。加算＋ブルームは色を白へ流すので、`[0.6,0.9,1.0]` のような淡い青は画面では
   **ただの白**になる。狙った色相を残すなら `[0.25,0.65,1.0]` くらいまで濃くして指定する。

その他の定石:
- **煙・埃・血・雪・灰は `blend:1`(前乗算アルファ)**。加算にすると白く光って煙に見えない。
- **暗いアルファの粒は暗い背景では文字通り見えない**。煙や血の確認は明るい床/空を背にして撮ること。
- **上へ立ち上る物は `gravity` を正**にする（浮力）。落ちる物は負。
- `light:true` は明るい粒を実ポイントライト化する。**ライト予算を食う**ので、同じ効果を 4 個以上
  並べるなら `light:false` で置いて代表 1 個だけ点ける（`dx12_list_lights` で確認）。
- CPU パーティクルの上限は**シーン全体で 8000 粒**。`dx12_vfx_apply` の返り値
  `estimatedLiveParticles` で 1 個あたりの目安が分かる。大量に撒く雨/雪は `gpu:true`（別枠 131072）。
- **ワンショット(explosion / impact_sparks / dust_puff …)は置いただけでは鳴らない**。鳴らす口は 3 つ:
  - Lua: **`fx:play("FX_Boom")`**(v1.18.0+。レイヤー名を渡せば 1 枚だけ。`fx:stop` で止める)
  - 演出: `dx12_sequence_author` の `vfxPlay` / `vfxStop` トラック
  - 配線: Trigger の `PlayEffect`(type:4, target:放出器の名前)

  確認だけなら `dx12_vfx_preview(fire:true)`（内部で `fx:play` を撃つので **Editor のまま鳴る**）。

#### レシピから外れた微調整（生のレイヤー操作）

```
dx12_list_particle_layers(name:"FX_torch")                  # index / name を見る
dx12_set_component(name:"FX_torch", component:"particleEmitter", layer:1,
                   data:{ rate: 4, size: 0.3 })              # layer 指定で 2 枚目を触る
dx12_add_particle_layer(name:"FX_torch", layerName:"Ash")    # 4 枚目を足す（上限 16）
dx12_remove_particle_layer(name:"FX_torch", layer:"Ash")     # 最後の 1 枚は消せない
```

`layer` を省いた `set_component` は **1 枚目だけ**を書き換える（レイヤーは追加されない）。
2 枚目以降を触るには必ず `layer`(index か名前)を渡すこと。

#### 粒に自作シェーダーを貼る

```
dx12_describe_shader_contract(kind:"particle")   # ★書く前に必ず読む(mesh とは別契約)
dx12_list_shader_templates()                      # 動く雛形から始める
dx12_create_shader(name:"Ember", template:"particle_ember")
dx12_set_component(name:"FX_torch", component:"particleEmitter", layer:0,
                   data:{ shaderPath:"Ember.hlsl" })
```

### ワークフロー: 演出(カットシーン)を作る — 台本 → 生成 → 流して見る

カメラ・ポスト・時間・エフェクト・音が【同じ時間軸で噛み合って】初めて演出になる。
Lua を手書きすると毎回ちがう自己流の状態機械が生えて、スローモを入れた瞬間に台本が壊れる。

```
dx12_sequence_author(
  name: "BossReveal",
  camera: "CutsceneCam",        # ★CameraComponent を持つエンティティ名
  activateCamera: true,          # そのカメラを「映るカメラ」にする
  tracks: [
    { t:0.0, type:"fade",   to:"clear", dur:0.8 },
    { t:0.0, type:"camera", from:[0,6,14], to:[0,2.2,6], lookAtName:"Boss", dur:3.2, ease:"inOut" },
    { t:0.4, type:"sound",  path:"audio/boss_theme.wav", bgm:true },
    { t:2.6, type:"vfx",    preset:"explosion", atName:"Boss", scale:1.4 },
    { t:2.6, type:"shake",  amp:0.35, freq:26, dur:0.7 },
    { t:2.6, type:"timeScale", value:0.25 },
    { t:3.1, type:"timeScale", value:1.0, dur:0.4 },
    { t:3.2, type:"post",   set:{ saturation:1.35, contrast:1.2 }, dur:1.0 },
    { t:4.4, type:"event",  name:"bossFightStart" },
  ])
# → components/BossReveal.lua を生成して SEQ_BossReveal に貼る
#   {duration, trackCount, playEvent, stopEvent, doneEvent, referenced, warnings}

dx12_sequence_preview(name:"BossReveal", seconds:5, frames:6)
# → ゲーム画面の連写(格子画像) + frameDiffs + recentLog
```

**track の type**: `camera`(移動+注視) / `fade`(black|white|clear) / `post`(グレーディングを時間で) /
`timeScale`(スローモ・ヒットストップ) / `shake`(画面揺れ) / `vfx`(VFX レシピをその場で撃つ) /
`vfxPlay`・`vfxStop`(**置いてある放出器**を鳴らす/止める) / `shaderParam`(カスタムシェーダーの値を時間で動かす) /
`sound`(SFX/BGM) / `move`・`rotate`(物を動かす) / `light`(明るさ・色) / `event`(Lua イベント) /
`scene`(フェードして遷移) / `log`。共通で `t`(開始秒) `dur`(長さ)
`ease`(linear/in/out/inOut/outBack/outBounce)。

```
# 置いた多層エフェクトを鳴らす(fx:burst と違い Inspector で組んだ構成をそのまま使う)
{ t:2.6, type:"vfxPlay", target:"FX_BossAura" }
{ t:5.0, type:"vfxStop", target:"FX_Rain", layer:"Drops" }
# カスタムシェーダーを時間で動かす(param: effect / p1..p4 / b1..b3)
{ t:0.2, type:"shaderParam", target:"Sea", param:"effect", from:0, to:1, dur:2.5, ease:"inOut" }
```

生成された Lua は**読める・手で直せる**。ただし同じ `name` で撃ち直すと上書きされる。
他のスクリプトからは `events:emit("<name>:play")` / `("<name>:stop")` で操作でき、
終わると `"<name>:done"` が飛ぶ。

#### 演出で踏む罠（全部ツール側で先回りしてある）

- **★動かすカメラが「映るカメラ」でないと画面は 1mm も変わらない**。
  CameraComponent は `isActive` が立っている 1 つだけが使われる。
  `dx12_sequence_author` は今アクティブなカメラを調べ、食い違っていれば警告する
  （`activateCamera:true` で切り替える。`camera` 省略時はアクティブなカメラを自動で使う）。
- **★`dx12_set_editor_camera` の固定が残っているとゲーム画面が撮れない**。
  固定中はゲームカメラの同期が止まるので、演出が動いても静止画が並ぶだけになる。
  `dx12_sequence_preview` は撮る前に必ず `release` する（VFX プレビューも後始末で外す）。
- **時計はタイムスケール非適用(`time.realDt()`)**。スローモを掛けても台本は実時間で流れる
  （スケール適用だと「0.25 倍速の 3 秒後」が実時間 12 秒になって台本が壊れる）。
- **終了時にタイムスケールを 1.0 へ戻す**。演出がスローモのまま終わるとゲームが壊れるため。
- **画面揺れは前フレームぶんを引いてから足す**。足しっぱなしだとカメラが少しずつ漂う。
- **グローバルの `camera` を Lua から動かしても無駄**。毎フレーム
  `ApplyCameraTransformToGlobal` が上書きするので、**カメラ役エンティティの transform** を動かす。
  生成コードはそうなっている（pitch の符号反転も込み）。
- `scene` トラックの後ろに置いたトラックは実行されない（遷移でスクリプトごと消える）。検査が警告する。

### ワークフロー: 汚れ・傷を入れる（デカール）

弾痕・焦げ・血・水たまり・苔・汚れは「そこで何かが起きた」を語る。1 つも無い床は、
どれだけ光を凝っても**出荷前のショールーム**に見える。

```
dx12_decal_library()                 # 14 種。床専用か壁にも貼れるかが surface に出る
dx12_decal_apply(preset:"dirt",   position:[0,0,0], size:2.4, opacity:0.4)
dx12_decal_apply(preset:"bullet_hole", position:[1,1.2,-3], normal:[0,0,1], count:6, spread:0.5)
dx12_decal_apply(preset:"puddle", position:[2,0,1], size:2)     # roughness を落とすので SSR で映る
dx12_decal_apply(preset:"scorch", position:[0,0,0], dryRun:true) # 姿勢と値だけ見る
```

- **面の座標と法線は `dx12_raycast_precise` / `dx12_pick` の `worldPos` / `worldNormal` をそのまま渡す**のが正確。
  `normal` 省略は「床(真上)」扱い。
- `count` を渡すと**大きさ・向き・位置を散らして**複数枚貼る（同じ判が並ぶと一発で嘘に見える）。
- 初回に **アトラス画像を手続き生成**して `assets/textures/decals/atlas.png` に置き、
  シーンの `decalAtlasPath` に設定する（**アトラスが無いとデカールは無言で何も出ない**ため）。

#### デカールで踏む罠

- ★**エディタのグリッド平面と床が同じ高さだと、グリッドが上に描かれてデカールが見えない**
  （グリッドはデカールを受けない）。「貼ったのに出ない」ときは床を少し上げるか Grid を消して確認する。
- ★**箱は面をまたぐように置く**（中心＝面）。法線方向へずらすと面が箱の底面に来て、
  縁フェードで 0 になり何も描かれない。`dx12_decal_apply` はそう置いている。
- **`puddle` / `blood_pool` / `oil` / `snow` は角度フェードが小さい＝ほぼ水平面専用**。
  壁に貼ると薄くなって消える（ツールが先に警告する）。壁には `dirt` / `leak` / `blood_splatter`。
- **投影軸はデカールのローカル +Y**。面内で回したいときは `rotationDeg`（法線まわりの回転として扱う）。
  euler の roll に直接入れると投影軸ごと傾いて薄くなる。
- 上限は**シーン全体で 256 枚 / クラスタ 1 マスあたり 16 枚**。密集させると切り捨てられる
  （`dx12_render_debug(mode:"decalCount")` で白くなる所が切り捨て中）。

### ワークフロー: 「まだ安っぽい」を潰す — `dx12_polish_audit`

`dx12_diagnose` は**壊れているか**、`dx12_look_compare` は**参照画像との差**を見る。
参照が無い状態で「作りかけに見える理由」を言うのがこれ。

```
dx12_polish_audit()                      # 最終画も撮って全カテゴリ
dx12_polish_audit(screenshot:false)      # 設定だけ見る(速い)
dx12_polish_audit(only:["light","air"])  # カテゴリを絞る
# → {score, verdict, findings:[{category, severity, what, why, fix}], facts}
```

`findings` は**効く順**（光 → 空気 → 階調 → 動き → 素材 → 接地 → 絵そのもの）に並び、
各項目に **why（なぜ安っぽく見えるか）** と **fix（そのまま撃てるコマンド）** が付く。
上から順に `fix` を実行して撃ち直せばスコアが上がる（実測: 既定シーン 34 →
`dx12_look_apply` + `dx12_vfx_apply(dust_motes)` + SSAO + コンタクトシャドウで 64）。

拾うもの: HDRI が無く手続き空のまま / 光源が 1 灯だけ / 影を落とすライトが無い /
フォグが無い / ポスト素通し / ブルーム無し / 動くものがゼロ / 法線マップ無し /
PBR が既定のまま / SSAO 無し / 眠い絵（実効レンジ < 0.35）/ 白飛び / 真っ黒すぎ / 彩度ゼロ。

**読めなかった項目は判定しない**（「読めなかった」を「無い」と決めつけない）ので、
Play 中や一部 API が使えない状況でも嘘を言わない。

### ワークフロー: 壊れてないか 1 発で確認する

```
dx12_diagnose(fast: true)     # 重い検査(textures/models=assets全走査)を外して数秒で返す
# → {summary:{errors:1, warnings:3, ok:false}, checks:[{id:"lighting", issues:[{level:2, text:"..."}]}]}

# 判定は summary.errors > 0 だけを見ればいい（注意/情報は失敗ではない）
dx12_diagnose(only: ["lighting","terrain","picking"])   # 気になる所だけ
dx12_diagnose()                                          # 全部（アセット数によっては数十秒〜）
```

検査 ID: `shaders` / `textures` / `models` / `gamma` / `scene_assets` / `lighting` /
`terrain` / `picking` / `instancing` / `scripts`。
issue は日本語 1 行で「次の一手」まで書いてある。`instancing` は 1 度も描画していないと測れない
（`skipped` に理由が入る）。**シーンをいじった後・Play する前に 1 回叩く**のが安上がり。

---

## エラーメッセージの読み方（hint / 有効値）

引数を間違えたときのエラーには、**次に何をすればいいか**と**有効値の一覧**が付いてくる。
推測でリトライせず、そのまま従うのが速い。

```
エラー(code=2): unknown brush: dig
ヒント: 有効値のどれかを指定してくれ
有効な値: raise, lower, smooth, flatten, noise
```

```
エラー(code=3): cannot modify terrain while Playing
ヒント: 先に dx12_stop で Editor へ戻してくれ
```

---

## エラーコード早見表

| コード | 意味 | 典型的な対処 |
|--------|------|------------|
| 1 | NOT_FOUND | entityId / path / jsonKey を確認 |
| 2 | INVALID_PARAM | describe_components でフィールド型を確認 |
| 3 | MODE_CONFLICT | dx12_stop → 再試行 |
| 4 | STALE_SCENE | **予約のみ・現状は送出されない**（実際は NOT_FOUND(1) が返る）。§ の説明を見ること |
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
- **`layout.errors > 0` を無視して次の作業へ進む** → 埋まり・ちらつき・すり抜けがそのまま残る。
  play / save の返り値に出ているものは必ず片付けてから進むこと。
- **ルート直下にエンティティを置きっぱなしにする / `Box` `Sphere` のまま放置する** → 共同開発者が読めない。
  生成時に `group` を渡すか、最後に `dx12_organize_scene(dryRun:false)` を通すこと。
- **`boxCollider` を付けただけで当たり判定が効いたと思う** → `rigidBody` が無いと Jolt に載らない。
- **`key_down` → `step_frames` → `get_entity` を何十回も往復する** → 遅いうえ dt が実時間で再現しない。
  `dx12_play_script` に台本ごと渡すこと。
- **`dx12_check_reachable` が通っただけで「クリアできる」と言う** → 静的判定にすぎない。
  `dx12_autoplay` で実際に走破させてから言うこと。
- **Blender から手で `export_scene.gltf` を呼ぶ** → 全シーン書き出し・tmp 画像名・真っ白マテリアルの
  どれかを必ず踏む。`dx12_blender_export` を使うこと。
