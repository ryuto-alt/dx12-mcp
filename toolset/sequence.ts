// 演出(カットシーン / シーケンス)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { generateLua, referencedEntities, referencedVfx, SEQUENCE_EXAMPLE, type SequenceSpec, validateSpec } from "../sequence.ts";
import { z } from "zod";
import { argError } from "../sceneTools.ts";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { buildContactSheet } from "../contactSheet.ts";
import { collectSceneFacts } from "../polishCollect.ts";
import { auditScene, polishScore, verdict } from "../polish.ts";
import { readBrief } from "../jev/brief.ts";
import { judgePolish, wordifyLook } from "../jev/polishJudge.ts";
import { engine, entityId, errResult, jevProjectBaseDir, reg, regRaw, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  演出(カットシーン / シーケンス)
// ════════════════════════════════════════════════════════════════
// ★カメラ・ポスト・時間・エフェクト・音が【同じ時間軸で噛み合って】初めて演出になる。
//   AI に Lua を直接書かせると毎回ちがう自己流の状態機械が生え、時間の進め方
//   (スケール適用/未適用)もバラバラで、スローモを入れた瞬間に台本が壊れる。
//   宣言的な台本 → 生成コード に固定して、時間の扱いと後始末を 1 箇所で正しくする。

reg(
  "dx12_sequence_author",
  "演出(カットシーン)を台本から作る",
  "時間軸の台本(JSON)から Lua コンポーネントを生成して、エンティティに貼る。"
  + "生成前に台本を全部検査して、足りない引数・知らないプリセット・重なったカメラ・"
  + "戻し忘れたスローモを【実行する前に】教える。"
  + "\ntrack の type: "
  + "camera(位置移動 + 注視) / fade(black|white|clear) / post(グレーディングを時間で動かす) / "
  + "timeScale(スローモ・ヒットストップ) / shake(画面揺れ) / vfx(VFX レシピを撃つ) / "
  + "sound(SFX/BGM) / move・rotate(物を動かす) / light(明るさ・色) / event(Lua イベント発火) / "
  + "scene(フェードしてシーン遷移) / log(デバッグ出力)。"
  + "\n各 track は {t:開始秒, type:…, dur:長さ秒, ease:linear|in|out|inOut|outBack|outBounce} + 型ごとの引数。"
  + "\n例: " + JSON.stringify(SEQUENCE_EXAMPLE.tracks.slice(0, 5))
  + "\n★時計は time.realDt()(タイムスケール非適用)で進むので、スローモを掛けても台本は実時間で流れる。"
  + "★終了時にタイムスケールを 1.0 へ戻し、'<name>:done' イベントを発火する。"
  + "他のスクリプトからは events:emit('<name>:play') / ('<name>:stop') で操作できる。"
  + "★カメラを動かすには spec.camera に【CameraComponent を持つエンティティ名】が要る"
  + "(グローバルのカメラは毎フレーム上書きされるので、カメラ役のエンティティを動かすのが正しい)。",
  {
    name: z.string().describe("演出名(英数字と _ のみ)。components/<name>.lua として生成される。"),
    tracks: z.array(z.record(z.string(), z.any())).describe("台本。t(秒)順でなくてよい(生成時に並べ替える)。"),
    camera: z.string().optional().describe("動かすカメラのエンティティ名(camera トラックを使うなら必須)。"),
    loop: z.boolean().optional().describe("true で最後まで行ったら頭から繰り返す。"),
    attachTo: z.string().optional().describe("この演出スクリプトを貼るエンティティ名。省略すると 'SEQ_<name>' を新規作成して貼る。"),
    doneEvent: z.string().optional().describe("終了時に発火するイベント名(既定 '<name>:done')。"),
    activateCamera: z.boolean().optional().describe(
      "true で camera に指定したカメラを【映るカメラ】にする(他のカメラの isActive を false にする)。"
      + "省略時は切り替えず、映らない指定なら警告だけ返す。"),
    dryRun: z.boolean().optional().describe("true で【何も書かず】生成される Lua と検査結果だけ返す。"),
  },
  {},
  ({ name, tracks, camera, loop, attachTo, doneEvent, activateCamera, dryRun }) => run(async () => {
    const preWarnings: string[] = [];
    let resolvedCamera = camera;
    const usesCameraTrack = (tracks as any[]).some((t) => t?.type === "camera");

    // ★「映るカメラ」を確かめる。CameraComponent が isActive でないカメラを動かしても
    //   画面は 1mm も変わらない(同期ループは最初の isActive を拾う)。
    //   ここを黙って通すと「演出は動いているのに絵が静止している」で長時間溶かす。
    if (usesCameraTrack || camera) {
      const list = await engine.call("list_entities", { component_type: "camera" }).catch(() => null) as any;
      const cams: Array<{ name: string; id: number; active: boolean }> = [];
      for (const e of list?.entities ?? []) {
        const info = await engine.call("get_entity", { entity: e.entityId }).catch(() => null) as any;
        if (info) cams.push({ name: info.name, id: info.entityId, active: !!info.camera?.isActive });
      }
      const active = cams.find((c) => c.active);
      if (cams.length === 0) {
        preWarnings.push("シーンに CameraComponent を持つエンティティが 1 つも無い。"
          + "dx12_create_entity(type:'camera', name:'CutsceneCam') で作ってから撃つこと。");
      } else if (!resolvedCamera) {
        if (!active) {
          preWarnings.push(`有効なカメラが無い(${cams.map((c) => c.name).join(", ")} はどれも isActive=false)。`
            + "dx12_set_component(name:<カメラ名>, component:'camera', data:{isActive:true}) で有効にすること。");
        } else {
          resolvedCamera = active.name;
          preWarnings.push(`camera を省略したので、今アクティブなカメラ "${active.name}" を動かす台本として生成した。`);
        }
      } else if (active && active.name !== resolvedCamera) {
        if (activateCamera) {
          await engine.call("set_component", { name: resolvedCamera, component: "camera", data: { isActive: true } });
          await engine.call("set_component", { name: active.name, component: "camera", data: { isActive: false } });
          preWarnings.push(`アクティブなカメラを "${active.name}" から "${resolvedCamera}" へ切り替えた。`
            + "ゲームへ戻すときは元のカメラを isActive:true に戻すこと。");
        } else {
          preWarnings.push(`★"${resolvedCamera}" は isActive=false。今 映っているのは "${active.name}" なので、`
            + "このままだと演出が動いても画面は変わらない。"
            + "activateCamera:true で切り替えるか、camera を \"" + active.name + "\" にすること。");
        }
      }
    }

    const spec = { name, camera: resolvedCamera, loop, doneEvent, tracks: tracks as any[] } as SequenceSpec;
    const v = validateSpec(spec);
    if (v.errors.length > 0) {
      throw argError(
        `台本に ${v.errors.length} 件の問題がある:\n- ${v.errors.join("\n- ")}`,
        "上の指摘を直してから撃ち直すこと。track の形は dx12_sequence_author の説明にある例を参照",
      );
    }
    const code = generateLua(spec);
    const warnings = [...preWarnings, ...v.warnings];

    // 参照しているエンティティが本当に居るか(居ないと実行時に logWarn が出るだけで静かに壊れる)
    const missing: string[] = [];
    for (const ent of referencedEntities(spec)) {
      const found = await engine.call("find_entity", { name: ent }).catch(() => null) as any;
      const ok = found && (found.entityId !== undefined || (found.entities?.length ?? 0) > 0);
      if (!ok) missing.push(ent);
    }
    if (missing.length > 0) {
      warnings.push(
        `シーンに見つからないエンティティ: ${missing.join(", ")}。`
        + "このままだと実行時に警告が出てそのトラックだけ無視される。名前を直すか先に作ること。",
      );
    }

    if (dryRun) {
      return {
        dryRun: true, name, duration: v.duration, trackCount: v.sorted.length,
        code, warnings, referenced: referencedEntities(spec), vfx: referencedVfx(spec),
      };
    }

    // ★create_lua_component はエンジン側で Lua の構文チェックをしてから書く
    //   (壊れたコードはファイルにならず、理由がそのまま返る)。
    const written = await engine.call("create_lua_component", { name, code }) as any;

    let target = attachTo;
    let created = false;
    if (!target) {
      target = `SEQ_${name}`;
      const found = await engine.call("find_entity", { name: target }).catch(() => null) as any;
      if (!found || found.entityId === undefined) {
        await engine.call("create_entity", { type: "empty", name: target, position: [0, 0, 0] });
        created = true;
      }
    }
    await engine.call("attach_lua_component", { name: target, script: `components/${name}.lua` });

    return {
      applied: true,
      name, path: written?.path ?? `components/${name}.lua`,
      camera: resolvedCamera ?? null,
      attachedTo: target, createdEntity: created,
      duration: v.duration, trackCount: v.sorted.length,
      playEvent: `${name}:play`, stopEvent: `${name}:stop`, doneEvent: doneEvent ?? `${name}:done`,
      referenced: referencedEntities(spec), vfx: referencedVfx(spec),
      warnings,
      next: "dx12_sequence_preview(name:\"" + name + "\") で実際に流して連写で確認する。"
        + "台本を直すときは同じ name で撃ち直せば上書きされる",
    };
  }),
);

// 演出を実際に流して連写する。Play 中のゲーム画面(＝演出がカメラを動かした結果)を撮る。
regRaw(
  "dx12_sequence_preview",
  {
    title: "演出を流して見る",
    description:
      "Play して演出を実際に流し、【ゲーム画面】を時間で連写して格子画像 1 枚にして返す。"
      + "撮り終わったら必ず Stop する(シーンは Play 前の状態へ戻る)。"
      + "★カメラは演出が動かす。撮る前に dx12_set_editor_camera の固定を必ず解除するので、"
      + "『演出は動いているのに絵が静止している』事故が起きない。"
      + "★deterministic ステップで進めるので毎回同じ間隔で撮れる。"
      + "連続フレーム間の差分率も返すので、『カメラが動いていない』『途中で絵が飛んだ』が数値で分かる。"
      + "image ブロック + text(撮影情報)を返す。",
    inputSchema: {
      seconds: z.number().optional().describe("流す長さ(秒)。既定 5。台本の duration に合わせるとよい。"),
      frames: z.number().int().optional().describe("撮る枚数(2..12)。既定 6。"),
      startDelay: z.number().optional().describe("Play してから撮り始めるまでの待ち(秒)。既定 0。"),
      columns: z.number().int().optional().describe("格子の列数(既定 3)。"),
      name: z.string().optional().describe("記録用の演出名(撮影内容には影響しない)。"),
    },
    annotations: { title: "演出を流して見る", openWorldHint: false, readOnlyHint: false },
  },
  async ({ seconds, frames, startDelay, columns, name }) => {
    let playing = false;
    try {
      const nFrames = Math.max(2, Math.min(12, Math.round(frames ?? 6)));
      const total = Math.max(0.2, seconds ?? 5);
      const stepFrames = Math.max(1, Math.round((total * 60) / nFrames));
      const stamp = Date.now();

      // ★撮影用のカメラ固定を必ず外してから Play する。
      //   固定が残っていると、演出がカメラを動かしても【絵が 1mm も変わらない】。
      //   「演出は動いているのに静止画が並ぶ」で長時間溶かす原因(実際に踏んだ)。
      await engine.call("set_editor_camera", { release: true }).catch(() => {});
      const mode = await engine.call("get_mode", {}) as any;
      if (mode?.mode !== "Playing") {
        await engine.call("play", {});
        playing = true;
      }
      if (startDelay && startDelay > 0) {
        await engine.call("step_frames", { frames: Math.round(startDelay * 60), deterministic: true, hold: true });
      }

      const shots: Buffer[] = [];
      for (let i = 0; i < nFrames; i++) {
        await engine.call("step_frames", { frames: stepFrames, deterministic: true, hold: true });
        const outFrame = path.join(os.tmpdir(), `dx12_seq_${stamp}_${i}.png`);
        const shot = await engine.call("screenshot_final", { gizmos: false, path: outFrame }) as any;
        const got = shot?.path ?? outFrame;
        if (!fs.existsSync(got)) throw new Error(`screenshot_final が PNG を残さなかった: ${got}`);
        shots.push(fs.readFileSync(got));
        fs.rmSync(got, { force: true });
      }
      await engine.call("step_frames", { frames: 1, deterministic: true, hold: false }).catch(() => {});
      if (playing) { await engine.call("stop", {}).catch(() => {}); playing = false; }

      const sheet = buildContactSheet(shots, { columns: columns ?? 3 });
      const outPath = path.join(os.tmpdir(), `dx12_seq_preview_${stamp}.png`);
      fs.writeFileSync(outPath, sheet.sheetPng);

      const moved = sheet.frameDiffs.some((d) => d > 0.5);
      const logs = await engine.call("get_log", { lines: 40 }).catch(() => null) as any;
      const lines: string[] = Array.isArray(logs) ? logs : (logs?.lines ?? []);
      const complaints = lines.filter((l) =>
        /が見つからない|エラー|error|warn/i.test(l)).slice(-6);

      return {
        content: [
          { type: "image", data: sheet.sheetPng.toString("base64"), mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify({
              path: outPath, name: name ?? null,
              frames: nFrames, secondsTotal: Number((stepFrames * nFrames / 60).toFixed(3)),
              secondsPerFrame: Number((stepFrames / 60).toFixed(4)),
              frameDiffs: sheet.frameDiffs,
              moved,
              recentLog: complaints,
              hint: moved
                ? "絵が動いている。あとは構図と間(ま)を見て台本の秒数を詰めること"
                : "フレーム間の差がほとんど無い＝演出が動いていない。確認する順番: "
                  + "①スクリプトが貼れているか(dx12_get_lua_component_state) "
                  + "②autoPlay が true か ③camera に指定した名前のエンティティが居るか "
                  + "④recentLog に『が見つからない』が出ていないか",
            }),
          },
        ],
      };
    } catch (e: any) {
      return errResult(e);
    } finally {
      await engine.call("step_frames", { frames: 1, deterministic: true, hold: false }).catch(() => {});
      if (playing) await engine.call("stop", {}).catch(() => {});
    }
  },
);

// 「まだ安っぽいのはなぜか」を測って言う。壊れているかを見る dx12_diagnose とは別物。
regRaw(
  "dx12_polish_audit",
  {
    title: "絵の仕上がりを検査する",
    description:
      "今のシーンに【高品質な絵に必ず入っている要素】が揃っているかを測り、足りないものを"
      + "効く順(光 → 空気 → 階調 → 動き → 素材 → 接地)に並べて返す。"
      + "各指摘には『なぜそれで安っぽく見えるか』と『次に撃つコマンド』が必ず付く。"
      + "★dx12_diagnose は【壊れているか】、dx12_look_compare は【参照画像との差】を見る。"
      + "こちらは参照画像が無い状態で『作りかけに見える理由』を言うためのもの。"
      + "screenshot:true(既定)で最終画も撮って、眠い絵・白飛び・真っ黒・彩度ゼロを画素で判定する。"
      + "返り値 {score, verdict, findings:[{code, category, severity, what, why, fix}], facts, judge}。"
      + "★judge は判断段: 測った数値を言葉にして作品の意図(dx12_brief)と一緒に Jev へ 1 往復で聞き、"
      + "{source, briefFit(0..4), findings:[{code, intended, keep}], nextFix:{id, tool, args, confidence}, uncertain[], scoreExcludingKept} を返す。"
      + "keep:true の指摘は Brief に照らすと意図どおり＝直さない(ホラーの暗さなど)。nextFix はそのまま撃てる。"
      + "uncertain があるものは境界付近なので、絵を見て自分で決めること。"
      + "Brief が無い / 鍵(TYPESAFE_API_KEY)が無い / Jev が落ちている → judge.source:\"rules\" で従来の結論(指摘の先頭を直す)。"
      + "judge:false で判断段を止める。",
    inputSchema: {
      screenshot: z.boolean().optional().describe("false で絵を撮らずシーン設定だけ見る(速い)。既定 true。"),
      only: z.array(z.enum(["light", "air", "grade", "motion", "material", "contact", "image"])).optional()
        .describe("見るカテゴリを絞る。省略で全部。"),
      sampleMeshes: z.number().int().optional().describe("マテリアルを調べるメッシュの上限(既定 24)。大きいシーンで遅いとき下げる。"),
      judge: z.boolean().optional().describe("false で判断段(Jev に Brief と照らして聞く段)を止め、ルールの結論だけ返す。既定 true。"),
    },
    // 判断段は外部の Jev へ出る(鍵があるときだけ)ので openWorldHint は true。
    annotations: { title: "絵の仕上がりを検査する", openWorldHint: true, readOnlyHint: true },
  },
  async ({ screenshot, only, sampleMeshes, judge }) => {
    try {
      // 材料集めは polishCollect.ts(dx12_quality_gate と同じ集め方を共有する)。
      const { facts, shotPath } = await collectSceneFacts((m, p) => engine.call(m, p), { screenshot, sampleMeshes });

      let findings = auditScene(facts);
      if (only && only.length > 0) findings = findings.filter((f) => only.includes(f.category));
      const score = polishScore(findings);

      // ── 判断段(Jev): 測った数値を言葉にして、Brief と一緒に 1 往復で聞く ──
      // ★既存の score / verdict / findings は一切変えない(後方互換)。判断は judge にだけ足す。
      let judgeOut: unknown = undefined;
      if (judge !== false) {
        const baseDir = await jevProjectBaseDir();
        const brief = baseDir ? readBrief(baseDir).brief : null;
        judgeOut = await judgePolish({ brief, facts, findings, askOptions: { baseDir } })
          .catch((e: any) => ({ source: "rules", reason: `判断段で想定外の失敗: ${e?.message ?? e}` }));
      }

      const text = JSON.stringify({
        score, verdict: verdict(score, findings),
        findings,
        facts: {
          envMapPath: facts.envMapPath, lights: facts.lights?.length ?? null,
          fogEnabled: facts.fog?.enabled ?? null,
          emitters: facts.emitterCount ?? null, meshes: facts.meshCount ?? null,
          normalMapped: facts.normalMapCount ?? null, defaultPbr: facts.defaultPbrCount ?? null,
          decals: facts.decalCount ?? null,
          image: facts.image ?? null,
          // Jev に渡した言葉(数値は入れていない)。判断の根拠を人が追えるように返す。
          words: wordifyLook(facts).look,
        },
        ...(judgeOut !== undefined ? { judge: judgeOut } : {}),
        next: findings.length === 0
          ? "必須要素は揃っている。dx12_look_compare で参照写真と比べるか、構図を詰める段階"
          : "findings の上から順に fix をそのまま撃つ(効く順に並んでいる)",
      });

      if (shotPath) {
        return {
          content: [
            { type: "image", data: fs.readFileSync(shotPath).toString("base64"), mimeType: "image/png" },
            { type: "text", text },
          ],
        };
      }
      return { content: [{ type: "text", text }] };
    } catch (e: any) {
      return errResult(e);
    }
  },
);
