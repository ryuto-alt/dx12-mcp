// シーンの内容のダイジェスト(往復・冪等・ロールバックの「同じシーンか」の判定用)。engine の読み取りだけで作る(偽エンジンでも実エンジンでも同じ)。
// entityId・guid・sceneGeneration・作成順は含めない(名前で並べ替える)。数値は小数 4 桁に丸める(float32 の揺れを吸収)。
import crypto from "node:crypto";
import { pmap, type EngineLike } from "./plan.ts";

const DROP = new Set(["entityId", "guid", "sceneGeneration", "luaReadable", "id"]);

function norm(v: any): any {
  if (typeof v === "number") { const r = Math.round(v * 1e4) / 1e4; return r === 0 ? 0 : r; }
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) if (!DROP.has(k)) o[k] = norm(v[k]);
    return o;
  }
  return v;
}

export type Digest = { hash: string; entities: number; text: string; byName: Map<string, string> };

/** name → 正規化した JSON(親の名前を含む)と全体のハッシュ。internal(gridPlane)は除く。 */
export async function digestScene(engine: EngineLike, opts: { ignoreData?: string[] } = {}): Promise<Digest> {
  const list = await engine.call("list_entities", { verbose: true, limit: 0 });
  const hier = await engine.call("get_hierarchy", { limit: 0 });
  const parentOf = new Map<string, string>();
  const walk = (n: any, p?: string) => { if (p !== undefined) parentOf.set(n.name, p); for (const c of n.children ?? []) walk(c, n.name); };
  for (const r of hier?.roots ?? []) walk(r);
  const ents = ((list?.entities ?? []) as any[]).filter((e) => !(e.componentTypes ?? []).includes("gridPlane"));
  const rows = await pmap(ents, async (e) => {
    const raw = await engine.call("get_entity", { entity: e.entityId ?? e.id });
    const o = norm(raw);
    if (opts.ignoreData && o.data) for (const k of opts.ignoreData) delete o.data[k];
    if (o.componentTypes) o.componentTypes = [...o.componentTypes].sort();
    o.__parent = parentOf.get(e.name) ?? null;
    return [e.name as string, JSON.stringify(o)] as [string, string];
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const text = rows.map(([n, s]) => `${n}\t${s}`).join("\n");
  return { hash: crypto.createHash("sha1").update(text).digest("hex").slice(0, 16), entities: rows.length, text, byName: new Map(rows) };
}
