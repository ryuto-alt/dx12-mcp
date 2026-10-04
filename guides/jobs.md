# 長い処理のジョブ API(ビルド・テスト・撮影バッチ・cook)
> 2 分を超えうる処理は dx12_job_start で裏で走らせ、id を受け取って dx12_job_status で進捗を待つ。サブエージェントでも切れない。

## 基本の流れ
1. `dx12_job_start {kind, args}` … 即座に `{id, state, progress}` を返す(`waitSec:N` を付けると最大 N 秒だけ終了を待つ)。
2. `dx12_job_status {id, waitSec:30}` … 終了まで(最大 30 秒)待つ long-poll。変化のたびに `notifications/progress` も送る(progressToken があれば。届くかはクライアント次第)。**主経路はこのポーリング**。
3. 終わったら `summary`(要点)を読む。詳細は `dx12_job_result {id}`、生の出力は `dx12_job_logs {id, tail}`。
4. 止めるのは `dx12_job_cancel {id}`(プロセスツリーごと終了)。`dx12_job_list` は履歴(MCP サーバの再起動前のジョブも出る)。

状態は `queued → running → succeeded | failed | cancelled | timeout`。`progress` は `{phase, pct, message, etaSec}`(`estimated:true` は経過時間からの見積もり)。`queuePosition` は順番待ちの順位(1 = 次に走る)。

## 種類(kind)と主な args
| kind | 何をするか | args |
|---|---|---|
| `build` | `tools\build.ps1`(全セッションで直列。他のビルド待ちは `phase:"waiting_lock"`) | `target`(1 つ)/ `tests:true`(テスト exe も)/ `refreshEngines:true`(成功後に自分の古い専用エンジンを更新) |
| `ctest` | ヘッドレス単体テスト。`n/N` の進捗と失敗テスト名 | `filter` / `exclude` / `jobs` / `rerunFailed` |
| `ui_tests` | UI 自動テスト(exe コピー・使い捨てデータ・背景起動)。**既定で `build_game` を除外**(Game.exe が前面に出て人の操作を奪うため)。exe が `--ui-tests-skip` 未対応なら `E_UNSUPPORTED` | `skip` / `project`(複製して使う)/ `deep` / `dpiScale` / `includeBuildGame`(人が席にいるときは使わない) |
| `screenshot_batch` | カメラ × DPI 倍率 × バリアントを順に撮影 → 画像 + `manifest.json` + `contact_sheet.png`。別の倍率は専用エンジンを 1 台ずつ起動して撮る | `cameras[{name,position,target}]` / `dpiScales[]` / `variants[{name,calls,launchArgs}]` / `view`(final・imgui・scene)/ `project` |
| `bench` | `benchmark` を `runs` 回。中央値・ばらつき | `frames` / `runs` / `scene` / `camera` / `engine` |
| `playtest` | 保存済み `.playtest` を 1 本ずつ再生(進捗 = 本数) | `name` / `judge` |
| `vg_cook` | `vgeo_cook`(VGSRC/OBJ → .vgeo)。未ビルドなら `build {target:"vgeo_cook"}` を案内 | `input` か `genBench` / `output` / `threads` |
| `ue_import` | `tools/ue_cook`(UE の cook 済みメッシュ → VGSRC。ファイルを読むだけ) | `command` / `paks` / `usmap` / `package` / `out`(リポジトリの外) |
| `external` | 任意の外部プロセス。**guarded**(`dx12_call_guarded` / `confirm` が要る) | `command`(配列)/ `cwd` / `env` / `progress` |

`engine` を渡すとそのエンジンで動く(省略で束縛中)。`idempotencyKey` を付けると、再送しても二重に開始しない(同じキーは前のジョブを返し、引数が違えば `E_IDEMPOTENCY_CONFLICT`)。

## 進捗プロトコル(外部プロセス)
標準出力に 1 行ずつ出す。`@progress {"pct":42,"phase":"cook","msg":"メッシュ 3/7","eta":30}` / `@progress {"done":3,"total":7}` / `@result {…}`(最後の要約)。`progress:"percent"` なら「NN%」を含む行も拾う。壊れた JSON は無視する。

## 動き方と後始末
- 状態は `%LOCALAPPDATA%\UnoEngine\jobs\<id>\`(state.json / live.json / log.txt / result.json / artifacts\)。**MCP サーバを再起動しても** process 型(build・ctest・ui_tests・cook)は走り続け、`dx12_job_status` で引ける。エンジンを使う型(bench・playtest・screenshot_batch)はサーバが終わると中断される(`E_JOB_INTERRUPTED`)。
- 同時実行: 総数 3・build は 1 本・external は 2 本・エンジン系は 1 エンジンにつき 1 本。超えた分は `queued`。
- キャンセルとタイムアウトは、**自分が記録した runner の pid**(イメージ名が node のとき)からプロセスツリーを `taskkill /T /F`。無関係なプロセスは触らない。他のセッションのジョブは `force:true` と承認が要る(持ち主が消えた孤児は止められる)。
- 実行中のエンジンがあるジョブの間は、そのエンジンのアイドル自動終了を防ぐ。
- 環境変数: `DX12_JOBS_DIR` / `DX12_JOBS_MAX_RUNNING` / `DX12_JOBS_KILL_ON_EXIT=1`(サーバ終了時に process 型も止める)/ `DX12_JOBS_KEEP_DAYS`(既定 7)/ `DX12_JOBS_DISABLE=1`。

## よくあること
- ビルド → 更新: `dx12_job_start {kind:"build", args:{refreshEngines:true}, waitSec:60}`。
- テストの前: `build {tests:true}` → `ctest`。失敗は `summary.failedTests`、UI テストは `summary.junit.failed`。
- 止まって見える: `dx12_job_logs {id}` で末尾を読む。`phase:"waiting_lock"` は他のビルド待ちで正常。
- ゲームのビルド(配布物の書き出し)はエンジン側が裏ジョブ: `dx12_build_game {waitSec:60}`(即応答・二重起動は拒否)→ 続きは `dx12_call {name:"get_build_status"}`(`state` / `stage` / `pct`。テクスチャの事前生成の段は `indeterminate`)、止めるのは `cancel_build`。エディタは操作できるまま。
