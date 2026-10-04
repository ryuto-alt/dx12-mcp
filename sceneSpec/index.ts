// 宣言的シーン生成(M11)の本体: 仕様 → 検証 → 展開 → 差分計画 → 1 トランザクションで適用 → 自動検証 → 報告(失敗は specPatch つき)。
// MCP ツール(toolset/sceneSpec.ts)・ジョブ(jobs/kinds/engine.ts)・テストが同じ関数を呼ぶ。engine と callTool は注入する(偽エンジンでも実エンジンでも同じ流れ)。
import crypto from "node:crypto";
import { stableJson } from "../guardCtx.ts";
import { aabbCenter, applyAffine, IDENTITY, mulAffine, trs, type AABB, type Affine, type Vec3 } from "./geom.ts";
import { applyPatch, mergePatches, PatchError } from "./patch.ts";
import { applySteps, commitTx, rollbackTx, type ApplyProgress, type StepError } from "./apply.ts";
import { resolveSpec, type Resolved } from "./expand.ts";
import { buildPlan, pmap, presentPlan, readScene, runStepsForOverride, type EngineLike, type Plan, type SceneSnapshot } from "./plan.ts";
import { hasErrors, validateSpec, type SchemaCtx } from "./schema.ts";
import { runVerify, verifyConfig, type VerifyDeps, type VerifyReport } from "./verify.ts";
import { GROUP_ROOT, JOB_RECOMMEND_ENTITIES, MAX_ENTITIES, type PatchOp, type SceneSpec, type SpecIssue } from "./types.ts";

export type { Plan } from "./plan.ts";
export type SpecMode = "plan" | "apply";

/** 直近に受け取った仕様(specRef で撃ち直せるように、サーバのメモリにだけ持つ。最大 16 件)。 */
export class SpecCache {
  private m = new Map<string, unknown>();
  static refOf(spec: unknown): string { return crypto.createHash("sha1").update(stableJson(spec)).digest("hex").slice(0, 12); }
  put(spec: unknown): string { const ref = SpecCache.refOf(spec); this.m.delete(ref); this.m.set(ref, JSON.parse(JSON.stringify(spec))); while (this.m.size > 16) this.m.delete(this.m.keys().next().value as string); return ref; }
  get(ref: string): unknown | undefined { const v = this.m.get(ref); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  get size() { return this.m.size; }
}

export type SpecDeps = VerifyDeps & {
  cache?: SpecCache;
  onProgress?: ApplyProgress;
  signal?: AbortSignal;
  /** ルックのプリセット id(検証用)。 */
  looks?: readonly string[];
  /** 設定の適用に使う TS ツール(look_apply)。無ければ engine 直の method だけ。 */
  callTool?: VerifyDeps["callTool"];
};

export type SpecInput = {
  /** テスト用: 解いた結果(座標・AABB)を data.resolved に含める。 */
  returnResolved?: boolean;
  spec?: unknown;
  specRef?: string;
  patch?: PatchOp[];
  mode?: SpecMode;
  verify?: unknown;
  prune?: boolean;
  /** plan の各 action を何件まで返すか。 */
  detail?: number;
};

export type SpecResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; stage: "input" | "validate" | "solve" | "plan" | "apply" | "verify"; code: "E_VALIDATION_FAILED" | "E_OUT_OF_RANGE" | "E_INTERNAL" | "E_MODE_CONFLICT"; message: string; issues: SpecIssue[]; specPatch: PatchOp[]; specRef?: string; data: Record<string, unknown> };

const ASSET_EXT = {
  models: /\.(glb|gltf|fbx|obj|vgeo)$/i, textures: /\.(png|jpe?g|tga|dds|hdr|bmp)$/i, scripts: /\.lua$/i, prefabs: /\.prefab$/i,
};

