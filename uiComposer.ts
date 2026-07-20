// Constraint-based retained-UI composer used by dx12_ui_compose.
// It intentionally exposes roles/layout intent instead of raw offsets for every element.

export type EngineLike = { call(method: string, params: any): Promise<any> };

const THEMES: Record<string, any> = {
  cinematic: { bg:[.025,.024,.022,1], panel:[.08,.075,.068,.94], panel2:[.14,.13,.115,.96], text:[.94,.92,.86,1], muted:[.66,.63,.57,1], accent:[.78,.55,.25,1], radius:2, outline:0 },
  tactical:  { bg:[.018,.027,.032,1], panel:[.045,.065,.072,.95], panel2:[.075,.105,.112,.97], text:[.88,.94,.93,1], muted:[.54,.65,.64,1], accent:[.34,.78,.68,1], radius:1, outline:1 },
  fantasy:   { bg:[.035,.026,.022,1], panel:[.105,.075,.052,.96], panel2:[.16,.115,.07,.97], text:[.96,.89,.72,1], muted:[.69,.61,.48,1], accent:[.76,.55,.24,1], radius:3, outline:1.2 },
  horror:    { bg:[.018,.017,.016,1], panel:[.055,.052,.048,.96], panel2:[.095,.085,.075,.97], text:[.78,.76,.71,1], muted:[.44,.43,.40,1], accent:[.55,.12,.10,1], radius:0, outline:.6 },
  arcade:    { bg:[.035,.025,.065,1], panel:[.11,.075,.19,.96], panel2:[.18,.10,.30,.97], text:[1,.98,.92,1], muted:[.72,.68,.82,1], accent:[1,.48,.16,1], radius:12, outline:2 },
  cozy:      { bg:[.13,.105,.08,1], panel:[.24,.20,.15,.97], panel2:[.32,.26,.19,.98], text:[.98,.91,.77,1], muted:[.74,.67,.55,1], accent:[.84,.48,.25,1], radius:14, outline:0 },
};

function box4(v: any, fallback = 0): number[] {
  if (typeof v === "number") return [v,v,v,v];
  if (Array.isArray(v) && v.length === 4) return v.map(Number);
  return [fallback,fallback,fallback,fallback];
}

function rectFor(layout: any = {}) {
  if (Array.isArray(layout.anchorMin) && Array.isArray(layout.anchorMax)) return {
    anchorMin: layout.anchorMin, anchorMax: layout.anchorMax,
    offsetMin: layout.offsetMin ?? [0,0], offsetMax: layout.offsetMax ?? [0,0], visible: layout.visible ?? true,
  };
  const dock = layout.dock ?? "fill";
  const m = box4(layout.margin, 0); const w = Number(layout.width ?? 480); const h = Number(layout.height ?? 160);
  if (dock === "top") return { anchorMin:[0,0], anchorMax:[1,0], offsetMin:[m[0],m[1]], offsetMax:[-m[2],m[1]+h], visible:layout.visible??true };
  if (dock === "bottom") return { anchorMin:[0,1], anchorMax:[1,1], offsetMin:[m[0],-m[3]-h], offsetMax:[-m[2],-m[3]], visible:layout.visible??true };
  if (dock === "left") return { anchorMin:[0,0], anchorMax:[0,1], offsetMin:[m[0],m[1]], offsetMax:[m[0]+w,-m[3]], visible:layout.visible??true };
  if (dock === "right") return { anchorMin:[1,0], anchorMax:[1,1], offsetMin:[-m[2]-w,m[1]], offsetMax:[-m[2],-m[3]], visible:layout.visible??true };
  if (dock === "center") return { anchorMin:[.5,.5], anchorMax:[.5,.5], offsetMin:[-w/2,-h/2], offsetMax:[w/2,h/2], visible:layout.visible??true };
  if (dock === "point") {
    const a = layout.anchor ?? [.5,.5], x = Number(layout.x ?? 0), y = Number(layout.y ?? 0);
    return { anchorMin:a, anchorMax:a, offsetMin:[x-w/2,y-h/2], offsetMax:[x+w/2,y+h/2], visible:layout.visible??true };
  }
  return { anchorMin:[0,0], anchorMax:[1,1], offsetMin:[m[0],m[1]], offsetMax:[-m[2],-m[3]], visible:layout.visible??true };
}

function imageStyle(role: string, t: any, overrides: any = {}) {
  const transparent = role === "group" || role === "stack" || role === "grid";
  const base: any = transparent
    ? { color:[0,0,0,0], raycastBlock:false }
    : role === "root" ? { color:t.bg, raycastBlock:false }
    : { color:role === "button" ? t.panel2 : t.panel, cornerRadius:t.radius, raycastBlock:role === "button", shadowColor:[0,0,0,.28], shadowOffset:[0,4], shadowSoftness:8 };
  if (t.outline > 0 && role !== "root" && !transparent) Object.assign(base, { outlineWidth:t.outline, outlineColor:[t.accent[0],t.accent[1],t.accent[2],.32] });
  if (role === "cta") Object.assign(base, { color:t.accent, cornerRadius:t.radius, raycastBlock:true, shadowColor:[0,0,0,.38], shadowOffset:[0,5], shadowSoftness:10 });
  return { ...base, ...overrides };
}

function textStyle(role: string, t: any, overrides: any = {}) {
  const sizes: Record<string, number> = { display:72, heading:38, subheading:28, body:24, caption:18, button:24 };
  return { text:"", fontSize:sizes[role] ?? 24, color:role === "caption" ? t.muted : t.text,
    alignH:role === "display" ? 0 : 0, alignV:1, wrap:role === "body", ...overrides };
}

