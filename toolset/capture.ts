// スクリーンショット / 中間バッファ可視化(render_debug)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import path from "node:path";
import { z } from "zod";
import { RENDER_DEBUG_MODES, renderDebugModeIssue } from "../sceneTools.ts";
import { definedOnly } from "../paramGuard.ts";
import fs from "node:fs";
import { compareUiImages } from "../uiCompare.ts";
import os from "node:os";
import { engine, errResult, imageResult, regRaw } from "./core.ts";
import type { ToolResult } from "./core.ts";

// ── スクショ 2 種の共通引数 ────────────────────────────────────────
// ★zod の同一インスタンスを 2 つのツールで共有すると JSON Schema が $ref に畳まれ、
//   $ref を解決しないクライアントではスキーマが空に見える。v3() と同じく
//   【呼ぶたびに新しいインスタンスを作るファクトリ】にすること。
const captureParams = () => ({
  path: z.string().optional().describe(
    "出力先の PNG パス(エンジンの CWD からの相対 or 絶対)。拡張子 .png は自動補完、親フォルダは自動生成、'..' は拒否。"
    + "★省略すると毎回【同じ既定ファイル】を上書きする。連写・並行実行するときは必ず別々の path を指定すること。"),
  deterministic: z.boolean().optional().describe(
    "true でピクセル完全再現モード。既定 false。time を固定(deband ディザ/グレイン/wave/glitch/パーティクルが止まる)し、"
    + "TAA・ボリュメトリックフォグ・SSGI の時間ジッタ位相を 0 に固定、時間蓄積の履歴を捨ててから settleFrames ぶん回して撮る。"
    + "★A/B のピクセル差分を取るなら必須(付けないと同じ設定でも 2 枚は一致しない: deband/グレインで画面の 66%、TAA で 9.4% が動く)。"
    + "★止まるのはレンダラの時間依存だけ。Play 中のゲームシミュレーション(移動/物理/アニメ)は止まらないので、厳密に比べるなら dx12_stop してから撮る。"),
  settleFrames: z.number().int().optional().describe(
    "deterministic:true のとき履歴を捨ててから回すフレーム数(1..240)。既定 8。増やすと TAA / SSGI の収束が進む(決定性そのものは 8 で得られる)。deterministic:false のときは無視される。"),
  gizmos: z.boolean().optional().describe(
    "false でこの 1 枚だけエディタのデバッグ描画を止めて撮る。既定 true(従来どおり)。"
    + "止まるのは【カメラエンティティの視錐台の水色の線 / 選択枠 / ライトやカメラのアイコン / "
    + "物理・ナビメッシュのワイヤ / 床のグリッド】。選択を外しても消えない『アクティブなカメラの視錐台』もこれで消える。"
    + "★戻すための呼び出しは不要。撮影状態と一緒に破棄されるので【次の 1 枚では必ず元どおり】。"
    + "★dx12_screenshot(ポスト前)では deterministic:true のときだけ効く(既定経路は直前フレームの読み戻しなので撮り直さないため)。"),
});

