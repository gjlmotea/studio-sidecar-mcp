import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * 真機驗證：對這台機器上真的 Roblox Studio 與真的 Open Cloud 帳號跑一遍。
 *
 * 刻意**只做唯讀操作** —— 不上傳、不更新、不開 place、不終止任何行程。
 * 會產生副作用的路徑（roblox_open_place、roblox_upload_asset、roblox_update_asset）
 * 的實測結果記在 README「端到端驗證」，重跑要人為判斷代價後手動執行。
 *
 * 用法：node scripts/verify-live.mjs [assetId]
 *
 * 金鑰取 ROBLOX_API_KEY，沒設定時再試作者工作區的 roblox/.env.shared；兩者都沒有、
 * 或沒給 assetId，就跳過 Open Cloud 那段。ROBLOX_CREATOR_USER_ID 有設才帶進去。
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const envPath = new URL('../../../roblox/.env.shared', import.meta.url);
const assetId = process.argv[2];

/** 先看環境變數，再看作者工作區的 roblox/.env.shared；都沒有就跳過 Open Cloud 那段。 */
async function readApiKey() {
  const fromEnv = process.env.ROBLOX_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(envPath, 'utf8');
    const line = raw.split(/\r?\n/).find((row) => row.startsWith('ROBLOX_API_KEY='));
    return line === undefined ? undefined : line.slice('ROBLOX_API_KEY='.length).trim();
  } catch {
    return undefined;
  }
}

const apiKey = await readApiKey();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    ...(apiKey === undefined ? {} : { ROBLOX_API_KEY: apiKey }),
    ...(process.env.ROBLOX_CREATOR_USER_ID
      ? { ROBLOX_CREATOR_USER_ID: process.env.ROBLOX_CREATOR_USER_ID }
      : {}),
  },
});

const client = new Client({ name: 'roblox-mcp-live', version: '0.0.0' });
await client.connect(transport);

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error.message}`);
  }
}

try {
  console.log('Status');
  const status = await client.callTool({ name: 'roblox_get_status', arguments: {} });
  const s = status.structuredContent;
  console.log(`  Studio executable: ${s.studioExecutable ?? '(not resolved)'}`);
  check('Studio executable resolves', () => assert.ok(s.studioExecutable, 'not resolved'));
  check('Open Cloud key is ready', () => assert.equal(s.openCloudConfigured, apiKey !== undefined));

  console.log('\nProcess snapshot (read-only)');
  const studios = await client.callTool({ name: 'roblox_list_studios', arguments: {} });
  if (studios.isError) {
    console.log(`  ⚠ Skipped: ${studios.content[0].text}`);
  } else {
    const snap = studios.structuredContent;
    const broker = snap.mcpProcesses.filter((row) => row.role === 'broker');
    const stubs = snap.mcpProcesses.filter((row) => row.role === 'stub');
    console.log(`  Studio ${snap.studios.length} | broker ${snap.brokerPid ?? 'none'} | stubs ${stubs.length}`);
    for (const studio of snap.studios) console.log(`    pid ${studio.pid}  ${studio.windowTitle ?? '(no title)'}`);
    check('At most one broker', () => assert.ok(broker.length <= 1, `found ${broker.length} brokers`));
    check('Broker is identified', () => assert.ok(snap.brokerPid !== undefined, 'no broker found'));

    console.log('\nCleanup plan (dry run, nothing is changed)');
    const plan = await client.callTool({
      name: 'roblox_cleanup_stubs',
      arguments: { olderThanHours: 6 },
    });
    const p = plan.structuredContent;
    console.log(`  ${p.planned.length} can be cleaned up`);
    check('Dry run is the default', () => assert.equal(p.dryRun, true));
    check('No process was actually terminated', () => assert.deepEqual(p.terminated, []));
    check('🔴 The broker is not on the cleanup list', () =>
      assert.ok(!p.planned.some((row) => row.pid === p.brokerPid), 'the broker is on the cleanup list'));
  }

  if (apiKey !== undefined && assetId !== undefined) {
    console.log('\nOpen Cloud (read-only)');
    const asset = await client.callTool({ name: 'roblox_get_asset', arguments: { assetId } });
    if (asset.isError) {
      console.log(`  ⚠ ${asset.content[0].text}`);
      failures += 1;
    } else {
      const a = asset.structuredContent.asset;
      console.log(`  ${a.displayName} | ${a.assetType} | revision ${a.revisionId} | ${a.state}`);
      check('Gets the assetId', () => assert.equal(a.assetId, assetId));
      check('Reports the real creator, not the holder', () => assert.ok(a.creatorUserId, 'no creatorUserId'));
      check('Reports revisionId (the only basis for judging an update)', () => assert.ok(a.revisionId, 'no revisionId'));
    }
  } else {
    console.log(`\nOpen Cloud: skipped (${apiKey === undefined ? 'no ROBLOX_API_KEY' : 'no assetId given'})`);
  }

  console.log(failures === 0 ? '\nLive verification passed.' : `\nLive verification: ${failures} check(s) failed.`);
} finally {
  await client.close();
}

process.exitCode = failures === 0 ? 0 : 1;
