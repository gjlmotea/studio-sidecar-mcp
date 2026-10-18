import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { RobloxService, RobloxServiceError } from '../../src/application/roblox-service.js';
import { writeIntoOutDir } from '../../src/composition.js';
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

/** 照 extraction 的格式組出腳本資料流。 */
function streamOf(scripts: readonly { path: string; className: string; source: string }[]): string {
  return scripts
    .map((s) => `<<<RBXFILE|${s.path}|${s.className}|${Buffer.byteLength(s.source, 'utf8')}>>>\n${s.source}`)
    .join('\n');
}

/**
 * 每個 `shared.<key>` 各存一份狀態的假橋，並刻意讓呼叫交錯：
 * 要等 `expectedCreates` 個呼叫都建好 buffer 才一起往下切片，每一步都先讓出執行權。
 */
class KeyedBridge implements StudioBridge {
  readonly buffers = new Map<string, string>();
  readonly keys = { create: [] as string[], slice: [] as string[], release: [] as string[] };
  stream = '';
  sliceCap = 2;
  readonly #expectedCreates: number;
  #creates = 0;
  #open: () => void = () => undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });

  constructor(expectedCreates: number) {
    this.#expectedCreates = expectedCreates;
  }

  static keyOf(code: string): string {
    const match = /shared(?:\.([A-Za-z_]\w*)|\[\s*"([^"]+)"\s*\])/.exec(code);
    const key = match?.[1] ?? match?.[2];
    if (key === undefined) throw new Error(`payload has no shared buffer key: ${code.slice(0, 80)}`);
    return key;
  }

  async listStudios(): Promise<readonly ConnectedStudio[]> {
    return [{ id: 's1', name: 'Target' }];
  }

  async executeLuau(_studioId: string, code: string): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (code.includes('match=')) return `placeId=1 expected=1 match=true gameId=99${SENTINEL}`;
    if (code.includes('JSONEncode')) return `{"placeId":1}${SENTINEL}`;
    if (code.includes('<<<AT|')) {
      const key = KeyedBridge.keyOf(code);
      this.keys.slice.push(key);
      const text = this.buffers.get(key);
      if (text === undefined) return `<<<AT|0>>>${SENTINEL}`;
      const start = Number.parseInt(/local start = (\d+)/.exec(code)?.[1] ?? '1', 10);
      const bytes = Buffer.from(text, 'utf8');
      const end = Math.min(start + this.sliceCap - 1, bytes.length);
      return `<<<AT|${end}>>>${bytes.subarray(start - 1, end).toString('utf8')}${SENTINEL}`;
    }
    if (code.includes('= nil')) {
      const key = KeyedBridge.keyOf(code);
      this.keys.release.push(key);
      this.buffers.delete(key);
      return `released${SENTINEL}`;
    }
    const isStream = code.includes('RBXFILE');
    if (isStream || code.includes('pcall(function()')) {
      const key = KeyedBridge.keyOf(code);
      this.keys.create.push(key);
      const text = isStream ? this.stream : (/return "([^"]*)"/.exec(code)?.[1] ?? '');
      this.buffers.set(key, text);
      this.#creates += 1;
      if (this.#creates >= this.#expectedCreates) this.#open();
      await this.#gate;
      const bytes = Buffer.byteLength(text, 'utf8');
      return isStream
        ? `bytes=${bytes} count=${text.split('<<<RBXFILE|').length - 1}${SENTINEL}`
        : `ok=true bytes=${bytes}${SENTINEL}`;
    }
    return `unhandled${SENTINEL}`;
  }

  async close(): Promise<void> {}
}

type OutDirWriter = (outDir: string, relativePath: string, content: string) => Promise<string>;

function keyedService(
  keyed: KeyedBridge,
  writeFile: OutDirWriter = async (_outDir, relativePath) => relativePath,
): RobloxService {
  return new RobloxService({
    studio: noopHost,
    openCloud: noopCloud,
    version: '0.1.0',
    allowedUploadRoots: [],
    bridge: keyed,
    writeFile,
  });
}

function settledValue<T>(result: PromiseSettledResult<T>): T | string {
  return result.status === 'fulfilled' ? result.value : `rejected: ${String(result.reason)}`;
}

