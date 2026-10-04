// エンジン診断
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { DIAG_CHECKS, fastDiagnoseOnly, normalizeDiagnoseOnly } from "../sceneTools.ts";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  エンジン診断（「壊れてないか」を 1 発で聞く口）
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_diagnose",
  "エンジン診断(機械可読)",
  "『いま何か壊れてないか？』を 1 回で聞くツール。シェーダーの作り忘れ・壊れたテクスチャ・法線マップが sRGB・"
  + "参照切れアセット(scene_assets: モデル/テクスチャ/マテリアル/シェーダに加えて音声・UI画像・フォント・パーティクル・.uianim/.spranim/.animfsm/.prefab・環境マップ・LUT・デカールアトラスまで見る。アセットを移動/削除しても参照は自動更新されないので、その後は必ずこれを撃つこと)・ライトの上限超過・地形の .hf 不整合・ピッキングが破綻する条件・インスタンシングの不適格理由・"
  + "エンティティ名参照の切れ(entity_refs: Lua の entity プロパティ / Trigger の絞り込み・相手。"
  + "これらは名前の文字列で相手を指すので、指し先を消すとファイルは何も欠けないまま黙って切れる＝"
  + "scene_assets では捕まらない。同名が複数あって『どちらを指すか決まらない』状態も出す。"
  + "エンティティを消した/リネームした後はこれを撃つこと)・"
  + "Lua の閉じ忘れ・DXR(dxr: ケーパビリティと加速構造、RT 影/RT-AO の設定矛盾)、を検査して JSON で返す。"
  + "★シーンビューやゲームビューが真っ暗 / カメラが何も映さないときは only:[\"render_health\"] を撃つこと"
  + "(render_debug の出しっぱなし・露出0・ティント黒・光源ゼロ・シーン矩形の潰れ・SRV ヒープ枯渇・"
  + "カメラの NaN や極端な座標・MCP のカメラ乗っ取り残り、を名指しする。速い)。"
  + "★判定は summary.errors > 0 だけを見ればよい(注意/情報は失敗ではない)。各 issue は日本語 1 行で次の一手が書いてある。"
  + "fast:true か only で重い検査(textures/models = assets 全走査で数十秒)を外せる。"
  + "instancing は 1 度も描画していないと測れない(skipped に理由が入る)。",
  {
    only: z.array(z.string()).optional().describe(
      `実行する検査 ID の配列。省略で全検査。有効値: ${DIAG_CHECKS.join(", ")}`),
    fast: z.boolean().optional().describe("true で重い検査(textures/models)を外して数秒で返す。only 指定時は無視。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ only, fast }) =>
    run(() => {
      const normalized = normalizeDiagnoseOnly(only);
      const target = normalized !== "" ? normalized : (fast ? fastDiagnoseOnly() : "");
      // 重い検査を含むときだけ長いタイムアウトを使う(既定 180s は待たせすぎなので短縮する)。
      const heavy = target === "" || target.includes("textures") || target.includes("models");
      return engine.call("diagnose", { only: target }, heavy ? undefined : { timeout: 30000 });
    }),
);
