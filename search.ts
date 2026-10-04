// dx12_tool_search の検索エンジン。外部依存なし・決定論(同じ入力なら同じ順位)。
//
//   索引  : ASCII の単語 + 日本語(かな/漢字)は文字 bigram + 漢字 1 文字。カタカナはひらがなへ、全角は半角へ畳む。
//   順位  : BM25F 風(名前×3 / 題名×2.5 / 要約×2 / キーワード×2 / 別名×2 / カテゴリ×1 / 説明×0.7 / 引数名×1 / 引数説明×0.4)。
//   同義語: 日本語 ⇄ 英語の同義語辞書で問い合わせを広げる(「影」→ shadow、「元に戻す」→ undo など)。
//   0 件 : 最も近い名前とカテゴリを返す(did-you-mean)。
//
// 辞書と重みは eval/discovery_tasks.json(付録 A の代表タスク)の recall@3 で調整している。

import type { Catalog, EffectClass, ToolDoc } from "./catalog.ts";
import { nearest } from "./errors.ts";

// ── トークナイザ ─────────────────────────────────────────────────────────

const KATA_TO_HIRA = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

function fold(s: string): string {
  return KATA_TO_HIRA(s.normalize("NFKC").toLowerCase());
}

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
const KANJI = /[㐀-䶿一-鿿]/;
// 日本語の助詞・機能語だけの bigram はノイズなので落とす。
const STOP_BIGRAMS = new Set(["をす", "してい", "する", "した", "して", "ので", "から", "こと", "ため", "です", "ます", "でき", "にな", "れる", "され", "れた", "いる", "ある", "のこ", "のを", "をい", "にし", "とき", "など"]);

export function tokenize(text: string): string[] {
  const s = fold(text);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[a-z0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-z0-9]/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else if (CJK.test(c)) {
      let j = i;
      while (j < s.length && CJK.test(s[j])) j++;
      const run = s.slice(i, j);
      for (let k = 0; k < run.length; k++) {
        if (KANJI.test(run[k])) out.push(run[k]);                         // 漢字 1 文字(影/霧/光…)
        if (k + 1 < run.length) {
          const bi = run.slice(k, k + 2);
          if (!STOP_BIGRAMS.has(bi)) out.push(bi);
        }
      }
      i = j;
    } else i++;
  }
  return out;
}

/** 名前(snake_case)を単語に割る。dx12_set_post_process → ["dx12","set","post","process"] + 結合形。 */
function nameTokens(name: string): string[] {
  const parts = name.toLowerCase().split(/[_\-.\s]+/).filter(Boolean);
  const out = [...parts];
  const bare = parts[0] === "dx12" ? parts.slice(1) : parts;
  if (bare.length > 1) out.push(bare.join(""));
  return out;
}

