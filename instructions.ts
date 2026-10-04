// サーバ instructions(initialize 応答に載る。Claude Code は 2,048 字で切り詰めるので、要点を先頭に置く)。
// 長さは errors.test.ts / shell.test.ts / toolSurface.test.ts が 2,048 字以内であることを確認する。
export const INSTRUCTIONS = `DX12 自作エンジン(Uno Engine)のエディタを操作する MCP。ゲームのシーン/マテリアル/ライト/地形/UI/Lua の制作、Play・プレイテスト・スクショ・性能・品質検査、エディタ UI 操作を扱う。ツールは 200 本超あるので、名前を推測せず shell 5 本で探す。
■ 最初に dx12_doctor: 接続と版を確認。エンジンが落ちていれば原因と起動手順(--background)を返す。
■ 自分専用のエンジン: 複数のエージェントが同じエンジンを奪い合わないよう、dx12_engine_launch で自分のエンジンを背景で起動する(ポート・exe コピー・データが別。全体で最大 3 台、10 分操作が無いと自動終了。窓は前面に出ない)。以後の全ツールがそのエンジンへ向く。終わったら dx12_engine_stop、ビルド後は dx12_engine_refresh。手動起動のエンジンを見るだけなら dx12_engine_attach(読み取り専用)。
■ 長い処理(ビルド・ctest・UI テスト・スクショのバッチ・ベンチ・プレイテスト・cook)は dx12_job_start で裏で走らせて id を受け取り、dx12_job_status {id, waitSec:30} で進捗を待つ。止めるのは dx12_job_cancel。ビルドは必ずジョブで(全セッションで直列化)。
■ ツールの探し方: dx12_tool_search {query} で日本語/英語の自然文検索 → dx12_tool_describe {name} で引数・副作用・例を確認 → dx12_call {name, args} で実行。旧ツール名(dx12_set_ssao 等)もエンジンの method 名もそのまま渡せる。エンジンに method が増えても MCP の再起動は不要。
■ 実行前の確認: dx12_call {dryRun:true} は実行せず、対象・件数・破壊性・書くファイルを返す(エンジンが対応する method は実際の影響)。guarded(git push/eval_lua/delete_asset/build_game 等)は confirm:true が要る。人の確認を取ってから撃つ。write 系は idempotency_key を付けると再送しても二重実行しない(省略しても自動採番・タイムアウト時に自動再送)。
■ エラー: {error_code, error, cause, fix, didYouMean, validValues} を読み、fix[0](tool+args)をそのまま dx12_call へ渡して撃ち直す。同じ呼び出しの繰り返しは無意味。retryable:false は原因を直す。
■ 作る: 1 体ずつ並べず、まとまった配置は dx12_apply_scene_spec(仕様 JSON。差分適用・自動検証・失敗は specPatch で返る)/ dx12_scatter / dx12_batch を使う。動きの確認は dx12_lua_step(仕掛け→進める→読むを 1 回で)。区切りで dx12_quality_gate。
■ エディタ操作: まず dx12_editor_command(コマンド表を id で実行。窓の開閉・Undo・作成・ビュー。list で id を引く)と dx12_editor_state(選択・モーダル・Play・未保存)。ウィジェットの値欄などだけ dx12_imgui_*(仮想入力)。削除・保存の上書きなど guarded なコマンドは E_GUARDED の fix に従う。
■ 最重要ルール(人の PC 操作を奪わない): 実マウス/実キーボード/前面化/computer-use/SendInput は使わない。エンジンは --background で起動し、UI は dx12_imgui_*(仮想入力)だけで操作する。dx12_mouse_move / dx12_key_press / dx12_ui_click は Play 中のゲーム入力用で、エディタの操作には使わない。
■ 保存: MCP 接続中はシーンが自動保存される。シーン JSON を外部で書く前は dx12_ping で sceneDirty:false を確認し、書いたら即 dx12_open_scene。
■ 手順の詳細: dx12_guide {topic: build_scene | scene_spec | test | lighting | ui | editor | safety | errors | perf | fleet | jobs | engine_dev}。`;

