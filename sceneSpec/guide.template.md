# シーン仕様(SceneSpec)で作る
> 何を置きたいかを JSON で宣言して 1 回で渡す。差分だけを 1 トランザクションで作り、自動検証し、失敗は specPatch(そのまま撃ち直せる差分)で返る。

## 0. 流れ(3 手)
1. `dx12_apply_scene_spec {spec, mode:"plan"}` … 作成 / 更新 / 削除 / 変更なしと理由・コスト(何も書かない)。
2. `dx12_apply_scene_spec {spec}` … 適用。**1 トランザクション**(Undo 1 回で丸ごと戻る)→ 自動検証。途中の失敗・検証落ちは**全体をロールバック**。
3. 失敗したら `issues[].specPatch`(全部まとめたものが `details.specPatch`、`fix[0]` がそのまま撃てる形)を **`{specRef, patch}`** で撃ち直す。spec の全文を送り直さない。

同じ仕様をもう一度撃っても何も変わらない(冪等)。仕様を 1 行直すと最小の差分だけ動く。大規模(数百体以上)は `async:true`(ジョブ)。上限は 5,000 体。

## 1. 仕様の形
```json
{"version":1, "name":"room", "entities":[
  {"name":"LVL_Floor","kind":"box","size":[8,0.2,6],"group":"LVL","at":[0,-0.1,0]},
  {"name":"ENV_Crate","kind":"box","size":1,"group":"ENV","at":[2,null,1],"place":{"on":"LVL_Floor"}}],
 "lighting":{"preset":"indoor"}}
```
- **name** は差分適用のキー(仕様の中で一意)。名前規約 `<PREFIX>_<Kind>`(LVL_ ENV_ LGT_ GP_ FX_ UI_ CAM_)+ `group`。**name を変えても同じ物として追従させたいときは `id`**(既定は name。パターンは `<id>_<NN>`)。
- **単位はメートル**。Euler は度(YXZ)。`at` の `null` の軸は `place` などで決まる。親が無ければワールド、`parent` があればローカル。
- **kind**: box / sphere / plane / model(`model` に assets 相対パス。読み込み時に実寸 m になる。`scale` は倍率)/ prefab / empty / camera / light(`light`: directional|point|spot)/ trigger / particle_emitter / decal / ui_* / **fps_player**(本体 + カメラの 2 体)。
- **size** = プリミティブの実寸 m(box `[w,h,d]`・sphere は直径・plane `[w,d]`)。**scale** = 倍率。併用不可。
- `color`("#rrggbb" か [r,g,b] 0..1)・`material`({metallic, roughness, emissive, emissiveIntensity, opacity, alphaMode, uvScale})・`texture`({albedo, normal, metalRoughness, emissive})・**`collider`**("static" / "dynamic": 当たり判定の略記。rigidBody + 形に合うコライダー。床・壁は static)・`components`({jsonKey:{フィールド}}。`dx12_describe_components`)・`script`(Lua のパス、または {path, props})・`tags`・`data`({キー:数値|真偽|文字列|[x,y,z]})・`lookAt`(名前か座標。`rotation` と併用不可)。
- 設定: `lighting:{preset}` / `look:{preset,strength}` / `sun` / `scene` / `navmesh:{build:true}`。エンジンの rollback で戻らない設定は、検証が通った後に撃つ(entity の明示値が設定より優先)。
- **指定した項目だけを管理する**: 書かなかった rotation / scale / 軸は、既存の物では手で変えた値を尊重する。

## 2. 相対配置(place)— 解決は決定論。AABB の実測(モデルは asset_info、プリミティブは解析)で決まる
軸はワールド: right=+X left=-X front=+Z back=-Z above=+Y below=-Y。yaw 0 は +Z を向く。
- `{"relativeTo":"A","side":"right","gap":2}` … A の右 2m(面と面のすき間)。他の軸は中心揃え、y は底揃え。`align:{x,y,z}` で変える。
- `{"on":"A"}` … A の上に載せる(上面に底を合わせる。x,z は A の中心)。`at:[3,null,-2]` と併用すると y だけ決まる。
- `{"ground":true}`(または高さ m)… 足元を地面に。`{"snap":true}` … 置いた後にエンジンの snap_to_ground(真下の実際の面)。
- `{"offset":[dx,dy,dz]}` … 解決後のずらし。`lookAt` … 向きを決める。

