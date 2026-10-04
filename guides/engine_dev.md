# エンジンに method を足したら何をするか(最短手順)
> エンジンの登録表(McpDefine + McpMeta)が唯一の真実。足したら再ビルド・エンジン再起動だけ。MCP サーバ(Node)も Claude Code も再起動は要らない。Core にも載せたいときは expose を 1 行。

## 手順
1. **エンジン**: `src/core/mcp/ApplicationMcp*.cpp` の `Register***McpMethods()` に 1 本足す。
   - 推奨(meta 付き): `McpDefine("my_method", McpMeta{ summary, keywords, category, group, target, effect, mode, timeoutMs, idempotent, deferred, dryRun, aliases, params, next, examples, expose }, DX12E_MCP_HANDLER { ... });`
     記入例は `ApplicationMcpManifest.cpp` の `describe_mcp_manifest`(引数は `P("name","type",required,enum,min,max,default,desc)`)。
     `params` を書くと、ハンドラの前に中央検証(必須・型・enum・範囲。違反は `E_MISSING_PARAM` / `E_BAD_TYPE` / `E_BAD_ENUM` / `E_OUT_OF_RANGE`)が走り、`dx12_tool_describe` の説明にもなる。
   - 従来の `McpDefine("my_method", "key:type,...", ...)` でも動く。その場合は `src/core/mcp/ApplicationMcpManifestData.inc` に同じ名前の行(summary / category / effect / timeout / params)を足す(`McpManifestTests` が全 method の記載を要求する)。
   - 第 2 引数のキー表は本文が読むキーと一致させる(`McpParamSpecTests` が見張る)。
   - `effect` は必ず正しく付ける: `read` / `write_scene`(Undo で戻る。Transform を書き換えるものもここ)/ `write_setting`(設定・エディタカメラ)/ `write_file`(Undo で戻らない)/ `runtime`(実行状態・時間が進む)/ `guarded`(git push・任意コード実行など取り返しが付かない・外部へ出る)。引数しだいで書くもの(`fix:'safe'` など)は `read` にせず、TS 側の `CONDITIONAL_WRITE`(`catalog.ts`)にも足す。
2. **ビルド**: `pwsh -NoProfile -File tools\build.ps1`(テストは `-Tests`)。エンジンを `--background` で起動し直す。
3. **MCP**: 何もしない。次の `dx12_tool_search` / `dx12_tool_describe` / `dx12_call` が `ping.manifestHash` の変化を見てマニフェストを取り直す(**主経路**。`core` 面ではエンジンへの再接続時にも自動で取り直す)。
   ```
   dx12_tool_search {query:"my method"} → dx12_tool_describe {name:"my_method"} → dx12_call {name:"my_method", args:{...}}
   ```
4. **Core に載せたい(任意・1 行)**: `McpMeta` の `.expose = "core"`。MCP サーバが `tools/list` に `dx12_my_method` を足して `notifications/tools/list_changed` を送る(引数・説明はマニフェストから生成。guarded は昇格しない)。
   ★Claude Code が list_changed を反映するかは未確認。反映されなくても手順 3 の経路で使える。止めたいときは MCP の env に `DX12_MCP_LIST_CHANGED=0`。
   静的に Core へ入れたい旧ツール名は `coreSpec.ts` の `CORE_LEGACY` / `CORE_ORDER` / `CORE_DESCRIPTIONS`(説明テンプレ 600 字以内)に足し、`toolSurface.test.ts` を通す。
5. **TS ラッパ(任意)**: 専用ツール名・複合処理が要るときだけ `toolset/*.ts` に `reg(...)` を足す(クライアントの再起動が要る)。足したら `paramGuard.ts` の `COMPOSITE_TOOLS`(合成ツールの場合)、`searchHints.ts`(検索語)、`eval/discovery_tasks.json`(代表クエリ)を更新し、`node scripts/gen_legacy_snapshot.mjs` は**旧ツールを意図して変えたときだけ**。
6. **スナップショット**: エンジンを起動した状態で `node scripts/gen_manifest_snapshot.mjs`(エンジン未接続時の検索用。実行中はエンジン側が常に優先される)。
7. **文書**: `docs/MCP.md`(§4 の該当表と §12)。
8. **配布**: `tools/mcp-server/publish.ps1`(push は人の確認が要る操作)。

## Lua API を足したとき(lua-api-checklist)の対応表
| 足したもの | 更新する場所 | 自動? |
|---|---|---|
| Lua の関数/テーブル/usertype | `src/core/Application.cpp` の `McpLuaApi()`(`dx12_call {name:"describe_lua_api"}` の辞書) | 手作業 |
| 〃 | `docs/API_REFERENCE.md`(§2 の一覧 + §3 の専用節)/ `docs/SCRIPTING.md`(短い例)/ `docs/index.html`(Lua の該当表) | 手作業 |
| 〃 | Lua の予測変換(`ScriptEngine::GetCompletions`) | 自動(lua state から動的列挙) |
| method / ツール | 上の手順 1〜7(マニフェスト・snapshot・ヒント・文書) | 一部自動(schemaDrift・toolSurface) |

## 後始末の自動化(M4 の下地)
`npm run finalize`(M4 で実装予定)は次を 1 コマンドにまとめる案: ① `gen:docs`(`docs/MCP.md` §4 / README / `AGENTS.md` の表をマニフェストから生成、`--check` は CI) ② `lua_api.json` → `McpLuaApi()` / `API_REFERENCE.md` §2 / `docs/index.html` の表を生成 + `--check`
③ `node scripts/gen_manifest_snapshot.mjs`(エンジン起動中のみ)④ `check:legacy-snapshot` + `schemaDrift` + `test:offline` ⑤ `publish.ps1` の差分表示(push は人の承認)。現状は上の表を手で行う。
