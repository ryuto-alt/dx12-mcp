# テストプレイと検査
> 台本で流して断言する。1 手ずつ動かさない。区切りで総合検査。

## 台本 + 断言
```
dx12_step_frames {deterministic:true, dt:0.016667, frames:60}   # 固定時間で進める(同じ入力が同じ結果になる)
dx12_play_script {steps:[...], expect:[...]}                    # 台本(入力の列)+断言。落ちたら「最接近 4.62m」のように原因を返す
dx12_measure_player {}                                          # 歩行速度・ジャンプ高さ/距離の実測(<project>/.dx12/movement.json)
dx12_check_reachable {from, to}                                 # ナビメッシュ + 実測値で到達性(戻れない落下=詰みも拾う)
dx12_autoplay {}                                                # 実際に走破させる
```
向きを変えるには `dx12_mouse_move`(`camera:setYaw()` では一人称の向きを変えられない)。Play 中のゲーム入力用で、エディタの操作には使わない。

## 回帰テスト
- `dx12_record_playtest` で人のプレイを保存 → `dx12_run_playtests` で全部再生して比較。
- 基準は「初回再生(ゴールデンラン)」。判定は終点 1.0m / 経路 2.0m / Lua 死亡 0。

## エラーの確認
`dx12_get_log`(ログ末尾)/ `dx12_get_script_errors`(live なロードエラー。ツールバーの「Lua Error」表示は消えないので、今のエラーはこちらを正とする)。

## 総合
`dx12_quality_gate`(検査 + 判断段を 1 つの合否に)。`blocking` が空になるまで直す。

## 罠
- ゲームは `step_frames` 中も実時間で走る。短い演出は読み出し前に終わるので、Play 直後に間髪入れず入力を送る。
- `hold:true` の間は時間が止まる。撮り終わりに `hold:false`。
- `dx12_set_editor_camera` の固定が残っているとゲーム画面が撮れない。撮影前に `{release:true}`。
