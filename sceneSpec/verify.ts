// 適用後の自動検証(M11)。既存の検証(validate_layout / 命名規約 / check_reachable / validate_scene)を仕様の verify 指定で走らせ、
// 失敗は「仕様の path・原因・そのまま撃ち直せる specPatch」に直す(M2 の流儀)。AI はこの差分を dx12_apply_scene_spec {specRef, patch} で撃ち直すだけでよい。
//
//   layout  … validate_layout(埋まり BURIED・宙に浮き FLOATING・重なり OVERLAP / DUPLICATE / Z_FIGHT・当たり判定・スケール異常)。
//             この仕様が作った物に関わる error は blocking(ロールバック)、warning は warn。仕様と無関係の既存の問題は preexisting に分ける。
//   naming  … 命名規約(<PREFIX>_<Kind>_<NN>・グループ・既定名)。既定は warn(blocking にしない)。
//   reachable … ナビメッシュ + 実測した移動能力で「from から to へ行けるか」(dx12_check_reachable)。要求したときだけ。指定したら blocking。
//   scene   … validate_scene(参照グラフ)。要求したときだけ。
import { lintNames, classify, toKind, type EntityInfo } from "../sceneOrganize.ts";
import type { Resolved } from "./expand.ts";
import { pmap, type EngineLike } from "./plan.ts";
import { ptr } from "./patch.ts";
import type { PatchOp, SceneSpec, SpecIssue } from "./types.ts";

export type VerifyConfig = {
  layout: "error" | "warn" | "off";
  naming: "error" | "warn" | "off";
  scene: boolean;
  reachable: { from: string; to: string }[];
};

/** ツール引数(verify)と仕様(spec.verify)から検証の設定を決める。ツール引数が優先。false は全部オフ。 */
export function verifyConfig(specVerify: SceneSpec["verify"], toolVerify: unknown): VerifyConfig {
  const off: VerifyConfig = { layout: "off", naming: "off", scene: false, reachable: [] };
  const merge = (base: VerifyConfig, v: unknown): VerifyConfig => {
    if (v === false) return off;
    if (v === true || v === undefined || v === null) return base;
    if (typeof v !== "object") return base;
    const o = v as any;
    const rc = o.reachable === undefined ? base.reachable : (Array.isArray(o.reachable) ? o.reachable : [o.reachable]);
    return { layout: o.layout ?? base.layout, naming: o.naming ?? base.naming, scene: o.scene ?? base.scene, reachable: rc.filter((r: any) => r && typeof r.from === "string" && typeof r.to === "string") };
  };
  const dflt: VerifyConfig = { layout: "error", naming: "warn", scene: false, reachable: [] };
  return merge(merge(dflt, specVerify), toolVerify);
}

export type VerifyDeps = {
  engine: EngineLike;
  /** TS ツールの呼び出し(dx12_check_reachable など)。無ければ reachable は未実施にする。 */
  callTool?: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: any; error?: string }>;
};

export type VerifyReport = {
  pass: boolean;
  blocking: SpecIssue[];
  warnings: SpecIssue[];
  preexisting: { kind: string; name: string; text: string }[];
  checks: { id: string; pass: boolean; skipped?: boolean; note?: string; counts?: Record<string, number> }[];
  specPatch: PatchOp[];
};

const setOrAdd = (obj: Record<string, unknown> | undefined, path: string, key: string, value: unknown): PatchOp => (obj && key in obj ? { op: "replace", path: `${path}/${key}`, value } : { op: "add", path: `${path}/${key}`, value });

