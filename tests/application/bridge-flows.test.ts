import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSnapshotStore, STAGING_PREFIX } from '../../src/adapters/fs-snapshot-store.js';
import { RobloxService, RobloxServiceError } from '../../src/application/roblox-service.js';
import { ExtractionError, SENTINEL } from '../../src/domain/extraction.js';
import type { AssetRecord, CleanupOutcome, StudioSnapshot } from '../../src/domain/contracts.js';
import type { OpenCloud } from '../../src/ports/open-cloud.js';
import type { CommittedSnapshot, SnapshotPlan, SnapshotStore } from '../../src/ports/snapshot-store.js';
import type { ConnectedStudio, StudioBridge } from '../../src/ports/studio-bridge.js';
import type { StudioHost } from '../../src/ports/studio-host.js';

/** 每個 payload 裡那把 buffer key。 */
function bufferKeyOf(code: string): string {
  const key = /RBXEXTRACT_[0-9a-f]{32}/.exec(code)?.[0];
  if (key === undefined) throw new Error(`payload has no buffer key: ${code.slice(0, 80)}`);
  return key;
}

/** 釋放 payload 的回傳以這個開頭；其他 payload 都不會出現這一句。 */
const RELEASE_MARKER = 'return "released';

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
    if (code.includes(RELEASE_MARKER)) {
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
    return bufferKeyOf(code);
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
    if (code.includes(RELEASE_MARKER)) {
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

/** 不碰磁碟的快照層：照名稱表的第一個名字記下每份腳本的內容。 */
class RecordingStore implements SnapshotStore {
  readonly written = new Map<string, string>();

  async commit(_outDir: string, plan: SnapshotPlan): Promise<CommittedSnapshot> {
    const files = plan.scripts.map((script) => script.target.path);
    for (const [i, script] of plan.scripts.entries()) this.written.set(files[i] ?? '', script.content);
    return { files, written: files };
  }
}

function keyedService(keyed: KeyedBridge, snapshots: SnapshotStore = new RecordingStore()): RobloxService {
  return new RobloxService({
    studio: noopHost,
    openCloud: noopCloud,
    version: '0.1.0',
    allowedUploadRoots: [],
    bridge: keyed,
    snapshots,
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
    const store = new RecordingStore();
    const written = store.written;
    const service = keyedService(keyed, store);
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
      const outcome = await keyedService(keyed, new FsSnapshotStore()).extractPlace({ placeId: '1', outDir });

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

type ScriptSpec = { path: string; className: string; source: string };

/** 用正式的快照層（composition 接的那個）抽一次，回傳 scripts.json 記下的實際路徑。 */
async function extractInto(
  outDir: string,
  scripts: readonly ScriptSpec[],
  store: SnapshotStore = new FsSnapshotStore(),
): Promise<string[]> {
  const keyed = new KeyedBridge(1);
  keyed.sliceCap = 60_000;
  keyed.stream = streamOf(scripts);
  await keyedService(keyed, store).extractPlace({ placeId: '1', outDir });
  const index = JSON.parse(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')) as {
    scripts: { path: string; file: string }[];
  };
  expect(index.scripts.map((entry) => entry.path)).toEqual(scripts.map((script) => script.path));
  return index.scripts.map((entry) => entry.file);
}

const missing = async (path: string): Promise<boolean> =>
  await lstat(path).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');

describe('🔴 extractPlace 不覆蓋任何既有檔案', () => {
  let base: string;
  let outDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-sidecar-extract-'));
    outDir = join(base, 'out');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('Σ、ς、σ 各寫一份：檔案系統把它們當成同名時也不互相覆蓋', async () => {
    // 'ς'.toLowerCase() 還是 'ς'，名稱表把它當成跟 σ 不同；不分大小寫的檔案系統卻當成同一個名字。
    // macOS 預設的 APFS 就是這種，所以這裡走的是真的撞名路徑。
    const scripts = [
      { path: 'ServerScriptService/Σ', className: 'ModuleScript', source: 'return "capital sigma"' },
      { path: 'ServerScriptService/ς', className: 'ModuleScript', source: 'return "final sigma"' },
      { path: 'ServerScriptService/σ', className: 'ModuleScript', source: 'return "small sigma"' },
    ];
    const files = await extractInto(outDir, scripts);
    for (const [i, file] of files.entries()) {
      expect(await readFile(join(outDir, file), 'utf8')).toBe(scripts[i]?.source);
    }
    expect(await readdir(join(outDir, 'src', 'ServerScriptService'))).toHaveLength(3);

    // 這個檔案系統把 ς 與 σ 當成同名時，名稱表的猜測撞到 EEXIST，改用下一個 ~n；不然就照名稱表。
    await writeFile(join(base, 'probe-ς'), '');
    const folds = !(await missing(join(base, 'probe-σ')));
    expect(files.map((file) => file.slice('src/ServerScriptService/'.length))).toEqual(
      folds ? ['Σ.luau', 'ς~2.luau', 'σ~3.luau'] : ['Σ.luau', 'ς.luau', 'σ~2.luau'],
    );
  });

  it('重跑到同一個輸出目錄：只換掉上一次自己寫的檔，別人的檔不刪也不蓋，檔名不會越跑越長', async () => {
    const first = await extractInto(outDir, [
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print("v1")' },
      { path: 'ServerScriptService/Old', className: 'ModuleScript', source: 'return "removed later"' },
      { path: 'ReplicatedStorage/Gone/Init', className: 'ModuleScript', source: 'return "folder removed later"' },
    ]);
    expect(first).toEqual([
      'src/ServerScriptService/Main.server.luau',
      'src/ServerScriptService/Old.luau',
      'src/ReplicatedStorage/Gone/Init.luau',
    ]);
    // 使用者自己放進來的檔：一個剛好跟下一次的腳本同名，一個無關。
    await writeFile(join(outDir, 'src', 'ServerScriptService', 'Notes.luau'), 'my notes');
    await writeFile(join(outDir, 'README.txt'), 'mine');

    const scripts = [
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print("v2")' },
      { path: 'ServerScriptService/Notes', className: 'ModuleScript', source: 'return "notes script"' },
    ];
    const second = await extractInto(outDir, scripts);
    expect(second).toEqual(['src/ServerScriptService/Main.server.luau', 'src/ServerScriptService/Notes~2.luau']);
    for (const [i, file] of second.entries()) {
      expect(await readFile(join(outDir, file), 'utf8')).toBe(scripts[i]?.source);
    }
    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Notes.luau'), 'utf8')).toBe('my notes');
    expect(await readFile(join(outDir, 'README.txt'), 'utf8')).toBe('mine');
    // 上一次寫的、這次沒有的腳本不留下來，空掉的資料夾也一樣。
    expect(await missing(join(outDir, 'src', 'ServerScriptService', 'Old.luau'))).toBe(true);
    expect(await missing(join(outDir, 'src', 'ReplicatedStorage'))).toBe(true);

    // 同一份再跑一次，結果一模一樣。
    expect(await extractInto(outDir, scripts)).toEqual(second);
  });

  it('scene/scripts.json 不是本工具寫的：拒絕，什麼都不動', async () => {
    await mkdir(join(outDir, 'scene'), { recursive: true });
    await writeFile(join(outDir, 'scene', 'scripts.json'), '{"owner":"someone else"}');
    await expect(
      extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]),
    ).rejects.toThrow(/scene\/scripts\.json/);
    expect(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')).toBe('{"owner":"someone else"}');
    expect(await missing(join(outDir, 'src'))).toBe(true);
  });

  it('manifest 列了 src/ 以外或穿越出去的路徑：整份不認，一個檔都不刪', async () => {
    await mkdir(join(outDir, 'scene'), { recursive: true });
    await mkdir(join(outDir, 'src'), { recursive: true });
    await writeFile(join(base, 'outside.luau'), 'outside');
    await writeFile(join(outDir, 'src', 'Keep.luau'), 'keep');
    const forged = {
      extractedBy: 'studio-sidecar extract_place (read-only)',
      scripts: [{ file: 'src/Keep.luau' }, { file: 'src/../../outside.luau' }],
    };
    await writeFile(join(outDir, 'scene', 'scripts.json'), JSON.stringify(forged));
    await expect(
      extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]),
    ).rejects.toThrow(/scene\/scripts\.json/);
    expect(await readFile(join(base, 'outside.luau'), 'utf8')).toBe('outside');
    expect(await readFile(join(outDir, 'src', 'Keep.luau'), 'utf8')).toBe('keep');
  });
});

/** outDir/src 底下所有檔案的相對路徑（`/` 分隔），排序過。 */
async function listSnapshotFiles(outDir: string): Promise<string[]> {
  const entries = await readdir(join(outDir, 'src'), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(outDir.length + 1).split(/[\\/]/).join('/'))
    .sort();
}

const stagingLeftovers = async (outDir: string): Promise<string[]> =>
  (await readdir(outDir)).filter((name) => name.startsWith(STAGING_PREFIX));

describe('🔴 新快照寫完才換掉上一次的', () => {
  let base: string;
  let outDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-sidecar-swap-'));
    outDir = join(base, 'out');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('寫到一半失敗時上一次的快照原樣留著，也不留暫存目錄', async () => {
    await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print("v1")' }]);
    const before = {
      main: await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8'),
      manifest: await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8'),
      place: await readFile(join(outDir, 'scene', 'place.json'), 'utf8'),
    };
    // 使用者在下一次需要資料夾的地方放了一個檔：寫到 ReplicatedStorage/Util 時一定失敗。
    await writeFile(join(outDir, 'src', 'ReplicatedStorage'), 'not a folder');

    await expect(
      extractInto(outDir, [
        { path: 'ServerScriptService/Main', className: 'Script', source: 'print("v2")' },
        { path: 'ReplicatedStorage/Util', className: 'ModuleScript', source: 'return {}' },
      ]),
    ).rejects.toThrow();

    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8')).toBe(before.main);
    expect(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')).toBe(before.manifest);
    expect(await readFile(join(outDir, 'scene', 'place.json'), 'utf8')).toBe(before.place);
    expect(await readFile(join(outDir, 'src', 'ReplicatedStorage'), 'utf8')).toBe('not a folder');
    expect(await listSnapshotFiles(outDir)).toEqual(['src/ReplicatedStorage', 'src/ServerScriptService/Main.server.luau']);
    expect(await stagingLeftovers(outDir)).toEqual([]);
  });

  it('成功後也不留暫存目錄', async () => {
    await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]);
    await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(2)' }]);
    expect(await stagingLeftovers(outDir)).toEqual([]);
    expect((await stat(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'))).nlink).toBe(1);
  });

  it('不支援硬連結的檔案系統改用獨佔建立，結果一樣', async () => {
    const noLinks = new FsSnapshotStore({
      link: async () => {
        throw Object.assign(new Error('hard links are not supported here'), { code: 'EPERM' });
      },
    });
    const scripts = [
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print("v1")' },
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print("twin")' },
    ];
    expect(await extractInto(outDir, scripts, noLinks)).toEqual([
      'src/ServerScriptService/Main.server.luau',
      'src/ServerScriptService/Main~2.server.luau',
    ]);
    const again = await extractInto(outDir, [scripts[0] as ScriptSpec], noLinks);
    expect(again).toEqual(['src/ServerScriptService/Main.server.luau']);
    expect(await listSnapshotFiles(outDir)).toEqual(['src/ServerScriptService/Main.server.luau']);
    expect(await stagingLeftovers(outDir)).toEqual([]);
  });
});

describe('🔴 同一個輸出目錄的抽取依序進行', () => {
  it('同時抽兩次：最後只有一份快照，scripts.json 列的就是磁碟上的全部，沒有 ~2', async () => {
    const base = await mkdtemp(join(tmpdir(), 'studio-sidecar-queue-'));
    const outDir = join(base, 'out');
    try {
      const store = new FsSnapshotStore();
      const run = (source: string): Promise<unknown> => {
        const keyed = new KeyedBridge(1);
        keyed.sliceCap = 60_000;
        keyed.stream = streamOf([
          { path: 'ServerScriptService/Main', className: 'Script', source },
          { path: 'ReplicatedStorage/Util', className: 'ModuleScript', source: `return "${source}"` },
        ]);
        return keyedService(keyed, store).extractPlace({ placeId: '1', outDir });
      };
      const results = await Promise.allSettled([run('first'), run('second')]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

      const index = JSON.parse(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')) as {
        scripts: { file: string }[];
      };
      const listed = index.scripts.map((entry) => entry.file).sort();
      expect(listed).toEqual(['src/ReplicatedStorage/Util.luau', 'src/ServerScriptService/Main.server.luau']);
      expect(await listSnapshotFiles(outDir)).toEqual(listed);
      // 兩份腳本來自同一次抽取。
      const main = await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8');
      expect(await readFile(join(outDir, 'src', 'ReplicatedStorage', 'Util.luau'), 'utf8')).toBe(`return "${main}"`);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('extractPlace 遇到硬連結', () => {
  let base: string;
  let outDir: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-sidecar-hardlink-'));
    outDir = join(base, 'out');
    outside = join(base, 'outside.txt');
    await writeFile(outside, 'keep me');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('上一次的檔被換成指到外面的硬連結：只拿掉這個名字，外面的內容不變，新檔是另一個檔案', async () => {
    const [first] = await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]);
    const target = join(outDir, ...(first ?? '').split('/'));
    await rm(target);
    await link(outside, target);

    await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(2)' }]);
    expect(await readFile(outside, 'utf8')).toBe('keep me');
    expect((await stat(outside)).nlink).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('print(2)');
    expect((await stat(target)).nlink).toBe(1);
  });

  it('別人的硬連結占著名字：不寫進去，新的腳本改用 ~2', async () => {
    await mkdir(join(outDir, 'src', 'ServerScriptService'), { recursive: true });
    await link(outside, join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'));

    const files = await extractInto(outDir, [{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]);
    expect(files).toEqual(['src/ServerScriptService/Main~2.server.luau']);
    expect(await readFile(outside, 'utf8')).toBe('keep me');
    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8')).toBe('keep me');
  });
});

/** 第一次釋放失敗的假橋；記下每一把建立與釋放過的 key。 */
class FlakyReleaseBridge extends FakeBridge {
  failReleases = 1;
  releaseAttempts = 0;
  readonly created: string[] = [];
  readonly released: string[] = [];

  override async executeLuau(studioId: string, code: string): Promise<string> {
    if (code.includes(RELEASE_MARKER)) {
      this.releaseAttempts += 1;
      if (this.failReleases > 0) {
        this.failReleases -= 1;
        throw new Error('execute_luau timed out');
      }
      this.released.push(bufferKeyOf(code));
    } else if (code.includes('!!LUAU_ERROR!!')) {
      this.created.push(bufferKeyOf(code));
    }
    return await super.executeLuau(studioId, code);
  }
}

describe('🔴 釋放失敗的 buffer 不會一直留著', () => {
  function flakyService(flaky: FlakyReleaseBridge, logs: string[] = []): RobloxService {
    return new RobloxService({
      studio: noopHost,
      openCloud: noopCloud,
      version: '0.1.0',
      allowedUploadRoots: [],
      bridge: flaky,
      log: (level, message) => {
        logs.push(`${level}: ${message}`);
      },
    });
  }

  it('下一次呼叫碰到同一個 Studio 時補釋放', async () => {
    const flaky = new FlakyReleaseBridge();
    const service = flakyService(flaky);
    await service.runLuau({ placeId: '1', code: 'return "x"' });
    expect(flaky.released).toEqual([]);

    await service.runLuau({ placeId: '1', code: 'return "y"' });
    expect(flaky.created).toHaveLength(2);
    expect([...flaky.released].sort()).toEqual([...flaky.created].sort());
  });

  it('一直釋放不掉就在幾次之後放手，不會每次呼叫都重試下去', async () => {
    const flaky = new FlakyReleaseBridge();
    flaky.failReleases = Number.POSITIVE_INFINITY;
    const logs: string[] = [];
    const service = flakyService(flaky, logs);
    await service.runLuau({ placeId: '1', code: 'return "x"' });
    for (let i = 0; i < 6; i += 1) await service.guardPlace('1');
    // 呼叫結束時一次，之後補兩次，然後放手。
    expect(flaky.releaseAttempts).toBe(3);
    expect(logs.filter((line) => /gave up/.test(line))).toHaveLength(1);
  });

  it('那個 Studio 不在連線清單裡了就不再補', async () => {
    const flaky = new FlakyReleaseBridge();
    const service = flakyService(flaky);
    await service.runLuau({ placeId: '1', code: 'return "x"' });
    flaky.studios = [{ id: 's3', name: 'Reopened' }];
    flaky.matching = 's3';
    await service.guardPlace('1');
    flaky.studios = [{ id: 's2', name: 'Target' }];
    flaky.matching = 's2';
    await service.guardPlace('1');
    expect(flaky.released).toEqual([]);
  });
});
