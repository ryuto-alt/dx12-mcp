// アセット操作(import / メタ情報 / 移動 / 削除)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import path from "node:path";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  アセット操作(import / メタ情報 / 移動 / 削除)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_import_asset",
  "外部アセット取り込み",
  "assets の外にあるファイル/フォルダをプロジェクトの assets/ へコピーする(ダウンロードした素材や /asset コマンドの出力の取り込み用)。sourcePath は絶対パス可(唯一 assets 外を読むツール)、destPath は assets 相対。フォルダを渡すと再帰コピー。★.gltf は同階層の .bin/テクスチャを参照するのでフォルダごと import すること。{imported:[相対パス...], count} が返る。",
  {
    sourcePath: z.string().describe("取り込み元の絶対パス(ファイル or フォルダ)。例: C:/Users/me/Downloads/rock.glb"),
    destPath: z.string().describe("assets 相対の置き先。ファイルなら 'models/rock.glb'、フォルダ/末尾'/' ならその中へ元ファイル名で入る。"),
    overwrite: z.boolean().optional().describe("true で既存を上書き。既定 false(存在したらエラー)。"),
  },
  {},
  ({ sourcePath, destPath, overwrite }) =>
    run(() => engine.call("import_asset", { sourcePath, destPath, overwrite })),
);

reg(
  "dx12_asset_info",
  "アセットのメタ情報",
  "アセットの中身情報を GPU を使わず読む。モデル(gltf/glb/fbx/obj): meshCount/totalVertices/totalFaces/materialCount/boneCount/hasSkeleton/animations[{name,durationSec}]/aabbMin,aabbMax(ノード変換込みのワールド AABB = スケール1で置いた時の実サイズ)。テクスチャ(png/jpg/dds/tga/bmp/hdr): width/height/mipLevels/format/isCubemap。その他は type と fileSizeBytes のみ。spawn 前に「このモデルどのくらいの大きさ? アニメ持ってる?」を確認するのに使う。",
  {
    path: z.string().describe("assets 相対パス。例: models/enemy.glb"),
  },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("asset_info", { path })),
);

reg(
  "dx12_reload_assets",
  "アセットを読み直す",
  "ディスク上で書き換わったアセット(テクスチャ / モデル)のキャッシュを捨てて読み直す: {reloaded, textures[], models[], reboundEntities, skipped[], warnings[]}。"
    + "★★エンジンはテクスチャもモデルも【プロセス起動から一生キャッシュする】ので、Blender や画像編集ソフトから同じパスへ書き出し直しても絵は変わらない。"
    + "これが無いとエディタを終了→起動→シーンロード(20 秒以上)を毎回やることになる。DCC ツールと行き来しながら見た目を詰めるときは必ずこれを使うこと。"
    + "★シーンは開き直さない: エンティティも Transform も選択状態もそのまま、いま置かれている MeshRenderer の参照だけが新しい実体へ張り替わる(reboundEntities がその体数)。"
    + "★既定はディスクの更新時刻を見て【変わったものだけ】。書き出し直したのに reloaded が 0 なら force:true(更新時刻を無視して全部読み直す)。"
    + "★モデル内の埋め込みテクスチャはモデル側を読み直せば一緒に更新される。キューブマップ / 配列テクスチャ(スカイボックス・地形レイヤー)だけは張り直せず skipped に載る(シーンを開き直すこと)。"
    + "読み直した後の絵の確認は dx12_screenshot_final {gizmos:false} が早い。",
  {
    path: z.string().optional().describe(
      "assets 相対のファイル or フォルダ。省略で assets 配下ぜんぶ。"
      + "例: models/camera/camera.gltf(1 ファイル) / models/camera(そのフォルダ配下すべて)。"),
    force: z.boolean().optional().describe(
      "true で更新時刻を見ずに対象を全部読み直す。既定 false(更新時刻が変わったものだけ)。"
      + "ネットワークドライブ等で更新時刻が当てにならないとき、「書き出したのに 0 件」のときに使う。"),
  },
  {},
  ({ path, force }) => run(() => engine.call("reload_assets", { path, force })),
);

reg(
  "dx12_move_asset",
  "アセット移動/リネーム",
  "assets 内のファイル/フォルダを移動・リネームする。★参照パスは自動で追従する: 開いているシーンはメモリ上で更新され(refsUpdated)、ディスク上の他シーン/.prefab/.dxmat/.animfsm/.spranim/.terrainlayers/.uianim も書き換わる(filesChanged / changedFiles)。★開いているシーンの分はメモリ上の更新なので dx12_save_scene で保存すること(保存しないとそのシーンだけ古いパスのまま残る)。ディレクトリを動かした場合は配下の相対部分を保って付け替える。",
  {
    from: z.string().describe("assets 相対の移動元。"),
    to: z.string().describe("assets 相対の移動先。"),
    overwrite: z.boolean().optional().describe("true で既存ファイルを上書き(ディレクトリは不可)。既定 false。"),
    updateFiles: z.boolean().optional().describe("ディスク上の他ファイル内の参照も書き換える。既定 true。false にすると開いているシーンのメモリ上だけ更新する。"),
  },
  {},
  // ★updateFiles を落とすと engine 側の既定 true が効いて、false を渡したのに
  //   ディスク上の他ファイルが書き換わる（成功が返るので気づけない）。
  ({ from, to, overwrite, updateFiles }) =>
    run(() => engine.call("move_asset", { from, to, overwrite, updateFiles })),
);

reg(
  "dx12_delete_asset",
  "アセット削除",
  "assets 内のファイルを削除する。ディレクトリは recursive=true が必須(誤爆防止)。★シーン/プレハブが参照中のアセットを消すとロードが壊れる。取り返しがつかないので消す前に本当に未参照か確認すること。",
  {
    path: z.string().describe("assets 相対パス。"),
    recursive: z.boolean().optional().describe("ディレクトリを丸ごと消す時に true。既定 false。"),
  },
  { destructiveHint: true },
  ({ path, recursive }) => run(() => engine.call("delete_asset", { path, recursive })),
);
