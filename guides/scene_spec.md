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
### fps_arena — FPS のアリーナ(柱の輪・散らした遮蔽物・到達性の検証)
`fps_arena.json`
```json
{
  "version": 1,
  "name": "fps_arena",
  "lighting": {"preset":"day"},
  "navmesh": {"build":true},
  "verify": {"reachable":{"from":"GP_Player","to":"GP_Goal"}},
  "entities": [
    {"name":"LVL_Floor","kind":"box","size":[40,1,40],"group":"LVL","at":[0,-0.5,0],"color":"#8c8a80","material":{"roughness":0.9},"collider":"static"},
    {"name":"LVL_Wall_N","kind":"box","size":[40,4,1],"group":"LVL","at":[0,null,20.5],"place":{"on":"LVL_Floor"},"color":"#a8a49a","collider":"static"},
    {"name":"LVL_Wall_S","kind":"box","size":[40,4,1],"group":"LVL","at":[0,null,-20.5],"place":{"on":"LVL_Floor"},"color":"#a8a49a","collider":"static"},
    {"name":"LVL_Wall_E","kind":"box","size":[1,4,42],"group":"LVL","at":[20.5,null,0],"place":{"on":"LVL_Floor"},"color":"#a8a49a","collider":"static"},
    {"name":"LVL_Wall_W","kind":"box","size":[1,4,42],"group":"LVL","at":[-20.5,null,0],"place":{"on":"LVL_Floor"},"color":"#a8a49a","collider":"static"},
    {"name":"LVL_Pillar","kind":"box","size":[1.4,5,1.4],"group":"LVL","color":"#b0745a","pattern":{"type":"ring","count":6,"radius":7,"origin":[0,0,0]},"place":{"on":"LVL_Floor"},"collider":"static"},
    {"name":"ENV_Crate","kind":"box","size":1.2,"group":"ENV","color":"#d2a45c","pattern":{"type":"scatter","count":12,"area":[-17,-12,17,12],"seed":7,"minSpacing":3.5,"yaw":"random","exclude":["LVL_Pillar_01","LVL_Pillar_02","LVL_Pillar_03","LVL_Pillar_04","LVL_Pillar_05","LVL_Pillar_06"]},"place":{"on":"LVL_Floor"},"collider":"static"},
    {"name":"GP_Player","kind":"fps_player","group":"GP","at":[0,null,-17]},
    {"name":"GP_Goal","kind":"box","size":[1.5,0.02,1.5],"group":"GP","at":[0,null,17],"place":{"on":"LVL_Floor"},"color":"#33ff88","material":{"emissive":[0.1,1,0.4],"emissiveIntensity":2},"tags":["goal"],"collider":"static"},
    {"name":"LGT_Sun","kind":"light","light":"directional","group":"LGT","at":[0,20,0],"rotation":[-55,25,0],"components":{"directionalLight":{"intensity":1.6,"ambient":0.35}}}
  ]
}
```

