import assert from "node:assert/strict";
import { auditUiTree, designBrief } from "./uiQuality.ts";

const node = (name: string, rect: number[], extra: any = {}) => ({
  entityId: Math.floor(Math.random() * 100000), name, resolvedRect: rect,
  uiRect: { visible:true, anchorMin:[0,0], anchorMax:[0,0] }, components:[], ...extra,
});

const good = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:[
  node("Start", [100,850,320,64], { components:["uiImage","uiButton"], uiImage:{color:[.1,.1,.1,1],raycastBlock:true,gradientDir:0,outlineWidth:0,shadowAlpha:0,shape:0}, uiButton:{interactable:true,onClickEvent:"start"} }),
  node("Title", [100,100,900,100], { components:["uiText"], text:"TITLE", uiText:{fontSize:64,wrap:false,rich:false,charAnim:0,outlineWidth:0,shadowAlpha:0} }),
] }] };
const a = auditUiTree(good, "strict");
assert.equal(a.summary.errors, 0);
assert.ok(a.score >= 90);

const bad = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:[
  node("Blocker", [0,0,1920,1080], { components:["uiImage"], uiImage:{color:[0,0,0,1],raycastBlock:true,gradientDir:1,outlineWidth:2,shadowAlpha:.5,shape:3,gradientScrollSpeed:.8} }),
  node("A", [100,100,40,30], { components:["uiButton"], uiButton:{interactable:true,onClickEvent:""} }),
  node("B", [105,105,40,30], { components:["uiButton"], uiButton:{interactable:true,onClickEvent:"b"} }),
  node("Copy", [0,0,100,12], { components:["uiText"], text:"this is far too long", uiText:{fontSize:24,wrap:false,rich:true,charAnim:1,outlineWidth:1,shadowAlpha:.5} }),
] }] };
const b = auditUiTree(bad, "strict");
assert.equal(b.pass, false);
for (const code of ["INPUT_BLOCKER","SMALL_HIT_TARGET","INTERACTIVE_OVERLAP","TEXT_CLIPPED_HEIGHT","OVER_DECORATED"])
  assert.ok(b.issues.some((i:any) => i.code === code), `missing ${code}`);

// ── 計測lint: SIBLING_MISALIGNMENT / OFF_GRID_SPACING ──────────
// 正例: 左端2pxズレ + 垂直gap13px(4の倍数でない)。負例: 完全整列 + gap16px。
const btn = (name: string, x: number, y: number) =>
  node(name, [x, y, 200, 50], { components:["uiButton"], uiButton:{interactable:true,onClickEvent:"go"} });
const sloppy = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:[
  btn("Row1", 100, 100), btn("Row2", 102, 163),  // x: 2pxズレ, gap: 163-150=13px
] }] };
const s1 = auditUiTree(sloppy);
assert.ok(s1.issues.some((i:any) => i.code === "SIBLING_MISALIGNMENT"), "missing SIBLING_MISALIGNMENT");
assert.ok(s1.issues.some((i:any) => i.code === "OFF_GRID_SPACING"), "missing OFF_GRID_SPACING");
assert.ok(s1.metrics.gapValues.includes(13), "gapValues should contain 13");
const tidy = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:[
  btn("Row1", 100, 100), btn("Row2", 100, 166),  // x: 0pxズレ, gap: 16px
  btn("Row3", 110, 232),                          // x: 10pxズレ=意図的(4px以上)、gap: 16px
] }] };
const s2 = auditUiTree(tidy);
assert.ok(!s2.issues.some((i:any) => i.code === "SIBLING_MISALIGNMENT"), "false positive SIBLING_MISALIGNMENT");
assert.ok(!s2.issues.some((i:any) => i.code === "OFF_GRID_SPACING"), "false positive OFF_GRID_SPACING");

// ── 計測lint: FONT_SIZE_SPRAWL ─────────────────────────────────
const text = (name: string, y: number, fs: number) =>
  node(name, [100, y, 600, Math.ceil(fs * 1.5)], { components:["uiText"], text:"t", uiText:{fontSize:fs,wrap:false,rich:false,charAnim:0,outlineWidth:0,shadowAlpha:0} });
const manyFonts = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:
  [18,20,24,28,32,40].map((fs, i) => text(`T${i}`, 100 + i * 100, fs)) }] };
const f1 = auditUiTree(manyFonts);
assert.ok(f1.issues.some((i:any) => i.code === "FONT_SIZE_SPRAWL"), "missing FONT_SIZE_SPRAWL");
assert.equal(f1.metrics.fontSizes.length, 6);
const fewFonts = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:
  [24,24,32,48].map((fs, i) => text(`T${i}`, 100 + i * 100, fs)) }] };
const f2 = auditUiTree(fewFonts);
assert.ok(!f2.issues.some((i:any) => i.code === "FONT_SIZE_SPRAWL"), "false positive FONT_SIZE_SPRAWL");
assert.deepEqual(f2.metrics.fontSizes, [{size:48,count:1},{size:32,count:1},{size:24,count:2}]);

// ── 計測lint: metrics.colorGroups ──────────────────────────────
// 近似色 [.1,.1,.1] と [.11,.1,.1] は同グループ、[.9,.2,.2] は別グループ。
const img = (name: string, y: number, color: number[]) =>
  node(name, [100, y, 100, 100], { components:["uiImage"], uiImage:{color,raycastBlock:false,gradientDir:0,outlineWidth:0,shadowAlpha:0,shape:0} });
const colored = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:[
  img("Dark1", 100, [.1,.1,.1,1]), img("Dark2", 300, [.11,.1,.1,1]), img("Red", 500, [.9,.2,.2,1]),
] }] };
const c1 = auditUiTree(colored);
assert.equal(c1.metrics.colorGroups.length, 2);
const darkGroup = c1.metrics.colorGroups.find((g:any) => g.count === 2);
assert.ok(darkGroup && darkGroup.examples.includes("Dark1"), "colorGroups should group similar colors with examples");

// ── 計測lint: CENTERED_MONOTONY ────────────────────────────────
// 正例: 操作/テキスト6個すべて水平中央(中心960)。負例: 左寄せ。
const centered = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:
  [0,1,2,3,4,5].map(i => btn(`C${i}`, 860, 100 + i * 100)) }] };  // 860+200/2=960=中心
const m1 = auditUiTree(centered);
assert.ok(m1.issues.some((i:any) => i.code === "CENTERED_MONOTONY"), "missing CENTERED_MONOTONY");
assert.equal(m1.metrics.centeredRatio, 1);
const leftAligned = { canvases:[{ name:"Canvas", uiCanvas:{refWidth:1920,refHeight:1080}, children:
  [0,1,2,3,4,5].map(i => btn(`L${i}`, 100, 100 + i * 100)) }] };
const m2 = auditUiTree(leftAligned);
assert.ok(!m2.issues.some((i:any) => i.code === "CENTERED_MONOTONY"), "false positive CENTERED_MONOTONY");
assert.equal(m2.metrics.centeredRatio, 0);

// metrics は issue が無くても常に返る。
assert.ok(a.metrics && Array.isArray(a.metrics.fontSizes) && Array.isArray(a.metrics.colorGroups)
  && typeof a.metrics.centeredRatio === "number" && Array.isArray(a.metrics.gapValues));

const brief = designBrief("horror", "title");
assert.match(brief.direction.composition, /余白/);
assert.ok(brief.avoid.length >= 5);
console.log("OK: UI品質監査テスト通過");