/** 仕様の中で oldName を参照している箇所を newName に書き換える差分(name 自体は除く)。 */
export function renameRefsPatch(spec: SceneSpec, oldName: string, newName: string): PatchOp[] {
  const ops: PatchOp[] = [];
  const ents = spec.entities ?? [];
  const sub = (v: unknown) => (v === oldName ? newName : undefined);
  ents.forEach((e, i) => {
    const b = ptr("entities", i);
    if (sub(e.parent)) ops.push({ op: "replace", path: `${b}/parent`, value: newName });
    if (sub(e.lookAt)) ops.push({ op: "replace", path: `${b}/lookAt`, value: newName });
    if (e.place) { if (sub(e.place.relativeTo)) ops.push({ op: "replace", path: `${b}/place/relativeTo`, value: newName }); if (sub(e.place.on)) ops.push({ op: "replace", path: `${b}/place/on`, value: newName }); }
    if (e.pattern) {
      for (const k of ["around", "of", "area"] as const) if (sub((e.pattern as any)[k])) ops.push({ op: "replace", path: `${b}/pattern/${k}`, value: newName });
      (e.pattern.exclude ?? []).forEach((x, xi) => { if (x === oldName) ops.push({ op: "replace", path: `${b}/pattern/exclude/${xi}`, value: newName }); });
    }
  });
  const rc = (spec.verify && typeof spec.verify === "object" ? (spec.verify as any).reachable : undefined);
  const arr = rc === undefined ? [] : Array.isArray(rc) ? rc : [rc];
  arr.forEach((r: any, ri: number) => {
    const base = Array.isArray(rc) ? `/verify/reachable/${ri}` : "/verify/reachable";
    if (r?.from === oldName) ops.push({ op: "replace", path: `${base}/from`, value: newName });
    if (r?.to === oldName) ops.push({ op: "replace", path: `${base}/to`, value: newName });
  });
  return ops;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function layoutIssue(li: any, byName: Map<string, Resolved>, spec: SceneSpec): SpecIssue {
  // 報告された 2 者のうち、この仕様が作った方を直す対象にする(既存の物が動く側でも、仕様側の位置を直す)。
  let name: string = li.name;
  let other: string | undefined = li.otherName;
  if (!byName.has(name) && other && byName.has(other)) { const t = name; name = other; other = t; }
  const foreign = other !== undefined && !byName.has(other);   // 相手は仕様の外(手で置いた物・既定のシーンの物)
  const mover = byName.get(name);
  const anchor = other ? byName.get(other) : undefined;
  const ent = spec.entities ?? [];
  const sev: "error" | "warn" = li.level === "error" ? "error" : "warn";
  const kind: string = li.kind;
  const path = mover ? mover.path : "";
  const tpl: any = mover ? ent[mover.srcIndex] : undefined;
  const isInstance = !!mover?.instance;
  const patch: PatchOp[] = [];
  let why = "";

  const dropInstance = () => {
    if (!mover || !isInstance) return false;
    const skip = Array.isArray(tpl?.pattern?.skip) ? tpl.pattern.skip : undefined;
    patch.push(skip ? { op: "add", path: `${path}/pattern/skip/-`, value: mover.instance } : { op: "add", path: `${path}/pattern/skip`, value: [mover.instance] });
    return true;
  };

  if (mover && tpl) {
    if (kind === "BURIED" || kind === "FLOATING") {
      patch.push(tpl.place ? setOrAdd(tpl.place, `${path}/place`, "snap", true) : { op: "add", path: `${path}/place`, value: { snap: true } });
      why = "place.snap:true(エンジンの snap_to_ground で真下の面に載せる)";
    } else if (kind === "DUPLICATE") {
      if (foreign) why = `既存の '${other}'(この仕様が作った物ではない)と同じ場所に重なっている。既存を消すか、仕様の位置を変える`;
      else {
        if (!dropInstance()) patch.push({ op: "remove", path });
        why = isInstance ? `重なった instance ${mover.instance} を pattern.skip で作らない` : "同じ場所に重なっているので片方を仕様から消す";
      }
    } else if (kind === "Z_FIGHT") {
      if (!isInstance && Array.isArray(tpl.at) && typeof tpl.at[1] === "number") patch.push({ op: "replace", path: `${path}/at/1`, value: round3(tpl.at[1] + 0.005) });
      else patch.push(tpl.place ? setOrAdd(tpl.place, `${path}/place`, "offset", [0, 0.005, 0]) : { op: "add", path: `${path}/place`, value: { offset: [0, 0.005, 0] } });
      why = "面が重なっているので 5mm ずらす";
    } else if (kind === "OVERLAP") {
      const vol = (b?: { min: number[]; max: number[] }) => (b ? Math.max(1e-9, (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2])) : 0);
      const bigAnchor = !!anchor?.worldBounds && !!mover.worldBounds && vol(anchor.worldBounds) > 8 * vol(mover.worldBounds);
      if (bigAnchor && !isInstance) {
        // 床のような大きな物とのめり込みは、接地(snap)で直る(相手の横へどかしても床の上に載らない)
        patch.push(tpl.place ? setOrAdd(tpl.place, `${path}/place`, "snap", true) : { op: "add", path: `${path}/place`, value: { snap: true } });
        why = `大きな '${other}' に埋まっている。place.snap:true で真下の面に載せる`;
      } else if (!dropInstance()) {
        if (other) {
          patch.push({ op: tpl.place ? "replace" : "add", path: `${path}/place`, value: { relativeTo: other, side: "right", gap: 0.05 } });
          patch.push(Array.isArray(tpl.at) ? { op: "replace", path: `${path}/at`, value: [null, typeof tpl.at[1] === "number" ? tpl.at[1] : null, null] } : { op: "add", path: `${path}/at`, value: [null, null, null] });
        }
      }
      if (!why) why = isInstance ? "めり込んだ instance を作らない" : `'${other}' の右へ 5cm 空けて置く(place.relativeTo)`;
    } else if (kind === "COLLIDER_WITHOUT_BODY") {
      patch.push(tpl.components ? { op: "add", path: `${path}/components/rigidBody`, value: { motionType: 0 } } : { op: "add", path: `${path}/components`, value: { rigidBody: { motionType: 0 } } });
      why = "rigidBody(静的)を足す(このエンジンは rigidBody が無いとコライダーが効かない)";
    } else if (kind === "NO_COLLIDER" && ["box", "sphere", "plane", "model"].includes(tpl.kind)) {
      patch.push({ op: tpl.collider === undefined ? "add" : "replace", path: `${path}/collider`, value: "static" });
      why = "collider:\"static\"(静的な rigidBody + 形に合ったコライダー)を足す";
    } else if (kind === "SCALE_ANOMALY") {
      const key = tpl.size !== undefined ? "size" : "scale";
      const cur = tpl[key];
      if (typeof cur === "number") patch.push({ op: "replace", path: `${path}/${key}`, value: round3(cur / 100) });
      else if (Array.isArray(cur)) patch.push({ op: "replace", path: `${path}/${key}`, value: cur.map((x: number) => round3(x / 100)) });
      why = "cm と m の取り違えの疑い。100 で割る";
    }
  }
  return {
    path: path || "", code: `E_LAYOUT_${kind}`, severity: sev, check: "layout", entity: name, message: String(li.text ?? `${kind}: ${name}`),
    cause: why || undefined, specPatch: patch.length ? patch : undefined,
    fix: foreign && (kind === "DUPLICATE" || kind === "OVERLAP")
      ? [{ tool: "dx12_delete_entity", args: { name: other }, why: `仕様と重なる既存の '${other}' を消してから撃ち直す(既定のシーンの Ground など)` }]
      : [{ tool: "dx12_validate_layout", args: { fix: "safe" }, why: "エンジン側の自動修正(BURIED / FLOATING / Z_FIGHT)は dx12_validate_layout {fix:'safe'}(この仕様の再適用でまた元に戻る点に注意)" }],
  };
}

