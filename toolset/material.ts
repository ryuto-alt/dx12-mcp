// 高品質 PBR 素材(Blender 経由): dx12_material_search / dx12_blender_material_apply / dx12_material_bake。
//
// ★なぜ要るか: 旧 dx12_blender_material は PolyHaven の 1 素材を貼るだけで、実寸合わせ・AO・繰り返しの消去・風化・焼きが無かった
//   (そのうえ旧ツールは legacy 220 本のスナップショットで引数を変えられない)。この 3 本は旧ツールを置き換える新しい入口。
//   ★名前の注意: dx12_material_apply は既にエンジン側(PBR 4 点セットを entity に当てる legacy ツール)にある。
//   Blender のオブジェクトに貼るこちらは dx12_blender_material_apply。
//
// 流れ: search(素材を探す)→ apply(Blender のオブジェクトに貼る)→(needsBake:true なら)bake → dx12_blender_place(エンジンへ置く)。
// 本体は materialLibrary.ts(検索・取得・ORM)/ blenderMaterial.ts(Blender 側スクリプト)。
//
// 登録の作法は blenderPlace.ts に準じるが、★tools/list には【どの面でも出さない】(dx12_tool_search で見つけて dx12_call で撃つ)。
//   full 面の tools/list は M0 基準(旧 220 本のスナップショット = 420,946 B)以下という予算があり、残りが 1KB 足らず。
//   この 3 本の説明・スキーマ(約 11KB)を載せると toolSurface.test.ts の予算検査が落ちるため。legacy 面には出さない。
import { z } from "zod";
import { errResult, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY } from "../toolRuntime.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope } from "../errors.ts";
import { BLENDER_PORT, blenderRunCode, isPortOpen } from "../blenderBridge.ts";
import { searchMaterials } from "../materialLibrary.ts";
import { applyMaterial, bakeMaterials } from "../blenderMaterial.ts";

export const MATERIAL_TOOLS = ["dx12_material_search", "dx12_blender_material_apply", "dx12_material_bake"];

interface Def {
  name: string;
  title: string;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
  keywords: string;
  readOnly: boolean;
  run: (args: any) => Promise<unknown>;
}

const blenderExec = (timeoutMs: number) => (code: string) => blenderRunCode(code, { timeoutMs });
const needBlender = async () => {
  if (!(await isPortOpen(BLENDER_PORT))) throw new Error("Blender に接続できない。先に dx12_blender_ensure を撃つこと");
};

