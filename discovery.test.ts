// dx12_tool_search の発見性テスト(設計書 付録 A の代表 30 タスク)。エンジン不要・決定論。
//   eval/discovery_tasks.json: 各タスクに日本語の言い換え 2 通り(queries)と、辞書調整に使っていない英語/口語の 1 通り(holdout)。
//   判定: 上位 3 件に許容ツールが入る率(recall@3)>= 90%。queries だけ / holdout だけでも 85% 以上。
//   M3: Core 面(shell 5 本 + Core)だけを対象にした検索でも、Core で届くタスクの recall@3 >= 90%(設計書 §5.2 M3 (d)④ のオフライン版)。
//        長尾のタスク(Core に無い)は全ツール対象の検索で届く。callTemplate が事前検証を通る率は 100%。
// 実行: node discovery.test.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DX12_MCP_PORT = "1";   // エンジンには繋がない(同梱スナップショット + 登録済みツールだけで検索する)
process.env.DX12_MCP_CONNECT_BACKOFF_MS = "0";   // 繋がらない前提なので接続の再試行を待たない(describe のたびに待つと遅い)
await import("./toolset/all.ts");
const { shell } = await import("./toolset/shell.ts");

let failed = 0;
let total = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  total++;
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 800)}` : ""}`); }
}

const tasks: { id: number; expect: string[]; queries: string[]; holdout?: string; design: string; core: string[] }[] =
  JSON.parse(fs.readFileSync(path.join(here, "eval", "discovery_tasks.json"), "utf8")).tasks;

function rankOf(q: string, expect: string[]): number {
  const hits = shell.index.search(q, { limit: 10 }).hits.map((h) => h.name);
  return hits.findIndex((h) => expect.includes(h));
}

function score(pick: (t: (typeof tasks)[number]) => string[]) {
  let n = 0, at1 = 0, at3 = 0, at5 = 0;
  const misses: string[] = [];
  for (const t of tasks) for (const q of pick(t)) {
    n++;
    const r = rankOf(q, t.expect);
    if (r === 0) at1++;
    if (r >= 0 && r < 3) at3++; else misses.push(`#${t.id} "${q}" rank=${r}`);
    if (r >= 0 && r < 5) at5++;
  }
  return { n, r1: at1 / n, r3: at3 / n, r5: at5 / n, misses };
}

console.log("[1] 検索の前提");
check("カタログに旧 220 ツールと shell 5 本がある", shell.catalog.docs.filter((d) => d.tier === "legacy").length === 220 && shell.catalog.docs.filter((d) => d.tier === "shell").length === 5);
check("エンジンのマニフェスト(同梱スナップショット)が取り込まれている", shell.deps.manifest.current?.source === "snapshot" && shell.deps.manifest.current.count > 150, shell.deps.manifest.current?.source);
check("付録 A の 30 タスク × (言い換え 2 + holdout 1)", tasks.length === 30 && tasks.every((t) => t.queries.length === 2 && !!t.holdout && t.expect.length > 0));
check("許容ツールがすべて実在する", tasks.every((t) => t.expect.every((n) => shell.catalog.resolve(n))), tasks.flatMap((t) => t.expect).filter((n) => !shell.catalog.resolve(n)));
{
  const a = JSON.stringify(shell.index.search("ブルームを調整", { limit: 8 }).hits.map((h) => [h.name, h.score]));
  const b = JSON.stringify(shell.index.search("ブルームを調整", { limit: 8 }).hits.map((h) => [h.name, h.score]));
  check("決定論: 同じ問い合わせは同じ順位・同じスコア", a === b);
}

console.log("[2] recall@3");
const main = score((t) => t.queries);
const hold = score((t) => (t.holdout ? [t.holdout] : []));
const all = score((t) => [...t.queries, ...(t.holdout ? [t.holdout] : [])]);
console.log(`      日本語の言い換え ${main.n} 件: recall@1=${(main.r1 * 100).toFixed(1)}% recall@3=${(main.r3 * 100).toFixed(1)}% recall@5=${(main.r5 * 100).toFixed(1)}%`);
console.log(`      holdout(英語/口語) ${hold.n} 件: recall@1=${(hold.r1 * 100).toFixed(1)}% recall@3=${(hold.r3 * 100).toFixed(1)}% recall@5=${(hold.r5 * 100).toFixed(1)}%`);
console.log(`      合計 ${all.n} 件: recall@1=${(all.r1 * 100).toFixed(1)}% recall@3=${(all.r3 * 100).toFixed(1)}% recall@5=${(all.r5 * 100).toFixed(1)}%`);
check(`合計 recall@3 >= 90%(${(all.r3 * 100).toFixed(1)}%)`, all.r3 >= 0.9, all.misses);
check(`日本語の言い換えだけでも recall@3 >= 90%(${(main.r3 * 100).toFixed(1)}%)`, main.r3 >= 0.9, main.misses);
check(`holdout だけでも recall@3 >= 85%(${(hold.r3 * 100).toFixed(1)}%)`, hold.r3 >= 0.85, hold.misses);

