// 品質判断系(look_compare / camera_path / scene_write)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { argError, v3 } from "../sceneTools.ts";
import { compareLook, roundDelta, roundStats } from "../lookCompare.ts";
import os from "node:os";
import { buildContactSheet, type PathMode, planCameraPath } from "../contactSheet.ts";
import { assetsDirFromScenePath, checkScenePath, summarizeScene, validateSceneJson } from "../sceneWrite.ts";
import { convertToV2, dumpSceneV2, inflateScene, isV2, parseSceneTextWithParts, partsDirOf } from "../sceneFormat.ts";
import { engine, errResult, imageResult, jevProjectBaseDir, regRaw, run } from "./core.ts";
import { writeJournalEntry } from "../journalTs.ts";

// ════════════════════════════════════════════════════════════════
//  品質判断系（絵を「見る」だけでなく「測る」ための道具）
// ════════════════════════════════════════════════════════════════
//
// dx12_ui_compare が UI の「形」を横並びで見せる担当なのに対し、ここは
//   ① dx12_look_compare  … 3D の「光」を数値化して参照画像との差を EV / K / 倍率で言う
//   ② dx12_camera_path   … 静止画では分からない時間方向のアラ(ゴースト/ポップ/ちらつき)を拾う
//   ③ dx12_scene_write   … 1 体 1 フレームの spawn を捨ててシーン JSON ごと差し替える
// が担当する。①②は【エンジン側の既存 method の組み合わせだけ】で作ってある(再ビルド不要)。

// ★どちらの絵を測るか。既定は "final"(バックバッファ＝ポスト適用後の最終画)。
//   "sceneRT" は従来どおりポスト前。ポストの化粧を剥がして幾何/ライティングだけ見たいとき用。
//   zod スキーマは毎回新規インスタンスを作る($ref 回避の流儀)。
const CAPTURE_SOURCES = ["final", "sceneRT"] as const;
type CaptureSource = (typeof CAPTURE_SOURCES)[number];
const captureSourceSchema = () =>
  z.enum(CAPTURE_SOURCES).optional().describe(
    "測る絵をどちらから撮るか。'final'(既定)=バックバッファ(ポスト適用後の最終画。人間が見ている絵と同一。"
    + "グレーディング/ブルーム/ビネット/LUT/FXAA/TAA 解決が全部乗る) / "
    + "'sceneRT'=ポスト前のシーン RT(ポストの化粧を剥がして幾何とライティングの素の値だけ見たいとき)。");

// エンジンの screenshot / screenshot_final は path 省略時、毎回 CWD の同じファイルへ上書きする。
// 連写するときは【次の撮影前に】必ず読み切ること(下の撮影ヘルパは即 readFileSync している)。
//
// ★settleFrames について:
//   sceneRT 側は step_frames で先に進めてから撮る(従来どおり)。final 側も同じ扱いにする。
//   engine の {deterministic:true, settleFrames} は「履歴を捨ててから固定 N フレーム」なので
//   意味が違う(ピクセル完全再現用)。ここでは「収束を待つ」だけが欲しいので step_frames を使う。
async function captureScene(
  settleFrames?: number, source: CaptureSource = "final",
): Promise<{ buf: Buffer; width: number; height: number; source: string; postApplied?: boolean }> {
  if (settleFrames && settleFrames > 0) await engine.call("step_frames", { frames: settleFrames });
  const method = source === "sceneRT" ? "screenshot" : "screenshot_final";
  const shot = await engine.call(method, {});
  if (!shot || !shot.path) throw new Error(`${method} が path を返さなかった`);
  return {
    buf: fs.readFileSync(shot.path), width: shot.width, height: shot.height,
    source: shot.source ?? (source === "sceneRT" ? "sceneRT(pre-post)" : "backbuffer"),
    postApplied: shot.postApplied,
  };
}