const DEFS: Def[] = [
  {
    name: "dx12_material_search",
    title: "高品質 PBR 素材を探す",
    description:
      "PolyHaven と ambientCG(どちらも CC0・API キー不要)から PBR 素材(テクスチャ)を検索する。Blender は要らない。"
    + "使う: 『木の床』『錆びた金属』『レンガの壁』などの素材を探して実寸・解像度を知る(→ 見つけた id を dx12_blender_material_apply に渡す)。使わない: 貼る(→ dx12_blender_material_apply)・旧 dx12_blender_material(PolyHaven 1 素材を貼るだけ。legacy)。"
    + "日本語の語は簡単な表で英訳する(木→wood / 床→floor / 石→stone / 金属→metal / 錆→rust / 布→fabric / 革→leather / コンクリ→concrete / レンガ→brick / タイル→tile / 土→ground / 砂→sand / 草→grass / 大理石→marble / 樹皮→bark / 壁→wall / 屋根→roof / 塗装→paint …)。表に無い日本語は捨てるので、英語でも書ける。"
    + "★sizeM は模様 1 枚の実寸 m(PolyHaven は dimensions[mm]、ambientCG は dimensionX/Y[cm] から換算。ambientCG は 0 = 不明で null)。一覧 API の結果は 24 時間ディスクにキャッシュ。"
    + "返り値: {query, english[], results:[{source, id, name, tags, sizeM:[w,h]|null, maxRes(px), thumbnailUrl, license:\"CC0\", url}], warnings[]}。片方の素材源が落ちていても、もう片方の結果と warnings を返す。",
    shape: {
      query: z.string().describe("探す語(日本語・英語)。例: 木の床 / rusty metal / brick wall。"),
      source: z.enum(["all", "polyhaven", "ambientcg"]).optional().describe("素材源。既定 all(両方を交互に混ぜる)。"),
      limit: z.number().int().min(1).max(30).optional().describe("返す件数(1〜30、既定 10)。"),
    },
    keywords: "material texture search 素材 テクスチャ 質感 PBR 高品質 探す 検索 polyhaven ambientcg CC0 木 床 石 金属 錆 布 革 コンクリ レンガ タイル 土 砂 草 大理石 壁",
    readOnly: true,
    run: async (a) => searchMaterials({ query: a.query, source: a.source, limit: a.limit }),
  },
  {
    name: "dx12_blender_material_apply",
    title: "Blender のオブジェクトに高品質素材を貼る",
    description:
      "素材(PolyHaven / ambientCG)を取得して、Blender のオブジェクトに実寸で貼る。AO 入りの ORM を 1 枚に詰め、書き出すとエンジンでそのまま正しい縮尺になる。"
    + "使う: Blender のメッシュに木・石・金属などの高品質な質感を貼る(→ 必要なら dx12_material_bake → dx12_blender_place)。使わない: エンジン側のエンティティに PBR を当てる(→ dx12_material_apply)・素材を探すだけ(→ dx12_material_search)。"
    + "仕組み: マテリアルは Principled BSDF に color(sRGB) / roughness・metallic・ao を orm から Separate Color(Non-Color) / normal_gl を Normal Map(OpenGL) / emission / opacity をつなぐ。"
    + "AO は『glTF Material Output』ノードグループの Occlusion に orm の R をつなぐので、書き出すと occlusionTexture と metallicRoughnessTexture が同じ 1 枚(ORM)を指す。"
    + "★実寸合わせ: エンジンは KHR_texture_transform を読まないので、Mapping ノードでは縮尺を合わせない。専用 UV マップ dx12_uv を作り(元 UV の辺比が一様なら元 UV を一様拡縮、そうでなければ箱投影 1UV=1m)、"
    + "ループ UV を 1/scaleM に拡縮して【先頭の UV マップ】にする(glTF の texCoord は並び順の番号で、エンジンは TEXCOORD_0 しか読まないため)。元の UV マップは名前も中身も残る。貼ると、オブジェクトのマテリアル割り当ては新しいマテリアル 1 つに置き換わる(元の名前は返り値の previousMaterials)。"
    + "scaleM(模様 1 枚の実寸)は、省略すると素材の実寸、不明なら 2m。1.7m の素材なら 1m の面に約 0.59 回繰り返す。"
    + "★needsBake: antiTile(Voronoi で UV をずらす)・projection:box(Image Texture の箱投影)・weathering(Bevel / AO ノード)・displacement:bump(Bump ノード。挟むと glTF エクスポータが height 画像を法線マップとして書き出す)は"
    + "ノードのままではエンジンへ行かない(書き出しはノードを評価しない)。使うと needsBake:true と理由を返す → dx12_material_bake で焼く。"
    + "素材は %LOCALAPPDATA%\\UnoEngine\\materials\\<source>\\<id>\\<res>\\ にキャッシュ(color / roughness / metallic / normal_gl / ao / height / orm.png / meta.json)。8k は数百 MB(warnings)。"
    + "ORM の詰めは窓なしの別 Blender で行い、ユーザーの Blender は固めない。Blender は公式アドオン・旧版のどちらでも動く。"
    + "返り値: {material, source, id, resolution, cached, cacheDir, maps, orm, scaleM, repeatsPerMeter, objects:[{name, uvSource, activeUv, uvLayers, previousMaterials}], needsBake, needsBakeReasons?, warnings[], next}。"
    + "副作用: Blender のシーン変更(マテリアル・UV マップ追加・割り当て置換)+ キャッシュへのダウンロード。",
    shape: {
      objects: z.array(z.string()).optional().describe("貼る対象のオブジェクト名。省略で Blender の選択中(MESH のみ)。"),
      source: z.enum(["all", "polyhaven", "ambientcg"]).optional().describe("素材源。id と一緒に渡すとその素材源から取る。省略で検索 / 存在確認は PolyHaven → ambientCG の順。"),
      id: z.string().optional().describe("素材 ID(dx12_material_search の id。例 wood_floor / Bricks060)。"),
      query: z.string().optional().describe("id が無いときの検索語(日本語可)。検索 1 位を使う。"),
      resolution: z.enum(["1k", "2k", "4k", "8k"]).optional().describe("解像度(既定 2k)。8k は数百 MB。"),
      projection: z.enum(["uv", "box"]).optional().describe("uv(既定)= UV で貼る。box = 箱投影(UV の無い/汚いメッシュ向け。ノードの箱投影なので needsBake)。"),
      scaleM: z.number().positive().optional().describe("模様 1 枚の実寸 m。省略で素材の実寸、不明なら 2m。"),
      antiTile: z.boolean().optional().describe("true で繰り返しの目立ちを消す(Voronoi のセルごとに UV をずらす/少し回す。needsBake)。"),
      displacement: z.enum(["none", "bump"]).optional().describe("bump(既定)= height を Bump ノード経由で法線へ。none = 使わない。bump はノードのままでは正しく書き出されない(needsBake)ので、すぐ書き出すなら none。"),
      weathering: z.object({
        edgeWear: z.number().min(0).max(1).optional().describe("角の擦れ 0..1(Bevel ノードの法線差。角の色が明るく粗さが下がる)。"),
        dirt: z.number().min(0).max(1).optional().describe("窪みの汚れ 0..1(AO ノード。窪みが暗く粗くなる)。"),
      }).optional().describe("風化(ノードのまま = needsBake)。"),
      materialName: z.string().optional().describe("作るマテリアル名。既定 dx12_<id>_<解像度>[_at][_box][_e<擦れ>][_d<汚れ>][_bump](ノードの作りが違えば別名)。同名があれば作り直して置き換える(その名前を使っている他のオブジェクトも変わる)。"),
    },
    keywords: "material apply texture 貼る マテリアル 素材 テクスチャ 質感 PBR 高品質 実寸 縮尺 UV AO ORM antiTile 繰り返し 汚れ 錆 擦れ 風化 weathering 箱投影 blender オブジェクトに貼る",
    readOnly: false,
    run: async (a) => { await needBlender(); return applyMaterial(a, { blenderExec: blenderExec(600_000) }); },
  },
  {
    name: "dx12_material_bake",
    title: "マテリアルをエンジン用のテクスチャへ焼く",
    description:
      "Blender のマテリアルを Cycles でテクスチャ(basecolor / normal / ORM)へ焼き、焼いたテクスチャだけを使うマテリアル <元の名前>_dx12 を作る。"
    + "使う: dx12_blender_material_apply が needsBake:true を返したとき(antiTile / 風化 / bump / 箱投影)・手続きノードだけで作ったマテリアルをエンジンへ持っていく。使わない: 画像テクスチャだけの素直なマテリアル(そのまま書き出せる)。"
    + "仕組み: オブジェクトごとに、重ならない UV が無ければ dx12_bake UV を Smart UV Project(+余白)で作る → 解像度 = round_pow2(sqrt(表面積m²) × texelDensity) を [minRes, maxRes] で挟む → "
    + "base color(Emit 経由。ライティング無し・金属でも色が黒にならない)/ roughness / metallic(Emit 経由)/ normal(Tangent・OpenGL・bump と法線マップ込み)/ ao(形の陰 × 素材の AO)を焼く → ORM(R=AO / G=roughness / B=metallic)に詰める。"
    + "★ユーザーのマテリアルを壊さない: 焼くのはマテリアルの【複製】で、元のマテリアル・マテリアル割り当て・元の UV は変えない(dx12_bake UV の追加だけ)。"
    + "オブジェクトにカスタムプロパティ dx12_baked_material を書き、dx12_blender_place / dx12_blender_export は書き出しの間だけ(一時コピー)焼いた方に差し替える。"
    + "焼いた PNG は .blend の隣の dx12_baked\\(未保存なら %LOCALAPPDATA%\\UnoEngine\\materials\\_baked\\untitled\\)にファイルで書く(packed ではない)。"
    + "★長い(数十秒〜数分。同期で待つ。Blender の窓はその間固まる)。GPU が使えれば GPU(OptiX/CUDA/HIP)、初期化に失敗したら CPU へ切り替える。"
    + "★対応は Principled BSDF のみ。opacity(アルファ)は焼かない。解像度は『全面を 1 枚の正方形に詰めたとき 1m あたり texelDensity px』の式で、実際の UV 充填率ぶんの実測は measuredTexelDensity に出す。"
    + "返り値: {ok, units:[{objects, bakedMaterial, areaM2, rawResolution, resolution, uvSource, measuredTexelDensity, files:{basecolor, normal, orm}, stats:{orm:[R,G,B 平均]}, passes}], before, after(元の割り当て・UV の前後), device, bakeDir, warnings[], next}。"
    + "副作用: Blender のシーン変更(マテリアル <名前>_dx12・dx12_bake UV・カスタムプロパティ)+ PNG の書き出し。レンダー設定は終わったら元に戻す。",
    shape: {
      objects: z.array(z.string()).optional().describe("焼く対象。省略で選択中(それも無ければ表示中の全 MESH)。"),
      texelDensity: z.number().positive().optional().describe("1m あたりの px 数(既定 1024)。"),
      maxRes: z.number().int().positive().optional().describe("解像度の上限 px(既定 4096)。"),
      minRes: z.number().int().positive().optional().describe("解像度の下限 px(既定 512)。"),
      samples: z.number().int().positive().optional().describe("Cycles のサンプル数(既定 16。AO は 32 以上、Emit だけの素材は 1 に落とす)。"),
      maps: z.array(z.enum(["basecolor", "roughness", "metallic", "normal", "ao", "emission"])).optional().describe("焼くマップ(既定 全部)。roughness / metallic / ao は ORM に詰まる。"),
      device: z.enum(["auto", "cpu"]).optional().describe("auto(既定)= GPU が使えれば GPU。cpu = CPU 固定。"),
    },
    keywords: "material bake 焼く ベイク テクスチャ 焼き込み 高品質 PBR antiTile 風化 汚し 錆 擦れ 法線 AO ORM cycles エンジン用 手続きマテリアル",
    readOnly: false,
    run: async (a) => { await needBlender(); return bakeMaterials(a, { blenderExec: blenderExec(30 * 60_000) }); },
  },
];

if (ENHANCED && SURFACE !== "legacy") {
  for (const def of DEFS) {
    const { name, title, description, shape } = def;
    const declared = Object.keys(shape);
    const annotations = { readOnlyHint: def.readOnly, destructiveHint: false, idempotentHint: def.readOnly, openWorldHint: true };
    const invoke = async (args: any): Promise<ToolResult> => {
      const issues = unknownKeyIssues(args ?? {}, declared);
      if (issues.length > 0) {
        const body = bodyFromIssues(name, args ?? {}, issues, declared);
        const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
        ERROR_BODY.set(res, body);
        return res;
      }
      try {
        const data = await def.run(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
      } catch (e: any) {
        return errResult(e);
      }
    };
    const hidden = true;   // ★予算のため tools/list には出さない(上の注)
    const registered = server.registerTool(
      name,
      { title, description, inputSchema: z.object(shape).passthrough() as any, annotations: { title, ...annotations } },
      async (args: any) => invoke(args),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title, description, shape, annotations, tier: "core", core: false, coreDescription: description,
      extraKeywords: def.keywords, invoke: (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}