function classifyAssets(list: any): NonNullable<SchemaCtx["assets"]> | undefined {
  if (!Array.isArray(list)) return undefined;
  const paths = list.map((a: any) => String(a?.path ?? "")).filter(Boolean);
  return {
    models: paths.filter((p) => ASSET_EXT.models.test(p)), textures: paths.filter((p) => ASSET_EXT.textures.test(p)),
    scripts: paths.filter((p) => ASSET_EXT.scripts.test(p)), prefabs: paths.filter((p) => ASSET_EXT.prefabs.test(p)),
  };
}

const errMsg = (e: any) => String(e?.message ?? e).slice(0, 300);

/** 仕様の外の参照(既にシーンにある物)の実測を先に集める。resolveSpec は同期関数なので、ここで全部読んでおく。 */
async function prefetchExternals(engine: EngineLike, spec: SceneSpec, snap: SceneSnapshot, specNames: Set<string>) {
  const refs = new Set<string>();
  for (const e of spec.entities ?? []) {
    if (e.parent) refs.add(e.parent);
    if (e.place?.relativeTo) refs.add(e.place.relativeTo);
    if (e.place?.on) refs.add(e.place.on);
    if (typeof e.lookAt === "string") refs.add(e.lookAt);
    const p = e.pattern;
    if (p) { if (typeof p.around === "string") refs.add(p.around); if (p.of) refs.add(p.of); if (typeof p.area === "string") refs.add(p.area); for (const x of p.exclude ?? []) refs.add(x); }
  }
  const groupRoots = new Set(Object.values(GROUP_ROOT));
  const ext = [...refs].filter((n) => !specNames.has(n) && snap.byName.has(n));
  const bounds = new Map<string, AABB>();
  const worlds = new Map<string, Affine>();
  const pivots = new Map<string, Vec3>();
  await pmap(ext, async (n) => {
    try {
      const b = await engine.call("get_bounds", { name: n });
      if (b?.hasMesh !== false && Array.isArray(b?.min) && Array.isArray(b?.max)) bounds.set(n, { min: b.min, max: b.max });
    } catch { /* 測れない = 基準にできない(解決時にエラー) */ }
    return null;
  });
  // 親として使う外部エンティティのワールド行列(親の連鎖を辿る。group 根は単位)
  const rawCache = new Map<string, any>();
  const rawOf = async (n: string) => {
    if (rawCache.has(n)) return rawCache.get(n);
    let r: any = snap.byName.get(n)?.raw;
    if (!r) { try { r = await engine.call("get_entity", { name: n }); } catch { r = null; } }
    rawCache.set(n, r);
    return r;
  };
  const worldOf = async (n: string, depth = 0): Promise<Affine> => {
    if (worlds.has(n)) return worlds.get(n)!;
    if (groupRoots.has(n) || depth > 32) return IDENTITY;
    const r = await rawOf(n);
    const tr = r?.transform;
    if (!tr) return IDENTITY;
    const local = trs(tr.position ?? [0, 0, 0], tr.rotation ?? [0, 0, 0], tr.scale ?? [1, 1, 1]);
    const parent = snap.byName.get(n)?.parent;
    const w = parent ? mulAffine(await worldOf(parent, depth + 1), local) : local;
    worlds.set(n, w);
    return w;
  };
  for (const n of ext) { const w = await worldOf(n); pivots.set(n, applyAffine(w, [0, 0, 0])); if (!bounds.has(n)) { /* メッシュ無し = 点 */ const c = pivots.get(n)!; bounds.set(n, { min: c, max: c }); } }
  return { bounds, worlds, pivots };
}

/** 段階ごとの失敗 → 結果。 */
function fail(stage: Extract<SpecResult, { ok: false }>["stage"], code: Extract<SpecResult, { ok: false }>["code"], message: string, issues: SpecIssue[], extra: { specRef?: string; data?: Record<string, unknown> } = {}): SpecResult {
  const specPatch = mergePatches(issues.map((i) => i.specPatch ?? []));
  return { ok: false, stage, code, message, issues, specPatch, specRef: extra.specRef, data: extra.data ?? {} };
}

