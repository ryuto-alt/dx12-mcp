# 性能を測る
> まず測る。ボトルネック(CPU/GPU/待ち)を名指ししてから直す。

```
dx12_perf_stats {}        # FPS・cpuScopeMs(update/buildList/shadowRec/mainRec/editorUi…)・gpuPassMs・analysis(ボトルネック解析)
dx12_benchmark {...}      # 平均 FPS。uncap 既定 true(垂直同期を外して測る)
dx12_diagnose {only}      # エンジン診断(アセット欠落など)。全部やると assets 全走査で数十秒
dx12_render_debug {mode, path}   # 中間バッファ可視化(なぜ変に見えるか/重いかの切り分け)
```
- エディタでは `editorUi`(ImGui)が重いことが多い。`picking` / `gizmo` は editorUi の内数。ゲーム性能は Play で測る。
- 描画を軽くする: `set_render_scale` / `set_occlusion`(Hi-Z カリング)/ `set_depth_prepass` / SSAO・SSR・SSGI の切り替え(`dx12_set_*`)。
- `--background` のウィンドウは画面外でも描画される。人のエディタと数値を比べる時は条件を揃える。
