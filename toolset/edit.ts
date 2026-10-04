// 編集系(同期): set_transform / set_component / 親子 / 選択 / シーン保存など
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { nonSettableComponentError, v3 } from "../sceneTools.ts";
import { z } from "zod";
import { definedOnly, unknownKeyError, unknownParamKeys, verifyApplied } from "../paramGuard.ts";
import { engine, entityId, entityRef, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  編集系(同期)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_set_transform",
  "Transform 設定",
  "エンティティの Transform を設定する。指定したフィールドだけ更新。回転は rotation(Euler 度) か quaternion([x,y,z,w]) のどちらか。即時反映で ok を返す。",
  {
    ...entityRef,
    position: v3().optional().describe("[x,y,z]"),
    rotation: v3().optional().describe("[x,y,z] Euler 度。quaternion と併用しない。"),
    quaternion: z.array(z.number()).length(4).optional().describe("[x,y,z,w] クォータニオン。rotation と併用しない。"),
    scale: v3().optional().describe("[x,y,z]"),
  },
  { idempotentHint: true },
  ({ entity, name, position, rotation, quaternion, scale }) =>
    run(() => engine.call("set_transform", { entity, name, position, rotation, quaternion, scale })),
);

reg(
  "dx12_set_component",
  "コンポーネント設定",
  "コンポーネントを設定(無ければ追加・あれば置換)。component は jsonKey、data は dx12_describe_components の形。tags は data=文字列配列、DataComponent(data) は {key:{t,v}} オブジェクト。即時反映で {entityId, component} を返す。形が不安なら先に dx12_describe_components を見るとよいです。",
  {
    ...entityRef,
    component: z.string().describe("jsonKey。例: pointLight, directionalLight, spotLight, camera, rigidBody, boxCollider, transform, tags, data, particleEmitter, trailRenderer, decal, networkIdentity, networkTransform, sprite2d, audioSource, trigger, uiCanvas, uiRect, uiImage, uiText, uiButton, uiSlider, uiToggle, uiScrollView, uiAnimator"),
    data: z.union([z.record(z.any()), z.array(z.any())]).describe("コンポーネントの値。オブジェクト or 配列(tags は文字列配列)。dx12_describe_components の fields に合わせる。"),
    layer: z.union([z.number().int(), z.string()]).optional()
      .describe("particleEmitter のときだけ有効: 編集するレイヤーの index か名前。省略すると 1 枚目が書き換わる。一覧は dx12_list_particle_layers。"),
  },
  { idempotentHint: true },
  ({ entity, name, component, data }) =>
    run(() => {
      // ★B11: terrain / sculptMesh / gridPlane 等はエンジンが UNKNOWN_COMPONENT で弾く
      //   (専用ツールの担当だから。詳細は sceneTools.ts の NON_SETTABLE_COMPONENTS)。
      //   "unknown" と言われると AI が名前を推測して撃ち直すので、送る前に本当の理由を返す。
      const blocked = nonSettableComponentError(component);
      if (blocked) throw blocked;
      return engine.call("set_component", { entity, name, component, data });
    }),
);

reg(
  "dx12_remove_component",
  "コンポーネント除去",
  "エンティティからコンポーネントを除去する。component は jsonKey。transform/name などコア不変のものは除去不可。即時反映で {entityId, removed} を返す。",
  {
    ...entityRef,
    component: z.string().describe("除去する jsonKey。例: pointLight, rigidBody, boxCollider, sphereCollider, camera, tags"),
  },
  { idempotentHint: true },
  ({ entity, name, component }) =>
    run(() => engine.call("remove_component", { entity, name, component })),
);

reg(
  "dx12_set_parent",
  "親子設定",
  "エンティティの親を設定する。parent 省略で親を解除。サイクルになる指定は拒否。即時反映で ok を返す。",
  {
    ...entityRef,
    parent: z.number().int().optional().describe("親エンティティ id。省略で親解除。"),
  },
  { idempotentHint: true },
  ({ entity, name, parent }) => run(() => engine.call("set_parent", { entity, name, parent })),
);

