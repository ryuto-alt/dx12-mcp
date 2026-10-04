// DX12 ゲームエンジン用 MCP サーバ。Codex / Claude Code から接続し、
// 起動中のエディタ(TCP 127.0.0.1:<port>)を叩いてゲームを作っていくための入口。
//
// ★遅延同期: create/spawn/delete/duplicate/open_scene/new_scene/play/stop は
//   エンジンがフレーム境界で実処理してから【同じ id】で本物の result を返す。
//   このサーバは id で待つだけなので、ツールは本物の entityId 等を【同期で】返す。
//   旧来の「{queued} が返るので後で name で list して探す」パターンは完全廃止。
//
// ツール名は dx12_ 接頭辞。entity パラメータ(int)はエンジンに合わせてそのまま渡す(変換しない)。
// result のフィールド名(entityId 等)もエンジンの返り値をそのまま通す。


import { server } from "./toolset/core.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// ツールの登録(shell 5 本 + 旧 220 本)は toolset/all.ts の import 順。順序を入れ替えない。
import "./toolset/all.ts";

export { TOOL_PARAM_KEYS } from "./toolset/core.ts";

const transport = new StdioServerTransport();
await server.connect(transport);