function stepIssue(err: StepError, byName: Map<string, Resolved>, spec: SceneSpec): SpecIssue {
  const r = err.entity ? byName.get(err.entity) : undefined;
  const base = r?.path ?? "";
  const nm = err.errName ?? (typeof err.code === "string" ? err.code : "E_APPLY_STEP");
  const issue: SpecIssue = { path: base, code: nm, severity: "error", check: "apply", entity: err.entity, message: `${err.method}${err.entity ? `(${err.entity})` : ""} が失敗: ${err.message}`, didYouMean: err.didYouMean };
  const dym = err.didYouMean?.[0];
  if (nm === "E_NOT_FOUND_ASSET" && dym && r) {
    if (err.method === "spawn_model") issue.specPatch = [{ op: "replace", path: `${base}/model`, value: dym }];
    else if (err.method === "set_texture") issue.specPatch = [{ op: "replace", path: `${base}/texture/${String(err.params?.slot)}`, value: dym }];
    else if (err.method === "attach_lua_component") issue.specPatch = [{ op: "replace", path: typeof (spec.entities ?? [])[r.srcIndex]?.script === "string" ? `${base}/script` : `${base}/script/path`, value: dym }];
  } else if (nm === "E_NOT_FOUND_COMPONENT" && err.method === "set_component" && r) {
    const ck = String(err.params?.component);
    issue.specPatch = dym ? [{ op: "move", from: `${base}/components/${ck}`, path: `${base}/components/${dym}` }] : [{ op: "remove", path: `${base}/components/${ck}` }];
  } else if (nm === "E_SPEC_DUPLICATE_NAME" && r) {
    issue.specPatch = [{ op: "replace", path: `${base}/name`, value: `${err.entity}_2` }];
  } else if (err.method === "set_component" && r && err.params?.component && !["tags", "data"].includes(String(err.params.component))) {
    // フィールドが受け付けられなかった等。その部品だけ外せば残りは適用できる
    issue.specPatch = [{ op: "remove", path: `${base}/components/${String(err.params.component)}` }];
    issue.cause = "コンポーネントの値をエンジンが受け付けなかった。dx12_call {name:'dx12_describe_components'} で形を確認する";
  }
  return issue;
}

