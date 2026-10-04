// ビルド/検証パイプライン連携とグループ分け・命名規則
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import path from "node:path";
import { z } from "zod";
import { conventionText, type EntityInfo, findNameReferences, GROUP_ORDER, type GroupKey, GROUPS, lintNames, planOrganize } from "../sceneOrganize.ts";
import fs from "node:fs";
import { engine, entityId, reg, run } from "./core.ts";
import { ensureGroupRoot } from "./spawn.ts";

// ════════════════════════════════════════════════════════════════
//  ビルド/検証パイプライン連携
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_validate_scene",
  "シーン検証",
  "シーン JSON の参照グラフをヘッドレスで検証する(CLI `--validate` と同じロジックをエンジン自身の子プロセスとして実行)。スクリプトパス存在・entity参照プロパティ解決・Trigger の filter/action target 解決・LoadScene 等のシーンパス存在をチェック。path 省略時は現在開いているシーン。{pass, exitCode, report, scenePath}。report はテキストレポート全文(PASS/FAIL・[info]/[warn]/[ERROR] 行)。編集→検証→修正のループに使う。子プロセスとして起動する(GPU初期化前に終了するので実行中のエディタと並行しても安全)。",
  { path: z.string().optional().describe("assets 相対パス。省略時は現在開いているシーン。") },
  { readOnlyHint: true },
  ({ path }) => run(() => engine.call("validate_scene", { path })),
);

// ════════════════════════════════════════════════════════════════
//  グループ分けと命名規則（共同開発でシーンを読める形に保つ）
// ════════════════════════════════════════════════════════════════

/** list_entities + get_hierarchy から親付きのフラット一覧を作る。 */
async function collectEntities(): Promise<EntityInfo[]> {
  const list = await engine.call("list_entities", { verbose: true, limit: 0 });
  const hier = await engine.call("get_hierarchy", { limit: 0 });
  const parentOf = new Map<number, number>();
  const walk = (node: any, parent?: number) => {
    if (parent != null) parentOf.set(node.entityId, parent);
    for (const c of node.children ?? []) walk(c, node.entityId);
  };
  for (const r of hier.roots ?? []) walk(r);
  return (list.entities ?? []).map((e: any) => ({
    entityId: e.entityId,
    name: e.name,
    componentTypes: e.componentTypes ?? [],
    parent: parentOf.get(e.entityId),
  }));
}

/**
 * プロジェクトの .lua を全部読む（改名してよいかの判定に使う）。
 * 読めなければ空配列＝「参照が分からない」なので、呼び出し側は**改名を控える**方へ倒すこと。
 */
async function readProjectLuaSources(): Promise<string[]> {
  const ping = await engine.call("ping", {});
  const dirs = [ping?.scriptsDir, ping?.assetsDir].filter(Boolean) as string[];
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let names: fs.Dirent[];
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name.startsWith(".")) continue;
        await walk(full, depth + 1);
      } else if (d.name.toLowerCase().endsWith(".lua")) {
        try { out.push(await fs.promises.readFile(full, "utf8")); } catch { /* 読めないものは無視 */ }
      }
    }
  };
  for (const d of dirs) await walk(d, 0);
  return out;
}

reg(
  "dx12_scene_scaffold",
  "シーン骨格の生成",
  "共同開発用のグループ骨格（LVL / ENV / LIGHT / GAMEPLAY / FX / UI / CAMERA の空エンティティ）を作る。既にあるものは作らないので何度撃っても安全。★グループのルートは必ず原点・無回転・スケール1で作る(set_parent はワールド座標を保持しないため、単位変換でないルートにぶら下げると物がワープする)。返り値に命名規約の説明も入るので、シーンを作り始める前にこれを 1 回撃つのが既定の手順。{groups:[{key, root, entityId, created}], convention}。",
  {
    only: z.array(z.enum(["ENV", "LVL", "LGT", "GP", "FX", "UI", "CAM"])).optional()
      .describe("作るグループを絞る。省略で 7 つ全部。"),
  },
  {},
  ({ only }) =>
    run(async () => {
      const want = (only?.length ? only : GROUP_ORDER) as GroupKey[];
      const groups = [];
      for (const key of want) {
        const rootName = GROUPS[key].root;
        const found = await engine.call("find_entity", { name: rootName });
        if (found?.entityId != null) {
          groups.push({ key, root: rootName, entityId: found.entityId, created: false });
          continue;
        }
        const made = await engine.call("create_entity", { type: "empty", name: rootName });
        groups.push({ key, root: rootName, entityId: made.entityId, created: true });
      }
      return { groups, convention: conventionText() };
    }),
);

