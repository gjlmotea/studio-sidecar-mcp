import { beforeEach, describe, expect, it } from 'vitest';

import { RobloxService, RobloxServiceError } from '../../src/application/roblox-service.js';
import { ExtractionError, SENTINEL } from '../../src/domain/extraction.js';
import type { AssetRecord, CleanupOutcome, StudioSnapshot } from '../../src/domain/contracts.js';
import type { OpenCloud } from '../../src/ports/open-cloud.js';
import type { ConnectedStudio, StudioBridge } from '../../src/ports/studio-bridge.js';
import type { StudioHost } from '../../src/ports/studio-host.js';

/** 假橋：照 Luau 內容決定要回什麼，並記錄有沒有被關閉。 */
class FakeBridge implements StudioBridge {
  closed = 0;
  calls: string[] = [];
  buffer = '';
  studios: readonly ConnectedStudio[] = [
    { id: 's1', name: 'Other' },
    { id: 's2', name: 'Target' },
  ];
  /** 哪一個 studio 的 placeId 相符。 */
  matching = 's2';
  /** 使用者程式碼是否拋錯。 */
  userThrows = false;
  /** 每次切片最多給幾個位元組（模擬 Lua 端的 UTF-8 邊界調整）。 */
  sliceCap = 70_000;

  async listStudios(): Promise<readonly ConnectedStudio[]> {
    this.calls.push('listStudios');
    return this.studios;
  }

  async executeLuau(studioId: string, code: string): Promise<string> {
    if (code.includes('match=')) {
      this.calls.push(`guard:${studioId}`);
      const match = studioId === this.matching;
      return `placeId=1 expected=1 match=${match} gameId=99${SENTINEL}`;
    }
    if (code.includes('pcall(function()')) {
      this.calls.push('run');
      this.buffer = this.userThrows ? '!!LUAU_ERROR!! boom' : 'the result';
      const ok = !this.userThrows;
      return `ok=${ok} bytes=${Buffer.byteLength(this.buffer, 'utf8')}${SENTINEL}`;
    }
    if (code.includes('<<<AT|')) {
      this.calls.push('slice');
      const start = Number.parseInt(/local start = (\d+)/.exec(code)?.[1] ?? '1', 10);
      const bytes = Buffer.from(this.buffer, 'utf8');
      const end = Math.min(start + this.sliceCap - 1, bytes.length);
      const payload = bytes.subarray(start - 1, end).toString('utf8');
      return `<<<AT|${end}>>>${payload}${SENTINEL}`;
    }
    if (code.includes('= nil')) {
      this.calls.push('release');
      this.buffer = '';
      return `released${SENTINEL}`;
    }
    this.calls.push('other');
    return `unhandled${SENTINEL}`;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

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

let bridge: FakeBridge;

function makeService(): RobloxService {
  return new RobloxService({
    studio: noopHost,
    openCloud: noopCloud,
    version: '0.1.0',
    allowedUploadRoots: [],
    bridge,
    writeFile: async (_outDir, relativePath) => relativePath,
  });
}

beforeEach(() => {
  bridge = new FakeBridge();
});

describe('guardPlace', () => {
  it('找出 placeId 相符的那一個實例', async () => {
    const result = await makeService().guardPlace('1');
    expect(result.studioId).toBe('s2');
    expect(result.studioName).toBe('Target');
    expect(result.gameId).toBe('99');
  });

  it('🔴 沒有相符的就中止 —— 認錯 place 會覆蓋別的遊戲', async () => {
    bridge.matching = 'nobody';
    await expect(makeService().guardPlace('1')).rejects.toThrow(RobloxServiceError);
  });

  it('沒有連線中的 Studio 時給出可行動的訊息', async () => {
    bridge.studios = [];
    await expect(makeService().guardPlace('1')).rejects.toThrow(/roblox_open_place/);
  });

  it('🔴 呼叫結束不關橋 —— 關掉會殺死 stub，下一次呼叫就會 reach 不到 Studio', async () => {
    // 第一版每次呼叫完就 close，症狀是「第一次成功、後續全失敗」：
    // broker 還在收拾被殺掉的那隻 stub，新生的那隻問它就得到 Unable to reach。
    await makeService().guardPlace('1');
    expect(bridge.closed).toBe(0);
  });

  it('橋由 closeBridge() 在關機時收，不是每次呼叫', async () => {
    const service = makeService();
    await service.guardPlace('1');
    await service.closeBridge();
    expect(bridge.closed).toBe(1);
  });
});

describe('runLuau', () => {
  it('取回結果並回報分塊數', async () => {
    const result = await makeService().runLuau({ placeId: '1', code: 'return "x"' });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('the result');
    expect(result.chunks).toBe(1);
  });

  it('使用者程式碼拋錯時回 ok=false 並剝掉錯誤前綴', async () => {
    // execute_luau 沒有 RobloxScript capability，碰到受保護屬性會整段中止；
    // 包 pcall 之後錯誤變成可讀的回傳值而不是整個呼叫失敗。
    bridge.userThrows = true;
    const result = await makeService().runLuau({ placeId: '1', code: 'return game.X' });
    expect(result.ok).toBe(false);
    expect(result.result).toBe('boom');
  });

  it('超過單塊上限時分多次取回並組回原樣', async () => {
    bridge.sliceCap = 4;
    const result = await makeService().runLuau({ placeId: '1', code: 'x' });
    expect(result.result).toBe('the result'); // 10 bytes / 4 = 3 塊
    expect(result.chunks).toBe(3);
  });

  it('用完會釋放 buffer，但橋留著', async () => {
    await makeService().runLuau({ placeId: '1', code: 'x' });
    expect(bridge.calls).toContain('release');
    expect(bridge.closed).toBe(0);
  });

  it('placeId 對不上時不執行任何程式碼', async () => {
    bridge.matching = 'nobody';
    await expect(makeService().runLuau({ placeId: '1', code: 'x' })).rejects.toThrow();
    expect(bridge.calls).not.toContain('run');
  });
});

describe('切片不前進時的保護', () => {
  it('🔴 endOffset 沒有前進就中止，不要無窮迴圈', async () => {
    // Lua 端的 buffer 被別人清掉時會回 <<<AT|0>>>，若不擋就會永遠切下去。
    class StuckBridge extends FakeBridge {
      override async executeLuau(studioId: string, code: string): Promise<string> {
        if (code.includes('<<<AT|')) return `<<<AT|0>>>${SENTINEL}`;
        return await super.executeLuau(studioId, code);
      }
    }
    bridge = new StuckBridge();
    await expect(makeService().runLuau({ placeId: '1', code: 'x' })).rejects.toThrow(ExtractionError);
  });
});