describe('🔴 重疊的呼叫各用各的 Lua buffer', () => {
  it('兩個重疊的 runLuau 各自拿回自己的結果', async () => {
    const keyed = new KeyedBridge(2);
    const service = keyedService(keyed);
    const results = await Promise.allSettled([
      service.runLuau({ placeId: '1', code: 'return "alpha"' }),
      service.runLuau({ placeId: '1', code: 'return "omega"' }),
    ]);
    const values = results.map(settledValue);
    expect(values.map((v) => (typeof v === 'string' ? v : v.result))).toEqual(['alpha', 'omega']);
    // 建立、切片、釋放都帶同一把 key；兩個呼叫的 key 不同；用完全部釋放。
    expect(new Set(keyed.keys.create).size).toBe(2);
    expect(new Set([...keyed.keys.slice, ...keyed.keys.release])).toEqual(new Set(keyed.keys.create));
    expect(keyed.keys.release).toHaveLength(2);
    expect(keyed.buffers.size).toBe(0);
  });

  it('extractPlace 與 runLuau 重疊時互不污染', async () => {
    const keyed = new KeyedBridge(2);
    keyed.sliceCap = 7;
    keyed.stream = streamOf([
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print("main")' },
      { path: 'ReplicatedStorage/Util', className: 'ModuleScript', source: 'return {}' },
    ]);
    const written = new Map<string, string>();
    const service = keyedService(keyed, async (_outDir, relativePath, content) => {
      written.set(relativePath, content);
      return relativePath;
    });
    const [extract, run] = await Promise.allSettled([
      service.extractPlace({ placeId: '1', outDir: 'out' }),
      service.runLuau({ placeId: '1', code: 'return "alpha"' }),
    ]);
    expect(settledValue(run)).toMatchObject({ ok: true, result: 'alpha' });
    expect(settledValue(extract)).toMatchObject({ scriptCount: 2 });
    expect(written.get('src/ServerScriptService/Main.server.luau')).toBe('print("main")');
    expect(written.get('src/ReplicatedStorage/Util.luau')).toBe('return {}');
  });
});

describe('🔴 extractPlace 的檔名碰撞', () => {
  it('清理後同名、只差大小寫、兄弟同名都各寫一份，scripts.json 記的是實際寫入的路徑', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'roblox-mcp-extract-'));
    try {
      const scripts = [
        { path: 'ServerScriptService/A:B', className: 'Script', source: 'print("colon")' },
        { path: 'ServerScriptService/A?B', className: 'Script', source: 'print("question")' },
        { path: 'ServerScriptService/Foo', className: 'ModuleScript', source: 'return "upper"' },
        { path: 'ServerScriptService/foo', className: 'ModuleScript', source: 'return "lower"' },
        { path: 'ServerScriptService/Main', className: 'Script', source: 'print("first")' },
        { path: 'ServerScriptService/Main', className: 'Script', source: 'print("second")' },
        { path: 'ReplicatedStorage/X:Y/Init', className: 'LocalScript', source: 'print("xy colon")' },
        { path: 'ReplicatedStorage/X?Y/Init', className: 'LocalScript', source: 'print("xy question")' },
      ];
      const keyed = new KeyedBridge(1);
      keyed.sliceCap = 60_000;
      keyed.stream = streamOf(scripts);
      const outcome = await keyedService(keyed, writeIntoOutDir).extractPlace({ placeId: '1', outDir });

      const index = JSON.parse(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')) as {
        scripts: { path: string; file: string }[];
      };
      const files = index.scripts.map((entry) => entry.file);
      // 名稱表在大小寫不敏感的檔案系統上也不能撞。
      expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(scripts.length);
      // 每一筆都讀得回自己的原始碼。
      for (const [i, entry] of index.scripts.entries()) {
        expect(await readFile(join(outDir, entry.file), 'utf8')).toBe(scripts[i]?.source);
      }
      expect(new Set(outcome.written).size).toBe(outcome.written.length);
      // 後綴照資料流順序給，同一份 place 每次抽出來的檔名一樣。
      expect(files).toEqual([
        'src/ServerScriptService/A_B.server.luau',
        'src/ServerScriptService/A_B~2.server.luau',
        'src/ServerScriptService/Foo.luau',
        'src/ServerScriptService/foo~2.luau',
        'src/ServerScriptService/Main.server.luau',
        'src/ServerScriptService/Main~2.server.luau',
        'src/ReplicatedStorage/X_Y/Init.client.luau',
        'src/ReplicatedStorage/X_Y~2/Init.client.luau',
      ]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
