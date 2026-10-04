// 仮想入力モード(imgui_*): 人のカーソルを奪わずエディタ UI を操作・撮影する
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { definedOnly } from "../paramGuard.ts";
import path from "node:path";
import { engine, errResult, imageResult, reg, regRaw, run } from "./core.ts";

// ── 仮想入力モード(AI が人の PC 操作を奪わずにエディタ UI を操作・撮影する) ───────────
// ★AI がエディタ UI を触るときは【必ず】これ + 起動引数 --background を使うこと。
//   実マウス/実キーボード/フォーカスを操作するスクリプト(SendInput / mouse_event / SetCursorPos /
//   SetForegroundWindow / computer-use)は使わない。人がカーソルを奪われて PC を使えなくなる。
reg(
  "dx12_imgui_virtual_input",
  "仮想入力モード切替",
  "エディタの『仮想入力モード』を ON/OFF し、現在の状態を返す。"
  + "★AI がエディタ UI(ImGui)を操作・撮影するときは必ずこのモードを ON にして、起動引数 --background(手前に出さない起動)と併用すること。"
  + "ON の間: 実マウス/実キーボードは ImGui に届かず(=人の操作と混ざらない)、OS のカーソル・フォーカス・前面ウィンドウには一切触れない"
  + "(SetCursorPos / ClipCursor / ShowCursor / SetCapture / SetForegroundWindow / SetFocus を全部無効化)。"
  + "操作は dx12_imgui_pointer / dx12_imgui_key、狙う場所は dx12_imgui_find、画面は dx12_imgui_screenshot(ImGui 込み・PrintWindow 不使用)。"
  + "スクショには仮想カーソル(矢印 + クリックの波紋 + AI タグ)が写るので『AI が今どこを触っているか』が分かる。"
  + "起動引数 --virtual-input / --background でも最初から ON になる(--background は仮想入力を含意)。"
  + "★人の脱出口: 仮想入力モード中は人の実入力が効かない。Ctrl+Alt+Shift+F12(実キーボード)で OFF に戻せ、MCP が 5 秒以上切れたら(この呼び出しで ON にした場合)自動で OFF に戻る。"
  + "enable を省略すると状態だけ返す。"
  + "返る形: {enabled, background:{mode,toolWindow}, pointer:{known,x,y,left,right,middle}, queue:{pending,pumped}, client:{width,height}, "
  + "window:{logicalWidth,logicalHeight,visible,minimized,isForegroundWindow}, osCursor:{x,y}(読み取りのみ)}。"
  + "★osCursor / isForegroundWindow は『AI の操作中に人のカーソルと前面ウィンドウが動いていないか』を外から確かめるための読み取り値。"
  + "★Play 中のゲーム入力(dx12_key_down / dx12_key_press / dx12_mouse_move / dx12_ui_click)は従来の合成入力のままで、これらも OS には触れない。",
  {
    enable: z.boolean().optional().describe("true で ON、false で OFF。省略で現在の状態だけ返す。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("imgui_virtual_input", definedOnly(a))),
);

reg(
  "dx12_imgui_pointer",
  "仮想ポインタ操作",
  "仮想入力モード(dx12_imgui_virtual_input)でエディタ UI をポインタ操作する。座標はエディタウィンドウのクライアント座標(px) = dx12_imgui_screenshot の画像ピクセルと同じ。"
  + "action: move(移動) / down(押す) / up(離す) / click(移動→押す→離す) / double_click / drag((x,y)→(toX,toY)を steps フレームかけて補間) / wheel(ホイール)。"
  + "button は left(既定) / right / middle。drag は steps(既定 12、最大 600)。wheel は dx / dy(ノッチ。dy 正 = 上スクロール)で、x,y を付けるとその位置へ先に動く。"
  + "down / up は x,y を省くと『今の位置』で押す/離す。"
  + "★押す(down)と離す(up)は必ず別フレーム、移動はその 1 フレーム前に入れる(ImGui のクリック判定はフレーム単位で、同一フレームに入れると押下が消えるため)。"
  + "★遅延同期: 積んだ入力が全部フレームに流れ切って ImGui が反応してから返る(通常 3〜数十フレーム)。返る値: {action, at, frames, clamped, pointer, hover:{window,focusedWindow,wantCaptureMouse,wantCaptureKeyboard,wantTextInput}}。"
  + "hover.window は『クリックした先のウィンドウ名』で、狙った窓に当たったかの確認に使う。wantTextInput が true ならテキスト欄がアクティブ(dx12_imgui_key の text を送れる)。"
  + "★座標がクライアント領域の外なら丸める(clamped:true。OS ウィンドウを引き出さないため)。"
  + "★狙う座標は推測せず dx12_imgui_find の rect / center か dx12_imgui_screenshot の画像から取ること。"
  + "★エディタのフライカメラ(右ドラッグ)も仮想ポインタで動く: button:right の drag / down + move をシーンビュー上で。",
  {
    action: z.enum(["move", "down", "up", "click", "double_click", "drag", "wheel"]).describe("操作の種類。"),
    x: z.number().optional().describe("クライアント座標 X(px)。move / click / double_click / drag(始点) では必須。down / up / wheel では任意。"),
    y: z.number().optional().describe("クライアント座標 Y(px)。x と対で指定する。"),
    button: z.enum(["left", "right", "middle"]).optional().describe("ボタン。既定 left。"),
    toX: z.number().optional().describe("drag の終点 X(px)。"),
    toY: z.number().optional().describe("drag の終点 Y(px)。"),
    steps: z.number().int().optional().describe("drag の補間フレーム数(既定 12、1〜600)。"),
    dx: z.number().optional().describe("wheel の横ノッチ数(正 = 右)。"),
    dy: z.number().optional().describe("wheel の縦ノッチ数(正 = 上スクロール)。"),
  },
  {},
  (a) => run(() => engine.call("imgui_pointer", definedOnly(a))),
);

reg(
  "dx12_imgui_key",
  "仮想キー入力",
  "仮想入力モードでエディタ UI にキー押下 / 文字入力を送る。key は名前(\"F2\" / \"Ctrl+S\" / \"Ctrl+Shift+Z\" / \"Enter\" / \"Esc\" / \"Delete\" / \"Tab\" / \"Up\" / \"PageDown\" / \"A\" 等。修飾は Ctrl / Shift / Alt / Win)。"
  + "text は文字列をそのまま入力する(日本語可)。★文字入力の前に、テキスト欄を dx12_imgui_pointer でクリックしてアクティブにしておくこと"
  + "(クリック後の応答の hover.wantTextInput が true なら入力できる)。key と text を両方渡すと key → text の順に流す。"
  + "キーは『押す → 次のフレームで離す』の 2 フレームで(hold で押し続けるフレーム数を指定できる。既定 1)、修飾キーは主キーの前に押して後に離す。"
  + "ImGui のショートカット(IsKeyChordPressed)と、VK ベースの入力(F1 一時停止など)の両方へ届く。"
  + "遅延同期(全部流れて ImGui が反応してから返る)。返る値: {key, vk, text, frames, pointer, hover}。"
  + "★Play 中のゲームへの入力は dx12_key_down / dx12_key_press を使う(こちらはエディタ UI 用)。",
  {
    key: z.string().optional().describe("キー名。\"F2\" / \"Ctrl+S\" / \"Enter\" 等。"),
    text: z.string().optional().describe("入力する文字列(UTF-8)。テキスト欄がアクティブのときに使う。"),
    hold: z.number().int().optional().describe("key を押し続けるフレーム数(既定 1、最大 600)。エディタのフライカメラの WASD など『押している間だけ効く』操作に。key があるときだけ有効。"),
  },
  {},
  (a) => run(() => engine.call("imgui_key", definedOnly(a))),
);

reg(
  "dx12_imgui_find",
  "UI要素を名前で探す",
  "ImGui のウィンドウ / ドックのタブ / 名前つき要素を名前で探し、矩形を返す。★座標を推測せず狙うための道具(dx12_imgui_pointer の x,y にそのまま渡せる)。"
  + "label 省略で今見えているウィンドウの一覧、label 指定でその名前に合う物だけ。contains(既定 true)は部分一致(大小無視)、false で完全一致。"
  + "返る形: {client:{width,height}, windows:[{name,title,rect:{x,y,w,h},center:{x,y},screenRect,visible,focused,hovered,collapsed,docked,popup,dockTabSelected?,tab?:{rect,center}}], "
  + "items:[{kind,label,window,rect,center,labelRect?}], counts, hover, coordinates}。"
  + "rect / center はエディタウィンドウのクライアント座標(px)。screenRect は ImGui 内部の(スクリーン)座標。"
  + "windows の tab はドック内のタブ見出し(クリックでそのパネルが前面に来る)。"
  + "items は仮想入力モード ON の間に描かれた『名前つき要素』: property(Inspector 等のプロパティ行。rect は値欄、labelRect はラベル) / header(コンポーネント見出し) / "
  + "button(ツールバーのボタン) / menu(メニューバー) / row(Hierarchy のエンティティ行)。全ウィジェットを網羅するものではない。"
  + "見つからない要素は windows の rect を基準に dx12_imgui_screenshot で目視して座標を決める。"
  + "同期(即時)。前フレームの描画結果を返す。",
  {
    label: z.string().optional().describe("探す名前(ウィンドウ名 / ラベル)。省略で見えているウィンドウ一覧。"),
    contains: z.boolean().optional().describe("true(既定)= 部分一致(大小無視)。false = 完全一致。"),
  },
  { readOnlyHint: true },
  (a) => run(() => engine.call("imgui_find", definedOnly(a))),
);

regRaw(
  "dx12_imgui_screenshot",
  {
    title: "ImGui込みスクリーンショット",
    description: "エディタの最終画面を ImGui(パネル・ギズモ・仮想カーソル)込みで PNG に保存して返す。"
      + "★バックバッファに ImGui を描いた後・Present の前に読み戻すので、PrintWindow を使わない = 窓が背面・画面外・最小化でも撮れ、人の画面には何も出ない。"
      + "仮想入力モード ON なら仮想カーソル(矢印 + クリックの波紋 + AI タグ)が写る。"
      + "画像のピクセル座標 = dx12_imgui_pointer のクライアント座標(そのまま渡せる)。"
      + "path 省略時はエンジンの CWD の mcp_imgui_screenshot.png へ書く(CWD が書けない場所だと失敗するので path を明示するのが安全)。"
      + "★3D の絵の見た目(ポスト適用後)だけを見たいなら dx12_screenshot_final、ImGui 込みのエディタ全体はこれ(dx12_ui_screenshot は仮想入力モード中はこれと同じ経路になる)。"
      + "返る値: 画像 + {path, width, height, source:'backbuffer+imgui', virtualCursor}。",
    inputSchema: {
      path: z.string().optional().describe("保存先 PNG(絶対パス推奨)。省略で CWD の mcp_imgui_screenshot.png。"),
    },
    annotations: { title: "ImGui込みスクリーンショット", openWorldHint: false, readOnlyHint: true },
  },
  async (a: any) => {
    try {
      const shot = await engine.call("imgui_screenshot", definedOnly(a ?? {}));
      if (!shot || !shot.path) throw new Error("imgui_screenshot が path を返さなかった");
      return imageResult(shot.path, {
        width: shot.width, height: shot.height, source: shot.source, virtualCursor: shot.virtualCursor,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

reg(
  "dx12_step_frames",
  "Nフレーム進める",
  "N フレーム経過してから応答する同期バリア。key_down/key_press の後に呼ぶと、入力がシミュレーションに効いてから dx12_get_entity / dx12_project_world_to_screen / dx12_screenshot で結果を観測できる。例: key_down('D') → step_frames(30) → get_entity(name:'Player') で右に動いたか確認 → key_up('D')。frames は 1..600(~10s)。★deterministic:true で dt を固定する(既定 1/60)。これを付けないと各フレームの dt は実時間なので、同じ入力を同じフレーム数だけ与えても進む距離が毎回変わる(ジャンプが届いたり届かなかったりする)。物理はもともと 60Hz 固定ステップなので dt=1/60 なら端数が出ない。応答に simulatedSec(= dt × frames)が付く。★deterministic:true は進めた後に【時間を止める】(次の step_frames まで進まない)。これが無いと、応答を待つ MCP の往復の間もエンジンが回り続けて不定な数のフレームが余計に進み、dt を固定しても再生が毎回 1〜2m ずれる(実測)。止まるのはシミュレーションだけなので、この間にスクショも設定の読み書きもできる。hold:false で従来どおり走らせ続ける。dx12_play / dx12_stop で必ず解除される。台本ごと流すなら dx12_play_script を使う方が速い。",
  {
    frames: z.number().int().optional().describe("進めるフレーム数(既定 1, 最大 600)。"),
    deterministic: z.boolean().optional().describe("true で dt を固定し、再現するステップにする。"),
    dt: z.number().optional().describe("固定 dt(秒)。既定 1/60 = 0.016667。deterministic:true のときだけ有効。"),
    hold: z.boolean().optional().describe("進めた後に時間を止めるか(既定 true)。deterministic:true のときだけ有効。false で従来どおり走らせ続ける。"),
  },
  {},
  ({ frames, deterministic, dt, hold }) => run(() => engine.call("step_frames", { frames, deterministic, dt, hold })),
);

reg(
  "dx12_perf_stats",
  "パフォーマンス統計",
  "直近 window フレーム(既定60)の性能統計を即時取得。fps / frameMs(avg,min,max,p95) / cpu(workMs,fenceWaitMs,presentMs) / "
  + "gpuPassMs(total, shadows, depthPrepass, prepassSsao, clusterCull, raytracing, rtScreen, ddgi, screenSpaceGi, volFog, hiZ, mainScene, particles, postFx, ui, vgCull "
  + "※約3フレーム遅れのGPUタイムスタンプ。raytracing = DXR の BLAS 遅延構築 + TLAS の毎フレーム再構築(加速構造だけ)、"
  + "rtScreen = RT サン影 + RT-AO + RT デバッグのスクリーン空間パス。どちらも DXR OFF なら 0。vgCull = 仮想ジオメトリ(Nanite 風)の GPU カリング。既定 OFF なら 0) / "
  + "drawCalls / culled / triangles / vsync / fpsLimit / scene(エンティティ内訳・shadows/ssao) と "
  + "analysis(verdict: gpu-bound|cpu-bound|fps-limit-capped 等 + 改善ノート)を返す。FPS が出ない時はまずこれで犯人を特定する。",
  { window: z.number().int().optional().describe("平均するフレーム数(既定 60, 最大 240)。") },
  { readOnlyHint: true },
  ({ window }) => run(() => engine.call("perf_stats", { window })),
);

reg(
  "dx12_benchmark",
  "ベンチマーク実行",
  "N フレーム(既定300, 30..3600)計測してから統計を返す遅延同期ベンチ。返り値は dx12_perf_stats と同形式 + frames / fps1PercentLow(p99フレーム時間の逆数=スパイク体感指標)。★既定で計測中だけ FPS上限/VSync を外す(uncap)ので、fpsLimit に張り付かない真のスループットが出る。カメラ位置・シーン・Play/Editor 状態は呼び出し側が事前に整えること。最適化の前後で同条件で回して比較するのが正しい使い方。実行中の重複呼び出しはエラー。",
  {
    frames: z.number().int().optional().describe("計測フレーム数(既定 300)。30..3600。"),
    uncap: z.boolean().optional().describe("計測中だけ FPS上限/VSync を外す(既定 true)。false で普段の設定のまま測る。"),
  },
  { readOnlyHint: true },
  ({ frames, uncap }) =>
    run(() =>
      engine.call("benchmark", { frames, uncap }, {
        // 30fps まで落ちてても間に合う余裕: frames×34ms + 10s
        timeout: (frames ?? 300) * 67 + 10000,
      })),
);
