# ライティングと絵作り
> 光 → 空気 → グレーディングの順に噛み合わせる。bloom と exposure だけ上げても映画的にはならない。

## 一括で寄せる
```
dx12_look_library {}                              # ルックの一覧
dx12_look_apply {preset:"horror_candle", strength:0.8}   # 太陽+霧+空+ポスト約 20 項目(id は dx12_look_library で確認)
dx12_look_apply {preset:"...", parts:["post"], dryRun:true}   # 部分適用 / 予定の値だけ見る
```
`strength` は中立値へ寄せる方式(0 で値が 0 になるのではない)。

## 個別に
- 太陽: `dx12_set_sun`(方位・高度・色温度・強さ)。灯数は `dx12_list_lights`(バジェット付き)。
- 描画設定は get/set の対: post_process / ssao / ssr / ssgi / taa / volumetric_fog / shadow_pcss / contact_shadow / dxr など。`dx12_tool_describe {name, target:"bloom"}` で該当引数を説明つきで引く。
- 屋内は環境マップが空になりがち。IBL の入れ方に注意。

## 確認
`dx12_screenshot_final {path}`(ポスト込み)。測るなら `dx12_look_compare`(参照画像との露出/色温度/コントラスト差)、`dx12_polish_audit`(安っぽさの原因を効く順に)。

## 罠
- 出力はリニア→sRGB。加算レイヤーは極小値(0.01〜0.1)で設計しないと白飛びする。
- 加算パーティクルは重なった枚数だけ足し算。粒が重なる層は rate × intensity ≒ 50 が目安。淡い色は白に流れる。
- Play 中の描画設定変更は `dx12_stop` で破棄される(返り値に `discardedOnStop:true`)。恒久的に効かせたい値はシーンに書く。
