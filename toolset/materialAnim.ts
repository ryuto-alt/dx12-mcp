// Lua 即時実行 / マテリアルテクスチャ・アニメーション制御
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import path from "node:path";
import { argError } from "../sceneTools.ts";
import { filesDirectlyUnder, HEIGHT_UNSUPPORTED_REASON, planPbr, resolveTextureSet, ROLE_TO_SLOT, validateScalar, verifyTextureOverrides } from "../materialApply.ts";
import { verifyApplied } from "../paramGuard.ts";
import { engine, entityId, entityRef, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  Lua 即時実行(eval) — デバッグ用。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_eval_lua",
  "Lua即時実行",
  "任意の Lua コードをエンジンの Lua state でその場実行する(強力なデバッグ機能)。globals フォールバック環境なので scene/physics/camera/audio/events 等の既存グローバルバインディング(dx12_describe_lua_api 参照)がそのまま使える。例: `local e = scene:findEntity(\"Player\"); e.transform.position.y = e.transform.position.y + 1; return e.transform.position.y`。code が値を return していれば result にその tostring() 文字列が入る(無ければ空文字)。★print() も log(msg) も dx12_get_log に出る(print は Logger へ差し替え済み)。副作用のある操作(位置変更・物理力印加等)は Editor/Playing 両方で実行できるが、bodies は Play 中のみ登録されているため物理系は Playing 中でないと効果が無い。localhost 限定・認証なしという既存のセキュリティモデルと同水準。",
  { code: z.string().describe("実行する Lua コード(複数行可)。") },
  {},
  ({ code }) => run(() => engine.call("eval_lua", { code })),
);

// ════════════════════════════════════════════════════════════════
//  マテリアルテクスチャ・アニメーション制御
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_set_texture",
  "テクスチャ上書き割当",
  "エンティティの MeshRenderer にテクスチャを割り当てる(Inspector のアセットブラウザ D&D と同じ操作)。Material はモデル共有なので直接触らず、インスタンス単位の override に書く=他のインスタンスに波及しない。slot は albedo(既定)/normal/metalRoughness/emissive、submesh はサブメッシュ index(既定 0)。path 空文字で解除(Material 既定に戻る)。即時反映。entity(id) か name 指定。スプライトのテクスチャは set_component(sprite2d, {texturePath}) の方。★emissive は貼っただけでは光らない(色×強度が既定 0)。dx12_set_pbr の emissiveIntensity を一緒に上げること。",
  {
    ...entityRef,
    path: z.string().describe("assets 相対パス(例: textures/rust.png)。空文字で override 解除。"),
    slot: z.enum(["albedo", "normal", "metalRoughness", "emissive"]).optional().describe("テクスチャスロット。省略で albedo。emissive は自己発光(dx12_set_pbr の emissiveIntensity と併用)。"),
    submesh: z.number().int().optional().describe("サブメッシュ index。省略で 0。"),
  },
  { idempotentHint: true },
  ({ entity, name, path, slot, submesh }) =>
    run(() => engine.call("set_texture", { entity, name, path, slot, submesh })),
);

