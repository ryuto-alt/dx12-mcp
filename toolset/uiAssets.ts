// UI 素材(フォント導入)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { downloadFont } from "../uiAssets.ts";
import path from "node:path";
import { definedOnly } from "../paramGuard.ts";
import { v3 } from "../sceneTools.ts";
import { engine, entityId, errResult, imageResult, reg, regRaw, run } from "./core.ts";

// ── UI 素材(フォント導入) ──────────────────────────────────────
reg(
  "dx12_install_font",
  "Google Fonts からフォント導入",
  "Google Fonts からフォント(.ttf)をダウンロードして現在のプロジェクトの assets/fonts/ へ取り込む。返る fontPath を uiText.fontPath に設定して使う(例: dx12_set_component で uiText:{fontPath:'fonts/NotoSansJP-700.ttf'})。★日本語を表示する UI には日本語対応フォント(Noto Sans JP / M PLUS Rounded 1c / Zen Kaku Gothic New 等)を選ぶこと — Roboto 等の欧文フォントでは日本語が豆腐(□)になる。family は Google Fonts のファミリー名そのまま(スペース含む)。{fontPath, family, weight} が返る。",
  {
    family: z.string().describe("Google Fonts のファミリー名。例: 'Noto Sans JP', 'Roboto', 'Bebas Neue'"),
    weight: z.number().int().optional().describe("ウェイト(100–900)。省略時は 400。太字見出しは 700 推奨。"),
  },
  {},
  ({ family, weight }) =>
    run(async () => {
      const { tmpPath, fileName } = await downloadFont(family, weight);
      await engine.call("import_asset", { sourcePath: tmpPath, destPath: `fonts/${fileName}`, overwrite: true });
      return { fontPath: `fonts/${fileName}`, family, weight: weight ?? 400 };
    }),
);

