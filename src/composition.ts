import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { DarwinProcessInspector } from './adapters/darwin-process-inspector.js';
import { FetchOpenCloud } from './adapters/fetch-open-cloud.js';
import { LocalStudioHost } from './adapters/local-studio-host.js';
import { McpStudioBridge } from './adapters/mcp-studio-bridge.js';
import { WindowsProcessInspector } from './adapters/windows-process-inspector.js';
import { RobloxService } from './application/roblox-service.js';
import { SCENE_FILES, sanitizeSegment, scriptFilesInManifest } from './domain/extraction.js';
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
 *
 * 🔴 **永不覆蓋**：檔案一律獨佔建立（O_EXCL）。目標已經有東西時——包括檔案系統認為同名、
 * 字串上卻不同的名字（不分大小寫時的 `Σ` 與 `ς`）——以 `code: 'EEXIST'` 失敗，由呼叫端換下一個名字。
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
  // O_EXCL：已經存在的檔案、資料夾或 symlink 都不會被打開，連檢查與開檔之間才冒出來的也一樣。
  // O_NOFOLLOW 是額外的一層（Windows 沒有這個旗標，退回 0）。
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags, 0o666);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return target;
}

const ignoreMissing = (error: NodeJS.ErrnoException): undefined => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
};

/**
 * 重跑到同一個輸出目錄之前，先清掉上一次抽取寫的檔。
 *
 * 只刪上一次 `scene/scripts.json` 列出的腳本檔（就是上一次實際寫入的路徑）與兩個 scene 檔，
 * 其餘一律不碰：使用者自己放的檔就算跟腳本同名也留著，新的那份撞到 EEXIST 後改用下一個 `~n`。
 * 少了這一步，每次重跑都會撞上自己上一次的檔，檔名就越跑越長；place 裡刪掉的腳本也會一直留在快照裡。
 *
 * 🔴 scene 檔不是本工具寫的（沒有認得出來的 scripts.json）時整個中止，一個檔都不刪：
 * 那兩個檔名是固定的，不能換名字，也不能蓋掉別人的檔。
 */
export async function clearPreviousExtraction(outDir: string): Promise<void> {
  const root = resolve(outDir);
  const realRoot = await realpath(root).catch(ignoreMissing);
  if (realRoot === undefined) return; // 輸出目錄還不存在，沒有上一次。

  // 回傳 outDir 內這個相對路徑的狀態；所在資料夾透過 symlink 跑到外面時直接中止。
  const locate = async (relative: string) => {
    const target = join(root, ...relative.split('/'));
    const realParent = await realpath(dirname(target)).catch(ignoreMissing);
    if (realParent === undefined) return { target, stat: undefined };
    if (!isPathInside(realRoot, realParent)) {
      throw new Error(`Output path escapes the output folder through a symlink: ${relative}`);
    }
    return { target, stat: await lstat(target).catch(ignoreMissing) };
  };

  const [placeRelative, manifestRelative] = SCENE_FILES;
  const manifest = await locate(manifestRelative);
  if (manifest.stat === undefined) {
    if ((await locate(placeRelative)).stat !== undefined) {
      throw new Error(
        `The output folder already has ${placeRelative} but no ${manifestRelative}, so it was not written by this tool. `
        + `Nothing was deleted. Use an empty folder or remove that file: ${join(root, placeRelative)}`,
      );
    }
    return;
  }
  if (!manifest.stat.isFile()) {
    throw new Error(`${manifestRelative} in the output folder is not a regular file; refusing to use it: ${manifest.target}`);
  }
  const handle = await open(manifest.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const scripts = scriptFilesInManifest(text);
  if (scripts === undefined) {
    throw new Error(
      `The output folder has a ${manifestRelative} that this tool did not write, or that lists paths this tool never writes. `
      + `Nothing was deleted. Use an empty folder, a folder from a previous extraction, or remove that file: ${manifest.target}`,
    );
  }

  // 先全部看過再刪：中途發現穿越就一個都不刪。scripts.json 排最後，刪到一半失敗時下一次還找得到它。
  const doomed: string[] = [];
  for (const relative of [...scripts, placeRelative, manifestRelative]) {
    const { target, stat } = await locate(relative);
    // 只刪一般檔。symlink 或資料夾不是本工具寫的，留著（之後寫到那個名字時會被拒絕或換名字）。
    if (stat?.isFile() === true) doomed.push(target);
  }
  for (const target of doomed) await unlink(target).catch(ignoreMissing);

  // 刪完變空的資料夾也收掉。rmdir 只收空資料夾，裡面還有別人的東西就留著。
  const dirs = new Set<string>();
  for (const target of doomed) {
    for (let dir = dirname(target); dir !== root && isPathInside(root, dir); dir = dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => undefined);
  }
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
    prepareOutDir: clearPreviousExtraction,
    ...(options.creatorUserId === undefined ? {} : { defaultCreatorUserId: options.creatorUserId }),
  });
}
