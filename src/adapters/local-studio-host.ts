import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CleanupOutcome, StudioMcpProcess, StudioProcess, StudioSnapshot } from '../domain/contracts.js';
import type { ProcessInspector, RawProcess } from '../ports/process-inspector.js';
import { StudioHostError, type StudioHost } from '../ports/studio-host.js';

/** 內建 Studio MCP 的 broker 在這個 loopback port 上 Listen。 */
export const BROKER_PORT = 13469;

/** 執行檔名在兩個平台不同：Windows 帶副檔名、macOS 不帶，Studio 本體名字也不一樣。 */
const IMAGE_NAMES: Partial<Record<NodeJS.Platform, { studio: string; mcp: string }>> = {
  win32: { studio: 'RobloxStudioBeta.exe', mcp: 'StudioMCP.exe' },
  darwin: { studio: 'RobloxStudio', mcp: 'StudioMCP' },
};

/** 這些是外殼行程，往上找真正的 MCP 客戶端時要跳過。 */
const WRAPPERS = new Set(['cmd.exe', 'sh', 'bash', 'sh.exe', 'bash.exe', 'zsh']);

/**
 * 解析 Roblox Studio 執行檔。
 *
 * Windows 的路徑帶版本 hash，每次 Studio 更新就換一個，而且**舊版目錄不會被清掉**
 * （實測本機留著六份）。判準是「同時帶著 Studio 主程式的版本目錄」＝目前安裝版。
 */
export function resolveStudioExecutable(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') {
    const versions = join(
      process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
      'Roblox',
      'Versions',
    );
    if (!existsSync(versions)) return undefined;
    const candidates: { path: string; mtime: number }[] = [];
    for (const entry of readdirSync(versions)) {
      const exe = join(versions, entry, 'RobloxStudioBeta.exe');
      if (existsSync(exe)) candidates.push({ path: exe, mtime: statSync(exe).mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0]?.path;
  }
  if (platform === 'darwin') {
    const paths = [
      '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
      join(homedir(), 'Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio'),
    ];
    return paths.find((path) => existsSync(path));
  }
  return undefined;
}

export class LocalStudioHost implements StudioHost {
  readonly executablePath: string | undefined;

  readonly #inspector: ProcessInspector;
  readonly #images: { studio: string; mcp: string };

  constructor(inspector: ProcessInspector, executablePath?: string) {
    this.#inspector = inspector;
    this.executablePath = executablePath ?? resolveStudioExecutable(inspector.platform);
    const images = IMAGE_NAMES[inspector.platform];
    if (images === undefined) {
      throw new StudioHostError(
        `Roblox Studio 不支援 ${inspector.platform}；本 server 只實作了 win32 與 darwin。`,
      );
    }
    this.#images = images;
  }

  /**
   * 往上跳過外殼行程，找到真正的 MCP 客戶端。
   *
   * 純記憶體運算，不再逐層去問作業系統 —— 那樣會變成 N+1 次行程查詢並撞穿逾時。
   */
  static #ownerOf(row: RawProcess, byPid: ReadonlyMap<number, RawProcess>): string | undefined {
    let current = byPid.get(row.parentPid);
    let hops = 0;
    while (current !== undefined && WRAPPERS.has(current.name) && hops < 4) {
      current = byPid.get(current.parentPid);
      hops += 1;
    }
    return current?.name;
  }

  async snapshot(): Promise<StudioSnapshot> {
    // 兩次查詢就好：一次列全部行程，一次問誰在 broker port 上 Listen。
    const [all, brokerPid] = await Promise.all([
      this.#inspector.listAll(),
      this.#inspector.listeningPid(BROKER_PORT),
    ]);

    const byPid = new Map(all.map((row) => [row.pid, row]));

    const studios: readonly StudioProcess[] = all
      .filter((row) => row.name === this.#images.studio)
      .map((row) => ({
        pid: row.pid,
        startedAt: row.startedAt,
        windowTitle: row.windowTitle,
        executablePath: row.executablePath,
      }));

    const mcpProcesses: readonly StudioMcpProcess[] = all
      .filter((row) => row.name === this.#images.mcp)
      .map((row) => ({
        pid: row.pid,
        startedAt: row.startedAt,
        executablePath: row.executablePath,
        role: row.pid === brokerPid ? ('broker' as const) : ('stub' as const),
        client: LocalStudioHost.#ownerOf(row, byPid),
      }));

    return { studios, mcpProcesses, brokerPid, brokerPort: BROKER_PORT };
  }

  async launch(args: readonly string[]): Promise<number> {
    const executable = this.executablePath;
    if (executable === undefined) {
      throw new StudioHostError(
        '找不到 Roblox Studio 執行檔；請確認已安裝，或以 ROBLOX_STUDIO_PATH 指定路徑。',
      );
    }
    // detached + unref：Studio 是長壽的 GUI 行程，不能綁在本 server 的生命週期上。
    // args 以陣列交給 spawn，由它負責平台的引號規則 —— 手動拼字串正是那個
    // 「JSON 引號被吃掉、Studio 靜默忽略 intent」的坑。
    const child = spawn(executable, [...args], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new StudioHostError('Studio 已啟動但取不到 pid。');
    return pid;
  }

  async isConnectedToBroker(pid: number): Promise<boolean> {
    const connected = await this.#inspector.connectedPids(BROKER_PORT);
    return connected.includes(pid);
  }

  /**
   * 只在 `openPlace` 的收尾路徑用來當診斷線索（標題沒帶 place 名＝啟動意圖沒被吃下去），
   * 不在輪詢迴圈裡呼叫，所以列全部的成本可以接受。
   */
  async windowTitle(pid: number): Promise<string | undefined> {
    const all = await this.#inspector.listAll();
    return all.find((row) => row.pid === pid)?.windowTitle;
  }

  async isAlive(pid: number): Promise<boolean> {
    return await this.#inspector.isAlive(pid);
  }

  async terminate(pids: readonly number[]): Promise<CleanupOutcome['failures']> {
    return await this.#inspector.kill(pids);
  }
}
