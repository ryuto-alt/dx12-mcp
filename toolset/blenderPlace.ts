// dx12_blender_place: Blender で作って並べたものを、同じ配置で dx12 のシーンに置く(2 回目以降は差分更新)。
//
// ★なぜ要るか: dx12_blender_export は 1 つのモデルを出して取り込むだけで、「Blender で並べた配置」は運べなかった。
//   このツールはオブジェクトごとのワールド変換(Blender → エンジンは (x,y,z) → (x,z,-y))を持ち込み、
//   リンク複製は 1 アセットを共有し、group の下に名前で差分更新する。本体は blenderPlace.ts(純関数は blenderPlace.test.ts)。
//
// 登録の作法は luaStep.ts / oracles.ts と同じ:
//   ・legacy 面(旧 220 本のスナップショット)には出さない
//   ・full 面: tools/list の末尾 / core・shell 面: tools/list には出さず dx12_call で使う
import { z } from "zod";
import { engine, errResult, server, type ToolResult } from "./core.ts";
import { ENHANCED, SURFACE, TOOL_REGISTRY, ERROR_BODY } from "../toolRuntime.ts";
import { unknownKeyIssues, bodyFromIssues } from "../validate.ts";
import { envelope } from "../errors.ts";
import { BLENDER_PORT, blenderRunCode, isPortOpen } from "../blenderBridge.ts";
import { placeFromBlender } from "../blenderPlace.ts";

export const BLENDER_PLACE_TOOLS = ["dx12_blender_place"];

const SHAPE: Record<string, z.ZodTypeAny> = {
  objects: z.array(z.string()).optional().describe("置くオブジェクト名。省略で Blender の選択中(それも無ければ表示中の全 MESH)。"),
  assetDir: z.string().optional().describe("assets 相対の書き出し先フォルダ。既定 models/blender/<.blend のファイル名。未保存は untitled>。アセットごとに <assetDir>/<キー>/<キー>.gltf。"),
  group: z.string().optional().describe("エンジン側の親エンティティ名。既定 Blender_<.blend 名>。無ければ空エンティティ(原点・無回転)を作る。"),
  meshes: z.boolean().optional().describe("false で書き出さず Transform だけ更新する(並べ直しの高速反復用。アセットは前回のものを使う)。既定 true。"),
  prune: z.boolean().optional().describe("true で group 配下の、今回の Blender 側に無い名前の子を削除する(既定 false)。objects で一部だけ指定したときは使わないこと。"),
  dryRun: z.boolean().optional().describe("true で何も書かず(Blender の書き出しも、エンジンの変更も無し)、spawn / update / prune / 書き出すアセットだけ返す。"),
};

const DESCRIPTION =
  "Blender で作って並べたものを、同じ配置で dx12 のシーンに置く。2 回目以降は差分更新(同じ名前のエンティティは Transform だけ直す)。"
  + "使う: Blender で複数のオブジェクトを配置し、そのレイアウトをエンジンへ持ってくる / 並べ直した結果を反映する。使わない: 1 つのモデルを書き出すだけ(→ dx12_blender_export)。"
  + "仕組み: MESH だけ対象(ライト・カメラ・空は skipped に理由付き)。モディファイアの無いオブジェクトは mesh データ名で 1 回だけ書き出し、リンク複製は 1 アセットを複数エンティティで共有する(モディファイア付きはオブジェクト固有)。"
  + "各オブジェクトのワールド変換を取り、座標変換(Blender (x,y,z) → エンジン (x,z,-y)。クォータニオンは (w,x,y,z) → [x,z,-y,w]、スケールは [sx,sz,sy])して group の子として置く。親子は平らにする(ワールド変換で置く)。group を動かせば全体が動く。"
  + "★罠: 画像テクスチャの無いマテリアルはエンジンで真っ白(warnings に出る)。せん断・負スケールは warnings。Blender 側のユーザーのオブジェクトは触らない(書き出しは代表の一時コピーを使い、必ず消して選択も元に戻す)。"
  + "Blender は公式アドオン(Blender Lab)・旧コミュニティ版のどちらでも動く(ポートは DX12_BLENDER_PORT、既定 9876)。"
  + "エンジンは Editor モード(Play 中は MODE_CONFLICT)。書き換えは 1 トランザクション = dx12_undo 1 回で戻る(書き出したファイルと reload_assets は戻らない)。"
  + "返り値: {group, assetDir, assets:[{key, path, objects}], spawned[], updated[], pruned[], skipped[], warnings[], next}。dryRun は {spawn, update, prune, willExport} を返す。"
  + "副作用: シーン変更(Undo 可)+ assets へのファイル書き出し。";

if (ENHANCED && SURFACE !== "legacy") {
  const name = "dx12_blender_place";
  const title = "Blender の配置をそのまま置く";
  const declared = Object.keys(SHAPE);
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const invoke = async (args: any): Promise<ToolResult> => {
    const issues = unknownKeyIssues(args ?? {}, declared);
    if (issues.length > 0) {
      const body = bodyFromIssues(name, args ?? {}, issues, declared);
      const res: ToolResult = { content: [{ type: "text", text: JSON.stringify(envelope(body)) }], isError: true };
      ERROR_BODY.set(res, body);
      return res;
    }
    try {
      if (!(await isPortOpen(BLENDER_PORT)))
        throw new Error("Blender に接続できない。先に dx12_blender_ensure を撃つこと");
      const ping = await engine.call("ping", {});
      const data = await placeFromBlender(args ?? {}, {
        engineCall: (m, p) => engine.call(m, p ?? {}),
        blenderExec: (code) => blenderRunCode(code, { timeoutMs: 600_000 }),
        assetsDir: ping.assetsDir,
      });
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data as any } };
    } catch (e: any) {
      return errResult(e);
    }
  };
  const hidden = SURFACE === "shell" || SURFACE === "core";
  const registered = server.registerTool(
    name,
    { title, description: DESCRIPTION, inputSchema: z.object(SHAPE).passthrough() as any, annotations: { title, ...annotations } },
    async (args: any) => invoke(args),
  );
  if (hidden) registered.disable();
  TOOL_REGISTRY.set(name, {
    name, title, description: DESCRIPTION, shape: SHAPE, annotations, tier: "core", core: false, coreDescription: DESCRIPTION,
    extraKeywords: "blender place 配置 並べる レイアウト 持ってくる 差分更新 リンク複製 インスタンス group モデル配置 シーン反映 同じ配置 glTF 一括 取り込み", invoke: (args: any) => invoke(args), listed: !hidden, registered,
  });
}
