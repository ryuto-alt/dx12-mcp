// Blender 連携(自動起動 → 規約どおりの書き出し → 取り込み → 実寸検証)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { BLENDER_PORT, blenderCall, blenderCandidatePaths, buildExportScript, buildMaterialScript, buildPolishScript, isPortOpen, modelBrief, parseCodeResult, planImageRenames } from "../blenderBridge.ts";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { readBrief } from "../jev/brief.ts";
import { collectLayoutContext, judgeLayout } from "../jev/layoutJudge.ts";
import { OUT, engine, entityId, jevProjectBaseDir, reg, regRaw, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  Blender 連携（自動起動 → 規約どおりの書き出し → 取り込み → 実寸検証）
// ════════════════════════════════════════════════════════════════

/**
 * PolyHaven を有効にする（CC0・API キー不要・テクスチャ 859 種 + HDRI）。
 *
 * ★アドオンの既定は **全部 OFF**。この状態だと AI は素材を一切持たずにプリミティブだけで
 *   モデルを組むことになり、真っ白でのっぺりした物しか出てこない（実測で確認）。
 *   キーが要る Hyper3D / Sketchfab は勝手に触らず、状態だけ報告する。
 */
async function enableAssetSources(): Promise<Record<string, unknown>> {
  try {
    // ★旧コミュニティ版アドオンだけがシーンプロパティ blendermcp_use_* を持つ。公式(Blender Lab)版には無いので、
    //   あれば立てる・無ければ飛ばす(代入すると AttributeError になる)。
    const resp = await blenderCall("execute_code", {
      code: [
        "import bpy, json",
        "sc = bpy.context.scene",
        "legacy = hasattr(sc, 'blendermcp_use_polyhaven')",
        "if legacy:",
        "    sc.blendermcp_use_polyhaven = True",
        "print(json.dumps({",
        "  'legacyAddon': legacy,",
        "  'polyhaven': sc.blendermcp_use_polyhaven if legacy else None,",
        "  'hyper3d': getattr(sc, 'blendermcp_use_hyper3d', False),",
        "  'sketchfab': getattr(sc, 'blendermcp_use_sketchfab', False),",
        "  'blender': bpy.app.version_string}))",
      ].join("\n"),
    }, { timeoutMs: 30_000 });
    const { json } = parseCodeResult(resp);
    const st = (json ?? {}) as Record<string, unknown>;
    if (st.legacyAddon === false)
      return {
        assetSources: st,
        assetNote: "公式 Blender アドオンには素材ソースの切替が無い。PolyHaven は dx12_blender_material が直接取りに行く(requests。CC0・キー不要。Blender のオンラインアクセスが ON なら通る)",
      };
    const off: string[] = [];
    if (!st.hyper3d) off.push("Hyper3D Rodin（テキスト→3D。API キーが要る）");
    if (!st.sketchfab) off.push("Sketchfab（既存モデルの検索。API キーが要る）");
    return {
      assetSources: st,
      ...(off.length ? { assetSourcesOff: off } : {}),
      assetNote: "PolyHaven を有効にした（CC0・キー不要）。dx12_blender_material が使う",
    };
  } catch (e) {
    return { assetSourcesError: (e as Error).message };
  }
}

reg(
  "dx12_blender_polish",
  "モデルの仕上げ（うすぺらいを消す）",
  "Blender のオブジェクトに『安っぽさを消す』処理を一括で掛ける。★AI が作ったモデルが『うすぺらい』のはほぼこれをやっていないから: ①スケール適用（★ベベルより先。非一様スケールのまま掛けると軸ごとに幅が変わり片側だけ角が丸い歪んだ形になる）②厚みゼロの板に Solidify ③UV を実寸で切り直す（プリミティブの既定 UV は【面ごとに 0..1】なので 60cm の箱にも 6m の壁にもテクスチャが 1 枚だけ貼られ、模様の大きさが物と合わず玩具に見える）④スムーズ+自動スムーズ ⑤ベベル 3mm/2 段/harden normals ⑥加重法線。★実測（木箱 60cm で比較）: ベベル無しの角は光を一切拾わず、どんなに良いテクスチャを貼っても紙細工に見える。4mm 入れると角にハイライトの線が走り固まりとして見える。書き出す前に必ず通すこと。",
  {
    objects: z.array(z.string()).optional().describe("対象のオブジェクト名。省略で選択中（それも無ければ全メッシュ）。"),
    bevelWidth: z.number().optional().describe("ベベル幅 m（既定 0.003 = 3mm）。小物ほど効く。"),
    bevelSegments: z.number().int().optional().describe("ベベルの段数（既定 2）。"),
    smoothAngle: z.number().optional().describe("自動スムーズの角度（度、既定 30）。"),
    uvMeters: z.number().optional().describe("1 UV = 何メートルで UV を切り直すか（既定 1.0）。0 で UV を触らない。"),
    minThickness: z.number().optional().describe("これ以下の厚みなら Solidify する m（既定 0.004）。0 で無効。"),
  },
  { destructiveHint: true },
  ({ objects, bevelWidth, bevelSegments, smoothAngle, uvMeters, minThickness }) =>
    run(async () => {
      if (!(await isPortOpen(BLENDER_PORT)))
        throw new Error("Blender に接続できない。先に dx12_blender_ensure を撃つこと");
      const code = buildPolishScript({
        objectNames: objects ?? [], bevelWidth, bevelSegments, smoothAngle, uvMeters, minThickness,
      });
      const resp = await blenderCall("execute_code", { code }, { timeoutMs: 300_000 });
      if (resp?.status && resp.status !== "success")
        throw new Error(`Blender 側で失敗: ${resp.message ?? JSON.stringify(resp)}`);
      const { json, stdout } = parseCodeResult(resp);
      if (!json) throw new Error(`結果を読めなかった（stdout: ${stdout.slice(0, 400)}）`);
      return { ...(json as object),
               next: "素材は dx12_blender_material、書き出しは dx12_blender_export" };
    }),
);

reg(
  "dx12_blender_material",
  "PolyHaven の PBR 素材を貼る",
  "PolyHaven（CC0・API キー不要・テクスチャ 859 種）から素材を落として貼る。★エンジンは glTF の baseColorFactor を読まないので、テクスチャ無しのマテリアルは【真っ白】になる（茶色に設定した木箱が白い箱として出る。実測で確認）。単色で済ませたい物にも必ずこれを通すこと。★ORM は R=AO / G=roughness / B=metallic。PolyHaven の arm マップがあればそのまま使い、無ければ Rough から B=0 で合成する（rough 単体をそのまま metallicRoughness として出すと B に粗さが入り、木や布が金属として描かれる）。UV も実寸で切り直すのでテクセル密度が揃う。",
  {
    objects: z.array(z.string()).optional().describe("貼る対象。省略で選択中。"),
    assetId: z.string().optional().describe("PolyHaven のアセット ID（例 brown_planks_05）。"),
    keyword: z.string().optional().describe("ID が分からないときの検索語（wood / concrete / rust / fabric 等）。"),
    resolution: z.enum(["1k", "2k", "4k"]).optional().describe("解像度（既定 2k）。"),
    uvMeters: z.number().optional().describe("1 UV = 何メートル（既定 2.0。2k なら約 1024 texel/m）。"),
  },
  { destructiveHint: true },
  ({ objects, assetId, keyword, resolution, uvMeters }) =>
    run(async () => {
      if (!(await isPortOpen(BLENDER_PORT)))
        throw new Error("Blender に接続できない。先に dx12_blender_ensure を撃つこと");
      if (!assetId && !keyword) throw new Error("assetId か keyword のどちらかが要る");
      const code = buildMaterialScript({
        objectNames: objects ?? [], assetId, keyword, resolution, uvMeters,
      });
      const resp = await blenderCall("execute_code", { code }, { timeoutMs: 600_000 });
      if (resp?.status && resp.status !== "success")
        throw new Error(`Blender 側で失敗: ${resp.message ?? JSON.stringify(resp)}`);
      const { json, stdout } = parseCodeResult(resp);
      if (!json) throw new Error(`結果を読めなかった（stdout: ${stdout.slice(0, 400)}）`);
      const r = json as Record<string, unknown>;
      if (r.error) throw new Error(String(r.error));
      return { ...r, next: "dx12_blender_export で書き出す。置いた後の見栄えは dx12_scene_env で環境光を入れてから判断する" };
    }),
);

reg(
  "dx12_scene_env",
  "環境光を HDRI にする",
  "PolyHaven の HDRI（CC0・キー不要）を落としてシーンの環境マップにする。★既定の手続き空のままだと【全部に青が乗って彩度が落ちる】ので、モデルの見栄えを判断する前にこれを通すこと（実測: 同じ木箱が青灰色 → 本来の木の色になった）。金属と光沢は環境に映るものが無いと質感そのものが出ない。keyword で探すか assetId を直接指定する（studio_small_09 / kloofendal_48d_partly_cloudy_puresky 等）。★屋内シーンで環境光を効かせたくない場合は使わないこと（envMapPath があると DirectionalLight.ambient が無視される）。",
  {
    assetId: z.string().optional().describe("PolyHaven の HDRI ID。"),
    keyword: z.string().optional().describe("検索語（studio / sunset / overcast / interior 等）。"),
    resolution: z.enum(["1k", "2k", "4k"]).optional().describe("解像度（既定 2k）。"),
    iblIntensity: z.number().optional().describe("環境光の強さ（既定 1.0）。"),
    skyboxIntensity: z.number().optional().describe("背景として描く明るさ（既定 0.35）。"),
    drawSkybox: z.boolean().optional().describe("背景に空を描くか（既定 true）。"),
  },
  { destructiveHint: true },
  ({ assetId, keyword, resolution, iblIntensity, skyboxIntensity, drawSkybox }) =>
    run(async () => {
      if (!assetId && !keyword) throw new Error("assetId か keyword のどちらかが要る");
      const res = resolution ?? "2k";
      const ping = await engine.call("ping", {});

      // PolyHaven の API を直接引く（Blender を起動していなくても使える）
      const get = async (url: string): Promise<any> => {
        const r = await fetch(url, { headers: { "User-Agent": "blender-mcp" } });
        if (!r.ok) throw new Error(`PolyHaven: HTTP ${r.status} (${url})`);
        return r.json();
      };
      let id = assetId;
      if (!id) {
        const list = await get("https://api.polyhaven.com/assets?t=hdris");
        const kw = keyword!.toLowerCase();
        const hits = Object.keys(list).filter((k) => k.toLowerCase().includes(kw));
        const byTag = hits.length ? hits : Object.entries(list)
          .filter(([, v]: [string, any]) =>
            [...(v.tags ?? []), ...(v.categories ?? [])].some((t: string) => t.toLowerCase().includes(kw)))
          .map(([k]) => k);
        if (!byTag.length) throw new Error(`PolyHaven に該当する HDRI が無い: ${keyword}`);
        id = byTag.sort()[0];
      }
      const files = await get(`https://api.polyhaven.com/files/${id}`);
      const node = files.hdri?.[res] ?? Object.values(files.hdri ?? {})[0];
      if (!node) throw new Error(`HDRI のファイルが見つからない: ${id}`);
      const url = (node as any).hdr?.url ?? Object.values(node as any)[0].url;

      const rel = `env/${id}_${res}.hdr`;
      const abs = path.join(ping.assetsDir, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) {
        const r = await fetch(url, { headers: { "User-Agent": "blender-mcp" } });
        if (!r.ok) throw new Error(`HDRI の取得に失敗: HTTP ${r.status}`);
        await fs.promises.writeFile(abs, Buffer.from(await r.arrayBuffer()));
      }

      await engine.call("set_scene_settings", {
        skybox: {
          envMapPath: rel,
          drawSkybox: drawSkybox !== false,
          iblIntensity: iblIntensity ?? 1.0,
          skyboxIntensity: skyboxIntensity ?? 0.35,
        },
      });
      const st = await engine.call("get_scene_settings", {});
      return {
        assetId: id, path: rel, bytes: fs.statSync(abs).size,
        skybox: st?.skybox ?? st,
        note: "環境光が入った。金属と光沢はこれが無いと質感が出ない",
      };
    }),
);

reg(
  "dx12_blender_ensure",
  "Blenderの起動確認/起動",
  "BlenderMCP アドオンのソケット(127.0.0.1:9876)が生きているか確かめ、死んでいたら Blender を起動してポートが開くまで待つ。アドオン側は自動でサーバーを開始する設定になっているので、起動さえすれば mcp__blender__* がそのまま使える。★モデリングを頼まれたら【まずこれを撃つ】。手で Blender を開いてもらう必要は無い。{running, started, port, blenderPath, waitedMs}。",
  {
    blenderPath: z.string().optional().describe("blender.exe の絶対パス。省略で既定の場所を新しい版から探す。"),
    timeoutMs: z.number().optional().describe("起動を待つ上限(既定 60000)。"),
  },
  { destructiveHint: false },
  ({ blenderPath, timeoutMs }) =>
    run(async () => {
      if (await isPortOpen(BLENDER_PORT))
        return { running: true, started: false, port: BLENDER_PORT,
                 note: "既に起動していて接続できる", ...(await enableAssetSources()) };

      let exe = blenderPath;
      if (!exe) {
        for (const c of blenderCandidatePaths()) {
          try { await fs.promises.access(c); exe = c; break; } catch { /* 次の候補 */ }
        }
      }
      if (!exe)
        throw new Error("blender.exe が見つからない。blenderPath で絶対パスを指定すること " +
                        `(探した場所: ${blenderCandidatePaths().slice(0, 3).join(" / ")} …)`);

      const { spawn } = await import("node:child_process");
      const child = spawn(exe, [], { detached: true, stdio: "ignore" });
      child.unref();

      const limit = timeoutMs ?? 60_000;
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        if (await isPortOpen(BLENDER_PORT))
          return { running: true, started: true, port: BLENDER_PORT, blenderPath: exe,
                   waitedMs: Date.now() - t0, pid: child.pid,
                   ...(await enableAssetSources()) };
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(
        `Blender は起動したがポート ${BLENDER_PORT} が ${limit}ms 開かなかった。` +
        "アドオンの『Blender MCP』が有効か、サイドバー(N)の BlenderMCP パネルで自動開始が入っているか確認すること");
    }),
);

reg(
  "dx12_model_brief",
  "モデリング規約",
  "dx12 へ持ってくるモデルの作り方を返す。Blender で作り始める【前】に読む。ここに書いてあるのは全部『守らないと実際に壊れた』項目: ★単色マテリアル禁止(エンジンは glTF の baseColorFactor を読まないのでテクスチャ無しは真っ白になる) / ★アルファ抜きが無いので葉・枝カードは Blender で消してから出す / 単位はメートル・原点は底面中心・+Y が正面(Blender の -Y がエンジンの +Z) / テクセル密度 512〜1024 texel/m / ORM は G=roughness B=metallic / シェイプキーは捨てる。{rules, materials, gotchas}。",
  { kind: z.string().optional().describe("用途(character / prop / level / 家具 等)。用途別の注意が増える。") },
  { readOnlyHint: true },
  ({ kind }) => run(async () => modelBrief(kind ?? "prop")),
);

reg(
  "dx12_blender_export",
  "Blenderから規約どおり書き出して取り込む",
  "Blender の選択物(または名前指定)を dx12 の規約どおりに glTF で書き出し、assets へ取り込んで実寸まで検証する。踏んだ罠を全部埋めてあるので【手で export_scene.gltf を呼ばないこと】: 全シーンの全 view_layer で deselect してから対象だけ選ぶ(use_selection=False は .blend 内の全シーンを書き出す)/ シェイプキーを捨てる(実例では 75MB のうち 70MB がモーフだった)/ 画像テクスチャが 1 枚も無いマテリアルを警告する(エンジンでは真っ白になる)/ tmpXXXX.jpg という一時名の画像を意味のある名前へ直して uri も書き換える(直さないと再書き出しで前のモデルの参照が切れる)。取り込み後に dx12_asset_info で実寸を読んで返すので、cm/m の取り違えもその場で分かる。{destPath, exported[], warnings[], assetInfo}。",
  {
    objects: z.array(z.string()).optional().describe("書き出すオブジェクト名。省略で Blender の選択中(それも無ければ全メッシュ)。"),
    destPath: z.string().describe("assets 相対の出力先。例 models/rock/rock.gltf（.glb も可）。"),
    clearShapeKeys: z.boolean().optional().describe("false でシェイプキーを残す(既定 true=捨てる)。"),
    applyModifiers: z.boolean().optional().describe("false でモディファイアを適用しない(既定 true)。"),
  },
  { destructiveHint: true },
  ({ objects, destPath, clearShapeKeys, applyModifiers }) =>
    run(async () => {
      if (!(await isPortOpen(BLENDER_PORT)))
        throw new Error("Blender に接続できない。先に dx12_blender_ensure を撃つこと");
      const ping = await engine.call("ping", {});
      const abs = path.join(ping.assetsDir, destPath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });

      const code = buildExportScript({
        objectNames: objects ?? [], outPath: abs,
        clearShapeKeys, applyModifiers,
      });
      const resp = await blenderCall("execute_code", { code });
      if (resp?.status && resp.status !== "success")
        throw new Error(`Blender 側で失敗: ${resp.message ?? JSON.stringify(resp)}`);
      const { json, stdout } = parseCodeResult(resp);
      const report = (json ?? {}) as { exported?: string[]; warnings?: string[]; error?: string; size?: number };
      if (report.error) throw new Error(`${report.error}（stdout: ${stdout.slice(0, 400)}）`);

      const warnings = [...(report.warnings ?? [])];

      // .gltf なら tmp 名の画像を直す（.glb は埋め込みなので対象外）
      const renamed: { from: string; to: string }[] = [];
      if (abs.toLowerCase().endsWith(".gltf")) {
        try {
          const raw = await fs.promises.readFile(abs, "utf8");
          const doc = JSON.parse(raw);
          const base = path.basename(abs, path.extname(abs));
          const plan = planImageRenames(doc, base);
          for (const r of plan) {
            const dir = path.dirname(abs);
            try {
              await fs.promises.rename(path.join(dir, r.from), path.join(dir, r.to));
              doc.images[r.index].uri = r.to;
              renamed.push({ from: r.from, to: r.to });
            } catch (e) { warnings.push(`画像の改名に失敗: ${r.from} → ${r.to}: ${(e as Error).message}`); }
          }
          if (renamed.length) await fs.promises.writeFile(abs, JSON.stringify(doc), "utf8");
        } catch (e) { warnings.push(`.gltf の画像名の整理に失敗: ${(e as Error).message}`); }
      }

      // 実寸を読む（cm/m の取り違えはここで分かる）
      let assetInfo: unknown;
      try { assetInfo = await engine.call("asset_info", { path: destPath }); }
      catch (e) { warnings.push(`asset_info を読めなかった: ${(e as Error).message}`); }

      const info = assetInfo as { aabbMin?: number[]; aabbMax?: number[] } | undefined;
      if (info?.aabbMin && info?.aabbMax) {
        const size = [0, 1, 2].map((i) => info.aabbMax![i] - info.aabbMin![i]);
        const big = Math.max(...size);
        if (big > 100) warnings.push(`一辺 ${big.toFixed(0)}m ある。Blender 側の単位が cm になっていないか確認すること`);
        if (big < 0.01) warnings.push(`一辺 ${(big * 1000).toFixed(1)}mm しかない。スケールの取り違えを疑う`);
      }

      return {
        destPath, absPath: abs, exported: report.exported ?? [],
        bytes: report.size, renamedImages: renamed, warnings, assetInfo,
        next: "dx12_preview_model で見た目を確認し、dx12_spawn_model(scale は常に 1)で置く。" +
              "置いた後は dx12_validate_layout で埋まり/ちらつきを確認すること",
      };
    }),
);

