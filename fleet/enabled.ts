// フリートのツールがこのサーバで有効か(doctor / エラーの fix が「dx12_engine_launch を撃つ」を案内してよいか)。
let enabled = false;
export function setFleetToolsEnabled(v: boolean) { enabled = v; }
export function fleetToolsEnabled(): boolean { return enabled; }