function validateBlueprint(bp: any) {
  if (!bp || typeof bp !== "object") throw new Error("blueprint はオブジェクト必須");
  if (!bp.root || typeof bp.root !== "object") throw new Error("blueprint.root が必要");
  let count = 0;
  const names = new Set<string>();
  const visit = (n: any, depth: number) => {
    if (++count > 160) throw new Error("UIノードは160個まで");
    if (depth > 10) throw new Error("UI階層は10段まで");
    if (!n.name || typeof n.name !== "string") throw new Error("全ノードに一意な name が必要");
    if (names.has(n.name)) throw new Error(`blueprint内でnameが重複: ${n.name}`);
    names.add(n.name);
    for (const c of n.children ?? []) visit(c, depth + 1);
  };
  visit(bp.root, 0);
  return count;
}

export async function composeUi(engine: EngineLike, blueprint: any) {
  const planned = validateBlueprint(blueprint);
  const t = THEMES[blueprint.theme] ?? THEMES.cinematic;
  const prefix = String(blueprint.prefix ?? "Screen").replace(/[^A-Za-z0-9_\-]/g, "_");
  const canvasName = `${prefix}_Canvas`;
  const created: number[] = [];
  let canvasId: number | null = null;
  try {
    const canvas = await engine.call("create_entity", { type:"ui_canvas", name:canvasName });
    canvasId = canvas.entityId; created.push(canvas.entityId);
    await engine.call("set_component", { entity:canvasId, component:"uiCanvas", data:{ refWidth:1920, refHeight:1080, scaleMode:0, sortOrder:Number(blueprint.sortOrder ?? 0), visible:true } });

    const build = async (node: any, parent: number, depth: number): Promise<number> => {
      const kind = node.kind ?? "panel";
      const name = `${prefix}_${node.name}`;
      const type = kind === "text" ? "ui_text" : kind === "button" ? "ui_button" : "ui_image";
      const r = await engine.call("create_entity", { type, name, parent });
      const id = r.entityId; created.push(...(r.entityIds ?? [id]).filter((v: number) => !created.includes(v)));
      await engine.call("set_component", { entity:id, component:"uiRect", data:{ ...rectFor(node.layout), order:Number(node.order ?? depth) } });

      if (kind === "text") {
        await engine.call("set_component", { entity:id, component:"uiText", data:textStyle(node.role ?? "body", t, { text:String(node.text ?? ""), ...(node.style ?? {}) }) });
      } else {
        const role = kind === "button" ? (node.role === "cta" ? "cta" : "button") : (node.role ?? (kind === "stack" || kind === "grid" ? kind : "panel"));
        await engine.call("set_component", { entity:id, component:"uiImage", data:imageStyle(role, t, node.style ?? {}) });
        if (kind === "button") {
          await engine.call("set_component", { entity:id, component:"uiButton", data:{ onClickEvent:String(node.event ?? ""), normalColor:[1,1,1,1], hoverColor:[1.12,1.12,1.12,1], pressedColor:[.88,.88,.88,1], interactable:true } });
          await engine.call("set_component", { entity:id, component:"uiAnimator", data:{ showAnim:1, showDuration:.22, showDelay:Math.min(depth*.035,.28), showEasing:2, hoverScale:1.025, pressScale:.975, hoverSpeed:16, loopAnim:0 } });
          const labelId = (r.entityIds ?? []).find((v: number) => v !== id);
          if (labelId != null) await engine.call("set_component", { entity:labelId, component:"uiText", data:textStyle("button", t, { text:String(node.text ?? node.name), alignH:1, ...(node.textStyle ?? {}) }) });
        }
        if (kind === "stack" || kind === "grid") {
          const flow = node.flow ?? {};
          await engine.call("set_component", { entity:id, component:"uiLayout", data:{
            mode:kind === "grid" ? 2 : (flow.direction === "horizontal" ? 1 : 0),
            cellW:Number(flow.cellWidth ?? (kind === "grid" ? 280 : 0)), cellH:Number(flow.cellHeight ?? 64),
            spacing:Number(flow.spacing ?? 16), padding:box4(flow.padding, 0), gridCols:Number(flow.columns ?? 3),
          } });
        }
      }
      for (const child of node.children ?? []) await build(child, id, depth + 1);
      return id;
    };
    const rootId = await build(blueprint.root, canvasId, 1);
    return { canvasId, rootId, entityIds:created, count:created.length, plannedNodes:planned, theme:blueprint.theme ?? "cinematic", prefix,
      next: ["dx12_ui_audit(strictness:'strict')", "dx12_ui_screenshot", "dx12_save_scene"] };
  } catch (e) {
    // Deleting the canvas removes the complete subtree and avoids half-built UI after a failed compose.
    if (canvasId != null) { try { await engine.call("delete_entity", { entity:canvasId }); } catch {} }
    throw e;
  }
}

export const BLUEPRINT_EXAMPLE = {
  theme:"cinematic", prefix:"Title", root:{ name:"Root", kind:"panel", role:"root", layout:{dock:"fill"}, children:[
    { name:"Header", kind:"text", role:"display", text:"GAME TITLE", layout:{dock:"top", height:120, margin:[64,72,64,0]} },
    { name:"Menu", kind:"stack", layout:{dock:"bottom", width:420, height:240, margin:[64,0,0,72]}, flow:{cellHeight:56, spacing:12}, children:[
      { name:"Start", kind:"button", role:"cta", text:"START", event:"ev_start" },
      { name:"Options", kind:"button", text:"OPTIONS", event:"ev_options" }
    ]}
  ]}
};
