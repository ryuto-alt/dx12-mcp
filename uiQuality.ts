// Pure UI quality helpers. Kept independent from MCP/EngineClient so the rules are unit-testable.

export type UiIssue = {
  severity: "error" | "warning" | "suggestion";
  code: string;
  entityId?: number;
  name?: string;
  message: string;
  fix: string;
};

type FlatNode = { node: any; parent: any | null; canvas: any; depth: number };

function flatten(tree: any): FlatNode[] {
  const out: FlatNode[] = [];
  for (const canvas of tree?.canvases ?? []) {
    const visit = (node: any, parent: any | null, depth: number) => {
      out.push({ node, parent, canvas, depth });
      for (const child of node?.children ?? []) visit(child, node, depth + 1);
    };
    visit(canvas, null, 0);
  }
  return out;
}

function overlapRatio(a: number[], b: number[]): number {
  const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const intersection = x * y;
  return intersection / Math.max(1, Math.min(a[2] * a[3], b[2] * b[3]));
}

function luminance(c: number[]): number {
  const lin = (v: number) => v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4);
  return .2126 * lin(c[0] ?? 1) + .7152 * lin(c[1] ?? 1) + .0722 * lin(c[2] ?? 1);
}

// インタラクティブ要素か(ボタン/スライダー/トグル)。
function isInteractive(n: any): boolean {
  return (n?.components?.includes("uiButton") && n?.uiButton?.interactable !== false)
    || n?.components?.includes("uiSlider") || n?.components?.includes("uiToggle");
}

// 監査対象になる表示中の矩形持ちノードか。
function hasVisibleRect(n: any): boolean {
  return Array.isArray(n?.resolvedRect) && n?.uiRect?.visible !== false;
}

// 使用色を近似グループ化した測定値。issue ではなく常に metrics として返す。
export type ColorGroup = { color: number[]; count: number; examples: string[] };