reg(
  "dx12_asset_gap",
  "足りないモデルの洗い出し",
  "『何をモデリングすべきか』のリストを作る。シーンの参照切れ(modelPath があるのにファイルが無い)と、プリミティブの箱・球で代用しているだけの仮置き(名前が既定のまま/ENV_ 配下のプリミティブ)を集めて返す。Blender で作り始める前の入口。{missing[], placeholders[], count}。",
  {
    includePlaceholders: z.boolean().optional().describe("false で参照切れだけ返す(既定 true)。"),
  },
  { readOnlyHint: true },
  ({ includePlaceholders }) =>
    run(async () => {
      const ping = await engine.call("ping", {});
      const list = await engine.call("list_entities", { verbose: true });
      const missing: { entityId: number; name: string; modelPath: string }[] = [];
      const placeholders: { entityId: number; name: string; primitive: string; sizeHint?: number[] }[] = [];

      for (const e of list?.entities ?? []) {
        let ent: any;
        try { ent = await engine.call("get_entity", { entity: e.entityId }); } catch { continue; }
        const mp = ent?.meshRenderer?.modelPath ?? ent?.modelPath;
        if (mp) {
          try { await fs.promises.access(path.join(ping.assetsDir, mp)); }
          catch { missing.push({ entityId: e.entityId, name: e.name, modelPath: mp }); }
          continue;
        }
        if (includePlaceholders === false) continue;
        const prim = ent?.primitive;
        if (!prim || prim === "plane") continue;          // 床の板は仮置きではない
        if (ent?.gridPlane) continue;                      // 編集用グリッド
        // 仮置きの目印: 既定名のまま or ENV_ 配下（背景装飾をプリミティブで代用している）
        const looksTemp = /^(box|cube|sphere|entity|object)(_\d+|\.\d+)?$/i.test(e.name)
                       || /^ENV_(Prop|Block)_/i.test(e.name);
        if (looksTemp)
          placeholders.push({
            entityId: e.entityId, name: e.name, primitive: prim,
            sizeHint: ent?.transform?.scale,
          });
      }
      return {
        missing, placeholders,
        count: missing.length + placeholders.length,
        next: missing.length
          ? "missing は参照切れ。パスを直すか、そのモデルを作ること（dx12_blender_ensure → モデリング → dx12_blender_export）"
          : placeholders.length
            ? "placeholders はプリミティブでの仮置き。dx12_model_brief を読んでから Blender で本物を作る"
            : "足りないものは無い",
      };
    }),
);

