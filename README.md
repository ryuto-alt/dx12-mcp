# Uno Engine MCP server

起動中の [Uno Engine](https://github.com/ryuto-alt/dx12) エディタを Claude Code / Codex から
叩いてゲームを作るための MCP サーバ。エディタ(C++)が `127.0.0.1:8787` で待ち受ける TCP ブリッジに
改行区切り JSON で繋ぐ。ゲーム(封印ランタイム)ではブリッジは起動しない＝外から触れない。

- **配布リポジトリ**: https://github.com/ryuto-alt/dx12-mcp （エンジン本体には同梱されない）
- **ソース・オブ・トゥルース**: エンジンリポジトリの `tools/mcp-server`（`publish.ps1` で dx12-mcp へ同期）
- **必要環境**: Node.js **v24+**（`.ts` を型ストリップで直接実行。tsc ビルド不要）、起動中の Uno Engine エディタ

## インストール

```powershell
git clone https://github.com/ryuto-alt/dx12-mcp "$env:USERPROFILE\dx12-mcp"
cd "$env:USERPROFILE\dx12-mcp"
./install.ps1        # Linux/macOS: ./install.sh
```

**これだけで Claude Code と Codex の両方に登録される**（手で貼るコマンドは無い）。install スクリプトは
Node v24+ を確認 → `npm install` + 自己テスト(エンジン不要) → `claude mcp add --scope user` と
`codex mcp add` を実行する。CLI が入っていないクライアントの分だけ手順を表示する。
再実行しても壊れない（remove → add で冪等）。あとは Claude Code / Codex を再起動するだけ。

`%USERPROFILE%\dx12-mcp` に置くと、エディタの「MCP / AI Bridge」窓が自動検出して
セットアップコマンドをワンクリックでコピーできる。

> `--scope user` で登録する。既定の `local` スコープはそのディレクトリでしか使えず、
> エンジンは 1 台に 1 つなので project スコープも不適切。

## 接続（自動登録が使えないとき）

### Claude Code
```powershell
claude mcp add dx12-engine --scope user -- node "$env:USERPROFILE\dx12-mcp\index.ts"
```
または `.mcp.json`（テンプレ: `.mcp.json.example`）:
```json
{
  "mcpServers": {
    "dx12-engine": {
      "command": "node",
      "args": ["C:\\Users\\<you>\\dx12-mcp\\index.ts"]
    }
  }
}
```

> 注意: 既定では `env` に `DX12_MCP_PORT` を書かないこと。書くとポート自動探索
> (`%TEMP%/dx12_mcp.port`)が無効化される。ポートを固定したい時だけ書く。

### Codex (`~/.codex/config.toml`)
```toml
[mcp_servers.dx12-engine]
command = "node"
args = ["C:\\Users\\<you>\\dx12-mcp\\index.ts"]
```

## まず使う: shell 5 本(常時ロード)

ツールは 220 本を超えるので、名前を推測せず shell 5 本で探して撃つ。**旧 220 ツールは名前・引数・成功時の返り値とも従来のまま**残っている。

| ツール | 使いどころ |
|---|---|
| `dx12_doctor` | 最初に撃つ。接続・ポート・プロセス・版(マニフェストのハッシュ)・直近エラーを診断し、原因と直し方(起動は `--background`)を返す |
| `dx12_tool_search {query}` | 日本語/英語の自然文・旧ツール名で全ツール + エンジンの全 method を検索(決定論) |
| `dx12_tool_describe {name}` | 引数(型・必須・enum・範囲)・副作用・例・次の一手・`callTemplate` |
| `dx12_call {name, args, dryRun?, confirm?}` | 任意のツール/method を**送信前にスキーマ検証**して実行。エンジンに後から足した method も**再起動なし**で呼べる |
| `dx12_guide {topic}` | 目的別の最短手順・危険操作の注意・仮想入力の運用ルール(`guides/*.md`) |

エラーは `{error_code, error, cause, fix:[{tool,args}], didYouMean, validValues, retryable}` の JSON で返り、`fix[0]` をそのまま `dx12_call` に渡して撃ち直せる。
詳細は [docs/MCP.md §0](https://github.com/ryuto-alt/dx12/blob/main/docs/MCP.md)。`DX12_MCP_SURFACE=full|core|shell|legacy` で見せ方を切り替える(既定 full = shell 5 + 旧 220。`DX12_MCP_TOOLSET` は旧名の互換)。

### ツール面(surface): full / core / shell
| 面 | `tools/list` | サイズ(実測) |
|---|---|---|
| `full`(既定) | shell 5 + 旧 220(共通の `outputSchema` だけ削った。名前・引数・説明は従来のまま)+ 末尾にパストレーサー 3・仮想ジオメトリ 2・フリート 6・ジョブ 6・エディタ操作 5 | 247 本 |
| `core` | shell 5 + フリート 2 + **ジョブ 3** + Core 28(**エディタ操作 2 を含む**)+ `dx12_batch` + `dx12_call_guarded` | **40 本(上限)** |
| `shell` | shell 5 | 5 本 / 約 6.7 KB |

**`core` を試す**: MCP の登録に `DX12_MCP_SURFACE=core` を足す(登録し直す: `claude mcp remove dx12-engine -s user` → `claude mcp add dx12-engine -s user -e DX12_MCP_SURFACE=core -- node <index.ts のパス>`。または `.mcp.json` の `"env": {"DX12_MCP_SURFACE": "core"}`)→ **Claude Code を再起動**。
戻すときは `full`(または env を消す)。core でも旧 220 名は `dx12_call {name:"dx12_set_ssao", …}` のように**旧名・旧引数のまま**呼べる。
Core = 一覧・取得・生成・変形・コンポーネント・削除・シーン開閉/保存・ルック/マテリアル/VFX・地形・Lua・UI・Play/Stop・品質ゲート・ログ・性能・撮影・描画設定(統合)・エディタ操作(`dx12_editor_command` / `dx12_editor_state`)・エディタ UI(仮想入力)。M7 で `dx12_play_script` と `dx12_engine_list` は長尾(`dx12_call`)へ移した。一覧と alias 表は `docs/MCP.md` §0-5。
guarded(git push・`eval_lua`・`delete_asset`・`build_game` 等)は core 面では `dx12_call` に `confirm:true` を付けても通らず、`dx12_call_guarded`(毎回ユーザー承認)から実行する。

**動的登録**: エンジンの method に `McpMeta.expose="core"` を付けると、MCP サーバが再起動なしで `tools/list` に足して `notifications/tools/list_changed` を送る(Claude Code が反映するかは**未確認**。`dx12_tool_describe` / `dx12_call` では常に使える。`DX12_MCP_LIST_CHANGED=0` で止める)。

### エンジンに method を足したら(最短手順)
1. `src/core/mcp/ApplicationMcp*.cpp` に `McpDefine(...)` を 1 本足す(推奨は `McpMeta` 付き。`docs/MCP.md` §12-1〜12-2)
2. エンジンを再ビルド・再起動する(`tools/build.ps1`)
3. **MCP サーバの再起動は不要**。`dx12_tool_search` → `dx12_tool_describe` → `dx12_call` で使える
3b. Core にも載せたければ `McpMeta` の `.expose = "core"`(1 行。`tools/list` に動的に足される)
4. 専用ツール名が要るときだけ `toolset/*.ts` に `reg(...)` を足す(この場合は MCP サーバの再起動が要る)。`searchHints.ts` と `eval/discovery_tasks.json` も更新する
5. `node scripts/gen_manifest_snapshot.mjs`(エンジンを `--background` で起動した状態で)で `manifest.snapshot.json` を更新し、`docs/MCP.md` を直し、`publish.ps1` で配布リポジトリへ(push は人が確認する)

**TODO(設計書 M4)**: docs / README / `guides` / スナップショット更新 / `publish` 差分確認を 1 コマンドにする `npm run finalize` は未実装(現状は上の手順を手で行う)。

## 専用エンジン(フリート): エージェントごとに自分のエンジンを持つ

エンジンの TCP ブリッジは単一クライアントなので、複数のエージェント(Claude Code・Codex CLI の各セッション)が同じエンジンに繋ぐと奪い合いになる。**最初に `dx12_engine_launch` で自分専用のエンジンを背景起動する**(設計: `docs/MCP_FLEET_DESIGN.md`)。

| ツール | 使いどころ |
|---|---|
| `dx12_engine_launch` | 専用エンジンを起動して既定に束縛する。ポート(8860〜8899 を自動割当)・exe コピー・データ領域・使い捨てプロジェクトが全部別。**ビルドと衝突しない**(`LNK1104` にならない) |
| `dx12_engine_list`(長尾)/ `dx12_engine_stop` | 一覧(全セッション分・台数・上限・空き VRAM/RAM。M7 で長尾へ。`dx12_call {name:"dx12_engine_list"}`)/ 自分のエンジンを止める |
| `dx12_engine_attach`(長尾) | 手動起動/他人のエンジンを**読み取り専用**で見る(接続は 1.5 秒で閉じ、持ち主の枠を塞がない) |
| `dx12_engine_refresh`(長尾) | ビルド後に exe コピーを最新へ入れ替えて再起動(`dx12_doctor` が古い exe コピーを警告する。build ジョブの `refreshEngines:true` でも同じ) |
| `dx12_engine_use`(長尾) | 既定エンジンの切替(core 面では `dx12_call {name:"dx12_engine_use"}`) |

全体で最大 3 台・10 分操作が無ければ自動終了・空き VRAM 2 GB / RAM 3 GB 未満は起動を断る(理由と止める候補を構造化エラーで返す)。MCP サーバが終了しても(強制終了でも)エンジンは残らない。
窓を画面に出す `mode:"visible"` は既定で拒否(`DX12_MCP_ALLOW_VISIBLE=1` と `confirm:true` の両方が要る)。人のカーソル・フォーカスは奪わない。
環境変数と仕組みは `docs/MCP.md` §0-7、使い方は `dx12_guide {topic:"fleet"}`。

## 長い処理のジョブ API(ビルド・テスト・撮影バッチ・cook)と副作用の安全性

2 分を超えうる処理は `dx12_job_start {kind, args}` で裏で走らせ、`dx12_job_status {id, waitSec:30}` で進捗を待つ(Claude Code の自動背景化はサブエージェントや `claude -p` に効かないため自前の非同期 API)。
kind = `build`(`tools\build.ps1`。全セッションで直列)/ `ctest` / `ui_tests`(既定で `build_game` を除外。背景起動)/ `screenshot_batch`(カメラ × DPI 倍率 × バリアント)/ `bench` / `playtest` / `vg_cook` / `ue_import` / `external`(承認が要る)。
状態は `%LOCALAPPDATA%\UnoEngine\jobs\` に永続化され、**MCP サーバを再起動しても** process 型は走り続けて `dx12_job_status` で引ける。キャンセルはプロセスツリーごと(`dx12_job_cancel`)。長尾の `dx12_job_list` / `dx12_job_result` / `dx12_job_logs` は `dx12_call` で使う。
進捗は `progressToken` 付きで待つ間 `notifications/progress` も送る(Claude Code / Codex が受け取るかは未確認。主経路はポーリング)。仕様は `docs/MCP.md` §0-8、手順は `dx12_guide {topic:"jobs"}`。

**副作用の安全性(M5)**: guarded な method(`git_push` / `eval_lua` / `delete_asset` / `build_game` など)は**エンジン側にも最終ゲート**があり、1 回限りの確認トークン(`guard_token` → `confirm_token`)が無いと拒否される(TS は承認済みの経路の中でだけ自動で取って付ける。`dx12_batch` の op は承認済みにならず、全ての面で guarded を拒否)。
`dx12_call {idempotency_key}` は write 系全般で再送を安全にする(同じキーは前回の結果を返して再実行しない。省略しても 1:1 の write 系は自動採番し、タイムアウト時に同じキーで自動再送する)。`dryRun:true` はエンジンが対応する 18 method で「実際に何が起こるか」を返す。`dx12_batch`(atomic)は主トランザクションで、失敗するとシーンと**ファイル(`.dx12/journal/`)も**戻る。後からは `journal_list` / `journal_restore`。エンジン側の仕様は `docs/MCP.md` §13。


**Codex CLI**(`~/.codex/config.toml`)/ **Claude Code**(ツール検索が無い/弱いクライアントには `core` 面を勧める。`tools/list` 40 本):
```toml
[mcp_servers.dx12-engine]
command = "node"
args = ["<REPO>/tools/mcp-server/index.ts"]
env = { DX12_MCP_SURFACE = "core" }
```
```bash
claude mcp add dx12-engine -s user -e DX12_MCP_SURFACE=core -- node <REPO>/tools/mcp-server/index.ts
```

## 宣言的シーン生成: 仕様 JSON で部屋・ステージ・街を作る(`dx12_apply_scene_spec`)

1 体ずつ `create_entity` を並べず、**何を置きたいかを SceneSpec(JSON)で 1 回渡す**。差分だけを 1 トランザクションで作り、自動検証し、失敗は**そのまま撃ち直せる差分(specPatch)**で返る。

```
dx12_apply_scene_spec {spec, mode:"plan"}        # 何を作る/更新/削除するか(書き込みなし)
dx12_apply_scene_spec {spec}                     # 適用(1 トランザクション・Undo 1 回)→ 自動検証(配置・命名・到達性)
dx12_apply_scene_spec {specRef, patch}           # 失敗の fix[0] をそのまま(specPatch = RFC 6902。仕様の全文は再送しない)
dx12_scene_spec_export {owned:true}              # 現在のシーン → 仕様(往復で同じシーン)。長尾(dx12_call)
```

- 単位はメートル。`place`(右 2m・上に載せる・地面に足元を合わせる)は **AABB の実測で決定論に解く**。`pattern`(grid / ring / line / 壁に沿って / seed 付き散布)。`collider:"static"` で当たり判定。`verify` で埋まり・重なり・命名・到達性を検査(落ちたら全体をロールバック)。
- 同じ仕様を 2 回撃っても何も変わらない(冪等)。`name`(または `id`)をキーに差分適用。`prune:true`(この仕様が作った物のうち仕様から消えたものを削除)は guarded。
- 書き方・例 5 本(FPS のアリーナ・部屋・散歩できる庭・ショーケース・ホラー廊下)・よくある失敗は `dx12_guide {topic:"scene_spec"}`。詳細は [docs/MCP.md §0-10](https://github.com/ryuto-alt/dx12/blob/main/docs/MCP.md)。
- 実装は `sceneSpec/`(純ロジック: `schema.ts` 検証・`expand.ts` 相対配置・`plan.ts` 差分計画・`apply.ts` 適用・`verify.ts` 検証と specPatch・`export.ts` 書き出し・`index.ts` 全体)。テストは偽エンジン `sceneSim.ts` で `npm test`、実エンジンは `node scripts/sceneSpecReal.ts --port <専用インスタンス>`(使い捨てプロジェクトで)。

## 構成
- `index.ts` … MCP サーバの入口(stdio)。`toolset/all.ts` を読み込んで接続するだけ(220 ツールの定義は下記へ機械分割済み)
- `toolset/` … ツール定義。`core.ts`(サーバ・登録ラッパ `reg`/`regRaw`・登録表)/ `shell.ts`(shell 5 本の登録)/ カテゴリ別 30 モジュール(`read` `edit` `spawn` `render` `terrain` `vfx` …)。**並び(= `tools/list` の順)は `toolset/all.ts` の import 順**
- `shellRuntime.ts` … shell 5 本の中身(検索・describe・call・dryRun・doctor・guide)。`catalog.ts`(ツール一覧の統合)/ `search.ts` + `searchHints.ts`(検索と同義語辞書)/ `manifest.ts`(エンジンのマニフェスト取得・スナップショット)/ `validate.ts`(事前検証)/ `errors.ts` + `structure.ts`(構造化エラー)/ `doctor.ts`(自己診断)
- `engineClient.ts` … TCP フレーミング + id 相関の薄いクライアント（ポートは env `DX12_MCP_PORT` → `%TEMP%/dx12_mcp.port` → 8787 の順で自動解決。別マシンは `DX12_MCP_HOST`）。接続失敗は 0.3/0.6/1.2 秒で再試行、タイムアウト後の応答は遅延結果として保持
- `guides/*.md` … `dx12_guide` の本文。`eval/` … 発見性の評価タスクとエラー再現ケース。`manifest.snapshot.json` … エンジン未接続時の代役。`legacy-tools.snapshot.json` … 旧 220 ツールの表面の固定
- `mockEngine.ts` … テスト用の偽エンジン(実エンジン不要)
- `sceneTools.ts` … 地形/スカルプト/診断の引数正規化と共通 zod 部品（純ロジック・エンジン非依存）
- `materialApply.ts` … `dx12_material_apply` の純ロジック（ファイル名からのテクスチャ用途推定、`hasOverride` の罠の回避）
- `paramGuard.ts` … 未知の引数を黙って捨てず「近い正解」を返す共通部品 + 適用後の読み返し照合
- `schemaDrift.ts` … `Application.cpp` と TS スキーマの食い違いを検出するパーサ（`schemaDrift.test.ts` が使う。ツール定義は `toolSource.ts` 経由で全モジュールを読む）
- `lookCompare.ts` … 3D の絵の測光（対数輝度ヒストグラム/CCT/彩度/黒潰れ）と参照画像との差分・示唆生成
- `contactSheet.ts` … カメラ経路の生成とコンタクトシート合成（連続フレーム差分つき）
- `sceneWrite.ts` … シーン JSON の検証・要約・書き出し先の解決（`SceneSerializer.cpp` のスキーマと 1:1）
- `test.ts` … mock エンジンで framing/相関/エラーを検証(`node test.ts`)
- `*.test.ts` … 各純ロジックの回帰テスト。`npm test` で全部、`npm run test:offline` でネット不要分のみ。shell/エラー系は `shell.test.ts` `discovery.test.ts`(recall@3)`errors.test.ts`(エラー再現 47 件・自己修復率)`manifestRefresh.test.ts`(再起動なしの追加)`coreSurface.test.ts`(core 面の stdio 一巡・動的登録・guarded)`toolSurface.test.ts`(legacy 面は M0 とバイト同一 / full 面は意味的に同一 / core・shell のサイズと lint / alias 網羅)
- `coreSpec.ts` … Core 面の仕様(Core の一覧と並び・説明テンプレ・統合ツールの振り分け表・alias 表・命名規約の動詞表。純データ)。`toolset/coreTools.ts` … 統合ツール 6 本の登録とマニフェストの `expose:"core"` による動的昇格
- `stdioClient.ts` … テスト用の最小 MCP stdio クライアント(`coreSurface.test.ts` が使う)
- `AGENTS.md` … AI エージェント向け運用ガイド（典型ワークフロー・禁止パターン）

## ツール(抜粋)

| カテゴリ | 主なツール |
|---|---|
| エンティティ | `dx12_list_entities` `dx12_get_entity` `dx12_create_entity` `dx12_delete_entity` `dx12_set_transform` `dx12_set_parent` `dx12_group_entities` `dx12_duplicate_entity` |
| コンポーネント | `dx12_describe_components` `dx12_set_component` `dx12_remove_component`（particleEmitter / trailRenderer / networkIdentity / networkTransform 等も対応） |
| 見た目 | `dx12_material_apply`（PBR 4点セットを1回で。フォルダ名から用途推定 + ORM が効く状態に自動調整） `dx12_set_pbr` `dx12_set_color` `dx12_set_texture` `dx12_create_shader` `dx12_set_mesh_shader` `dx12_set_sprite_shader` `dx12_set_post_process` `dx12_set_ssao` |
| Lua | `dx12_create_lua_component` `dx12_attach_lua_component` `dx12_set_lua_property` `dx12_eval_lua` `dx12_describe_lua_api` |
| アニメーション | `dx12_play_anim`（クリップ再生 / `state` で .animfsm のステート遷移・`layer` 指定可） `dx12_get_anim_state` `dx12_describe_anim_graph`（.animfsm の構造・ステート名/パラメータ名） `dx12_set_anim_param`（FSM パラメータを外から叩いて遷移を検証。**パラメータ名は `param`**、`name` はエンティティ名） |
| マルチプレイヤー | `dx12_net_setup` `dx12_net_status` `dx12_net_launch_test_client` |
| 再生/検証 | `dx12_play` `dx12_stop` `dx12_step_frames` `dx12_key_press` `dx12_raycast` `dx12_get_physics_state` `dx12_screenshot_final`（★見た目の判断はこちら。ポスト適用後の最終画）`dx12_screenshot`（ポスト前のシーン RT）`dx12_validate_scene` `dx12_build_game` |
| シーン編集強化 | `dx12_get_bounds` `dx12_look_at` `dx12_snap_to_ground` `dx12_get_hierarchy` `dx12_set_editor_camera` `dx12_screenshot_from` `dx12_scatter` |
| アセット操作 | `dx12_import_asset` `dx12_asset_info` `dx12_move_asset` `dx12_delete_asset` `dx12_view_texture` `dx12_preview_model` |
| 精密ピック | `dx12_pick`（画面座標→三角形精密ヒット列） `dx12_raycast_precise`（描画メッシュ基準のワールドレイ） |
| 地形 | `dx12_terrain_create` `dx12_terrain_generate` `dx12_terrain_sculpt` `dx12_terrain_erode` `dx12_terrain_sample` `dx12_terrain_set_layers`（.terrainlayers を割り当てる**唯一の経路**。初回はスプラット生成＋自動ペイント） `dx12_terrain_autopaint`（傾斜/標高から4層を焼き直す・冪等） `dx12_terrain_paint`（円ブラシで1層を塗る・相対） `dx12_terrain_splat_info`（塗り結果を絵を見ずに数値検証） |
| スカルプト | `dx12_sculpt_create` `dx12_sculpt_make_editable` `dx12_sculpt_brush` |
| ライティング | `dx12_list_lights`（灯数バジェット警告つき） `dx12_set_sun` `dx12_apply_lighting_preset` |
| 描画の切り分け | `dx12_render_debug`（中間バッファ可視化: normal/roughness/metallic/depth/ao/contactShadow/velocity/ssr/ssgi/**rt**/**rtDiff**/shadowCascade/lightComplexity/clusterGrid/decalCount/fog*/off の 19 mode。撮ったら設定は必ず元へ戻る。`albedo`・`overdraw` は理由つきで非対応） |
| 影 | `dx12_get_shadow_pcss` `dx12_set_shadow_pcss`（PCSS ソフトシャドウ。OFF で従来 PCF とビット一致） |
| レイトレーシング | `dx12_get_dxr` `dx12_set_dxr`（DXR 1.1 inline raytracing の RT サン影 / RT-AO。**非対応 GPU では `set` がエラーではなく `retryable:false` の結果で返る**＝撃ち直さない。検証は `dx12_render_debug(mode:"rtDiff")`） |
| 診断 | `dx12_diagnose`（シェーダー/テクスチャ/シーン参照/ライト/地形/ピッキング/Lua/**dxr** を一括検査） `dx12_describe_mcp_params`（エンジンが実際に受け付ける引数キーと型を method 名で引く。「設定したのに変わらない」ときの現物照合） |
| 品質判断 | `dx12_look_compare`（参照画像との測光比較: EV/コントラスト/CCT/彩度/黒潰れ + 具体的な示唆。既定でポスト後の最終画を測る） `dx12_camera_path`（動かして連写 → コンタクトシート + フレーム間差分） `dx12_scene_write`（シーン JSON を検証つきで直接書く） |

(以下は旧ツールの抜粋。全量と検索は shell 5 本 / `docs/MCP.md`)

生成/削除/シーン読込/Play/Stop は**遅延同期**: エンジンはフレーム境界で実処理し、完了後に
本物の結果(`entityId` 等)を同期で返す。「name で list して探す」旧パターンは不要。

## 使い方
1. エディタ(`DX12Engine.exe`)を起動してシーンを開く（ブリッジが 8787〜8797 で待ち受け）
2. AI から `dx12_doctor`(または `dx12_ping`)→ 疎通確認
3. `dx12_create_entity` / `dx12_set_component` / `dx12_attach_lua_component` でシーンを組む
4. `dx12_play` → `dx12_screenshot_final` / `dx12_get_log` で結果を確認
