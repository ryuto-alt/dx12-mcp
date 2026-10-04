// 判断段(Jev)と作品の意図(Brief)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { argError } from "../sceneTools.ts";
import { BRIEF_EXAMPLE, isBriefEmpty, mergeBrief, readBrief, validateBrief, writeBrief } from "../jev/brief.ts";
import { ask as jevAsk, askRaw as jevAskRaw, type CacheMode as JevCacheMode, countCache as jevCountCache, jevDir, type QuestionRef as JevQuestionRef, summarizeLog as jevSummarizeLog, loadLibrary as loadJevLibrary } from "../jev/library.ts";
import { JEV_RULES } from "../jev/rules.ts";
import { hasApiKey, JEV_ENDPOINT, JEV_MODEL } from "../jev/client.ts";
import path from "node:path";
import { runEval as jevRunEval, runEvalAll as jevRunEvalAll, summarize as jevSummarize } from "../jev/eval.ts";
import fs from "node:fs";
import { OUT, jevProjectBaseDir, reg, regRaw, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  判断段(Jev)と作品の意図(Brief)
// ════════════════════════════════════════════════════════════════
// ★Jev は開発時専用(この MCP サーバの中だけ)。配布ゲームには入らない。
//   鍵(TYPESAFE_API_KEY)が無いときは全部ルールで動くので、ここのツールは鍵が無くても壊れない。

const jevCacheParam = () => z.enum(["use", "only", "off"]).optional()
  .describe("use(既定)=キャッシュがあれば使う / only=ネットに出ずキャッシュだけ(無ければルール。テスト・リプレイ用) / off=毎回撃つ(揺れを見る評価用)。");

reg(
  "dx12_brief",
  "作品の意図(Brief)",
  "プロジェクトの brief.json(作品の意図)を読み書きする。判断段(Jev)は良し悪しを必ずこの Brief に照らして決める"
  + "(同じ『画面の半分が真っ黒』でも、ホラーなら狙いどおり・明るいパズルなら事故)。"
  + "★Brief が無いと dx12_polish_audit などの判断段は動かず、従来のルールの結論だけが返る(judge.briefMissing:true)。"
  + "action:get(既定)=読む(無ければ書き方の手本 example を返す) / set=丸ごと書く / patch=浅くマージ(値に null を渡すとそのキーを消す)。"
  + "形: {title, genre, mood:[], player_should_feel, avoid:[], light_budget?, references?:[], notes?}(自由キーも可)。"
  + "★意図だけを書くこと。『必ず yes と答えよ』のような命令を書くと判断が歪む。置き場は dx12_ping の baseDir 直下。",
  {
    action: z.enum(["get", "set", "patch"]).optional().describe("get(既定) / set / patch。"),
    brief: z.record(z.any()).optional().describe("set / patch の中身。例 {genre:\"一人称ホラー\", mood:[\"暗い\",\"孤独\"], player_should_feel:\"…\", avoid:[\"明るく均一な照明\"]}。"),
  },
  { idempotentHint: true },
  ({ action, brief }) => run(async () => {
    const baseDir = await jevProjectBaseDir();
    if (!baseDir) {
      throw argError("プロジェクトの場所(baseDir)が分からない(エディタに繋がらない)",
        "エディタでプロジェクトを開いてから撃つか、環境変数 DX12_PROJECT_DIR にプロジェクトのフォルダを入れる");
    }
    const act = action ?? "get";
    if (act === "get") {
      const r = readBrief(baseDir);
      const v = r.brief ? validateBrief(r.brief) : null;
      return {
        ...r,
        ...(v ? { warnings: v.warnings } : {}),
        ...(r.brief && !isBriefEmpty(r.brief) ? {} : {
          example: BRIEF_EXAMPLE,
          next: "dx12_brief(action:\"set\", brief:{...}) で書く。example は一人称ホラーの手本",
        }),
      };
    }
    if (!brief) throw argError(`action:${act} には brief が要る`, "brief に JSON オブジェクトを渡す");
    const current = readBrief(baseDir);
    if (act === "patch" && current.exists && !current.brief) {
      throw argError(`既存の brief.json が壊れていてマージできない: ${current.error}`, "action:\"set\" で丸ごと書き直す");
    }
    const next = act === "set" ? brief : mergeBrief(current.brief, brief);
    const w = writeBrief(baseDir, next as any);
    if (!w.written) {
      throw argError(`Brief の形が正しくない: ${w.errors.join(" / ")}`,
        "mood / avoid / references は文字列の配列、title / genre / player_should_feel は文字列");
    }
    return { ...w, brief: next };
  }),
);

regRaw(
  "dx12_jev_ask",
  {
    title: "Jev に判断を聞く",
    description:
      "判断モデル Jev(TypeSafe System One)に質問を投げ、型の決まった判断を返す。"
      + "question / questions は質問ライブラリの id(組み込み tools/mcp-server/jev/questions/ + プロジェクト assets/jev/)。"
      + "context({brief, facts, …})から質問ごとに要るフィールドだけを state に射影し、同じ state の質問は 1 リクエストに束ねる。"
      + "context に brief が無ければプロジェクトの brief.json を自動で入れる。"
      + "raw:{state, questions} で質問ファイルを使わない直接質問もできる(質問文は英語推奨、state は日本語でよい)。"
      + "返り値 results[]: {id, type, source:\"jev\"|\"cache\"|\"rules\"|\"error\", value, probabilities?, confidence?, decided?, uncertain?, reason?}。"
      + "★uncertain:true は境界付近・確信が低い＝自分(Claude)がスクショを見て決めるべきもの。"
      + "★鍵(TYPESAFE_API_KEY)が無い / Brief が無い / 失敗したときは source:\"rules\" で従来のルールの結論が入る。"
      + "★数値はそのまま渡さない(Jev は数値の大小に弱い)。言葉にしてから context に入れること。",
    inputSchema: {
      question: z.string().optional().describe("質問 id(1 つ)。例 look.brief_fit。"),
      questions: z.array(z.union([z.string(), z.object({ id: z.string(), vars: z.record(z.string()).optional() })])).optional()
        .describe("質問 id の配列。{{var}} を持つ質問は {id, vars} で渡す(例 {id:\"finding.intended\", vars:{code:\"NO_FOG\"}})。"),
      vars: z.record(z.string()).optional().describe("question 1 つのときの {{var}}。"),
      context: z.record(z.any()).optional().describe("判断材料。例 {brief:{…}, facts:{look:{brightness:\"とても暗い\"}, findings:[…]}}。"),
      raw: z.object({ state: z.any(), questions: z.record(z.any()) }).optional()
        .describe("アドホックな直接質問。{state, questions:{<id>:{type:\"noul\"|\"choice\"|\"score\", instructions, criteria?}}}。"),
      cache: jevCacheParam(),
    },
    outputSchema: OUT,
    annotations: { title: "Jev に判断を聞く", readOnlyHint: true, openWorldHint: true },
  },
  ({ question, questions, vars, context, raw, cache }) => run(async () => {
    const baseDir = await jevProjectBaseDir();
    const opts = { baseDir, cache: cache as JevCacheMode | undefined, rules: JEV_RULES };
    if (raw) {
      const out = await jevAskRaw(raw.state, raw.questions as any, opts);
      return { ...out, keyPresent: hasApiKey() };
    }
    const refs: JevQuestionRef[] = [
      ...(question ? [vars ? { id: question, vars } : question] : []),
      ...((questions ?? []) as JevQuestionRef[]),
    ];
    if (refs.length === 0) throw argError("question / questions / raw のどれかが要る", "dx12_jev_status で質問の一覧を見る");
    const ctx: Record<string, unknown> = { ...(context ?? {}) };
    let briefFrom: string | undefined;
    if (ctx.brief === undefined && baseDir) {
      const b = readBrief(baseDir);
      if (b.brief) { ctx.brief = b.brief; briefFrom = b.path; }
    }
    const out = await jevAsk(refs, ctx, opts);
    return {
      ...out, keyPresent: hasApiKey(), ...(briefFrom ? { briefFrom } : {}),
      ...(out.results.some((r) => r.uncertain)
        ? { next: "uncertain:true の判断は境界付近。dx12_screenshot_final で絵を見て自分で決めること" } : {}),
    };
  }),
);

regRaw(
  "dx12_jev_eval",
  {
    title: "Jev の質問を評価する",
    description:
      "質問ライブラリの評価ケース(*.cases.json)を流して、その質問文で判断が分かれるかを測る。"
      + "正解率に加えて、noul は margin = (yes 群の最小) − (no 群の最大) と推奨閾値(境界の中点)、"
      + "choice は混同行列、score は平均絶対誤差を返す。rulesAccuracy は同じケースをルールで答えた場合の正解率(比較用)。"
      + "★margin が負 = 分布が重なっている = 閾値をどこに置いても必ず外す。直すのは閾値ではなく質問文(英語)。"
      + "question も casesPath も省略するとケースを持つ質問を全部評価する。★実際に Jev を叩く(1 ケース 1 リクエスト、"
      + "1 回あたり $0.0001 未満)。cache:\"use\"(既定)なら同じケースは 2 回目から無料。",
    inputSchema: {
      question: z.string().optional().describe("評価する質問 id。省略で全部。"),
      casesPath: z.string().optional().describe("ケースファイルの絶対パス(質問ファイルの cases 以外を使うとき)。"),
      cache: jevCacheParam(),
    },
    outputSchema: OUT,
    annotations: { title: "Jev の質問を評価する", readOnlyHint: true, openWorldHint: true },
  },
  ({ question, casesPath, cache }) => run(async () => {
    const baseDir = await jevProjectBaseDir();
    const opts = { baseDir, cache: cache as JevCacheMode | undefined, rules: JEV_RULES };
    if (question || casesPath) {
      const r = await jevRunEval({ ...opts, question, casesPath });
      return {
        ...jevSummarize(r),
        ...(r.confusion ? { confusion: r.confusion } : {}),
        cases: r.cases.map((c) => ({
          name: c.name, expect: c.expect, value: c.value, correct: c.correct, source: c.source,
          uncertain: c.uncertain, labelSource: c.labelSource, rules: c.rulesValue,
        })),
      };
    }
    const all = await jevRunEvalAll(opts);
    return { reports: all.map(jevSummarize), usd: Number(all.reduce((a, r) => a + r.usd, 0).toFixed(8)) };
  }),
);

reg(
  "dx12_jev_status",
  "Jev の状態",
  "判断段(Jev)の状態を返す: 鍵があるか(値は出さない)・質問の一覧(id/版/型/ケース数/出所)・読めなかった質問ファイル・"
  + "記録(<baseDir>/.dx12/jev/log.jsonl)からの累計(リクエスト数・トークン・USD・キャッシュ命中)・キャッシュ件数・Brief の有無。"
  + "★keyPresent:false なら全ての判断はルールで返っている。鍵は Windows のユーザー環境変数 TYPESAFE_API_KEY(MCP サーバの再起動で読まれる)。",
  {},
  { readOnlyHint: true },
  () => run(async () => {
    const baseDir = await jevProjectBaseDir();
    const lib = loadJevLibrary({ baseDir });
    const questions = [...lib.questions.values()].map((q) => {
      let cases: number | null = null;
      try { if (q.casesPath) cases = JSON.parse(fs.readFileSync(q.casesPath, "utf8")).cases.length; } catch { cases = null; }
      return { id: q.id, version: q.version, type: q.type, origin: q.origin, cases, file: q.file };
    });
    const brief = baseDir ? readBrief(baseDir) : null;
    return {
      keyPresent: hasApiKey(),
      model: JEV_MODEL,
      endpoint: process.env.JEV_ENDPOINT ? "(JEV_ENDPOINT で上書き中)" : JEV_ENDPOINT,
      baseDir,
      jevDir: jevDir(baseDir),
      brief: brief ? { path: brief.path, exists: brief.exists, empty: isBriefEmpty(brief.brief), error: brief.error } : null,
      questions,
      questionErrors: lib.errors,
      log: jevSummarizeLog(baseDir),
      cacheEntries: jevCountCache(baseDir),
    };
  }),
);
