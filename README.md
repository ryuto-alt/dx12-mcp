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

`%USERPROFILE%\dx12-mcp` に置くと、エディタの「MCP / AI Bridge」窓が自動検出して
登録コマンドをワンクリックでコピーできる。install スクリプトは Node v24+ を確認し、
`npm install` + 自己テスト(エンジン不要)を実行して、絶対パス解決済みの登録コマンドを表示する。

## 接続

### Claude Code
```powershell
claude mcp add dx12-engine -- node "$env:USERPROFILE\dx12-mcp\index.ts"
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
- `index.ts` … MCP サーバ本体(stdio)。70+ ツールを公開（全量はエンジンリポジトリの [docs/MCP.md](https://github.com/ryuto-alt/dx12/blob/main/docs/MCP.md) 参照）
- `test.ts` … mock エンジンで framing/相関/エラーを検証(`node test.ts`)
- `AGENTS.md` … AI エージェント向け運用ガイド（典型ワークフロー・禁止パターン）

## ツール(抜粋)

| カテゴリ | 主なツール |
|---|---|
| エンティティ | `dx12_list_entities` `dx12_get_entity` `dx12_create_entity` `dx12_delete_entity` `dx12_set_transform` `dx12_set_parent` `dx12_duplicate_entity` |
| コンポーネント | `dx12_describe_components` `dx12_set_component` `dx12_remove_component`（particleEmitter / trailRenderer / networkIdentity / networkTransform 等も対応） |
| 見た目 | `dx12_set_pbr` `dx12_set_color` `dx12_set_texture` `dx12_create_shader` `dx12_set_mesh_shader` `dx12_set_sprite_shader` `dx12_set_post_process` `dx12_set_ssao` |
| Lua | `dx12_create_lua_component` `dx12_attach_lua_component` `dx12_set_lua_property` `dx12_eval_lua` `dx12_describe_lua_api` |
| アニメーション | `dx12_play_anim` `dx12_get_anim_state` |
| マルチプレイヤー | `dx12_net_setup` `dx12_net_status` `dx12_net_launch_test_client` |
| 再生/検証 | `dx12_play` `dx12_stop` `dx12_step_frames` `dx12_key_press` `dx12_raycast` `dx12_get_physics_state` `dx12_screenshot` `dx12_validate_scene` `dx12_build_game` |

生成/削除/シーン読込/Play/Stop は**遅延同期**: エンジンはフレーム境界で実処理し、完了後に
本物の結果(`entityId` 等)を同期で返す。「name で list して探す」旧パターンは不要。

## 使い方
1. エディタ(`DX12Engine.exe`)を起動してシーンを開く（ブリッジが 8787〜8797 で待ち受け）
2. AI から `dx12_ping` → 疎通確認
3. `dx12_create_entity` / `dx12_set_component` / `dx12_attach_lua_component` でシーンを組む
4. `dx12_play` → `dx12_screenshot` / `dx12_get_log` で結果を確認