// ── 同義語辞書 ────────────────────────────────────────────────────────────
// 各グループは「同じ意味の語」の集合。問い合わせにどれか 1 つが含まれていたら残りも足す。
// 日本語は部分一致(含まれていれば発火)、英字は単語一致。
export const SYNONYM_GROUPS: string[][] = [
  ["影", "シャドウ", "shadow", "shadows", "pcss", "contact_shadow"],
  ["霧", "フォグ", "fog", "volumetric_fog", "もや"],
  ["ブルーム", "bloom", "発光"],
  ["トーンマップ", "tonemap", "tonemapper", "露出", "exposure", "aces"],
  ["ポストプロセス", "ポスト処理", "ポスト", "post_process", "post", "postprocess", "画面効果", "後処理"],
  ["環境遮蔽", "ssao", "ambient occlusion", "遮蔽", "ao", "暗がり"],
  ["反射", "ssr", "reflection", "映り込み"],
  ["グローバルイルミネーション", "ssgi", "gi", "間接光", "ddgi"],
  ["レイトレ", "レイトレーシング", "dxr", "raytracing", "ray tracing"],
  ["アンチエイリアス", "taa", "antialiasing", "ジャギ"],
  ["太陽", "sun", "directional", "ディレクショナル", "日光", "平行光源"],
  ["ライト", "light", "lights", "照明", "灯り", "光源", "明かり", "ポイントライト", "pointlight", "スポットライト"],
  ["ライティング", "lighting", "雰囲気", "ムード", "夕暮れ", "夕焼け", "夜", "昼", "ホラー調", "ルック", "look", "絵作り", "色調"],
  ["空", "sky", "skybox", "スカイ", "環境マップ", "hdri"],
  ["スクリーンショット", "スクショ", "screenshot", "撮影", "撮る", "撮って", "キャプチャ", "capture", "画像", "写真", "絵を見る", "画面を見"],
  ["最終画", "final", "人が見る", "ポスト込み", "見た目"],
  ["視点", "カメラ", "camera", "アングル", "from", "位置から"],
  ["ログ", "log", "エラー", "error", "errors", "警告", "warning", "例外", "スクリプトエラー"],
  ["性能", "パフォーマンス", "performance", "fps", "フレームレート", "重い", "ボトルネック", "perf", "ベンチ", "benchmark", "計測"],
  ["再生", "プレイ", "play", "実行", "ゲームを動か", "起動して遊"],
  ["停止", "止める", "止めて", "stop", "ストップ", "エディタに戻"],
  ["台本", "スクリプト入力", "play_script", "断言", "assert", "入力の台本", "自動プレイ"],
  ["プレイテスト", "playtest", "回帰テスト", "テストプレイ", "保存済みのプレイ"],
  ["品質", "検査", "総合検査", "ゲート", "gate", "quality", "チェック", "監査", "audit", "仕上がり"],
  ["元に戻す", "取り消", "アンドゥ", "undo", "戻す", "巻き戻", "やり直し", "redo"],
  ["トランザクション", "transaction", "まとめて戻"],
  ["保存", "save", "セーブ", "書き出"],
  ["開く", "open", "ロード", "読み込", "load", "切り替え"],
  ["新規シーン", "new_scene", "空のシーン", "シーンを作"],
  ["シーン", "scene", "ステージ", "レベル", "マップ"],
  ["エンティティ", "entity", "オブジェクト", "object", "物体", "ゲームオブジェクト", "ノード"],
  ["一覧", "list", "列挙", "全部", "全て", "中身", "何がある", "何が置"],
  ["名前", "name", "リネーム", "rename", "改名"],
  ["削除", "delete", "消す", "消して", "remove", "除去", "デリート"],
  ["複製", "duplicate", "コピー", "clone", "複写"],
  ["位置", "座標", "transform", "position", "移動", "回転", "スケール", "rotation", "scale", "大きさ"],
  ["コンポーネント", "component", "components", "属性", "プロパティ"],
  ["箱", "ボックス", "box", "cube", "キューブ", "立方体", "直方体", "床", "壁", "足場", "platform"],
  ["球", "スフィア", "sphere", "ボール", "ball"],
  ["コイン", "coin", "円盤"],
  ["モデル", "model", "glb", "gltf", "fbx", "メッシュ", "mesh", "3d", "3dモデル", "obj"],
  ["プレハブ", "prefab", "テンプレート"],
  ["親子", "parent", "階層", "hierarchy", "グループ化", "group", "子"],
  ["散らす", "散布", "scatter", "ばら撒", "たくさん置", "大量", "100本", "何本も", "森", "群れ"],
  ["マテリアル", "material", "pbr", "テクスチャ", "texture", "質感", "素材", "金属", "粗さ", "roughness", "albedo", "木材", "貼る"],
  ["色", "カラー", "color", "colour", "着色", "塗る"],
  ["シェーダー", "shader", "hlsl", "カスタムシェーダ"],
  ["エフェクト", "vfx", "パーティクル", "particle", "particles", "炎", "火", "松明", "たいまつ", "煙", "火花", "爆発", "fire", "torch", "smoke", "魔法"],
  ["デカール", "decal", "汚れ", "傷", "弾痕", "焦げ", "血", "苔", "水たまり"],
  ["演出", "シーケンス", "sequence", "カットシーン", "cutscene", "台本から", "ムービー", "タイムライン", "timeline", "キーフレーム", "keyframe", "カメラワーク", "dxseq"],
  ["地形", "terrain", "山", "丘", "峡谷", "ハイトフィールド", "heightfield", "雪", "岩", "草", "レイヤー"],
  ["スカルプト", "sculpt", "彫る", "洞窟", "アーチ"],
  ["ナビメッシュ", "navmesh", "ナビゲーション", "経路", "パス", "path", "pathfinding", "焼く", "ベイク", "bake", "到達", "ゴールへ", "追いかけ"],
  ["到達", "reachable", "行ける", "届く", "詰み", "クリア可能"],
  ["lua", "スクリプト", "script", "ルア", "回転するスクリプト", "コンポーネントlua", "ゲームロジック", "挙動"],
  ["ui", "ユーザーインターフェース", "hud", "タイトル画面", "メニュー", "ボタン", "canvas", "画面ui", "ゲーム内ui", "ui_compose", "タイトル"],
  ["フォント", "font", "書体", "文字"],
  ["アセット", "asset", "assets", "ファイル", "インポート", "import", "取り込み", "取り込む"],
  ["blender", "ブレンダー", "モデリング", "自作モデル", "モデル作成"],
  ["エディタ", "editor", "imgui", "インスペクタ", "inspector", "ウィンドウ", "window", "パネル", "エディタui", "メニューバー"],
  ["クリック", "click", "押す", "ポインタ", "pointer", "マウス", "入力欄", "値欄", "ボタンを"],
  ["キー", "key", "キーボード", "keyboard", "ボタン入力", "入力"],
  ["接続", "繋がらない", "つながらない", "ping", "疎通", "doctor", "診断", "起動していない", "エンジンに", "生きてる", "ポート", "port"],
  ["ガイド", "guide", "使い方", "手順", "やり方", "ヘルプ", "help", "チュートリアル"],
  ["検索", "search", "探す", "探して", "find", "見つけ", "どのツール"],
  ["git", "コミット", "commit", "プッシュ", "push", "ブランチ", "branch", "マージ", "merge", "履歴"],
  ["物理", "physics", "レイキャスト", "raycast", "衝突", "コライダー", "collider", "rigidbody", "当たり判定", "オーバーラップ", "overlap"],
  ["アニメ", "アニメーション", "animation", "anim", "モーション", "スケルタル"],
  ["音", "サウンド", "オーディオ", "audio", "sound", "効果音", "bgm"],
  ["マルチプレイ", "multiplayer", "ネットワーク", "network", "net", "サーバ", "クライアント"],
  ["配置検査", "レイアウト", "layout", "埋まって", "浮いて", "めり込み", "重なり", "z-fighting", "z_fight"],
  ["命名", "naming", "ネーミング", "整理", "organize", "グループ分け", "スキャフォールド", "scaffold", "骨格"],
  ["シーン一括", "scene_write", "まとめて作", "一式", "一括生成", "json", "部屋", "ステージ一式", "レベル一式"],
  // 宣言的シーン生成(M11)
  ["仕様", "spec", "宣言的", "declarative", "scene spec", "シーン仕様"],
  ["ステージ", "アリーナ", "stage", "arena", "level", "レベル", "マップ", "map", "街", "town", "庭", "garden", "廊下", "corridor", "ショーケース", "showcase"],
  ["円形", "円状", "ring", "circle", "circular", "まわり", "around"],
  ["等間隔", "evenly", "equally spaced", "均等"],
  ["バッチ", "batch", "まとめて実行", "一括", "複数の操作"],
  ["ルック比較", "参照画像", "reference", "比較", "compare", "差分", "diff"],
  ["知覚", "perceive", "見える", "視認", "気づく", "読める", "可視"],
  ["診断", "diagnose", "健全性", "壊れて", "エンジン診断", "自己診断"],
  ["モード", "mode", "editor モード", "playing"],
  ["設定", "settings", "setting", "config", "パラメータ"],
  ["調整", "変える", "変更", "強さ", "強度", "上げる", "下げる", "調節", "書き換え", "set"],
  ["見たい", "見る", "見せて", "読む", "確認", "調べ", "知りたい", "get", "read", "inspect", "取得"],
  // エディタ操作(M7): dx12_editor_command / state / notify / select。
  ["モーダル", "modal", "ダイアログ", "dialog", "ポップアップ", "popup", "詰まった", "固まった"],
  ["トースト", "toast", "通知", "notify", "notification", "お知らせ"],
  ["未保存", "dirty", "unsaved", "scenedirty"],
  ["選択", "select", "selection", "selected", "複数選択"],
  ["コマンド", "command", "commands", "コマンドパレット", "palette", "ショートカット", "shortcut"],
];

