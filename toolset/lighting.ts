// ライティングと絵作り(ルック)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { argError, LIGHTING_PRESETS, v3 } from "../sceneTools.ts";
import { describeLooks, LOOK_TAGS, resolveLook } from "../lookDev.ts";
import { definedOnly, verifyApplied } from "../paramGuard.ts";
import { engine, reg, run } from "./core.ts";
import { enumOf } from "./pick.ts";

// ════════════════════════════════════════════════════════════════
//  ライティング
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_list_lights",
  "ライト一覧と灯数バジェット",
  "シーンのライトを種別・色・強度・range・コーン角・影の有無つきで列挙する。"
  + "★同時に【GPU へ送れる灯数の上限に対する使用数】と超過警告を返すのが本命。"
  + "クラスタードライティング(Forward+)なので点/スポットに個別上限は無く【合計 1024 灯】まで置ける"
  + "(ただし画面を割ったクラスタ 1 マスあたりは 128 灯まで。密集して超えた所は無言で切り捨て)。"
  + "【影が落ちるのは spot 4 / point 2 のまま】＝灯数の上限が消えても影の上限は消えていないので注意。"
  + "上限を超えた分は【無言で描画されない】ので、『ライトを置いたのに暗い』の原因はほぼこれ。"
  + "各ライトの overBudget / effective を見れば、どれが効いていないか一目で分かる。"
  + "平行光(太陽)は先頭 1 灯だけが有効。limit/cursor でページングできる(既定 50 件)。",
  {
    limit: z.number().int().optional().describe("1 回に返す件数(既定 50、1..200)。"),
    cursor: z.number().int().optional().describe("続きを取るときに前回の nextCursor を渡す。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ limit, cursor }) => run(() => engine.call("list_lights", { limit, cursor })),
);

reg(
  "dx12_set_sun",
  "太陽(平行光)を設定",
  "シーンの太陽(最初の DirectionalLight)の向き・色・強度・環境光を【絶対値で】設定する(冪等)。"
  + "timeOfDay(0..24)を渡すと向き・色・強度・環境光を時刻カーブで一括決定する(エディタのスライダや "
  + "Lua の Lighting.setTimeOfDay とまったく同じカーブ)。方位/高度で直接指定するなら azimuth / elevation。"
  + "★azimuth / elevation は【太陽が見える方向】(方位: +Z が 0°、+X が 90° / 高度: 0=地平線、90=真上)。"
  + "色は color:[r,g,b] か kelvin(色温度 1000..40000K。電球色 2900 / 昼白色 5600)。"
  + "timeOfDay と個別指定を同時に渡すと、時刻で決めた値の上に個別指定が乗る。"
  + "★物理大気(dx12_set_scene_settings の atmosphere.enabled)が ON のときは、timeOfDay は従来の曲線ではなく大気の時刻を設定し、"
  + "向き・色・強度は大気が毎フレーム決める(応答の atmosphere に太陽の高度/方位/照度)。azimuth/elevation を渡すと sunMode=1(向きを直接指定)へ切り替わる。",
  {
    timeOfDay: z.number().optional().describe("0..24 の時刻。向き/色/強度/環境光をまとめて決める。物理大気 ON のときは大気の時刻を設定する。"),
    azimuth: z.number().optional().describe("方位角(度)。+Z が 0°、+X が 90°。"),
    elevation: z.number().optional().describe("高度角(度)。0=地平線、90=真上(-89..89)。"),
    color: v3().optional().describe("[r,g,b] 0..1。kelvin より優先。"),
    kelvin: z.number().optional().describe("色温度 K(1000..40000)。2900=電球色 / 5600=昼白色 / 7800=曇天。"),
    intensity: z.number().optional().describe("光の強さ(0..100)。"),
    ambient: z.number().optional().describe("この光が供給する環境光(影部分の明るさ。0..5)。"),
  },
  { idempotentHint: true },
  (a) => run(() => engine.call("set_sun", a)),
);

reg(
  "dx12_apply_lighting_preset",
  "ライティング・プリセット適用",
  "太陽 + ポストプロセスをまとめて『それらしい絵』に振る(冪等)。エディタの「ライティング」窓のプリセットと"
  + "【同じ実装・同じ値】なので、AI が触った結果と人が押した結果が一致する。"
  + "day=真上から白い光 / dusk=低いオレンジ+強めのブルーム / night=青白い弱い光+低い環境光 / "
  + "indoor=電球色の斜め光+環境光多め / horror=ほぼ真っ暗+冷たい薄明かり+強いビネット / studio=均一なニュートラル光。"
  + "まずこれで土台を作ってから dx12_set_sun / dx12_set_post_process で詰めるのが速い。"
  + "太陽(平行光)が無いシーンではポストだけ適用される。",
  {
    preset: enumOf(LIGHTING_PRESETS).describe("プリセット名。"),
  },
  { idempotentHint: true },
  ({ preset }) => run(() => engine.call("apply_lighting_preset", { preset })),
);

// ── 絵作り(ルック): 光 + 空気 + グレーディングを 1 セットで当てる ──
// ★ポストは約 90 フィールドある。1 つずつ触っても「それっぽい絵」にはならず、
//   bloom と exposure だけ上げて終わる(実際にそうなっていた)。
//   映画的な絵は【光 → 空気 → グレーディング】が噛み合って初めて出るので、組み合わせで渡す。

reg(
  "dx12_look_library",
  "ルック(絵作り)一覧",
  "使えるルック(ゴールデンアワー / ネオンノワール / ホラー / 白黒 / 水中 …)を一覧する。"
  + "各項目は {id, title, summary, tags, touches(何を触るか), pairsWith(相性の良い VFX)}。"
  + "★dx12_apply_lighting_preset(エンジンの 6 種)は【太陽 + ごく一部のポスト】の土台。"
  + "こちらは【フォグ・トーンマッパー・ビネットの形・粒子・色収差まで含めた完成形】で、土台の上に乗せる仕上げ。"
  + "id を指定すると、そのルックが設定する全フィールドの実値と注意書きまで返す。",
  {
    tag: z.string().optional().describe("タグで絞る(outdoor / indoor / night / dark / warm / cool / stylized / cinematic / neutral / bright / moody / product)。"),
    id: z.string().optional().describe("1 つの id を指定すると全フィールドの実値と注意書きを返す。"),
  },
  { readOnlyHint: true, idempotentHint: true },
  ({ tag, id }) => run(async () => {
    if (id) {
      const r = resolveLook(id);
      return {
        id: r.preset.id, title: r.preset.title, summary: r.preset.summary,
        tags: r.preset.tags, notes: r.preset.notes, pairsWith: r.preset.pairsWith ?? [],
        sun: r.sun, fog: r.fog, sky: r.sky, post: r.post, warnings: r.warnings,
      };
    }
    const list = describeLooks(tag);
    if (list.length === 0) {
      throw argError(`タグ "${tag}" に当てはまるルックが無い`, "tag を省略して全件見るか、下の有効値から選ぶ", LOOK_TAGS);
    }
    return {
      looks: list, count: list.length, tags: LOOK_TAGS,
      next: "dx12_look_apply(preset:<id>) で当てて、dx12_screenshot_game_view で見る",
    };
  }),
);

reg(
  "dx12_look_apply",
  "ルック(絵作り)を当てる",
  "太陽 + ボリュメトリックフォグ + 背景の強さ + ポスト約 20 項目を 1 コールでまとめて当てる(冪等)。"
  + "内部では set_sun / set_volumetric_fog / set_scene_settings / set_post_process を順に撃ち、"
  + "最後に読み返した実値を返す(要求と食い違うものは mismatched に出す＝嘘をつかない)。"
  + "★strength(0..1)はポストにだけ効く。0 に向かって【無味無臭の値】へ寄る(0 になるのではない)ので、"
  + "0.5 で『半分だけ効いた絵』になる。太陽とフォグは常に指定どおり。"
  + "★parts で部分適用できる: ['post'] なら今のライティングを壊さずグレーディングだけ乗せる。"
  + "★暗いルックは【光源を置いてから】当てること。真っ暗なシーンに当てても真っ黒になるだけ。",
  {
    preset: z.string().describe("ルック id(dx12_look_library で一覧)。例: golden_hour / neon_noir / horror_candle / clean_studio。"),
    strength: z.number().optional().describe("ポストの効き具合 0..1(既定 1)。0.5 で半分。太陽とフォグには効かない。"),
    parts: z.array(z.enum(["sun", "fog", "post", "sky"])).optional()
      .describe("当てる範囲(既定は全部)。['post'] = 今の光を壊さずグレーディングだけ。['sun','fog'] = 色味は自分で決める。"),
    dryRun: z.boolean().optional().describe("true で【何も変更せず】適用予定の値だけ返す。"),
  },
  { idempotentHint: true },
  ({ preset, strength, parts, dryRun }) => run(async () => {
    const r = resolveLook(preset, { strength, parts });
    if (dryRun) {
      return {
        dryRun: true, preset: r.preset.id, title: r.preset.title,
        sun: r.sun, fog: r.fog, sky: r.sky, post: r.post,
        notes: r.preset.notes, warnings: r.warnings,
      };
    }

    const applied: string[] = [];
    if (r.sun) { await engine.call("set_sun", definedOnly(r.sun)); applied.push("sun"); }
    if (r.fog) { await engine.call("set_volumetric_fog", definedOnly(r.fog)); applied.push("fog"); }
    if (r.sky) {
      await engine.call("set_scene_settings", { skybox: definedOnly(r.sky) });
      applied.push("sky");
    }
    let mismatched: unknown[] = [];
    let currentPost: unknown = null;
    if (Object.keys(r.post).length > 0) {
      await engine.call("set_post_process", r.post);
      applied.push("post");
      currentPost = await engine.call("get_post_process", {}).catch(() => null);
      mismatched = verifyApplied(r.post, currentPost);
    }

    const warnings = [...r.warnings];
    // 「当てたのに真っ黒」を先回りして言う。暗いルックは光源が要る。
    if ((r.sun?.intensity ?? 1) < 0.5) {
      const lights = await engine.call("list_lights", { limit: 1 }).catch(() => null) as any;
      const count = lights?.count ?? lights?.total ?? null;
      if (count !== null && count <= 1) {
        warnings.push(
          "このルックは太陽をほぼ消すが、シーンに他のライトが見当たらない＝ただの真っ黒な絵になる。"
          + "松明/窓/ランプなどの光源を置いてから当て直すこと(dx12_vfx_apply preset='torch' が早い)。",
        );
      }
    }

    return {
      applied: mismatched.length === 0,
      preset: r.preset.id, title: r.preset.title,
      parts: applied,
      strength: strength ?? 1,
      sun: r.sun, fog: r.fog, sky: r.sky,
      postRequested: r.post,
      currentPost,
      ...(mismatched.length > 0
        ? { mismatched, hint: "要求した値がエンジンに入っていない(クランプされたか、そのフィールドを見ていない)。currentPost の実値を見て次の手を決めること" }
        : {}),
      notes: r.preset.notes,
      pairsWith: r.preset.pairsWith ?? [],
      warnings,
      next: "dx12_screenshot_game_view か dx12_screenshot_from(gizmos:false) で絵を見る。"
        + "参照写真に寄せたいなら dx12_look_compare",
    };
  }),
);
