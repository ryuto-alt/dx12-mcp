// vfx.ts の単体テスト(エンジン不要)。
// 守りたいのは 4 つ:
//   1) レシピが【エンジンが実際に読むフィールド名/値域】から外れていない
//      (ここがズレると「applied:true なのに何も出ない」になる)
//   2) 倍率(scale/rate/intensity/color)がレシピの性格を壊さない
//   3) 危ない設定(ライト過多・粒数過多・GPU 非対応項目)を警告として必ず出す
//   4) 計測が「出ていない」を取りこぼさない

import {
  VFX_IDS, VFX_PRESETS, VFX_TAGS,
  applyOverrides, describeLibrary, estimateLiveParticles, findVfxPreset,
  measureVfxFrames, resolveVfx, retintTo,
} from "./vfx.ts";
import { PNG } from "pngjs";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] レシピの健全性(エンジンの値域から外れていないか)");
{
  check("プリセットが 20 個以上ある", VFX_PRESETS.length >= 20, `${VFX_PRESETS.length} 個`);
  check("id が重複していない", new Set(VFX_IDS).size === VFX_IDS.length);

  for (const p of VFX_PRESETS) {
    const where = `preset "${p.id}"`;
    if (p.layers.length === 0 && !p.trail) {
      check(`${where}: 空でない`, false, "レイヤーもトレイルも無い＝付けても何も出ない");
    }
    if (p.layers.length > 16) check(`${where}: レイヤー 16 枚以下`, false, `${p.layers.length} 枚`);
    for (const l of p.layers) {
      const at = `${where} layer "${l.name}"`;
      if (!(l.kind >= 0 && l.kind <= 7)) check(`${at}: kind は 0..7`, false, `kind=${l.kind}`);
      if (l.blend !== undefined && l.blend !== 0 && l.blend !== 1) {
        check(`${at}: blend は 0/1`, false, `blend=${l.blend}`);
      }
      if (l.orient !== undefined && !(l.orient >= 0 && l.orient <= 2)) {
        check(`${at}: orient は 0..2`, false, `orient=${l.orient}`);
      }
      if (!(l.rate > 0)) check(`${at}: rate > 0`, false, `rate=${l.rate}`);
      if (!(l.life > 0)) check(`${at}: life > 0`, false, `life=${l.life}`);
      if (!(l.size > 0)) check(`${at}: size > 0`, false, `size=${l.size}`);
      for (const [key, c] of [["color", l.color], ["colorEnd", l.colorEnd], ["colorMid", l.colorMid]] as const) {
        if (!c) continue;
        if (c.length !== 3 || c.some((v) => v < 0 || v > 1)) {
          check(`${at}: ${key} は 0..1 の 3 成分`, false, JSON.stringify(c));
        }
      }
      // ワンショットは「勝手に鳴らない」こと。playOnStart=true の looping=false は
      // Play した瞬間に 1 回だけ出て以後沈黙する＝ほぼ間違い。
      if (l.looping === false && l.playOnStart === true) {
        check(`${at}: ワンショットは playOnStart=false`, false, "Play 開始時に 1 度だけ出て終わる");
      }
      if (l.looping === false && !(l.duration && l.duration > 0)) {
        check(`${at}: ワンショットは duration > 0`, false, `duration=${l.duration}`);
      }
    }
  }
  console.log("  (上に NG が無ければレシピは全件健全)");

  // 煙・血・雪が加算になっていないか(これを間違えると「白く光る煙」になる)
  const mustBeAlpha = ["torch:Smoke", "campfire:Smoke", "blood_burst:Spray", "snow:Flakes", "ground_mist:Mist"];
  for (const key of mustBeAlpha) {
    const [pid, lname] = key.split(":");
    const l = findVfxPreset(pid)?.layers.find((x) => x.name === lname);
    check(`${key} は前乗算アルファ(blend=1)`, l?.blend === 1, `blend=${l?.blend}`);
  }
  // 炎・魔法は加算(ブルームに乗せる)
  for (const key of ["torch:Flame", "campfire:Flame", "magic_circle:Core", "explosion:Fireball"]) {
    const [pid, lname] = key.split(":");
    const l = findVfxPreset(pid)?.layers.find((x) => x.name === lname);
    check(`${key} は加算 + intensity>=0.8`, (l?.blend ?? 0) === 0 && (l?.intensity ?? 0) >= 0.8,
      `blend=${l?.blend} intensity=${l?.intensity}`);
  }

  // ★【密度 × 強度】の上限。加算は重なった枚数だけ足し算なので、
  //   rate を上げたまま intensity を上げると芯が真っ白に潰れて色も形も消える(実測)。
  //   粒が重なる層(size が大きい = 0.15 以上)だけを見る。火の粉のような細かい粒は対象外。
  for (const p of VFX_PRESETS) {
    for (const l of p.layers) {
      if ((l.blend ?? 0) !== 0) continue;           // 加算だけ
      if (l.size < 0.15) continue;                   // 細かい粒は重ならないので除外
      if (l.looping === false) continue;             // 一瞬の爆発/閃光は飛んで良い
      const load = l.rate * (l.intensity ?? 1);
      if (load > 90) {
        check(`${p.id}:${l.name} の rate×intensity が過大`, false,
          `${l.rate} × ${l.intensity} = ${load.toFixed(0)}(目安 50、上限 90)。芯が白く潰れる`);
      }
    }
  }
  // ★大きな Glow(kind 0)は 1 枚でも画面を覆うので、重なると即『白いドーム』になる。
  //   実測: 魔法陣の中心 Glow を size 0.9 / intensity 2.0 にしたら、リングが見えない白い球になった。
  for (const p of VFX_PRESETS) {
    for (const l of p.layers) {
      if (l.kind !== 0 || (l.blend ?? 0) !== 0) continue;
      if (l.looping === false) continue;          // 一瞬の閃光は別
      if (l.size >= 0.5 && (l.intensity ?? 1) > 1.2) {
        check(`${p.id}:${l.name} は大きい Glow なのに強い`, false,
          `size=${l.size} intensity=${l.intensity}(size>=0.5 の Glow は intensity<=1.2)`);
      }
    }
  }
  console.log("  (上に NG が無ければ密度×強度も範囲内)");
}

