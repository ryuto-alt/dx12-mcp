// リソースガード: 起動前に空き VRAM / RAM を見る。エンジンを増やしてユーザーのビルド・ゲームを圧迫しないため。
//   VRAM: nvidia-smi(GPU が複数なら空きが最大のもの)→ 無ければ PowerShell の GPU カウンタ+レジストリの総量 → 取れなければ「不明」
//   RAM : os.freemem()
// 観測は同期(spawnSync)。起動 1 回につき 1 回だけ呼ぶ(数百 ms)。
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { FleetConfig } from "./config.ts";

export type ResourceSnapshot = {
  vramFreeMB: number | null;
  vramUsedMB: number | null;
  vramTotalMB: number | null;
  vramSource: "nvidia-smi" | "powershell" | "fake" | "unknown";
  gpuName?: string;
  ramFreeMB: number;
  ramTotalMB: number;
};

/** nvidia-smi の csv(noheader,nounits)を読む。"NVIDIA GeForce RTX 5060, 2126, 8151" 形式。 */
export function parseNvidiaSmi(out: string): { name: string; usedMB: number; totalMB: number }[] {
  const gpus: { name: string; usedMB: number; totalMB: number }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length < 3) continue;
    const total = Number(parts[parts.length - 1]);
    const used = Number(parts[parts.length - 2]);
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) continue;
    gpus.push({ name: parts.slice(0, parts.length - 2).join(", "), usedMB: used, totalMB: total });
  }
  return gpus;
}

function fromNvidiaSmi(): Partial<ResourceSnapshot> | null {
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 6000, windowsHide: true });
    if (r.status !== 0) return null;
    const gpus = parseNvidiaSmi(r.stdout ?? "");
    if (!gpus.length) return null;
    const best = gpus.reduce((a, b) => (b.totalMB - b.usedMB > a.totalMB - a.usedMB ? b : a));
    return { vramUsedMB: best.usedMB, vramTotalMB: best.totalMB, vramFreeMB: best.totalMB - best.usedMB, vramSource: "nvidia-smi", gpuName: best.name };
  } catch { return null; }
}

// nvidia-smi が無い環境(AMD / Intel)の代役。Windows の GPU アダプタのカウンタ(専用メモリ使用量の合計)と、
// レジストリの HardwareInformation.qwMemorySize(総量)から求める。取れなければ null。
const PS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  $used = (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum | Select-Object -ExpandProperty Sum
  $total = 0
  Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
    $v = (Get-ItemProperty $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
    if ($v -and $v -gt $total) { $total = [double]$v }
  }
  if ($total -gt 0) { Write-Output ("{0} {1}" -f [math]::Round($used/1MB), [math]::Round($total/1MB)) }
} catch { }
`;

function fromPowerShell(): Partial<ResourceSnapshot> | null {
  if (process.platform !== "win32") return null;
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const m = /^(\d+)\s+(\d+)\s*$/m.exec(r.stdout ?? "");
    if (!m) return null;
    const used = Number(m[1]), total = Number(m[2]);
    if (!(total > 0)) return null;
    return { vramUsedMB: used, vramTotalMB: total, vramFreeMB: Math.max(0, total - used), vramSource: "powershell" };
  } catch { return null; }
}

export function sampleResources(cfg: Pick<FleetConfig, "fakeResources">): ResourceSnapshot {
  const ramFreeMB = Math.round(os.freemem() / 1048576);
  const ramTotalMB = Math.round(os.totalmem() / 1048576);
  const fake = cfg.fakeResources;
  if (fake) {
    return {
      vramFreeMB: fake.vramFreeMB ?? null, vramTotalMB: fake.vramTotalMB ?? null,
      vramUsedMB: fake.vramFreeMB != null && fake.vramTotalMB != null ? fake.vramTotalMB - fake.vramFreeMB : null,
      vramSource: "fake", ramFreeMB: fake.ramFreeMB ?? ramFreeMB, ramTotalMB,
    };
  }
  const v = fromNvidiaSmi() ?? fromPowerShell();
  return {
    vramFreeMB: v?.vramFreeMB ?? null, vramUsedMB: v?.vramUsedMB ?? null, vramTotalMB: v?.vramTotalMB ?? null,
    vramSource: (v?.vramSource as ResourceSnapshot["vramSource"]) ?? "unknown", ...(v?.gpuName ? { gpuName: v.gpuName } : {}),
    ramFreeMB, ramTotalMB,
  };
}

export type ResourceViolation = { kind: "vram" | "ram"; freeMB: number; minMB: number; message: string };

/** 閾値と比べる。VRAM が「不明」のときは違反にしない(呼び出し側が警告を出す)。 */
export function checkResources(snap: ResourceSnapshot, cfg: Pick<FleetConfig, "minFreeVramMB" | "minFreeRamMB">): ResourceViolation[] {
  const out: ResourceViolation[] = [];
  if (snap.vramFreeMB != null && snap.vramFreeMB < cfg.minFreeVramMB) {
    out.push({ kind: "vram", freeMB: snap.vramFreeMB, minMB: cfg.minFreeVramMB, message: `空き VRAM が ${snap.vramFreeMB} MB(下限 ${cfg.minFreeVramMB} MB)` });
  }
  if (snap.ramFreeMB < cfg.minFreeRamMB) {
    out.push({ kind: "ram", freeMB: snap.ramFreeMB, minMB: cfg.minFreeRamMB, message: `空き RAM が ${snap.ramFreeMB} MB(下限 ${cfg.minFreeRamMB} MB)` });
  }
  return out;
}
