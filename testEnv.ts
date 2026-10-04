// テストの環境を隔離する(最初の import として読み込む)。フリートのレジストリを実ユーザーの %LOCALAPPDATA%/UnoEngine/fleet に作らない/触らない。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
if (!process.env.DX12_FLEET_DIR) {
  const dir = path.join(os.tmpdir(), `dx12-fleet-test-${process.pid}`);
  process.env.DX12_FLEET_DIR = dir;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 使用中でも落とさない */ } });
}
