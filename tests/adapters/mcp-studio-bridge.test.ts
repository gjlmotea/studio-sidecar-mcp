import { describe, expect, it } from 'vitest';

import {
  McpStudioBridge,
  type BridgeClient,
  type BridgeConnector,
} from '../../src/adapters/mcp-studio-bridge.js';
import { RobloxService } from '../../src/application/roblox-service.js';
import type { AssetRecord, CleanupOutcome, StudioSnapshot } from '../../src/domain/contracts.js';
import { SENTINEL } from '../../src/domain/extraction.js';
import type { OpenCloud } from '../../src/ports/open-cloud.js';
import type { StudioHost } from '../../src/ports/studio-host.js';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 沒人等的那一份被 reject 時不要變成 unhandled rejection；等它的人照樣拿得到錯誤。
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

type Answer = (name: string, args: Record<string, unknown>) => string | Promise<string>;

/**
 * 假的 MCP client，行為照 SDK：close 會讓還沒完成的握手與進行中的呼叫以 Connection closed 失敗。
 */
class FakeClient implements BridgeClient {
  closed = 0;
  readonly handshake = deferred();
  readonly #inFlight = new Set<(error: Error) => void>();
  readonly #answer: Answer;

  constructor(answer: Answer) {
    this.#answer = answer;
  }

  async callTool(params: { readonly name: string; readonly arguments: Record<string, unknown> }): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      this.#inFlight.add(reject);
      Promise.resolve(this.#answer(params.name, params.arguments)).then(
        (text) => {
          this.#inFlight.delete(reject);
          resolve({ content: [{ type: 'text', text }] });
        },
        (error: unknown) => {
          this.#inFlight.delete(reject);
          reject(error);
        },
      );
    });
  }

  async close(): Promise<void> {
    this.closed += 1;
    const error = new Error('Connection closed');
    this.handshake.reject(error);
    for (const reject of this.#inFlight) reject(error);
    this.#inFlight.clear();
  }
}

/** 記下每一條開過的連線。握手預設在下一個 tick 完成，跟真的一樣是非同步的。 */
function fakeConnector(answer: Answer, options: { readonly autoReady?: boolean } = {}): {
  readonly made: FakeClient[];
  readonly connect: BridgeConnector;
} {
  const made: FakeClient[] = [];
  const connect: BridgeConnector = () => {
    const client = new FakeClient(answer);
    made.push(client);
    if (options.autoReady !== false) setTimeout(() => client.handshake.resolve(), 0);
    return { client, ready: client.handshake.promise };
  };
  return { made, connect };
}

const noStudios: Answer = () => JSON.stringify({ studios: [] });

const tick = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 0));

describe('🔴 McpStudioBridge 的連線與關閉競爭', () => {
  it('兩個同時第一次連線的呼叫共用同一條連線，close 收掉它', async () => {
    const { made, connect } = fakeConnector(noStudios);
    const bridge = new McpStudioBridge({ connect });

    await Promise.all([bridge.listStudios(), bridge.listStudios()]);
    expect(made).toHaveLength(1);

    // 關機流程可能同時從好幾個訊號進來；close 重複呼叫也只收一次。
    await Promise.all([bridge.close(), bridge.close()]);
    await bridge.close();
    expect(made.map((client) => client.closed)).toEqual([1]);
  });

  it('握手途中 close：那條連線也被收掉，等著它的呼叫拿到明確的錯誤', async () => {
    const { made, connect } = fakeConnector(noStudios, { autoReady: false });
    const bridge = new McpStudioBridge({ connect });

    const pending = bridge.listStudios();
    await tick();
    expect(made).toHaveLength(1);

    const closing = bridge.close();
    // 最壞的時序：握手剛好在 close 之後才回來。
    made[0]?.handshake.resolve();
    await closing;

    await expect(pending).rejects.toThrow(/shut down/);
    expect(made).toHaveLength(1);
    expect(made[0]?.closed).toBe(1);
  });

  it('close 之後不再連線：呼叫直接被拒絕，不會再生一隻 StudioMCP', async () => {
    const { made, connect } = fakeConnector(noStudios);
    const bridge = new McpStudioBridge({ connect });
    await bridge.listStudios();
    await bridge.close();

    await expect(bridge.executeLuau('s1', 'return 1')).rejects.toThrow(/shut down/);
    await expect(bridge.listStudios()).rejects.toThrow(/shut down/);
    expect(made).toHaveLength(1);
  });
});

const noopHost: StudioHost = {
  executablePath: undefined,
  async snapshot(): Promise<StudioSnapshot> {
    return { studios: [], mcpProcesses: [], brokerPid: undefined, brokerPort: 0 };
  },
  async launch() { return 0; },
  async isConnectedToBroker() { return false; },
  async windowTitle() { return undefined; },
  async isAlive() { return false; },
  async terminate(): Promise<CleanupOutcome['failures']> { return []; },
};

const noopCloud: OpenCloud = {
  configured: false,
  async get(): Promise<AssetRecord> { throw new Error('n/a'); },
  async create(): Promise<AssetRecord> { throw new Error('n/a'); },
  async updateContent(): Promise<AssetRecord> { throw new Error('n/a'); },
  async updateMetadata(): Promise<AssetRecord> { throw new Error('n/a'); },
  async archive(): Promise<AssetRecord> { throw new Error('n/a'); },
  async restore(): Promise<AssetRecord> { throw new Error('n/a'); },
};

describe('🔴 關機時正在跑的 runLuau', () => {
  it('釋放 buffer 那一步跳過並記一行，不會為了它重開一條橋', async () => {
    const runStarted = deferred();
    const { made, connect } = fakeConnector((name, args) => {
      if (name === 'list_roblox_studios') return JSON.stringify({ studios: [{ id: 's1', name: 'Target' }] });
      const code = String(args['code']);
      if (code.includes('match=')) return `placeId=1 expected=1 match=true gameId=99${SENTINEL}`;
      if (code.includes('= nil')) return `released${SENTINEL}`;
      // 使用者的程式碼還在跑，直到連線被關掉。
      runStarted.resolve();
      return new Promise<string>(() => undefined);
    });
    const logs: string[] = [];
    const service = new RobloxService({
      studio: noopHost,
      openCloud: noopCloud,
      version: '0.1.0',
      allowedUploadRoots: [],
      bridge: new McpStudioBridge({ connect }),
      log: (level, message) => {
        logs.push(`${level}: ${message}`);
      },
    });

    const run = service.runLuau({ placeId: '1', code: 'return "x"' });
    await runStarted.promise;
    await service.closeBridge();

    await expect(run).rejects.toThrow(/Connection closed/);
    expect(made).toHaveLength(1);
    expect(made[0]?.closed).toBe(1);
    expect(logs).toEqual([expect.stringMatching(/Luau buffer.*shut down/)]);
  });
});
