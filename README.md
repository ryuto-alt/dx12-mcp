# DX12 Engine MCP server

起動中の [DX12 Engine](https://github.com/ryuto-alt/dx12) エディタを Claude Code / Codex から
叩いてゲームを作るための MCP サーバ。エディタ(C++)が `127.0.0.1:8787` で待ち受ける TCP ブリッジに
改行区切り JSON で繋ぐ。ゲーム(封印ランタイム)ではブリッジは起動しない＝外から触れない。

- **配布リポジトリ**: https://github.com/ryuto-alt/dx12-mcp （エンジン本体には同梱されない）
- **ソース・オブ・トゥルース**: エンジンリポジトリの `tools/mcp-server`（`publish.ps1` で dx12-mcp へ同期）
- **必要環境**: Node.js **v24+**（`.ts` を型ストリップで直接実行。tsc ビルド不要）、起動中の DX12 Engine エディタ

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

## 構成
- `engineClient.ts` … TCP フレーミング + id 相関の薄いクライアント（ポートは env `DX12_MCP_PORT` → `%TEMP%/dx12_mcp.port` → 8787 の順で自動解決。別マシンは `DX12_MCP_HOST`）
- `index.ts` … MCP サーバ本体(stdio)。141 ツールを公開（全量はエンジンリポジトリの [docs/MCP.md](https://github.com/ryuto-alt/dx12/blob/main/docs/MCP.md) 参照）
- `sceneTools.ts` … 地形/スカルプト/診断の引数正規化と共通 zod 部品（純ロジック・エンジン非依存）
- `materialApply.ts` … `dx12_material_apply` の純ロジック（ファイル名からのテクスチャ用途推定、`hasOverride` の罠の回避）
- `paramGuard.ts` … 未知の引数を黙って捨てず「近い正解」を返す共通部品 + 適用後の読み返し照合
- `schemaDrift.ts` … `Application.cpp` と TS スキーマの食い違いを検出するパーサ（`schemaDrift.test.ts` が使う）
- `lookCompare.ts` … 3D の絵の測光（対数輝度ヒストグラム/CCT/彩度/黒潰れ）と参照画像との差分・示唆生成
- `contactSheet.ts` … カメラ経路の生成とコンタクトシート合成（連続フレーム差分つき）
- `sceneWrite.ts` … シーン JSON の検証・要約・書き出し先の解決（`SceneSerializer.cpp` のスキーマと 1:1）
- `test.ts` … mock エンジンで framing/相関/エラーを検証(`node test.ts`)
- `*.test.ts` … 各純ロジックの回帰テスト。`npm test` で全部、`npm run test:offline` でネット不要分のみ
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

生成/削除/シーン読込/Play/Stop は**遅延同期**: エンジンはフレーム境界で実処理し、完了後に
本物の結果(`entityId` 等)を同期で返す。「name で list して探す」旧パターンは不要。

## 使い方
1. エディタ(`DX12Engine.exe`)を起動してシーンを開く（ブリッジが 8787〜8797 で待ち受け）
2. AI から `dx12_ping` → 疎通確認
3. `dx12_create_entity` / `dx12_set_component` / `dx12_attach_lua_component` でシーンを組む
4. `dx12_play` → `dx12_screenshot_final` / `dx12_get_log` で結果を確認
