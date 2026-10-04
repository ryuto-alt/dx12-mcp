// 読み取り系(同期・readOnly): ping / list / get / find / query / describe など
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { auditUiTree, designBrief } from "../uiQuality.ts";
import { judgeUi, UI_SCREENS } from "../jev/uiJudge.ts";
import { readBrief } from "../jev/brief.ts";
import { BLUEPRINT_EXAMPLE, composeUi } from "../uiComposer.ts";
import path from "node:path";
import { OUT, engine, entityRef, jevProjectBaseDir, reg, regRaw, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  読み取り系(同期・readOnly)
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_ping",
  "疎通確認",
  "エディタとの疎通確認。mode(Editor/Playing)・entityCount・sceneGeneration・currentScene・sceneDirty・protocolVersion を返す。★sceneDirty=true は未保存の変更がある状態。この状態で dx12_open_scene / dx12_new_scene / dx12_open_project を撃つとその変更は黙って消えるので、先に dx12_save_scene するか人間に確認すること。まず最初に叩いて生きてるか確認するのに使う。"
  + "★protocolVersion 4 からパス一式も返る: assetsDir / scriptsDir / baseDir / projectShaderDir / cwd(すべて絶対パス)。"
  + "assets 相対パスを絶対パスへ直したい時・シーン JSON を直接書きたい時は、ログから推測せずここを正とすること。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("ping", {})),
);

reg(
  "dx12_list_entities",
  "エンティティ一覧",
  "今開いてるシーンのエンティティ一覧(entityId, name)を返す。verbose で componentTypes も付く。name_prefix / component_type で絞り込み可。{entities, count, total, sceneGeneration} が返る。件数が既定 10000(verbose は 5000)を超えると打ち切り、truncated:true と nextOffset を付ける(続きは offset、全件は limit:0)。",
  {
    verbose: z.boolean().optional().describe("true で各エンティティの componentTypes も含める。"),
    name_prefix: z.string().optional().describe("名前の前方一致フィルタ。"),
    component_type: z.string().optional().describe("指定 jsonKey を持つものだけに絞る(例 pointLight)。"),
    limit: z.number().int().min(0).optional().describe("返す件数の上限(既定 10000・verbose は 5000・0 で無制限)。超えたら truncated:true と nextOffset を返す。total は常に一致件数。"),
    offset: z.number().int().min(0).optional().describe("何件目から返すか(既定 0。truncated 時の nextOffset を渡して続きを取る)。"),
  },
  { readOnlyHint: true },
  ({ verbose, name_prefix, component_type, limit, offset }) =>
    run(() => engine.call("list_entities", { verbose, name_prefix, component_type, limit, offset })),
);

reg(
  "dx12_get_entity",
  "エンティティ詳細",
  "エンティティの全コンポーネントと値を JSON で読む(編集前の状態確認に使う)。entity(id) か name(完全一致)で指定。返り値は entityId, componentTypes, luaReadable(Lua から entity.<key> で直接読めるコンポーネント=現状 transform のみ), sceneGeneration と、各コンポーネントの jsonKey をキーにした値。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_entity", { entity, name })),
);

reg(
  "dx12_find_entity",
  "名前でエンティティ検索",
  "名前の完全一致でエンティティを1件探す。見つかれば {entityId, name}、無ければ null。",
  { name: z.string().describe("探すエンティティ名(完全一致)。") },
  { readOnlyHint: true },
  ({ name }) => run(() => engine.call("find_entity", { name })),
);

reg(
  "dx12_query_entities",
  "タグ/領域でエンティティ検索",
  "tag か box のどちらかで複数エンティティを探す(どちらか必須)。box は XZ 平面の矩形 [minX,minZ,maxX,maxZ]。{entities:[{entityId,name}], count, total} を返す。既定 10000 件で打ち切り、truncated:true と nextOffset を付ける。",
  {
    tag: z.string().optional().describe("このタグを持つエンティティを列挙。"),
    box: z.array(z.number()).length(4).optional().describe("[minX,minZ,maxX,maxZ]。この XZ 矩形に入るエンティティを列挙。"),
    limit: z.number().int().min(0).optional().describe("返す件数の上限(既定 10000・0 で無制限)。超えたら truncated:true と nextOffset。"),
    offset: z.number().int().min(0).optional().describe("何件目から返すか(既定 0)。"),
  },
  { readOnlyHint: true },
  ({ tag, box, limit, offset }) => run(() => engine.call("query_entities", { tag, box, limit, offset })),
);

reg(
  "dx12_list_scenes",
  "シーン一覧",
  "assets/scenes 配下のシーン(.json)一覧 [{path, name}] を返す。dx12_open_scene の path を選ぶのに使う。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("list_scenes", {})),
);

