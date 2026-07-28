// dx12_material_apply（PBR 4 点セットの一括割当）の純ロジック。
// fs も engine も触らない＝materialApply.test.ts からそのまま検証できる
// （sceneTools.ts / uiQuality.ts と同じ流儀）。
//
// ★なぜこのツールが要るか
//   MCP から PBR マテリアルを当てるには dx12_set_texture を 3〜4 回 + dx12_set_pbr を
//   叩く必要があり、往復が多すぎて実用にならなかった。ここでは
//   「ディレクトリを渡す → 中のファイル名から用途を推定 → まとめて割り当てる」までをやる。
//
// ★エンジン側の事実（src/core/Application.cpp を読んで確認した分）
//   - set_texture の slot は albedo / normal / metalRoughness の 3 つだけ
//     (Application.cpp:5521-5524)。height(disp) を割り当てる先はメッシュには無い。
//   - 描画側の PBR flags は
//       flags |= 1u … 法線マップ有り / flags |= 2u … metalRoughness テクスチャ有り
//     で、後者は【hasOverride が false のときだけ】立つ (Application.cpp:11617-11618)。
//       bool hasOverride = (overrideMetallic >= 0.0f || overrideRoughness >= 0.0f);
//       if (!hasOverride && mat && mat->metalRoughnessTexture) flags |= 2u;
//     つまり dx12_spawn_model 後などに metallic/roughness の【数値上書きが残っていると
//     ORM テクスチャが丸ごと無効化される】。-1 に戻す(=上書き解除)のが唯一の対処。
//     これを自動でやるのが planPbr()。

/** set_texture の slot と 1:1 で対応する用途 + メッシュには割り当てられない height。 */
export type TextureRole = "baseColor" | "normal" | "orm" | "height";

/** TextureRole → dx12_set_texture の slot 名。height は割当先が無いので null。 */
export const ROLE_TO_SLOT: Readonly<Record<TextureRole, string | null>> = {
  baseColor: "albedo",
  normal: "normal",
  orm: "metalRoughness",
  height: null,
};

export const ROLE_ORDER: readonly TextureRole[] = ["baseColor", "normal", "orm", "height"];

/**
 * ファイル名トークン → 用途。
 * 命名規則の出どころ:
 *   - Poly Haven（エンジン同梱のマテリアルライブラリが実際に保存する名前。
 *     src/editor/panels/MaterialLibraryPanel.cpp:305-349 → <id>_diff.jpg / <id>_nor_gl.png /
 *     <id>_arm.png。Web から直接落とすと <id>_diff_2k.jpg のように解像度が付く）
 *   - docs/AUTHORING.md §8（.dxmat の albedo/normal/metalRoughness）と §10.5.1
 *     （.terrainlayers の albedo/normal/arm/height。height は disp）
 *   - 一般的な PBR パック（albedo / basecolor / ORM / RMA / displacement …）
 * 1 文字略号（d/n/h）は誤爆が多すぎるので入れない。
 */
const ROLE_TOKENS: Readonly<Record<TextureRole, readonly string[]>> = {
  baseColor: ["diff", "diffuse", "albedo", "basecolor", "basecolour", "color", "colour", "col"],
  normal: ["nor", "normal", "normals", "norm", "nrm", "normalgl", "norgl"],
  orm: ["arm", "orm", "rma", "mra", "metalroughness", "metallicroughness", "metalrough", "roughmetal"],
  height: ["disp", "displacement", "height", "heightmap", "bump"],
};

/**
 * 法線マップの規約を示すトークン。gl(既定)は素通し、dx はこのエンジンでは使えない。
 * nor_gl / nor_dx のように用途トークンの直後に付く。
 */
const NORMAL_DX_TOKENS = ["dx", "directx"];

/**
 * 「用途は分かるがエンジンが単体では受け取れない」トークン。
 * 無視した理由を具体的に言うために持つ（黙って捨てないのがこのサーバの方針）。
 */
