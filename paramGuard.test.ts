// paramGuard.ts の単体テスト(ネット不要・エンジン不要)。
// 「引数を無言で捨てない」「applied:true で嘘をつかない」の 2 点を守る。

import { z } from "zod";
import {
  definedOnly, nearestKey, unknownKeyError, unknownParamKeys, verifyApplied,
  COMPOSITE_TOOLS, GLOBAL_PARAM_KEYS,
} from "./paramGuard.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] 未知キーの検出");
{
  const declared = ["enabled", "godraysOn", "grIntensity"];
  check("宣言済みキーだけなら何も出ない",
    unknownParamKeys({ enabled: true, grIntensity: 0.5 }, declared).length === 0);
  check("未知キーを拾う",
    JSON.stringify(unknownParamKeys({ enabled: true, godrays: true, zzz: 1 }, declared)) === '["godrays","zzz"]');
  check("idempotency_key は全 method 共通なので弾かない",
    unknownParamKeys({ idempotency_key: "k" }, declared).length === 0
    && GLOBAL_PARAM_KEYS.includes("idempotency_key"));
  check("args が undefined / 配列でも落ちない",
    unknownParamKeys(undefined, declared).length === 0 && unknownParamKeys([1, 2], declared).length === 0);
}

console.log("\n[2] 近い正解の提示");
{
  check("大文字小文字違いを最優先で拾う", nearestKey("GodraysOn", ["godraysOn", "grDecay"]) === "godraysOn");
  check("1 文字違いを拾う", nearestKey("godrayOn", ["godraysOn", "grDecay"]) === "godraysOn");
  check("見当違いには提案しない", nearestKey("completelyDifferent", ["godraysOn"]) === null);
  const e = unknownKeyError("dx12_set_post_process", ["godrays"], ["godraysOn", "grDecay"]);
  check("エラー本文に候補が入る", e.message.includes("godraysOn"), e.message);
  check("エラーは INVALID_PARAM(=2)", e.code === 2, String(e.code));
  check("短い一覧なら valid_values が付く", Array.isArray(e.valid_values) && e.valid_values.length === 2);
  const many = Array.from({ length: 90 }, (_, i) => `field${i}`);
  const e2 = unknownKeyError("dx12_set_post_process", ["fieldX"], many);
  check("長い一覧は valid_values を出さず get_* を案内する",
    e2.valid_values === undefined && e2.hint!.includes("dx12_get_"), e2.hint);
}

console.log("\n[3] 適用後の読み返し照合");
{
  check("一致すれば mismatch なし",
    verifyApplied({ enabled: true, exposure: 1.5 }, { enabled: true, exposure: 1.5, other: 9 }).length === 0);
  check("float32 の丸め(0.65 → 0.6499999761581421)を一致とみなす",
    verifyApplied({ bloomRadius: 0.65 }, { bloomRadius: 0.6499999761581421 }).length === 0);
  check("値が違えば mismatch",
    verifyApplied({ exposure: 2 }, { exposure: 1 })[0]?.key === "exposure");
  check("読み返しに無いキーも mismatch(＝エンジンが見ていない)",
    verifyApplied({ godraysOn: true }, { enabled: true })[0]?.key === "godraysOn");
  check("配列を要素ごとに比べる",
    verifyApplied({ tint: [1, 0.5, 0.25] }, { tint: [1, 0.5, 0.25] }).length === 0
    && verifyApplied({ tint: [1, 0.5, 0.25] }, { tint: [1, 0.5, 0.3] }).length === 1);
  check("入れ子(skybox)を辿ってキー名も入れ子で返す",
    verifyApplied({ skybox: { iblIntensity: 2 } }, { skybox: { iblIntensity: 1 } })[0]?.key === "skybox.iblIntensity");
  check("undefined の要求は現状維持なので照合対象外",
    verifyApplied({ exposure: undefined }, {}).length === 0);
  check("読み返せなかった(null)なら黙る(嘘をつくよりマシ)",
    verifyApplied({ exposure: 2 }, null).length === 0);
  check("definedOnly が undefined を落とす",
    JSON.stringify(definedOnly({ a: 1, b: undefined })) === '{"a":1}');
}

console.log("\n[4] zod の既定挙動(この修正が必要だった理由)");
{
  // 生の shape のままだと未知キーは黙って消える = 事故の本体
  const shape = { enabled: z.boolean().optional() };
  const stripped = z.object(shape).parse({ enabled: true, godraysOn: true } as any);
  check("素の z.object は未知キーを黙って捨てる", !("godraysOn" in stripped));
  const kept = z.object(shape).passthrough().parse({ enabled: true, godraysOn: true } as any);
  check("passthrough なら未知キーが手元まで届く(→ 弾ける)", (kept as any).godraysOn === true);
}

console.log("\n[5] COMPOSITE_TOOLS の形式");
{
  check("全部 dx12_ 接頭辞", [...COMPOSITE_TOOLS].every((t) => t.startsWith("dx12_")));
  check("代表的な合成ツールが入っている",
    COMPOSITE_TOOLS.has("dx12_batch") && COMPOSITE_TOOLS.has("dx12_spawn_box")
    && COMPOSITE_TOOLS.has("dx12_view_texture"));
}

console.log(failed === 0 ? "\nOK: paramGuard テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