// ── dx12_screenshot_final 専用の引数(Q2 校正): 出力形式と任意解像度 ─────────────────────
// ★線形 HDR(pfm/exr)と任意解像度は最終画(ポスト後のバックバッファ)側の機能。dx12_screenshot(ポスト前)には付けない。
//   都度作る(captureParams と同じ理由: zod インスタンスの共有で JSON Schema が $ref に畳まれるのを避ける)。
const finalOnlyParams = () => ({
  format: z.enum(["png", "pfm", "exr"]).optional().describe(
    "出力形式。png(既定。表示色の 8bit。従来どおり画像で返る) / pfm / exr(★ポスト前の線形 float。トーンマップ前・露出前のシーン参照 Rec.709 RGB。"
    + "パストレーサー dx12_render_reference の PFM/EXR と同じ規約で、tools/parity(FLIP-HDR)がそのまま読める。"
    + "物理ライティング単位(lightingUnits:1)ならシーン値は nit)。pfm/exr のときは画像ブロックではなく JSON(files に形式ごとのパス)で返る。"
    + "path の拡張子は無視され、形式ごとに同じ基準名で書く(a.png → a.pfm)。"),
  formats: z.array(z.enum(["png", "pfm", "exr"])).optional().describe(
    "複数形式を同じフレームで撮る(例 [\"png\",\"pfm\"])。png を含めれば画像ブロックも返る。format と併用可。"),
  width: z.number().int().optional().describe(
    "任意解像度のオフスクリーン出力の幅(height と両方指定)。エディタ/ウィンドウ/16:9 レターボックスと無関係に、シーン系 RT をこのサイズで作って描き出す(撮影後に元へ戻る)。"
    + "1 辺 16〜8192・総画素 8192x4096 まで(pfm/exr は 4096x4096 まで)。GPU メモリ不足は撮影前にエラー。"
    + "エディタのアイコン・ゲーム内 UI 画像・画面全体のカスタムシェーダーは写らない。deterministic:true と併用でき、同じ設定なら同じ画素になる。起動引数 --size WxH が既定。"),
  height: z.number().int().optional().describe("任意解像度のオフスクリーン出力の高さ(width と両方指定)。"),
});