console.log("[3] 名前・別名・カテゴリの当たり方");
{
  const top = (q: string, opts: Record<string, unknown> = {}) => shell.index.search(q, opts as any).hits.map((h) => h.name);
  check("旧ツール名そのもの(dx12_set_ssao)は先頭", top("dx12_set_ssao")[0] === "dx12_set_ssao");
  check("dx12_ 無し(screenshot_final)も先頭", top("screenshot_final")[0] === "dx12_screenshot_final");
  check("エンジン method 名(describe_mcp_manifest)でヒット(TS ラッパ無し)", top("describe_mcp_manifest").includes("describe_mcp_manifest"));
  check("effect=guarded で絞ると guarded だけ", top("git", { effect: "guarded" }).every((n) => shell.catalog.resolve(n)?.effectClass === "guarded") && top("git", { effect: "guarded" }).length > 0);
  check("category=terrain で絞ると terrain だけ", shell.index.search("地形", { category: "terrain", limit: 20 }).hits.every((h) => h.category === "terrain"));
  check("tier=core は tools/list に載る面(shell 5 本 + Core)だけ", shell.index.search("検索", { tier: "core", limit: 30 }).hits.every((h) => h.tier === "shell" || h.tier === "core") && shell.index.search("ブルーム", { tier: "core", limit: 30 }).hits.length > 0);
  check("0 件のクエリは didYouMean/categories を返す", (() => { const r = shell.index.search("zzzzqqqq"); return r.hits.length === 0 && Array.isArray(r.categories); })());
}

console.log("[4] Core 面の選択率(オフライン・決定論): shell 5 本 + Core だけを対象に、日本語/英語の依頼 → 上位 3 件");
{
  const coreTasks = tasks.filter((t) => t.core.length > 0);
  const longTail = tasks.filter((t) => t.core.length === 0);
  const rankIn = (q: string, accept: string[]) => shell.index.search(q, { limit: 10, tier: "core" }).hits.map((h) => h.name).findIndex((h) => accept.includes(h));
  let n = 0, at1 = 0, at3 = 0;
  const misses: string[] = [];
  for (const t of coreTasks) for (const q of [...t.queries, ...(t.holdout ? [t.holdout] : [])]) {
    n++;
    const r = rankIn(q, t.core);
    if (r === 0) at1++;
    if (r >= 0 && r < 3) at3++; else misses.push(`#${t.id} "${q}" rank=${r}`);
  }
  console.log(`      Core で届くタスク ${coreTasks.length} 件 / ${n} クエリ: Core 面のみの recall@1=${(at1 / n * 100).toFixed(1)}% recall@3=${(at3 / n * 100).toFixed(1)}%`);
  check(`Core 面のみの検索で recall@3 >= 90%(${(at3 / n * 100).toFixed(1)}%)`, at3 / n >= 0.9, misses);
  let ln = 0, l3 = 0;
  const lmiss: string[] = [];
  for (const t of longTail) for (const q of [...t.queries, ...(t.holdout ? [t.holdout] : [])]) {
    ln++;
    const r = rankOf(q, t.expect);
    if (r >= 0 && r < 3) l3++; else lmiss.push(`#${t.id} "${q}" rank=${r}`);
  }
  console.log(`      長尾のタスク ${longTail.length} 件 / ${ln} クエリ: 全ツール検索(dx12_tool_search)の recall@3=${(l3 / ln * 100).toFixed(1)}%`);
  check(`長尾のタスクは dx12_tool_search で届く(recall@3 >= 90%: ${(l3 / ln * 100).toFixed(1)}%)`, l3 / ln >= 0.9, lmiss);
  // 総合 = Core で届くタスクは Core 面の検索、長尾は全ツール検索。「正しいツールを選べる率」
  const overall = (at3 + l3) / (n + ln);
  console.log(`      総合の選択率(Core は Core 面、長尾は全ツール検索): ${((at3 + l3) / (n + ln) * 100).toFixed(1)}% (${at3 + l3}/${n + ln})`);
  check(`総合の選択率 >= 90%(${(overall * 100).toFixed(1)}%)`, overall >= 0.9);
  // 各 Core タスクの正解ツールを dx12_tool_describe すると、callTemplate がそのまま事前検証を通る(dx12_call の往復が要らない)
  const bad: string[] = [];
  for (const name of [...new Set(coreTasks.flatMap((t) => t.core))]) {
    const doc = shell.catalog.resolve(name);
    const r: any = await shell.describe({ name });
    const d = JSON.parse(r.content[0].text);
    const tpl = d.callTemplate;
    const entry = shell.deps.registry.get(doc!.id);
    if (!entry) { if (doc!.kind !== "shell") bad.push(`${name}: registry に無い`); continue; }
    const { validateAgainstShape } = await import("./validate.ts");
    const v = validateAgainstShape(entry.name, entry.shape, tpl.args);
    // 統合ツール(dx12_set_render_settings 等)は values の中身が旧ツール側の検証になる。callTemplate の外側の形だけを見る。
    if (!v.ok && !doc!.consolidated) bad.push(`${name}: ${JSON.stringify(v.body.issues ?? v.body.message).slice(0, 160)}`);
    if (!v.ok && doc!.consolidated) bad.push(`${name}(統合): ${v.body.message}`);
  }
  check("Core タスクの正解ツールの callTemplate が事前検証を通る(100%)", bad.length === 0, bad);
}