// core 面(DX12_MCP_SURFACE=core): 頻出操作は Core ツールを直接呼ぶ。Core に無いものだけ shell 5 本で探す。
export const INSTRUCTIONS_CORE = `DX12 自作エンジン(Uno Engine)のエディタを操作する MCP。シーン/マテリアル/ライト/地形/UI/Lua の制作、Play・プレイテスト・スクショ・性能・品質検査、エディタ UI 操作を扱う。頻出操作は下記の Core を直接呼び、他(200 本超)は shell 5 本で探す。
■ 最初に dx12_doctor: 接続と版を確認。エンジンが落ちていれば原因と起動手順(--background)を返す。
■ 自分専用のエンジン: dx12_engine_launch で自分のエンジンを背景起動する(全体で最大 3 台、10 分操作が無いと自動終了)。以後の全ツールがそれへ向く。終わったら dx12_engine_stop。
■ Core: シーン=dx12_list_entities / get_entity / create_entity / spawn_model / set_transform / set_component / delete_entity / open_scene / save_scene、部屋・街・ステージ一括生成=dx12_apply_scene_spec(仕様 JSON)。絵=dx12_capture(final が人の見る絵)/ get_render_settings / set_render_settings / look_apply / material_apply / vfx_apply / edit_terrain。動作=dx12_play / stop / get_log、演出(カメラワーク・タイムライン)=dx12_sequence。検査=dx12_quality_gate / get_perf。UI=dx12_ui_compose。まとめて=dx12_batch。エディタ操作=dx12_editor_command(id で実行: 窓の開閉・Undo・作成)/ dx12_editor_state(選択・モーダル・Play・未保存)を先に、値欄などだけ dx12_imgui(仮想入力)。
■ 長い処理(ビルド・ctest・UI テスト・スクショのバッチ・ベンチ・プレイテスト・cook): dx12_job_start で裏で走らせて id を受け取り、dx12_job_status {id, waitSec:30} で進捗を待つ。止めるのは dx12_job_cancel。ビルドは必ずジョブで(全セッションで直列化)。
■ Core に無い操作(undo・アニメ・ナビ・Blender・アセット・git・dx12_play_script・dx12_get_script_errors・dx12_engine_list / refresh・dx12_job_list・dx12_editor_select / notify 等): dx12_tool_search {query} → dx12_tool_describe {name} → dx12_call {name, args}。旧ツール名(dx12_undo, dx12_set_ssao, dx12_screenshot_final 等)もエンジンの method 名もそのまま渡せる。
■ guarded(git push/commit・eval_lua・delete_asset・build_game 等)は dx12_call では実行できない。dx12_call_guarded から実行する(ユーザーが毎回承認。動きの確認は dx12_lua_step で 1 回に)。先に dryRun:true で影響を確認。write 系は idempotency_key で再送しても二重実行しない。
■ エラー: {error_code, cause, fix, didYouMean, validValues} を読み、fix[0](tool+args)をそのまま撃ち直す。同じ呼び出しの繰り返しは無意味。
■ 最重要ルール(人の PC 操作を奪わない): 実マウス/実キーボード/前面化/computer-use/SendInput は使わない。エンジンは --background で起動し、UI は dx12_imgui(仮想入力)だけで操作する。
■ 保存: 接続中は自動保存。JSON を外部で書く前は dx12_ping で sceneDirty:false を確認。区切りで dx12_quality_gate。
■ 手順の詳細: dx12_guide {topic: build_scene | scene_spec | test | lighting | ui | editor | safety | errors | perf | fleet | jobs | engine_dev}。`;

export function instructionsFor(surface: string): string {
  return surface === "core" ? INSTRUCTIONS_CORE : INSTRUCTIONS;
}
