// RFC 6902 JSON Patch の必要な部分(add / replace / remove / move / copy / test)と JSON Pointer。純関数。
// specPatch(仕様への差分)を dx12_apply_scene_spec {specRef, patch} でそのまま撃ち直せるようにする。
import type { PatchOp } from "./types.ts";

export function ptrEscape(seg: string | number): string { return String(seg).replace(/~/g, "~0").replace(/\//g, "~1"); }
export function ptrUnescape(seg: string): string { return seg.replace(/~1/g, "/").replace(/~0/g, "~"); }
export function ptr(...segs: (string | number)[]): string { return segs.map((s) => "/" + ptrEscape(s)).join(""); }
export function parsePtr(p: string): string[] {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new PatchError(`JSON Pointer は "/" で始まる: ${JSON.stringify(p)}`);
  return p.slice(1).split("/").map(ptrUnescape);
}

export class PatchError extends Error {
  op?: PatchOp; index?: number;
  constructor(message: string, op?: PatchOp, index?: number) { super(message); this.name = "PatchError"; this.op = op; this.index = index; }
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function getParent(root: any, segs: string[], op: PatchOp, index: number): { parent: any; key: string } {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (cur === null || typeof cur !== "object" || !(k in cur)) throw new PatchError(`パスが存在しない: ${op.path}(${segs.slice(0, i + 1).join("/")} が無い)`, op, index);
    cur = cur[k];
  }
  if (cur === null || typeof cur !== "object") throw new PatchError(`パスの親が値ではない: ${op.path}`, op, index);
  return { parent: cur, key: segs[segs.length - 1] };
}

function getAt(root: any, path: string, op: PatchOp, index: number): any {
  const segs = parsePtr(path);
  let cur = root;
  for (const k of segs) {
    if (cur === null || typeof cur !== "object" || !(k in cur)) throw new PatchError(`パスが存在しない: ${path}`, op, index);
    cur = cur[k];
  }
  return cur;
}

function arrIndex(key: string, len: number, allowEnd: boolean, op: PatchOp, index: number): number {
  if (key === "-") { if (!allowEnd) throw new PatchError(`"-" は add でだけ使える: ${op.path}`, op, index); return len; }
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new PatchError(`配列の添字が整数ではない: ${op.path}`, op, index);
  const n = Number(key);
  if (n > len || (!allowEnd && n === len)) throw new PatchError(`配列の添字が範囲外: ${op.path}(長さ ${len})`, op, index);
  return n;
}

function addAt(root: any, path: string, value: unknown, op: PatchOp, index: number): any {
  const segs = parsePtr(path);
  if (segs.length === 0) return clone(value);
  const { parent, key } = getParent(root, segs, op, index);
  if (Array.isArray(parent)) parent.splice(arrIndex(key, parent.length, true, op, index), 0, clone(value));
  else parent[key] = clone(value);
  return root;
}

function removeAt(root: any, path: string, op: PatchOp, index: number): { root: any; removed: any } {
  const segs = parsePtr(path);
  if (segs.length === 0) throw new PatchError("ルートは remove できない", op, index);
  const { parent, key } = getParent(root, segs, op, index);
  if (Array.isArray(parent)) { const i = arrIndex(key, parent.length, false, op, index); const [removed] = parent.splice(i, 1); return { root, removed }; }
  if (!(key in parent)) throw new PatchError(`パスが存在しない: ${path}`, op, index);
  const removed = parent[key];
  delete parent[key];
  return { root, removed };
}

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** ops を順に適用した新しい文書を返す(元は変えない)。失敗したら PatchError(どの op で・なぜ)。 */
export function applyPatch<T = any>(doc: T, ops: PatchOp[]): T {
  let root: any = clone(doc);
  ops.forEach((op, i) => {
    if (!op || typeof op !== "object" || typeof op.path !== "string") throw new PatchError(`ops[${i}] が {op, path} の形ではない`, op, i);
    switch (op.op) {
      case "add": root = addAt(root, op.path, op.value, op, i); break;
      case "replace": {
        const segs = parsePtr(op.path);
        if (segs.length === 0) { root = clone(op.value); break; }
        const { parent, key } = getParent(root, segs, op, i);
        if (Array.isArray(parent)) parent[arrIndex(key, parent.length, false, op, i)] = clone(op.value);
        else { if (!(key in parent)) throw new PatchError(`replace の対象が無い: ${op.path}(add を使う)`, op, i); parent[key] = clone(op.value); }
        break;
      }
      case "remove": root = removeAt(root, op.path, op, i).root; break;
      case "move": {
        if (typeof op.from !== "string") throw new PatchError(`ops[${i}] move に from が無い`, op, i);
        const r = removeAt(root, op.from, op, i);
        root = addAt(r.root, op.path, r.removed, op, i);
        break;
      }
      case "copy": {
        if (typeof op.from !== "string") throw new PatchError(`ops[${i}] copy に from が無い`, op, i);
        root = addAt(root, op.path, getAt(root, op.from, op, i), op, i);
        break;
      }
      case "test": if (!deepEq(getAt(root, op.path, op, i), op.value)) throw new PatchError(`test 失敗: ${op.path}`, op, i); break;
      default: throw new PatchError(`ops[${i}].op が不明: ${JSON.stringify((op as any).op)}(add / replace / remove / move / copy / test)`, op, i);
    }
  });
  return root as T;
}

/**
 * 複数の issue が出した specPatch を 1 本にまとめる(同じ path への重複は最初のものだけ。配列の remove は添字の大きい方から)。
 * 添字を動かす remove が他の op の path をずらさないように、remove は最後に後ろから並べる。
 */
export function mergePatches(patches: PatchOp[][]): PatchOp[] {
  const seen = new Set<string>();
  const normal: PatchOp[] = [];
  const removes: PatchOp[] = [];
  for (const p of patches) {
    for (const op of p) {
      const key = `${op.op === "remove" ? "remove" : "set"}:${op.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      (op.op === "remove" ? removes : normal).push(op);
    }
  }
  const idx = (o: PatchOp) => { const m = /\/(\d+)$/.exec(o.path); return m ? Number(m[1]) : -1; };
  removes.sort((a, b) => {
    const pa = a.path.replace(/\/\d+$/, ""), pb = b.path.replace(/\/\d+$/, "");
    return pa === pb ? idx(b) - idx(a) : (a.path < b.path ? 1 : -1);
  });
  return [...normal, ...removes];
}
