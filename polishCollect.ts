// polish_audit の材料集め(エンジンを叩く部分)。判定は polish.ts の純関数、ここは「読むだけ」。
//
// ★index.ts の dx12_polish_audit の中に直書きしていたものを切り出した。dx12_quality_gate も同じ材料で
//   polish の検査をするので、集め方を 2 か所に書くと片方だけキー名を直す事故が起きる(polish.ts の解説の
//   「castShadow と castShadows」の件と同じ型)。エンジン呼び出しは call を注入するのでテストで差し替えられる。
//
// ★読めなかった項目は facts に入れない(undefined = 「読めなかった」。判定は飛ばす)。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  entityHasDefaultPbr, entityHasNormalMap, imageFacts, lightFactsFrom, type SceneFacts,
} from "./polish.ts";

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<any>;

export async function collectSceneFacts(call: EngineCall, opts: { screenshot?: boolean; sampleMeshes?: number } = {}):
  Promise<{ facts: SceneFacts; shotPath: string | null }> {
  const facts: SceneFacts = {};

  // ── シーン設定(環境光) ──
  const settings = await call("get_scene_settings", {}).catch(() => null) as any;
  const sky = settings?.skybox ?? settings;
  if (sky) {
    facts.envMapPath = String(sky.envMapPath ?? "");
    facts.iblIntensity = typeof sky.iblIntensity === "number" ? sky.iblIntensity : undefined;
    if (typeof sky.drawSkybox === "boolean") facts.outdoor = sky.drawSkybox;
  }

  // ── ライト ──
  const lights = await call("list_lights", { limit: 200 }).catch(() => null) as any;
  // ★抽出は polish.ts の純関数へ(キー名のズレをテストで守るため)。
  if (lights?.lights ?? lights?.entries) facts.lights = lightFactsFrom(lights);

  // ── 空気・ポスト・接地 ──
  facts.fog = await call("get_volumetric_fog", {}).catch(() => undefined) as any;
  facts.post = await call("get_post_process", {}).catch(() => undefined) as any;
  facts.ssao = await call("get_ssao", {}).catch(() => undefined) as any;
  facts.contactShadow = await call("get_contact_shadow", {}).catch(() => undefined) as any;

  // ── 動くもの / メッシュとマテリアル ──
  const ents = await call("list_entities", { verbose: true }).catch(() => null) as any;
  const list: any[] = ents?.entities ?? [];
  facts.entityCount = list.length;
  facts.emitterCount = list.filter((e) => (e.componentTypes ?? []).includes("particleEmitter")).length;
  // デカールはルールでは見ない(有無の良し悪しは作品による)が、判断段へ「汚れ・傷の有無」として渡す。
  facts.decalCount = list.filter((e) => (e.componentTypes ?? []).includes("decal")).length;
  const meshes = list.filter((e) => (e.componentTypes ?? []).includes("meshRenderer"));
  facts.meshCount = meshes.length;
  if (meshes.length > 0) {
    const cap = Math.max(1, Math.min(64, opts.sampleMeshes ?? 24));
    // 全部見ると往復が増えるので先頭 N 件だけ(偏らないよう等間隔で拾う)
    const step = Math.max(1, Math.floor(meshes.length / cap));
    const picked = meshes.filter((_, i) => i % step === 0).slice(0, cap);
    let normals = 0, defaults = 0, seen = 0;
    for (const m of picked) {
      const info = await call("get_entity", { entity: m.entityId }).catch(() => null) as any;
      if (!info) continue;
      seen++;
      if (entityHasNormalMap(info)) normals++;
      if (entityHasDefaultPbr(info)) defaults++;
    }
    if (seen > 0) {
      // 抽出した割合をシーン全体へ引き伸ばす(件数ではなく比率で判定するので問題ない)
      facts.normalMapCount = Math.round((normals / seen) * meshes.length);
      facts.defaultPbrCount = Math.round((defaults / seen) * meshes.length);
    }
  }

  // ── 最終画 ──
  let shotPath: string | null = null;
  if (opts.screenshot !== false) {
    const out = path.join(os.tmpdir(), `dx12_polish_${Date.now()}.png`);
    const shot = await call("screenshot_final", { gizmos: false, path: out }).catch(() => null) as any;
    const got = shot?.path ?? out;
    if (fs.existsSync(got)) {
      shotPath = got;
      facts.image = imageFacts(fs.readFileSync(got));
    }
  }
  return { facts, shotPath };
}
