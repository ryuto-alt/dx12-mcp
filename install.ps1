#!/usr/bin/env pwsh
# DX12 Engine MCP サーバのセットアップ(Windows / PowerShell)。
# Node v24+ を確認 -> npm install -> npm test(エンジン不要)-> 絶対パス解決済みの登録コマンドを表示。
$ErrorActionPreference = "Stop"

# このスクリプトのあるディレクトリ = tools/mcp-server(どこから実行しても効くよう絶対パス化)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Node v24+ 必須(.ts を型ストリップで直接実行するため。tsc ビルドは不要)
$nodeVer = $null
try { $nodeVer = (node --version) } catch {}
if (-not $nodeVer) {
  Write-Error "node が見つからへん。Node v24+ を入れてな: https://nodejs.org/"
  exit 1
}
$major = [int]($nodeVer.TrimStart("v").Split(".")[0])
if ($major -lt 24) {
  Write-Error "Node $nodeVer は古い。v24+ が要る(.ts 直接実行に必要)。"
  exit 1
}
Write-Host "Node $nodeVer OK"

# 依存インストール + 自己テスト
npm install
npm test

# 登録用の絶対パス(Node は Windows でも '/' を解釈するので生成側はそのまま使える)
$index = Join-Path $here "index.ts"

Write-Host ""
Write-Host "=== セットアップ完了。下記いずれかで MCP サーバを登録してな ==="
Write-Host ""
Write-Host "[Claude Code]"
Write-Host "  claude mcp add dx12-engine -- node `"$index`""
Write-Host ""
Write-Host "[.mcp.json](リポジトリ or ホームに置く。.mcp.json は gitignore 済み)"
Write-Host "  {"
Write-Host "    `"mcpServers`": {"
Write-Host "      `"dx12-engine`": {"
Write-Host "        `"command`": `"node`","
Write-Host "        `"args`": [`"$($index -replace '\\','/')`"]"
Write-Host "      }"
Write-Host "    }"
Write-Host "  }"
Write-Host ""
Write-Host "別マシンの Windows エディタを叩く場合は env DX12_MCP_HOST=<そのIP> を足す。"
Write-Host "使い方の詳細: docs/MCP.md"
