import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { RobloxService, RobloxServiceError } from '../../src/application/roblox-service.js';
import type { AssetRecord, CleanupOutcome, StudioSnapshot } from '../../src/domain/contracts.js';
import type { OpenCloud } from '../../src/ports/open-cloud.js';
import type { StudioHost } from '../../src/ports/studio-host.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

class FakeStudioHost implements StudioHost {
  executablePath: string | undefined = 'C:\\Roblox\\RobloxStudioBeta.exe';
  launched: readonly string[][] = [];
  /** 第幾次輪詢開始回報已連上 broker；Infinity＝永遠不連。 */
  connectsAfterPolls = 1;
  alive = true;
  terminated: number[] = [];
  failures: CleanupOutcome['failures'] = [];
  #polls = 0;

  snapshotValue: StudioSnapshot = {
    studios: [],
    mcpProcesses: [],
    brokerPid: 100,
    brokerPort: 13469,
  };

  async snapshot(): Promise<StudioSnapshot> {
    return this.snapshotValue;
  }

  async launch(args: readonly string[]): Promise<number> {
    this.launched = [...this.launched, [...args]];
    return 4242;
  }

  async isConnectedToBroker(): Promise<boolean> {
    this.#polls += 1;
    return this.#polls >= this.connectsAfterPolls;
  }

  async windowTitle(): Promise<string | undefined> {
    return 'sample-game - Roblox Studio';
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async terminate(pids: readonly number[]): Promise<CleanupOutcome['failures']> {
    this.terminated = [...this.terminated, ...pids];
    return this.failures;
  }
}

function record(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    assetId: '100000000000001',
    displayName: 'ProbeCube',
    description: '',
    assetType: 'Model',
    revisionId: '1',
    revisionCreateTime: iso(0),
    creatorUserId: '1000000001',
    moderationState: 'Approved',
    state: 'Active',
    ...overrides,
  };
}

class FakeOpenCloud implements OpenCloud {
  configured = true;
  current: AssetRecord = record();
  next: AssetRecord | undefined;
  calls: string[] = [];

  async get(): Promise<AssetRecord> {
    this.calls.push('get');
    return this.current;
  }

  async create(): Promise<AssetRecord> {
    this.calls.push('create');
    return this.current;
  }

  async updateContent(): Promise<AssetRecord> {
    this.calls.push('updateContent');
    return this.next ?? this.current;
  }

  async updateMetadata(): Promise<AssetRecord> {
    this.calls.push('updateMetadata');
    return this.current;
  }

  async archive(): Promise<AssetRecord> {
    this.calls.push('archive');
    return record({ state: 'Archived' });
  }

  async restore(): Promise<AssetRecord> {
    this.calls.push('restore');
    return record({ state: 'Active' });
  }
}

let studio: FakeStudioHost;
let openCloud: FakeOpenCloud;
let workDir: string;
let fbxPath: string;
/**
 * 虛擬時鐘。
 *
 * 必須讓注入的 sleep 推進它 —— openPlace 的逾時是拿 now() 相減判斷的，
 * 時鐘不動就永遠不會逾時，測試會變成無窮迴圈（第一版就是這樣掛住的）。
 */
let clock: number;

