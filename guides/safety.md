# 危険操作と運用ルール
> guarded な操作は確認してから。人の PC 操作を奪わない。破壊的な操作は使い捨てプロジェクトで。

## guarded(`dx12_call` は `confirm:true` が無いと拒否)
`git_commit` / `git_push` / `git_pull` / `git_fetch` / `git_checkout` / `git_merge` / `git_merge_abort` / `eval_lua` / `delete_asset` / `build_game` / `net_launch_test_client`。
手順: ① `dx12_call {name, args, dryRun:true}` で影響を確認 → ② ユーザーの承認を得る → ③ `confirm:true` を付けて撃つ。
**core 面(`DX12_MCP_SURFACE=core`)**: `dx12_call` では `confirm:true` でも通らない(E_GUARDED)。`dx12_call_guarded {name, args}` から実行する(毎回ユーザーが承認する。先に `dryRun:true`)。`dx12_batch` に guarded な op が混じると 1 つも実行せず E_GUARDED。
(旧ツールとして直接呼ぶ場合は、クライアントの権限設定(名前ベースの allow/deny)が効く。)
**エンジン側にも最終ゲートがある**(M5): guarded な method は、1 回限り・60 秒有効の確認トークン(`guard_token` → `confirm_token`)が無いとエンジンが `E_GUARDED` で拒否する。トークンは、ゲートを通った呼び出し(`dx12_call_guarded` / `dx12_call {confirm:true}` / guarded な旧ツールの直接呼び出し)の中でだけ TS が自動で取って付ける。`dx12_batch` の op は承認済みにならないので、生 TCP でも `dx12_batch` でも guarded は実行できない。`dx12_job_start {kind:"external"}`(任意の外部プロセス)も guarded 扱い。

## dryRun
`dx12_call {dryRun:true}` は副作用のある操作を実行せず、影響を返す。エンジンが対応する method(マニフェストの `dryRun:"preview"`。`create_entity` / `spawn_model` / `delete_entity` / `set_transform` / `set_component` / `save_scene` / `open_scene` / `create_lua_component` / `create_shader` / `move_asset` / `delete_asset` / `import_asset` など 18 件)は、**実際に何が起こるか**(対象と件数・破壊性・書くファイルと上書きか・willFail)を返す(`dryRunMode:"engine"`。副作用ゼロ)。対応しない write は従来の静的な予測。`dx12_batch` の dryRun は op ごとにプレビューする。`look_apply` / `vfx_apply` / `decal_apply` / `sequence_author` / `organize_scene` は native dryRun(実際の計算結果を返す)。読み取り系は実行される。

## 冪等キー(再送しても二重に実行しない)
`dx12_call {idempotency_key}`(別名 `idempotencyKey`)は、write 系の全 method / ツールで、同じキーの再送に前回の結果(`idempotentReplay:true`)を返して再実行しない(エンジンが 10 分・256 件まで覚える)。同じキーで別の引数を送ると `E_IDEMPOTENCY_CONFLICT`(ラッパの無い method のみ。旧ツール / 合成ツールは引数ごとにサブキーが付くので、同じ引数の再送だけが Replay)。キーを省略しても、エンジン method に 1:1 の write 系は自動採番し、**タイムアウトのときは同じキーで自動再送**する(`meta.autoRetried`)。`dx12_batch` も同じキーで再送でき、完了済みの op は二重実行されない。

## ファイルを書く操作の巻き戻し(journal)
ファイルを書く操作(`save_scene` / `create_lua_component` / `create_shader` / `move_asset` / `delete_asset` / `import_asset` / `create_prefab` と TS の `dx12_scene_write`)は、上書き・削除・移動の前に元の内容を `<project>/.dx12/journal/` へ退避する。`dx12_batch`(atomic)が失敗して rollback すると、シーンと一緒に**ファイルも元に戻る**(応答の `transaction.journal`)。journal 未対応の write_file(地形の保存など)を含む batch は `transaction.warning` で「戻らない」と明記される。後から戻すには `dx12_call {name:"journal_list"}` → `{name:"journal_restore", args:{id}}`(先に `dryRun:true`。復元自体も 1 エントリとして残る)。tx を開いている間は自動保存が保留される。

## 未保存の変更を消す操作
`open_scene` / `new_scene` / `open_project` は現在のシーンを閉じる。`sceneDirty:true` のときは meta.warnings に出る。MCP 接続中は自動保存されるが、外部でシーン JSON を書き換えた直後は上書きの競合に注意(書いたら即 open、事前に `sceneDirty:false`)。

## Undo
## シーンの世代(scene_backups)
保存のたびに直前のシーン一式が `.dx12/backups/` へ世代として残る(既定 10 世代)。実体は `objects/<内容ハッシュ>` に 1 回だけ置く方式で、現行ファイルをその場で上書きしても世代は変わらない。`dx12_call {name:"scene_backups", args:{op:"list"}}` → `{op:"restore", id}` で戻す(`snapshot` / `settings` もある)。`open_scene` が壊れたシーンで失敗したら、保存を止めてあるのでまずこれで戻す。

MCP 呼び出し 1 回 = Undo 1 エントリ「AI: <method>」(Editor モードのみ)。まとまった編集は `dx12_batch`(atomic)か `dx12_transaction_begin` 〜 `commit`。`undo` は既定で AI の分だけ戻す。ファイルを書く操作(`create_lua_component` / `scene_write` / `import_asset` など)は Undo で戻らない(シーンは保存のたびに直前の版が世代として残る。下の「シーンの世代」)。

## 人の作業を守る
- エンジンは `--background` で起動する(editor ガイド参照)。実マウス/実キーボード/前面化は使わない。
- 起動したエンジンは終わったら閉じる。
- 使い捨てのプロジェクトで試す。人が開いているエディタを奪わない(単一クライアントのブリッジなので、別セッションが握っていると応答が無い → `dx12_doctor` が E_ENGINE_BUSY と診断する)。
