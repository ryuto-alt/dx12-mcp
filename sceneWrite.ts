// シーン JSON を直接書き出すための検証・要約ロジック(純関数。fs も engine も触らない)。
//
// なぜ要るか: MCP で 1 体ずつ spawn すると 1 体につき 1 フレーム(遅延同期)かかる。
// 100 体並べると 100 フレーム待つ。シーン JSON を書いて open_scene 1 回の方が桁違いに速い。
// ただし手書き JSON は「キー名を 1 文字間違えると無言で無視される」のが最大の罠なので、
// 書く前にここで潰す。
//
// スキーマの出典は src/scene/SceneSerializer.cpp:
//   - BuildSceneJson         … ルートキー(version/entities/postProcess/skybox/shadows/ssao/
//                              contactShadow/taa/ssr/ssgi/volumetricFog)
//   - SerializeEntityJson    … エンティティのキー
//   - RegisterCoreComponentSerializers … 反射登録された部品のキー(pointLight/rigidBody/uiText …)
//   - InstantiateEntityJson  … 復元時の分岐(gridPlane > terrain > sculpt > meshRenderer > primitive)
//   - LoadFromString         … parent は「entities 配列のインデックス」
//
// 「打ち間違いキーに近い正解を添える」ロジックは MCP ツールの引数検査でも同じものが要るので
// paramGuard.ts へ移した(ここは後方互換のため再エクスポートする)。

import { editDistance, nearestKey } from "./paramGuard.ts";
export { editDistance, nearestKey } from "./paramGuard.ts";

// ── スキーマ定数(SceneSerializer.cpp と 1:1) ─────────────────────
export const SCENE_ROOT_KEYS = [
  "version", "entities", "postProcess", "skybox", "shadows", "ssao", "prefab",
  // ↓ BuildSceneJson は昔から書いているのにここに無く、エンジン自身が書いたシーンに対して
  //   「ルートの未知キー」警告を出していた（取りこぼし。まとめて追加）。
  "contactShadow", "taa", "ssr", "ssgi", "volumetricFog", "decalAtlas",
  // ↓ 同じ取りこぼしが 3 回目。BuildSceneJson が root["shadowPcss"] / root["raytracing"] を
  //   書くようになったのにここへ足し忘れると、エンジン自身が保存したシーンを読み込んだだけで
  //   「ルートの未知キー」警告が出る。schemaDrift.test.ts [11] が SceneSerializer.cpp の
  //   root["..."] 代入と突き合わせるので、次からは足し忘れた時点でテストが赤くなる。
  "shadowPcss", "raytracing",
] as const;

/** 反射登録されたコア部品の JSON キー(RegisterCoreComponentSerializers の登録順)。 */
export const REFLECTED_COMPONENT_KEYS = [
  "pointLight", "directionalLight", "spotLight",
  "rigidBody", "boxCollider", "sphereCollider", "capsuleCollider", "characterController",
  "sprite2d", "trailRenderer", "decal", "networkIdentity", "networkTransform",
  "uiCanvas", "uiRect", "uiImage", "uiText", "uiButton", "uiSlider", "uiToggle",
  "uiScrollView", "uiLayout", "uiAnimator", "uiAnimPlayer", "spriteAnimator",
  "prefabLink", "camera",
  // ★この2つが抜けていて、dx12_scene_write が「未知キー(エンジンに無視される)」という
  //   嘘の警告を出していた。エンジンは SceneSerializer.cpp:267/269 で両方シリアライズしている。
  //   schemaDrift はルートキーしか照合していないので検出できていなかった。
  "animatorController", "footIK",
] as const;

/** SerializeEntityJson が直接書くキー。 */
export const ENTITY_OWN_KEYS = [
  "name", "transform", "parent",
  // 安定 ID（16 桁の hex 文字列）。parentGuid が親参照の正で、parent(index) は
  // 旧エンジン互換のために残っている冗長情報。手書きするなら parentGuid を優先すること。
  // ★数値ではなく文字列。u64 を JSON 数値で書くと JS 側が double へ丸めて下位ビットを失う。
  "guid", "parentGuid",
  "primitive", "meshRenderer",
  "shader", "shaderAlphaBlend", "shaderEffectValue", "shaderParams",
  "materialTextureOverrides", "materialAssets",
  "color", "material", "uvTiling", "uvScroll", "flipbook",
  "terrain", "sculpt", "gridPlane",
  "gimmick", "audioSource", "particleEmitter", "trigger",
  "convexHullCollider", "luaScript", "tags", "data",
] as const;

export const ENTITY_KEYS: readonly string[] = [...ENTITY_OWN_KEYS, ...REFLECTED_COMPONENT_KEYS];

