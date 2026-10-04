// fleet.test.ts が別プロセスとして起動する、レジストリの同時アクセス用ワーカー。
//   node fleetRegistryWorker.ts <fleetDir> <label> <increments> <holdPorts> [basePort]
//   1) カウンタを increments 回、トランザクションで +1(更新の取りこぼしが無いこと)
//   2) holdPorts 個のポートを「空いている最小」で予約してエントリに書く(全ワーカー通して重複しないこと)
//   3) 予約したポートの一覧を標準出力に JSON で出す
import { Registry, sleepSync, type Entry } from "./fleet/registry.ts";

const [dir, label, incStr, holdStr, baseStr] = process.argv.slice(2);
const increments = Number(incStr), hold = Number(holdStr), base = Number(baseStr ?? 8900);
const reg = new Registry(dir, { lockTimeoutMs: 20_000 });

const blank = (id: string, port: number): Entry => ({
  id, name: id, state: "starting", owner: { pid: process.pid, startMs: 0, heartbeatAt: Date.now() }, pid: 0, imageName: "", port, mode: "background",
  project: { dir: "", disposable: true }, exe: { path: "", sourcePath: "", sourceMtimeMs: 0, sizeBytes: 0, copiedAt: 0 }, startedAt: Date.now(), lastActivityAt: Date.now(), idleExitMin: 0, args: [],
});

for (let i = 0; i < increments; i++) {
  reg.transaction((d) => {
    const c = d.engines["__counter"] ?? blank("__counter", 0);
    c.port += 1;
    d.engines["__counter"] = c;
  });
  if (i % 7 === 0) sleepSync(Math.random() * 5);
}

const mine: number[] = [];
for (let i = 0; i < hold; i++) {
  reg.transaction((d) => {
    const used = new Set(Object.values(d.engines).map((e) => e.port));
    let p = base; while (used.has(p)) p++;
    const id = `${label}-${i}`;
    d.engines[id] = blank(id, p);
    mine.push(p);
  });
}
process.stdout.write(JSON.stringify({ label, ports: mine }) + "\n");