const KNOWN_UNSUPPORTED: Readonly<Record<string, string>> = {
  ao: "AO 単体テクスチャ。エンジンは ORM(arm) の R チャンネルとしてしか読まない",
  ambientocclusion: "AO 単体テクスチャ。ORM(arm) にパックされたものを使う",
  occlusion: "AO 単体テクスチャ。ORM(arm) にパックされたものを使う",
  rough: "roughness 単体テクスチャ。エンジンは ORM(arm) の G チャンネルを読む",
  roughness: "roughness 単体テクスチャ。エンジンは ORM(arm) の G チャンネルを読む",
  metal: "metallic 単体テクスチャ。エンジンは ORM(arm) の B チャンネルを読む",
  metallic: "metallic 単体テクスチャ。エンジンは ORM(arm) の B チャンネルを読む",
  metalness: "metallic 単体テクスチャ。エンジンは ORM(arm) の B チャンネルを読む",
  spec: "specular ワークフローのテクスチャ。エンジンは metallic-roughness ワークフローのみ",
  specular: "specular ワークフローのテクスチャ。エンジンは metallic-roughness ワークフローのみ",
  gloss: "glossiness ワークフローのテクスチャ。エンジンは metallic-roughness ワークフローのみ",
  glossiness: "glossiness ワークフローのテクスチャ。エンジンは metallic-roughness ワークフローのみ",
  emissive: "エミッシブは MeshRenderer のテクスチャスロットに無い",
  emission: "エミッシブは MeshRenderer のテクスチャスロットに無い",
  opacity: "不透明度テクスチャのスロットは無い(半透明は dx12_set_mesh_shader の alphaBlend)",
  alpha: "不透明度テクスチャのスロットは無い(半透明は dx12_set_mesh_shader の alphaBlend)",
  mask: "マスクテクスチャのスロットは無い",
  preview: "プレビュー用サムネイル",
  thumb: "プレビュー用サムネイル",
  thumbnail: "プレビュー用サムネイル",
};

/** 解像度や汎用語など、用途判定に使わないトークン。 */
const NEUTRAL_TOKEN = /^(?:\d+k|\d+|tex|texture|map|maps|material|mat|png|jpg|jpeg|tga|dds|bmp)$/;

/** パス/ファイル名 → 小文字トークン列（拡張子も 1 トークンとして残す。NEUTRAL で落ちる）。 */
export function tokenizeTextureName(filePath: string): string[] {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

export type RoleGuess = {
  role: TextureRole | null;
  /** 判定の決め手になったトークン（説明用）。 */
  token: string | null;
  /** role が null のときの理由。返り値の ignored[].reason にそのまま載る。 */
  reason?: string;
};

/**
 * ファイル名から用途を推定する。
 *
 * ★最後にマッチしたトークンを採る。PBR パックの命名は「素材名_用途_解像度」で
 *   用途が後ろに来るため（"arm_chair_diff_2k.jpg" は arm(=素材名の一部) ではなく diff）。
 * ★法線は OpenGL 規約のみ。nor_dx は【無視せずに理由付きで弾く】
 *   (shaders/common/PBR.hlsli の PerturbNormal が G 反転しない = docs/AUTHORING.md §8)。
 */
export function guessTextureRole(filePath: string): RoleGuess {
  const tokens = tokenizeTextureName(filePath);
  let role: TextureRole | null = null;
  let token: string | null = null;
  let roleIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (NEUTRAL_TOKEN.test(t)) continue;
    for (const r of ROLE_ORDER) {
      if ((ROLE_TOKENS[r] as readonly string[]).includes(t)) { role = r; token = t; roleIdx = i; }
    }
  }
  if (role === "normal") {
    // 規約トークンは用途トークンの直後に来る（nor_gl / nor_dx）。前方に出ることは無い。
    if (tokens.slice(roleIdx + 1).some((t) => NORMAL_DX_TOKENS.includes(t))) {
      return {
        role: null, token,
        reason: "DirectX 規約の法線マップ(nor_dx)。このエンジンのシェーダは OpenGL 規約なので nor_gl を使う",
      };
    }
  }
  if (role) return { role, token };

  for (const t of tokens) {
    if (KNOWN_UNSUPPORTED[t]) return { role: null, token: t, reason: KNOWN_UNSUPPORTED[t] };
  }
  return {
    role: null, token: null,
    reason: "ファイル名から用途を推定できない(diff/albedo, nor_gl, arm/orm, disp/height のどれかを含む名前が要る)。"
      + "baseColor/normal/orm を直接指定すれば確実",
  };
}