export function auditUiTree(tree: any, strictness: "balanced" | "strict" = "balanced") {
  const all = flatten(tree);
  const issues: UiIssue[] = [];
  const add = (f: FlatNode, severity: UiIssue["severity"], code: string, message: string, fix: string) =>
    issues.push({ severity, code, entityId: f.node?.entityId, name: f.node?.name, message, fix });

  for (const f of all) {
    const n = f.node;
    const r = n?.resolvedRect;
    const cv = f.canvas?.uiCanvas ?? { refWidth: 1920, refHeight: 1080 };
    if (f.depth > 9) add(f, "warning", "DEEP_HIERARCHY", `UI階層が ${f.depth} 段あります。`, "装飾を親パネルへ統合し、8段以内を目安に整理する。 ");
    if (!Array.isArray(r)) continue;
    const [x, y, w, h] = r;
    if (w <= 0 || h <= 0) add(f, "error", "COLLAPSED_RECT", `解決後サイズが ${w.toFixed(1)}×${h.toFixed(1)}px です。`, "anchor と offset の組合せを直し、正の幅・高さを確保する。");
    if (n?.uiRect?.visible !== false && (x < -1 || y < -1 || x + w > cv.refWidth + 1 || y + h > cv.refHeight + 1))
      add(f, "warning", "OUT_OF_CANVAS", `キャンバス外へはみ出しています (${x.toFixed(0)}, ${y.toFixed(0)}, ${w.toFixed(0)}, ${h.toFixed(0)})。`, "safe area 内へ収めるか、意図した装飾なら clipChildren を使う。");

    const interactive = (n?.components?.includes("uiButton") && n?.uiButton?.interactable !== false)
      || n?.components?.includes("uiSlider") || n?.components?.includes("uiToggle");
    if (interactive) {
      if (w < 72 || h < 44) add(f, "error", "SMALL_HIT_TARGET", `操作領域 ${w.toFixed(0)}×${h.toFixed(0)}px は小さすぎます。`, "ゲームパッド/マウス共用なら最低72×44px、主要CTAは96×52px以上にする。");
      if (!n?.uiButton?.onClickEvent && n?.components?.includes("uiButton")) add(f, "warning", "BUTTON_NO_EVENT", "ボタンにクリックイベントがありません。", "uiButton.onClickEvent を設定する。");
    }

    if (n?.uiText) {
      const fs = Number(n.uiText.fontSize ?? 24);
      if (fs < (strictness === "strict" ? 20 : 18)) add(f, "warning", "SMALL_TEXT", `文字サイズ ${fs}px はゲーム画面で読みにくい可能性があります。`, "補助文でも18–20px以上、本文24px前後を基準にする。");
      if (h < fs * 1.15) add(f, "error", "TEXT_CLIPPED_HEIGHT", `高さ ${h.toFixed(0)}px に対して fontSize ${fs}px で、上下が切れる可能性があります。`, "テキスト矩形を fontSize の1.25倍以上にする。");
      const plain = String(n.text ?? "").replace(/\[[^\]]+\]/g, "");
      if (!n.uiText.wrap && plain.length > 0 && w < plain.length * fs * .43)
        add(f, "warning", "TEXT_OVERFLOW_RISK", "文字列に対して横幅が不足する可能性があります。", "横幅を広げる、文言を短くする、または wrap=true にする。");
      if (n.uiText.rich && n.uiText.wrap) add(f, "error", "RICH_WRAP_CONFLICT", "rich と wrap はエンジン仕様上併用できません。", "リッチ装飾を外すか、手動改行で wrap=false にする。");
      if (n.uiText.charAnim && (n.uiText.outlineWidth > 0 || n.uiText.shadowAlpha > 0))
        add(f, "suggestion", "EFFECT_STACKING", "文字アニメ・縁取り・影が重なり、生成AI的な過装飾に見えやすい状態です。", "強調手法を1つ、可読性補助を1つまでに絞る。");
    }

    if (n?.uiImage) {
      const effects = Number(n.uiImage.gradientDir !== 0) + Number(n.uiImage.outlineWidth > 0) + Number(n.uiImage.shadowAlpha > 0) + Number(n.uiImage.shape !== 0);
      if (effects >= 4) add(f, "suggestion", "OVER_DECORATED", "グラデーション・枠・影・特殊形状を同時使用しています。", "主役以外は装飾を1–2種類に抑え、余白と階層で差をつける。");
      if (n.uiImage.gradientScrollSpeed > .45) add(f, "warning", "BUSY_GLOSS", "光沢アニメーションが速く、視線を奪います。", "CTA 1個だけに使い、0.15–0.35周/秒へ落とす。");
      if (n.uiImage.raycastBlock && !n.components?.includes("uiButton") && w * h > cv.refWidth * cv.refHeight * .4)
        add(f, "error", "INPUT_BLOCKER", "大きな非ボタン画像が入力を遮ります。", "背景・装飾画像は raycastBlock=false にする。");
    }
  }

  // Interactive siblings must not occupy the same place. This catches the most common generated-UI collapse.
  for (const p of all) {
    const kids = (p.node?.children ?? []).filter((n: any) => n?.resolvedRect && (n?.components?.includes("uiButton") || n?.components?.includes("uiSlider") || n?.components?.includes("uiToggle")));
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      if (overlapRatio(kids[i].resolvedRect, kids[j].resolvedRect) > .2)
        issues.push({ severity: "error", code: "INTERACTIVE_OVERLAP", entityId: kids[j].entityId, name: kids[j].name,
          message: `同じ親の操作要素「${kids[i].name}」と20%以上重なっています。`, fix: "UILayout を使うか、アンカー/offset を分離する。" });
    }
  }

  // ── 計測lint: 兄弟間の整列・間隔 ─────────────────────────────
  // 「ほぼ揃ってるのに1〜3pxだけズレ」「gapが4pxグリッドに乗らない」は生成UIの典型。
  const gapValues: number[] = [];
  for (const p of all) {
    const kids = (p.node?.children ?? []).filter(hasVisibleRect);

    // SIBLING_MISALIGNMENT: 左端(または上端)が1〜3pxだけズレている兄弟ペア。
    // 0pxちょうど(揃ってる)と4px以上(意図的な差)は対象外。
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const [ax, ay] = kids[i].resolvedRect, [bx, by] = kids[j].resolvedRect;
      const dx = Math.round(Math.abs(ax - bx)), dy = Math.round(Math.abs(ay - by));
      if (dx >= 1 && dx <= 3)
        issues.push({ severity: "warning", code: "SIBLING_MISALIGNMENT", entityId: kids[j].entityId, name: kids[j].name,
          message: `兄弟「${kids[i].name}」と左端が ${dx}px だけズレています (x=${ax.toFixed(0)} と x=${bx.toFixed(0)})。`,
          fix: `x を ${ax.toFixed(0)} に揃える(またはUILayoutで整列する)。` });
      else if (dy >= 1 && dy <= 3)
        issues.push({ severity: "warning", code: "SIBLING_MISALIGNMENT", entityId: kids[j].entityId, name: kids[j].name,
          message: `兄弟「${kids[i].name}」と上端が ${dy}px だけズレています (y=${ay.toFixed(0)} と y=${by.toFixed(0)})。`,
          fix: `y を ${ay.toFixed(0)} に揃える(またはUILayoutで整列する)。` });
    }

    // OFF_GRID_SPACING: 隣接兄弟の間隔が4pxグリッドに乗っていない。
    // 縦積み(横方向に重なる)は垂直gap、横並び(縦方向に重なる)は水平gapで判定。
    // 64pxを超える間隔はレイアウト領域の分割とみなして issue にしない(gapValues には残す)。
    const checkGaps = (axis: 0 | 1) => {
      const sorted = [...kids].sort((a, b) => a.resolvedRect[axis] - b.resolvedRect[axis]);
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i].resolvedRect, b = sorted[i + 1].resolvedRect;
        const cross = axis === 0 ? 1 : 0;
        const overlap = Math.min(a[cross] + a[cross + 2], b[cross] + b[cross + 2]) - Math.max(a[cross], b[cross]);
        if (overlap <= 0) continue; // 交差軸で重なってない=積み/並びの関係にない
        const gap = Math.round((b[axis] - (a[axis] + a[axis + 2])) * 10) / 10;
        if (gap <= 0) continue;
        gapValues.push(gap);
        if (gap <= 64 && gap % 4 !== 0)
          issues.push({ severity: "suggestion", code: "OFF_GRID_SPACING", entityId: sorted[i + 1].entityId, name: sorted[i + 1].name,
            message: `「${sorted[i].name}」との${axis === 1 ? "垂直" : "水平"}間隔 ${gap}px が4pxグリッドに乗っていません。`,
            fix: `間隔を ${Math.round(gap / 4) * 4 || 4}px など4の倍数に揃える。` });
      }
    };
    checkGaps(1);
    checkGaps(0);
  }

  // ── 計測lint: タイポスケール ─────────────────────────────────
  const fontSizeCount = new Map<number, number>();
  for (const f of all) if (f.node?.uiText && hasVisibleRect(f.node)) {
    const fs = Number(f.node.uiText.fontSize ?? 24);
    fontSizeCount.set(fs, (fontSizeCount.get(fs) ?? 0) + 1);
  }
  const fontSizes = [...fontSizeCount.entries()].sort((a, b) => b[0] - a[0])
    .map(([size, count]) => ({ size, count }));
  if (fontSizes.length > 5)
    issues.push({ severity: "suggestion", code: "FONT_SIZE_SPRAWL",
      message: `文字サイズが ${fontSizes.length} 種類あり、タイポスケールが乱れています (${fontSizes.map(f => f.size).join(", ")}px)。`,
      fix: "見出し・本文・補助の3〜5段のスケール(例: 48/32/24/18)へ集約する。" });

  // ── 計測lint: 中央揃え単調 ───────────────────────────────────
  // インタラクティブ+テキスト要素の矩形中心がキャンバス中心±2pxに乗る割合。全部中央はAI的構図の典型。
  let centeredTargets = 0, centeredHits = 0;
  for (const f of all) {
    const n = f.node;
    if (!hasVisibleRect(n) || !(isInteractive(n) || n?.uiText)) continue;
    const cv = f.canvas?.uiCanvas ?? { refWidth: 1920, refHeight: 1080 };
    centeredTargets++;
    if (Math.abs((n.resolvedRect[0] + n.resolvedRect[2] / 2) - cv.refWidth / 2) <= 2) centeredHits++;
  }
  const centeredRatio = centeredTargets > 0 ? centeredHits / centeredTargets : 0;
  if (centeredTargets >= 6 && centeredRatio >= .8)
    issues.push({ severity: "suggestion", code: "CENTERED_MONOTONY",
      message: `操作/テキスト要素 ${centeredTargets} 個のうち ${Math.round(centeredRatio * 100)}% が水平中央揃えです。`,
      fix: "情報レールを左右に寄せる等、非対称の構図を混ぜる(designBrief の composition を参照)。" });

  // A restrained palette is usually more authored than every element having a unique colour.
  const colors = new Set(all.map(f => f.node?.uiImage?.color).filter(Array.isArray)
    .map((c: number[]) => c.slice(0, 3).map(v => Math.round(v * 16)).join(",")));
  if (colors.size > 12) issues.push({ severity: "suggestion", code: "PALETTE_SPRAWL",
    message: `${colors.size}系統の面色があり、画面の統一感が弱くなっています。`, fix: "背景・面・文字・アクセント・状態色の5役程度へ色を整理する。" });

  // colorGroups: 近似色(RGB各成分を1/8刻みで量子化)ごとに代表色・使用回数・使用エンティティ例をまとめる。
  const groupMap = new Map<string, { sum: number[]; count: number; examples: string[] }>();
  for (const f of all) {
    const c = f.node?.uiImage?.color;
    if (!Array.isArray(c)) continue;
    const key = c.slice(0, 3).map((v: number) => Math.round(v * 8)).join(",");
    const g = groupMap.get(key) ?? { sum: [0, 0, 0], count: 0, examples: [] };
    for (let k = 0; k < 3; k++) g.sum[k] += c[k] ?? 0;
    g.count++;
    if (g.examples.length < 3 && f.node?.name) g.examples.push(f.node.name);
    groupMap.set(key, g);
  }
  const colorGroups: ColorGroup[] = [...groupMap.values()].sort((a, b) => b.count - a.count)
    .map(g => ({ color: g.sum.map(v => Math.round(v / g.count * 1000) / 1000), count: g.count, examples: g.examples }));

  const errors = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;
  const suggestions = issues.filter(i => i.severity === "suggestion").length;
  const score = Math.max(0, 100 - errors * 12 - warnings * 5 - suggestions * 2);
  return {
    pass: errors === 0 && (strictness !== "strict" || warnings === 0), score,
    grade: score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F",
    summary: { canvases: tree?.canvases?.length ?? 0, nodes: all.length, errors, warnings, suggestions },
    issues,
    // 測定値サマリ。issue にならなくても常に返す(AIっぽさの定量把握用)。
    metrics: {
      fontSizes,                                        // 使用フォントサイズと回数(降順)
      colorGroups,                                      // 近似色グループ(代表色/回数/使用例)
      centeredRatio: Math.round(centeredRatio * 1000) / 1000, // 水平中央揃え率(操作+テキスト要素)
      gapValues: [...new Set(gapValues)].sort((a, b) => a - b), // 観測した兄弟間gap(重複除去・昇順)
    },
    principles: ["主役は1つ", "装飾より余白と整列", "CTAは画面内1–2個", "操作領域72×44px以上", "生成後はui_tree監査とスクリーンショットを両方確認"],
  };
}