reg(
  "dx12_group_entities",
  "グループ化",
  "複数エンティティを空の親(グループ)へまとめる。ヒエラルキーの Ctrl+G と同じ。★親は原点・無回転・スケール1で作るので子のワールド位置は動かない(見た目は完全に同じまま)。以後はグループを dx12_set_transform で動かせば中身ごと移動/回転/拡縮できる。指定した中に親子関係があれば子側は自動で除外(親ごと動くため)。全員が同じ親の下にいたらグループもその親の下に入る。エディタと同じく Undo 可能。{groupId, name, count} を返す。エンティティが増えてヒエラルキーが膨れた時の整理に使う。",
  {
    entities: z.array(z.number().int()).optional().describe("まとめる エンティティ id の配列。names と併用可。"),
    names: z.array(z.string()).optional().describe("まとめる エンティティ名(完全一致)の配列。entities と併用可。"),
    name: z.string().optional().describe("グループ名。省略時 'Group'。重複したら連番が付く。"),
  },
  {},
  ({ entities, names, name }) =>
    run(() => engine.call("group_entities", { entities, names, name })),
);

reg(
  "dx12_rename_entity",
  "リネーム",
  "エンティティ名を変更する。重複名は連番(name_2 など)が付与され、確定した {name} を返す。",
  {
    entity: entityId,
    name: z.string().describe("新しい名前。"),
  },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("rename_entity", { entity, name })),
);

reg(
  "dx12_select_entity",
  "選択",
  "エディタ上で対象エンティティを選択状態にする(Inspector 表示が切り替わる)。entity(id) か name 指定。{selected} を返す。",
  { ...entityRef },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("select_entity", { entity, name })),
);

reg(
  "dx12_focus_camera",
  "カメラフォーカス",
  "エディタのフライカメラを対象エンティティに寄せる。entity(id) か name 指定。{cameraPos, target, distance} を返す。撮影前に画角を合わせるのに使う(dx12_focus_and_screenshot もある)。",
  { ...entityRef },
  { idempotentHint: true },
  ({ entity, name }) => run(() => engine.call("focus_camera", { entity, name })),
);

reg(
  "dx12_set_pbr",
  "PBR マテリアル設定",
  "エンティティの PBR パラメータ(metallic/roughness/UV スケール/透明/自己発光)を設定する。指定分のみ更新。"
  + "即時反映で {entityId, metallic, roughness, uvScaleU, uvScaleV, alphaMode, alphaCutoff, opacity, "
  + "emissiveIntensity, emissiveColor} を返す。"
  + "透明は alphaMode(auto/opaque/mask/blend) + alphaCutoff + opacity。mask は影も同じ形に抜ける。"
  + "★自己発光(emissive)は emissiveIntensity を上げるだけで光る(色を省くと白)。ライティングも影も "
  + "通さず最終色へ加算するので、1 を超えるとブルームが乗る。天井照明パネル・看板・非常口サイン向け。"
  + "テクスチャで発光形状を指定したいときは dx12_set_texture の slot:\"emissive\" と併用する。",
  {
    ...entityRef,
    metallic: z.number().optional().describe("金属度 0..1"),
    roughness: z.number().optional().describe("粗さ 0..1"),
    uvScaleU: z.number().optional().describe("UV の U 方向スケール(タイリング)"),
    uvScaleV: z.number().optional().describe("UV の V 方向スケール(タイリング)"),
    alphaMode: z
      .enum(["auto", "opaque", "mask", "blend"])
      .optional()
      .describe(
        "透明の扱い。auto=モデルのマテリアル(glTF alphaMode)に従う(既定) / opaque=不透明 / " +
          "mask=baseColor.a < alphaCutoff を discard(葉・フェンス・角膜。影も同じ形に抜ける) / " +
          "blend=半透明(不透明の後にカメラから遠い順で描く。深度は書かない)",
      ),
    alphaCutoff: z
      .number()
      .optional()
      .describe("mask のしきい値 0..1(既定はマテリアル値、glTF 既定 0.5)。負でマテリアルに従う"),
    opacity: z
      .number()
      .optional()
      .describe("不透明度 0..1。1 未満なら alphaMode を省いても半透明になる(ガラス・水面)"),
    emissiveIntensity: z
      .number()
      .optional()
      .describe(
        "自己発光の強さ 0..64(0=消灯、負=マテリアルに従う)。1 を超えるとブルームが乗る。" +
          "目安: 看板 2..5 / 天井照明パネル 4..10 / 非常口サイン 3..6",
      ),
    emissiveColor: z
      .array(z.number())
      .length(3)
      .optional()
      .describe("自己発光の色 [r,g,b](0..1、リニア)。省略して強度だけ指定すると白になる"),
  },
  { idempotentHint: true },
  ({ entity, name, metallic, roughness, uvScaleU, uvScaleV, alphaMode, alphaCutoff, opacity,
     emissiveIntensity, emissiveColor }) =>
    run(() =>
      engine.call("set_pbr", {
        entity,
        name,
        metallic,
        roughness,
        uvScaleU,
        uvScaleV,
        alphaMode,
        alphaCutoff,
        opacity,
        emissiveIntensity,
        emissiveColor,
      }),
    ),
);