reg(
  "dx12_material_apply",
  "PBRマテリアル一括割当",
  "PBR の 4 点セット(BaseColor / Normal / ORM / Height)を 1 回でエンティティへ割り当てる合成ツール。"
  + "dx12_set_texture を 3 回 + dx12_set_pbr を叩く手間を畳んだもの。★dir に素材フォルダ(assets 相対)を "
  + "渡すと中のファイル名から用途を推定する(Poly Haven 系の diff / nor_gl / arm / disp、および "
  + "albedo / basecolor / ORM / RMA / displacement 等)。推定できなかったファイルは黙って捨てず "
  + "ignored に理由付きで返す。個別に baseColor / normal / orm / height を渡せば推定より優先される。"
  + "★重要(既知の罠): エンジンは metallic/roughness の数値上書きが 1 つでも残っていると ORM テクスチャを "
  + "無効化する(Application.cpp:11617 の hasOverride が PBR flags から 2u を落とす)。dx12_spawn_model 経由の "
  + "モデルはシーン JSON の material.metallic/roughness からこの上書きが入っていることが多い。このツールは "
  + "ORM を割り当てるとき自動で metallic/roughness を -1(=上書き解除)へ戻すので、そのままで ORM が効く。"
  + "metallic/roughness を明示指定した場合はその指定を尊重するが、ORM が無効化されることを warnings で返す。"
  + "★height(disp) はメッシュに割当先が無い(set_texture の slot は albedo/normal/metalRoughness だけ)。"
  + "渡しても ignored に理由付きで出る。変位が使えるのは地形の .terrainlayers だけ。"
  + "★適用後に dx12_get_entity で読み返して照合し、食い違いがあれば applied:false + mismatched を返す。"
  + "返り値 {applied, resolved, source, ignored, warnings, targets:[{entityId, name, textures, pbr, applied, mismatched?}]}。",
  {
    ...entityRef,
    entities: z.array(z.union([z.number().int(), z.string()])).optional()
      .describe("複数対象。エンティティ id(int) と 名前(string) を混ぜて渡せる。entity/name と併用可。"),
    dir: z.string().optional()
      .describe("素材フォルダの assets 相対パス(例 textures/red_brick_03)。直下のテクスチャをファイル名から用途推定して割り当てる。サブフォルダは見ない。"),
    baseColor: z.string().optional().describe("BaseColor/Albedo の assets 相対パス。dir の推定より優先。"),
    normal: z.string().optional().describe("法線マップの assets 相対パス。★OpenGL 規約(nor_gl)のみ。nor_dx は使えない。"),
    orm: z.string().optional().describe("ORM/ARM(R=AO 未使用 / G=Roughness / B=Metallic)の assets 相対パス。set_texture の metalRoughness スロットへ入る。"),
    metalRoughness: z.string().optional().describe("orm の別名(glTF 語彙で書きたいとき用)。orm と同時指定なら orm が勝つ。"),
    height: z.string().optional().describe("変位(disp/height)。★メッシュには割当先が無いので ignored に理由付きで返るだけ。地形のレイヤー用。"),
    submesh: z.number().int().optional().describe("サブメッシュ index(既定 0)。モデルのサブメッシュ数は dx12_get_entity の materialTextureOverrides で分かる。"),
    uvScale: z.number().optional().describe("UV タイリング倍率(U/V 両方に入る)。タイル素材を広い床に貼るときに上げる。"),
    uvScaleU: z.number().optional().describe("U 方向だけ個別指定(uvScale より優先)。"),
    uvScaleV: z.number().optional().describe("V 方向だけ個別指定(uvScale より優先)。"),
    metallic: z.number().optional().describe("金属度 0..1 の数値上書き、または -1 で上書き解除。★ORM を割り当てるなら省略が正解(省略時は自動で -1 にする)。"),
    roughness: z.number().optional().describe("粗さ 0..1 の数値上書き、または -1 で上書き解除。★ORM を割り当てるなら省略が正解。"),
  },
  { idempotentHint: true },
  (args: any) => run(async () => {
    const { dir, submesh = 0 } = args;

    // 1) 対象エンティティ(id / 名前を混ぜて受ける)。set_texture / get_entity はどちらも受け付ける。
    //    entity と name は他ツールと同じく排他(両方来たら id を採る)。重複指定は畳んで二重適用を防ぐ。
    const refs: { entity?: number; name?: string }[] = [];
    const seen = new Set<string>();
    const pushRef = (r: { entity?: number; name?: string }) => {
      const key = r.entity !== undefined ? `#${r.entity}` : `@${r.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push(r);
    };
    if (args.entity !== undefined) pushRef({ entity: args.entity });
    else if (args.name !== undefined) pushRef({ name: args.name });
    for (const t of args.entities ?? []) {
      pushRef(typeof t === "number" ? { entity: t } : { name: t });
    }
    if (refs.length === 0) {
      throw argError("対象エンティティが指定されていない",
        "entity(id) / name / entities:[id か 名前の配列] のどれかを渡す。id は dx12_list_entities で分かる");
    }

    // 2) 数値の範囲は投げる前に見る(エンジンはクランプせずそのまま入れるので -1 以外の負値は事故)。
    for (const [k, v] of [["metallic", args.metallic], ["roughness", args.roughness]] as const) {
      const msg = validateScalar(k, v as number | undefined);
      if (msg) throw argError(msg, "ORM テクスチャを効かせたいなら metallic/roughness は省略する(自動で -1 にする)");
    }

    // 3) dir を展開してファイル名から用途を推定 → 明示指定と突き合わせる。
    let files: string[] = [];
    if (dir) {
      const assets = await engine.call("list_assets", { type: "texture" });
      files = filesDirectlyUnder(dir, Array.isArray(assets) ? assets as { path: string }[] : []);
      if (files.length === 0) {
        throw argError(`dir "${dir}" の直下にテクスチャが 1 枚も無い`,
          "assets 相対のフォルダを渡す(例 textures/red_brick_03)。中身は dx12_list_assets type:\"texture\" で確認できる");
      }
    }
    const resolved = resolveTextureSet({
      files,
      explicit: {
        baseColor: args.baseColor,
        normal: args.normal,
        orm: args.orm ?? args.metalRoughness,
        height: args.height,
      },
    });
    const ignored = [...resolved.ignored];

    // height はメッシュに割当先が無い。捨てるが【何を捨てたか】は必ず返す。
    if (resolved.textures.height) {
      ignored.push({ path: resolved.textures.height, reason: HEIGHT_UNSUPPORTED_REASON });
      delete resolved.textures.height;
      delete resolved.source.height;
    }

    const slots: Record<string, string> = {};
    for (const role of ["baseColor", "normal", "orm"] as const) {
      const p = resolved.textures[role];
      const slot = ROLE_TO_SLOT[role];
      if (p && slot) slots[slot] = p;
    }
    const plan = planPbr({
      hasOrm: slots.metalRoughness !== undefined,
      metallic: args.metallic, roughness: args.roughness,
      uvScale: args.uvScale, uvScaleU: args.uvScaleU, uvScaleV: args.uvScaleV,
    });
    if (Object.keys(slots).length === 0 && plan.call === null) {
      throw argError("割り当てるものが 1 つも無い",
        "dir で素材フォルダを渡すか、baseColor / normal / orm のどれかを直接指定する",
      );
    }

    const warnings = [...plan.warnings];
    if (plan.clearedScalarOverride) {
      warnings.push("ORM を有効にするため metallic/roughness の数値上書きを -1(=Material の値を使う)へ戻した。"
        + "数値で金属感を作りたい場合は metallic/roughness を明示指定すること(ただし ORM は効かなくなる)");
    }

    // 4) 適用 → 読み返して照合。エンジンは set_texture に対し applied:true 相当を返すだけなので鵜呑みにしない。
    const targets: any[] = [];
    for (const ref of refs) {
      const t: any = { ...ref, textures: {}, applied: false };
      try {
        for (const [slot, path] of Object.entries(slots)) {
          const r = await engine.call("set_texture", { ...ref, path, slot, submesh });
          t.entityId = (r as any)?.entityId ?? t.entityId;
          t.textures[slot] = path;
        }
        if (plan.call) {
          const r: any = await engine.call("set_pbr", { ...ref, ...plan.call });
          t.entityId = r?.entityId ?? t.entityId;
          // set_pbr は上書きの【生値】(-1 込み)を返す。get_entity の material.metallic は
          // 上書きを解決した後の実効値なので -1 に戻したことを確認できない ＝ ここで照合する。
          t.pbr = { metallic: r?.metallic, roughness: r?.roughness, uvScaleU: r?.uvScaleU, uvScaleV: r?.uvScaleV };
          t.mismatched = verifyApplied(plan.call as Record<string, unknown>, r);
        } else {
          t.mismatched = [];
        }

        const ent: any = await engine.call("get_entity", ref);
        t.entityId = ent?.entityId ?? t.entityId;
        if (ent?.name) t.name = ent.name;
        const entry = Array.isArray(ent?.materialTextureOverrides)
          ? ent.materialTextureOverrides[submesh] : undefined;
        t.mismatched = [...t.mismatched, ...verifyTextureOverrides(slots, entry)];

        // 「割り当てたのに絵が変わらない」を先回りして名指しする。どちらもエンジンの仕様。
        const assigned = Array.isArray(ent?.materialAssets) ? ent.materialAssets[submesh] : undefined;
        if (assigned) {
          t.warning = `.dxmat(${assigned}) が割り当たっているので、このテクスチャ上書きは描画に使われない`
            + "(優先度: materialAsset > テクスチャ上書き > モデル焼き込み Material)。"
            + "上書きを効かせたいならシーン JSON の materialAssets を空にする(dx12_scene_write)";
        } else if (ent?.primitive && (slots.normal || slots.metalRoughness)) {
          t.warning = `プリミティブ(${ent.primitive})の焼き込み Material は法線/metalRoughness テクスチャを持たないため、`
            + "描画側が PBR flags を立てず normal / ORM は無視される可能性が高い"
            + "(Application.cpp:11615-11618 が mat->normalMapTexture / mat->metalRoughnessTexture しか見ていない)。"
            + "法線と ORM を効かせたいならモデル(.gltf)へ貼るか .dxmat を使う";
        }
        t.applied = t.mismatched.length === 0;
        if (t.mismatched.length === 0) delete t.mismatched;
      } catch (e: any) {
        t.error = e.message;
        if (e.code != null) t.error_code = e.code;
      }
      targets.push(t);
    }

    const applied = targets.length > 0 && targets.every((t) => t.applied);
    const out: any = {
      applied,
      resolved: resolved.textures,
      source: resolved.source,
      slots,
      submesh,
      targets,
    };
    if (plan.call) out.pbrRequested = plan.call;
    if (ignored.length > 0) out.ignored = ignored;
    if (warnings.length > 0) out.warnings = warnings;
    if (!applied) {
      out.hint = "要求したパスがエンティティに入っていない。targets[].mismatched / error を見ること。"
        + "同じ呼び出しを繰り返しても変わらない(パスが assets 相対で実在するか、対象に meshRenderer があるかを疑う)";
    }
    out.nextStep = "dx12_focus_and_screenshot で絵を確認する(テクスチャは即時反映される)";
    return out;
  }),
);

reg(
  "dx12_play_anim",
  "アニメーション再生",
  "スケルタルアニメーションを再生する。★2 つの経路がある: "
    + "(A) state を渡すと .animfsm ステートマシンの遷移(AnimatorController が必要。ステート名は dx12_describe_anim_graph で確認)。layer で対象レイヤーを選ぶ(既定 0=ベース)。"
    + "(B) state を渡さなければ従来どおりクリップのクロスフェード再生(Lua の playAnim/playAnimByName と同じ経路)。clipName(名前) か clip(index) で指定、loop/speed も変更できる。クリップ一覧は dx12_get_anim_state。"
    + "blend はどちらの経路でもフェード秒(既定 0.3)。★アニメーションの更新は Play 中に進む。entity(id) か name 指定。",
  {
    ...entityRef,
    clip: z.number().int().optional().describe("クリップ index。clipName と排他(clipName 優先)。省略時 0。state 指定時は無視。"),
    clipName: z.string().optional().describe("クリップ名(完全一致)。dx12_get_anim_state の clips から選ぶ。state 指定時は無視。"),
    blend: z.number().optional().describe("クロスフェード秒。省略で 0.3。"),
    loop: z.boolean().optional().describe("ループ再生するか。省略で現状維持。state 経路では無視。"),
    speed: z.number().optional().describe("再生速度倍率(1.0=等速、2.0=2倍速、0=一時停止)。省略で現状維持。state 経路では無視。"),
    state: z.string().optional().describe(
      ".animfsm のステート名(完全一致)。渡すと clip 経路ではなく FSM の遷移になる。"
      + "AnimatorController とロード済みグラフが要る。名前一覧は dx12_describe_anim_graph。"),
    layer: z.number().int().min(0).optional().describe(
      "state を遷移させるレイヤー index。省略で 0(ベースレイヤー)。上半身だけ差し替える等のマスク付きレイヤーは 1 以降。"),
  },
  {},
  ({ entity, name, clip, clipName, blend, loop, speed, state, layer }) =>
    run(() => engine.call("play_anim", { entity, name, clip, clipName, blend, loop, speed, state, layer })),
);

reg(
  "dx12_get_anim_state",
  "アニメーション状態取得",
  "エンティティのスケルタルアニメーション情報を返す。{hasSkeletalAnimation, clips:[名前...]}。dx12_play_anim の clipName/clip を選ぶのに使う。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_anim_state", { entity, name })),
);

reg(
  "dx12_describe_anim_graph",
  "アニメグラフ構造取得",
  ".animfsm(アニメーションステートマシン)の構造を返す。"
    + "{source, graph:{version, parameters, clipEvents, extraClips, layers:[{name, weight, blend, mask, defaultState, states, transitions}]}}。"
    + "entity/name を渡すとそのエンティティの AnimatorController がロード済みのグラフを、path を渡すと .animfsm ファイルを直接読む(path が優先)。"
    + "dx12_play_anim の state 名 / dx12_set_anim_param のパラメータ名を確認するのに使う。",
  {
    ...entityRef,
    path: z.string().optional().describe(
      ".animfsm の assets 相対パス。渡すとエンティティを見ずにファイルを直接パースする(entity/name より優先)。"),
  },
  { readOnlyHint: true },
  ({ entity, name, path }) => run(() => engine.call("describe_anim_graph", { entity, name, path })),
);

reg(
  "dx12_set_anim_param",
  "アニメパラメータ設定",
  "アニメーション FSM(.animfsm)のパラメータを外から書き換えて遷移を発火させる。"
    + "value に数値(Float パラメータ)か真偽値(Bool パラメータ)を渡すか、trigger:true で Trigger を立てる(value と trigger のどちらかが必須)。"
    + "パラメータ名の一覧は dx12_describe_anim_graph の graph.parameters、現在値は dx12_get_anim_state の parameters で確認。"
    + "★パラメータ名は param。name は他ツールと同じ【エンティティ名】(entity と排他)。"
    + "エンジンには『param 省略時だけ name をパラメータ名として読む』後方互換が残っているが、新しい呼び出しは必ず param を使うこと。"
    + "★遷移が実際に進むのは Play 中(dx12_play)だけ。",
  {
    // ★以前はここだけ entityRef を展開していなかった。エンジンが name を【パラメータ名】として
    //   読んでいた時期の名残で、今は param が正・name はエンティティ名に戻っている
    //   (Application.cpp:5943)。他ツールと同じ entityRef でよい。
    ...entityRef,
    param: z.string().describe("FSM パラメータ名(完全一致)。dx12_describe_anim_graph の graph.parameters から選ぶ。"),
    value: z.union([z.number(), z.boolean()]).optional().describe(
      "設定する値。Float パラメータなら数値、Bool パラメータなら真偽値。trigger と併用不可(trigger:true が優先)。"),
    trigger: z.boolean().optional().describe(
      "true で Trigger パラメータを立てる(値は true 固定。消費は FSM 側)。value の代わりに使う。"),
  },
  {},
  ({ entity, name, param, value, trigger }) =>
    run(() => engine.call("set_anim_param", { entity, name, param, value, trigger })),
);
