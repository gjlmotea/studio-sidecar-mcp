#!/usr/bin/env node
/**
 * MCP Client 啟動點。
 *
 * `ROBLOX_API_KEY` 依根 AGENTS.md SEC-001 只准放在列名核准的
 * `gjlmotea/vibe/roblox/.env.shared`，不得複製到 `.mcp.json` 或其他被追蹤的路徑。
 * 這層把該檔的金鑰讀進 process.env 後才載入 server，讓那把金鑰維持唯一來源。
 *
 * 外部已設好 `ROBLOX_API_KEY` 時一律以外部為準；讀不到檔案就照常啟動，
 * 只有四個 Open Cloud 工具會因缺金鑰而拒絕，其餘工具不受影響。
 */

import { readFile } from 'node:fs/promises';

const ENV_SHARED_URL = new URL('../../../roblox/.env.shared', import.meta.url);
const KEY = 'ROBLOX_API_KEY';

async function readSharedApiKey() {
  try {
    const raw = await readFile(ENV_SHARED_URL, 'utf8');
    const line = raw.split(/\r?\n/).find((row) => row.startsWith(`${KEY}=`));
    return line === undefined ? undefined : line.slice(KEY.length + 1).trim();
  } catch {
    return undefined;
  }
}

if ((process.env[KEY]?.trim() ?? '') === '') {
  const apiKey = await readSharedApiKey();
  if (apiKey !== undefined && apiKey !== '') {
    process.env[KEY] = apiKey;
  }
}

await import('../dist/index.js');