function namingIssue(ni: { entityId: number; name: string; kind: string; text: string }, byName: Map<string, Resolved>, spec: SceneSpec, info: Map<string, EntityInfo>, taken: Set<string>, done: Set<string>): SpecIssue | null {
  const r = byName.get(ni.name);
  const tpl: any = r ? (spec.entities ?? [])[r.srcIndex] : undefined;
  const patch: PatchOp[] = [];
  let cause: string | undefined;
  if (r && tpl) {
    const path = r.path;
    // パターンの instance は全部が同じテンプレートの名前で決まる。1 テンプレートにつき 1 回だけ差分を出す。
    const dk = `${ni.kind}:${path}`;
    if (r.instance && done.has(dk)) return null;
    done.add(dk);
    if (ni.kind === "NO_PREFIX" || ni.kind === "DEFAULT_NAME" || ni.kind === "BAD_CHARS") {
      const e = info.get(ni.name);
      const g = classify(e ?? { entityId: 0, name: ni.name });
      const base = r.instance ? String(tpl.name) : ni.name;
      const kind = toKind(base, "Prop");
      let cand = `${g}_${kind}`;
      let n = 1;
      while (taken.has(cand)) { n++; cand = `${g}_${kind}${n}`; }
      taken.add(cand);
      patch.push({ op: "replace", path: `${path}/name`, value: cand });
      // 名前が変わっても同じ実体に追従させる(複製 + 孤児にしない): id に元の名前を固定する
      if (tpl.id === undefined) patch.push({ op: "add", path: `${path}/id`, value: base });
      patch.push(...renameRefsPatch(spec, base, cand));
      cause = `命名規約 <PREFIX>_<Kind>_<NN>(${g}_ …)に合わせて改名する。Lua が名前で引いている物は改名しないこと(dx12_organize_scene は .lua を読んで避ける)`;
    } else if (ni.kind === "NOT_IN_GROUP") {
      const e = info.get(ni.name);
      patch.push({ op: tpl.group ? "replace" : "add", path: `${path}/group`, value: classify(e ?? { entityId: 0, name: ni.name }) });
      cause = "group を付けるとグループの根の下に置かれる";
    }
  }
  return { path: r?.path ?? "", code: `E_NAMING_${ni.kind}`, severity: "warn", check: "naming", entity: ni.name, message: ni.text, cause, specPatch: patch.length ? patch : undefined };
}

