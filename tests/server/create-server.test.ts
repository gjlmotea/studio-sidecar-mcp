import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { RobloxService } from '../../src/application/roblox-service.js';
import { createMcpServer } from '../../src/server/create-server.js';

async function connect(): Promise<Client> {
  const service = {
    status: () => ({ version: '0.1.0-test', openCloudConfigured: false, allowedUploadRoots: [], defaultCreatorConfigured: false }),
  } as unknown as RobloxService;
  const server = createMcpServer({ service, version: '0.1.0-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'studio-sidecar-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('serverInfo', () => {
  it('握手回報的是產品名，不是舊的 roblox-mcp', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'studio-sidecar-mcp', title: 'Studio Sidecar' });
  });
});

describe('server instructions', () => {
  it('照實描述 Luau 的錯誤處理：錯誤之後的程式不會執行，也不回復先前的修改', async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).not.toContain('without one protected property aborting the whole chunk');
    expect(instructions).toContain('stops the rest of the chunk');
    expect(instructions).toContain('not rolled back');
  });
});

describe('tools/call 引數的元素上限', () => {
  it('一般呼叫不受影響', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'roblox_get_status', arguments: {} });
    expect(result.isError).not.toBe(true);
  });

  it('元素數超過上限的引數在 schema 驗證之前就被拒絕', async () => {
    const client = await connect();
    const outcome = await client
      .callTool({ name: 'roblox_place_guard', arguments: { placeId: '1', padding: Array.from({ length: 5_000 }, () => 0) } })
      .then(
        (result) => JSON.stringify(result.content),
        (error: unknown) => String(error),
      );
    expect(outcome).toContain('maximum of 1000 elements');
  });
});
