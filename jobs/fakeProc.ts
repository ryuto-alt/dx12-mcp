// ジョブのテスト用「偽の子プロセス」。ビルド / ctest / @progress プロトコル風の出力を出して終わる。
//   node fakeProc.ts --mode build|ctest|protocol|hang [--steps N] [--delay ms] [--exit C] [--grandchild pidfile] [--lock-wait ms]
import fs from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const mode = opt("--mode", "protocol")!;
const steps = Number(opt("--steps", "5"));
const delay = Number(opt("--delay", "60"));
const exitCode = Number(opt("--exit", "0"));
const grand = opt("--grandchild");
const lockWait = Number(opt("--lock-wait", "0"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (grand) {
  // 孫プロセス(プロセスツリーごと止められるかの確認用)。自分の pid をファイルへ書いて 5 分眠る。
  const c = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(grand)}, String(process.pid)); setTimeout(()=>{}, 300000)`], { stdio: "ignore", windowsHide: true });
  void c;
  // 孫が pid を書くまで少し待つ
  for (let i = 0; i < 100 && !fs.existsSync(grand); i++) await sleep(30);
}

if (mode === "cp932") {
  // 日本語 Windows の MSVC の診断は cp932。UTF-8 として不正なバイト列(「エラー」= 83 47 83 89 81 5B)を出す。
  const NL = "\n";
  process.stdout.write(Buffer.concat([
    Buffer.from("[1/2] Building CXX object a.obj" + NL),
    Buffer.from("C:\\x\\a.cpp(3,1): error C2535: "), Buffer.from([0x83, 0x47, 0x83, 0x89, 0x81, 0x5b]), Buffer.from(" tail" + NL),
    Buffer.from("utf8 line: 日本語" + NL),   // 1 行の中で混ぜず、行ごとに別の文字コードにする(実際の ninja 出力もそう)
    Buffer.from("[build] FAILED in 0.1s (exit 2)" + NL),
  ]));
  process.exit(2);
}

if (mode === "hang") { console.log("hanging"); await sleep(300_000); process.exit(0); }

if (mode === "build") {
  if (lockWait > 0) { console.log("[build] another build is running. waiting for the lock (up to 40 min)..."); await sleep(lockWait); console.log("[build] lock acquired after 1s"); }
  console.log("[build] cmake --build build\\release -j 6 --target DX12Engine -- -l 26  (jobs=6, priority=BelowNormal)");
  for (let i = 1; i <= steps; i++) {
    const d = i === steps ? "Linking CXX executable DX12Engine.exe" : `Building CXX object src\\core\\CMakeFiles\\core.dir\\Application${i}.cpp.obj`;
    console.log(`[${i}/${steps}] ${d}`);
    if (i === 2 && exitCode !== 0) console.log("C:\\dx12\\src\\core\\Foo.cpp(12,5): error C2065: 'x': undeclared identifier [C:\\dx12\\build\\core.vcxproj]");
    await sleep(delay);
  }
  console.log(`[build] ${exitCode === 0 ? "OK" : "FAILED"} in 1.2s (exit ${exitCode})`);
  process.exit(exitCode);
}

if (mode === "ctest") {
  console.log("Test project C:/dx12/build/release");
  for (let i = 1; i <= steps; i++) {
    const bad = exitCode !== 0 && i === 2;
    console.log(`      Start ${String(i).padStart(2)}: Test${i}`);
    console.log(`${String(i).padStart(2)}/${steps} Test #${i}: Test${i} ...................${bad ? "***Failed" : "   Passed"}    0.0${i} sec`);
    await sleep(delay);
  }
  if (exitCode !== 0) {
    console.log(`\n${Math.round(((steps - 1) * 100) / steps)}% tests passed, 1 tests failed out of ${steps}\n`);
    console.log("Total Test time (real) =   0.42 sec\n\nThe following tests FAILED:\n\t  2 - Test2 (Failed)\nErrors while running CTest");
  } else console.log(`\n100% tests passed, 0 tests failed out of ${steps}\n\nTotal Test time (real) =   0.30 sec`);
  process.exit(exitCode);
}

// protocol
for (let i = 1; i <= steps; i++) {
  console.log(`@progress ${JSON.stringify({ pct: Math.round((i * 100) / steps), phase: "cook", msg: `step ${i}/${steps}`, eta: (steps - i) * delay / 1000 })}`);
  console.log(`plain line ${i}`);
  await sleep(delay);
}
console.log(`@result ${JSON.stringify({ outputs: ["a.vgeo"], tris: 12345 })}`);
process.exit(exitCode);
