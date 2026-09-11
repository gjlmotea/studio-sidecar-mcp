import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { StudioBridgeError, type ConnectedStudio, type StudioBridge } from '../ports/studio-bridge.js';

type ToolResult = {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly isError?: boolean;
};

/**
 * 解析 StudioMCP 的啟動方式。
 *
 * Windows 上官方提供 `%LOCALAPPDATA%\Roblox\mcp.bat`，它自己會在版本目錄之間挑
 * ——比我們自己猜版本 hash 可靠，優先用它。
 */
export function resolveBridgeCommand(
  platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    const bat = join(local, 'Roblox', 'mcp.bat');
    if (existsSync(bat)) return { command: 'cmd.exe', args: ['/c', bat] };

    // 沒有 mcp.bat 時退回自己挑版本目錄：取最新的那份 StudioMCP.exe。
    const versions = join(local, 'Roblox', 'Versions');
    if (!existsSync(versions)) return undefined;
    const candidates: { path: string; mtime: number }[] = [];
    for (const entry of readdirSync(versions)) {
      const exe = join(versions, entry, 'StudioMCP.exe');
      if (existsSync(exe)) candidates.push({ path: exe, mtime: statSync(exe).mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const best = candidates[0];
    return best === undefined ? undefined : { command: best.path, args: [] };
  }
  if (platform === 'darwin') {
    const paths = [
      '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP',
      join(homedir(), 'Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'),
    ];
    const found = paths.find((path) => existsSync(path));
    return found === undefined ? undefined : { command: found, args: [] };
  }
  return undefined;
}

function firstText(result: ToolResult, context: string): string {
  const text = result.content?.find((part) => part.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new StudioBridgeError(`${context}：回應沒有文字內容。`);
  }
  if (result.isError === true) {
    throw new StudioBridgeError(`${context}：${text}`);
  }
  return text;
}

export class McpStudioBridge implements StudioBridge {
  #client: Client | undefined;
  readonly #override: { command: string; args: readonly string[] } | undefined;
  readonly #timeoutMs: number;
  readonly #readyTimeoutMs: number;

  constructor(options: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
    /** 等 stub 連上 broker 的上限。實測冷啟動約需數秒。 */
    readonly readyTimeoutMs?: number;
  } = {}) {
    this.#override = options.command === undefined
      ? undefined
      : { command: options.command, args: options.args ?? [] };
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  }

  async #connected(): Promise<Client> {
    if (this.#client !== undefined) return this.#client;
    const launch = this.#override ?? resolveBridgeCommand();
    if (launch === undefined) {
      throw new StudioBridgeError(
        '找不到 StudioMCP 執行檔；請確認 Roblox Studio 已安裝。'
        + '（Windows 找 %LOCALAPPDATA%\\Roblox\\mcp.bat，macOS 找 RobloxStudio.app 內的 StudioMCP。）',
      );
    }
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      stderr: 'pipe',
      env: getDefaultEnvironment(),
    });
    const client = new Client({ name: 'roblox-mcp-bridge', version: '0.1.0' });
    await client.connect(transport);
    this.#client = client;
    return client;
  }

  /**
   * 剛生出來的 stub 還沒連上 broker 時的暫時性失敗。
   *
   * 🔴 這不是「Studio 沒開」或「設定沒打開」—— 訊息長那樣但兩者都正常。
   * MCP 握手（stub ↔ 本行程）比 stub ↔ broker 的註冊先完成，中間那段空窗期問下去
   * 就會拿到這句。跟 Studio 開機後約 5 秒才註冊到 broker 是同一類競爭。
   */
  static #isNotReady(message: string): boolean {
    return /Unable to reach Roblox Studio/i.test(message);
  }

  /** 有界重試：只重試上面那個明確的暫時性狀態，其餘錯誤立刻往上拋。 */
  async #withReadinessRetry<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!McpStudioBridge.#isNotReady(detail) || Date.now() >= deadline) throw error;
        await new Promise((r) => setTimeout(r, Math.min(250 * attempt, 1_500)));
      }
    }
  }

  async listStudios(): Promise<readonly ConnectedStudio[]> {
    return await this.#withReadinessRetry(async () => await this.#listStudiosOnce());
  }

  async #listStudiosOnce(): Promise<readonly ConnectedStudio[]> {
    const client = await this.#connected();
    const result = (await client.callTool(
      { name: 'list_roblox_studios', arguments: {} },
      undefined,
      { timeout: this.#timeoutMs },
    )) as ToolResult;
    const text = firstText(result, 'list_roblox_studios');
    let parsed: { studios?: readonly ConnectedStudio[] };
    try {
      parsed = JSON.parse(text) as { studios?: readonly ConnectedStudio[] };
    } catch {
      throw new StudioBridgeError(`list_roblox_studios 回應不是 JSON：${text.slice(0, 120)}`);
    }
    return parsed.studios ?? [];
  }

  async executeLuau(
    studioId: string,
    code: string,
    datamodel: 'Edit' | 'Client' | 'Server' = 'Edit',
  ): Promise<string> {
    const client = await this.#connected();
    const result = (await client.callTool(
      {
        name: 'execute_luau',
        arguments: { studio_id: studioId, datamodel_type: datamodel, code },
      },
      undefined,
      { timeout: this.#timeoutMs },
    )) as ToolResult;
    return firstText(result, 'execute_luau');
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client !== undefined) await client.close();
  }
}