### room — 部屋(テーブルの上のランプ・左右の椅子・壁に沿った本)
`room.json`
```json
{
  "version": 1,
  "name": "room",
  "lighting": {"preset":"indoor"},
  "entities": [
    {"name":"LVL_Floor","kind":"box","size":[8.6,0.2,6.6],"group":"LVL","at":[0,-0.1,0],"color":"#8a6f52","material":{"roughness":0.6}},
    {"name":"LVL_Wall_N","kind":"box","size":[8.4,3,0.2],"group":"LVL","at":[0,null,3.1],"place":{"on":"LVL_Floor"},"color":"#d8d2c4"},
    {"name":"LVL_Wall_S","kind":"box","size":[8.4,3,0.2],"group":"LVL","at":[0,null,-3.1],"place":{"on":"LVL_Floor"},"color":"#d8d2c4"},
    {"name":"LVL_Wall_E","kind":"box","size":[0.2,3,6],"group":"LVL","at":[4.1,null,0],"place":{"on":"LVL_Floor"},"color":"#d8d2c4"},
    {"name":"LVL_Wall_W","kind":"box","size":[0.2,3,6],"group":"LVL","at":[-4.1,null,0],"place":{"on":"LVL_Floor"},"color":"#d8d2c4"},
    {"name":"LVL_Ceiling","kind":"box","size":[8.4,0.2,6.4],"group":"LVL","at":[0,null,0],"place":{"relativeTo":"LVL_Wall_N","side":"above","align":{"z":"center"}},"color":"#efeae0"},
    {"name":"ENV_Rug","kind":"box","size":[3,0.02,2],"group":"ENV","at":[0.5,null,-0.5],"place":{"on":"LVL_Floor"},"color":"#a83a3a"},
    {"name":"ENV_Table","kind":"box","size":[1.6,0.75,0.9],"group":"ENV","at":[0.5,null,-0.5],"place":{"on":"ENV_Rug"},"color":"#6b4a2b","material":{"roughness":0.5}},
    {"name":"ENV_Lamp","kind":"sphere","size":0.3,"group":"ENV","place":{"on":"ENV_Table"},"color":"#fff2c8","material":{"emissive":[1,0.85,0.5],"emissiveIntensity":3}},
    {"name":"LGT_Lamp","kind":"light","light":"point","group":"LGT","place":{"relativeTo":"ENV_Lamp","side":"above","gap":0.05},"components":{"pointLight":{"intensity":6,"range":9,"color":[1,0.85,0.6]}}},
    {"name":"ENV_ChairL","kind":"box","size":[0.5,0.9,0.5],"group":"ENV","place":{"relativeTo":"ENV_Table","side":"left","gap":0.25},"color":"#8a6a48"},
    {"name":"ENV_ChairR","kind":"box","size":[0.5,0.9,0.5],"group":"ENV","place":{"relativeTo":"ENV_Table","side":"right","gap":0.25},"color":"#8a6a48"},
    {"name":"ENV_Shelf","kind":"box","size":[3,2,0.4],"group":"ENV","at":[0,null,2.7],"place":{"on":"LVL_Floor"},"color":"#5a3f28"},
    {"name":"ENV_Book","kind":"box","size":[0.12,0.3,0.22],"group":"ENV","color":"#2f5d8a","pattern":{"type":"along","of":"ENV_Shelf","side":"above","count":8,"margin":0.2,"gap":0}},
    {"name":"LGT_Window","kind":"light","light":"point","group":"LGT","at":[3.4,2.4,0],"components":{"pointLight":{"intensity":3,"range":8,"color":[0.75,0.85,1]}}},
    {"name":"CAM_Main","kind":"camera","group":"CAM","at":[-3.4,1.8,-2.5],"lookAt":"ENV_Table","components":{"camera":{"fovDegrees":62}}}
  ]
}
```