console.log("[2] 倍率の適用");
{
  const base = findVfxPreset("torch")!;
  const flame = base.layers[0];

  const big = applyOverrides(flame, { scale: 2 });
  check("scale はサイズと速度に掛かる", big.size === flame.size * 2 && big.speed === flame.speed! * 2);
  check("scale はライト到達距離にも掛かる", big.lightRange === flame.lightRange! * 2);
  check("scale は寿命を変えない(粒数を増やさないため)", big.life === flame.life);

  const smoke = base.layers[1];
  const scaledSmoke = applyOverrides(smoke, { scale: 3 });
  check("scale はオフセットにも掛かる", scaledSmoke.offset![1] === smoke.offset![1] * 3,
    JSON.stringify(scaledSmoke.offset));

  const dense = applyOverrides(flame, { rate: 0.5 });
  check("rate 倍率が効く", dense.rate === flame.rate * 0.5);

  const bright = applyOverrides(flame, { intensity: 2 });
  check("intensity 倍率が効く", bright.intensity === flame.intensity! * 2);

  const blue = applyOverrides(flame, { color: [0.3, 0.6, 1.0] });
  check("color は開始色を置き換える", JSON.stringify(blue.color) === JSON.stringify([0.3, 0.6, 1.0]));
  check("color の置き換えでも終了色は暗いまま(減衰が残る)",
    blue.colorEnd[2] < blue.color[2], JSON.stringify(blue.colorEnd));

  const smokeTinted = applyOverrides(smoke, { color: [1, 0, 0] });
  check("煙(アルファ層)は color で塗り替えない",
    JSON.stringify(smokeTinted.color) === JSON.stringify(smoke.color));

  const once = applyOverrides(flame, { oneShot: true, duration: 0.5 });
  check("oneShot で looping=false + duration", once.looping === false && once.duration === 0.5);
  check("oneShot は勝手に鳴らない(playOnStart=false)", once.playOnStart === false);

  const forced = applyOverrides(flame, { light: false });
  check("light を明示的に切れる", forced.light === false);

  check("retintTo は明度比を保つ",
    Math.abs(retintTo([0.5, 0.5, 0.5], [1, 1, 1], [0.4, 0.4, 0.4])[0] - 0.2) < 1e-6);
  check("retintTo は 0..1 にクランプする", retintTo([1, 1, 1], [0.1, 0.1, 0.1], [1, 1, 1])[0] === 1);
}

