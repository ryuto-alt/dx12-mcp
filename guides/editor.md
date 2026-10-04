# エディタを操作する(コマンド表・状態・仮想入力)
> 梯子の順に使う: dx12_editor_command(名前で実行)→ 専用ツール(dx12_set_component など)→ dx12_imgui(仮想入力。ウィジェットだけ)。人の PC 操作は絶対に奪わない。

## 最短手順
1. **状態**: `dx12_editor_state`(選択・開いている窓・モーダル・Play・未保存・Undo・直近の通知)。`scope` で絞る: selection / windows / layout / modal / mode / undo / toasts / perf。
2. **探す**: `dx12_editor_command {op:"list", query:"ポストプロセス"}`。表はエンジンが持ち、メニュー・ショートカット・パレットと同じ。日本語・英語・キー(Ctrl+Z)で引ける。各コマンドに `enabled` / `disabledReason` / `guarded` / `osDialog` / `hasArgs`。
3. **詳細**: `{op:"describe", id:"create.box"}` で引数と例。
4. **実行**: `{op:"run", id:"window.postProcess"}`。結果の `effects` に、開閉した窓・トースト・Play・選択・エンティティ数・未保存・Undo・開いたモーダルが入る。
5. 確認: もう一度 `dx12_editor_state`。

| 用途 | 例 |
|---|---|
| ツール窓 | `run id:"window.postProcess"`(既定で開く。`args:{state:"close"}` で閉じる。トグルではない) |
| 作成 | `run id:"create.box" args:{position:[0,0.5,3], name:"Crate"}`(既定はカメラ前・床。Undo 1 回で戻る) |
| Undo / Redo | `edit.undo` / `edit.redo`(履歴が無いと `E_MODE_CONFLICT` + 理由) |
| 選択が対象 | `edit.duplicate` / `edit.group` / `edit.focus`(先に `dx12_editor_select`) |
| ビュー・Play | `view.gizmoMove` / `view.fill {state:"on"}` / `view.toggle2D` / `play.toggle` |

コマンド一覧はここに書かない。**エディタの表にコマンドが増えれば自動で出る**ので、必ず `list` で引く。id を推測しない(未知の id は `E_NOT_FOUND_COMMAND` + `didYouMean`)。

## 選択と通知
- `dx12_editor_select`(長尾。`dx12_call` で使う): 名前・id・クエリ(`Wall*`)・タグ・guid で複数選択。`mode` = set / add / remove / toggle / clear。旧 `dx12_select_entity`(1 体だけ)は残る。
- `dx12_editor_modal`(長尾): `{action:"get"|"dismiss"}`。開いているモーダルを読む / 安全に閉じられるものをキャンセルと同じに閉じる(下の「モーダルで詰まったとき」)。
- `dx12_editor_notify`(長尾): 人のエディタ画面の右下にトースト(`message` / `level` / `seconds`)。`--background` は画面外なので**人の画面には出ない**。出たことは `dx12_editor_state {scope:"toasts"}` で確認。

## モーダルで詰まったとき
モーダル・コマンドパレットが開いている間、コマンドは `E_MODAL_OPEN` で断られる(キーが効かないのと同じ)。
1. `dx12_editor_state {scope:"modal"}` → `modal.blocking:true`・`modals[]`(`kind` / `id` / `title` / `canDismiss` / `dismissHint`)。
2. 閉じる: **ImGui のモーダルは Esc では閉じない**(実測)。`canDismiss:true` のダイアログ(新規シーン・名前を付けて保存・新規スクリプト / シェーダー など)は `dx12_call {name:"dx12_editor_modal", args:{action:"dismiss"}}`(キャンセルと同じ)。`canDismiss:false`(未保存の確認・自動保存の復旧など)は `E_UNSUPPORTED` になるので、`dx12_imgui {op:"find", label:"…"}` で位置を得て `pointer` でボタンを押す。**コマンドパレットだけは Esc**(`dx12_imgui {op:"key", key:"Esc"}`)。
3. `modal` をもう一度読んで閉じたことを確認してから、元のコマンドを撃ち直す。

`file.new` / `file.saveAs` / `palette.commands` などはアプリ内のダイアログを開く(`opensModal`)。`run` の `effects.modalsOpened` と `next` に案内が出る。

## guarded なコマンド
削除(`edit.delete`)・保存の上書き(`file.save` / `file.saveAs`)・プロジェクトを閉じる(`file.closeProject`)・OS のファイルダイアログ(`file.open`)は `guarded`。`run` は `E_GUARDED` で断り、`fix` に承認つきの実行口を返す。
1. `dryRun:true` で対象・件数・戻せるかを先に確認(guarded でも通る)。
2. ユーザーの承認を得て実行: core 面は `dx12_call_guarded {name:"editor_command_run_guarded", args:{id}}`、full / shell 面は `dx12_call {name:"editor_command_run_guarded", args:{id}, confirm:true}`。
3. 名前で指せる操作を優先する(`dx12_delete_entity {name}` / `dx12_save_scene {path}` / `dx12_open_scene {path}`)。コマンドは**選択に対して**動くので、対象が見えないまま実行しない。

**OS のダイアログを開く `file.open` は、仮想入力 / 背景モードでは承認しても実行拒否**(`E_UNSUPPORTED` + `details.reason:"os-dialog"`)。人の画面にダイアログを出さない。`dx12_open_scene {path}` を使う。

## 仮想入力(コマンドにも専用ツールにも無いウィジェットだけ)
`--background` で起動する(窓は画面外・前面化しない。`dx12_doctor` が起動コマンドを案内、自分専用は `dx12_engine_launch`)。終わったら閉じる。

`dx12_imgui`(または `dx12_imgui_*`)の `virtual_input`(`--background` は既に ON)/ `find`(UI 要素の位置。座標を推測しない)/ `pointer`(座標は**物理クライアント px**。論理 px = 物理 ÷ dpiScale)/ `key` / `screenshot`(ImGui 込み)。

## してはいけないこと(固定)
- `SendInput` / `mouse_event` / `SetCursorPos` / `SetForegroundWindow` / computer-use での操作。エディタ窓を前面化・移動・リサイズしない。
- `dx12_mouse_move` / `dx12_key_press` / `dx12_ui_click` でエディタを操作する(Play 中のゲーム入力用)。

## 罠
- 選択の entityId は Stop / シーン切り替えで変わる。名前(`names`)で選ぶと安定する。
- `window.*` は「開く」が既定(メニューのトグルとは違う)。既に開いていれば `changed:false`。