reg(
  "dx12_set_color",
  "基本色設定",
  "メッシュの基本色(頂点色の乗算)を設定する。足場やコインの色付けに。color は [r,g,b](0..1)。entity(id) か name 指定。金属感は dx12_set_pbr の metallic/roughness と併用。",
  {
    ...entityRef,
    color: v3().describe("[r,g,b] 0..1。例: 金色=[1,0.84,0]"),
  },
  { idempotentHint: true },
  ({ entity, name, color }) => run(() => engine.call("set_color", { entity, name, color })),
);

reg(
  "dx12_set_mesh_shader",
  "カスタムシェーダー割当",
  "エンティティの MeshRenderer::shaderPath を設定/解除する(Inspector の「Shader」欄と同じ操作)。dx12_create_shader で作った .hlsl の assets/shaders 相対パスを渡す。shaderPath 省略/空文字で既定 Forward に戻す。modelPath と違いメッシュ再ロードを伴わないため即時反映。★スキンドメッシュ(SkeletalAnimation 持ち)は既定 Forward へ自動フォールバックする(返り値 skinnedFallbackWarning で判定可)。★シェーダーのピクセルシェーダーで alpha を出しても、既定では不透明固定(BlendEnable=FALSE)でブレンドに使われない。半透明にしたい場合は alphaBlend:true も渡すこと(Inspector の「アルファブレンド有効」チェックボックスと同じ)。entity(id) か name 指定。",
  {
    ...entityRef,
    shaderPath: z.string().optional().describe("assets/shaders 相対パス。例: ToonShade.hlsl。省略/空文字で既定 Forward に戻す。"),
    alphaBlend: z.boolean().optional().describe("true でシェーダーの alpha 出力を SrcAlpha/InvSrcAlpha ブレンドに使う(DepthWrite OFF)。省略時は既存値を維持、既定は false(不透明固定)。"),
  },
  { idempotentHint: true },
  ({ entity, name, shaderPath, alphaBlend }) => run(() => engine.call("set_mesh_shader", { entity, name, shaderPath, alphaBlend })),
);

reg(
  "dx12_set_mesh_shader_params",
  "カスタムシェーダーのパラメーターを動かす",
  "カスタムシェーダーの自由枠(b0 の effectValue / shaderParams(float4) / shaderParamsB(float3))へ値を書く。"
  + "★これが無いとシェーダーは【貼れるが動かない】。割り当てた直後は全パラメーターが 0 なので、"
  + "波の高さ 0・流速 0 の水面のように『貼ったのに何も起きない』状態になる(実際にそう見える)。"
  + "各値の意味はシェーダー自身のヘッダコメントにある(dx12_read_shader で読める)。"
  + "ルート定数なので毎フレーム撃っても安い(頂点バッファの作り直しは起きない)。"
  + "返り値に現在値が全部入るので、撃った後の確認は要らない。"
  + "★時間で動かしたい(徐々に溶ける/波が高くなる)なら Trigger の AnimShaderParam"
  + "(dx12_set_component component='trigger' の actions に type:12 を入れる)を使うこと。"
  + "Lua からシェーダーパラメーターを動かす口はまだ無い。",
  {
    ...entityRef,
    effect: z.number().optional().describe("effectValue(汎用の 1 個目。多くの雛形で『効果の強さ 0..1』)。"),
    params: z.array(z.number()).max(4).optional().describe("shaderParams へ先頭から代入する最大 4 要素の配列。"),
    paramsB: z.array(z.number()).max(3).optional().describe("shaderParamsB へ先頭から代入する最大 3 要素の配列。"),
  },
  { idempotentHint: true },
  ({ entity, name, effect, params, paramsB }) =>
    run(() => engine.call("set_mesh_shader_params", { entity, name, effect, params, paramsB })),
);

