// 知覚層(dx12_perceive)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import path from "node:path";
import { definedOnly } from "../paramGuard.ts";
import { perceptionFacts } from "../perceive.ts";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  知覚層: プレイヤーの目から見た事実(エンジンの perceive)を数値と言葉の両方で返す
// ════════════════════════════════════════════════════════════════
// ★Jev は画像を見られないので、ここが Jev の目になる。数値 → 言葉は perceive.ts(境界は PERCEIVE_BINS)。
//   指標の定義はエンジン側 src/renderer/PerceptionStats.h。litFacing はカスタムシェーダの照明を見ていない
//   (JUNCTION の Unbuilt.hlsl は点光源を読まない)ので、「照らされている」でも実際は暗いことがある
//   → 判断に使うときは brightness / contrast と必ず一緒に読むこと(facts には常に並べて出る)。

reg(
  "dx12_perceive",
  "知覚(プレイヤーの目から見た事実)",
  "指定の視点から見た画面を ID パスで集計し、【対象がどれくらい見えるか】を数値(raw)と言葉(facts)の両方で返す。"
  + "対象ごとに 画面占有・位置・明るさ(Y')・周囲とのコントラスト・模様/陰影の量・灯りの当たる向き(litFacing と主光源)・"
  + "遮蔽率・視野に収まるか・距離・彩度・半透明か、シーン全体は上下左右の見え方(空/暗くて何も見えない/面の距離)・"
  + "黒潰れ/白飛び・最も遠い面・画面を占める物の上位。"
  + "camera は \"editor\"(今のエディタのカメラ)/ \"game\"(アクティブなゲームカメラ)/ {position, target, fovDeg?}(指定視点。終われば元へ戻す)。"
  + "targets は名前(最大 16、子孫ごと 1 対象)。遮蔽率は targets で名指しした対象だけに出る。スプライト/パーティクル/UI は数えない。"
  + "★facts は数値を含まない言葉(Jev の判断材料・人が読む用)、raw はエンジンの数値そのまま。"
  + "★litFacing はカスタムシェーダの照明を見ていないので、lit_side が「照らされている」でも brightness / contrast が暗ければ暗い。"
  + "普段 0.1〜0.4 秒(重いシーンでも 0.5 秒前後)。返り値 {facts:{viewpoint, scene, targets[{name, facts}], top[]}, raw}。",
  {
    camera: z.union([
      z.enum(["editor", "game"]),
      z.object({
        position: v3().describe("視点の位置 [x,y,z]。"),
        target: v3().describe("見る先の点 [x,y,z]。"),
        fovDeg: z.number().optional().describe("縦の視野角(1〜170 度)。省略で今のカメラのまま。"),
      }),
    ]).optional().describe("\"editor\"(既定)/ \"game\" / {position, target, fovDeg?}。"),
    targets: z.union([z.string(), z.array(z.string())]).optional().describe("対象のエンティティ名(最大 16。親を渡すと子孫ごと 1 対象)。"),
    top: z.number().int().optional().describe("画面占有の上位を何件返すか(既定 8、0〜64)。"),
    width: z.number().int().optional().describe("解析の横解像度(省略で表示矩形と同じ。height と両方渡すなら縦横比を合わせる)。"),
    height: z.number().int().optional().describe("解析の縦解像度。"),
    settleFrames: z.number().int().optional().describe("決定論モードで落ち着かせるフレーム数(既定 8)。"),
    path: z.string().optional().describe("最終画を PNG で保存する先(省略で保存しない)。"),
    includeTransparent: z.boolean().optional().describe("半透明を「手前の面」として数えるか(既定 true)。"),
  },
  { readOnlyHint: true },
  (a) => run(async () => {
    const raw = await engine.call("perceive", definedOnly(a));
    return { facts: perceptionFacts(raw, { top: 3 }), raw };
  }),
);
