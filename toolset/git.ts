// Git / GitHub
// index.ts から機械分割したモジュール(コードの移動のみ・挙動不変)。ツールの登録順は index.ts の import 順で決まる。
import { z } from "zod";
import { engine, reg, run } from "./core.ts";

// ════════════════════════════════════════════════════════════════
//  Git / GitHub — エディタの「Git」窓と同じ操作を AI からも撃てるようにしたもの。
//  対象はプロジェクトフォルダの git リポジトリで、エンジンの状態は変えない。
//  ★まず dx12_git_status を読むこと。未コミットの変更やマージ中かどうかで
//    次に撃てる操作が変わる（撃ってから失敗を読むより速い）。
// ════════════════════════════════════════════════════════════════

reg(
  "dx12_git_status",
  "Git 状態",
  "プロジェクトの git 状態を 1 回で返す: {branch, remoteUrl, changedFiles[{path,status,staged}], mergeInProgress, conflicts[], githubUser}。status は A=追加/未追跡 M=変更 D=削除 R=リネーム U=競合。★何かする前にこれを読む。changedFiles が空でないと dx12_git_merge は弾かれるし、mergeInProgress=true の間は「マージを終わらせるコミット」しかできない。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("git_status", {})),
);

reg(
  "dx12_git_branches",
  "ブランチ一覧",
  "ローカルブランチの一覧と、今いるブランチを返す: {current, branches[{name,current}]}。dx12_git_checkout / dx12_git_merge へ渡す名前はここから取る（推測しない）。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("git_branches", {})),
);

reg(
  "dx12_git_checkout",
  "ブランチ切替/作成",
  "ブランチを切り替える。create:true なら新規作成して切り替える。★切り替えでプロジェクトの assets が入れ替わる（シーンや .hlsl が消える/増える）ことがあるので、実行後は dx12_list_scenes と dx12_git_status を読み直すこと。エディタで開いているシーンのファイルが消えた場合はそのまま編集を続けないこと。",
  {
    name: z.string().describe("ブランチ名。既存へ切り替えるなら dx12_git_branches の名前をそのまま渡す。"),
    create: z.boolean().optional().describe("true なら新規作成して切り替える（git checkout -b）。既定 false。"),
  },
  {},
  ({ name, create }) => run(() => engine.call("git_checkout", { name, create })),
);

reg(
  "dx12_git_merge",
  "ブランチをマージ",
  "name のブランチを『今いるブランチ』へ取り込む（エディタの Git 窓のマージと同じ）。既定は --no-ff＝どこから取り込んだかが履歴に残る。★未コミットの変更があると実行前に弾かれる（先に dx12_git_commit すること）。★コンフリクトすると succeeded:false で返り conflicts[] に未解消ファイルが入る。その場合は作業ツリーが止まったままなので、ファイルを直して dx12_git_commit で完了させるか、dx12_git_merge_abort で取り消すこと。返り値 {succeeded, exitCode, output, mergedFrom, into, mergeInProgress, conflicts[]}。",
  {
    name: z.string().describe("取り込み元のブランチ名（dx12_git_branches から取る）。今いるブランチは指定できない。"),
    noFastForward: z.boolean().optional().describe("true(既定): --no-ff でマージコミットを必ず作る。false: 早送りできるときは履歴を一直線にする。"),
  },
  {},
  ({ name, noFastForward }) => run(() => engine.call("git_merge", { name, noFastForward })),
);

reg(
  "dx12_git_merge_abort",
  "マージを中止",
  "進行中のマージを取り消して、始める前の作業ツリーへ戻す（git merge --abort）。コンフリクトを解消しきれないときの逃げ道。マージ中でなければエラーになる（dx12_git_status の mergeInProgress で確認）。",
  {},
  {},
  () => run(() => engine.call("git_merge_abort", {})),
);

reg(
  "dx12_git_commit",
  "コミット",
  "変更を全部ステージしてコミットする（git add -A && git commit）。マージのコンフリクトを解消した後の『マージを終わらせるコミット』もこれ。★未解消のコンフリクトが残っていると弾かれる（競合マーカー入りのファイルをコミットさせないため）。user.name/email が未設定なら自動でこのリポジトリにだけ設定する（global は触らない）。",
  { message: z.string().describe("コミットメッセージ。何を変えたかが分かる 1 行以上。") },
  {},
  ({ message }) => run(() => engine.call("git_commit", { message })),
);

reg(
  "dx12_git_push",
  "プッシュ",
  "今のブランチをリモートへ送る（upstream が無ければ -u で設定して送る）。★【外向きの操作】＝押した内容は他人から見える場所へ出る。ユーザーが明示的に頼んでいないなら撃たないこと。リモート(origin)が未設定ならエラーになる。",
  {},
  {},
  () => run(() => engine.call("git_push", {})),
);

reg(
  "dx12_git_pull",
  "プル",
  "リモートの変更を取り込む（git pull）。コンフリクトすると dx12_git_merge と同じ形（conflicts[] と mergeInProgress:true）で返る。★取り込みでプロジェクトの assets が変わるので、実行後は dx12_git_status を読み直すこと。",
  {},
  {},
  () => run(() => engine.call("git_pull", {})),
);

reg(
  "dx12_git_fetch",
  "フェッチ",
  "リモートの最新を取ってくるだけ（git fetch --all --prune）。作業ツリーは一切変えないので安全。取り込むかどうかは別途 dx12_git_pull / dx12_git_merge で判断する。",
  {},
  { readOnlyHint: true },
  () => run(() => engine.call("git_fetch", {})),
);
