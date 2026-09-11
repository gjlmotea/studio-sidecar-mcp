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
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const envPath = new URL('../../../roblox/.env.shared', import.meta.url);
const assetId = process.argv[2] ?? '139070083633857';

/** 從 vibe/roblox/.env.shared 取金鑰；沒有就跳過 Open Cloud 那段。 */
async function readApiKey() {
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
    ROBLOX_CREATOR_USER_ID: '1000000123',
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
  console.log('狀態');
  const status = await client.callTool({ name: 'roblox_get_status', arguments: {} });
  const s = status.structuredContent;
  console.log(`  Studio 執行檔：${s.studioExecutable ?? '（解析不到）'}`);
  check('解析得到 Studio 執行檔', () => assert.ok(s.studioExecutable, '沒解析到'));
  check('Open Cloud 金鑰就緒', () => assert.equal(s.openCloudConfigured, apiKey !== undefined));

  console.log('\n行程快照（唯讀）');
  const studios = await client.callTool({ name: 'roblox_list_studios', arguments: {} });
  if (studios.isError) {
    console.log(`  ⚠ 跳過：${studios.content[0].text}`);
  } else {
    const snap = studios.structuredContent;
    const broker = snap.mcpProcesses.filter((row) => row.role === 'broker');
    const stubs = snap.mcpProcesses.filter((row) => row.role === 'stub');
    console.log(`  Studio ${snap.studios.length} 個｜broker ${snap.brokerPid ?? '無'}｜stub ${stubs.length} 隻`);
    for (const studio of snap.studios) console.log(`    pid ${studio.pid}  ${studio.windowTitle ?? '(無標題)'}`);
    check('broker 唯一', () => assert.ok(broker.length <= 1, `找到 ${broker.length} 個 broker`));
    check('broker 有被辨識出來', () => assert.ok(snap.brokerPid !== undefined, '沒找到 broker'));

    console.log('\n清理計畫（dry-run，不動手）');
    const plan = await client.callTool({
      name: 'roblox_cleanup_stubs',
      arguments: { olderThanHours: 6 },
    });
    const p = plan.structuredContent;
    console.log(`  可清除 ${p.planned.length} 隻`);
    check('預設就是 dry-run', () => assert.equal(p.dryRun, true));
    check('沒有真的終止任何行程', () => assert.deepEqual(p.terminated, []));
    check('🔴 broker 不在清除名單裡', () =>
      assert.ok(!p.planned.some((row) => row.pid === p.brokerPid), 'broker 被列入清除名單'));
  }

  if (apiKey !== undefined) {
    console.log('\nOpen Cloud（唯讀）');
    const asset = await client.callTool({ name: 'roblox_get_asset', arguments: { assetId } });
    if (asset.isError) {
      console.log(`  ⚠ ${asset.content[0].text}`);
      failures += 1;
    } else {
      const a = asset.structuredContent.asset;
      console.log(`  ${a.displayName}｜${a.assetType}｜revision ${a.revisionId}｜${a.state}`);
      check('取得 assetId', () => assert.equal(a.assetId, assetId));
      check('回報真正的作者而不是持有者', () => assert.ok(a.creatorUserId, '沒有 creatorUserId'));
      check('回報 revisionId（更新判定的唯一依據）', () => assert.ok(a.revisionId, '沒有 revisionId'));
    }
  } else {
    console.log('\nOpen Cloud：跳過（讀不到 vibe/roblox/.env.shared 的金鑰）');
  }

  console.log(failures === 0 ? '\n真機驗證通過。' : `\n真機驗證有 ${failures} 項未通過。`);
} finally {
  await client.close();
}

process.exitCode = failures === 0 ? 0 : 1;