export const PRIMITIVES = ["box", "sphere", "plane"] as const;

// ── 型 ───────────────────────────────────────────────────────────
export type SceneSummary = {
  version: number | null;
  entityCount: number;
  /** 生成方法の内訳(InstantiateEntityJson の分岐と同じ区分)。 */
  byKind: Record<string, number>;
  /** 付いているコンポーネントの内訳(キー名 → 個数)。 */
  byComponent: Record<string, number>;
  /** 参照しているモデルパス(assets 相対、重複除去・ソート済み)。 */
  modelPaths: string[];
  /** 参照している Lua スクリプトパス(同上)。 */
  scriptPaths: string[];
  /** 親を持つエンティティ数。 */
  parentedCount: number;
  /** ルート設定の有無。 */
  hasPostProcess: boolean;
  hasSkybox: boolean;
  hasSsao: boolean;
  shadows: boolean | null;
};

export type SceneValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: SceneSummary;
};

export type ValidateOptions = {
  /**
   * エンジンの dx12_list_assets が返した assets 相対パスの一覧。
   * 渡すと meshRenderer.modelPath / luaScript.scriptPath の実在確認までやる。
   * 省略すると参照確認は「未実施」の warning になる(黙って通さない)。
   */
  knownAssets?: readonly string[];
};

// ── ヘルパ ───────────────────────────────────────────────────────
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isVec(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/** assets 相対パスとして妥当か(engine の open_scene / ValidateMcpAssetRelPath と同じ制約)。 */
export function isSafeAssetRelPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0
    && p[0] !== "/" && !p.includes("\\") && !p.includes(":") && !p.includes("..");
}

/** 復元時にどの分岐で作られるかを返す(InstantiateEntityJson の if-else の順序と同じ)。 */
export function entityKind(e: Record<string, unknown>): string {
  if ("gridPlane" in e) return "gridPlane";
  if ("terrain" in e) return "terrain";
  if ("sculpt" in e) return "sculpt";
  if ("meshRenderer" in e) return "model";
  if ("primitive" in e) return `primitive:${String((e as any).primitive)}`;
  if ("directionalLight" in e || "pointLight" in e || "spotLight" in e) return "light";
  if ("camera" in e) return "camera";
  return "empty";
}

/** シーン JSON の要約(壊す前に「何を壊すのか」を数字で言うため)。 */
export function summarizeScene(root: unknown): SceneSummary {
  const summary: SceneSummary = {
    version: null, entityCount: 0, byKind: {}, byComponent: {},
    modelPaths: [], scriptPaths: [], parentedCount: 0,
    hasPostProcess: false, hasSkybox: false, hasSsao: false, shadows: null,
  };
  if (!isPlainObject(root)) return summary;

  if (typeof root.version === "number") summary.version = root.version;
  summary.hasPostProcess = isPlainObject(root.postProcess);
  summary.hasSkybox = isPlainObject(root.skybox);
  summary.hasSsao = isPlainObject(root.ssao);
  if (typeof root.shadows === "boolean") summary.shadows = root.shadows;

  const entities = Array.isArray(root.entities) ? root.entities : [];
  summary.entityCount = entities.length;

  const models = new Set<string>();
  const scripts = new Set<string>();
  for (const e of entities) {
    if (!isPlainObject(e)) continue;
    const kind = entityKind(e);
    summary.byKind[kind] = (summary.byKind[kind] ?? 0) + 1;
    if (typeof e.parent === "number") summary.parentedCount++;
    for (const k of Object.keys(e)) {
      if (k === "name" || k === "transform" || k === "parent") continue;
      summary.byComponent[k] = (summary.byComponent[k] ?? 0) + 1;
    }
    const mr = e.meshRenderer;
    if (isPlainObject(mr) && typeof mr.modelPath === "string" && mr.modelPath) models.add(mr.modelPath);
    const ls = e.luaScript;
    if (isPlainObject(ls) && typeof ls.scriptPath === "string" && ls.scriptPath) scripts.add(ls.scriptPath);
  }
  summary.modelPaths = [...models].sort();
  summary.scriptPaths = [...scripts].sort();
  return summary;
}

/**
 * シーン JSON を「エンジンに渡す前に」検証する。
 * errors が 1 つでもあれば書かない(呼び出し側の責務)。warnings は書いてよいが読ませる。
 *
 * ★方針: エンジン側は壊れたキーを【無言でスキップ】する(Logger::Warn が出るだけで
 *   MCP からは見えない)。だからここで「無視される」を全部 error / warning にして拾う。
 */
