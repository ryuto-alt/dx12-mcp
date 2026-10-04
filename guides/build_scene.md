# シーンを作る最短手順
> 骨格 → 配置 → 素材/光 → 検査 → 保存。1 体ずつ並べず、まとめて置く。

## 0. 前提
- `dx12_doctor` で接続を確認する。`dx12_ping` の `sceneDirty:false` を確認してから始める。
- エンティティは `name` で指定する(`entityId` は Stop / open_scene で変わる。`sceneGeneration` が同じ間だけ安定)。
- MCP 接続中は編集の 2 秒後に自動で本保存される。外部でシーン JSON を書く場合は、書いたら**すぐ** `dx12_open_scene`(事前に `sceneDirty:false` を確認)。

## 1. 骨格を作る(命名規約)
```
dx12_scene_scaffold {}                       # LVL/ENV/LGT/GP/FX/UI/CAM のグループ根を作る(何度撃っても同じ)
```
生成時に `group:"LVL"` を渡すと最初から規約どおりの名前になる。

## 2. 配置する(まとまった量は 1 回で)
| やりたいこと | 使う |
|---|---|
| **部屋・ステージ・街を一括で(第一候補)** | **`dx12_apply_scene_spec`(仕様 JSON。差分適用・自動検証・失敗は specPatch。`dx12_guide {topic:"scene_spec"}`)** |
| 生のシーン JSON を書く(低レベル。長尾) | `dx12_call {name:"dx12_scene_write"}` |
| 同じものを散らす(木・岩・草) | `dx12_scatter` |
| 少数を個別に | `dx12_create_entity` / `dx12_spawn_model` / `dx12_spawn_box` |
| 複数操作をまとめて(失敗したら丸ごと戻す) | `dx12_batch`(既定 atomic) |

## 3. 素材・光・雰囲気
- 素材: `dx12_material_apply`(PBR 一式)。単体の値は `dx12_set_pbr` / `dx12_set_color`。
- 雰囲気を一括で: `dx12_look_apply {preset, strength}`(太陽+霧+空+ポスト)。一覧は `dx12_look_library`。
- エフェクト: `dx12_vfx_apply {recipe}`。汚れ・傷: `dx12_decal_apply`。

## 4. 検査(置いたら必ず)
- `dx12_validate_layout`(埋まり・浮き・Z ファイト・コライダー無し)。`fix:"safe"` で自動修正。
- 作業の区切りで `dx12_quality_gate`。
- 見た目は `dx12_screenshot_final`(人が見る絵)。**`path` を明示する**(省略するとエンジンの CWD に書いて失敗することがある)。

## 5. 保存
`dx12_save_scene {path}`。Play 中に撃たない(欠けたシーンが書かれることがある)。先に `dx12_ping` で mode=Editor を確認。

## 罠
- `set_parent` はワールド座標を保持しない(子はローカルとして解釈)。親子化の後にローカル座標を設定し直す。
- グループの根は原点・無回転・スケール 1 にする。
- 改名は Lua を壊す(`scene:findEntity` は見つからなくても nil ではなく無効な Entity を返す)。プロジェクトの `.lua` に出てくる名前は改名しない。
