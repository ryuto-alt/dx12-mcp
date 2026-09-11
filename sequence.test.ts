// sequence.ts の単体テスト(エンジン不要)。
// 守りたいのは 4 つ:
//   1) 台本の不備を【生成前に】全部言う(実行してから気付くのが一番高い)
//   2) 生成した Lua がエンジンの流儀に従っている
//      (findEntity は isValid で確かめる / カメラの pitch 符号 / 時計は realDt)
//   3) 後始末が必ず入る(スローモのまま終わらない・揺れが累積しない)
//   4) VFX レシピと地続き(preset 名から fx:burst が出る)

import {
  EASES, SEQUENCE_EXAMPLE, TRACK_TYPES,
  generateLua, layerToBurst, luaValue, referencedEntities, referencedVfx,
  trackDuration, unknownVfxPresets, validateSpec, type SequenceSpec,
} from "./sequence.ts";
import { findVfxPreset } from "./vfx.ts";

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  OK  ${label}`);
  else { failed++; console.log(`  NG  ${label}${detail ? `\n      ${detail}` : ""}`); }
}

console.log("[1] 台本の検証");
{
  const ok = validateSpec(SEQUENCE_EXAMPLE);
  check("例の台本はエラー無し", ok.errors.length === 0, JSON.stringify(ok.errors));
  check("長さを計算する", ok.duration === 4.4, `${ok.duration}`);
  check("t 順に並べ替える", ok.sorted.every((t, i, a) => i === 0 || a[i - 1].t <= t.t));

  const bad = validateSpec({
    name: "9bad name",
    tracks: [
      { t: -1, type: "camera", to: [0, 0, 0] } as any,
      { t: 0, type: "nope" } as any,
      { t: 1, type: "vfx", preset: "no_such_effect", at: [0, 0, 0] } as any,
      { t: 2, type: "post", set: {} } as any,
      { t: 3, type: "move", target: "", to: [0, 0, 0] } as any,
      { t: 4, type: "camera", to: [1, 1, 1], ease: "wobble" } as any,
    ],
  });
  check("名前の不正を言う", bad.errors.some((e) => e.includes("name")), JSON.stringify(bad.errors));
  check("負の時刻を言う", bad.errors.some((e) => e.includes("t は 0 以上")));
  check("知らない type を言う", bad.errors.some((e) => e.includes("知らない type")));
  check("知らない VFX プリセットを言う", bad.errors.some((e) => e.includes("no_such_effect")));
  check("空の post set を言う", bad.errors.some((e) => e.includes("set が空")));
  check("target 無しの move を言う", bad.errors.some((e) => e.includes("target")));
  check("知らない ease を言う", bad.errors.some((e) => e.includes("wobble")));
  check("camera があるのに spec.camera が無いことを言う",
    bad.errors.some((e) => e.includes("spec.camera")));

  // 警告(エラーではないが事故のもと)
  const warn = validateSpec({
    name: "W", camera: "Cam",
    tracks: [
      { t: 0, type: "camera", to: [0, 1, 0], dur: 2 },                    // 注視点なし
      { t: 1, type: "camera", to: [3, 1, 0], lookAt: [0, 0, 0], dur: 2 }, // 重なり
      { t: 0.5, type: "timeScale", value: 0 },                             // 止めっぱなし
      { t: 2, type: "scene", path: "scenes/next.json" },
      { t: 3, type: "log", text: "遷移の後" },
    ],
  });
  check("注視点の無いカメラを警告", warn.warnings.some((w) => w.includes("注視点が無い")));
  check("カメラトラックの重なりを警告", warn.warnings.some((w) => w.includes("重なっている")));
  check("時間を止めたままを警告", warn.warnings.some((w) => w.includes("戻していない")));
  check("シーン遷移の後ろのトラックを警告", warn.warnings.some((w) => w.includes("後ろは実行されない")));
  check("警告だけならエラーは出ない", warn.errors.length === 0, JSON.stringify(warn.errors));

  check("空の台本はエラー", validateSpec({ name: "E", tracks: [] }).errors.length > 0);
  check("既定の長さが型ごとに入る", trackDuration({ t: 0, type: "camera", to: [0, 0, 0] }) === 2.0);
  check("dur 指定が優先", trackDuration({ t: 0, type: "camera", to: [0, 0, 0], dur: 5 }) === 5);
  check("種類が 13 種ある", TRACK_TYPES.length === 13, `${TRACK_TYPES.length}`);
  check("ease が 6 種ある", EASES.length === 6);
}

console.log("[2] 生成される Lua の流儀");
{
  const lua = generateLua(SEQUENCE_EXAMPLE);

  check("エンジンの罠を踏まない: findEntity は isValid で確かめる",
    lua.includes("e:isValid()"), "無効な Entity を返す仕様への対処が無い");
  check("時計はタイムスケール非適用(realDt)",
    lua.includes("time.realDt()") && !lua.includes("time.dt()"));
  check("カメラの pitch は符号を反転して入れる",
    lua.includes("Vec3.new(-pitch, yaw, 0)"), "ApplyCameraTransformToGlobal の規約");
  check("yaw は atan(dx, dz)(エンジンの規約と同じ)", lua.includes("math.atan(dx, dz)"));
  check("イベント購読は OnStart の中", /function OnStart[\s\S]*events:on\(/.test(lua));
  check("OnStart / OnUpdate を定義している",
    lua.includes("function OnStart(self)") && lua.includes("function OnUpdate(self)"));
  check("properties で自動再生を切り替えられる", lua.includes('name = "autoPlay"'));

  // 後始末
  check("★終了時にタイムスケールを 1 へ戻す", lua.includes("time.setScale(1.0)"),
    "スローモのまま終わるとゲームが壊れる");
  check("★揺れは前フレーム分を戻してから足す", lua.includes("self._shakeOff"),
    "足しっぱなしだとカメラが漂う");
  check("終了イベントを発火する", lua.includes('events:emit(DONE_EVENT'));

  // 内容
  check("カメラトラックが出ている", lua.includes("cam.transform.position = Vec3.new"));
  check("lookAtName は毎フレーム追う", lua.includes('findE("Boss")'));
  check("音が鳴る", lua.includes('audio:playBGM("audio/boss_theme.wav"'));
  check("スローモが入る", lua.includes("time.setScale(0.25)"));
  check("ポストは開始値を捕まえてから動かす", lua.includes('post.set("saturationOn", true)'));
  check("最初の fade to clear は黒から明ける", lua.includes('post.set("exposure", 0.0)'));

  // VFX(レシピ 5 レイヤーぶんの burst が出る)
  const bursts = (lua.match(/fx:burst\{/g) ?? []).length;
  check("VFX はレイヤー数ぶん burst する", bursts === findVfxPreset("explosion")!.layers.length,
    `${bursts} 個`);
}

console.log("[3] Lua リテラル化");
{
  check("文字列はエスケープする", luaValue('a"b\\c') === '"a\\"b\\\\c"');
  check("数値は丸める", luaValue(1 / 3) === "0.3333");
  check("配列はテーブルに", luaValue([1, 2]) === "{ 1, 2 }");
  check("bool はそのまま", luaValue(true) === "true");
  check("undefined は nil", luaValue(undefined) === "nil");

  // 改行を含む文字列を入れても Lua の構文を壊さない
  const lua = generateLua({
    name: "Esc", tracks: [{ t: 0, type: "log", text: 'a"b\nc' }],
  });
  check("log の改行がコードを壊さない", lua.includes('\\n') && !lua.split("log(")[1].startsWith('"a"b'));
}

console.log("[4] VFX との地続き");
{
  const l = findVfxPreset("torch")!.layers[0];
  const burst = layerToBurst(l, "p", 2);
  check("scale が大きさに掛かる", burst.includes(`size = ${l.size * 2}`), burst);
  check("色は開始色と終了色が出る", burst.includes("rEnd =") && burst.includes("r ="));
  check("kind と blend が出る", burst.includes(`kind = ${l.kind}`) && burst.includes("blend = 0"));
  check("ライト化も引き継ぐ", burst.includes("light = true"));

  check("参照エンティティを列挙できる",
    referencedEntities(SEQUENCE_EXAMPLE).sort().join(",") === "Boss,CutsceneCam",
    JSON.stringify(referencedEntities(SEQUENCE_EXAMPLE)));
  check("使っている VFX を列挙できる",
    referencedVfx(SEQUENCE_EXAMPLE).join(",") === "explosion");
  check("知らないプリセットだけ返す",
    unknownVfxPresets({ name: "X", tracks: [
      { t: 0, type: "vfx", preset: "torch", at: [0, 0, 0] },
      { t: 1, type: "vfx", preset: "bogus", at: [0, 0, 0] },
    ] } as SequenceSpec).join(",") === "bogus");
}

console.log("[5] 生成コードの構造(かっこの対応)");
{
  // Lua の構文チェックはエンジン側(create_lua_component)が行うが、
  // 生成が壊れて括弧が閉じない事故だけは手元で気付けるようにしておく。
  const lua = generateLua(SEQUENCE_EXAMPLE);
  const open = (lua.match(/\{/g) ?? []).length;
  const close = (lua.match(/\}/g) ?? []).length;
  check("波括弧の数が合っている", open === close, `{ ${open} } ${close}`);
  const fn = (lua.match(/\bfunction\b/g) ?? []).length;
  const end = (lua.match(/\bend\b/g) ?? []).length;
  check("function と end の数が合っている(if/for ぶんは end が多い)", end >= fn, `function ${fn} / end ${end}`);
  check("生成が空でない", lua.split("\n").length > 80);
}

console.log(failed === 0 ? "\nOK: sequence テストすべて通過" : `\nNG: ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
