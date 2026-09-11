import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { DarwinProcessInspector } from './adapters/darwin-process-inspector.js';
import { FetchOpenCloud } from './adapters/fetch-open-cloud.js';
import { LocalStudioHost } from './adapters/local-studio-host.js';
import { McpStudioBridge } from './adapters/mcp-studio-bridge.js';
import { WindowsProcessInspector } from './adapters/windows-process-inspector.js';
import { RobloxService } from './application/roblox-service.js';
import type { ProcessInspector } from './ports/process-inspector.js';
import { StudioHostError } from './ports/studio-host.js';

/**
 * 把 DataModel 路徑裡不能當檔名的東西換掉。
 *
 * 🔴 Roblox 的實例名稱幾乎沒有限制 —— 可以叫 `..`、可以含 `:`、可以含路徑分隔符。
 * 直接拿來拼檔案路徑會穿越出輸出目錄。
 */
export function sanitizeSegment(segment: string): string {
  // 只換掉在 Windows 或 POSIX 真的不能當檔名的字元。空白與連字號是合法的，
  // 換掉只會讓快照的檔名跟 DataModel 的實例名對不起來。
  // 用明確字元集而不是正規表示式字面值 —— 這串要跳脫的東西太多，寫錯不會報錯只會靜默漏掉。
  const FORBIDDEN = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const cleaned = [...segment]
    .map((char) => (FORBIDDEN.has(char) || char.charCodeAt(0) < 0x20 ? '_' : char))
    .join('')
    // Windows 不允許檔名以點或空白結尾。
    .replace(/[. ]+$/, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

/** 寫進輸出目錄，並確保最終路徑真的落在目錄內。 */
export async function writeIntoOutDir(
  outDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const safe = relativePath.split('/').map(sanitizeSegment).join('/');
  const root = resolve(outDir);
  const target = resolve(join(root, safe));
  const rel = relative(root, target);
  if (rel.startsWith('..')) {
    throw new Error(`輸出路徑逃出目錄：${relativePath}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

export type CompositionOptions = {
  readonly apiKey?: string;
  readonly creatorUserId?: string;
  readonly studioPath?: string;
  readonly uploadRoots?: readonly string[];
  /** 測試用；正式執行時依 `process.platform` 挑。 */
  readonly inspector?: ProcessInspector;
};

/** Roblox Studio 只存在於 Windows 與 macOS，所以只實作這兩個平台。 */
export function createProcessInspector(platform: NodeJS.Platform = process.platform): ProcessInspector {
  switch (platform) {
    case 'win32':
      return new WindowsProcessInspector();
    case 'darwin':
      return new DarwinProcessInspector();
    default:
      throw new StudioHostError(
        `Roblox Studio 不支援 ${platform}；本 server 只實作了 Windows 與 macOS。`,
      );
  }
}

export function createRobloxService(version: string, options: CompositionOptions = {}): RobloxService {
  const inspector = options.inspector ?? createProcessInspector();
  const studio = new LocalStudioHost(inspector, options.studioPath);
  const openCloud = new FetchOpenCloud(
    options.apiKey === undefined ? {} : { apiKey: options.apiKey },
  );

  return new RobloxService({
    studio,
    openCloud,
    version,
    allowedUploadRoots: options.uploadRoots ?? [],
    bridge: new McpStudioBridge(),
    writeFile: writeIntoOutDir,
    ...(options.creatorUserId === undefined ? {} : { defaultCreatorUserId: options.creatorUserId }),
  });
}
