#!/usr/bin/env pwsh
# DX12 Engine MCP サーバのセットアップ(Windows / PowerShell)。
# Node v24+ を確認 -> npm install -> npm test(エンジン不要)-> Claude Code と Codex に自動登録。
# 手で貼るコマンドは無い。CLI が入っていない環境だけ、その分を手順として表示する。
$ErrorActionPreference = "Stop"

# このスクリプトのあるディレクトリ = tools/mcp-server(どこから実行しても効くよう絶対パス化)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Node v24+ 必須(.ts を型ストリップで直接実行するため。tsc ビルドは不要)
$nodeVer = $null
try { $nodeVer = (node --version) } catch {}
if (-not $nodeVer) {
  Write-Error "node が見つかりません。Node v24+ を入れてください: https://nodejs.org/"
  exit 1
}
$major = [int]($nodeVer.TrimStart("v").Split(".")[0])
if ($major -lt 24) {
  Write-Error "Node $nodeVer は古いです。v24+ が必要です(.ts 直接実行に必要)。"
  exit 1
}
Write-Host "Node $nodeVer OK"

# 依存インストール + 自己テスト
npm install
npm test

# 登録用の絶対パス(Node は Windows でも '/' を解釈するので生成側はそのまま使える)
$index = Join-Path $here "index.ts"

# ponytail: 設定ファイルを自前で書かず、各CLIの mcp add に投げる。
# TOML/JSON の書式・置き場所・スキーマ変更は向こうの責任になる。
# remove -> add で冪等(既に登録済みでも add がエラーで止まらない)。
function Register-Mcp($cli, $label, $scopeArgs) {
  if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) { return $false }
  & $cli mcp remove dx12-engine *> $null   # スコープ指定なし = 入っている所から消す
  & $cli mcp add dx12-engine @scopeArgs -- node "$index" *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  ! $label への登録に失敗しました。手動: $cli mcp add dx12-engine -- node `"$index`""
    return $false
  }
  Write-Host "  OK $label"
  return $true
}

Write-Host ""
Write-Host "=== MCP クライアントへ登録 ==="
# --scope user: どのディレクトリで起動しても使える。エンジンは1台に1つなので project スコープは不適。
$claude = Register-Mcp "claude" "Claude Code (user スコープ)" @("--scope", "user")
$codex  = Register-Mcp "codex"  "Codex (~/.codex/config.toml)" @()

if (-not $claude) {
  Write-Host "  - Claude Code CLI が見つかりません。入れた後:"
  Write-Host "      claude mcp add dx12-engine --scope user -- node `"$index`""
}
if (-not $codex) {
  Write-Host "  - Codex CLI が見つかりません。~/.codex/config.toml に直接書く場合:"
  Write-Host "      [mcp_servers.dx12-engine]"
  Write-Host "      command = `"node`""
  Write-Host "      args = [`"$($index -replace '\\','/')`"]"
}

Write-Host ""
Write-Host "セットアップ完了。クライアントを再起動すると dx12_* ツールが出ます。"
Write-Host "接続確認: エディタを起動して dx12_ping"
Write-Host "別マシンの Windows エディタを叩く場合は env DX12_MCP_HOST=<そのIP> を足す。"
Write-Host "使い方の詳細: docs/MCP.md"