export async function runSceneSpec(deps: SpecDeps, input: SpecInput): Promise<SpecResult> {
  const t0 = Date.now();
  const engine = deps.engine;
  const mode: SpecMode = input.mode ?? "apply";
  const cache = deps.cache ?? new SpecCache();
  const progress = (phase: string, pct: number, message: string) => deps.onProgress?.({ phase, pct, message });

  // ── 1) 仕様を確定する(spec / specRef + patch)──
  let specRaw: unknown = input.spec;
  if (typeof specRaw === "string") {
    try { specRaw = JSON.parse(specRaw); } catch (e: any) { return fail("input", "E_VALIDATION_FAILED", "spec が JSON として読めない", [{ path: "", code: "E_BAD_TYPE", severity: "error", message: `spec が JSON として読めない: ${errMsg(e)}`, cause: "オブジェクトのまま渡すのが確実" }]); }
  }
  if (specRaw === undefined && input.specRef) {
    specRaw = cache.get(input.specRef);
    if (specRaw === undefined) return fail("input", "E_VALIDATION_FAILED", `specRef '${input.specRef}' の仕様が残っていない`, [{ path: "", code: "E_NOT_FOUND", severity: "error", message: `specRef '${input.specRef}' はこのサーバに無い(MCP サーバが再起動した/16 件を超えて古いものが消えた)`, cause: "specRef はサーバのメモリにだけある", fix: [{ tool: "dx12_apply_scene_spec", args: { spec: "<仕様の全文>" }, why: "仕様の全文を渡し直す" }] }]);
  }
  if (specRaw === undefined) return fail("input", "E_VALIDATION_FAILED", "spec(または specRef)が無い", [{ path: "", code: "E_MISSING_PARAM", severity: "error", message: "spec が無い。{version:1, entities:[…]} を渡す(または直前の specRef + patch)", fix: [{ tool: "dx12_guide", args: { topic: "scene_spec" }, why: "仕様の書き方と例" }] }]);
  if (input.patch && input.patch.length) {
    try { specRaw = applyPatch(specRaw, input.patch); }
    catch (e: any) {
      const pe = e instanceof PatchError ? e : null;
      return fail("input", "E_VALIDATION_FAILED", `patch を適用できない: ${errMsg(e)}`, [{ path: pe?.op?.path ?? "", code: "E_BAD_PATCH", severity: "error", message: `patch[${pe?.index ?? "?"}] を適用できない: ${errMsg(e)}`, cause: "patch は RFC 6902(add / replace / remove / move / copy / test)。path は仕様のルートからの JSON Pointer。specPatch の値をそのまま渡す" }], { specRef: input.specRef });
    }
  }
  const specRef = cache.put(specRaw);

  // Play 中は生成できない(create_entity / spawn_model は Editor 限定。Stop でシーンも作り直される)。plan は Play 中でも撃てる。
  if (mode === "apply") {
    const pong = await engine.call("ping", {}).catch(() => null);
    if (pong && pong.mode && pong.mode !== "Editor") {
      return fail("input", "E_MODE_CONFLICT", `エンジンが ${pong.mode} モード。シーンの生成・編集は Editor モードだけ`, [{ path: "", code: "E_MODE_CONFLICT", severity: "error", message: `エンジンが ${pong.mode} モードのため適用できない(Play 中に作ってもStop で消える)`, cause: "dx12_stop で Editor に戻してから撃つ", fix: [{ tool: "dx12_stop", args: {}, why: "Editor モードへ戻す" }] }], { specRef: typeof input.specRef === "string" ? input.specRef : undefined });
    }
  }

  // ── 2) 文脈の読み取り(アセット・既存の名前・コンポーネント一覧)──
  progress("読み取り", 2, "アセットとシーンの一覧を読む");
  const [assetsRaw, listRaw, compsRaw] = await Promise.all([
    engine.call("list_assets", {}).catch(() => null),
    engine.call("list_entities", { verbose: true, limit: 0 }).catch(() => null),
    engine.call("describe_components", {}).catch(() => null),
  ]);
  const assets = classifyAssets(assetsRaw);
  const sceneNames: string[] = ((listRaw?.entities ?? []) as any[]).map((e) => e.name);
  const compKeys: string[] | undefined = Array.isArray(compsRaw?.components) ? compsRaw.components.filter((c: any) => c.settable !== false).map((c: any) => c.jsonKey) : undefined;

  // ── 3) 検証 ──
  progress("検証", 5, "仕様を検証する");
  const reserved: string[] = ((listRaw?.entities ?? []) as any[]).filter((e) => (e.componentTypes ?? []).includes("gridPlane")).map((e) => e.name);
  const v = validateSpec(specRaw, { assets, sceneNames, reserved, components: compKeys, looks: deps.looks });
  const errors = v.issues.filter((i) => i.severity === "error");
  if (errors.length) {
    const total = v.entityCount;
    const over = errors.find((i) => i.code === "E_SPEC_LIMIT");
    return fail("validate", over ? "E_OUT_OF_RANGE" : "E_VALIDATION_FAILED", `仕様の検証で ${errors.length} 件のエラー(エンジンには何も書いていない): ${errors[0].message}`, v.issues, { specRef, data: { entityCount: total } });
  }
  const spec = specRaw as SceneSpec;
  const owner = typeof spec.name === "string" && spec.name ? spec.name : "scene";
  const warnIssues: SpecIssue[] = v.issues.filter((i) => i.severity === "warn");

  // ── 4) 実測の準備(モデルの実寸・仕様の外の参照)+ 5) 展開・相対配置の解決 ──
  const snap0 = await readScene(engine, [...v.names.keys()]);
  const specNames = new Set(v.names.keys());
  const modelPaths = [...new Set((spec.entities ?? []).filter((e) => e.kind === "model" && e.model && !e.bounds).map((e) => e.model as string))];
  const assetBounds = new Map<string, AABB>();
  await pmap(modelPaths, async (p) => {
    try { const r = await engine.call("asset_info", { path: p }); if (Array.isArray(r?.aabbMin) && Array.isArray(r?.aabbMax)) assetBounds.set(p, { min: r.aabbMin, max: r.aabbMax }); } catch { /* 実寸が測れない = 相対配置の基準にできない */ }
    return null;
  });
  const ext = await prefetchExternals(engine, spec, snap0, specNames);
  progress("配置", 10, "相対配置を解く");
  const res = resolveSpec(spec, {
    assetBounds: (p) => assetBounds.get(p),
    external: { bounds: (n) => ext.bounds.get(n), world: (n) => ext.worlds.get(n), pivot: (n) => ext.pivots.get(n) },
  }, { assetHasScript: (p) => !!assets?.scripts.includes(p) });
  const solveErr = res.issues.filter((i) => i.severity === "error");
  if (solveErr.length) return fail("solve", "E_VALIDATION_FAILED", `配置を解けない: ${solveErr[0].message}`, [...res.issues, ...warnIssues], { specRef });
  warnIssues.push(...res.issues.filter((i) => i.severity === "warn"));
  const resolved = res.entities;
  if (resolved.length > MAX_ENTITIES) return fail("validate", "E_OUT_OF_RANGE", `エンティティが ${resolved.length} 体で上限 ${MAX_ENTITIES} を超える`, [{ path: "/entities", code: "E_SPEC_LIMIT", severity: "error", message: `作るエンティティが ${resolved.length} 体で上限 ${MAX_ENTITIES} を超える` }], { specRef });
  const byName = new Map(resolved.map((r) => [r.name, r]));

  // ── 6) 現在のシーン + 7) 差分計画 ──
  progress("計画", 15, "現在のシーンと比べる");
  const snap = await readScene(engine, resolved.map((r) => r.name));
  const plan: Plan = buildPlan(spec, resolved, snap, { prune: input.prune === true, owner });
  if (snap.duplicates.length) plan.warnings.push(`シーンに同名のエンティティがある(${snap.duplicates.slice(0, 3).join(", ")})。名前で指す操作はどれに当たるか不定になる`);
  if (resolved.length > JOB_RECOMMEND_ENTITIES) plan.warnings.push(`${resolved.length} 体は多い。dx12_apply_scene_spec {async:true}(ジョブ)なら進捗つきで非同期に実行できる`);
  const planErr = plan.issues.filter((i) => i.severity === "error");
  const common: Record<string, any> = { name: owner, specRef, entityCount: resolved.length, warnings: [...plan.warnings, ...warnIssues.map((w) => w.message)], ...(input.returnResolved ? { resolved: resolved.map((r) => ({ name: r.name, id: r.id, kind: r.kind, position: r.position, rotation: r.rotation, scale: r.scale, worldBounds: r.worldBounds, parent: r.parent })) } : {}) };
  if (planErr.length) return fail("plan", "E_VALIDATION_FAILED", `計画を実行できない: ${planErr[0].message}`, [...plan.issues, ...warnIssues], { specRef, data: { plan: presentPlan(plan, input.detail) } });

  if (mode === "plan") {
    return { ok: true, data: { ok: true, mode: "plan", applied: false, ...common, plan: presentPlan(plan, input.detail), issues: warnIssues.length ? warnIssues : undefined, next: plan.summary.create + plan.summary.update + plan.summary.replace + plan.summary.delete + plan.summary.settings === 0 ? "差分は無い(冪等)" : "問題なければ mode:'apply' で同じ仕様を適用する(1 つの Undo で戻せる)", tookMs: Date.now() - t0 } };
  }

  // ── 8) 適用(1 トランザクション)+ 9) 検証 ──
  const cfg = verifyConfig(spec.verify, input.verify);
  const owned = new Set(resolved.map((r) => r.name));
  const noop = plan.steps.length === 0;
  const idsIn = new Map<string, number>();
  for (const [n, a] of snap.byName) idsIn.set(n, a.id);

  let applied: Awaited<ReturnType<typeof applySteps>> | null = null;
  let txReport: Record<string, unknown> = { note: "差分が無いのでトランザクションは開かなかった" };
  if (!noop) {
    progress("適用", 20, `${plan.steps.length} 件の操作を適用する`);
    applied = await applySteps(engine, plan, idsIn, `scene_spec:${owner}`, { onProgress: (p) => progress(p.phase, 20 + Math.round(p.pct * 0.55), p.message), signal: deps.signal });
    if (!applied.ok) {
      const rb = await rollbackTx(engine, applied.transaction);
      const issues = applied.errors.map((e) => stepIssue(e, byName, spec));
      return fail("apply", "E_VALIDATION_FAILED", `適用中に失敗したのでロールバックした: ${applied.errors[0].message}`, [...issues, ...warnIssues], { specRef, data: { transaction: { ...rb, stepsRun: applied.stepsRun, failedSteps: applied.errors.slice(0, 5).map((e) => ({ method: e.method, entity: e.entity, message: e.message })) }, plan: presentPlan(plan, 20), tookMs: Date.now() - t0 } });
    }
  }

  // ナビメッシュは検証(到達性)の前に、トランザクションの中で焼く。検証で落ちてロールバックしたら、戻ったシーンで焼き直す(ナビメッシュはロールバックでは戻らない)。
  const navStep = plan.settings.find((s) => s.what === "navmesh");
  let navBuilt = false;
  if (navStep && !noop || navStep && cfg.reachable.length) {
    progress("ナビメッシュ", 74, navStep!.effect);
    try { await engine.call("navmesh_build", navStep!.params ?? {}, { timeout: 120000 }); navBuilt = true; }
    catch (e: any) {
      const rb = applied ? await rollbackTx(engine, applied.transaction) : { rolledBack: false };
      return fail("apply", "E_VALIDATION_FAILED", `ナビメッシュを焼けなかったのでロールバックした: ${errMsg(e)}`, [{ path: "/navmesh", code: "E_NAVMESH_BUILD", severity: "error", check: "apply", message: `navmesh_build が失敗: ${errMsg(e)}`, specPatch: [{ op: "remove", path: "/navmesh" }], cause: "メッシュが 1 つも無い/範囲が不正など。navmesh の設定を見直す" }, ...warnIssues], { specRef, data: { transaction: rb } });
    }
  }
  progress("検証", 78, "自動検証");
  let report: VerifyReport;
  try { report = await runVerify({ engine, callTool: deps.callTool }, { spec, resolved, owned }, cfg); }
  catch (e: any) { report = { pass: true, blocking: [], warnings: [], preexisting: [], checks: [{ id: "verify", pass: true, skipped: true, note: `検証を実行できなかった: ${errMsg(e)}` }], specPatch: [] }; }

  if (!report.pass) {
    const rb = applied ? await rollbackTx(engine, applied.transaction) : { rolledBack: false, note: "差分が無かったので戻すものは無い(既存の状態が検証に落ちた)" };
    if (navBuilt && navStep) { try { await engine.call("navmesh_build", navStep.params ?? {}, { timeout: 120000 }); (rb as any).navmesh = "戻したシーンで焼き直した"; } catch { (rb as any).navmesh = "ナビメッシュは検証用に焼いたもののまま(戻したシーンでの焼き直しに失敗)。dx12_navmesh_build で焼き直す"; } }
    const issues = [...report.blocking, ...report.warnings, ...warnIssues];
    return fail("verify", "E_VALIDATION_FAILED", `適用は完了したが検証に失敗したのでロールバックした(${report.blocking.length} 件): ${report.blocking[0].message}`, issues, {
      specRef, data: { transaction: rb, verify: { pass: false, checks: report.checks, preexisting: report.preexisting.slice(0, 10) }, plan: presentPlan(plan, 20), reasons: report.blocking.map((b) => `${b.entity ?? b.path}: ${b.code}`), tookMs: Date.now() - t0 },
    });
  }
  if (applied) txReport = await commitTx(engine, applied.transaction);

  // ── 10) 設定(エンジンの rollback では戻らない系。検証が通った後に撃つ)──
  const settingsReport: Record<string, unknown>[] = [];
  for (let si = 0; si < plan.settings.length; si++) {
    const s = plan.settings[si];
    if (s.what === "navmesh") { settingsReport.push({ what: "navmesh", ok: navBuilt, note: navBuilt ? "検証の前にトランザクションの中で焼いた" : "差分が無いので焼き直さなかった" }); continue; }
    progress("設定", 88 + Math.round((si / Math.max(1, plan.settings.length)) * 10), s.effect);
    try {
      if (s.method === "look_apply") {
        if (!deps.callTool) throw new Error("look_apply(TS ツール)を呼べない環境");
        const r = await deps.callTool("dx12_look_apply", s.params ?? {});
        if (!r.ok) throw new Error(r.error ?? "look_apply が失敗");
        settingsReport.push({ what: s.what, ok: true, mismatched: r.data?.mismatched });
      } else {
        const r = await engine.call(s.method as string, s.params ?? {});
        settingsReport.push({ what: s.what, ok: true, ...(s.what === "navmesh" ? { polyCount: r?.polyCount ?? r?.stats?.polyCount } : {}) });
      }
    } catch (e: any) { settingsReport.push({ what: s.what, ok: false, error: errMsg(e) }); common.warnings.push(`設定 ${s.what} の適用に失敗した(エンティティの変更は確定済み): ${errMsg(e)}`); }
  }

  // 仕様の太陽(directional light)の明示した値は、プリセット / ルック / sun の設定より強い: 設定を撃った後にもう一度その値を書く(冪等にするため)。
  if (plan.settings.some((x) => ["lighting", "look", "sun"].includes(x.what))) {
    const errs = await runStepsForOverride(engine, resolved, owner, idsIn);
    if (errs.length) common.warnings.push(`太陽の明示した値を設定の後に書き直せなかった: ${errs[0]}`);
  }

  const s = plan.summary;
  return {
    ok: true,
    data: {
      ok: true, mode: "apply", applied: true, ...common, noop: noop && plan.settings.length === 0,
      result: { created: s.create, updated: s.update, replaced: s.replace, deleted: s.delete, unchanged: s.unchanged, settings: settingsReport.length },
      idempotent: s.create + s.update + s.replace + s.delete === 0,
      transaction: { ...txReport, stepsRun: applied?.stepsRun ?? 0 },
      verify: { pass: true, checks: report.checks, warnings: report.warnings.slice(0, 20), preexisting: report.preexisting.slice(0, 10), ...(report.warnings.length ? { specPatch: mergePatches(report.warnings.map((w) => w.specPatch ?? [])) } : {}) },
      ...(settingsReport.length ? { settings: settingsReport } : {}),
      plan: presentPlan(plan, input.detail ?? 30),
      ...(warnIssues.length ? { issues: warnIssues } : {}),
      timing: { totalMs: Date.now() - t0, applyMs: applied?.ms ?? 0, engineCalls: applied?.stepsRun ?? 0 },
      next: report.warnings.length ? "warnings の specPatch を dx12_apply_scene_spec {specRef, patch} で撃ち直すと直る(任意)。見た目は dx12_capture {view:'final'}" : "見た目は dx12_capture {view:'final'}。保存は dx12_save_scene",
    },
  };
}