### garden — 散歩できる庭(木・花・池・ベンチ・飛び石)
`garden.json`
```json
{
  "version": 1,
  "name": "garden",
  "lighting": {"preset":"day"},
  "navmesh": {"build":true},
  "verify": {"reachable":{"from":"GP_Player","to":"GP_Goal"}},
  "entities": [
    {"name":"LVL_Ground","kind":"box","size":[34,1,34],"group":"LVL","at":[0,-0.5,0],"color":"#4d7a3a","material":{"roughness":1},"collider":"static"},
    {"name":"LVL_Stone","kind":"box","size":[1.2,0.06,0.8],"group":"LVL","color":"#9a9a92","pattern":{"type":"line","count":9,"from":[0,null,-13],"to":[0,null,9]},"place":{"on":"LVL_Ground"},"collider":"static"},
    {"name":"LVL_Pond","kind":"box","size":[6,0.06,4],"group":"LVL","at":[8,null,2],"place":{"on":"LVL_Ground"},"color":"#2f6f9f","material":{"roughness":0.05,"metallic":0.2,"emissive":[0.05,0.2,0.35],"emissiveIntensity":0.6}},
    {"name":"GP_Bench","kind":"box","size":[1.8,0.45,0.6],"group":"GP","at":[-3.2,null,9],"place":{"on":"LVL_Ground"},"color":"#8a5a30","collider":"static"},
    {"name":"GP_Goal","kind":"box","size":[1.2,0.02,1.2],"group":"GP","at":[-3.2,null,7.4],"place":{"on":"LVL_Ground"},"color":"#ffd24a","material":{"emissive":[1,0.8,0.2],"emissiveIntensity":1.5}},
    {"name":"ENV_BenchBack","kind":"box","size":[1.8,0.6,0.1],"group":"ENV","place":{"relativeTo":"GP_Bench","side":"above","align":{"z":"max"}},"color":"#8a5a30"},
    {"name":"ENV_TreeTrunkL","kind":"box","size":[0.5,3.4,0.5],"group":"ENV","color":"#6b4a2b","pattern":{"type":"scatter","count":6,"area":[-15,-15,-4.5,15],"seed":11,"minSpacing":5,"exclude":["GP_Bench"],"yaw":"random"},"place":{"on":"LVL_Ground"}},
    {"name":"ENV_TreeLeavesL","kind":"sphere","size":3.2,"group":"ENV","color":"#2f7a3a","material":{"roughness":0.9},"pattern":{"type":"scatter","count":6,"area":[-15,-15,-4.5,15],"seed":11,"minSpacing":5,"exclude":["GP_Bench"],"y":4.4}},
    {"name":"ENV_TreeTrunkR","kind":"box","size":[0.5,3.4,0.5],"group":"ENV","color":"#6b4a2b","pattern":{"type":"scatter","count":6,"area":[4.5,-15,15,15],"seed":12,"minSpacing":5,"exclude":["LVL_Pond"],"yaw":"random"},"place":{"on":"LVL_Ground"}},
    {"name":"ENV_TreeLeavesR","kind":"sphere","size":3.2,"group":"ENV","color":"#2f7a3a","material":{"roughness":0.9},"pattern":{"type":"scatter","count":6,"area":[4.5,-15,15,15],"seed":12,"minSpacing":5,"exclude":["LVL_Pond"],"y":4.4}},
    {"name":"ENV_FlowerL","kind":"sphere","size":0.25,"group":"ENV","color":"#ff6f9f","pattern":{"type":"scatter","count":14,"area":[-15,-15,-2.5,15],"seed":3,"minSpacing":1.6,"scaleRange":[0.7,1.3],"exclude":["GP_Bench"]},"place":{"on":"LVL_Ground"}},
    {"name":"ENV_FlowerR","kind":"sphere","size":0.25,"group":"ENV","color":"#ffd24a","pattern":{"type":"scatter","count":14,"area":[2.5,-15,15,15],"seed":4,"minSpacing":1.6,"scaleRange":[0.7,1.3],"exclude":["LVL_Pond"]},"place":{"on":"LVL_Ground"}},
    {"name":"GP_Player","kind":"fps_player","group":"GP","at":[0,null,-15]},
    {"name":"LGT_Sun","kind":"light","light":"directional","group":"LGT","at":[0,20,0],"rotation":[-48,35,0],"components":{"directionalLight":{"intensity":1.8,"ambient":0.4}}}
  ]
}
```

### showcase — ショーケース(台 + 3 灯 + カメラ)
`showcase.json`
```json
{
  "version": 1,
  "name": "showcase",
  "lighting": {"preset":"studio"},
  "scene": {"skybox":{"drawSkybox":false,"iblIntensity":0.45}},
  "entities": [
    {"name":"LVL_Floor","kind":"box","size":[40,0.4,40],"group":"LVL","at":[0,-0.2,0],"color":"#1b1c21","material":{"roughness":0.6,"metallic":0.1}},
    {"name":"LVL_Backdrop","kind":"box","size":[40,8,0.3],"group":"LVL","at":[0,null,7],"place":{"on":"LVL_Floor"},"color":"#22242b","material":{"roughness":0.9}},
    {"name":"ENV_Pedestal","kind":"box","size":[1.4,0.9,1.4],"group":"ENV","at":[0,null,0],"place":{"on":"LVL_Floor"},"color":"#e8e6e0","material":{"roughness":0.4}},
    {"name":"ENV_Sphere","kind":"sphere","size":0.9,"group":"ENV","place":{"on":"ENV_Pedestal"},"color":"#c9a24a","material":{"metallic":1,"roughness":0.18}},
    {"name":"ENV_Cube","kind":"box","size":0.5,"group":"ENV","rotation":[0,35,0],"place":{"relativeTo":"ENV_Pedestal","side":"right","gap":0.9},"color":"#4a7bd0","material":{"metallic":0.2,"roughness":0.3}},
    {"name":"ENV_Orb","kind":"sphere","size":0.16,"group":"ENV","color":"#dddddd","material":{"metallic":0.9,"roughness":0.2},"pattern":{"type":"ring","count":8,"radius":2.6,"origin":[0,0,0]},"place":{"on":"LVL_Floor"}},
    {"name":"LGT_Key","kind":"light","light":"point","group":"LGT","place":{"relativeTo":"ENV_Sphere","side":"front","gap":1.8,"offset":[1.6,1.4,0]},"components":{"pointLight":{"intensity":12,"range":12,"color":[1,0.95,0.85]}}},
    {"name":"LGT_Fill","kind":"light","light":"point","group":"LGT","place":{"relativeTo":"ENV_Sphere","side":"front","gap":2.2,"offset":[-2.2,0.6,0]},"components":{"pointLight":{"intensity":4,"range":12,"color":[0.6,0.75,1]}}},
    {"name":"LGT_Rim","kind":"light","light":"point","group":"LGT","place":{"relativeTo":"ENV_Sphere","side":"back","gap":1.6,"offset":[0.6,1.2,0]},"components":{"pointLight":{"intensity":10,"range":10,"color":[0.8,0.9,1]}}},
    {"name":"CAM_Main","kind":"camera","group":"CAM","at":[2.4,1.8,-5.2],"lookAt":"ENV_Sphere","components":{"camera":{"fovDegrees":40}}}
  ]
}
```

