// デカール(投影テクスチャ)
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { buildAtlasPng, DECAL_IDS, describeDecals, findDecal, planDecal } from "../decals.ts";
import { z } from "zod";
import { v3 } from "../sceneTools.ts";
import path from "node:path";
import fs from "node:fs";
import { engine, entityId, reg, run } from "./core.ts";

// ── デカール(投影テクスチャ): 弾痕・焦げ・血・水たまり・苔・汚れ ──
// ★「そこで何かが起きた」を語る唯一の安い手段。1 つも無い床は、どれだけ光を凝っても
//   出荷前のショールームに見える。エンジンには DecalComponent があったが
//   MCP から触れず、しかも【シーンにアトラス画像が無いと無言で何も出ない】ので
//   実質使えない機能だった。アトラスはここで手続き生成して自動で用意する。

reg(
  "dx12_decal_library",
  "デカール一覧",
  "貼れる汚れ・傷の一覧を返す。各項目は {id, title, summary, defaultSize, surface(床専用か), changes(粗さ/金属感の上書き), notes}。"
  + "id を dx12_decal_apply に渡して貼る。"
  + "★水たまり/血だまり/油/雪は【ほぼ水平面専用】(角度フェードが小さい)。壁には dirt / leak / blood_splatter を使う。",
  {},
  { readOnlyHint: true, idempotentHint: true },
  () => run(async () => ({
    decals: describeDecals(),
    count: DECAL_IDS.length,
    atlas: "初回の dx12_decal_apply が assets/textures/decals/atlas.png を生成してシーンに設定する(手続き生成・16 セル)",
    next: "dx12_decal_apply(preset:'dirt', position:[x,y,z], normal:[0,1,0]) で貼る。"
      + "面の座標と法線は dx12_raycast_precise か dx12_pick が返すものをそのまま渡すのが正確",
  })),
);

