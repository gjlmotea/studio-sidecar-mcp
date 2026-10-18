import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DarwinProcessInspector } from './adapters/darwin-process-inspector.js';
import { FetchOpenCloud } from './adapters/fetch-open-cloud.js';
import { LocalStudioHost } from './adapters/local-studio-host.js';
import { McpStudioBridge } from './adapters/mcp-studio-bridge.js';
import { WindowsProcessInspector } from './adapters/windows-process-inspector.js';
import { RobloxService } from './application/roblox-service.js';
import { sanitizeSegment } from './domain/extraction.js';
import { isPathInside } from './domain/path-containment.js';
import type { ProcessInspector } from './ports/process-inspector.js';
import { StudioHostError } from './ports/studio-host.js';

// 檔名清理屬於抽取的 domain 規則；這裡轉出去，維持原本的匯入點。
export { sanitizeSegment };

/**
 * 寫進輸出目錄，並確保最終路徑真的落在目錄內。
 *
 * 🔴 光比字面路徑不夠：輸出目錄裡已經有的 symlink（資料夾或檔案）會把寫入帶到外面。
 * 所以每往下一層都先 realpath 確認還在輸出目錄的 realpath 之內才往下建，
 * 目標檔本身是 symlink 時一律拒寫，不管它指到哪裡。
 */
export async function writeIntoOutDir(
  outDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const segments = relativePath.split('/').map(sanitizeSegment);
  const fileName = segments.pop() ?? '_';
  const root = resolve(outDir);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);

  let dir = root;
  for (const segment of segments) {
    dir = join(dir, segment);
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // 先確認這一層還在裡面再往下建；不然 mkdir 會順著 symlink 在外面建出資料夾。
    if (!isPathInside(realRoot, await realpath(dir))) {
      throw new Error(`Output path escapes the output folder through a symlink: ${relativePath}`);
    }
  }

  const target = join(dir, fileName);
  if (!isPathInside(root, target)) {
    throw new Error(`Output path escapes the output folder: ${relativePath}`);
  }
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() === true) {
    throw new Error(`Refusing to write through a symlink: ${target}`);
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`Output path exists and is not a regular file: ${target}`);
  }
  // O_NOFOLLOW 補檢查與開檔之間被換成 symlink 的空窗（Windows 沒有這個旗標，退回 0）。
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags, 0o666);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
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
        `Roblox Studio does not support ${platform}; this server only implements Windows and macOS.`,
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