reg(
  "dx12_list_assets",
  "アセット一覧",
  "assets 配下のアセット一覧 [{path, type, name}] を返す。type で種別フィルタ(省略で全種別)。spawn_model / spawn_prefab / attach の path 探索に使う。",
  {
    type: z.enum(["model", "texture", "script", "audio", "scene", "prefab", "shader"]).optional().describe("種別フィルタ。省略で全種別。"),
  },
  { readOnlyHint: true },
  ({ type }) => run(() => engine.call("list_assets", { type })),
);

reg(
  "dx12_get_mode",
  "モード取得",
  "現在のエンジンモード(Editor / Playing)を返す。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_mode", {})),
);

reg(
  "dx12_get_log",
  "ログ取得",
  "エンジンログの末尾 N 行を配列で返す。エラーや print() の確認に使う。",
  { lines: z.number().int().optional().describe("取得行数(既定 50)。") },
  { readOnlyHint: true },
  ({ lines }) => run(() => engine.call("get_log", { lines })),
);

reg(
  "dx12_describe_components",
  "コンポーネント辞書",
  "set_component する前にフィールドを知るための辞書。component 省略で全コンポーネント、指定でそれだけ。返り値 components:[{jsonKey, settable, removable, fields:[{name,type,default}], note?}]。dx12_set_component の data を組み立てる前に必ず参照すると確実。",
  { component: z.string().optional().describe("特定 jsonKey の定義だけ欲しい時に指定(例 pointLight)。省略で全件。") },
  { readOnlyHint: true },
  ({ component }) => run(() => engine.call("describe_components", { component })),
);

reg(
  "dx12_describe_mcp_params",
  "MCP引数辞書",
  "エンジン側の MCP ハンドラが【実際に受け付ける引数キーと型】を method 名で引く辞書。"
  + "エンジンのディスパッチ表(McpDefine の第 2 引数)をそのまま返すので、"
  + "docs や このサーバの zod スキーマが古くても【エンジンの現物】が分かる。"
  + "\n■ 返り値 {methods:{<method名>:[{key,type}]}, count, globalKeys:[\"idempotency_key\"], note}。"
  + "type は bool / int / number / string / vec3 / object / any。"
  + "\"親.子\"(例 skybox.envMapPath)は入れ子オブジェクトのキー。"
  + "any は C++ 側で型を静的に決められなかっただけで「何でも通る」という意味ではない。"
  + "\n■ method には dx12_ 接頭辞を付けない(ツール名 dx12_set_dxr → method \"set_dxr\")。省略で全件。"
  + "\n■ ★使いどころ: ツールが『知らない引数』と言って弾いたときや、"
  + "設定したのに変わらないときに、まずこれでエンジンの現物と突き合わせること。",
  {
    method: z.string().optional().describe(
      "engine の method 名(dx12_ 接頭辞なし。例 \"set_dxr\")。省略で全 method を返す。"),
  },
  { readOnlyHint: true },
  ({ method }) => run(() => engine.call("describe_mcp_params", { method })),
);

reg(
  "dx12_ui_tree",
  "UIツリー取得",
  "ゲーム内 UI のツリー構造を丸ごと JSON で返す(キャンバスごと)。各ノード: {entityId, name, components(uiImage/uiButton等の種別), uiRect(anchor/offset/order/visible), resolvedRect:[x,y,w,h](レイアウト解決済み・キャンバス空間px=uiRectと同じ単位), text?, children}。★UI を組む時の基本ループ: create_entity(ui_*) → set_component(uiRect等) → ui_tree で位置を数値確認 → dx12_ui_screenshot で見た目確認。兄弟の描画順は uiRect.order(大きいほど手前)、親変更は dx12_set_parent。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("ui_tree", {})),
);

reg(
  "dx12_ui_design_brief",
  "ゲームUIデザイン方針",
  "画面を組む前に、ジャンルと画面目的から構図・視覚階層・余白・操作サイズ・避けるべきAI的表現を返す。単なる色テーマではなく、title/HUD/inventory/settings/result/dialogごとに情報設計を変える。★ui_composeや手動生成の前に呼び、返ったbriefを設計判断の基準にする。",
  {
    genre: z.enum(["cinematic", "tactical", "fantasy", "horror", "arcade", "cozy"]).describe("作品の視覚文法。安易な青紫ネオン固定を避け、ゲーム固有の方向性を選ぶ。"),
    screen: z.enum(["title", "hud", "inventory", "settings", "result", "dialog", "other"]).describe("作る画面の役割。"),
    tone: z.string().optional().describe("premium / playful / restrained / brutalist 等の補助トーン。"),
  },
  { readOnlyHint: true },
  ({ genre, screen, tone }) => run(async () => designBrief(genre, screen, tone)),
);

