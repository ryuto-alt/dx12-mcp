# エラーの読み方と直し方
> `fix[0]` をそのまま `dx12_call` に渡して撃ち直す。同じ呼び出しを繰り返さない。

## 形
```json
{"ok":false, "error":"…", "error_code":"E_BAD_ENUM", "engineCode":2, "cause":"…", "retryable":false,
 "didYouMean":["sculpt"], "validValues":["create","generate","sculpt"],
 "fix":[{"tool":"dx12_terrain_sculpt","args":{"brush":"lower"},"why":"…"}],
 "details":{…}, "docs":"dx12_tool_describe {name:'…'}"}
```
旧ツールを直接呼んだ場合は、従来の日本語本文の後ろに同じ JSON が 1 ブロック付く。

## コード表
| error_code | 意味 | 直し方 |
|---|---|---|
| E_ENGINE_UNREACHABLE | エンジンに繋がらない | `dx12_doctor`。起動は `--background` |
| E_ENGINE_BUSY | 接続は通るが応答が無い(別セッションが保持/処理中) | 他セッションを閉じる。少し待つ |
| E_ENGINE_TIMEOUT | 期限内に応答が来ない。エンジンは処理を続けている可能性 | `dx12_ping` で応答確認 → 結果を確かめてから撃ち直す(生成系は二重生成に注意。`idempotency_key` を使う)。遅れて届いた結果は次の `meta.lateResults` |
| E_ENGINE_TOO_OLD | エンジンが古い | エンジンを更新・再ビルドして再起動(MCP の再起動は不要) |
| E_UNKNOWN_TOOL | ツール/メソッドが無い | `didYouMean` / `dx12_tool_search` |
| E_UNKNOWN_PARAM / E_MISSING_PARAM / E_BAD_TYPE / E_BAD_ENUM / E_OUT_OF_RANGE | 引数不正 | `fix[0].args`(機械的に直した引数)/ `validValues` |
| E_NOT_FOUND_ENTITY / E_NOT_FOUND_ASSET / E_NOT_FOUND_SCENE / E_NOT_FOUND_COMPONENT / E_NOT_FOUND_COMMAND | 対象が無い | `didYouMean`(近い名前)/ 一覧ツール(dx12_list_entities / dx12_list_assets / dx12_list_scenes / dx12_describe_components / エディタのコマンド id は `dx12_editor_command {op:"list"}`) |
| E_STALE_SCENE | `expectGeneration` が古い | `dx12_list_entities` で引き直す(name 指定なら世代に影響されない) |
| E_MODE_CONFLICT | Editor/Playing が合わない・トランザクション中に禁止 | fix の `dx12_stop` などを先に撃って同じ呼び出しを再送 |
| E_VIRTUAL_INPUT_OFF / E_MODAL_OPEN | 仮想入力が OFF / モーダルが開いている | `dx12_imgui_virtual_input {enable:true}` |
| E_UNSUPPORTED | 環境が非対応(DXR など) | 再送しても無駄。代替を使う |
| E_GUARDED | guarded な操作に `confirm` が無い(core 面は `confirm:true` でも不可) | 承認を得て `confirm:true`(core 面は `dx12_call_guarded`) |
| E_FILE_IO | ファイル書込/読込失敗 | `path` を明示する |
| E_VALIDATION_FAILED | 宣言的な入力(シーン JSON など)の検証失敗 | `issues[]` の path と fix で該当箇所を直す |
| E_CANCELLED | 呼び出しが中断された | 同じ呼び出しを撃ち直せる |
| E_SAFETY_VIOLATION | 仮想入力中に OS のカーソル/前面窓が動いた(本来起きない) | 以降の UI 操作を止めて人に報告する |
| E_INTERNAL | エンジン内部エラー | `dx12_get_log` で直前のログ |
| E_FLEET_LIMIT / E_FLEET_RESOURCE | 専用エンジンが同時 3 台の上限 / 空き VRAM・RAM が下限未満 | `fix` の `dx12_engine_stop {engine}`(自分のエンジンを idle が長い順)。他人のエンジンは止めず、ユーザーに確認 |
| E_FLEET_VISIBLE_DENIED | 窓を画面に出す起動(visible)は既定で拒否 | `mode:"background"`(または `headless`)で足りる。どうしても要るなら環境変数 `DX12_MCP_ALLOW_VISIBLE=1` と `confirm:true`(実マウス・フォーカスを奪い得る) |
| E_FLEET_READONLY | 読み取り専用で繋いだエンジンに書き込み系を送った | `dx12_engine_launch` で自分専用のエンジンを起動する |
| E_FLEET_NOT_FOUND / E_FLEET_NOT_OWNER | エンジンが無い / 他人のエンジン | `dx12_engine_list` → `didYouMean` の id。他人のエンジンは止められない |
| E_FLEET_PROJECT_IN_USE | 同じプロジェクトを別のエンジンが使用中 | 既存のエンジンを使うか、`project` を省略して使い捨てにする |
| E_FLEET_BUILD_IN_PROGRESS / E_FLEET_EXE_MISSING | exe の元がビルド中 / 見つからない | ビルドが終わるのを待って撃ち直す / `tools\build.ps1` |
| E_FLEET_LAUNCH_FAILED / E_FLEET_DISABLED | 起動失敗・無応答 / フリート無効 | `details.logTail` を読む。`DX12_FLEET_DISABLE` を外す |
| E_JOB_NOT_FOUND / E_JOB_NOT_FINISHED | ジョブ id が無い / まだ終わっていない | `dx12_job_list` で id を確認 / `dx12_job_status {id, waitSec:30}` で待つ |
| E_JOB_TOOL_MISSING | build.ps1・vgeo_cook・ctest・exe が無い/起動できない | `fix`(build ジョブで作る・環境変数を設定する) |
| E_JOB_FAILED / E_JOB_TIMEOUT | ジョブの処理が失敗 / `timeoutSec` 超過 | `summary.errors` `failedTests` と `dx12_job_logs`。timeout は `timeoutSec` を延ばす |
| E_JOB_INTERRUPTED / E_JOB_RUNNER_LOST | 起動したサーバの終了・runner の異常終了で中断 | 同じ引数で `dx12_job_start` し直す(`idempotencyKey` は新しいものに) |
| E_JOB_NOT_OWNER / E_JOB_DISABLED | 他のセッションのジョブ / ジョブ API 無効 | 止めるなら `force:true`(承認を得てから)/ `DX12_JOBS_DISABLE` を外す |
| E_IDEMPOTENCY_CONFLICT / E_IDEMPOTENCY_IN_FLIGHT | 同じ冪等キーで別の要求 / 処理中 | 別のキーにする / 少し待って同じ要求を再送(完了済みなら前回の結果が返る) |
| E_NOT_FOUND / E_INVALID_PARAM | 種類を特定できなかった旧経路 | メッセージと hint を読む |

`retryable:true` は「原因を除けば同じ呼び出しが通る」、`false` は「引数か状態を直さないと通らない」。