reg(
  "dx12_organize_scene",
  "シーンの整理(グループ分け+改名)",
  "既存シーンを命名規約に沿って整理する。各エンティティをコンポーネント(名前より優先)で分類し、規約グループへ親付けして <PREFIX>_<Kind>_<NN> に改名する。★既定は dryRun:true = 計画を返すだけで何も変えない。中身を確認してから dryRun:false で適用すること。連番は既存の規約名を見て衝突しないよう採番し、既に規約どおりのものは触らない(＝何度撃っても同じ結果に収束する)。子(グループ以外の親を持つもの)は親ごと動くので触らない。★プロジェクトの .lua を全部読み、文字列として出てくる名前は【改名しない】(Lua の scene:findEntity は名前で引くうえ、見つからなくても nil ではなく無効な Entity を返すので、改名すると『エラーも出ずに OnUpdate の残りが動かない』最悪の壊れ方をする)。その分はグループ分けだけ行い notes と protectedNames に出る。{applied, moves:[{entityId, oldName, newName, group, reparent, locked}], untouched, protectedNames, luaFilesScanned, convention}。",
  {
    dryRun: z.boolean().optional().describe("true(既定)=計画だけ返す / false=実際に適用する。"),
    rename: z.boolean().optional().describe("false で改名せずグループ分けだけ行う。既定 true。"),
  },
  { destructiveHint: true },
  ({ dryRun, rename }) =>
    run(async () => {
      const entities = await collectEntities();
      // ★改名は Lua の findEntity を壊しうる。プロジェクトの .lua に文字列として
      //   出てくる名前は改名対象から外す（外した分は notes に理由が出る）。
      const luaSources = await readProjectLuaSources();
      const protectedNames = findNameReferences(luaSources, entities.map((e) => e.name));
      const plan = planOrganize(entities, { rename, protectedNames });
      const guard = { luaFilesScanned: luaSources.length, protectedNames: [...protectedNames] };
      if (dryRun !== false)
        return { applied: false, dryRun: true, ...plan, ...guard, convention: conventionText(),
                 next: "内容を確認したら dryRun:false で適用する" };

      // 親付け先を先に用意する（無いグループだけ作る）
      const rootIds = new Map<GroupKey, number>();
      for (const g of plan.groupsNeeded) rootIds.set(g, await ensureGroupRoot(g));

      let moved = 0, renamed = 0;
      for (const m of plan.moves) {
        if (m.reparent) {
          const parent = rootIds.get(m.group) ?? (await ensureGroupRoot(m.group));
          rootIds.set(m.group, parent);
          await engine.call("set_parent", { entity: m.entityId, parent });
          moved++;
        }
        if (m.newName !== m.oldName) {
          await engine.call("rename_entity", { entity: m.entityId, name: m.newName });
          renamed++;
        }
      }
      return { applied: true, dryRun: false, moved, renamed, ...plan, ...guard,
               convention: conventionText() };
    }),
);

reg(
  "dx12_validate_naming",
  "命名規約の検査",
  "命名とグループ分けの崩れを数える。DEFAULT_NAME(Box / Cube.001 のまま)・NO_PREFIX(役割の接頭辞が無い)・DUPLICATE_NAME(name 指定も Lua の findEntity も当たり先が不定になる)・BAD_CHARS(空白 / 非 ASCII)・NOT_IN_GROUP(ルート直下に浮いている)。直すのは dx12_organize_scene。{pass, issues:[{entityId, name, kind, text}], counts, convention}。",
  {},
  { readOnlyHint: true },
  () =>
    run(async () => {
      const entities = await collectEntities();
      const issues = lintNames(entities);
      const counts: Record<string, number> = {};
      for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      return { pass: issues.length === 0, checked: entities.length, issues, counts,
               convention: conventionText() };
    }),
);
