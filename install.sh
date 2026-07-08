#!/usr/bin/env bash
# DX12 Engine MCP サーバのセットアップ(Linux / macOS)。install.ps1 と同等。
# Node v24+ を確認 -> npm install -> npm test(エンジン不要)-> 絶対パス解決済みの登録コマンドを表示。
# 注: エディタ本体は Windows 専用。他OSからは env DX12_MCP_HOST で別マシンの Windows エディタを遠隔操作する用途。
set -euo pipefail

# このスクリプトのあるディレクトリ = tools/mcp-server(どこから実行しても効くよう絶対パス化)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Node v24+ 必須(.ts を型ストリップで直接実行するため。tsc ビルドは不要)
if ! command -v node >/dev/null 2>&1; then
  echo "node が見つからへん。Node v24+ を入れてな: https://nodejs.org/" >&2
  exit 1
fi
ver="$(node --version)"
major="${ver#v}"; major="${major%%.*}"
if [ "$major" -lt 24 ]; then
  echo "Node $ver は古い。v24+ が要る(.ts 直接実行に必要)。" >&2
  exit 1
fi
echo "Node $ver OK"

# 依存インストール + 自己テスト
npm install
npm test

# 登録用の絶対パス
index="$here/index.ts"

echo
echo "=== セットアップ完了。下記いずれかで MCP サーバを登録してな ==="
echo
echo "[Claude Code]"
echo "  claude mcp add dx12-engine -- node \"$index\""
echo
echo "[.mcp.json](リポジトリ or ホームに置く。.mcp.json は gitignore 済み)"
cat <<EOF
  {
    "mcpServers": {
      "dx12-engine": {
        "command": "node",
        "args": ["$index"]
      }
    }
  }
EOF
echo
echo "別マシンの Windows エディタを叩く場合は env DX12_MCP_HOST=<そのIP> を足す。"
echo "使い方の詳細: docs/MCP.md"