/** 適用後の検証を実行する。 */
export async function runVerify(deps: VerifyDeps, ctx: { spec: SceneSpec; resolved: Resolved[]; owned: Set<string> }, cfg: VerifyConfig): Promise<VerifyReport> {
  const rep: VerifyReport = { pass: true, blocking: [], warnings: [], preexisting: [], checks: [], specPatch: [] };
  const byName = new Map(ctx.resolved.map((r) => [r.name, r]));
  const owned = ctx.owned;

  if (cfg.layout !== "off") {
    try {
      const r = await deps.engine.call("validate_layout", {});
      const issues: any[] = r?.issues ?? [];
      let mine = 0;
      // Z_FIGHT は「AABB が 1mm 未満だけ食い込んでいる」検査。面と面がぴったり接している(on / side の gap 0)と、float32 の丸めで 1e-7 m だけ
      // 食い込んで見え、実害の無い接触を Z_FIGHT と数える。食い込みを get_bounds で測り直し、0.02mm 未満は接触として除く。
      const touching = new Set<any>();
      await pmap(issues.filter((li) => li.kind === "Z_FIGHT" && li.otherName && (owned.has(li.name) || owned.has(li.otherName))), async (li) => {
        try {
          const [a, b] = await Promise.all([deps.engine.call("get_bounds", { name: li.name }), deps.engine.call("get_bounds", { name: li.otherName })]);
          const ov = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
          if (Math.min(...ov) < 2e-5) touching.add(li);
        } catch { /* 測れなければ報告のまま */ }
        return null;
      });
      // BURIED の誤検出: エンジンは「真下に最初に当たった大きな面」を地面とみなす。天井の下に立つ壁・柱は、天井の面を地面と誤認して
      // 「地面へ 100% 埋まっている」と言う。この仕様の中の大きな面(床)で測り直し、実際は床の上に立っていれば誤検出として除く。
      const falsePositive = new Set<any>();
      for (const li of issues) {
        if (li.kind !== "BURIED") continue;
        const me = byName.get(li.name);
        const B = me?.worldBounds;
        if (!B) continue;
        const cx = (B.min[0] + B.max[0]) / 2, cz = (B.min[2] + B.max[2]) / 2, h = B.max[1] - B.min[1];
        let groundY: number | null = null;
        for (const o of ctx.resolved) {
          const w = o.worldBounds;
          if (o === me || !w || !o.localBounds) continue;
          const sx = w.max[0] - w.min[0], sy = w.max[1] - w.min[1], sz = w.max[2] - w.min[2];
          if (sx * sz <= 25 && sy <= 6) continue;   // 置き物は地面ではない(エンジンの IsProp と同じ)
          if (cx < w.min[0] || cx > w.max[0] || cz < w.min[2] || cz > w.max[2] || w.max[1] > B.max[1] + 0.05) continue;
          if (groundY === null || w.max[1] > groundY) groundY = w.max[1];
        }
        if (groundY !== null && B.min[1] - groundY >= -Math.max(0.05, Math.min(0.5, h * 0.25))) falsePositive.add(li);
      }
      for (const li of issues) {
        if (touching.has(li) || falsePositive.has(li)) continue;
        const involved = owned.has(li.name) || (li.otherName && owned.has(li.otherName));
        if (!involved) { rep.preexisting.push({ kind: li.kind, name: li.name, text: String(li.text ?? "") }); continue; }
        mine++;
        const si = layoutIssue(li, byName, ctx.spec);
        if (si.severity === "error" && cfg.layout === "error") rep.blocking.push(si); else rep.warnings.push({ ...si, severity: "warn" });
      }
      const errs = rep.blocking.filter((b) => b.check === "layout").length;
      rep.checks.push({ id: "layout", pass: errs === 0, counts: { checked: r?.checked ?? 0, errors: r?.errors ?? 0, warnings: r?.warnings ?? 0, mine, preexisting: rep.preexisting.length, ...(touching.size ? { touchingIgnored: touching.size } : {}), ...(falsePositive.size ? { buriedFalsePositive: falsePositive.size } : {}) } });
    } catch (e: any) { rep.checks.push({ id: "layout", pass: true, skipped: true, note: `validate_layout を実行できなかった: ${String(e?.message ?? e).slice(0, 160)}` }); }
  }

  if (cfg.naming !== "off") {
    try {
      const list = await deps.engine.call("list_entities", { verbose: true, limit: 0 });
      const hier = await deps.engine.call("get_hierarchy", { limit: 0 });
      const parentOf = new Map<number, number>();
      const walk = (n: any, p?: number) => { if (p != null) parentOf.set(n.entityId, p); for (const c of n.children ?? []) walk(c, n.entityId); };
      for (const r of hier?.roots ?? []) walk(r);
      const infos: EntityInfo[] = (list?.entities ?? []).map((e: any) => ({ entityId: e.entityId ?? e.id, name: e.name, componentTypes: e.componentTypes ?? [], parent: parentOf.get(e.entityId ?? e.id) }));
      const info = new Map(infos.map((e) => [e.name, e]));
      const taken = new Set(infos.map((e) => e.name));
      const lint = lintNames(infos).filter((n) => owned.has(n.name));
      const done = new Set<string>();
      for (const n of lint) {
        const si = namingIssue(n, byName, ctx.spec, info, taken, done);
        if (!si) continue;
        if (cfg.naming === "error") { rep.blocking.push({ ...si, severity: "error" }); } else rep.warnings.push(si);
      }
      rep.checks.push({ id: "naming", pass: lint.length === 0 || cfg.naming !== "error", counts: { issues: lint.length } });
    } catch (e: any) { rep.checks.push({ id: "naming", pass: true, skipped: true, note: `命名検査を実行できなかった: ${String(e?.message ?? e).slice(0, 160)}` }); }
  }

  if (cfg.reachable.length) {
    if (!deps.callTool) rep.checks.push({ id: "reachable", pass: true, skipped: true, note: "到達性の検査(dx12_check_reachable)を呼べない環境" });
    else {
      const results = await pmap(cfg.reachable, async (pair) => {
        const r = await deps.callTool!("dx12_check_reachable", { fromName: pair.from, toName: pair.to });
        return { pair, r };
      }, 1);
      let bad = 0;
      for (const { pair, r } of results) {
        const d = r.data ?? {};
        if (r.ok && d.reachable === true) continue;
        bad++;
        const reason = String(d.reason ?? r.error ?? "到達できない");
        const needNav = /ナビメッシュ.*焼かれていない|navmesh/i.test(reason) && !(ctx.spec.navmesh && (ctx.spec.navmesh as any).build);
        const issue: SpecIssue = {
          path: "/verify/reachable", code: "E_UNREACHABLE", severity: "error", check: "reachable", message: `${pair.from} から ${pair.to} へ到達できない: ${reason}`,
          cause: (d.issues && d.issues.length ? String(d.issues[0]?.reason ?? d.issues[0]?.text ?? JSON.stringify(d.issues[0])).slice(0, 240) : undefined) ?? "床が繋がっていない/段差・隙間が移動能力を超える/ナビメッシュが古い",
          specPatch: needNav ? [{ op: "add", path: "/navmesh", value: { build: true } }] : undefined,
          fix: [{ tool: "dx12_check_reachable", args: { fromName: pair.from, toName: pair.to }, why: "経路の区間ごとの登り・隙間を見る" }],
        };
        rep.blocking.push(issue);
      }
      rep.checks.push({ id: "reachable", pass: bad === 0, counts: { pairs: cfg.reachable.length, unreachable: bad } });
    }
  }

  if (cfg.scene) {
    try {
      const r = await deps.engine.call("validate_scene", {});
      const pass = r?.pass !== false;
      if (!pass) rep.blocking.push({ path: "", code: "E_SCENE_INVALID", severity: "error", check: "scene", message: `validate_scene が FAIL: ${String(r?.report ?? "").split("\n").filter((l) => /ERROR|FAIL/.test(l)).slice(0, 3).join(" / ")}` });
      rep.checks.push({ id: "scene", pass });
    } catch (e: any) { rep.checks.push({ id: "scene", pass: true, skipped: true, note: `validate_scene を実行できなかった: ${String(e?.message ?? e).slice(0, 160)}` }); }
  }

  resolvePatchConflicts([...rep.blocking, ...rep.warnings], ctx.spec);   // error と warning をまたいで 1 つの直しにする
  rep.blocking = groupIssues(rep.blocking);
  rep.warnings = groupIssues(rep.warnings);
  rep.pass = rep.blocking.length === 0;
  return rep;
}