console.log("[3] 解決と警告");
{
  const r = resolveVfx("torch");
  check("torch は 3 レイヤー", r.layers.length === 3);
  check("ライト警告が出る", r.warnings.some((w) => w.includes("ポイントライト")), JSON.stringify(r.warnings));
  check("粒数を見積もる", r.estimatedLiveParticles > 0);

  const heavy = resolveVfx("campfire", { rate: 40 });
  check("粒数が多いと警告する", heavy.warnings.some((w) => w.includes("同時生存粒")),
    JSON.stringify(heavy.warnings));

  const distort = resolveVfx("shockwave_ring");
  check("歪み系は TAA 注意を出す", distort.warnings.some((w) => w.includes("歪")));

  const smokeOnly = resolveVfx("chimney_smoke", { color: [1, 0, 0] });
  check("色を変えられないレシピでは黙らずに言う",
    smokeOnly.warnings.some((w) => w.includes("色は変わらない")), JSON.stringify(smokeOnly.warnings));

  let threw = false;
  try { resolveVfx("nonexistent_effect"); } catch (e: any) {
    threw = e.message.includes("nonexistent_effect") && e.message.includes("torch");
  }
  check("未知の id はエラー + 使える id の一覧", threw);

  // ワンショットは duration ぶんだけ数える(life で数えると桁が変わる)
  const burst = estimateLiveParticles([
    { name: "x", kind: 3, rate: 200, size: 0.1, life: 5, looping: false, duration: 0.1,
      color: [1, 1, 1], colorEnd: [0, 0, 0] },
  ]);
  check("ワンショットの粒数は duration で見る", burst === 20, `${burst}`);
  const gpuOnly = estimateLiveParticles([
    { name: "g", kind: 3, rate: 600, size: 0.1, life: 2, gpu: true, color: [1, 1, 1], colorEnd: [0, 0, 0] },
  ]);
  check("GPU 粒は CPU 上限の見積もりに入れない", gpuOnly === 0, `${gpuOnly}`);
}

console.log("[4] ライブラリ一覧");
{
  const all = describeLibrary();
  check("全件返る", all.length === VFX_PRESETS.length);
  const fire = describeLibrary("fire");
  check("タグで絞れる", fire.length > 0 && fire.every((p: any) => p.tags.includes("fire")));
  check("ワンショットが一覧から分かる",
    (all.find((p: any) => p.id === "explosion") as any).oneShot === true);
  check("タグ一覧が空でない", VFX_TAGS.length > 5);
}