regRaw(
  "dx12_ui_audit",
  {
    title: "ゲームUI品質監査",
    description:
      "現在のui_treeを自動解析し、崩れ・入力遮断・小さな操作領域・文字切れ・文字あふれ・rich/wrap競合・操作要素の重なり・過装飾・色の散乱を検出する。score/grade/passと、entityId付きの修正案を返す。★UI生成後は必ずstrictでpassさせ、その後ui_screenshotで美的判断を行う。数値監査だけで完成扱いにしない。"
      + "★judge は判断段: 好みのルール(CENTERED_MONOTONY / FONT_SIZE_SPRAWL / PALETTE_SPRAWL / OVER_DECORATED / BUSY_GLOSS / EFFECT_STACKING / OUT_OF_CANVAS)を"
      + "作品の意図(dx12_brief)と一緒に Jev へ 1 往復で聞き、{source, briefFit(0..4), findings:[{code, intended, keep}], uncertain[], passExcludingKept, scoreExcludingKept, notAsked} を返す。"
      + "keep:true は Brief に照らすと意図どおり＝直さない(ガチャ画面の光沢など)。押せない・読めない・崩れている系は聞かずにルールのまま(notAsked)。"
      + "uncertain は dx12_ui_screenshot で自分の目で見て決める。Brief / 鍵が無いときは judge.source:\"rules\"(全部直す＝従来どおり)。judge:false で止める。",
    inputSchema: {
      strictness: z.enum(["balanced", "strict"]).optional().describe("strictはwarningが1件でもpass=false。最終検証ではstrict推奨。"),
      screen: z.enum(UI_SCREENS).optional().describe("画面の役割(title/hud/inventory/settings/result/dialog/other)。判断段に「何の画面か」として渡す。"),
      judge: z.boolean().optional().describe("false で判断段(Jev に Brief と照らして聞く段)を止め、ルールの結果だけ返す。既定 true。"),
    },
    outputSchema: OUT,
    // 判断段は外部の Jev へ出る(鍵があるときだけ)ので openWorldHint は true。
    annotations: { title: "ゲームUI品質監査", readOnlyHint: true, openWorldHint: true },
  },
  ({ strictness, screen, judge }) => run(async () => {
    const tree = await engine.call("ui_tree", {});
    const audit = auditUiTree(tree, strictness ?? "balanced");
    if (judge === false) return audit;
    // ★既存の pass / score / grade / issues / metrics は一切変えない(後方互換)。判断は judge にだけ足す。
    const baseDir = await jevProjectBaseDir();
    const brief = baseDir ? readBrief(baseDir).brief : null;
    const judged = await judgeUi({ brief, tree, audit, strictness, screen, askOptions: { baseDir } })
      .catch((e: any) => ({ source: "rules", reason: `判断段で想定外の失敗: ${e?.message ?? e}` }));
    return { ...audit, judge: judged };
  }),
);

reg(
  "dx12_ui_compose",
  "制約付きゲームUI構築",
  "役割(role)とレイアウト意図(dock/stack/grid)から、Canvas・UIRect・UILayout・スタイル・ボタンラベル・控えめなインタラクションをまとめて構築する。生offsetの手計算を減らしUI崩れを防ぐ。themeは色だけでなく角・枠・コントラストの文法を変える。既存UIは消さず、prefix付きの新Canvasを作る。失敗時は作成Canvasを自動削除して半端なUIを残さない。構築後は返されるnext順にui_audit→ui_screenshot→save_sceneを行う。blueprint例: " + JSON.stringify(BLUEPRINT_EXAMPLE),
  {
    blueprint: z.any().describe("{theme,prefix,sortOrder?,root}。node={name,kind:'panel|text|button|stack|grid',role?,text?,event?,layout?,flow?,style?,textStyle?,children?}。layout.dock='fill|top|bottom|left|right|center|point', margin=数値または[l,t,r,b], width/height。stack.flow={direction:'vertical|horizontal',cellHeight,cellWidth,spacing,padding}、grid.flow={columns,...}。全nameはblueprint内で一意。"),
  },
  { destructiveHint: false },
  ({ blueprint }) => run(() => composeUi(engine, blueprint)),
);

