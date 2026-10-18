import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * stdio lifecycle smoke。
 *
 * 只做不需要 Roblox Studio、不需要網路、也不需要金鑰的檢查：
 * 伺服器起得來、工具面完整、狀態工具可呼叫、上傳護欄在沒設定時確實拒絕。
 * 真機驗證（開 place、上傳資產）見 README「端到端驗證」。
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    // 刻意全部留空：smoke 要驗的正是「沒設定時明確拒絕」而不是靜默失敗。
    ROBLOX_API_KEY: '',
    ROBLOX_UPLOAD_ROOT: '',
    ROBLOX_CREATOR_USER_ID: '',
  },
});

const client = new Client({ name: 'roblox-mcp-smoke', version: '0.0.0' });
await client.connect(transport);

try {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();

  const expected = [
    'roblox_archive_asset',
    'roblox_cleanup_stubs',
    'roblox_extract_place',
    'roblox_get_asset',
    'roblox_get_status',
    'roblox_list_studios',
    'roblox_luau_safe',
    'roblox_open_place',
    'roblox_place_guard',
    'roblox_update_asset',
    'roblox_upload_asset',
  ];
  assert.deepEqual(names, expected, `unexpected tool surface: ${names.join(', ')}`);

  // 每個工具都要有描述，否則呼叫端無從判斷該不該用。
  for (const tool of tools) {
    assert.ok(
      typeof tool.description === 'string' && tool.description.length > 0,
      `${tool.name} has no description`,
    );
  }

  const status = await client.callTool({ name: 'roblox_get_status', arguments: {} });
  assert.equal(status.isError ?? false, false, 'the status tool should not return an error');
  assert.equal(status.structuredContent.openCloudConfigured, false, 'should report not configured when no key is given');
  assert.deepEqual(status.structuredContent.allowedUploadRoots, [], 'should be empty when no upload root is given');

  // 沒設定允許目錄時，上傳必須明確拒絕 —— 這是不可逆操作的護欄。
  const denied = await client.callTool({
    name: 'roblox_upload_asset',
    arguments: { filePath: 'anything.fbx', displayName: 'Probe' },
  });
  assert.equal(denied.isError, true, 'should refuse when no upload root is set');
  assert.match(
    denied.content[0].text,
    /ROBLOX_UPLOAD_ROOT/,
    'the refusal should name the missing setting',
  );

  console.log(`stdio smoke passed: ${tools.length} tools; the upload guard and status reporting work.`);
} finally {
  await client.close();
}
