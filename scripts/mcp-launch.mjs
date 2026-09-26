#!/usr/bin/env node
/**
 * MCP Client 啟動點。
 *
 * `ROBLOX_API_KEY` 一律以外部環境變數為準（例如 MCP client 設定裡的 env）。
 * 沒設定時，再試著讀上層工作區的 `roblox/.env.shared` —— 作者的私人 monorepo 用這個檔
 * 跨機器共用金鑰，讓它維持唯一來源；獨立 clone 下這個檔不存在，會直接略過。
 *
 * 讀不到金鑰也照常啟動，只有四個 Open Cloud 工具會因缺金鑰而拒絕，其餘工具不受影響。
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
