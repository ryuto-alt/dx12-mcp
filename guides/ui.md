# ゲーム内 UI
> 宣言的に組む(ui_compose)→ 検査(ui_audit)→ 参照に寄せる(ui_compare)のループ。

```
dx12_ui_design_brief {}        # デザイン方針(トークン・余白・タイポ)を作る/読む
dx12_ui_compose {blueprint}    # ブループリント(JSON)から UI を組む。手本は BLUEPRINT_EXAMPLE
dx12_ui_audit {}               # 計測 lint(ずれ・グリッド外・フォントの種類・中央寄せ偏り)
dx12_ui_screenshot {path}      # ゲーム内 UI の撮影
dx12_ui_compare {referencePath}   # 参照スクショと横並び + 差分率
dx12_install_font {family}     # 日本語 UI は Noto Sans JP など必須。assets/fonts/ に取り込み fontPath を返す
```
- 9-slice: `uiImage` の `texturePath` + `sliceBorder=[左,上,右,下]px`。
- 違う点を 3 つ挙げてから直す、を繰り返す。
- UI の押下テストは `dx12_ui_click`(Play 中のゲーム内 UI)。エディタの UI ではない。