## 3. パターン(pattern)— 同じ物を N 個。名前は `<name>_<NN>`(2 桁ゼロ埋め)
- `grid`: `count:[nx,nz]` `spacing:[sx,sz]`(中心間隔)`origin`(中心)`jitter`。
- `ring`: `count` `radius` `origin` か `around`(名前)`startAngle`(+Z が 0)`faceCenter`。
- `line`: `count` `from` `to`(`null` の軸は place に任せる)または `step`。
- `along`: `of`(壁など)`side` `count` `margin` `gap` … 面に沿って等間隔。
- `scatter`: `count` `area`([minX,minZ,maxX,maxZ] か名前)`seed` `minSpacing` `yaw:"random"` `scaleRange` `exclude`([名前])。**同じ seed は同じ位置**(幹と葉を同じ seed で重ねられる)。置けなければ W_SCATTER_SHORT。
- `skip:[3,7]` … 作らない連番。パターンの instance は個別に参照できる(`Pillar_03`)。

## 4. 検証(verify)
既定: layout=error(埋まり BURIED・重なり DUPLICATE / OVERLAP・当たり判定なし COLLIDER_WITHOUT_BODY。**この仕様が作った物の error はロールバック**)、naming=warn。`verify:{reachable:{from:"GP_Player",to:"GP_Goal"}}` は到達性(ナビメッシュを焼く: `navmesh:{build:true}`)。`verify:false` で全部省く。warning にも specPatch が付く(浮き FLOATING → `place.snap:true` など)。

## 5. 消す・作り直す・確認する
- **prune:true** は、この仕様(同じ name)が作ったが今の仕様に無い物だけを消す。手で置いた物・他の仕様の物は消さない。**削除なので承認が要る**(core 面 `dx12_call_guarded`、full 面 `dx12_call {confirm:true}`)。先に `mode:"plan"` で何が消えるか見る。
- 種別の変更(plane → box)は作り直し。子を持つ物は自動ではしない(E_SPEC_KIND_CHANGE)。
- 手で作ったシーンは `dx12_scene_spec_export {owned?}` で仕様に起こせる(座標は展開後の絶対値。往復で同じシーンになる)。

## 6. よくある失敗(issues の code と直し方)
| code | 原因 | 直し |
|---|---|---|
| E_UNKNOWN_PARAM | キーの打ち間違い(postion / position / metalic) | didYouMean の `move`(at / metallic) |
| E_BAD_ENUM | kind に cube・point_light など | box / kind:light + light:point |
| E_NOT_FOUND_ASSET | モデル・スクリプト・テクスチャのパス違い | didYouMean の近いパスへ replace |
| E_NOT_FOUND_ENTITY | parent / relativeTo / lookAt の名前違い(パターンは連番付き) | 近い名前へ replace |
| E_SPEC_DUPLICATE_NAME | name の重複・予約名(Grid) | 改名 |
| E_SPEC_CYCLE | 相対配置・親子の輪 | どれかの place を外す |
| E_SPEC_BOUNDS_UNKNOWN | prefab など大きさが分からない物を相対配置 | `bounds:{min,max}` を書く |
| W_UNIT_SUSPECT | cm と m の取り違え(size 1200) | 100 で割った値(specPatch) |
| E_LAYOUT_DUPLICATE / OVERLAP | 同じ場所・めり込み | 片方を skip / 相対配置で離す |
| E_LAYOUT_BURIED / FLOATING | 埋まり・浮き | `place.snap:true` |
| E_LAYOUT_COLLIDER_WITHOUT_BODY / NO_COLLIDER | コライダーだけで rigidBody が無い / 当たり判定が無い(すり抜ける) | `collider:"static"` を足す |
| E_UNREACHABLE | 塞がれている・ナビメッシュが無い | 通路を空ける・navmesh を足す |

## 7. 例 5 本(どれも `dx12_apply_scene_spec {spec}` でそのまま適用できる)
@@EXAMPLES@@