// 問い合わせに発火判定するときの正規化済み語 → グループ番号。
type SynEntry = { term: string; ascii: boolean; group: number };
const SYN_ENTRIES: SynEntry[] = [];
SYNONYM_GROUPS.forEach((g, gi) => {
  for (const raw of g) {
    const term = fold(raw);
    SYN_ENTRIES.push({ term, ascii: /^[a-z0-9_ .]+$/.test(term), group: gi });
  }
});

/** 問い合わせに含まれる同義語グループを返す(発火した語の長いものを優先)。 */
export function synonymGroupsFor(query: string): number[] {
  const q = fold(query);
  const words = new Set(q.split(/[^a-z0-9_]+/).filter(Boolean));
  const hit = new Set<number>();
  for (const e of SYN_ENTRIES) {
    if (e.ascii) {
      const t = e.term.replace(/ /g, "");
      if (e.term.includes(" ") || e.term.includes("_")) { if (q.includes(e.term) || q.replace(/[ _]/g, "").includes(t)) hit.add(e.group); }
      else if (words.has(e.term)) hit.add(e.group);
    } else if (e.term.length >= 1 && q.includes(e.term)) hit.add(e.group);
  }
  return [...hit];
}

// ── 索引 ─────────────────────────────────────────────────────────────────

const FIELD_WEIGHTS = { name: 3, title: 2.5, summary: 2, keywords: 2, aliases: 2, category: 1, desc: 0.4, pname: 1, pdesc: 0.25 } as const;
type Field = keyof typeof FIELD_WEIGHTS;
const K1 = 1.4;
const B = 0.6;

