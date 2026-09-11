/**
 * シーンのグループ分けと命名規則（純関数）。
 *
 * なぜ規約を機械で持つのか（2026-09-10 にユーザーと合意）:
 *   AI に置かせると `Box` `Box_2` `Sphere` が原点付近に散らばったシーンができる。
 *   それでも動きはするが、**共同開発者が開いた瞬間に何がどれか分からない**。
 *   規約を文章で書いても AI は毎回読まないので、
 *     ① 生成時に group を渡せる（spawn_* / create_entity の group 引数）
 *     ② 後からでも organize_scene で一括整理できる
 *     ③ validate_naming で違反が数えられる（放置すると数が増える＝気づける）
 *   の 3 点で機械化する。判定はここに集約し、TS 側だけで完結させる（エンジン再ビルド不要）。
 *
 * 規約:
 *   ルート直下は 7 つの空グループだけ。全エンティティはそのどれかにぶら下がる。
 *   名前は <PREFIX>_<Kind>_<NN>。例: ENV_Rock_03 / LVL_Platform_07 / GP_Enemy_Slime_01
 *   ・PREFIX は下の GROUPS のキー
 *   ・Kind は英数字のみ（空白・日本語・ドットは使わない＝Lua の findEntity と grep が効く）
 *   ・NN は 2 桁ゼロ埋めの通し番号。1 個しか無いものは省略してよい（GP_Player 等）
 */

export type GroupKey = "ENV" | "LVL" | "LGT" | "GP" | "FX" | "UI" | "CAM";

export interface GroupDef {
  /** グループのルートエンティティ名（= 階層に見える名前） */
  root: string;
  /** 何を入れるか（AI と人間の両方が読む説明） */
  what: string;
}

export const GROUPS: Record<GroupKey, GroupDef> = {
  ENV: { root: "ENV", what: "背景・装飾。当たり判定が要らない見せ物（岩・草・家具・小物）" },
  LVL: { root: "LVL", what: "レベル形状。床・壁・足場・階段・坂。**当たり判定を持つ**のが原則" },
  LGT: { root: "LIGHT", what: "ライト（directional / point / spot）" },
  GP: { root: "GAMEPLAY", what: "遊びに絡むもの。プレイヤー・敵・アイテム・トリガー・スポーン地点" },
  FX: { root: "FX", what: "エフェクト。パーティクル・トレイル・デカール" },
  UI: { root: "UI", what: "ゲーム内 UI（uiCanvas 以下）" },
  CAM: { root: "CAMERA", what: "カメラ" },
};

export const GROUP_ORDER: GroupKey[] = ["LVL", "ENV", "LGT", "GP", "FX", "UI", "CAM"];

/** ルート名 → プレフィックス（organize が既存グループを見つけるのに使う） */
export const ROOT_TO_PREFIX = new Map<string, GroupKey>(
  (Object.entries(GROUPS) as [GroupKey, GroupDef][]).map(([k, v]) => [v.root, k]),
);

/** エディタ / エンジンが勝手に作る名前。「名前が付いていない」と同じ扱いにする。 */
const DEFAULT_NAMES = new Set([
  "box", "cube", "sphere", "plane", "entity", "gameobject", "empty", "object",
  "light", "camera", "mesh", "model", "node", "group", "untitled", "new entity",
]);

/** 名前が既定のまま（Box / Cube.001 / Sphere_2 等）か。 */
export function isDefaultName(name: string): boolean {
  const base = name.trim().toLowerCase()
    .replace(/[._-]?\d+$/, "")     // Cube.001 / Box_2 / Sphere-3 の連番を落とす
    .replace(/\s*\(\d+\)$/, "");   // "Box (2)"
  return DEFAULT_NAMES.has(base);
}

/** レベル形状っぽい語（名前からの推定に使う）。 */
const LEVEL_WORDS = [
  "floor", "ground", "wall", "platform", "stair", "step", "ceiling", "roof", "road",
  "bridge", "ramp", "slope", "pillar", "column", "block", "tile", "path", "corridor",
  "床", "壁", "足場", "階段", "天井", "地面", "橋", "坂",
];
const GAMEPLAY_WORDS = [
  "player", "enemy", "boss", "npc", "item", "coin", "key", "door", "goal", "start",
  "spawn", "checkpoint", "pickup", "weapon", "bullet", "trigger", "zone", "target",
  "プレイヤー", "敵", "ゴール", "鍵", "扉", "アイテム",
];
const FX_WORDS = ["fx", "vfx", "particle", "smoke", "fire", "spark", "trail", "decal", "explosion"];