console.log("[5] フリート(専用エンジンの管理)ツールの発見性(eval/fleet_tasks.json)");
{
  const ft: { id: string; expect: string[]; core: boolean; queries: string[]; holdout: string }[] = JSON.parse(fs.readFileSync(path.join(here, "eval", "fleet_tasks.json"), "utf8")).tasks;
  check("フリートのタスクの許容ツールがすべて実在する", ft.every((t) => t.expect.every((n) => shell.catalog.resolve(n))));
  let n = 0, all3 = 0, core3 = 0, cn = 0;
  const miss: string[] = [];
  for (const t of ft) for (const q of [...t.queries, t.holdout]) {
    n++;
    const r = rankOf(q, t.expect);
    if (r >= 0 && r < 3) all3++; else miss.push(`${t.id} "${q}" rank=${r}`);
    if (t.core) {
      cn++;
      const rc = shell.index.search(q, { limit: 10, tier: "core" }).hits.map((h) => h.name).findIndex((h) => t.expect.includes(h));
      if (rc >= 0 && rc < 3) core3++; else miss.push(`(core 面) ${t.id} "${q}" rank=${rc}`);
    }
  }
  console.log(`      フリート ${ft.length} タスク / ${n} クエリ: 全ツール検索 recall@3=${(all3 / n * 100).toFixed(1)}% / Core 面のみ recall@3=${(core3 / cn * 100).toFixed(1)}%`);
  check(`フリートのツールは全ツール検索で recall@3 >= 90%(${(all3 / n * 100).toFixed(1)}%)`, all3 / n >= 0.9, miss);
  check(`Core 面のみの検索でも recall@3 >= 90%(${(core3 / cn * 100).toFixed(1)}%)`, core3 / cn >= 0.9, miss);
  check("dx12_engine_use は Core 面の検索に出ない(長尾)が、全ツール検索では出る", !shell.index.search("既定のエンジンを切り替える", { limit: 20, tier: "core" }).hits.some((h) => h.name === "dx12_engine_use") && shell.index.search("既定のエンジンを切り替える", { limit: 5 }).hits.some((h) => h.name === "dx12_engine_use"));
  check("既存の 30 タスクの選択率は下がっていない(フリートのツールが割り込まない)", main.r3 >= 0.9 && hold.r3 >= 0.85);
}

