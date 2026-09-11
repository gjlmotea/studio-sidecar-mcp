import { describe, expect, it } from 'vitest';

import { LocalStudioHost } from '../../src/adapters/local-studio-host.js';
import type { ProcessInspector, RawProcess } from '../../src/ports/process-inspector.js';

function proc(overrides: Partial<RawProcess> & { pid: number }): RawProcess {
  return {
    parentPid: 0,
    startedAt: '2026-08-30T00:00:00.000Z',
    name: 'x',
    executablePath: undefined,
    windowTitle: undefined,
    ...overrides,
  };
}

/** 會記帳的假 inspector：用來釘住「snapshot 只查兩次」這個不變量。 */
class CountingInspector implements ProcessInspector {
  readonly platform: NodeJS.Platform = 'win32';
  calls: string[] = [];

  constructor(private readonly rows: readonly RawProcess[], private readonly broker?: number) {}

  async listAll(): Promise<readonly RawProcess[]> {
    this.calls.push('listAll');
    return this.rows;
  }

  async listeningPid(): Promise<number | undefined> {
    this.calls.push('listeningPid');
    return this.broker;
  }

  async connectedPids(): Promise<readonly number[]> {
    this.calls.push('connectedPids');
    return [];
  }

  async isAlive(): Promise<boolean> {
    this.calls.push('isAlive');
    return true;
  }

  async kill(): Promise<readonly { pid: number; reason: string }[]> {
    this.calls.push('kill');
    return [];
  }
}

// 一個逼真的行程表：broker + 三隻 stub，其中兩隻包著 cmd.exe 外殼。
const ROWS: readonly RawProcess[] = [
  proc({ pid: 1, name: 'explorer.exe' }),
  proc({ pid: 10, name: 'codex.exe', parentPid: 1 }),
  proc({ pid: 11, name: 'cmd.exe', parentPid: 10 }),
  proc({ pid: 12, name: 'StudioMCP.exe', parentPid: 11 }),
  proc({ pid: 20, name: 'claude.exe', parentPid: 1 }),
  proc({ pid: 21, name: 'cmd.exe', parentPid: 20 }),
  proc({ pid: 22, name: 'StudioMCP.exe', parentPid: 21 }),
  proc({ pid: 30, name: 'StudioMCP.exe', parentPid: 1 }),
  proc({ pid: 40, name: 'RobloxStudioBeta.exe', parentPid: 1, windowTitle: 'sample-game - Roblox Studio' }),
];

describe('LocalStudioHost.snapshot', () => {
  it('🔴 只查兩次作業系統 —— 逐個 pid 查會撞穿 MCP 逾時', async () => {
    // 第一版對每個 stub 逐層查父行程：16 隻 stub × 5 次 ≈ 80 次 PowerShell 啟動，
    // 真機驗證直接 -32001 逾時。這條測試就是為了不讓它復發。
    const inspector = new CountingInspector(ROWS, 30);
    await new LocalStudioHost(inspector, 'C:\\fake\\RobloxStudioBeta.exe').snapshot();
    expect(inspector.calls.sort()).toEqual(['listAll', 'listeningPid']);
  });

  it('認得出 broker 與 stub', async () => {
    const inspector = new CountingInspector(ROWS, 30);
    const snap = await new LocalStudioHost(inspector, 'C:\\fake\\x.exe').snapshot();
    expect(snap.brokerPid).toBe(30);
    const roles = Object.fromEntries(snap.mcpProcesses.map((r) => [r.pid, r.role]));
    expect(roles).toEqual({ 12: 'stub', 22: 'stub', 30: 'broker' });
  });

  it('往上跳過 cmd.exe 外殼，認出真正的客戶端', async () => {
    const inspector = new CountingInspector(ROWS, 30);
    const snap = await new LocalStudioHost(inspector, 'C:\\fake\\x.exe').snapshot();
    const clients = Object.fromEntries(snap.mcpProcesses.map((r) => [r.pid, r.client]));
    expect(clients[12]).toBe('codex.exe');
    expect(clients[22]).toBe('claude.exe');
  });

  it('挑得出 Studio 行程並帶回視窗標題', async () => {
    const inspector = new CountingInspector(ROWS, 30);
    const snap = await new LocalStudioHost(inspector, 'C:\\fake\\x.exe').snapshot();
    expect(snap.studios).toHaveLength(1);
    expect(snap.studios[0]?.windowTitle).toBe('sample-game - Roblox Studio');
  });

  it('找不到 broker 時 brokerPid 為 undefined，交給上層決定怎麼辦', async () => {
    const inspector = new CountingInspector(ROWS, undefined);
    const snap = await new LocalStudioHost(inspector, 'C:\\fake\\x.exe').snapshot();
    expect(snap.brokerPid).toBeUndefined();
    expect(snap.mcpProcesses.every((r) => r.role === 'stub')).toBe(true);
  });

  it('父行程已消失時不會爆，client 回 undefined', async () => {
    const orphan = [proc({ pid: 99, name: 'StudioMCP.exe', parentPid: 12345 })];
    const inspector = new CountingInspector(orphan, undefined);
    const snap = await new LocalStudioHost(inspector, 'C:\\fake\\x.exe').snapshot();
    expect(snap.mcpProcesses[0]?.client).toBeUndefined();
  });
});