reg(
  "dx12_set_sprite_shader",
  "Sprite2Dカスタムシェーダー割当",
  "エンティティの Sprite2D::shaderPath を設定/解除する(Inspector の Sprite2D「Shader」欄と同じ操作)。world-space スプライトのみ対応(HUD不可)。dx12_create_shader で作った .hlsl の assets/shaders 相対パスを渡す。shaderPath 省略/空文字で既定 Sprite シェーダーに戻す。★MeshRendererのカスタムシェーダーとはルートシグネチャ/頂点フォーマットの契約が異なる(cbuffer b0 = float4x4 transform + float time、頂点は POSITION/TEXCOORD0/COLOR0/TEXCOORD1(effect)、詳細はdocs/AUTHORING.md)ため同じ.hlslは使い回せない。alphaBlend は Inspector の「アルファブレンド有効」と同じ。entity(id) か name 指定。",
  {
    ...entityRef,
    shaderPath: z.string().optional().describe("assets/shaders 相対パス。例: Dissolve.hlsl。省略/空文字で既定 Sprite シェーダーに戻す。"),
    alphaBlend: z.boolean().optional().describe("true でシェーダーの alpha 出力を SrcAlpha/InvSrcAlpha ブレンドに使う(DepthWrite OFF)。省略時は既存値を維持、既定は false(不透明固定)。"),
  },
  { idempotentHint: true },
  ({ entity, name, shaderPath, alphaBlend }) => run(() => engine.call("set_sprite_shader", { entity, name, shaderPath, alphaBlend })),
);

