import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  StudioBridgeClosedError,
  StudioBridgeError,
  type ConnectedStudio,
  type StudioBridge,
} from '../ports/studio-bridge.js';

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
    throw new StudioBridgeError(`${context}: the response has no text content.`);
  }
  if (result.isError === true) {
    throw new StudioBridgeError(`${context}: ${text}`);
  }
  return text;
}

/** 橋只用到 client 的這兩個方法；測試注入假的。 */
export type BridgeClient = {
  callTool(
    params: { readonly name: string; readonly arguments: Record<string, unknown> },
    resultSchema: undefined,
    options: { readonly timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
};

/**
 * 開始一條連線。client 立刻交回（握手途中也要能 close 它），`ready` 在握手完成時 resolve。
 */
export type BridgeConnector = () => { readonly client: BridgeClient; readonly ready: Promise<void> };

/** 正式執行時的連線方式：把 StudioMCP 當子行程啟動，以 MCP client 身分連上。 */
function stdioConnector(
  override: { command: string; args: readonly string[] } | undefined,
  version: string,
): BridgeConnector {
  return () => {
    const launch = override ?? resolveBridgeCommand();
    if (launch === undefined) {
      throw new StudioBridgeError(
        'StudioMCP executable not found; make sure Roblox Studio is installed. '
        + '(On Windows it looks for %LOCALAPPDATA%\\Roblox\\mcp.bat; on macOS, for StudioMCP inside RobloxStudio.app.)',
      );
    }
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      stderr: 'pipe',
      env: getDefaultEnvironment(),
    });
    const client = new Client({ name: 'studio-sidecar-bridge', version });
    return { client, ready: client.connect(transport) };
  };
}

/**
 * 一個 server 只開一條 StudioMCP 連線，關機之後不再開。
 *
 * 🔴 三個競爭都會留下沒人收的 StudioMCP 子行程（stub）：
 * - 兩個呼叫同時第一次連線，各開一條，close 只收得到其中一條 —— 所以握手中的連線共用 `#connecting`。
 * - close 時還在握手的那條，握手完成後就沒人收了 —— 所以 close 連它一起收，並等它結束。
 * - 關機後還在跑的呼叫（例如 runLuau 的 finally 要釋放 buffer）又把橋接回來 ——
 *   所以 closing／closed 之後一律拒絕連線，丟 `StudioBridgeClosedError`。
 */
export class McpStudioBridge implements StudioBridge {
  #state: 'open' | 'closing' | 'closed' = 'open';
  /** 握手完成的連線。 */
  #client: BridgeClient | undefined;
  /** 握手中的連線；close 要拿得到它才收得掉。 */
  #pending: BridgeClient | undefined;
  /** 進行中的握手，同時第一次連線的呼叫都等這一個。 */
  #connecting: Promise<BridgeClient> | undefined;
  #closing: Promise<void> | undefined;
  readonly #connect: BridgeConnector;
  readonly #timeoutMs: number;
  readonly #readyTimeoutMs: number;

  constructor(options: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
    /** 等 stub 連上 broker 的上限。實測冷啟動約需數秒。 */
    readonly readyTimeoutMs?: number;
    /** 測試用；正式執行時啟動 StudioMCP 子行程。 */
    readonly connect?: BridgeConnector;
    /** 對 StudioMCP 自報的 client 版本，跟著本 server 的版本走。 */
    readonly version?: string;
  } = {}) {
    this.#connect = options.connect ?? stdioConnector(
      options.command === undefined ? undefined : { command: options.command, args: options.args ?? [] },
      options.version ?? '0.0.0',
    );
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
  }

  async #connected(): Promise<BridgeClient> {
    if (this.#state !== 'open') throw new StudioBridgeClosedError();
    if (this.#client !== undefined) return this.#client;
    if (this.#connecting === undefined) {
      const attempt: Promise<BridgeClient> = this.#open().finally(() => {
        if (this.#connecting === attempt) this.#connecting = undefined;
      });
      this.#connecting = attempt;
    }
    return await this.#connecting;
  }

  async #open(): Promise<BridgeClient> {
    const { client, ready } = this.#connect();
    this.#pending = client;
    let failure: { readonly error: unknown } | undefined;
    try {
      await ready;
    } catch (error) {
      failure = { error };
    }
    // close() 在握手途中把它拿走了：收它是 close() 的事，這裡只回報已關閉。
    if (this.#pending !== client) throw new StudioBridgeClosedError();
    this.#pending = undefined;
    if (failure !== undefined) {
      await client.close().catch(() => undefined);
      throw failure.error;
    }
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
      throw new StudioBridgeError(`list_roblox_studios response is not JSON: ${text.slice(0, 120)}`);
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

  /** 收掉連線（包括還在握手的那條）。可以重複呼叫；之後的呼叫一律拒絕。 */
  async close(): Promise<void> {
    if (this.#closing === undefined) {
      this.#state = 'closing';
      this.#closing = this.#shutdown().finally(() => {
        this.#state = 'closed';
      });
    }
    await this.#closing;
  }

  async #shutdown(): Promise<void> {
    const clients = [this.#client, this.#pending].filter((client) => client !== undefined);
    const connecting = this.#connecting;
    this.#client = undefined;
    this.#pending = undefined;
    const results = await Promise.allSettled(clients.map(async (client) => await client.close()));
    // 等握手那一段真的結束，close 回來時就不會還有連線在半路上。
    await connecting?.catch(() => undefined);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}