console.log("[6] ジョブ API(dx12_job_*)の発見性(eval/job_tasks.json)");
{
  const jt: { id: string; expect: string[]; core: boolean; queries: string[]; holdout: string }[] = JSON.parse(fs.readFileSync(path.join(here, "eval", "job_tasks.json"), "utf8")).tasks;
  check("ジョブのタスクの許容ツールがすべて実在する", jt.every((t) => t.expect.every((n) => shell.catalog.resolve(n))));
  let n = 0, all3 = 0, core3 = 0, cn = 0;
  const miss: string[] = [];
  for (const t of jt) for (const q of [...t.queries, t.holdout]) {
    n++;
    const r = rankOf(q, t.expect);
    if (r >= 0 && r < 3) all3++; else miss.push(`${t.id} "${q}" rank=${r}`);
    if (t.core) {
      cn++;
      const rc = shell.index.search(q, { limit: 10, tier: "core" }).hits.map((h) => h.name).findIndex((h) => t.expect.includes(h));
      if (rc >= 0 && rc < 3) core3++; else miss.push(`(core 面) ${t.id} "${q}" rank=${rc}`);
    }
  }
  console.log(`      ジョブ ${jt.length} タスク / ${n} クエリ: 全ツール検索 recall@3=${(all3 / n * 100).toFixed(1)}% / Core 面のみ recall@3=${(core3 / cn * 100).toFixed(1)}%`);
  check(`ジョブのツールは全ツール検索で recall@3 >= 90%(${(all3 / n * 100).toFixed(1)}%)`, all3 / n >= 0.9, miss);
  check(`Core 面のみの検索でも recall@3 >= 90%(${(core3 / cn * 100).toFixed(1)}%)`, core3 / cn >= 0.9, miss);
  const tail = ["dx12_job_list", "dx12_job_result", "dx12_job_logs"];
  const qs = ["ジョブの一覧と履歴を見たい", "終わったジョブの結果の全文を読みたい", "失敗したジョブのログの末尾を見たい"];
  check("dx12_job_list / result / logs は Core 面の検索に出ない(長尾)が、全ツール検索では出る", qs.every((q, i) => !shell.index.search(q, { limit: 20, tier: "core" }).hits.some((h) => h.name === tail[i]) && shell.index.search(q, { limit: 5 }).hits.some((h) => h.name === tail[i])));
  check("既存の 30 タスクの選択率は下がっていない(ジョブのツールが割り込まない)", main.r3 >= 0.9 && hold.r3 >= 0.85);
}

console.log("[7] エディタ操作(dx12_editor_*)の発見性(eval/editor_tasks.json)");
{
  const et: { id: string; expect: string[]; core: boolean; queries: string[]; holdout: string }[] = JSON.parse(fs.readFileSync(path.join(here, "eval", "editor_tasks.json"), "utf8")).tasks;
  check("エディタ操作のタスクの許容ツールがすべて実在する", et.every((t) => t.expect.every((n) => shell.catalog.resolve(n))));
  check("エディタ操作は 6 タスク以上 × (言い換え 2 + holdout 1)", et.length >= 6 && et.every((t) => t.queries.length === 2 && !!t.holdout));
  let n = 0, all3 = 0, core3 = 0, cn = 0;
  const miss: string[] = [];
  for (const t of et) for (const q of [...t.queries, t.holdout]) {
    n++;
    const r = rankOf(q, t.expect);
    if (r >= 0 && r < 3) all3++; else miss.push(`${t.id} "${q}" rank=${r}`);
    if (t.core) {
      cn++;
      const rc = shell.index.search(q, { limit: 10, tier: "core" }).hits.map((h) => h.name).findIndex((h) => t.expect.includes(h));
      if (rc >= 0 && rc < 3) core3++; else miss.push(`(core 面) ${t.id} "${q}" rank=${rc}`);
    }
  }
  console.log(`      エディタ操作 ${et.length} タスク / ${n} クエリ: 全ツール検索 recall@3=${(all3 / n * 100).toFixed(1)}% / Core 面のみ recall@3=${(core3 / cn * 100).toFixed(1)}%`);
  check(`エディタ操作は全ツール検索で recall@3 >= 90%(${(all3 / n * 100).toFixed(1)}%)`, all3 / n >= 0.9, miss);
  check(`Core 面のみの検索でも recall@3 >= 90%(${(core3 / cn * 100).toFixed(1)}%)`, core3 / cn >= 0.9, miss);
  const tail = [["dx12_editor_notify", "作業が終わったことをエディタの画面に通知したい"], ["dx12_editor_select", "名前が Wall で始まるものをまとめて選択したい"], ["dx12_editor_modal", "開いているダイアログを閉じたい"], ["dx12_engine_list", "起動中のエンジンの一覧と空き VRAM を見たい"], ["dx12_play_script", "入力の台本でゴールまで行けるか確かめる"]];
  check("dx12_editor_notify / select / modal と、M7 で長尾へ移した dx12_engine_list / dx12_play_script は Core 面の検索に出ない(長尾)が、全ツール検索では出る",
    tail.every(([name, q]) => !shell.index.search(q, { limit: 20, tier: "core" }).hits.some((h) => h.name === name) && shell.index.search(q, { limit: 5 }).hits.some((h) => h.name === name)));
  check("dx12_editor_command / dx12_editor_state は Core(tools/list に載る面)にある", ["dx12_editor_command", "dx12_editor_state"].every((n) => shell.catalog.resolve(n)?.core === true));
  check("旧 dx12_select_entity は残り、複数選択・クエリは dx12_editor_select へ案内する(検索で dx12_editor_select が上位)", !!shell.catalog.resolve("dx12_select_entity") && shell.index.search("複数のエンティティを選択したい", { limit: 3 }).hits.some((h) => h.name === "dx12_editor_select"));
  check("既存の 30 タスクの選択率は下がっていない(エディタ操作のツールが割り込まない)", main.r3 >= 0.9 && hold.r3 >= 0.85);
}