export type IgnoredFile = { path: string; reason: string };
export type ResolvedTextures = Partial<Record<TextureRole, string>>;

export type ResolveResult = {
  /** 用途 → assets 相対パス。 */
  textures: ResolvedTextures;
  /** 用途ごとに「明示指定」か「ディレクトリからの推定」か。 */
  source: Partial<Record<TextureRole, "explicit" | "dir">>;
  /** 使わなかったファイルと、その理由。黙って捨てない。 */
  ignored: IgnoredFile[];
};

/**
 * 明示パス + ディレクトリ内のファイル一覧 → 用途別のテクスチャ集合。
 *
 * - 明示指定が常に優先。ディレクトリ側の同用途候補は ignored に理由付きで落ちる。
 * - 同じ用途の候補が複数あったら【ソート順の先頭】を採る（1k < 2k < 4k なので既定は軽い方）。
 *   採らなかった分も ignored に出すので、AI は明示指定で上書きできる。
 */
export function resolveTextureSet(input: {
  files?: readonly string[];
  explicit?: ResolvedTextures;
}): ResolveResult {
  const textures: ResolvedTextures = {};
  const source: ResolveResult["source"] = {};
  const ignored: IgnoredFile[] = [];

  for (const r of ROLE_ORDER) {
    const p = input.explicit?.[r];
    if (p) { textures[r] = p; source[r] = "explicit"; }
  }

  const byRole = new Map<TextureRole, string[]>();
  for (const f of [...(input.files ?? [])].sort()) {
    const g = guessTextureRole(f);
    if (!g.role) { ignored.push({ path: f, reason: g.reason ?? "用途不明" }); continue; }
    const list = byRole.get(g.role) ?? [];
    list.push(f);
    byRole.set(g.role, list);
  }

  for (const [role, list] of byRole) {
    if (source[role] === "explicit") {
      for (const f of list) {
        ignored.push({ path: f, reason: `${role} は引数で明示指定されている(${textures[role]})のでディレクトリ側は使わない` });
      }
      continue;
    }
    textures[role] = list[0];
    source[role] = "dir";
    for (const f of list.slice(1)) {
      ignored.push({ path: f, reason: `同じ用途(${role})の候補が複数。${list[0]} を採用した(名前順の先頭)` });
    }
  }
  return { textures, source, ignored };
}

/** height はメッシュに割り当てるスロットが無い。理由を付けて ignored へ回すための定数。 */
export const HEIGHT_UNSUPPORTED_REASON =
  "メッシュに高さ/変位テクスチャのスロットが無い(dx12_set_texture の slot は albedo/normal/metalRoughness だけ)。"
  + "変位を使えるのは地形の .terrainlayers(docs/AUTHORING.md §10.5.1)のみ";

export type PbrPlan = {
  /** dx12_set_pbr へ渡す params（何もする必要が無ければ null）。 */
  call: { metallic?: number; roughness?: number; uvScaleU?: number; uvScaleV?: number } | null;
  /** ORM を効かせるためにスカラー上書きを -1 へ戻したか。 */
  clearedScalarOverride: boolean;
  warnings: string[];
};

/**
 * ★hasOverride の罠をここで畳む。
 *
 * エンジン(Application.cpp:11617-11618 / 11763-11764)は
 *   overrideMetallic >= 0 か overrideRoughness >= 0 のどちらかでも立っていると
 *   metalRoughness テクスチャの flags(=2u) を落とす。
 * dx12_spawn_model 経由のモデルはシーン JSON の material.metallic/roughness から
 * 上書きが入っていることが多く、その状態で ORM を割り当てても【何も変わらない】。
 *
 * 方針:
 *   - ORM を割り当てる & metallic/roughness の明示指定が無い → -1 を書いて上書きを解除する
 *     （エンジンは >= 0 でだけ上書き扱いなので -1 が「Material の値を使う」の意味。
 *       src/ecs/Components.h:83-84）
 *   - ORM を割り当てる & 明示指定あり → 指定を尊重するが、ORM が無効化されることを警告する
 *   - ORM 無し → metallic/roughness は触らない（現状維持）
 */