// スクショ単体も画像ブロックで返す。
regRaw(
  "dx12_screenshot",
  {
    title: "スクリーンショット(ポスト前)",
    description: "今シーンビューに映ってる絵を PNG に書き出して画像で返す(+text に path/width/height/source)。"
      + "★★これは【ポストプロセス前の m_sceneRT】。カラーグレーディング(contrast/brightness/saturation/warmth/hueShift/tint)・"
      + "ブルーム・ゴッドレイ・ビネット・LUT・FXAA・デバンド・TAA の解決結果が【1 つも写らない】。"
      + "見た目を判断する / 参照画像と比べる / ポストを触った結果を確かめるなら必ず dx12_screenshot_final を使うこと。"
      + "こちらは『幾何とライティングの素の値』を見たいとき(ポストの化粧を剥がして原因を切り分けたいとき)に使う。"
      + "★Playing 中はアクティブなゲームカメラの絵になる。Editor 中はエディタのフライカメラ。"
      + "dx12_project_world_to_screen と同じカメラなので「player が画面中央/画面内か」を数値+絵の両方で確認できる。",
    inputSchema: { ...captureParams() },
    annotations: { title: "スクリーンショット(ポスト前)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path: outPath, deterministic, settleFrames, gizmos }) => {
    try {
      const shot = await engine.call("screenshot", { path: outPath, deterministic, settleFrames, gizmos });
      if (!shot || !shot.path) throw new Error("screenshot が path を返さなかった");
      return imageResult(shot.path, {
        width: shot.width, height: shot.height,
        source: shot.source ?? "sceneRT(pre-post)",
        deterministic: shot.deterministic ?? false,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ★測定と目視の食い違いを断つ本命。バックバッファ(＝ポスト適用後の最終画)を撮る。
regRaw(
  "dx12_screenshot_final",
  {
    title: "最終画スクリーンショット(ポスト後)",
    description: "★見た目を判断するときの既定の撮り方。バックバッファ(ポスト適用後の最終画)のビューポート矩形を PNG で返す。"
      + "dx12_screenshot(ポスト前の m_sceneRT)と違い、カラーグレーディング・ブルーム・ゴッドレイ・ビネット・LUT・FXAA・デバンド・TAA の解決結果が【全部写る】"
      + "= 人間がビューポートで見ている絵と同じ。ImGui を描く前にコピーするので【エディタのパネル/ギズモは写らない】＝ゲームと同じ絵になる。"
      + "サイズはウィンドウ全体ではなくシーンビューの矩形。"
      + "★遅延同期(1 フレーム描いてから返る。deterministic:true なら settleFrames ぶん回してから返る)。"
      + "★エディタのパネル込みが欲しいなら dx12_ui_screenshot、中間バッファの可視化は dx12_render_debug。"
      + "★Playing 中はアクティブなゲームカメラの絵になる(= 実際のゲーム画面のポスト後)。",
    inputSchema: { ...captureParams(), ...finalOnlyParams() },
    annotations: { title: "最終画スクリーンショット(ポスト後)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path: outPath, deterministic, settleFrames, gizmos, format, formats, width, height }) => {
    try {
      const shot = await engine.call("screenshot_final", { path: outPath, deterministic, settleFrames, gizmos, format, formats, width, height });
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      const meta = {
        width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer",
        postApplied: shot.postApplied,
        deterministic: shot.deterministic ?? false,
        gizmos: shot.gizmos ?? true,
        taa: shot.taa,
        mode: shot.mode,
        note: shot.note,
        ...(shot.files && Object.keys(shot.files).length > 0 ? { files: shot.files } : {}),
        ...(shot.linear ? { linear: shot.linear } : {}),
        ...(shot.offscreen ? { offscreen: true } : {}),
      };
      // png を撮ったときは従来どおり画像ブロック付き。pfm/exr だけのときは JSON(パスと線形 HDR の規約)だけ返す。
      const png: string | undefined = shot.files?.png ?? (String(shot.path).toLowerCase().endsWith(".png") ? shot.path : undefined);
      if (png) return imageResult(png, { path: shot.path, ...meta });
      const linearOnly: ToolResult = { content: [{ type: "text", text: JSON.stringify({ path: shot.path, ...meta }) }] };
      return linearOnly;
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// エディタウィンドウ全体のスクショ(ImGui パネル込み)。ゲーム内 UI / UIエディタの見た目確認用。
regRaw(
  "dx12_ui_screenshot",
  {
    title: "UIスクリーンショット",
    description: "エディタウィンドウ全体(ImGui パネル込み)を PNG で返す。★dx12_screenshot(シーンRT)には写らないゲーム内 UI プレビュー・UIエディタ・インスペクタが写る = AI が組んだ UI の見た目を目で確認して直すのに使う。ウィンドウが最小化中はエラー。レイアウトの数値確認は dx12_ui_tree の方が正確。",
    inputSchema: {},
    annotations: { title: "UIスクリーンショット", openWorldHint: false, readOnlyHint: true },
  },
  async () => {
    try {
      const shot = await engine.call("ui_screenshot", {});
      if (!shot || !shot.path) throw new Error("ui_screenshot が path を返さんかった");
      return imageResult(shot.path, { width: shot.width, height: shot.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── 中間バッファ可視化(「なぜ変に見えるか」の切り分け) ────────────────────
//
// ★mode を zod の enum にしてある。albedo / overdraw は【意図的に非対応】なので、
//   渡されたら errorMap で「なぜ無いか + 代わりに何を見るか」を本文にして弾く
//   (ただ弾くと AI は綴り間違いだと解釈して何度も撃ち直す)。理由の表は sceneTools.ts。
// ★毎回新しい zod インスタンスを作るファクトリにしてある($ref に畳まれるのを避ける流儀)。
const renderDebugModeSchema = () =>
  z.enum(RENDER_DEBUG_MODES as unknown as [string, ...string[]], {
    errorMap: (issue, ctx) => {
      const msg = renderDebugModeIssue((issue as { received?: unknown }).received);
      return { message: msg ?? ctx.defaultError };
    },
  });

regRaw(
  "dx12_render_debug",
  {
    title: "中間バッファ可視化",
    description:
      "レンダラの中間バッファを可視化して PNG 画像で返す。★『絵がなんか変』の原因を切り分けるための唯一の入口。"
      + "frames フレーム描いてから撮影し、【呼ぶ前と完全に同じ設定へ必ず戻す】(一時的に ON にした機能も戻る)。"
      + "可視化はポスト前の m_sceneRT へ描くので dx12_screenshot と違って必ず写る。"
      + "\n■ mode: normal(ワールド法線 0.5+0.5*N。★G-Buffer は幾何法線なので法線マップは載っていない) / "
      + "roughness / metallic(どちらも G-Buffer のスカラー値のみ。ORM テクスチャは載っていない) / "
      + "depth(ビュー空間 Z のヒートマップ。青=近→赤=遠、空は黒。depthRange で正規化) / "
      + "ao(SSAO。白=遮蔽なし) / contactShadow(白=遮蔽なし) / "
      + "velocity(速度バッファ。R=+X G=+画面下。★静止していれば一様な (0.5,0.5,0.5) が正常。gain 20 くらいが見やすい) / "
      + "ssr / ssgi(時間蓄積があるので frames を 8〜16 に) / "
      + "rt(DXR のプライマリレイのヒット距離をヒートマップ。空/ミスは黒。depthRange で正規化。"
      + "RT 影 / RT-AO が OFF でも TLAS を一時的に建てるので TLAS が正しく建つかの目視に使える) / "
      + "rtDiff(★加速構造の検証はこれが本命。|RT のヒット距離 − ラスタの距離| をヒートマップ。"
      + "【黒 = 完全一致】、マゼンタ = 片方だけヒット。行列の転置ミスやノード変換の付け忘れを一発で炙り出す。"
      + "gain を 20 くらいにすると 5cm でフルスケール。スキンドと半透明は TLAS に入らない仕様なのでマゼンタになるのが正常。"
      + "BLAS は LOD0 固定なので遠くて低 LOD の物に数 cm の差が出るのも正常) / "
      + "rtAlbedo(★バインドレスの検証。レイのヒット点のアルベドをそのまま出す。"
      + "ラスタの絵と色が一致すれば InstanceID → GeometryInfo → VB/IB/テクスチャ の配線と"
      + "バリセントリック補間が全部正しい。BLAS は LOD0 固定なので比較は近距離で。"
      + "Dynamic Resources 非対応 GPU では真っ黒。dx12_get_dxr の stats.bindlessReady で確認できる) / "
      + "shadowCascade(CSM のカスケードを赤/緑/青/黄で色分け) / "
      + "lightComplexity(クラスタごとの灯数ヒートマップ。青0→緑→赤、★白=128 灯で切り捨て中) / "
      + "clusterGrid(クラスタ境界の市松) / decalCount(★白=16 枚で切り捨て中) / "
      + "fogScattering・fogTransmittance・fogSlice(ボリュメトリックフォグの散乱/透過率/froxel スライス) / "
      + "off(何も撮らず全部戻すだけ。途中で失敗したときのリセット用)。"
      + "\n■ rt / rtDiff は DXR 非対応 GPU だと【真っ黒になるだけ】でエラーにはならない"
      + "(warnings に理由が出る)。先に dx12_get_dxr で supported を見ておくと空振りしない。"
      + "\n■ normal / roughness / metallic / velocity は【深度+速度プリパスでしか書かれない】ので、"
      + "TAA も SSR も SSGI も OFF のときはエンジンが TAA を一時 ON にして撮る(warnings に出る)。"
      + "この 4 モードが『ジオメトリだけの粗い絵』に見えるのは仕様。"
      + "\n■ 返り値 {path(絶対パス), mode, width, height, toneMapped, warnings:[...], mode_engine}。"
      + "toneMapped:false のモードはトーンマップ/露出を掛けずに 8bit へ落とすので、"
      + "【PNG のピクセル値がそのままバッファの値】として読める。warnings は必ず読むこと"
      + "(「フォグが無効なので何も出ない」等、真っ黒な絵の理由がここに出る)。"
      + "\n■ albedo と overdraw は意図的に非対応(理由つきで弾かれる)。",
    inputSchema: {
      mode: renderDebugModeSchema().describe(
        "可視化する中間バッファ。off は『何も撮らず設定を戻すだけ』。albedo / overdraw は非対応。"),
      frames: z.number().int().min(1).max(120).optional().describe(
        "撮影までに描くフレーム数(1..120、既定 3)。ssr / ssgi は時間蓄積があるので 8〜16 にすると安定する。"),
      gain: z.number().optional().describe(
        "可視化の倍率(既定 1)。velocity は値が小さいので 20 くらいにすると見やすい。"),
      depthRange: z.number().optional().describe(
        "mode:\"depth\" のヒートマップを正規化する距離(m。既定 100)。屋内なら 20、遠景なら 500 等。"),
      exposure: z.number().optional().describe(
        "HDR を出すモード(ssr / ssgi)の露出倍率(既定 1)。真っ黒/真っ白なときに動かす。"),
          path: z.string().optional().describe(
        "保存先の絶対パス(.png)。省略するとエンジンの CWD へ書く。"
        + "★ヘッドレス起動で CWD が書けない場所だと『WIC stream open failed』で撮影ごと失敗するので、"
        + "そのときは必ず指定すること。"),
},
    annotations: { title: "中間バッファ可視化", openWorldHint: false, readOnlyHint: true, idempotentHint: true },
  },
  async ({ mode, frames, gain, depthRange, exposure, path }) => {
    try {
      const r = await engine.call("render_debug", definedOnly({ mode, frames, gain, depthRange, exposure, path }));
      const meta = {
        mode: r?.mode ?? mode,
        width: r?.width, height: r?.height,
        toneMapped: r?.toneMapped,
        warnings: r?.warnings ?? [],
        mode_engine: r?.mode_engine,
      };
      // mode:"off" は撮影しない(エンジンが path:"(no capture)" を返す)。画像が無いので JSON だけ返す。
      const p: unknown = r?.path;
      if (typeof p !== "string" || !fs.existsSync(p)) {
        return { content: [{ type: "text", text: JSON.stringify({ path: p ?? null, ...meta }) }] };
      }
      return imageResult(p, meta);
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// 参照UIスクショ + 現在UI を横並び1枚に合成して返す比較ツール(outputSchema なし = image 結果)。
regRaw(
  "dx12_ui_compare",
  {
    title: "参照UIとの比較",
    description: "参照ゲームのUIスクショ(referencePath)と現在のUI(ui_screenshot)を横並び1枚(左=参照、右=現在、間に区切り線)に合成したPNGで返す。2枚を別々に見るより正確に差分を比較できる。text にピクセル差分率 diffRatio(%) と両画像サイズも返す。grid=true で右側(現在)に8pxグリッド線を薄く重畳(整列・余白の確認用)。★使い方: 合成画像を見て『参照と違う点を3つ』具体的に挙げてから直し、再度このツールで確認するループを回す。1回で寄せきろうとしない。",
    inputSchema: {
      referencePath: z.string().describe("参照UI画像(PNG)の絶対パス。ユーザーから貰った目標スクショ。"),
      grid: z.boolean().optional().describe("true で右側(現在のUI)に8pxグリッド線を薄く重畳。整列確認用。既定 false。"),
    },
    annotations: { title: "参照UIとの比較", openWorldHint: false, readOnlyHint: true },
  },
  async ({ referencePath, grid }) => {
    try {
      const shot = await engine.call("ui_screenshot", {});
      if (!shot || !shot.path) throw new Error("ui_screenshot が path を返さんかった");
      const r = compareUiImages(fs.readFileSync(referencePath), fs.readFileSync(shot.path), { grid });
      const outPath = path.join(os.tmpdir(), `dx12_ui_compare_${Date.now()}.png`);
      fs.writeFileSync(outPath, r.compositePng);
      return imageResult(outPath, { diffRatio: Number(r.diffRatio.toFixed(2)), refSize: r.refSize, curSize: r.curSize });
    } catch (e: any) {
      return errResult(e);
    }
  },
);