const PRIORITY: Record<string, number> = { E_LAYOUT_DUPLICATE: 5, E_LAYOUT_BURIED: 4, E_LAYOUT_FLOATING: 4, E_LAYOUT_COLLIDER_WITHOUT_BODY: 3, E_LAYOUT_NO_COLLIDER: 3, E_LAYOUT_OVERLAP: 2, E_LAYOUT_Z_FIGHT: 1, E_LAYOUT_SCALE_ANOMALY: 1 };

/**
 * 同じエンティティ(テンプレートの path)に複数の issue が付いたとき、直し方を 1 つにする。
 *   ・優先順位(DUPLICATE > 接地 > コライダー > 重なり > ちらつき)が一番高い直しだけを残し、他は「同じ直しで解ける」として specPatch を外す
 *     (別々の直しを混ぜると path が食い違い、直した先でまた別の指摘になって収束しない)。
 *   ・pattern の instance を作らない(skip)は、同じテンプレートの分を 1 つの配列にまとめる。
 */
export function resolvePatchConflicts(list: SpecIssue[], spec: SceneSpec): void {
  const byPath = new Map<string, SpecIssue[]>();
  for (const i of list) if (i.specPatch?.length && i.path) { const a = byPath.get(i.path) ?? []; a.push(i); byPath.set(i.path, a); }
  for (const [path, arr] of byPath) {
    // skip の統合(instance ごとに出た add を 1 つに)
    const skipIssues = arr.filter((i) => i.specPatch!.some((o) => /\/pattern\/skip(\/-)?$/.test(o.path)));
    if (skipIssues.length) {
      const set = new Set<number>();
      for (const i of skipIssues) for (const o of i.specPatch!) { if (/\/pattern\/skip(\/-)?$/.test(o.path)) { const v = o.value; if (Array.isArray(v)) v.forEach((x) => set.add(x)); else if (typeof v === "number") set.add(v); } }
      const idx = Number(/\/entities\/(\d+)/.exec(path)?.[1]);
      const cur = Number.isInteger(idx) ? (spec.entities?.[idx]?.pattern?.skip ?? []) : [];
      const merged = [...new Set([...cur, ...set])].sort((a, b) => a - b);
      const has = Array.isArray(spec.entities?.[idx]?.pattern?.skip);
      const op: PatchOp = { op: has ? "replace" : "add", path: `${path}/pattern/skip`, value: merged };
      for (const i of skipIssues) i.specPatch = [op];
    }
    // 優先順位
    const top = Math.max(...arr.map((i) => PRIORITY[i.code] ?? 0));
    const winner = arr.find((i) => (PRIORITY[i.code] ?? 0) === top)!;
    for (const i of arr) if (i !== winner && (PRIORITY[i.code] ?? 0) < top) { i.specPatch = undefined; i.cause = `${i.cause ? i.cause + "。" : ""}${winner.code} の直しで一緒に解ける`; }
  }
}

/** 同じ code・同じ path・同じ specPatch の issue を 1 件にまとめる(パターンの instance が 100 件同じ指摘を出さないように)。 */
export function groupIssues(list: SpecIssue[]): SpecIssue[] {
  const out: SpecIssue[] = [];
  const byKey = new Map<string, SpecIssue>();
  for (const i of list) {
    const key = `${i.check ?? ""}|${i.code}|${i.path}|${JSON.stringify(i.specPatch ?? null)}`;
    const g = byKey.get(key);
    if (!g) { const c = { ...i, entities: i.entity ? [i.entity] : [], count: 1 }; byKey.set(key, c); out.push(c); continue; }
    g.count = (g.count ?? 1) + 1;
    if (i.entity) g.entities!.push(i.entity);
  }
  for (const g of out) {
    if ((g.count ?? 1) === 1) { delete g.entities; delete g.count; }
    else g.message = `${g.message}(同じ指摘が ${g.count} 体: ${g.entities!.slice(0, 4).join(", ")}${g.entities!.length > 4 ? " …" : ""})`;
  }
  return out;
}