export function planPbr(opts: {
  hasOrm: boolean;
  metallic?: number;
  roughness?: number;
  uvScale?: number;
  uvScaleU?: number;
  uvScaleV?: number;
}): PbrPlan {
  const warnings: string[] = [];
  const call: NonNullable<PbrPlan["call"]> = {};
  let clearedScalarOverride = false;

  const u = opts.uvScaleU ?? opts.uvScale;
  const v = opts.uvScaleV ?? opts.uvScale;
  if (u !== undefined) call.uvScaleU = u;
  if (v !== undefined) call.uvScaleV = v;

  const explicitScalar = opts.metallic !== undefined || opts.roughness !== undefined;
  if (explicitScalar) {
    if (opts.metallic !== undefined) call.metallic = opts.metallic;
    if (opts.roughness !== undefined) call.roughness = opts.roughness;
    const stillOverriding = (opts.metallic ?? -1) >= 0 || (opts.roughness ?? -1) >= 0;
    if (opts.hasOrm && stillOverriding) {
      warnings.push(
        "metallic/roughness を明示指定したので ORM(metalRoughness) テクスチャは描画側で無効化される"
        + "(Application.cpp:11617 の hasOverride が flags から 2u を落とす)。"
        + "テクスチャを効かせたいなら metallic/roughness を省略するか -1 を渡すこと",
      );
    }
    if ((opts.metallic ?? -1) < 0 && (opts.roughness ?? -1) < 0 && opts.hasOrm) {
      clearedScalarOverride = true;
    }
  } else if (opts.hasOrm) {
    call.metallic = -1;
    call.roughness = -1;
    clearedScalarOverride = true;
  }

  return {
    call: Object.keys(call).length > 0 ? call : null,
    clearedScalarOverride,
    warnings,
  };
}

/** metallic/roughness の受け付け範囲（-1 = 上書き解除、0..1 = 値）。 */
export function validateScalar(nameOfArg: string, value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value)) return `${nameOfArg} は有限な数値で渡す`;
  if (value === -1) return null;
  if (value < 0 || value > 1) {
    return `${nameOfArg}=${value} は範囲外。0..1 か、上書きを解除する -1 のどちらか`;
  }
  return null;
}

/**
 * list_assets の結果からディレクトリ直下のファイルだけ取る。
 * 引数の dir は assets 相対（先頭/末尾の / は許容）。サブディレクトリは見ない
 * （素材フォルダは 1 階層＝Poly Haven ダウンローダが assets/textures/<id>/ に平置きする形）。
 */
export function filesDirectlyUnder(dir: string, assets: readonly { path: string }[]): string[] {
  const norm = dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = norm.length > 0 ? `${norm}/` : "";
  const out: string[] = [];
  for (const a of assets) {
    const p = String(a.path ?? "").replace(/\\/g, "/");
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest.length === 0 || rest.includes("/")) continue;
    out.push(p);
  }
  return out.sort();
}

/**
 * 「割り当てたパス」と「get_entity で読み返した materialTextureOverrides[submesh]」を突き合わせる。
 * get_entity は空文字の上書きをキーごと落とす(SceneSerializer.cpp:433-435)ので、
 * 要求したスロットだけを見る。
 */
export function verifyTextureOverrides(
  requestedSlots: Readonly<Record<string, string>>,
  overridesEntry: unknown,
): { key: string; requested: string; actual: unknown }[] {
  const out: { key: string; requested: string; actual: unknown }[] = [];
  const cur = (overridesEntry && typeof overridesEntry === "object" && !Array.isArray(overridesEntry))
    ? overridesEntry as Record<string, unknown>
    : {};
  for (const [slot, want] of Object.entries(requestedSlots)) {
    const got = cur[slot];
    if (got !== want) out.push({ key: `materialTextureOverrides[${slot}]`, requested: want, actual: got });
  }
  return out;
}