reg(
  "dx12_describe_lua_api",
  "Lua API 辞書",
  "Lua コンポーネントスクリプトから使えるバインディング一覧を binding ごと(entity/transform/Vec3/self/scene/input/camera/physics/audio/ui/fx/events/globals/prelude)に返す静的辞書。★重要: MCP で見えるコンポーネントと Lua から読める API は違う。entity から直接読めるデータは transform だけで、entity.boxCollider 等は nil(collider/rigidBody の値は physics:getVelocity(e) 等の別 API 経由)。Lua を書く前にこれで実際に読める API を確認すると取り違えを防げる。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("describe_lua_api", {})),
);

reg(
  "dx12_get_lua_component_state",
  "Luaプロパティ状態取得",
  "エンティティの LuaScript の現在のプロパティ値を全部返す(スキーマ基準なので未上書きの既定値も含む。get_entity は保存済みの上書きしか出さない)。{scriptPath, enabled, started, loadError, errorMessage, properties:[{name,type,value,isOverride}]}。★loadError=true のとき errorMessage に Lua の traceback がそのまま入る。dx12_set_lua_property で変える前の確認に。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("get_lua_component_state", { entity, name })),
);

reg(
  "dx12_get_script_errors",
  "壊れているLuaを全部出す",
  "いま loadError が立っている LuaScript を全部返す: {count, mode, errors:[{entityId,name,scriptPath,message}]}。message は traceback 込み。★どのエンティティが壊れたか分からない状態ではこれを使う(dx12_get_lua_component_state は entity を1個ずつ聞くので使えない)。dx12_play の結果に scriptErrors>0 が出たら次はこれ。dx12_get_log と違ってログ行を漁らなくてよい。エラーの出たスクリプトは .lua を保存し直すだけでホットリロードされ復活する(Play を止めなくてよい)。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_script_errors", {})),
);

reg(
  "dx12_reload_scripts",
  "Luaを強制リロード",
  "LuaScript を作り直して loadError を落とす: {reloaded, cleared}。★実行時エラーで死んだスクリプトを Play を止めずに復帰させる用。OnUpdate で 1 回でもエラーが出たスクリプトはそのフレーム以降まるごとスキップされるので、原因を直しても自動では戻らない場合にこれを叩く。path を渡すとその .lua を使うものだけ、省略で全部。ファイルを書き換えた場合は 0.5 秒で自動リロードされるのでこれは不要 — これが要るのは「外から状態を戻したい」「ファイルは変えずにやり直したい」ケース。Editor モードで呼ぶと env を捨てるだけで、実際の作り直しは次の Play。",
  { path: z.string().optional().describe("assets 相対の .lua パス。省略で全 LuaScript が対象") },
  {},
  ({ path }) => run(() => engine.call("reload_scripts", path ? { path } : {})),
);

reg(
  "dx12_set_lua_property",
  "Luaプロパティ設定",
  "LuaScript のプロパティを1つ書き換える(スクリプトの properties 宣言にあるものだけ)。type に応じて value は number/bool/string/[x,y,z]。Playing 中なら即再注入(スクリプト再ロード=OnStart 再実行)、Editor 中は保存だけで次 Play から反映。entity(id) か name 指定。型が不安なら先に dx12_get_lua_component_state で確認。",
  {
    ...entityRef,
    key: z.string().describe("プロパティ名(スクリプトの properties に宣言済みのもの)。"),
    value: z.any().describe("値。型はプロパティに合わせる: number / bool / string / [x,y,z](vec3,color)。"),
  },
  { idempotentHint: true },
  ({ entity, name, key, value }) =>
    run(() => engine.call("set_lua_property", { entity, name, key, value })),
);

reg(
  "dx12_project_world_to_screen",
  "ワールド→画面投影",
  "エンティティのワールド座標を、今シーンビューを描いているカメラで画面ピクセルへ投影する。{x, y, visible, depth, w, width, height, mode}。★Playing 中は m_camera=アクティブなゲームカメラなので「ゲーム画面で player が中央(x≈width/2, y≈height/2)か」「画面内(visible)か」を数値で検証できる(dx12_screenshot と同じカメラ)。w<=0 はカメラ背面。entity(id) か name 指定。",
  { ...entityRef },
  { readOnlyHint: true },
  ({ entity, name }) => run(() => engine.call("project_world_to_screen", { entity, name })),
);

reg(
  "dx12_get_scene_settings",
  "シーン設定取得",
  "シーンのスカイボックス/IBL・物理大気の設定を返す。{skybox:{envMapPath,iblIntensity,skyboxIntensity,drawSkybox}, atmosphere:{enabled,timeOfDay,…全項目}, atmosphereState:{太陽の高度/方位・IBL 再ベイク回数・GPU 時間}, note}。dx12_set_scene_settings で変える前の確認に使う。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("get_scene_settings", {})),
);