/**
 * 配置検査の結果に判断段を足す(dx12_validate_layout と dx12_quality_gate の両方から使う)。
 * 聞く種類の指摘が無ければ Jev にも get_bounds にも出ない。例外は投げない。
 */
async function judgeLayoutReport(report: any, askOptions: { baseDir?: string | null } = {}) {
  const baseDir = askOptions.baseDir !== undefined ? askOptions.baseDir : await jevProjectBaseDir();
  const brief = baseDir ? readBrief(baseDir).brief : null;
  const ctx = await collectLayoutContext((m, p) => engine.call(m, p), report?.issues ?? []);
  return judgeLayout({ brief, report: report ?? {}, ctx, askOptions: { baseDir } });
}

regRaw(
  "dx12_validate_layout",
  {
    title: "配置検査",
    description:
      "置いた物の【見れば分かるが AI は見ない】破綻を数値で拾う。埋まり(BURIED)/浮き(FLOATING)/同一平面の重なり=ちらつき(Z_FIGHT)/深いめり込み(OVERLAP)/二重配置(DUPLICATE)/当たり判定の欠落(NO_COLLIDER・COLLIDER_WITHOUT_BODY)/スケール異常(SCALE_ANOMALY・NAN_TRANSFORM)。ワールド AABB と三角形精密レイキャストだけで判定するので Editor で動く(Playing 中は MODE_CONFLICT。物理が動かした後の位置を測っても意味が無いため)。★COLLIDER_WITHOUT_BODY はこのエンジン固有の罠: boxCollider だけでは Jolt に載らず、プレイヤーは床をすり抜けて落ち続ける。fix:'safe' で BURIED/FLOATING(接地)・Z_FIGHT(5mm 逃がす)・COLLIDER_WITHOUT_BODY(静的 rigidBody 付与)を自動修正する。DUPLICATE は消す判断が取り返しつかないので報告のみ(dx12_delete_entity で片方を消すこと)。返り値 {pass, checked, errors, warnings, fixed, total, byKind, issues[{kind, level, entityId, name, otherEntityId?, text, fixed}], judge?}。★この検査の要約は dx12_play / dx12_save_scene の返り値にも layout として必ず載る。"
      + "★judge は判断段: 設計判断で意図的でありうる指摘(OVERLAP / FLOATING / BURIED / NO_COLLIDER)だけを、名前・グループ・大きさ・程度の言葉と"
      + "作品の意図(dx12_brief)と一緒に Jev へ 1 往復で聞く(本棚の中の本・吊りランプ・半分埋めた岩・すり抜けてよい草は keep:true)。"
      + "Z_FIGHT / DUPLICATE / COLLIDER_WITHOUT_BODY / NAN_TRANSFORM / SCALE_ANOMALY は明らかな欠陥なので聞かない(notAsked)。"
      + "{source, findings:[{code, ref, entityId, name, intended, keep}], uncertain[{id, why, look}], errorsExcludingKept, passExcludingKept, notAsked, skipped, cost}。"
      + "uncertain は look のツールで絵を見て自分で決める。judge:false で止める。",
    inputSchema: {
      fix: z.enum(["none", "safe", "all"]).optional().describe("none(既定)=検査のみ / safe=安全な修正だけ / all=全部。"),
      tolerance: z.number().optional().describe("同一平面とみなす距離(m)。既定 0.001(1mm)。"),
      limit: z.number().int().min(0).optional().describe("返す issues の件数上限(既定 1000・0 で無制限)。超えたら truncated:true と nextOffset。errors/warnings/byKind は全件ぶん。"),
      offset: z.number().int().min(0).optional().describe("issues の何件目から返すか(既定 0)。"),
      judge: z.boolean().optional().describe("false で判断段(Jev に Brief と照らして聞く段)を止め、エンジンの結果だけ返す。既定 true。"),
    },
    outputSchema: OUT,
    // 判断段は外部の Jev へ出る(鍵があるときだけ)ので openWorldHint は true。
    annotations: { title: "配置検査", destructiveHint: false, openWorldHint: true },
  },
  ({ fix, tolerance, limit, offset, judge }) => run(async () => {
    const report = await engine.call("validate_layout", { fix, tolerance, limit, offset });
    if (judge === false) return report;
    // ★エンジンの pass / errors / issues は一切変えない(後方互換)。判断は judge にだけ足す。
    const judged = await judgeLayoutReport(report)
      .catch((e: any) => ({ source: "rules", reason: `判断段で想定外の失敗: ${e?.message ?? e}` }));
    return { ...report, judge: judged };
  }),
);

