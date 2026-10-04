// 事前検証(M2)。エンジンへ送る前に、引数の誤りを【往復せずに】構造化エラーで返す。
//
//   - 旧 TS ツール(dx12_xxx)  : zod スキーマ(SDK が検証するのと同じもの)で検証し、ZodIssue を E_* に写す
//   - TS ラッパの無い method  : マニフェストの params(型/必須/enum/範囲)で検証する
//   どちらも「未知キー」は近い正解つきで返す(paramGuard の流儀)。
//
// 各エラーは validValues / didYouMean / fix(そのまま撃ち直せる引数)を可能な限り付ける。

import { z } from "zod";
import type { ErrorBody, ErrorCodeName, Fix } from "./errors.ts";
import { nearest } from "./errors.ts";
import { GLOBAL_PARAM_KEYS, METHOD_KEY_ALIASES, nearestKey } from "./paramGuard.ts";
import type { ManifestParam } from "./manifest.ts";

type Args = Record<string, unknown>;

// ── パス操作 ────────────────────────────────────────────────────────────

function getPath(obj: any, path: (string | number)[]): unknown {
  let cur = obj;
  for (const k of path) { if (cur == null) return undefined; cur = cur[k as any]; }
  return cur;
}

function setPath(obj: Args, path: (string | number)[], value: unknown): Args {
  const root: any = structuredClone(obj);
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as any;
    if (cur[k] == null || typeof cur[k] !== "object") return root;
    cur = cur[k];
  }
  if (path.length) cur[path[path.length - 1] as any] = value;
  return root;
}

function deletePath(obj: Args, path: (string | number)[]): Args {
  const root: any = structuredClone(obj);
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) { cur = cur?.[path[i] as any]; if (cur == null) return root; }
  if (cur) delete cur[path[path.length - 1] as any];
  return root;
}

const pathStr = (p: (string | number)[]) => p.map(String).join(".");

/** 型が違う値を期待型へ機械的に直せるなら直した値を返す(直せなければ undefined)。 */
export function coerceValue(expected: string, value: unknown): { ok: boolean; value?: unknown } {
  if ((expected === "number" || expected === "integer") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return { ok: true, value: expected === "integer" ? Math.round(Number(value)) : Number(value) };
  }
  if (expected === "integer" && typeof value === "number" && Number.isFinite(value)) return { ok: true, value: Math.round(value) };
  if (expected === "boolean" && typeof value === "string" && /^(true|false)$/i.test(value)) return { ok: true, value: value.toLowerCase() === "true" };
  if (expected === "boolean" && typeof value === "number" && (value === 0 || value === 1)) return { ok: true, value: value === 1 };
  if (expected === "string" && (typeof value === "number" || typeof value === "boolean")) return { ok: true, value: String(value) };
  if (expected === "array" && (typeof value === "number" || typeof value === "boolean")) return { ok: true, value: [value] };
  if (expected === "array" && typeof value === "string") {
    try { const v = JSON.parse(value); if (Array.isArray(v)) return { ok: true, value: v }; } catch { /* 次へ */ }
    // "0,1,0" / "0 1 0" のような数値の並びは配列にできる(vec3 など)
    const parts = value.trim().replace(/^[\[(]|[\])]$/g, "").split(/[\s,]+/).filter(Boolean);
    if (parts.length > 1 && parts.every((s) => s !== "" && Number.isFinite(Number(s)))) return { ok: true, value: parts.map(Number) };
  }
  if (expected === "object" && typeof value === "string") {
    try { const v = JSON.parse(value); if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, value: v }; } catch { /* 直せない */ }
  }
  return { ok: false };
}

export type ParamIssue = {
  path: string;
  code: ErrorCodeName;
  message: string;
  expected?: string;
  received?: unknown;
  validValues?: string[];
  didYouMean?: string[];
  min?: number;
  max?: number;
  /** 直した引数全体(直せるときだけ)。 */
  fixedArgs?: Args;
};

// ── zod ─────────────────────────────────────────────────────────────────