### horror_corridor — ホラー廊下(暗い赤灯・崩れた柱・突き当たりの扉)
`horror_corridor.json`
```json
{
  "version": 1,
  "name": "horror_corridor",
  "lighting": {"preset":"horror"},
  "navmesh": {"build":true},
  "verify": {"reachable":{"from":"GP_Player","to":"GP_Exit"}},
  "entities": [
    {"name":"LVL_Floor","kind":"box","size":[4.8,0.4,30],"group":"LVL","at":[0,-0.2,0],"color":"#2a2622","material":{"roughness":0.85},"collider":"static"},
    {"name":"LVL_Wall_L","kind":"box","size":[0.4,3.2,30],"group":"LVL","at":[-2.2,null,0],"place":{"on":"LVL_Floor"},"color":"#3b3a34","collider":"static"},
    {"name":"LVL_Wall_R","kind":"box","size":[0.4,3.2,30],"group":"LVL","at":[2.2,null,0],"place":{"on":"LVL_Floor"},"color":"#3b3a34","collider":"static"},
    {"name":"LVL_Ceiling","kind":"box","size":[4.8,0.3,30],"group":"LVL","at":[0,null,0],"place":{"relativeTo":"LVL_Wall_L","side":"above"},"color":"#24221f"},
    {"name":"LVL_Wall_End","kind":"box","size":[4,3.2,0.4],"group":"LVL","at":[0,null,15.2],"place":{"on":"LVL_Floor"},"color":"#3b3a34","collider":"static"},
    {"name":"LVL_Wall_Start","kind":"box","size":[4,3.2,0.4],"group":"LVL","at":[0,null,-15.2],"place":{"on":"LVL_Floor"},"color":"#3b3a34","collider":"static"},
    {"name":"GP_Exit","kind":"box","size":[1.4,2.4,0.15],"group":"GP","at":[0,null,14.9],"place":{"on":"LVL_Floor"},"color":"#6b1f1f","material":{"emissive":[0.6,0.05,0.05],"emissiveIntensity":0.8},"tags":["exit"]},
    {"name":"LGT_Bulb","kind":"light","light":"point","group":"LGT","pattern":{"type":"line","count":5,"from":[0,2.9,-11],"to":[0,2.9,11]},"components":{"pointLight":{"intensity":6.5,"range":7,"color":[1,0.32,0.2]}}},
    {"name":"LVL_Debris","kind":"box","size":[0.9,0.9,0.9],"group":"LVL","color":"#4a3d2f","pattern":{"type":"scatter","count":4,"area":[-1.5,-12,1.5,12],"seed":5,"minSpacing":5,"yaw":"random"},"place":{"on":"LVL_Floor"}},
    {"name":"ENV_Pillar","kind":"box","size":[0.5,3.2,0.5],"group":"ENV","color":"#4e4b44","rotation":[0,15,0],"pattern":{"type":"line","count":3,"from":[-1.8,null,-6],"to":[-1.8,null,6]},"place":{"on":"LVL_Floor"}},
    {"name":"GP_Player","kind":"fps_player","group":"GP","at":[0,null,-13]}
  ]
}
```
