#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { delimiter } from 'node:path';

import { createRobloxService } from './composition.js';
import { installShutdown } from './lifecycle.js';
import { log } from './logger.js';
import { createMcpServer } from './server/create-server.js';
import { connectStdio } from './transports/stdio.js';

const PACKAGE_URL = new URL('../package.json', import.meta.url);

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(PACKAGE_URL, 'utf8');
    const parsed = JSON.parse(raw) as { readonly version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `ROBLOX_UPLOAD_ROOT` 允許多個目錄，以平台的 PATH 分隔符分隔。 */
function envList(name: string): readonly string[] {
  const raw = env(name);
  return raw === undefined
    ? []
    : raw.split(delimiter).map((part) => part.trim()).filter((part) => part !== '');
}

async function main(): Promise<void> {
  const version = await readVersion();

  const service = createRobloxService(version, {
    ...(env('ROBLOX_API_KEY') === undefined ? {} : { apiKey: env('ROBLOX_API_KEY') as string }),
    ...(env('ROBLOX_CREATOR_USER_ID') === undefined
      ? {}
      : { creatorUserId: env('ROBLOX_CREATOR_USER_ID') as string }),
    ...(env('ROBLOX_STUDIO_PATH') === undefined
      ? {}
      : { studioPath: env('ROBLOX_STUDIO_PATH') as string }),
    uploadRoots: envList('ROBLOX_UPLOAD_ROOT'),
  });

  const server = createMcpServer({ service, version });
  // listener 先掛再接 stdio：Host 在握手前就關掉 stdin 也收得到。
  const lifecycle = installShutdown(
    { stdin: process.stdin, stdout: process.stdout, signals: process },
    [
      // 收 Studio 橋才會連帶收掉 StudioMCP 子行程；不收就留下一隻 stub。
      { name: 'studio-bridge', close: async () => await service.closeBridge() },
      { name: 'stdio', close: async () => await server.close() },
    ],
  );
  try {
    if (!process.stdin.readableEnded && !process.stdin.destroyed) await connectStdio(server);
  } catch (error) {
    await lifecycle.shutdown('startup-failure');
    throw error;
  }
  if (!(await lifecycle.startupComplete())) return;

  const status = service.status();
  log('info', 'ready', {
    version,
    transport: 'stdio',
    platform: process.platform,
    studioExecutable: status.studioExecutable ?? 'unresolved',
    uploadRoots: status.allowedUploadRoots.length,
    // 祕密只記名稱不記值。
    apiKey: status.openCloudConfigured ? 'set' : 'unset',
    creatorUserId: status.defaultCreatorConfigured ? 'set' : 'unset',
  });
}

main().catch((error: unknown) => {
  log('error', 'fatal', {
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
