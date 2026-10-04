// 宣言的シーン生成(M11)の例 5 本を実エンジン(専用インスタンス・使い捨てプロジェクト)へ apply し、複数の視点で撮ってコンタクトシートにする。
//   使い方: node scripts/sceneSpecShots.ts --port 8829 --out C:/Users/ryuto/Documents/dx12-ui-audit/shots [--only room,garden]
//   撮影は仮想入力・MCP の set_editor_camera + screenshot_final だけ(実マウス・前面化は使わない)。使い捨てプロジェクトの scene を作り直す。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const args = process.argv.slice(2);
const argVal = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = argVal("port", process.env.DX12_MCP_PORT ?? "8829")!;
const outDir = argVal("out", path.join(os.tmpdir(), "m11-shots"))!;
const only = (argVal("only", "") ?? "").split(",").filter(Boolean);
process.env.DX12_MCP_PORT = port;
process.env.DX12_MCP_PORT_FILE = path.join(os.tmpdir(), `sceneSpecShots-none-${process.pid}.port`);
process.env.DX12_MCP_SURFACE = "full";
process.env.DX12_FLEET_DISABLE = "1";

await import("../toolset/all.ts");
const { TOOL_REGISTRY } = await import("../toolRuntime.ts");
const { engine } = await import("../toolset/core.ts");
const { buildContactSheet } = await import("../contactSheet.ts");
const { loadExample } = await import("../sceneSpecCorpus.ts");
const { PNG } = await import("pngjs");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });

const VIEWS: Record<string, { name: string; pos: number[]; target: number[] }[]> = {
  fps_arena: [
    { name: "overview", pos: [-26, 24, -32], target: [0, 1, 2] },
    { name: "player", pos: [0, 1.7, -17], target: [0, 1.6, 12] },
    { name: "pillars", pos: [16, 6, -14], target: [0, 1.5, 2] },
    { name: "goal", pos: [-6, 2.2, 8], target: [0, 0.5, 17] },
  ],
  room: [
    { name: "corner", pos: [-3.6, 1.9, -2.7], target: [0.5, 0.8, -0.5] },
    { name: "shelf", pos: [3.4, 1.7, -2.5], target: [0, 1.0, 2.7] },
    { name: "table", pos: [0.5, 2.2, -2.9], target: [0.5, 0.7, -0.4] },
    { name: "wide", pos: [-3.7, 2.4, 2.6], target: [1.5, 0.9, -1.5] },
  ],
  garden: [
    { name: "overview", pos: [-24, 15, -24], target: [0, 0, 0] },
    { name: "path", pos: [0, 1.7, -15], target: [0, 1.5, 10] },
    { name: "bench", pos: [3.5, 2.4, 3.5], target: [-3.2, 0.6, 9.2] },
    { name: "pond", pos: [14, 4, -6], target: [8, 0, 2] },
  ],
  showcase: [
    { name: "hero", pos: [2.4, 1.8, -5.2], target: [0, 1.4, 0] },
    { name: "wide", pos: [0, 2.6, -8.5], target: [0, 0.9, 0] },
    { name: "high", pos: [4.5, 3.6, -3.5], target: [0, 0.7, 0] },
    { name: "low", pos: [-3.2, 0.7, -4.5], target: [0, 1.1, 0] },
  ],
  horror_corridor: [
    { name: "down", pos: [0, 1.6, -13], target: [0, 1.5, 12] },
    { name: "exit", pos: [0, 1.7, 5], target: [0, 1.4, 14.9] },
    { name: "side", pos: [1.4, 2.4, -8], target: [-1, 1.0, -1] },
    { name: "back", pos: [0, 1.7, 13], target: [0, 1.6, -14] },
  ],
};

async function reset() {
  await engine.call("new_scene", {});
  await sleep(500);
  const l = await engine.call("list_entities", {});
  for (const e of l.entities) if (e.name !== "Grid") await engine.call("delete_entity", { entity: e.entityId }).catch(() => { /* 既に消えた */ });
  await sleep(150);
}
async function apply(a: Record<string, unknown>) {
  const res: any = await TOOL_REGISTRY.get("dx12_apply_scene_spec")!.invoke(a);
  const text = res.content?.[res.content.length - 1]?.text ?? "";
  let d: any = null; try { d = JSON.parse(text); } catch { /* 文字列 */ }
  return { ok: !res.isError, d };
}

const names = Object.keys(VIEWS).filter((n) => only.length === 0 || only.includes(n));
const sheets: { name: string; png: Buffer }[] = [];
for (const n of names) {
  await reset();
  const spec = loadExample(n);
  const t0 = Date.now();
  const r = await apply({ spec });
  console.log(`${n}: apply ${r.ok ? "OK" : "NG"} ${Date.now() - t0} ms`, r.ok ? JSON.stringify(r.d.result) : JSON.stringify(r.d).slice(0, 600));
  if (!r.ok) continue;
  await engine.call("step_frames", { frames: 30 });
  const shots: Buffer[] = [];
  for (const v of VIEWS[n]) {
    await engine.call("set_editor_camera", { position: v.pos, target: v.target });
    await engine.call("step_frames", { frames: 12 });
    const file = path.join(outDir, `m11_${n}_${v.name}.png`);
    const s = await engine.call("screenshot_final", { path: file, gizmos: false });
    shots.push(fs.readFileSync(s.path ?? file));
    console.log(`   ${v.name}: ${s.width}x${s.height}`);
  }
  const sheet = buildContactSheet(shots, { columns: 2, tileWidth: 640 });
  const p = path.join(outDir, `m11_${n}.png`);
  fs.writeFileSync(p, sheet.sheetPng);
  sheets.push({ name: n, png: sheet.sheetPng });
  console.log(`   contact sheet: ${p}`);
}
if (sheets.length > 1) {
  // 5 本のコンタクトシートの縮小版をまとめた 1 枚(各例の hero 1 枚ずつ)
  const heroes: Buffer[] = [];
  for (const n of names) { const f = path.join(outDir, `m11_${n}_${VIEWS[n][0].name}.png`); if (fs.existsSync(f)) heroes.push(fs.readFileSync(f)); }
  const all = buildContactSheet(heroes, { columns: 3, tileWidth: 560 });
  fs.writeFileSync(path.join(outDir, "m11_examples.png"), all.sheetPng);
  console.log(`overall: ${path.join(outDir, "m11_examples.png")} (${names.join(", ")})`);
}
void PNG;
await reset();
process.exit(0);