console.log("[8] 宣言的シーン生成(dx12_apply_scene_spec / dx12_scene_spec_export)の発見性(eval/scene_spec_tasks.json)");
{
  const st: { id: string; expect: string[]; core: boolean; queries: string[]; holdout: string }[] = JSON.parse(fs.readFileSync(path.join(here, "eval", "scene_spec_tasks.json"), "utf8")).tasks;
  check("シーン仕様のタスクの許容ツールがすべて実在する", st.every((t) => t.expect.every((n) => shell.catalog.resolve(n))));
  check("シーン仕様は 8 タスク × (言い換え 2 + holdout 1)", st.length >= 8 && st.every((t) => t.queries.length === 2 && !!t.holdout));
  let n = 0, all3 = 0, core3 = 0, cn = 0;
  const miss: string[] = [];
  for (const t of st) for (const q of [...t.queries, t.holdout]) {
    n++;
    const r = rankOf(q, t.expect);
    if (r >= 0 && r < 3) all3++; else miss.push(`${t.id} "${q}" rank=${r}`);
    if (t.core) {
      cn++;
      const rc = shell.index.search(q, { limit: 10, tier: "core" }).hits.map((h) => h.name).findIndex((h) => t.expect.includes(h));
      if (rc >= 0 && rc < 3) core3++; else miss.push(`(core 面) ${t.id} "${q}" rank=${rc}`);
    }
  }
  console.log(`      シーン仕様 ${st.length} タスク / ${n} クエリ: 全ツール検索 recall@3=${(all3 / n * 100).toFixed(1)}% / Core 面のみ recall@3=${(core3 / cn * 100).toFixed(1)}%`);
  check(`シーン仕様は全ツール検索で recall@3 >= 90%(${(all3 / n * 100).toFixed(1)}%)`, all3 / n >= 0.9, miss);
  check(`Core 面のみの検索でも recall@3 >= 90%(${(core3 / cn * 100).toFixed(1)}%)`, core3 / cn >= 0.9, miss);
  check("dx12_apply_scene_spec は Core(tools/list に載る面)・dx12_scene_write と dx12_scene_spec_export は長尾", shell.catalog.resolve("dx12_apply_scene_spec")?.core === true && shell.catalog.resolve("dx12_scene_write")?.core !== true && shell.catalog.resolve("dx12_scene_spec_export")?.core !== true);
  check("dx12_scene_write は「シーン JSON を直接書く」で全ツール検索の上位 3 件に残る(長尾でも見つかる)", shell.index.search("シーン JSON をファイルへ直接書き出す", { limit: 3 }).hits.some((h) => h.name === "dx12_scene_write"));
  check("既存の 30 タスクの選択率は下がっていない(シーン仕様のツールが割り込まない)", main.r3 >= 0.9 && hold.r3 >= 0.85);
}

if (failed) { console.log(`\nNG: ${failed}/${total} 件失敗`); process.exit(1); }
console.log(`\nOK: 発見性テスト ${total} 項目すべて通過`);
process.exit(0);
