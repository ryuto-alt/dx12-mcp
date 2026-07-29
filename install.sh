#!/usr/bin/env bash
# DX12 Engine MCP サーバのセットアップ(Linux / macOS)。install.ps1 と同等。
# Node v24+ を確認 -> npm install -> npm test(エンジン不要)-> Claude Code と Codex に自動登録。
# 注: エディタ本体は Windows 専用。他OSからは env DX12_MCP_HOST で別マシンの Windows エディタを遠隔操作する用途。
set -euo pipefail

# このスクリプトのあるディレクトリ = tools/mcp-server(どこから実行しても効くよう絶対パス化)
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Node v24+ 必須(.ts を型ストリップで直接実行するため。tsc ビルドは不要)
if ! command -v node >/dev/null 2>&1; then
  echo "node が見つかりません。Node v24+ を入れてください: https://nodejs.org/" >&2
  exit 1
fi
ver="$(node --version)"
major="${ver#v}"; major="${major%%.*}"
if [ "$major" -lt 24 ]; then
  echo "Node $ver は古いです。v24+ が必要です(.ts 直接実行に必要)。" >&2
  exit 1
fi
echo "Node $ver OK"

# 依存インストール + 自己テスト
npm install
npm test

# 登録用の絶対パス
index="$here/index.ts"

# ponytail: 設定ファイルを自前で書かず、各CLIの mcp add に投げる。
# remove -> add で冪等(既に登録済みでも add がエラーで止まらない)。
register() {  # $1=cli  $2=label  $3...=scope args
  local cli="$1" label="$2"; shift 2
  command -v "$cli" >/dev/null 2>&1 || return 1
  "$cli" mcp remove dx12-engine >/dev/null 2>&1 || true   # スコープ指定なし = 入っている所から消す
  if "$cli" mcp add dx12-engine "$@" -- node "$index" >/dev/null 2>&1; then
    echo "  OK $label"; return 0
  fi
  echo "  ! $label への登録に失敗しました。手動: $cli mcp add dx12-engine -- node \"$index\""
  return 1
}

echo
echo "=== MCP クライアントへ登録 ==="
# --scope user: どのディレクトリで起動しても使える。エンジンは1台に1つなので project スコープは不適。
register claude "Claude Code (user スコープ)" --scope user || cat <<EOF
  - Claude Code CLI が見つかりません。入れた後:
      claude mcp add dx12-engine --scope user -- node "$index"
EOF
register codex "Codex (~/.codex/config.toml)" || cat <<EOF
  - Codex CLI が見つかりません。~/.codex/config.toml に直接書く場合:
      [mcp_servers.dx12-engine]
      command = "node"
      args = ["$index"]
EOF

echo
echo "セットアップ完了。クライアントを再起動すると dx12_* ツールが出ます。"
echo "接続確認: エディタを起動して dx12_ping"
echo "別マシンの Windows エディタを叩く場合は env DX12_MCP_HOST=<そのIP> を足す。"
echo "使い方の詳細: docs/MCP.md"