// ゲームカメラ視点のスクショ。アクティブな CameraComponent でシーンを1フレーム描いて撮る。
// Editor 中でも Play せずにゲームカメラの画角を確認できる(Playing 中は通常 screenshot と同じ絵)。
regRaw(
  "dx12_screenshot_game_view",
  {
    title: "ゲーム画面スクショ",
    description: "アクティブな CameraComponent(ゲームカメラ)視点でシーンを1フレーム描画して PNG で返す。★Editor 中でも Play せずにゲームカメラの見え方(画角・構図)を確認できる。アクティブなカメラが無いとエラー(camera.isActive=true にする)。image ブロック + text(path/サイズ/mode)を返す。",
    inputSchema: {
      path: z.string().optional().describe(
        "保存先の絶対パス(.png)。省略するとエンジンの CWD へ書く。"
        + "★ヘッドレス起動で CWD が書けない場所だと撮影ごと失敗するので、そのときは指定すること。"),
    },
    annotations: { title: "ゲーム画面スクショ", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path }) => {
    try {
      const shot = await engine.call("screenshot_game_view", definedOnly({ path }));
      if (!shot || !shot.path) throw new Error("screenshot_game_view が path を返さんかった");
      return imageResult(shot.path, { width: shot.width, height: shot.height, mode: shot.mode });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// 任意視点スクショ(set_editor_camera → 次フレームで screenshot)。俯瞰/引きの構図を一発で。
regRaw(
  "dx12_screenshot_from",
  {
    title: "任意視点スクショ",
    description: "カメラを指定の位置・注視点へ動かしてからスクショを撮り、PNG 画像で返す(dx12_set_editor_camera + dx12_screenshot_final の合成)。俯瞰でレイアウト全体を見る、プレイヤー視点の高さで見る等。"
      + "★撮るのは【ポスト適用後の最終画】なのでグレーディング/ブルーム/TAA 込みの見た目が確認できる。"
      + "★Play 中も使える(カメラを固定して撮る。dx12_set_editor_camera {release:true} でゲームカメラへ返す)。image ブロック + text(path/サイズ)を返す。",
    inputSchema: {
      position: v3().describe("カメラ位置 [x,y,z]。"),
      target: v3().optional().describe("注視点 [x,y,z]。省略で現在の向きのまま位置だけ移動。"),
      gizmos: z.boolean().optional().describe(
        "false でこの 1 枚だけエディタのデバッグ描画(カメラの視錐台の水色の線 / 選択枠 / アイコン / "
        + "物理・ナビのワイヤ / 床グリッド)を止めて撮る。既定 true。構図や質感を評価する絵、AI に見せる絵はこれを false にする。"
        + "★戻す呼び出しは不要 ── 次の 1 枚では必ず元どおり。"),
    },
    annotations: { title: "任意視点スクショ", openWorldHint: false, idempotentHint: true },
  },
  async ({ position, target, gizmos }) => {
    try {
      await engine.call("set_editor_camera", { position, target });
      const shot = await engine.call("screenshot_final", { gizmos });
      if (!shot || !shot.path) throw new Error("screenshot_final が path を返さなかった");
      return imageResult(shot.path, {
        position, target, width: shot.width, height: shot.height,
        source: shot.source ?? "backbuffer", postApplied: shot.postApplied,
        gizmos: shot.gizmos ?? true,
      });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// テクスチャを画像として見る(エンジンが dds/tga 含め PNG へ変換 → 画像ブロックで返す)。
regRaw(
  "dx12_view_texture",
  {
    title: "テクスチャを見る",
    description: "assets 内のテクスチャ(png/jpg/dds/tga/bmp/hdr)を PNG に変換して画像で返す。割り当てる前に絵柄を目で確認するのに使う。長辺 maxSize(既定 1024)超は縮小。キューブマップは先頭面のみ。image ブロック + text(元パス/サイズ)を返す。",
    inputSchema: {
      path: z.string().describe("assets 相対パス。例: textures/rust.png"),
      maxSize: z.number().int().optional().describe("返す画像の長辺上限 px(16..4096)。既定 1024。"),
    },
    annotations: { title: "テクスチャを見る", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path, maxSize }) => {
    try {
      const r = await engine.call("read_texture", { path, maxSize });
      if (!r || !r.path) throw new Error("read_texture が path を返さんかった");
      return imageResult(r.path, { sourcePath: r.sourcePath, width: r.width, height: r.height });
    } catch (e: any) {
      return errResult(e);
    }
  },
);

// モデルのプレビュー(一時 spawn → 寄せて撮影 → 削除)。spawn する価値があるか見た目で判断する用。
regRaw(
  "dx12_preview_model",
  {
    title: "モデルプレビュー",
    description: "モデルを一時的にシーン外(遠方)へ spawn して撮影し、すぐ削除して PNG で返す(spawn_model → focus_and_screenshot → delete_entity の合成)。アセットの見た目を配置前に確認するのに使う。★Editor 限定。シーンは変更されない(一時エンティティは必ず削除される)。image ブロック + text(path/サイズ)を返す。",
    inputSchema: {
      path: z.string().describe("モデルの assets 相対パス(.gltf/.glb/.fbx/.obj)。"),
    },
    annotations: { title: "モデルプレビュー", openWorldHint: false, readOnlyHint: true },
  },
  async ({ path }) => {
    let previewId: number | null = null;
    try {
      const created = await engine.call("spawn_model",
        { path, name: "__mcp_preview__", position: [0, -10000, 0] });
      previewId = created?.entityId;
      await engine.call("focus_camera", { entity: previewId });
      const shot = await engine.call("screenshot", {});
      if (!shot || !shot.path) throw new Error("screenshot が path を返さんかった");
      const img = imageResult(shot.path, { model: path, width: shot.width, height: shot.height });
      await engine.call("delete_entity", { entity: previewId });
      previewId = null;
      return img;
    } catch (e: any) {
      // 撮影に失敗しても一時エンティティは残さない
      if (previewId != null) { try { await engine.call("delete_entity", { entity: previewId }); } catch {} }
      return errResult(e);
    }
  },
);