reg(
  "dx12_set_scene_settings",
  "シーン設定変更",
  "シーンのスカイボックス/IBL・物理大気・デカールアトラスを設定する。skybox / atmosphere 内の指定フィールドだけ適用。"
  + "★物理大気は atmosphere:{enabled:true, preset?, timeOfDay?} で ON(既定 OFF=従来の空)。太陽は driveSun=true の間、大気が向き・色・強度を毎フレーム決める。"
  + "★適用後にエンジンから読み返した実値を current に返す(envMapPath を変えたときは envMapRebake も)。"
  + "★decalAtlasPath は【デカールの絵】。空だとデカールを置いても【無言で何も出ない】"
  + "(dx12_decal_apply が自動で用意するので、普通は直接触らなくてよい)。"
  + "★partition:{cellSize} はシーンファイルの【分割保存】(メートル。0=分割しない=既定)。>0 にして dx12_save_scene すると foo.json(ルート設定+置き場所の無い物)"
  + "+ foo.parts/cell_<x>_<z>.json(位置のセルごと)に分けて書き、変えたセルのファイルだけ書き換える(大規模シーンの git 差分・部分読みに効く)。"
  + "エンティティ 5,000 体以上は有効化を勧める。目安 64(街・屋内)〜256(広い屋外)。保存結果は dx12_save_scene の partition に出る。",
  {
    // ★入れ子も passthrough。素の z.object は skybox 内の未知キーを黙って捨てるため、
    //   skybox:{envMapPath:...} の打ち間違いが無言で無視されていた(下のハンドラで弾く)。
    decalAtlasPath: z.string().optional().describe(
      "デカールアトラス画像の assets 相対パス(RGBA。alpha=覆う度合い)。空文字でデカールを無効化。"),
    skybox: z.object({
      envMapPath: z.string().optional().describe("環境マップ(HDR/EXR 等)の assets 相対パス。"),
      iblIntensity: z.number().optional().describe("IBL(間接光)の強さ。"),
      skyboxIntensity: z.number().optional().describe("スカイボックス描画の明るさ。"),
      drawSkybox: z.boolean().optional().describe("スカイボックスを描画するか。"),
    }).passthrough().optional().describe("スカイボックス設定。指定したフィールドのみ適用。"),
    partition: z.object({
      cellSize: z.number().min(0).max(100000).optional().describe("分割保存のセルの大きさ [m](XZ の格子の 1 辺)。0 = 分割しない(1 ファイル)。0 より大きいときは 4 以上。目安 64〜256。"),
    }).optional().describe("シーンファイルの分割保存の設定(保存時に効く)。"),
    atmosphere: z.object({
      preset: z.enum(["earth", "mars", "haze", "twilight"]).optional().describe("大気パラメータのプリセット(地球 / 火星風 / 霞 / 薄明)。先に適用され、同時に指定した個別項目で上書きできる。"),
      enabled: z.boolean().optional().describe("物理大気を使うか。false(既定)= 従来の空。"),
      timeOfDay: z.number().optional().describe("時刻 0..24(現地太陽時。6/18 時が日の出/日の入り = 春分)。"),
      timeSpeed: z.number().optional().describe("Play 中に時刻を進める速さ [時間/秒]。0 = 止める。"),
      latitudeDeg: z.number().optional().describe("緯度(-90..90。北が正)。"),
      dayOfYear: z.number().optional().describe("年内通日 1..366(81 = 春分)。"),
      northYawDeg: z.number().optional().describe("ワールド +Z が北から時計回りに何度ずれているか。"),
      sunMode: z.number().optional().describe("0 = 時刻から太陽の向きを決める / 1 = 太陽ライトの向きを直接指定。"),
      driveSun: z.boolean().optional().describe("太陽ライトの向き(sunMode=0)・色・強度を大気が決める。"),
      driveIBL: z.boolean().optional().describe("空を環境マップ(IBL/DDGI)へ反映する。"),
      drawStars: z.boolean().optional().describe("夜の星。"),
      drawMoon: z.boolean().optional().describe("夜の月。"),
      sunIlluminance: z.number().optional().describe("大気上端の太陽照度 [lux](既定 128000)。"),
      groundAlbedo: z.array(z.number()).optional().describe("地表アルベド [r,g,b]。"),
      aerialPerspective: z.boolean().optional().describe("遠景の霞(エアリアルパースペクティブ)。"),
      apStartDepth: z.number().optional().describe("霞を掛け始める距離 [m]。"),
      apMaxDistanceKm: z.number().optional().describe("霞の froxel が届く最大距離 [km]。"),
      apStrength: z.number().optional().describe("霞の濃さ倍率(1 = 物理どおり)。"),
    }).passthrough().optional().describe("物理ベース大気(Hillaire 2020)。指定したフィールドのみ適用。上記以外の物理パラメータ(planetRadiusKm / rayleighScattering / mieG など)も get_scene_settings の atmosphere と同じ名前で渡せる。"),
  },
  { idempotentHint: true },
  ({ skybox, atmosphere, decalAtlasPath, partition }) => run(async () => {
    const known = ["envMapPath", "iblIntensity", "skyboxIntensity", "drawSkybox"];
    const bad = unknownParamKeys(skybox, known);
    if (bad.length > 0) throw unknownKeyError("dx12_set_scene_settings skybox", bad, known);
    const clean = definedOnly(skybox ?? {});
    const atmoClean = definedOnly(atmosphere ?? {});
    const r = await engine.call("set_scene_settings",
      definedOnly({ skybox: skybox === undefined ? undefined : clean,
                    atmosphere: atmosphere === undefined ? undefined : atmoClean, decalAtlasPath,
                    partition: partition === undefined ? undefined : definedOnly(partition) })) as Record<string, unknown>;
    const current = await engine.call("get_scene_settings", {}).catch(() => null);
    // preset は値ではなく操作なので突き合わせから外す(適用後の個別項目は atmosphere に入っている)
    const { preset: _preset, ...atmoCheck } = atmoClean as Record<string, unknown>;
    const mismatched = verifyApplied({ skybox: clean, ...(atmosphere === undefined ? {} : { atmosphere: atmoCheck }),
                                      ...(partition === undefined ? {} : { partition: definedOnly(partition) }) }, current);
    return {
      applied: mismatched.length === 0,
      envMapRebake: r?.envMapRebake ?? false,
      current,
      ...(mismatched.length > 0
        ? { mismatched, hint: "要求した値がエンジンに入っていない。current の実値を見て次の手を決めること" }
        : {}),
    };
  }),
);
