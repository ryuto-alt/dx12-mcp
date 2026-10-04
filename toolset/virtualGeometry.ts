// 仮想ジオメトリ(Nanite 風。docs/VIRTUAL_GEOMETRY_DESIGN.md)のツール 2 本:
//   dx12_vg_stats            … GPU カリング + ラスタの統計(エンジン method vg_stats)
//   dx12_set_virtual_geometry … ON/OFF・τ(lodPixelError)・HZB・コーン棄却・ラスタ・計測(エンジン method set_virtual_geometry)
// 引数の一覧はエンジン側 src/core/mcp/ApplicationMcpManifest.cpp の meta(vg_stats / set_virtual_geometry)。VG の段階(P4 以降)で引数が増えたら、
// この shape に足す(足さないと zod が黙って捨てる)。ドリフトは schemaDrift.test.ts [14] が突き合わせる。
//
// 登録の作法は pathTracer.ts / フリート / ジョブと同じ:
//   ・legacy 面(旧 220 本のスナップショット = 1 バイトも変えない回帰基準)には出さない
//   ・full 面: 旧 220 本の直後(パストレーサーの次)/ core・shell 面: tools/list には出さず dx12_call で使う(長尾)
import { z } from "zod";
import { engine, errResult, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY } from "../toolRuntime.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope } from "../errors.ts";
import { ERROR_BODY } from "../toolRuntime.ts";

export const VG_TOOLS = ["dx12_vg_stats", "dx12_set_virtual_geometry"];

const SET_SHAPE: Record<string, z.ZodTypeAny> = {
  enabled: z.boolean().optional().describe("GPU カリング + メッシュシェーダ描画を ON/OFF(既定 OFF)。"),
  lodPixelError: z.number().min(0.25).max(8).optional().describe("LOD の画面空間誤差しきい値 τ(レンダー px。既定 1)。"),
  hzbCulling: z.boolean().optional().describe("二段 HZB オクルージョン(既定 true)。"),
  coneCulling: z.boolean().optional().describe("法線コーンの背面棄却(既定 true)。"),
  instanceMinPx: z.number().min(0).max(64).optional().describe("画面上の半径がこれ未満のインスタンスを棄却(0 で無効。既定 0.5)。"),
  vramBudgetMB: z.number().int().min(64).max(65536).optional().describe("アセット(ページ + BVH)の VRAM 予算。超える読込は構造化エラーで拒否(既定 3072)。"),
  raster: z.boolean().optional().describe("メッシュシェーダで VG 本体を描く(既定 true。false = 統計だけ・プロキシを描く。GPU 非対応なら自動で無効。シーンには保存されない)。"),
  rasterAs: z.boolean().optional().describe("増幅シェーダ経由で描く(既定 false = MS のみ)。"),
  smallPrimCull: z.boolean().optional().describe("画素中心を 1 つも覆わない三角形 / クラスタを落とす(既定 false)。"),
  measure: z.boolean().optional().describe("計測(断片数 / オーバードロー / 被覆画素 / 辺長ヒストグラムを vg_stats.raster へ)。少し遅い(既定 false)。"),
  forceLod0: z.boolean().optional().describe("検証 / 計測用。LOD0 の葉クラスタだけを選ぶ(全 LOD0 の素朴な参照。三角形が桁違いに増える)。"),
  resolve: z.boolean().optional().describe("P4: 材質 resolve(フォワードと同じライティングで VG 画素を塗る。既定 true)。false = P3 の暫定シェーディング(A/B 用。シーンには保存されない)。"),
  stableOrder: z.boolean().optional().describe("P4: 決定論(可視リストをフェーズごとに安定ソート。同じ深さの面の先着が起動ごとに変わらない)。決定論キャプチャ中は自動で ON(既定 false)。"),
};

type Def = { title: string; description: string; shape: Record<string, z.ZodTypeAny>; annotations: Record<string, unknown>; keywords: string; method: string };
const DEFS: Record<string, Def> = {
  dx12_vg_stats: {
    title: "仮想ジオメトリの統計", method: "vg_stats", shape: {},
    description:
      "仮想ジオメトリ(Nanite 風)の GPU カリング + ラスタ + 材質 resolve の統計を返す({enabled, active, instances, sourceTrisInFrustum, visibleClusters, trianglesDrawn, cullGpuMs, vramMB, overflow, levelHistogram, raster{…}, "
      + "resolve{active, gpuMs, gbufferGpuMs, …}, stableOrder{…}, vgGpuTotalMs, ineligible{count, entities[…]}, assets[…]}。統計は約 3 フレーム遅れ)。"
      + "VirtualGeometry コンポーネント(.vgeo を置くと付く)を持つエンティティが対象。設定は dx12_set_virtual_geometry。",
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    keywords: "vg virtual geometry nanite 仮想ジオメトリ クラスタ カリング 統計 vgeo",
  },
  dx12_set_virtual_geometry: {
    title: "仮想ジオメトリの設定", method: "set_virtual_geometry", shape: SET_SHAPE,
    description:
      "仮想ジオメトリ(Nanite 風)の設定を変えて、現在の統計を返す。enabled で GPU カリング + メッシュシェーダ描画を ON/OFF(既定 OFF)、lodPixelError = LOD の τ、hzbCulling / coneCulling / instanceMinPx / vramBudgetMB、"
      + "実行時のみの raster / rasterAs / smallPrimCull / measure / forceLod0 / resolve / stableOrder。SM 6.6 + Resource Binding Tier 3 が無い GPU では無効(gpuSupported:false)。",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    keywords: "vg virtual geometry nanite 仮想ジオメトリ 設定 enabled lodPixelError hzb cone",
  },
};

if (ENHANCED && SURFACE !== "legacy") {
  for (const name of VG_TOOLS) {
    const def = DEFS[name];
    const declared = Object.keys(def.shape);
    const invoke = async (args: any): Promise<ToolResult> => {
      const issues = unknownKeyIssues(args ?? {}, declared);
      if (issues.length > 0) {
        const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(bodyFromIssues(name, args ?? {}, issues, declared))) }], isError: true };
        ERROR_BODY.set(res, bodyFromIssues(name, args ?? {}, issues, declared));
        return res;
      }
      try {
        const data = await engine.call(def.method, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: (data ?? null) as any } };
      } catch (e: any) {
        return errResult(e);
      }
    };
    const hidden = SURFACE === "shell" || SURFACE === "core";
    const registered = server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: z.object(def.shape).passthrough() as any, annotations: { title: def.title, ...def.annotations } },
      async (args: any) => invoke(args),
    );
    if (hidden) registered.disable();
    TOOL_REGISTRY.set(name, {
      name, title: def.title, description: def.description, shape: def.shape, annotations: def.annotations, tier: "core", core: false, coreDescription: def.description,
      extraKeywords: def.keywords, invoke: (args: any) => invoke(args), listed: !hidden, registered,
    });
  }
}

// schemaDrift.test.ts [14] が、エンジンの set_virtual_geometry が読むキーと突き合わせる。
export const VG_SET_SHAPE_KEYS = Object.keys(SET_SHAPE);