reg(
  "dx12_build_game",
  "ゲームビルド",
  "現在のプロジェクトをビルドする(ツールバーの「ビルド」ボタンと同じ処理: exe+DLL+assets+shaders を暗号化 pak にして出力フォルダへ)。★エンジン側は裏ジョブで始めて即応答する({started, state:'running', stage, pct…})ので、エディタは固まらず、大きなプロジェクトの初回ビルド(1〜2 分)でもタイムアウトしない。待つなら waitSec(最大 110)を付ける: 終わる(succeeded|failed|cancelled)か時間切れまで状態を読んで返す。時間切れなら state:'running' のまま返るので、続きは dx12_call {name:'get_build_status'} で読む(止めるのは cancel_build)。二重起動は拒否される(started:false)。ビルド中に保存していない編集は配布物に入らない(ディスクの内容が対象)。出力先はビルド設定(エンジン設定窓)で指定した場所、未設定なら build/game。wait:true は従来どおり完了まで同期({success, outputDir, error?}。エディタが固まるので小さなプロジェクト以外では使わない)。",
  {
    waitSec: z.number().min(0).max(110).optional().describe("終わるまで最大この秒数だけ状態を待つ(既定 0 = 待たず即応答)。"),
    wait: z.boolean().optional().describe("true=従来の同期ビルド(エンジンが完了まで応答しない)。通常は使わず waitSec を使う。"),
  },
  { destructiveHint: true },
  ({ waitSec, wait }) => run(async () => {
    if (wait === true) return engine.call("build_game", { wait: true });
    const started = await engine.call("build_game", {});
    if (!waitSec || started?.started === false) return started;
    const deadline = Date.now() + waitSec * 1000;
    let st: any = started;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 1000));
      st = await engine.call("get_build_status", {});
      if (st?.state === "succeeded" || st?.state === "failed" || st?.state === "cancelled") break;
    }
    return { ...st, started: true };
  }),
);