function readReference(referencePath: string): Buffer {
  if (!fs.existsSync(referencePath)) {
    throw argError(
      `参照画像が見つからない: ${referencePath}`,
      "referencePath は【絶対パス】の PNG。ユーザーから貰った実写写真や参考ゲームのスクショを指す",
    );
  }
  return fs.readFileSync(referencePath);
}

// ── ① 参照画像との「絵づくり」比較（測光つき）─────────────────
regRaw(
  "dx12_look_compare",
  {
    title: "参照画像との絵づくり比較(測光)",
    description:
      "参照画像(実写写真 / 参考ゲームのスクショ)と現在のシーンビューを横並び 1 枚に合成し、"
      + "★さらに『どのノブをどっちへ何倍動かせばいいか』を数値で返す。リアル系ライティングを詰める本体はこれ。"
      + "返す数値: 対数輝度ヒストグラム(既定 24 ビン)とその EMD、平均/中央輝度、コントラスト(対数輝度の標準偏差と P5–P95)、"
      + "相関色温度 CCT(McCamy 近似)、平均彩度(HSV S と CIELAB C*)、黒潰れ率 / 白飛び率。"
      + "suggestions に『参照より平均輝度が -0.8EV 暗い → 太陽の intensity を ×1.74』の形で具体的な次の一手が入る。"
      + "★使い方: suggestions のとおりノブを 1 つだけ動かして撮り直す、を繰り返す(同時に触ると何が効いたか分からない)。"
      + "★★測っているのは既定で dx12_screenshot_final(バックバッファ＝ポスト適用後の最終画)なので、"
      + "ライト・環境光・材質・IBL・影・SSAO に加えて post のグレーディング(contrast/saturation/warmth/tint)・"
      + "ブルーム・ビネット・LUT・FXAA・TAA 解決まで【全部反映される】= 人間が見ている絵と同じものを測る。"
      + "source:'sceneRT' にするとポスト前のシーン RT を測る(ポストの化粧を剥がして幾何とライティングだけ見たいとき。"
      + "そのときはポストのノブが数値に効かないので suggestions に但し書きが付く)。"
      + "position/target を渡すとその視点へカメラを動かしてから撮る(★Play 中も可。撮影後もカメラは固定されたままなので、"
      + "ゲームカメラへ返すには dx12_set_editor_camera {release:true})。",
    inputSchema: {
      referencePath: z.string().describe("参照画像(PNG)の絶対パス。実写写真や参考ゲームのスクショ。"),
      source: captureSourceSchema(),
      position: v3().optional().describe("撮影カメラ位置 [x,y,z]。省略で現在のカメラのまま。"),
      target: v3().optional().describe("注視点 [x,y,z]。position と併用。"),
      gameView: z.boolean().optional().describe(
        "true でアクティブな CameraComponent(ゲームカメラ)視点で撮る。position/target は無視。"
        + "★これは screenshot_game_view = 常に【ポスト前】のシーン RT なので source は無視され、ポストのノブは測れない。"
        + "ポスト込みのゲーム画面を測りたいなら dx12_play してから gameView なしで呼ぶこと(Playing 中の最終画はゲームカメラの絵そのもの)。"),
      settleFrames: z.number().int().optional().describe("撮る前に進めるフレーム数(0..60)。TAA / 露出順応を収束させたい時に 4〜8。既定 0。"),
      bins: z.number().int().optional().describe("対数輝度ヒストグラムのビン数(8..64)。既定 24。"),
      minEV: z.number().optional().describe("ヒストグラム下限 EV。既定 -10(相対輝度 2^-10)。"),
      maxEV: z.number().optional().describe("ヒストグラム上限 EV。既定 0(相対輝度 1.0 = 白)。"),
      blackLevel: z.number().int().optional().describe("黒潰れ判定の luma 閾値(sRGB 0..255、以下を潰れと数える)。既定 4。"),
      whiteLevel: z.number().int().optional().describe("白飛び判定の luma 閾値(sRGB 0..255、以上を飛びと数える)。既定 250。"),
      diffThreshold: z.number().optional().describe("画素差分率の RGB 距離閾値。既定 30(dx12_ui_compare と同じ)。"),
    },
    annotations: { title: "参照画像との絵づくり比較(測光)", openWorldHint: false, readOnlyHint: true },
  },
  async ({ referencePath, source, position, target, gameView, settleFrames, bins, minEV, maxEV, blackLevel, whiteLevel, diffThreshold }) => {
    try {
      const ref = readReference(referencePath);
      // ★gameView(screenshot_game_view)だけは常にポスト前のシーン RT。エンジンに
      //   「ゲームカメラ視点のバックバッファ」を撮る method が無いため、ここは source を無視する。
      const src: CaptureSource = gameView ? "sceneRT" : ((source as CaptureSource | undefined) ?? "final");
      const postVisible = src === "final";
      let cur: Buffer;
      let measuredOn: string;
      if (gameView) {
        if (settleFrames && settleFrames > 0) await engine.call("step_frames", { frames: settleFrames });
        const shot = await engine.call("screenshot_game_view", {});
        if (!shot || !shot.path) throw new Error("screenshot_game_view が path を返さなかった");
        cur = fs.readFileSync(shot.path);
        measuredOn = "screenshot_game_view(ゲームカメラ視点のシーン RT。★ポスト前)";
      } else {
        if (position) await engine.call("set_editor_camera", { position, target });
        const shot = await captureScene(settleFrames, src);
        cur = shot.buf;
        measuredOn = postVisible
          ? `screenshot_final(バックバッファ = ポスト適用後の最終画。postApplied=${shot.postApplied})`
          : "screenshot(シーン RT を CPU で 露出→トーンマップ→ガンマ した絵。★ポスト前)";
      }

      const r = compareLook(ref, cur, { bins, minEV, maxEV, blackLevel, whiteLevel, diffThreshold, postVisible });
      const outPath = path.join(os.tmpdir(), `dx12_look_compare_${Date.now()}.png`);
      fs.writeFileSync(outPath, r.compositePng);
      return imageResult(outPath, {
        diffRatio: Number(r.diffRatio.toFixed(2)),
        reference: roundStats(r.reference),
        current: roundStats(r.current),
        delta: roundDelta(r.delta),
        suggestions: r.suggestions,
        cctFormula: "McCamy 1992: n=(x-0.3320)/(0.1858-y), CCT=449n^3+3525n^2+6823.3n+5520.33"
          + "（黒体軌跡からの距離 Duv > 0.05 なら CCT は null。理由は cctNote）",
        measuredOn,
        notReflected: postVisible
          ? null   // 最終画なので「映らないもの」は無い(ImGui のパネル/ギズモだけ)
          : "post のグレーディング(contrast/brightness/saturation/warmth/hueShift/tint)・"
            + "ブルーム・ビネット・グレインはこの絵に映らない。測りながら追い込むなら source:'final' で呼び直すこと。",
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── ② カメラを動かして連写 → コンタクトシート ────────────────
regRaw(
  "dx12_camera_path",
  {
    title: "カメラを動かして連写(コンタクトシート)",
    description:
      "カメラを経路に沿って動かしながら N 枚撮り、格子状の 1 枚(コンタクトシート)にして返す。"
      + "★静止画 1 枚では TAA のゴースト・LOD ポップ・影のちらつき・カリング抜けが分からない。動かして初めて出る。"
      + "★★撮るのは既定で dx12_screenshot_final(バックバッファ)。TAA の【解決結果】はポスト前のシーン RT には出ないので、"
      + "ゴーストを探すならこちらでないと見えない。source:'sceneRT' でポスト前に切り替えられる"
      + "(ゴーストがポストのせいか本体のせいかを切り分けたいとき)。"
      + "各タイルに『何枚目/全体』を焼き込み、連続フレーム間の画素差分率 frameDiffs(%) も返すので、"
      + "『4→5 だけ差分 18%』のように目で探す前に当たりを付けられる(周りが 3% 前後なのに 1 箇所だけ跳ねていたらポップかちらつき)。"
      + "mode:'line' は from → to を直線補間、mode:'orbit' は target を中心に radius/height の円周を回る。"
      + "★Play 中も使える(dx12_set_editor_camera が Play 中のカメラを固定できるようになったため)。"
      + "撮り終わったら元のカメラへ戻す(restore:false で戻さない)。Play 中に使った後は dx12_set_editor_camera {release:true} でゲームカメラへ返すこと。",
    inputSchema: {
      mode: z.enum(["line", "orbit"]).optional().describe("'line'=直線移動(既定) / 'orbit'=注視点まわりを周回。"),
      source: captureSourceSchema(),
      frames: z.number().int().optional().describe("撮影枚数(2..24)。既定 6。多いほど遅い(1 枚につき 2 往復 + 1 フレーム)。"),
      columns: z.number().int().optional().describe("格子の列数(1..8)。既定 3。"),
      from: v3().optional().describe("line: 始点カメラ位置 [x,y,z]。"),
      to: v3().optional().describe("line: 終点カメラ位置 [x,y,z]。"),
      fromTarget: v3().optional().describe("line: 始点の注視点。省略時は target を使う。"),
      toTarget: v3().optional().describe("line: 終点の注視点。省略時は target を使う。"),
      target: v3().optional().describe("共通の注視点。line では固定注視点、orbit では周回の中心(必須)。dx12_get_bounds の center が使える。"),
      radius: z.number().optional().describe("orbit: 中心からの水平距離(必須、> 0)。被写体の大きさは dx12_get_bounds で測る。"),
      height: z.number().optional().describe("orbit: 中心からの高さオフセット。既定 0。見下ろしたいなら +。"),
      startAngleDeg: z.number().optional().describe("orbit: 開始方位角(度)。+Z が 0°、+X が 90°(dx12_set_sun の azimuth と同じ)。既定 0。"),
      endAngleDeg: z.number().optional().describe("orbit: 終了方位角(度)。既定 360(1 周。全周時は終端が始端と重ならないよう自動で詰める)。"),
      settleFrames: z.number().int().optional().describe("各カットで撮る前に進めるフレーム数(0..60)。既定 0(★TAA のゴーストを見たいなら 0 のまま)。"),
      tileWidth: z.number().int().optional().describe("タイル 1 枚の幅 px。既定 min(元画像幅, 480)。"),
      diffThreshold: z.number().optional().describe("連続フレーム差分の RGB 距離閾値。既定 30。"),
      restore: z.boolean().optional().describe("false で撮影後にカメラを元へ戻さない。既定 true。"),
    },
    annotations: { title: "カメラを動かして連写(コンタクトシート)", openWorldHint: false, idempotentHint: true },
  },
  async (a) => {
    try {
      const poses = planCameraPath({
        mode: a.mode as PathMode | undefined,
        frames: a.frames,
        from: a.from, to: a.to, fromTarget: a.fromTarget, toTarget: a.toTarget,
        target: a.target, radius: a.radius, height: a.height,
        startAngleDeg: a.startAngleDeg, endAngleDeg: a.endAngleDeg,
      });

      const settle = Math.max(0, Math.min(60, Math.round(a.settleFrames ?? 0)));
      const restore = a.restore !== false;
      // 元のカメラを覚えておく(撮影は「見に行く」操作なので、勝手に視点を変えたまま返さない)。
      const before = restore ? await engine.call("get_editor_camera", {}).catch(() => null) : null;

      const src: CaptureSource = (a.source as CaptureSource | undefined) ?? "final";
      const shots: Buffer[] = [];
      let measuredOn = "";
      for (const p of poses) {
        await engine.call("set_editor_camera", { position: p.position, target: p.target });
        const shot = await captureScene(settle, src);   // ★次の撮影で上書きされる前に読み切る
        measuredOn = shot.source;
        shots.push(shot.buf);
      }

      if (before && before.position) {
        await engine.call("set_editor_camera", {
          position: before.position, yawDeg: before.yawDeg, pitchDeg: before.pitchDeg,
        }).catch(() => { /* 戻せなくても撮影結果は返す */ });
      }
      // Play 中に set_editor_camera を撃つとゲームカメラの追従が止まる(override)。
      // 上の復元自体が override を立て直すので、最後に必ず返す。
      // 忘れるとカメラが最後のポーズに固定され「ゲームが何も映さない」になる。
      if (before && before.overridden === false) {
        await engine.call("set_editor_camera", { release: true })
          .catch(() => { /* 返せなくても撮影結果は返す */ });
      }

      const sheet = buildContactSheet(shots, {
        columns: a.columns, tileWidth: a.tileWidth, diffThreshold: a.diffThreshold,
      });
      const outPath = path.join(os.tmpdir(), `dx12_camera_path_${Date.now()}.png`);
      fs.writeFileSync(outPath, sheet.sheetPng);
      return imageResult(outPath, {
        mode: a.mode ?? "line",
        source: src,
        measuredOn,
        frames: shots.length,
        columns: sheet.columns,
        rows: sheet.rows,
        tile: sheet.tile,
        frameDiffs: sheet.frameDiffs,
        maxDiff: sheet.maxDiff,
        poses: poses.map((p) => ({ position: p.position.map((v) => Number(v.toFixed(3))), target: p.target })),
        note: "frameDiffs[i] は フレーム i+1 → i+2 の画素差分率(%)。カメラ移動量に比例するので、"
            + "周囲より突出した山だけがちらつき/ポップの候補。"
            + (src === "final"
                ? "★最終画(ポスト後)で撮っているので TAA の解決結果・グレーディング・ブルームも差分に乗る。"
                  + "デバンドのディザ/グレインは ±1〜2 LSB なので既定の閾値 30 では拾わない。"
                : "★ポスト前のシーン RT で撮っているので TAA の解決結果は差分に出ない。"),
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// ── ③ シーン JSON の直接書き出し ─────────────────────────────
// assets ディレクトリは【エンジンが dx12_ping で返す】(protocolVersion 4 以降。
// PathResolver::AssetsDir をそのまま載せている)。引数 → 環境変数 → ping の順で解決する。
//
// ★以前はここで get_log を 500 行引いて「ログに混ざる絶対パスから assets らしき祖先を推定し、
//   list_scenes の相対パスが実在するかで裏取りする」という回避コードを持っていた(#20-3)。
//   別プロジェクトの古いログを掴む・ログが流れていると失敗する・裏取りできない時は
//   当てずっぽうを返す、という三重に不確かなものだった。エンジンが正を返すようになったので削除。
async function resolveAssetsDir(explicit?: string): Promise<{ dir: string; how: string }> {
  const ok = (d: string) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
  const norm = (d: string) => d.replace(/\\/g, "/").replace(/\/+$/, "");

  if (explicit) {
    const d = norm(explicit);
    if (!ok(d)) throw argError(`assetsDir が存在しない: ${explicit}`, "プロジェクトの assets フォルダの絶対パスを渡す");
    return { dir: d, how: "引数 assetsDir" };
  }
  const env = process.env.DX12_ASSETS_DIR;
  if (env && ok(norm(env))) return { dir: norm(env), how: "環境変数 DX12_ASSETS_DIR" };

  // エンジンに聞く(唯一の正)。protocolVersion 4 未満のエンジンは assetsDir を返さない。
  const pong = await engine.call("ping", {}).catch(() => null);
  const fromEngine = typeof pong?.assetsDir === "string" ? norm(pong.assetsDir) : "";
  if (fromEngine && ok(fromEngine)) return { dir: fromEngine, how: "dx12_ping の assetsDir(エンジンが返す正)" };

  throw argError(
    fromEngine
      ? `エンジンが返した assetsDir が存在しない: ${fromEngine}`
      : "assets ディレクトリを特定できなかった"
        + (pong ? `(エンジンの protocolVersion=${pong.protocolVersion ?? "不明"}。4 未満は assetsDir を返さない)` : "(エンジンに繋がらない)"),
    "assetsDir にプロジェクトの assets フォルダの絶対パス(例 C:/Users/me/game/MyGame/assets)を渡すか、"
    + "path 自体を絶対パスで渡す。環境変数 DX12_ASSETS_DIR でも指定できる",
  );
}

regRaw(
  "dx12_scene_write",
  {
    title: "シーンJSONを直接書き出す",
    description:
      "シーン JSON をファイルへ直接書く。★MCP で 1 体ずつ spawn すると【1 体につき 1 フレーム】かかる(遅延同期)ため、"
      + "数十体以上を一気に並べるならこちらが桁違いに速い。書いた後 open:true で dx12_open_scene まで一気にやれる。"
      + "★書く前に検証する: entities 配列の有無、name / transform / parent(=配列インデックス)の型、"
      + "primitive の値、meshRenderer.modelPath と luaScript.scriptPath の【実在確認】(dx12_list_assets 突き合わせ)、"
      + "親子の循環、そして『エンジンが無言で無視するキー名の打ち間違い』(例 meshrenderer / rotate)。"
      + "エラーが 1 つでもあれば書かずに理由を全部返す(壊れた JSON を黙って置かない)。"
      + "既存ファイルを上書きする場合は必ず先に読んで、上書き前のエンティティ数などの要約 replaced と、"
      + "%TEMP% に取ったバックアップ backupPath を返す(何を壊したか分かるように)。"
      + "スキーマは src/scene/SceneSerializer.cpp と同じ: "
      + "{version:1, entities:[{name, transform:{position,rotation,scale}, parent?:<配列index>, "
      + "primitive?:'box'|'sphere'|'plane' | meshRenderer:{modelPath}, color?:[r,g,b], material?:{metallic,roughness}, "
      + "pointLight?/directionalLight?/spotLight?/camera?/rigidBody?/boxCollider?/luaScript?:{scriptPath,props}, tags?:[...]}], "
      + "postProcess?, skybox?, ssao?, shadows?}",
    inputSchema: {
      path: z.string().describe("書き出し先。assets 相対(推奨、例 'scenes/level1.json')か絶対パス。dx12_open_scene が開けるのは assets 配下の .json だけ。"),
      sceneJson: z.union([z.record(z.any()), z.string()]).describe("シーン JSON 本体(オブジェクト、または その JSON 文字列)。{version:1, entities:[...]}"),
      assetsDir: z.string().optional().describe("assets フォルダの絶対パス。省略時は 環境変数 DX12_ASSETS_DIR → dx12_ping の assetsDir(エンジンが返す正) の順で自動解決する。"),
      open: z.boolean().optional().describe("true で書いた後に dx12_open_scene して読み込む(★Editor 限定)。既定 false。"),
      overwrite: z.boolean().optional().describe("false にすると既存ファイルがある場合に書かずにエラー。既定 true(上書きするが要約とバックアップを返す)。"),
      skipAssetCheck: z.boolean().optional().describe("true で modelPath/scriptPath の実在確認を省く(これから import するアセットを先に書く時)。既定 false。"),
      force: z.boolean().optional().describe("true で検証エラーがあっても書く。★壊れたシーンができるので通常は使わない(エラーは返り値に残る)。既定 false。"),
    },
    annotations: { title: "シーンJSONを直接書き出す", openWorldHint: false, destructiveHint: true },
  },
  async ({ path: outPath, sceneJson, assetsDir, open, overwrite, skipAssetCheck, force }) =>
    run(async () => {
      // 1) JSON 本体を確定(文字列なら parse。ここで壊れていたら位置つきで返す)
      let root: unknown;
      if (typeof sceneJson === "string") {
        try {
          root = JSON.parse(sceneJson);
        } catch (e: any) {
          throw argError(`sceneJson が JSON として読めない: ${e.message}`, "オブジェクトのまま渡すのが確実");
        }
      } else {
        root = sceneJson;
      }

      // 2) 書き出し先の絶対パスと assets 相対パスを決める
      const isAbs = path.isAbsolute(outPath) || /^[A-Za-z]:[\\/]/.test(outPath);
      let absPath: string;
      let dir: string;
      let how: string;
      let relPath: string | null;
      if (isAbs) {
        absPath = path.resolve(outPath).replace(/\\/g, "/");
        const derived = assetsDirFromScenePath(absPath);
        if (assetsDir || !derived) {
          const r = await resolveAssetsDir(assetsDir);
          dir = r.dir; how = r.how;
        } else {
          dir = derived; how = "path から推定(.../assets/ を検出)";
        }
        const rel = path.relative(dir, absPath).replace(/\\/g, "/");
        relPath = rel.startsWith("..") ? null : rel;
      } else {
        const chk = checkScenePath(outPath.replace(/\\/g, "/"));
        if (!chk.ok) throw argError(chk.error!, "assets 相対の .json パスにする(例 'scenes/level1.json')");
        const r = await resolveAssetsDir(assetsDir);
        dir = r.dir; how = r.how;
        relPath = outPath.replace(/\\/g, "/");
        absPath = path.join(dir, relPath).replace(/\\/g, "/");
      }
      if (open && !relPath) {
        throw argError(
          `open:true だが ${absPath} は assets(${dir}) の外にある`,
          "dx12_open_scene は assets 相対パスしか受けない。assets 配下へ書くか open:false にする",
        );
      }

      // 3) 検証(参照アセットはエンジンの list_assets と突き合わせる)
      let knownAssets: string[] | undefined;
      if (!skipAssetCheck) {
        const list = await engine.call("list_assets", {}).catch(() => null);
        if (Array.isArray(list)) knownAssets = list.map((a: any) => String(a?.path ?? "")).filter(Boolean);
      }
      const validation = validateSceneJson(root, { knownAssets });
      if (!validation.ok && !force) {
        const e: any = new Error(
          `シーン JSON の検証で ${validation.errors.length} 件のエラー。書き込みは行っていない。\n`
          + validation.errors.map((s) => `  - ${s}`).join("\n")
          + (validation.warnings.length > 0
            ? `\n警告 ${validation.warnings.length} 件:\n` + validation.warnings.slice(0, 20).map((s) => `  - ${s}`).join("\n")
            : ""),
        );
        e.code = 2;   // INVALID_PARAM
        e.hint = "上のエラーを直してから撃ち直す。どうしても先に書きたい場合だけ force:true(壊れたシーンになる)";
        throw e;
      }

      // 4) 既存ファイルの要約とバックアップ(何を壊すのかを必ず言う)
      let replaced: Record<string, unknown> | null = null;
      let prevBuf: Buffer | null = null;
      if (fs.existsSync(absPath)) {
        if (overwrite === false) {
          throw argError(
            `${absPath} は既に存在する(overwrite:false)`,
            "上書きしてよいなら overwrite を省く(既定 true)。別名で書くなら path を変える",
          );
        }
        prevBuf = fs.readFileSync(absPath);
        const prevText = prevBuf.toString("utf8");
        const backupPath = path.join(os.tmpdir(), `dx12_scene_backup_${Date.now()}_${path.basename(absPath)}`);
        fs.writeFileSync(backupPath, prevText);
        let prevSummary: unknown = null;
        let parseError: string | null = null;
        // v2 は既定値を省略している。補完してから数える（コンポーネントの有無はキーで分かるが、他の読み手と流儀を揃える）
        // 分割保存のシーン（foo.json + foo.parts/）はセルファイルもつなげて数える（§4.3）
        try { prevSummary = summarizeScene(inflateScene(parseSceneTextWithParts(prevText, absPath))); }
        catch (e: any) { parseError = e.message; }
        replaced = {
          bytes: Buffer.byteLength(prevText),
          backupPath,
          summary: prevSummary,
          parseError,
          note: "上書き前の内容。バックアップは %TEMP% に置いた(assets を汚さないため)",
        };
      }

      // 4.5) ファイル書き込みジャーナル(M5): 上書き前の内容(新規なら「無かった」)を <project>/.dx12/journal/ に退避する。
      //      エンジンの journal_restore で戻せる。プロジェクトが分からない(エンジンに繋がらない)ときは退避しない。
      let journal: { id: string; restore: unknown } | { skipped: string } | null = null;
      {
        const baseDir = await jevProjectBaseDir();
        if (baseDir) {
          const je = writeJournalEntry(baseDir, "scene_write", `dx12_scene_write ${relPath ?? path.basename(absPath)}`, [{ absPath, prev: prevBuf }]);
          journal = je ? { id: je.id, restore: { tool: "dx12_call", args: { name: "journal_restore", args: { id: je.id } }, why: "この書き込みの前の状態へファイルを戻す(新規作成なら削除)" } } : { skipped: "ジャーナルを書けなかった" };
        } else journal = { skipped: "エンジンに繋がらずプロジェクトが分からない" };
      }

      // 5) 書き出し。version >= 2 で渡されたものは v2 の整形（ルート設定は 2 スペース・entities は 1 行 1 体・最短 float）で書く。
      //    v1（version 無し / 1）は従来どおり 2 スペースインデント。★v1 を勝手に v2 へ変換しない:
      //    v1 の欠けたフィールドは構造体の既定、v2 では表の既定（rigidBody は静的）になり意味が変わるため。
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const text = isV2(root) ? dumpSceneV2(convertToV2(root as Record<string, any>)) : JSON.stringify(root, null, 2);
      fs.writeFileSync(absPath, text, "utf8");

      // 5.5) 分割保存だったシーンを 1 ファイルで書き直した場合: 古い foo.parts/ のセルファイルは読まれない残骸になる
      //      （エンジンは foo.json に "parts" が無ければセルを読まない。次にエンジンが保存すると片付く）。
      let orphanParts: { dir: string; files: number; note: string } | null = null;
      if (!(root && typeof root === "object" && !Array.isArray(root) && "parts" in (root as object))) {
        const pdir = partsDirOf(absPath);
        if (fs.existsSync(pdir)) {
          const n = fs.readdirSync(pdir).filter((f) => /^cell_.*\.json$/.test(f)).length;
          if (n > 0) orphanParts = { dir: pdir.replace(/\\/g, "/"), files: n, note: "このシーンは分割保存だった。今回は 1 ファイルで書いたので、古いセルファイルは読まれない(エンジンで開いて保存し直すと消える)。分割で保つなら partition:{cellSize} を付けてエンジンで保存する" };
        }
      }

      // 6) 任意で開く
      let opened: unknown = null;
      if (open && relPath) opened = await engine.call("open_scene", { path: relPath });

      return {
        path: relPath, absolutePath: absPath, assetsDir: dir, assetsDirResolvedBy: how,
        bytes: Buffer.byteLength(text),
        wrote: validation.summary,
        replaced,
        journal,
        ...(orphanParts ? { orphanParts } : {}),
        validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
        opened,
        nextStep: open
          ? "dx12_screenshot / dx12_look_compare で絵を確認する"
          : `読み込むには dx12_open_scene path:"${relPath ?? "(assets 外)"}"`,
      };
    }),
);
