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
