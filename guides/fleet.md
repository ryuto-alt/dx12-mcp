# 専用エンジン(フリート)の使い方
> 複数のエージェントが同じエンジンを奪い合わない。最初に dx12_engine_launch で自分専用のエンジンを起動する。

## 基本の流れ
1. `dx12_engine_launch {}` … 自分専用のエンジンを背景で起動し、このセッションの既定に束縛する(以後の全ツールがそこへ向く)。`project` を省略すると使い捨てプロジェクトを自動で作る。
2. 普通に `dx12_list_entities` や `dx12_scene_write` などを使う。
3. 終わったら `dx12_engine_stop {}`(閉じ忘れても、10 分操作が無ければ自動で終了する。MCP サーバが終わってもエンジンは残らない)。

## 何が別になるか
ポート(8860〜8899 から自動割当)・exe コピー(`%LOCALAPPDATA%\UnoEngine\fleet\instances\<id>\bin`)・データ領域(`DX12E_DATA_DIR`)・作業フォルダ・使い捨てプロジェクトが全部別。**ビルド(`tools\build.ps1`)は `build\release\DX12Engine.exe` を自由に上書きできる**(実行中の exe は別の場所にある)。ビルドの後は `dx12_engine_refresh` で最新の exe に入れ替える(`dx12_doctor` が「古い exe コピー」と警告する)。

## 上限と資源
- 全体で最大 **3 台**(他のエージェントの分も数える)。空き VRAM が 2 GB 未満・空き RAM が 3 GB 未満でも起動を断る。断られたら `E_FLEET_LIMIT` / `E_FLEET_RESOURCE` の `fix`(自分の idle なエンジンを止める `dx12_engine_stop`)を撃つ。**他のセッションのエンジンは止めない**(`details.others` に持ち主と idle 時間が出る。ユーザーに確認する)。
- 閾値の変更: `DX12_FLEET_MAX` / `DX12_FLEET_MIN_FREE_VRAM_MB` / `DX12_FLEET_MIN_FREE_RAM_MB`(MCP サーバの環境変数)。

## 起動モード
- `background`(既定): 窓は画面外・タスクバーに出ない・前面化しない。スクショと UI 操作は仮想入力(`dx12_imgui` / `dx12_capture`)で行える。
- `headless`: 窓なし。画面が要らない検証用(既定ではディスクへ書かない)。
- `visible`: 窓を画面に出す。**既定で拒否**。環境変数 `DX12_MCP_ALLOW_VISIBLE=1`(ユーザーが設定)と呼び出しの `confirm:true` の両方が要る。それでも実マウス・フォーカスを奪い得るので、ユーザーに確認してから使う。

## 手動起動のエンジン・他のエージェントのエンジンを見る
`dx12_engine_attach {port}` または `{engine}` … **読み取り専用**(effect が read の method だけ通る)。接続は最後の応答から 1.5 秒で閉じるので、持ち主の接続枠を塞がない。持ち主が接続中なら `E_ENGINE_BUSY`。書き込みが要るなら `dx12_engine_launch` で自分専用を起動する。

## 複数のエンジンを持つとき
`dx12_engine_list` で一覧、`dx12_call {name, args, engine:"<id|name|port>"}` でその 1 回だけ別のエンジンへ、`dx12_call {name:"dx12_engine_use", args:{engine}}` で既定を切り替える(`"none"` で従来の探索へ戻る)。

## 従来どおりの運用
束縛が無ければ、従来どおり `DX12_MCP_PORT` → ポートファイル(`%TEMP%\dx12_mcp.port`)→ 8787 の順で手動起動のエンジンへ繋ぐ。`DX12_FLEET_DISABLE=1` でフリートのツールごと止められる。

## Codex CLI など、ツール検索が無いクライアント
`DX12_MCP_SURFACE=core`(Core 40 本。`dx12_engine_*` 5 本を含む)が推奨。Core に無い操作は `dx12_call {name, args}`(`dx12_engine_use` もここ)。