function receivedName(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function issueFromZod(iss: any, args: Args): ParamIssue {
  const path: (string | number)[] = iss.path ?? [];
  const p = pathStr(path) || "(args)";
  const received = getPath(args, path);
  switch (iss.code) {
    case "invalid_type": {
      if (iss.received === "undefined" || received === undefined) {
        return { path: p, code: "E_MISSING_PARAM", message: `必須の引数 '${p}' が無い(${iss.expected} が必要)`, expected: iss.expected };
      }
      const co = coerceValue(iss.expected, received);
      const issue: ParamIssue = {
        path: p, code: "E_BAD_TYPE", expected: iss.expected, received,
        message: `引数 '${p}' の型が違う: ${iss.expected} が必要だが ${receivedName(received)} が来た`,
      };
      if (co.ok) issue.fixedArgs = setPath(args, path, co.value);
      return issue;
    }
    case "invalid_enum_value": {
      const options: string[] = (iss.options ?? []).map(String);
      const dym = typeof received === "string" ? nearest(received, options, 3, { liberal: options.length <= 16 }) : [];
      const issue: ParamIssue = {
        path: p, code: "E_BAD_ENUM", received, validValues: options, didYouMean: dym,
        message: `引数 '${p}' に ${JSON.stringify(received)} は使えない(有効な値: ${options.join(", ")})`,
      };
      if (dym[0]) issue.fixedArgs = setPath(args, path, dym[0]);
      return issue;
    }
    case "invalid_literal": {
      const exp = String(iss.expected);
      return { path: p, code: "E_BAD_ENUM", received, validValues: [exp], didYouMean: [exp], message: `引数 '${p}' は ${JSON.stringify(iss.expected)} でなければならない`, fixedArgs: setPath(args, path, iss.expected) };
    }
    case "too_small": case "too_big": {
      const isMin = iss.code === "too_small";
      const bound = isMin ? iss.minimum : iss.maximum;
      if (iss.type === "number") {
        const issue: ParamIssue = {
          path: p, code: "E_OUT_OF_RANGE", received, [isMin ? "min" : "max"]: bound,
          message: `引数 '${p}' が範囲外: ${received} は ${bound} ${isMin ? "以上" : "以下"}でなければならない`,
        } as ParamIssue;
        issue.fixedArgs = setPath(args, path, bound);
        return issue;
      }
      // 配列/文字列の長さ
      const unit = iss.type === "array" ? "要素" : "文字";
      const exact = iss.exact === true;
      return {
        path: p, code: exact ? "E_BAD_TYPE" : "E_OUT_OF_RANGE", received,
        message: exact ? `引数 '${p}' は ${bound} ${unit}ちょうどが必要`
                       : `引数 '${p}' の長さが範囲外: ${bound} ${unit}${isMin ? "以上" : "以下"}が必要`,
      };
    }
    case "invalid_union": {
      // 各候補の literal/enum を集めて有効値にする
      const opts: string[] = [];
      for (const ue of iss.unionErrors ?? []) for (const sub of ue.issues ?? []) {
        if (sub.code === "invalid_enum_value") opts.push(...(sub.options ?? []).map(String));
        if (sub.code === "invalid_literal") opts.push(String(sub.expected));
      }
      const uniq = [...new Set(opts)];
      const dym = typeof received === "string" ? nearest(received, uniq, 3, { liberal: uniq.length <= 16 }) : [];
      const issue: ParamIssue = {
        path: p, code: uniq.length ? "E_BAD_ENUM" : "E_BAD_TYPE", received,
        message: uniq.length ? `引数 '${p}' に ${JSON.stringify(received)} は使えない(有効な値: ${uniq.join(", ")}、または別形式の値)`
                             : `引数 '${p}' はどの受け付ける形式にも合わない`,
      };
      if (uniq.length) { issue.validValues = uniq; issue.didYouMean = dym; if (dym[0]) issue.fixedArgs = setPath(args, path, dym[0]); }
      return issue;
    }
    default:
      return { path: p, code: "E_BAD_TYPE", received, message: `引数 '${p}': ${iss.message}` };
  }
}

/** 未知キー(黙って捨てられる分)を近い正解つきの issue にする。 */
export function unknownKeyIssues(args: Args, declared: readonly string[], extraAllowed: readonly string[] = []): ParamIssue[] {
  const allowed = new Set<string>([...declared, ...GLOBAL_PARAM_KEYS, ...extraAllowed]);
  const out: ParamIssue[] = [];
  for (const k of Object.keys(args)) {
    // "親.子" 形式で宣言されたキーの親はここでは許す
    if (allowed.has(k)) continue;
    const near = nearestKey(k, declared);
    const fixedArgs = (() => {
      const c: Args = { ...args };
      const v = c[k];
      delete c[k];
      if (near && !(near in c)) c[near] = v;
      return c;
    })();
    out.push({
      path: k, code: "E_UNKNOWN_PARAM",
      message: near ? `知らない引数 '${k}'(→ '${near}' のことか?)` : `知らない引数 '${k}'`,
      received: args[k], didYouMean: near ? [near] : [], fixedArgs,
      validValues: declared.length > 0 && declared.length <= 32 ? [...declared] : undefined,
    });
  }
  return out;
}

export type ValidationOutcome<T = Args> = { ok: true; data: T } | { ok: false; body: ErrorBody };

/**
 * 旧 TS ツールの引数を検証する。未知キー → zod の順に見て、最初の誤りを主エラーにし、
 * 全部の issue と「全部直した引数」(直せるときだけ)を返す。
 */
export function validateAgainstShape(
  tool: string, shape: Record<string, z.ZodTypeAny>, args: Args,
): ValidationOutcome {
  const declared = Object.keys(shape);
  const issues: ParamIssue[] = [];
  issues.push(...unknownKeyIssues(args, declared, METHOD_KEY_ALIASES[tool.replace(/^dx12_/, "")] ?? []));
  const parsed = z.object(shape).passthrough().safeParse(args);
  if (!parsed.success) for (const iss of parsed.error.issues) issues.push(issueFromZod(iss, args));
  if (issues.length === 0) return { ok: true, data: parsed.success ? (parsed.data as Args) : args };
  return { ok: false, body: bodyFromIssues(tool, args, issues, declared) };
}

/** issue 群 → ErrorBody。fix には「機械的に直せた引数全体」を 1 つ、無理なら tool_describe を入れる。 */
export function bodyFromIssues(tool: string, args: Args, issues: ParamIssue[], declared: readonly string[]): ErrorBody {
  const main = issues[0];
  // 全 issue の修正を順に重ねる(全部直せたときだけ「そのまま撃ち直せる」)
  let merged: Args | null = args;
  for (const iss of issues) {
    if (!iss.fixedArgs) { merged = null; break; }
    // 各 fixedArgs は元の args に対する 1 箇所の修正。差分だけを重ねる。
    merged = mergeFix(merged as Args, args, iss.fixedArgs);
  }
  const fix: Fix[] = [];
  if (merged) fix.push({ tool, args: merged, why: issues.length > 1 ? `${issues.length} 件の誤りを機械的に直した引数` : "誤りを直した引数" });
  else if (main.fixedArgs) fix.push({ tool, args: main.fixedArgs, why: "最初の誤りだけ直した引数(残りは issues を参照)" });
  fix.push({ tool: "dx12_tool_describe", args: { name: tool }, why: "引数の一覧・型・例を確認する" });
  const body: ErrorBody = {
    code: main.code,
    message: `${tool}: ${main.message}`,
    cause: main.message,
    retryable: false,
    didYouMean: main.didYouMean?.length ? main.didYouMean : undefined,
    validValues: main.validValues,
    fix,
    docs: `dx12_tool_describe {name:'${tool}'}`,
  };
  if (issues.length > 1) body.issues = issues.map(({ fixedArgs: _f, ...rest }) => rest);
  if (main.code === "E_OUT_OF_RANGE") body.details = { min: main.min, max: main.max, received: main.received };
  return body;
}

function mergeFix(current: Args, original: Args, fixed: Args): Args {
  // fixed と original の差(キー単位の追加/変更/削除)を current に適用する
  const out: Args = structuredClone(current);
  const keys = new Set([...Object.keys(original), ...Object.keys(fixed)]);
  for (const k of keys) {
    if (JSON.stringify(original[k]) === JSON.stringify(fixed[k])) continue;
    if (k in fixed) out[k] = fixed[k]; else delete out[k];
  }
  return out;
}

// ── マニフェストの params(TS ラッパの無い method) ──────────────────────────────

function checkType(p: ManifestParam, v: unknown): { ok: boolean; expected: string } {
  const t = p.type;
  switch (t) {
    case "bool": case "boolean": return { ok: typeof v === "boolean", expected: "boolean" };
    case "int": case "integer": return { ok: typeof v === "number" && Number.isInteger(v), expected: "integer" };
    case "number": case "float": return { ok: typeof v === "number" && Number.isFinite(v), expected: "number" };
    case "string": case "assetPath": return { ok: typeof v === "string", expected: "string" };
    case "entityRef": return { ok: (typeof v === "number" && Number.isInteger(v)) || typeof v === "string", expected: "integer|string" };
    case "vec2": return { ok: Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number"), expected: "array" };
    case "vec3": return { ok: Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number"), expected: "array" };
    case "vec4": return { ok: Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number"), expected: "array" };
    case "array": return { ok: Array.isArray(v), expected: "array" };
    case "object": return { ok: v !== null && typeof v === "object" && !Array.isArray(v), expected: "object" };
    case "enum": return { ok: typeof v === "string", expected: "string" };
    default: return { ok: true, expected: t };   // any / 未知の型は検査しない
  }
}

/**
 * マニフェストの params で検証する。source が derived/fallback(型だけ・説明なし)のときは
 * 型が "any" になりがちなので、型は検査しても必須/範囲は宣言があるものだけ見る。
 */
export function validateAgainstParams(
  method: string, params: ManifestParam[], args: Args, opts: { checkUnknown?: boolean } = {},
): ValidationOutcome {
  const issues: ParamIssue[] = [];
  const declared = params.map((p) => p.name);
  const topLevel = [...new Set(declared.map((n) => n.split(".")[0]))];
  if (opts.checkUnknown !== false) {
    issues.push(...unknownKeyIssues(args, topLevel, METHOD_KEY_ALIASES[method] ?? []));
  }
  for (const p of params) {
    if (p.name.includes(".")) continue;   // 入れ子の子キーは親(object)が受ける
    const v = args[p.name];
    if (v === undefined) {
      if (p.required) {
        const fixedArgs = p.default !== undefined ? { ...args, [p.name]: p.default }
          : p.enum?.length === 1 ? { ...args, [p.name]: p.enum[0] } : undefined;
        issues.push({ path: p.name, code: "E_MISSING_PARAM", expected: p.type, validValues: p.enum, message: `必須の引数 '${p.name}' が無い(${p.type}${p.desc ? `: ${p.desc}` : ""})`, fixedArgs });
      }
      continue;
    }
    const ty = checkType(p, v);
    if (!ty.ok) {
      const co = coerceValue(ty.expected === "integer|string" ? "integer" : ty.expected, v);
      issues.push({ path: p.name, code: "E_BAD_TYPE", expected: p.type, received: v, message: `引数 '${p.name}' の型が違う: ${p.type} が必要だが ${receivedName(v)} が来た`, fixedArgs: co.ok ? { ...args, [p.name]: co.value } : undefined });
      continue;
    }
    if (p.enum?.length && typeof v === "string" && !p.enum.includes(v)) {
      const dym = nearest(v, p.enum, 3, { liberal: p.enum.length <= 16 });
      issues.push({ path: p.name, code: "E_BAD_ENUM", received: v, validValues: p.enum, didYouMean: dym, message: `引数 '${p.name}' に ${JSON.stringify(v)} は使えない(有効な値: ${p.enum.join(", ")})`, fixedArgs: dym[0] ? { ...args, [p.name]: dym[0] } : undefined });
      continue;
    }
    if (typeof v === "number") {
      if (p.min != null && v < p.min) issues.push({ path: p.name, code: "E_OUT_OF_RANGE", received: v, min: p.min, message: `引数 '${p.name}' が範囲外: ${v} は ${p.min} 以上でなければならない`, fixedArgs: { ...args, [p.name]: p.min } });
      else if (p.max != null && v > p.max) issues.push({ path: p.name, code: "E_OUT_OF_RANGE", received: v, max: p.max, message: `引数 '${p.name}' が範囲外: ${v} は ${p.max} 以下でなければならない`, fixedArgs: { ...args, [p.name]: p.max } });
    }
  }
  if (issues.length === 0) return { ok: true, data: args };
  return { ok: false, body: bodyFromIssues(method, args, issues, declared) };
}