export function designBrief(genre: string, screen: string, tone = "premium") {
  const profiles: Record<string, any> = {
    tactical: { composition: "非対称の情報レール＋広い戦術表示面", shape: "直線、切り欠き、細い罫線", accent: "低彩度面に警告色を一点", motion: "120–220msの短いスライド" },
    fantasy: { composition: "中央の象徴物＋左右に従属情報", shape: "額縁的だが角丸は控える", accent: "金属色は重要度の高い箇所だけ", motion: "240–420msの緩いフェード" },
    horror: { composition: "余白を大きく取り、情報を端へ寄せる", shape: "不均衡、細い境界、低コントラスト面", accent: "危険色は状態変化時のみ", motion: "基本静止。必要時だけ短い揺れ" },
    arcade: { composition: "スコアを最上位に置く明快な三角構図", shape: "太いシルエットと少数の幾何形", accent: "2色までの高彩度アクセント", motion: "80–180msのスナップとパンチ" },
    cozy: { composition: "カードを詰めすぎず、左揃えの穏やかな流れ", shape: "柔らかな角と手触りのある面", accent: "暖色を選択・報酬に限定", motion: "180–300msの小さなフェード" },
    cinematic: { composition: "大きなネガティブスペース＋下端の操作列", shape: "ほぼ無装飾、細い区切り", accent: "作品固有の1色のみ", motion: "300–500msの抑制した入場" },
  };
  const p = profiles[genre] ?? profiles.cinematic;
  const screenRules: Record<string, string> = {
    title: "ロゴ→主要アクション→補助アクションの3段階。設定や終了をSTARTと同格にしない。",
    hud: "中心視野を空け、常時情報は四隅へ。戦闘時だけ必要な情報は平時に隠す。",
    inventory: "一覧・選択状態・詳細の3領域を明確化し、詳細より一覧の操作速度を優先。",
    settings: "カテゴリ、設定項目、現在値を一直線に読み取れるようにし、適用/戻るを固定。",
    result: "結果の結論を先に見せ、内訳は遅れて開示。次の行動を1つだけ強くする。",
    dialog: "話者、本文、送りの順。背景情報とのコントラストを確保し、本文に演出を盛りすぎない。",
  };
  return {
    genre, screen, tone, direction: p, screenRule: screenRules[screen] ?? "視線の始点・比較領域・次の行動をそれぞれ1つに絞る。",
    hierarchy: ["primary: 画面目的/現在状態", "secondary: 比較・選択対象", "tertiary: 補助説明/キーガイド"],
    constraints: { safeArea: 48, minHitTarget: [72, 44], bodyText: 24, captionText: 18, maxAccents: 2, maxCta: 2, spacingScale: [8, 12, 16, 24, 32, 48, 64] },
    avoid: ["全パネルを同じ角丸カードにする", "青紫ネオンの多用", "すべて中央揃え", "全要素にグラデ・影・枠を付ける", "意味のない英大文字ラベル", "常時動く装飾"],
    workflow: ["briefを確定", "UILayout中心で骨格生成", "dx12_ui_audit(strict)が通るまで修正", "dx12_ui_screenshotで視線誘導と固有性を確認"],
  };
}