reg(
  "dx12_decal_apply",
  "デカールを貼る",
  "汚れ・傷・水たまりを面へ投影する。位置と法線から姿勢を計算し、DecalComponent 付きのエンティティを作る。"
  + "★初回はアトラス画像(assets/textures/decals/atlas.png)を手続き生成して、シーンのデカールアトラスに設定する"
  + "(アトラスが無いとデカールは【無言で何も出ない】ため)。"
  + "★面の座標と法線は dx12_raycast_precise / dx12_pick の worldPos・worldNormal をそのまま渡すのが正確。"
  + "normal を省略すると真上[0,1,0](床)として扱う。"
  + "★Editor 限定(エンティティを作るため)。count を渡すと、その面のまわりへ散らして複数枚貼る(弾痕・汚れ向き)。",
  {
    preset: z.string().describe("デカール id(dx12_decal_library で一覧)。例: dirt / bullet_hole / puddle / blood_pool / moss。"),
    position: v3().describe("[x,y,z] 貼る面の点(ワールド)。"),
    normal: v3().optional().describe("[x,y,z] 面の法線。省略で [0,1,0]。raycast の worldNormal をそのまま渡す。"),
    size: z.number().optional().describe("1 辺の大きさ m。省略でレシピの既定。"),
    depth: z.number().optional().describe("投影の厚み m。省略で size*0.35。面の凹凸より厚くすること。"),
    rotationDeg: z.number().optional().describe("面の中での回転(度)。垂れ跡の向きを合わせるときに使う。"),
    opacity: z.number().optional().describe("濃さ 0..1。薄く重ねるほど自然。"),
    tint: v3().optional().describe("[r,g,b] 色の乗算。"),
    sortOrder: z.number().int().optional().describe("重なり順(小さいほど下)。"),
    count: z.number().int().optional().describe("まとめて貼る枚数(1..24)。2 以上で spread の範囲に散らす。"),
    spread: z.number().optional().describe("count>1 のときの散らばり半径 m(既定 size*1.5)。"),
    seed: z.number().int().optional().describe("散らしの乱数シード(同じ値なら同じ配置)。"),
    entityName: z.string().optional().describe("作るエンティティ名(既定 'DECAL_<preset>')。複数枚なら連番。"),
    parentName: z.string().optional().describe("親にするエンティティ名(命名規約に従うなら 'ENV')。"),
    dryRun: z.boolean().optional().describe("true で何も作らず、計算結果(姿勢と値)だけ返す。"),
  },
  {},
  ({ preset, position, normal, size, depth, rotationDeg, opacity, tint, sortOrder,
     count, spread, seed, entityName, parentName, dryRun }) => run(async () => {
    const n = (normal ?? [0, 1, 0]) as [number, number, number];
    const base = planDecal(preset, {
      position: position as [number, number, number], normal: n,
      size, depth, rotationDeg, opacity,
      tint: tint as [number, number, number] | undefined, sortOrder,
    });
    const num = Math.max(1, Math.min(24, Math.round(count ?? 1)));

    // 散らす: 面内の 2 軸(法線に直交する基底)へランダムにずらす
    const rng = (() => { let a = (seed ?? 12345) >>> 0;
      return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; })();
    const ref: [number, number, number] = Math.abs(n[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const dotv = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
    const tx = [ref[0] - n[0] * dotv, ref[1] - n[1] * dotv, ref[2] - n[2] * dotv];
    const tl = Math.hypot(tx[0], tx[1], tx[2]) || 1;
    const T: [number, number, number] = [tx[0] / tl, tx[1] / tl, tx[2] / tl];
    const B: [number, number, number] = [
      T[1] * n[2] - T[2] * n[1], T[2] * n[0] - T[0] * n[2], T[0] * n[1] - T[1] * n[0],
    ];
    const radius = spread ?? (size ?? base.scale[0]) * 1.5;

    const placements = Array.from({ length: num }, (_, i) => {
      if (i === 0 && num === 1) return { ...base, index: 0 };
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * radius;
      const off: [number, number, number] = [
        Math.cos(a) * r * T[0] + Math.sin(a) * r * B[0],
        Math.cos(a) * r * T[1] + Math.sin(a) * r * B[1],
        Math.cos(a) * r * T[2] + Math.sin(a) * r * B[2],
      ];
      const p = planDecal(preset, {
        position: [position[0] + off[0], position[1] + off[1], position[2] + off[2]],
        normal: n,
        size: (size ?? base.scale[0]) * (0.7 + rng() * 0.6),   // 大きさを散らす(同じ判が並ぶと嘘っぽい)
        depth, rotationDeg: (rotationDeg ?? 0) + rng() * 360,   // 向きも散らす
        opacity, tint: tint as [number, number, number] | undefined,
        sortOrder: (sortOrder ?? 0) + i,
      });
      return { ...p, index: i };
    });

    if (dryRun) {
      return {
        dryRun: true, preset, count: num,
        placements: placements.map((p) => ({
          position: p.position, rotation: p.rotation, scale: p.scale, decal: p.decal,
        })),
        warnings: base.warnings,
      };
    }

    // ── アトラスを用意する(無ければ生成してシーンに設定) ──
    const ping = await engine.call("ping", {}) as any;
    const assetsDir: string = ping?.assetsDir ?? "";
    if (!assetsDir) throw new Error("dx12_ping が assetsDir を返さない(古いエンジン?)");
    const rel = "textures/decals/atlas.png";
    const abs = path.join(assetsDir, rel);
    let atlasCreated = false;
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buildAtlasPng());
      atlasCreated = true;
    }
    const settings = await engine.call("get_scene_settings", {}).catch(() => null) as any;
    const curAtlas: string = settings?.decalAtlasPath ?? "";
    let atlasSet = false;
    if (curAtlas !== rel) {
      const r = await engine.call("set_scene_settings", { decalAtlasPath: rel }).catch(() => null) as any;
      atlasSet = r?.decalAtlasPath === rel;
      if (!atlasSet) {
        base.warnings.push(
          "シーンのデカールアトラスを設定できなかった(エンジンが古い可能性)。"
          + "この場合デカールは【無言で何も出ない】。シーン JSON の decalAtlas を直接書くか、エンジンを更新すること。",
        );
      }
    }

    // ── 置く ──
    const made: Array<Record<string, unknown>> = [];
    for (const p of placements) {
      const nm = num === 1
        ? (entityName ?? `DECAL_${preset}`)
        : `${entityName ?? `DECAL_${preset}`}_${String(p.index + 1).padStart(2, "0")}`;
      const res = await engine.call("create_entity", {
        type: "decal", name: nm, position: p.position, parentName,
      }) as any;
      const id = res?.entityId;
      await engine.call("set_transform", { entity: id, rotation: p.rotation, scale: p.scale });
      await engine.call("set_component", { entity: id, component: "decal", data: p.decal });
      made.push({ entityId: id, name: res?.name ?? nm, position: p.position });
    }

    return {
      applied: true,
      preset, count: made.length, entities: made,
      atlas: { path: rel, created: atlasCreated, sceneSet: atlasSet || curAtlas === rel },
      rotation: placements[0].rotation,
      notes: findDecal(preset)?.notes ?? [],
      warnings: base.warnings,
      next: "dx12_screenshot_from(gizmos:false) で見る。薄い汚れ(dirt/dust)は opacity 0.3〜0.5 で"
        + "重ねると自然。濡れ表現(puddle/oil/blood_pool)は dx12_set_ssr(enabled:true) で反射が出る",
    };
  }),
);