console.log("[5] フレーム計測(背景は画素ごとの中央値で推定する)");
{
  const solid = (v: number): Buffer => {
    const png = new PNG({ width: 64, height: 64 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  };
  // 背景 bg の上に、中央 size px 半幅の明るさ level の塊があるフレーム
  const withBlob = (level: number, size: number, bg = 10): Buffer => {
    const png = new PNG({ width: 64, height: 64 });
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        const v = (Math.abs(x - 32) < size && Math.abs(y - 32) < size) ? level : bg;
        png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  };

  const still = measureVfxFrames([solid(10), solid(10), solid(10)]);
  check("何も出ていなければ visible=false", still.visible === false);
  check("出ていない理由と確認手順を返す",
    still.suggestions.some((s) => s.includes("ワンショット")), JSON.stringify(still.suggestions));

  const moving = measureVfxFrames([withBlob(240, 6), withBlob(240, 10), withBlob(240, 6)]);
  check("出ていれば visible=true", moving.visible === true, JSON.stringify(moving.frames));
  check("効果の画素の明るさを測る", moving.frames[1].effectPeak > 0.9, JSON.stringify(moving.frames[1]));
  // 3 枚とも塊が居座る中心部は「背景」に含まれる(時間で変わらない＝地の絵、という定義)
  check("背景の明るさを別に返す", moving.sceneLuma < 0.2, `${moving.sceneLuma}`);

  // ★背景が白くても、動いているのが暗い粒なら白飛び判定は出ない
  //   (前フレーム差分で測っていた頃は、粒が消えて現れた白い背景を「飛んでいる効果」と誤判定した)
  const brightBg = measureVfxFrames([withBlob(60, 6, 250), withBlob(60, 10, 250), withBlob(60, 6, 250)],
    { additive: true });
  check("明るい背景に引っ張られて白飛び誤報を出さない",
    !brightBg.suggestions.some((s) => s.includes("飽和")), JSON.stringify(brightBg.suggestions));
  check("明るい背景では加算が埋もれると助言する",
    brightBg.suggestions.some((s) => s.includes("埋もれる")), JSON.stringify(brightBg.suggestions));
  check("背景の明るさを正しく拾う", brightBg.sceneLuma > 0.9, `${brightBg.sceneLuma}`);

  const blown = measureVfxFrames([withBlob(255, 6), withBlob(255, 10), withBlob(255, 6)]);
  check("効果そのものが飽和していれば警告する",
    blown.suggestions.some((s) => s.includes("飽和")), JSON.stringify(blown.suggestions));

  const dim = measureVfxFrames([withBlob(60, 6), withBlob(60, 10), withBlob(60, 6)], { additive: true });
  check("加算なのに暗ければ警告する", dim.suggestions.some((s) => s.includes("暗い")),
    JSON.stringify(dim.suggestions));

  // 止まった効果(3 枚とも同じ絵だが baseline とは違う)は「動いていない」と言う
  const frozen = measureVfxFrames([withBlob(200, 8), withBlob(200, 8), withBlob(200, 8)],
    { baseline: solid(10) });
  check("baseline があれば動かない効果でも visible=true", frozen.visible === true,
    JSON.stringify(frozen.frames[0]));
  check("動いていない効果はそう言う",
    frozen.suggestions.some((s) => s.includes("動いていない")), JSON.stringify(frozen.suggestions));
  check("baseline を使ったことを返す", frozen.backgroundFrom === "baseline");
  check("白い塊の画面占有率も返す", frozen.frames[0].blownAreaPct >= 0);

  // まばらな効果(蛍・埃・火の粉)は画面の 0.01% しか占めないが、点として光っていれば「出ている」
  const sparse = measureVfxFrames([withBlob(250, 1), withBlob(250, 2), withBlob(250, 1)],
    { baseline: solid(10), additive: true });
  check("まばらでも明るい点があれば visible=true", sparse.visible === true,
    JSON.stringify(sparse.frames[1]));
  // 暗い粒が暗い背景に乗ると本当に何も変わらない → 出ていない扱い + 背景を変えろと言う
  const darkOnDark = measureVfxFrames([solid(12), solid(12), solid(12)], { baseline: solid(10) });
  check("暗所の暗い粒は『見えない』と言い、背景を変えろと助言する",
    darkOnDark.visible === false && darkOnDark.suggestions.some((s) => s.includes("アルファ")),
    JSON.stringify(darkOnDark.suggestions));

  let threwEmpty = false;
  try { measureVfxFrames([]); } catch { threwEmpty = true; }
  check("フレーム 0 枚はエラー", threwEmpty);
}

console.log(failed === 0 ? "\nOK: vfx テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