function hasWord(name: string, words: string[]): boolean {
  const n = name.toLowerCase();
  return words.some((w) => n.includes(w));
}

export interface EntityInfo {
  entityId: number;
  name: string;
  componentTypes?: string[];
  /** 親の entityId（ルートなら未定義） */
  parent?: number;
}

/**
 * 編集用の内部エンティティか。整理も lint も検査もしてはいけない。
 * gridPlane はエディタのビューポートにしか出ない床で、シーンの一部ではない
 * （読み込み時に size を無視して常に作り直される）。
 */
export function isInternal(e: EntityInfo): boolean {
  return (e.componentTypes ?? []).includes("gridPlane");
}

/**
 * どのグループへ入れるべきかを決める。
 * コンポーネントを名前より優先する（名前は嘘をつくがコンポーネントは嘘をつかない）。
 */
export function classify(e: EntityInfo): GroupKey {
  const c = new Set(e.componentTypes ?? []);
  const any = (...keys: string[]) => keys.some((k) => c.has(k));

  if (any("uiCanvas", "uiRect", "uiImage", "uiText", "uiButton", "uiSlider", "uiToggle", "uiScrollView"))
    return "UI";
  if (any("camera")) return "CAM";
  if (any("directionalLight", "pointLight", "spotLight")) return "LGT";
  if (any("particleEmitter", "trailRenderer", "decal")) return "FX";
  // trigger / キャラ / スクリプトが付いている＝遊びに絡む
  if (any("trigger", "characterController", "luaScript", "networkIdentity")) return "GP";
  if (hasWord(e.name, GAMEPLAY_WORDS)) return "GP";
  if (hasWord(e.name, FX_WORDS)) return "FX";
  // 地形とスカルプトはレベル形状そのもの
  if (any("terrain", "sculpt", "sculptMesh")) return "LVL";
  if (hasWord(e.name, LEVEL_WORDS)) return "LVL";
  // 静的な当たり判定を持つ＝歩ける/ぶつかる形状
  if (any("rigidBody", "boxCollider", "sphereCollider", "capsuleCollider")) return "LVL";
  return "ENV";
}

/** 名前から Kind 部分（英数字）を作る。日本語・空白・記号は落とす。 */
export function toKind(name: string, fallback: string): string {
  // 既に規約名なら Kind をそのまま取り出す（ENV_Rock_03 → Rock）
  const m = /^(ENV|LVL|LGT|GP|FX|UI|CAM)_(.+?)(?:_\d+)?$/.exec(name);
  const base = m ? m[2] : name;
  const cleaned = base
    .replace(/\.\d+$/, "")            // Blender の .001
    .replace(/[^A-Za-z0-9]+/g, "_")   // 空白・日本語・記号 → _
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (!cleaned || /^\d+$/.test(cleaned)) return fallback;
  // 先頭を大文字に（Rock / Platform）
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * 「名前で参照されている」エンティティ名を拾う。**改名してはいけない印**。
 *
 * なぜ要るか:
 *   このエンジンの参照は 2 系統ある。シーン JSON 内の参照は guid なので改名しても切れないが、
 *   **Lua は名前で引く**（`scene:findEntity("MainCamera")`）。ここを黙って改名すると、
 *   `findEntity` は nil ではなく**無効な Entity** を返す仕様なので `if not e then` を素通りし、
 *   続く `e.transform` で例外＝その OnUpdate の残り全部が無かったことになる。
 *   ＝「整理したら動かなくなった。しかもエラーが出ない」という最悪の壊れ方をする。
 *   だから **.lua に文字列として出てくる名前は絶対に改名しない**。
 *
 * sources は .lua の中身（と、名前で参照しうるシーン JSON の文字列）をそのまま渡す。
 */
export function findNameReferences(sources: string[], names: string[]): Set<string> {
  const referenced = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    // "Name" / 'Name' / `Name` のいずれかで出てきたら参照とみなす（完全一致のみ）
    const quoted = [`"${name}"`, `'${name}'`, "`" + name + "`"];
    if (sources.some((src) => quoted.some((q) => src.includes(q)))) referenced.add(name);
  }
  return referenced;
}

export interface RenamePlan {
  entityId: number;
  oldName: string;
  newName: string;
  group: GroupKey;
  reparent: boolean;
  /** Lua から名前で参照されているので改名を見送った */
  locked?: boolean;
}

