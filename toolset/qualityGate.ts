// 品質ゲート(作業の区切りで 1 回撃つ)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { GATE_CHECKS, runQualityGate } from "../jev/qualityGate.ts";
import { z } from "zod";
import { UI_SCREENS } from "../jev/uiJudge.ts";
import { v3 } from "../sceneTools.ts";
import { readBrief } from "../jev/brief.ts";
import { OUT, engine, jevProjectBaseDir, regRaw, run } from "./core.ts";
import { replayPlaytest } from "./playtestStore.ts";

// ════════════════════════════════════════════════════════════════
//  品質ゲート(作業の区切りで 1 回撃つ): ルールの検査 + 判断段をまとめて 1 つの合否にする
// ════════════════════════════════════════════════════════════════
// ★本体は jev/qualityGate.ts(検査は GATE_CHECKS に足す)。ここはエンジン・Brief・再生の口を渡すだけ。

const GATE_CHECK_IDS = GATE_CHECKS.map((c) => c.id) as [string, ...string[]];

regRaw(
  "dx12_quality_gate",
  {
    title: "品質ゲート",
    description:
      "作業の区切りで 1 回撃つ品質ゲート。(a) シーンの検証(validate_scene の参照切れ + diagnose の軽い検査。textures/models は既定で外す)"
      + " (b) 配置検査(validate_layout)+ 判断段 (c) 絵の仕上がり(polish_audit)+ 判断段 (d) UI があれば ui_audit + 判断段"
      + " (e) playtests を指定すれば保存済みプレイテストの再生 + 判断段、をまとめて 1 つの合否にする。"
      + "返り値 {pass, blocking[], keep[], suggestions[], uncertain[], cost:{requests, tokens, usd, ms}, checks[], judge, elapsedMs, next}。"
      + "★合否: ルールの error は blocking(直すまで先へ進まない)。Jev が作品の意図(dx12_brief)に照らして keep(意図どおり)と"
      + "判断したものは blocking から外し、判断結果と確信度を keep[].judge に残す(直さない)。"
      + "uncertain は合否に入れず列挙するだけ: 各項目の look のツール呼び出しで自分(Claude)が絵を見て決める。"
      + "suggestions は次の一手(そのまま撃てる tool / args 付きのものがある)。"
      + "★Jev は全検査ぶんを 1 往復で聞く: 既定(bundle:\"perDomain\")は検査ごとの state で並列に撃つ(待ち時間は 1 往復)。"
      + "bundle:\"one\" は全質問を 1 リクエストに束ねるが、他の検査の事実が混ざって score / choice の判断が落ちる(実測)ので既定にしていない。"
      + "Brief / 鍵が無いときはルールだけで同じ形を返す(judge.source:\"rules\")。judge:false で Jev を使わない。"
      + "★playtests はシーンを開き直して再生するので、指定したときだけ走る(Editor 中に撃つこと)。Playing 中は配置検査を飛ばす。"
      + "★readability に視点(焦点)と対象を渡すと、知覚層(dx12_perceive)で対象が初見で数秒のうちに気づけて読めるか(read.noticeable)と"
      + "主な原因(read.main_problem)も聞く。壊れてはいないので blocking にはせず、気づけない対象は suggestions で名指しする。",
    inputSchema: {
      checks: z.array(z.enum(GATE_CHECK_IDS)).optional()
        .describe(`走らせる検査を絞る(${GATE_CHECK_IDS.join(" / ")})。省略で既定のもの全部(playtests は指定したときだけ)。`),
      heavy: z.boolean().optional().describe("true で diagnose の重い検査(textures / models。数十秒)も入れる。既定 false。"),
      screenshot: z.boolean().optional().describe("false で polish の最終画を撮らない(速い)。既定 true。"),
      strictness: z.enum(["balanced", "strict"]).optional().describe("strict は UI の warning も blocking にする。既定 balanced。"),
      screen: z.enum(UI_SCREENS).optional().describe("UI の画面の役割(判断段に渡す)。"),
      playtests: z.union([z.boolean(), z.array(z.string())]).optional()
        .describe("保存済みプレイテストを再生する(true = 全部 / 名前の配列)。既定は再生しない。"),
      judge: z.boolean().optional().describe("false で判断段(Jev)を使わずルールだけで返す。既定 true。"),
      bundle: z.enum(["one", "perDomain"]).optional()
        .describe("perDomain(既定)= 検査ごとの state で並列に聞く / one = 全検査の質問を 1 リクエストに束ねる(判断の精度が落ちる)。"),
      readability: z.array(z.object({
        label: z.string().optional().describe("視点の名前(例「継ぎ目6 の焦点」)。判断段にも渡す。"),
        camera: z.union([
          z.enum(["editor", "game"]),
          z.object({ position: v3(), target: v3(), fovDeg: z.number().optional() }),
        ]).optional().describe("dx12_perceive の camera と同じ(既定 editor)。"),
        targets: z.array(z.union([
          z.string(),
          z.object({ name: z.string(), role: z.string().optional().describe("何の物か(例「見つけてほしい破片」)。") }),
        ])).min(1).max(12).describe("読めるか確かめる対象(名前か {name, role})。"),
      })).max(4).optional()
        .describe("読みやすさの検査(知覚層)。視点ごとに dx12_perceive を撃ち、初見で数秒のうちに気づいて読めるかを Jev に聞く。指定したときだけ走る。"),
    },
    outputSchema: OUT,
    // 判断段は外部の Jev へ出る。playtests はシーンを開き直すので読み取り専用ではない。
    annotations: { title: "品質ゲート", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  (args) => run(async () => {
    const baseDir = await jevProjectBaseDir();
    const brief = baseDir ? readBrief(baseDir).brief : null;
    return runQualityGate({
      call: (m, p) => engine.call(m, p), baseDir, brief, opts: args,
      replay: (pt) => replayPlaytest(pt),
    });
  }),
);