export function validateSceneJson(root: unknown, opts: ValidateOptions = {}): SceneValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(root)) {
    return {
      ok: false,
      errors: ["シーン JSON のルートがオブジェクトではない。{ version:1, entities:[...] } の形にする"],
      warnings, summary: summarizeScene(root),
    };
  }

  // ── ルート ──
  for (const k of Object.keys(root)) {
    if ((SCENE_ROOT_KEYS as readonly string[]).includes(k)) continue;
    const near = nearestKey(k, SCENE_ROOT_KEYS);
    warnings.push(`ルートの未知キー "${k}" はエンジンに無視される${near ? `。"${near}" の打ち間違い?` : ""}`);
  }
  if (root.version === undefined) {
    warnings.push('ルートに "version" が無い。SceneSerializer は version:1 を書く。付けておくこと');
  } else if (root.version !== 1) {
    warnings.push(`version が ${JSON.stringify(root.version)}。エンジンが書くのは 1`);
  }
  if (root.shadows !== undefined && typeof root.shadows !== "boolean") {
    errors.push('"shadows" は bool。数値や文字列だと LoadFromString が既定(true)に落ちる');
  }
  for (const k of ["postProcess", "skybox", "ssao",
                   "contactShadow", "taa", "ssr", "ssgi", "volumetricFog",
                   "shadowPcss", "raytracing"] as const) {
    if (root[k] !== undefined && !isPlainObject(root[k])) {
      errors.push(`"${k}" はオブジェクト。今は ${Array.isArray(root[k]) ? "配列" : typeof root[k]}`);
    }
  }

  // ── entities ──
  if (root.entities === undefined) {
    errors.push('"entities" 配列が無い。空でも [] を書く(無いとエンジンは「entities がありません」で何も作らない)');
  } else if (!Array.isArray(root.entities)) {
    errors.push('"entities" は配列。オブジェクトやマップでは読めない');
  }

  const entities = Array.isArray(root.entities) ? root.entities : [];
  const assets = opts.knownAssets ? new Set(opts.knownAssets) : null;
  const nameSeen = new Map<string, number>();

  entities.forEach((raw, i) => {
    const at = `entities[${i}]`;
    if (!isPlainObject(raw)) {
      errors.push(`${at} がオブジェクトではない`);
      return;
    }
    const e = raw;

    // 名前(MCP は name 指定で操作するので、無名は後で触れなくなる)
    if (typeof e.name !== "string" || e.name.trim() === "") {
      errors.push(`${at} に "name"(空でない文字列)が無い。エンジンは "Unnamed" にするが、name 指定で操作できなくなる`);
    } else {
      const prev = nameSeen.get(e.name);
      if (prev !== undefined) {
        warnings.push(`${at} の name "${e.name}" が entities[${prev}] と重複。dx12_find_entity は先に見つかった方しか返さない`);
      } else {
        nameSeen.set(e.name, i);
      }
    }

    // transform
    if (e.transform === undefined) {
      warnings.push(`${at} に "transform" が無い。原点・無回転・スケール 1 で作られる`);
    } else if (!isPlainObject(e.transform)) {
      errors.push(`${at}.transform はオブジェクト {position,rotation,scale}`);
    } else {
      for (const k of ["position", "rotation", "scale"] as const) {
        const v = (e.transform as Record<string, unknown>)[k];
        if (v !== undefined && !isVec(v, 3)) {
          errors.push(`${at}.transform.${k} は有限な数値 3 つの配列 [x,y,z]`);
        }
      }
      if (isVec((e.transform as any).scale, 3) && (e.transform as any).scale.some((v: number) => v === 0)) {
        warnings.push(`${at}.transform.scale に 0 がある。ピッキングのレイが素通りし、見えない/選べないエンティティになる`);
      }
      for (const k of Object.keys(e.transform as object)) {
        if (["position", "rotation", "scale"].includes(k)) continue;
        warnings.push(`${at}.transform の未知キー "${k}" は無視される(有効: position / rotation / scale)`);
      }
    }

    // parent(配列インデックス参照)
    if (e.parent !== undefined) {
      if (typeof e.parent !== "number" || !Number.isInteger(e.parent)) {
        errors.push(`${at}.parent は整数(entities 配列のインデックス)。entityId でも name でもない`);
      } else if (e.parent < 0 || e.parent >= entities.length) {
        errors.push(`${at}.parent = ${e.parent} が範囲外(0..${entities.length - 1})`);
      } else if (e.parent === i) {
        errors.push(`${at}.parent が自分自身を指している`);
      }
    }

    // 生成分岐が競合していないか(先勝ちなので後ろのキーが無言で捨てられる)
    const kindKeys = ["gridPlane", "terrain", "sculpt", "meshRenderer", "primitive"].filter((k) => k in e);
    if (kindKeys.length > 1) {
      warnings.push(
        `${at} に生成キーが複数ある(${kindKeys.join(", ")})。エンジンは ` +
        `gridPlane > terrain > sculpt > meshRenderer > primitive の順で先勝ちにし、残りは無視する`,
      );
    }

    // primitive
    if (e.primitive !== undefined) {
      if (typeof e.primitive !== "string" || !(PRIMITIVES as readonly string[]).includes(e.primitive)) {
        errors.push(`${at}.primitive は ${PRIMITIVES.join(" / ")} のどれか。今は ${JSON.stringify(e.primitive)}`);
      }
    }

    // meshRenderer(モデル参照)
    if (e.meshRenderer !== undefined) {
      if (!isPlainObject(e.meshRenderer)) {
        errors.push(`${at}.meshRenderer はオブジェクト { modelPath: "models/foo.gltf" }`);
      } else {
        const mp = (e.meshRenderer as Record<string, unknown>).modelPath;
        if (typeof mp !== "string" || mp === "") {
          errors.push(`${at}.meshRenderer.modelPath が無い/空。assets 相対パスを書く(例 "models/tree.gltf")`);
        } else if (!isSafeAssetRelPath(mp)) {
          errors.push(`${at}.meshRenderer.modelPath "${mp}" は assets 相対パスにする(先頭 "/"・"\\"・":"・".." は不可、区切りは "/")`);
        } else if (assets && !assets.has(mp)) {
          const near = nearestAsset(mp, opts.knownAssets!);
          errors.push(
            `${at}.meshRenderer.modelPath "${mp}" が assets に無い(dx12_list_assets に不在)。` +
            `参照切れのエンティティは【生成そのものが失敗して丸ごと消える】` +
            (near ? `。"${near}" のこと?` : "。dx12_list_assets type:\"model\" で正しいパスを確認する"),
          );
        }
      }
    }

    // luaScript
    if (e.luaScript !== undefined) {
      if (!isPlainObject(e.luaScript)) {
        errors.push(`${at}.luaScript はオブジェクト { scriptPath: "components/Foo.lua" }`);
      } else {
        const sp = (e.luaScript as Record<string, unknown>).scriptPath;
        if (typeof sp !== "string" || sp === "") {
          errors.push(`${at}.luaScript.scriptPath が無い/空`);
        } else if (!isSafeAssetRelPath(sp)) {
          errors.push(`${at}.luaScript.scriptPath "${sp}" は assets 相対パスにする`);
        } else if (assets && !assets.has(sp)) {
          const near = nearestAsset(sp, opts.knownAssets!);
          errors.push(
            `${at}.luaScript.scriptPath "${sp}" が assets に無い` +
            (near ? `。"${near}" のこと?` : "。dx12_list_assets type:\"script\" で確認する"),
          );
        }
        const props = (e.luaScript as Record<string, unknown>).props;
        if (props !== undefined && !Array.isArray(props)) {
          errors.push(`${at}.luaScript.props は [{name,type,value}, ...] の配列`);
        }
      }
    }

    // 色 / マテリアル
    if (e.color !== undefined && !isVec(e.color, 3)) {
      errors.push(`${at}.color は [r,g,b](0..1 の数値 3 つ)`);
    }
    if (e.material !== undefined) {
      if (!isPlainObject(e.material)) {
        errors.push(`${at}.material はオブジェクト { metallic, roughness }`);
      } else {
        for (const k of ["metallic", "roughness"] as const) {
          const v = (e.material as Record<string, unknown>)[k];
          if (v === undefined) continue;
          if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${at}.material.${k} は数値`);
          else if (v < 0 || v > 1) warnings.push(`${at}.material.${k} = ${v} が 0..1 の外`);
        }
      }
    }

    // tags は「文字列の配列」(AGENTS.md のよくある間違い)
    if (e.tags !== undefined && (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== "string"))) {
      errors.push(`${at}.tags は文字列の配列 ["enemy","boss"]。オブジェクト形式では読めない`);
    }

    // 反射登録の部品はオブジェクトでないと丸ごと無視される
    for (const k of REFLECTED_COMPONENT_KEYS) {
      if (k in e && !isPlainObject(e[k])) {
        errors.push(`${at}.${k} はオブジェクト。今は ${Array.isArray(e[k]) ? "配列" : typeof e[k]} なので無言で無視される`);
      }
    }

    // 地形 / スカルプト(実データは別ファイル)
    if (isPlainObject(e.terrain) && !(e.terrain as any).heightmapPath) {
      warnings.push(`${at}.terrain.heightmapPath が無い。高さ配列(.hf)が読めず平坦な地形になる`);
    }
    if (isPlainObject(e.sculpt) && !(e.sculpt as any).meshPath) {
      warnings.push(`${at}.sculpt.meshPath が無い。頂点配列(.smsh)が読めず素体の球になる`);
    }

    // 未知キー(タイプミスの本丸)
    for (const k of Object.keys(e)) {
      if (ENTITY_KEYS.includes(k)) continue;
      const near = nearestKey(k, ENTITY_KEYS);
      warnings.push(`${at} の未知キー "${k}" はエンジンに無視される${near ? `。"${near}" の打ち間違い?` : ""}`);
    }
  });

  // 親子の循環(自己参照は上で弾いたので、ここは 2 段以上の輪)
  const cycle = findParentCycle(entities);
  if (cycle) {
    errors.push(`親子関係が循環している: ${cycle.map((i) => `entities[${i}]`).join(" → ")}`);
  }

  if (!opts.knownAssets) {
    warnings.push(
      "参照アセットの実在確認をしていない(knownAssets 未指定)。" +
      "参照切れのモデルはエンティティごと消えるので、可能なら dx12_list_assets の結果を渡すこと",
    );
  }

  return { ok: errors.length === 0, errors, warnings, summary: summarizeScene(root) };
}

/** parent チェーンの循環を 1 つ見つける(見つからなければ null)。 */
function findParentCycle(entities: unknown[]): number[] | null {
  const parentOf = entities.map((e) => {
    if (!isPlainObject(e)) return -1;
    const p = e.parent;
    return typeof p === "number" && Number.isInteger(p) && p >= 0 && p < entities.length ? p : -1;
  });
  const state = new Int8Array(entities.length);   // 0=未訪問 1=探索中 2=完了
  for (let start = 0; start < entities.length; start++) {
    if (state[start] !== 0) continue;
    const stack: number[] = [];
    let cur = start;
    while (cur !== -1 && state[cur] === 0) {
      state[cur] = 1;
      stack.push(cur);
      cur = parentOf[cur];
    }
    if (cur !== -1 && state[cur] === 1) {
      return stack.slice(stack.indexOf(cur)).concat(cur);
    }
    for (const n of stack) state[n] = 2;
  }
  return null;
}

/** 参照切れパスに一番近い実在アセットを返す(ファイル名一致 → 編集距離)。 */
export function nearestAsset(p: string, known: readonly string[]): string | null {
  const base = p.split("/").pop()!.toLowerCase();
  const sameName = known.filter((k) => k.split("/").pop()!.toLowerCase() === base);
  if (sameName.length > 0) return sameName[0];
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = editDistance(p.toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= Math.max(3, Math.floor(p.length / 3)) ? best : null;
}

// ── パス解決(fs は触らない。候補を返すだけ) ─────────────────────
/**
 * 絶対パスから assets ディレクトリを推定する。".../assets/..." の "assets" までを返す。
 * 例: C:/game/PerfTest/assets/scenes/main.json → C:/game/PerfTest/assets
 */
export function assetsDirFromScenePath(absScenePath: string): string | null {
  const norm = absScenePath.replace(/\\/g, "/");
  const m = norm.match(/^(.*\/assets)\//i);
  return m ? m[1] : null;
}

// ★削除: assetsDirCandidatesFromLog(エンジンログの絶対パスから assets を推定するハック)。
//   エンジンが dx12_ping で assetsDir を返すようになった(protocolVersion 4 / #20-3)ので不要。
//   ログ由来の推定は「別プロジェクトの古い行を掴む」「ログが流れると失敗する」
//   「裏取りできない時に当てずっぽうを返す」の三重に不確かで、置き換えるべきものだった。

/** シーンの書き出し先として妥当な相対パスか(scenes/ 配下の .json を推奨)。 */
export function checkScenePath(rel: string): { ok: boolean; error?: string; warning?: string } {
  if (!isSafeAssetRelPath(rel)) {
    return { ok: false, error: `path "${rel}" は assets 相対にする(先頭 "/"・"\\"・":"・".." は不可、区切りは "/")` };
  }
  if (!/\.json$/i.test(rel)) {
    return { ok: false, error: `path "${rel}" の拡張子が .json ではない。dx12_open_scene は .json しか開けない` };
  }
  if (!/^scenes\//i.test(rel)) {
    return { ok: true, warning: `"${rel}" は scenes/ 配下ではない。dx12_list_scenes は assets/scenes/ 配下しか列挙しない` };
  }
  return { ok: true };
}