export interface OrganizePlan {
  groupsNeeded: GroupKey[];
  moves: RenamePlan[];
  /** 触らないもの（既に規約どおり） */
  untouched: number;
  notes: string[];
}

/**
 * 整理の計画を立てる（適用はしない）。
 * 既にグループ配下に居て規約名のものは触らない＝何度撃っても同じ結果に収束する。
 */
export function planOrganize(
  entities: EntityInfo[],
  opts: { rename?: boolean; protectedNames?: Set<string> } = {},
): OrganizePlan {
  const rename = opts.rename !== false;
  const protectedNames = opts.protectedNames ?? new Set<string>();
  const byId = new Map(entities.map((e) => [e.entityId, e]));

  // グループのルート自身は対象外
  const groupRootIds = new Set(
    entities.filter((e) => ROOT_TO_PREFIX.has(e.name)).map((e) => e.entityId),
  );

  // 「既にどれかのグループの子孫か」を親チェーンで見る
  const groupOf = (e: EntityInfo): GroupKey | null => {
    let cur: EntityInfo | undefined = e;
    for (let d = 0; cur && d < 64; d++) {
      const g = ROOT_TO_PREFIX.get(cur.name);
      if (g && cur.entityId !== e.entityId) return g;
      cur = cur.parent != null ? byId.get(cur.parent) : undefined;
    }
    return null;
  };

  const moves: RenamePlan[] = [];
  const groupsNeeded = new Set<GroupKey>();
  const notes: string[] = [];
  let untouched = 0;

  // 連番はグループ+Kind ごとに振る。既存の規約名から使用済み番号を拾って衝突を避ける。
  const used = new Map<string, Set<number>>();
  for (const e of entities) {
    const m = /^(ENV|LVL|LGT|GP|FX|UI|CAM)_(.+?)_(\d+)$/.exec(e.name);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;
    if (!used.has(key)) used.set(key, new Set());
    used.get(key)!.add(parseInt(m[3], 10));
  }
  const nextNumber = (key: string): number => {
    if (!used.has(key)) used.set(key, new Set());
    const set = used.get(key)!;
    let n = 1;
    while (set.has(n)) n++;
    set.add(n);
    return n;
  };

  for (const e of entities) {
    if (groupRootIds.has(e.entityId)) continue;
    if (isInternal(e)) continue;                 // 編集用グリッドは触らない
    // 子（親がグループのルート以外）は親ごと動くので触らない
    if (e.parent != null && !groupRootIds.has(e.parent)) { untouched++; continue; }

    const g = classify(e);
    const currentGroup = groupOf(e);
    const needsReparent = currentGroup !== g;
    const conforms = /^(ENV|LVL|LGT|GP|FX|UI|CAM)_/.test(e.name) && !isDefaultName(e.name);
    // ★Lua が名前で引いているものは改名しない（findNameReferences の理由参照）。
    //   グループへ入れるのは参照を壊さないので、そちらだけやる。
    const locked = protectedNames.has(e.name);
    const needsRename = rename && !locked && (!conforms || !e.name.startsWith(`${g}_`));

    if (locked && rename && !conforms)
      notes.push(`"${e.name}" は Lua から名前で参照されているので改名しない（グループ分けだけ行う）`);

    if (!needsReparent && !needsRename) { untouched++; continue; }

    let newName = e.name;
    if (needsRename) {
      // 既定名（Box / Cube.001 / Light）から Kind を作っても意味が無いので、種別の既定語を使う。
      const kind = isDefaultName(e.name) ? defaultKindFor(g, e) : toKind(e.name, defaultKindFor(g, e));
      const key = `${g}_${kind}`;
      newName = `${g}_${kind}_${String(nextNumber(key)).padStart(2, "0")}`;
    }
    if (needsReparent) groupsNeeded.add(g);
    moves.push({ entityId: e.entityId, oldName: e.name, newName, group: g, reparent: needsReparent,
                 locked });
  }

  if (moves.length === 0) notes.push("すべて規約どおり。整理するものは無い");
  return { groupsNeeded: GROUP_ORDER.filter((g) => groupsNeeded.has(g)), moves, untouched, notes };
}

function defaultKindFor(g: GroupKey, e: EntityInfo): string {
  const c = new Set(e.componentTypes ?? []);
  if (g === "LGT") {
    if (c.has("directionalLight")) return "Sun";
    if (c.has("spotLight")) return "Spot";
    return "Point";
  }
  if (g === "CAM") return "Camera";
  if (g === "FX") return "Effect";
  if (g === "UI") return "Panel";
  if (g === "LVL") return "Block";
  if (g === "GP") return "Actor";
  return "Prop";
}