async function makeService(uploadRoots: readonly string[]): Promise<RobloxService> {
  return new RobloxService({
    studio,
    openCloud,
    version: '0.1.0',
    allowedUploadRoots: uploadRoots,
    defaultCreatorUserId: '1000000001',
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
}

beforeEach(async () => {
  studio = new FakeStudioHost();
  openCloud = new FakeOpenCloud();
  clock = NOW;
  workDir = await mkdtemp(join(tmpdir(), 'roblox-mcp-test-'));
  fbxPath = join(workDir, 'cube.fbx');
  await writeFile(fbxPath, '; fbx');
});

describe('openPlace', () => {
  it('把啟動意圖以陣列交給 host，不自己拼命令列', async () => {
    const service = await makeService([]);
    await service.openPlace({ placeId: '100000000000002', universeId: '10000000003' });
    expect(studio.launched[0]).toEqual([
      '-launchIntentString',
      '{"task":"EditPlace","universeid":"10000000003","placeid":"100000000000002"}',
    ]);
  });

  it('連上 broker 就回報 connected', async () => {
    const service = await makeService([]);
    const result = await service.openPlace({ placeId: '1', universeId: '2' });
    expect(result.connected).toBe(true);
    expect(result.pid).toBe(4242);
  });

  it('逾時仍回報結果與視窗標題，讓呼叫端判斷是不是意圖沒被吃下去', async () => {
    // 實測過一次 Studio 開著 place 五分鐘都沒註冊到 broker（原因未明），
    // 所以逾時不能當成錯誤丟出去 —— 要把線索帶回去。
    studio.connectsAfterPolls = Number.POSITIVE_INFINITY;
    const service = await makeService([]);
    const result = await service.openPlace({ placeId: '1', universeId: '2', waitMs: 5_000 });
    expect(result.connected).toBe(false);
    expect(result.windowTitle).toBe('sample-game - Roblox Studio');
  });

  it('行程直接死掉時立刻返回', async () => {
    studio.alive = false;
    const service = await makeService([]);
    const result = await service.openPlace({ placeId: '1', universeId: '2' });
    expect(result.connected).toBe(false);
  });
});

describe('cleanupStubs', () => {
  beforeEach(() => {
    studio.snapshotValue = {
      studios: [],
      brokerPid: 100,
      brokerPort: 13469,
      mcpProcesses: [
        // broker 本身很舊，但永遠不能被清除。
        { pid: 100, startedAt: iso(72 * HOUR), executablePath: undefined, role: 'broker', client: 'codex.exe' },
        { pid: 201, startedAt: iso(48 * HOUR), executablePath: undefined, role: 'stub', client: 'codex.exe' },
        { pid: 202, startedAt: iso(1 * HOUR), executablePath: undefined, role: 'stub', client: 'claude.exe' },
      ],
    };
  });

  it('預設只報告不動手', async () => {
    const service = await makeService([]);
    const result = await service.cleanupStubs({ olderThanHours: 12 });
    expect(result.dryRun).toBe(true);
    expect(result.planned.map((row) => row.pid)).toEqual([201]);
    expect(studio.terminated).toEqual([]);
  });

  it('🔴 broker 永遠不在清除名單裡', async () => {
    const service = await makeService([]);
    const result = await service.cleanupStubs({ olderThanHours: 1, apply: true });
    expect(result.planned.map((row) => row.pid)).not.toContain(100);
    expect(studio.terminated).not.toContain(100);
  });

  it('年輕的 stub 不碰 —— 可能還有活著的 session', async () => {
    const service = await makeService([]);
    const result = await service.cleanupStubs({ olderThanHours: 12, apply: true });
    expect(studio.terminated).toEqual([201]);
    expect(result.terminated).toEqual([201]);
  });

  it('辨識不出 broker 時整個放棄，寧可不動手也不亂殺', async () => {
    studio.snapshotValue = { ...studio.snapshotValue, brokerPid: undefined };
    const service = await makeService([]);
    await expect(service.cleanupStubs({ apply: true })).rejects.toThrow(RobloxServiceError);
    expect(studio.terminated).toEqual([]);
  });

  it('終止失敗的 pid 不算進 terminated', async () => {
    studio.failures = [{ pid: 201, reason: 'Access denied' }];
    const service = await makeService([]);
    const result = await service.cleanupStubs({ olderThanHours: 12, apply: true });
    expect(result.terminated).toEqual([]);
    expect(result.failures).toEqual([{ pid: 201, reason: 'Access denied' }]);
  });
});

describe('uploadAsset', () => {
  it('未設定允許目錄時一律拒絕', async () => {
    const service = await makeService([]);
    await expect(service.uploadAsset({ filePath: fbxPath, displayName: 'X' })).rejects.toThrow(
      /ROBLOX_UPLOAD_ROOT is not set/,
    );
  });

  it('拒絕允許目錄外的路徑 —— MCP Client 不該能指定任意檔案', async () => {
    const service = await makeService([join(workDir, 'allowed')]);
    await expect(service.uploadAsset({ filePath: fbxPath, displayName: 'X' })).rejects.toThrow(
      /is not inside an allowed folder/,
    );
  });

  it('擋掉用 .. 穿越出去的路徑', async () => {
    const service = await makeService([join(workDir, 'allowed')]);
    await expect(
      service.uploadAsset({ filePath: join(workDir, 'allowed', '..', 'cube.fbx'), displayName: 'X' }),
    ).rejects.toThrow(/is not inside an allowed folder/);
  });

  it('來源檔不存在時明確報錯', async () => {
    const service = await makeService([workDir]);
    await expect(
      service.uploadAsset({ filePath: join(workDir, 'missing.fbx'), displayName: 'X' }),
    ).rejects.toThrow(/Source file does not exist/);
  });

  it('推不出資產型別時要求明確指定', async () => {
    const objPath = join(workDir, 'cube.obj');
    await writeFile(objPath, 'o cube');
    const service = await makeService([workDir]);
    await expect(service.uploadAsset({ filePath: objPath, displayName: 'X' })).rejects.toThrow(
      /Cannot infer the asset type from the file extension/,
    );
  });

  it('路徑合法時才送出去', async () => {
    const service = await makeService([workDir]);
    const asset = await service.uploadAsset({ filePath: fbxPath, displayName: 'ProbeCube' });
    expect(asset.assetId).toBe('100000000000001');
    expect(openCloud.calls).toContain('create');
  });
});

describe('updateAsset', () => {
  it('revisionId 遞增＝真的更新了', async () => {
    openCloud.current = record({ revisionId: '1' });
    openCloud.next = record({ revisionId: '2' });
    const service = await makeService([workDir]);
    const { outcome } = await service.updateAsset({ assetId: '100000000000001', filePath: fbxPath });
    expect(outcome.verdict).toBe('updated');
  });

  it('🔴 revisionId 不動＝靜默去重，不能當成更新成功', async () => {
    openCloud.current = record({ revisionId: '1' });
    openCloud.next = record({ revisionId: '1' });
    const service = await makeService([workDir]);
    const { outcome } = await service.updateAsset({ assetId: '100000000000001', filePath: fbxPath });
    expect(outcome.verdict).toBe('deduplicated');
  });

  it('更新前先讀一次，才有前值可以比對', async () => {
    const service = await makeService([workDir]);
    await service.updateAsset({ assetId: '100000000000001', filePath: fbxPath });
    expect(openCloud.calls).toEqual(['get', 'updateContent']);
  });
});

describe('archiveAsset', () => {
  it('Model 先擋下來，不送出必定失敗的請求', async () => {
    openCloud.current = record({ assetType: 'Model' });
    const service = await makeService([]);
    await expect(service.archiveAsset('100000000000001')).rejects.toThrow(/is not an archivable asset type/);
    expect(openCloud.calls).not.toContain('archive');
  });

  it('可封存的型別照常送出', async () => {
    openCloud.current = record({ assetType: 'Audio' });
    const service = await makeService([]);
    const asset = await service.archiveAsset('100000000000001');
    expect(asset.state).toBe('Archived');
  });

  it('還原不需要先檢查型別', async () => {
    openCloud.current = record({ assetType: 'Model' });
    const service = await makeService([]);
    const asset = await service.archiveAsset('100000000000001', true);
    expect(asset.state).toBe('Active');
  });
});