type DocIndex = { doc: ToolDoc; tf: Map<string, number>; len: number };

export type SearchHit = {
  name: string;
  tier: string;
  kind: string;
  summary: string;
  category: string;
  effect: string;
  mode: string;
  example?: { tool: string; args: Record<string, unknown> };
  replaces?: string[];
  /** この旧ツールを置き換える Core の統合ツール(旧名の呼び方は変わらない)。 */
  replacedBy?: { tool: string; key: string };
  score: number;
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
  hint: string;
  didYouMean?: string[];
  categories?: string[];
  expandedTerms?: string[];
};

export class SearchIndex {
  private items: DocIndex[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  readonly catalog: Catalog;

  constructor(catalog: Catalog) {
    this.catalog = catalog;
    for (const doc of catalog.docs) this.items.push(this.indexDoc(doc));
    for (const it of this.items) for (const t of it.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.items.reduce((a, b) => a + b.len, 0) / Math.max(1, this.items.length);
  }

  private indexDoc(doc: ToolDoc): DocIndex {
    const tf = new Map<string, number>();
    let len = 0;
    const add = (field: Field, text: string, toks?: string[]) => {
      const w = FIELD_WEIGHTS[field];
      for (const t of toks ?? tokenize(text)) { tf.set(t, (tf.get(t) ?? 0) + w); len += w; }
    };
    add("name", "", nameTokens(doc.id));
    add("title", doc.title);
    add("summary", doc.summary);
    add("keywords", doc.keywords.join(" "));
    add("aliases", "", doc.aliases.flatMap(nameTokens));
    add("category", doc.category);
    // 説明の残り(先頭 1 文は summary で加点済みなので、全文は低い重みで入れる)
    add("desc", (doc.coreDescription ? doc.coreDescription + " " : "") + doc.description.slice(0, 1200));
    add("pname", "", doc.params.flatMap((p) => nameTokens(p.name)));
    add("pdesc", doc.params.map((p) => p.desc ?? "").join(" ").slice(0, 600));
    return { doc, tf, len };
  }

  private idf(t: string): number {
    const n = this.items.length;
    const df = this.df.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(query: string, opts: { category?: string; effect?: string; tier?: string; limit?: number; only?: (d: ToolDoc) => boolean } = {}): SearchResult {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 30));
    const q = query.trim();
    const qTokens = tokenize(q);
    // 語 → 重み。原文の語は 1.0、同義語で足した語は 0.75(原文に近い語ほど強く)。
    const weights = new Map<string, number>();
    for (const t of qTokens) weights.set(t, Math.max(weights.get(t) ?? 0, 1));
    const expanded: string[] = [];
    for (const gi of synonymGroupsFor(q)) {
      for (const raw of SYNONYM_GROUPS[gi]) {
        for (const t of tokenize(raw.replace(/_/g, " "))) {
          if (!weights.has(t)) { weights.set(t, 0.75); }
        }
        expanded.push(raw);
      }
    }
    // 名前そのもの(dx12_xxx / xxx)が問い合わせに入っていれば強く当てる。
    const qFold = fold(q);
    const exactNames = new Set<string>();
    for (const d of this.catalog.docs) {
      const id = d.id.toLowerCase();
      const bare = id.replace(/^dx12_/, "");
      if (qFold.includes(id) || (bare.length >= 6 && new RegExp(`(^|[^a-z0-9_])${bare}([^a-z0-9_]|$)`).test(qFold))) exactNames.add(d.id);
    }

    const scored: { it: DocIndex; s: number }[] = [];
    for (const it of this.items) {
      const d = it.doc;
      if (opts.category && d.category !== opts.category) continue;
      if (opts.effect && !effectMatches(d, opts.effect)) continue;
      // tier:"core" = tools/list に直接載る面(shell 5 本 + Core)。all(既定)は旧 220 とエンジンの全 method まで含む。
      if (opts.tier === "core" && d.tier !== "shell" && !d.core) continue;
      if (opts.only && !opts.only(d)) continue;
      let s = 0;
      const norm = 1 - B + B * (it.len / this.avgLen);
      for (const [t, w] of weights) {
        const f = it.tf.get(t);
        if (!f) continue;
        s += w * this.idf(t) * ((f * (K1 + 1)) / (f + K1 * norm));
      }
      if (exactNames.has(d.id)) s += 100;
      if (s > 0) scored.push({ it, s });
    }
    scored.sort((a, b) => b.s - a.s || a.it.doc.id.localeCompare(b.it.doc.id));

    const hits: SearchHit[] = scored.slice(0, limit).map(({ it, s }) => hitOf(it.doc, s));
    const res: SearchResult = {
      hits, total: scored.length,
      hint: hits.length ? "dx12_tool_describe {name} で引数と注意点を確認し、dx12_call {name, args} で実行する。dryRun:true で実行せずに影響を確認できる" : "",
    };
    if (expanded.length) res.expandedTerms = [...new Set(expanded)].slice(0, 12);
    if (hits.length === 0) {
      const names = this.catalog.names().map((n) => n.replace(/^dx12_/, ""));
      res.didYouMean = nearest(q.replace(/^dx12_/, ""), names, 5).map((n) => this.catalog.resolve(n)?.id ?? n);
      const cats = [...new Set(this.catalog.docs.map((d) => d.category))].sort();
      res.categories = cats;
      res.hint = "該当なし。category を指定して絞る/別の言い方(英語・日本語)で検索する/dx12_guide でトピックを確認する";
    }
    return res;
  }
}

function effectMatches(d: ToolDoc, filter: string): boolean {
  const f = filter.toLowerCase();
  if (f === "dangerous") return d.effectClass === "guarded";
  if (["read", "write", "runtime", "guarded"].includes(f)) return d.effectClass === (f as EffectClass);
  return d.effect === f;   // write_scene などの細かい指定
}

function hitOf(d: ToolDoc, score: number): SearchHit {
  const hit: SearchHit = {
    name: d.id, tier: d.core ? "core" : d.tier, kind: d.kind, summary: d.summary, category: d.category,
    effect: d.effect, mode: d.mode, score: Math.round(score * 100) / 100,
  };
  const req = d.params.filter((p) => p.required);
  if (d.examples[0]) hit.example = { tool: d.id, args: d.examples[0].args };
  else if (req.length) hit.example = { tool: d.id, args: Object.fromEntries(req.slice(0, 4).map((p) => [p.name, placeholder(p.type)])) };
  else hit.example = { tool: d.id, args: {} };
  if (d.aliases.length) {
    const legacy = d.aliases.filter((a) => a.startsWith("dx12_") && a !== d.id);
    if (legacy.length) hit.replaces = legacy;
  }
  if (d.consolidated) {
    // 統合ツールは「どの旧ツールを置き換えるか」を検索結果に出す(旧名でも引けることが分かる)
    hit.replaces = [...new Set([...(hit.replaces ?? []), ...Object.values(d.consolidated.routes)])];
  }
  if (d.replacedBy) hit.replacedBy = d.replacedBy;
  return hit;
}

function placeholder(type: string): unknown {
  if (type.startsWith("number") || type.startsWith("integer")) return 0;
  if (type.startsWith("boolean") || type === "bool") return false;
  if (type.includes("[")) return [];
  if (type === "object") return {};
  return "<" + type + ">";
}
