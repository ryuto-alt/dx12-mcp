// ツールモジュールの読み込み(= 登録)順。ここの並びが tools/list の並びになるので、入れ替えない。
// shell 5 本が先頭、続いて旧 220 本(index.ts から機械分割したモジュール群)。
import "./shell.ts";
import "./read.ts";
import "./edit.ts";
import "./undo.ts";
import "./spawn.ts";
import "./play.ts";
import "./imguiInput.ts";
import "./physics.ts";
import "./render.ts";
import "./sceneNaming.ts";
import "./testplay.ts";
import "./playtestStore.ts";
import "./blender.ts";
import "./materialAnim.ts";
import "./multiplayer.ts";
import "./assets.ts";
import "./composite.ts";
import "./capture.ts";
import "./uiAssets.ts";
import "./pick.ts";
import "./terrain.ts";
import "./vfx.ts";
import "./lighting.ts";
import "./sequence.ts";
import "./decals.ts";
import "./navmesh.ts";
import "./diag.ts";
import "./quality.ts";
import "./git.ts";
import "./jev.ts";
import "./perceive.ts";
import "./qualityGate.ts";
// Core の統合ツール(旧ツールの登録表を引くので、旧ツールの全モジュールより後ろ)と、マニフェストの expose:"core" による動的昇格。
import "./coreTools.ts";
// dx12_sequence(シーケンサー .dxseq の Core ツール。エンジンの sequence_* を op で束ねる。旧ツールを持たない)。core 面だけ tools/list に出る。
import "./sequenceCore.ts";
// DXR パストレーサー(地上真値レンダラ。Q1a)。legacy 面には出さない(旧 220 本のスナップショットを凍結したまま保つ)。full 面ではフリート / ジョブの手前(旧 220 本の直後)。
import "./pathTracer.ts";
// 仮想ジオメトリ(Nanite 風): dx12_vg_stats / dx12_set_virtual_geometry。legacy 面には出さない。full 面ではパストレーサーの次。
import "./virtualGeometry.ts";
// Lua で仕掛けて N フレーム進めて読む合成ツール(dx12_lua_step)。eval_lua と同じく guarded。legacy 面には出さない。full 面では仮想ジオメトリの次。
import "./luaStep.ts";
// 書き換えられない正解(dx12_oracle。Q2): 金画像・性能予算・封印台帳。seal だけ guarded。legacy 面には出さない。full 面では lua_step の次。
import "./oracles.ts";
// フリート(専用エンジンの管理)。full 面では旧 220 本の後ろ(tools/list の末尾)。
import "./fleet.ts";
// ジョブ API(長い処理の非同期実行。docs/MCP_FLEET_DESIGN.md「ジョブ API」)。
import "./jobs.ts";
// エディタ操作(M7): dx12_editor_command / dx12_editor_state(core)+ dx12_editor_notify / dx12_editor_select(長尾)。
// エディタのコマンド表(メニュー・ショートカット・パレットと同じ)を名前で実行し、選択・窓・モーダルなどの状態を読む。中身は editorOps.ts。
import "./editorTools.ts";
// 宣言的シーン生成(M11): dx12_apply_scene_spec(core)+ dx12_scene_spec_export(長尾)。仕様 JSON を差分適用 → 自動検証 → 失敗は specPatch で返す。中身は ../sceneSpec/。
import "./sceneSpec.ts";