export interface NamingIssue {
  entityId: number;
  name: string;
  kind: "DEFAULT_NAME" | "NO_PREFIX" | "NOT_IN_GROUP" | "DUPLICATE_NAME" | "BAD_CHARS" | "WRONG_GROUP";
  text: string;
}

/** 命名規約の lint。organize を撃たずに「どれだけ崩れているか」だけ知りたいときに使う。 */
export function lintNames(entities: EntityInfo[]): NamingIssue[] {
  const issues: NamingIssue[] = [];
  const byId = new Map(entities.map((e) => [e.entityId, e]));
  const seen = new Map<string, number>();

  for (const e of entities) {
    if (ROOT_TO_PREFIX.has(e.name)) continue;   // グループのルート自身
    if (isInternal(e)) continue;                // 編集用グリッドは対象外

    const prev = seen.get(e.name);
    if (prev != null)
      issues.push({
        entityId: e.entityId, name: e.name, kind: "DUPLICATE_NAME",
        text: `"${e.name}" が複数ある（id ${prev} と ${e.entityId}）。name 指定の操作も Lua の findEntity も どちらに当たるか不定になる`,
      });
    seen.set(e.name, e.entityId);

    if (isDefaultName(e.name)) {
      issues.push({
        entityId: e.entityId, name: e.name, kind: "DEFAULT_NAME",
        text: `"${e.name}" は既定名のまま。何を置いたのか他人に伝わらない`,
      });
      continue;   // 既定名なら以下の指摘は重複するだけ
    }

    // ★接頭辞を要求するのは「1 個のオブジェクトとして立っているもの」だけ。
    //   親を持つ子（UI パネルの中身・モデルの部品）は organize_scene も触らない相手なので、
    //   ここで指摘だけすると『直せない指摘が延々と残る』ことになる（実際にそうなった:
    //   FPS テンプレートの HudScore / CrossDot 等が 9 件並んだ）。
    //   しかも UI の子は Lua が名前で引いていることが多く、改名は最初から選択肢に無い。
    const parentIsGroupRoot = e.parent == null || ROOT_TO_PREFIX.has(byId.get(e.parent)?.name ?? "");
    if (parentIsGroupRoot && !/^(ENV|LVL|LGT|GP|FX|UI|CAM)_/.test(e.name))
      issues.push({
        entityId: e.entityId, name: e.name, kind: "NO_PREFIX",
        text: `"${e.name}" に役割の接頭辞が無い（ENV_/LVL_/LGT_/GP_/FX_/UI_/CAM_ のどれか）`,
      });

    if (/[^\x20-\x7E]/.test(e.name) || /\s/.test(e.name))
      issues.push({
        entityId: e.entityId, name: e.name, kind: "BAD_CHARS",
        text: `"${e.name}" に空白か非 ASCII が入っている。grep と Lua の findEntity が扱いにくい`,
      });

    // どのグループにも属していない（ルート直下に浮いている）
    let inGroup = false;
    let cur: EntityInfo | undefined = e.parent != null ? byId.get(e.parent) : undefined;
    for (let d = 0; cur && d < 64; d++) {
      if (ROOT_TO_PREFIX.has(cur.name)) { inGroup = true; break; }
      cur = cur.parent != null ? byId.get(cur.parent) : undefined;
    }
    if (!inGroup && e.parent == null)
      issues.push({
        entityId: e.entityId, name: e.name, kind: "NOT_IN_GROUP",
        text: `"${e.name}" がルート直下に置かれている。dx12_organize_scene でグループへ入れること`,
      });
  }
  return issues;
}

/** AI にも人にも読ませる規約の説明（dx12_scene_scaffold / organize が返す）。 */
export function conventionText(): string {
  const lines = GROUP_ORDER.map((g) => `  ${GROUPS[g].root.padEnd(9)} (${g}_) … ${GROUPS[g].what}`);
  return [
    "命名規則: <PREFIX>_<Kind>_<NN>   例: ENV_Rock_03 / LVL_Platform_07 / GP_Enemy_Slime_01",
    "  ・Kind は英数字のみ（空白・日本語・ドットは使わない）",
    "  ・NN は 2 桁ゼロ埋めの通し番号。唯一のものは省略可（GP_Player）",
    "グループ（ルート直下はこの 7 つだけ）:",
    ...lines,
  ].join("\n");
}
