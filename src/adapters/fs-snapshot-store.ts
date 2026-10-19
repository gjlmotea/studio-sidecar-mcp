import { constants, type Stats } from 'node:fs';
import { link as fsLink, lstat, mkdir, mkdtemp, open, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { SCENE_FILES, sanitizeSegment, scriptFilesInManifest, type ScriptTarget } from '../domain/extraction.js';
import { isPathInside } from '../domain/path-containment.js';
import type { CommittedSnapshot, SnapshotPlan, SnapshotStore } from '../ports/snapshot-store.js';

/** 暫存目錄的名字前綴。建在輸出目錄裡，切換時的搬移才保證在同一個檔案系統上。 */
export const STAGING_PREFIX = '.studio-sidecar-staging-';

/** 一份腳本在輸出目錄裡最多試幾個名字。 */
const MAX_NAME_ATTEMPTS = 1_000;

/**
 * 獨佔建立：已經存在的檔案、資料夾或 symlink 都不會被打開，連檢查與開檔之間才冒出來的也一樣。
 * O_NOFOLLOW 是額外的一層（Windows 沒有這個旗標，退回 0）。
 */
const EXCLUSIVE_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const [PLACE_FILE, MANIFEST_FILE] = SCENE_FILES;

type Located = { readonly target: string; readonly stat: Stats | undefined };

/** 搬到暫存目錄的上一次快照檔：原本在哪、現在在哪。 */
type Moved = { readonly from: string; readonly to: string };

/** 切換途中做過的事，失敗時照它倒回去。 */
type SwapJournal = {
  readonly moved: Moved[];
  readonly placed: string[];
  readonly createdDirs: string[];
};

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const ignoreMissing = (error: unknown): undefined => {
  if (code(error) === 'ENOENT') return undefined;
  throw error;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type FsSnapshotStoreOptions = {
  /**
   * 建立硬連結；測試用來模擬不支援硬連結的檔案系統（FAT、exFAT）。
   * 目標已經存在時必須以 `code: 'EEXIST'` 失敗。
   */
  readonly link?: (existing: string, created: string) => Promise<void>;
};

/**
 * 把抽取結果寫成輸出目錄裡的快照。
 *
 * 🔴 0.1.0 先刪上一次的快照再寫新的，寫到一半失敗（磁碟滿、路徑被檔案擋住）就兩份都沒了。
 * 現在分兩段：
 * 1. **寫**：整份新快照先寫進輸出目錄裡一個全新的暫存目錄（`mkdtemp`，名字隨機、只有本行程知道），
 *    每個檔都獨佔建立。這一段失敗只會丟掉暫存目錄，上一次的快照完全沒動。
 * 2. **切換**：上一次快照的檔搬進暫存目錄，新檔以硬連結放到正式位置（目標已存在就失敗，
 *    不會覆蓋任何東西）。中途失敗就把放上去的新檔收掉、舊檔搬回原位。
 *
 * 同一個輸出目錄（以 realpath 認）的寫入排隊依序做：兩次抽取交錯時，後一次會把前一次當成別人的檔，
 * 改用 `~2` 的名字，而且前一次寫的檔不在最後那份 scripts.json 裡，下次就再也清不掉。
 *
 * 硬連結：本工具寫的檔都只有一個名字。上一次快照列出的檔就算被做成硬連結，搬走與刪除的也只是
 * 這個名字，別的名字底下的內容不受影響；寫入一律是建立新檔，從不打開已經存在的檔，
 * 所以也不可能透過硬連結寫進別的檔。
 *
 * 輸出目錄底下既有的資料夾仍是用路徑走的：每一層都先 realpath 確認還在輸出目錄裡才往下，
 * 但檢查與搬移之間被同機器上的其他程式換成 symlink 的話擋不住（README 的已知限制）。
 * 那種情況下最多是在外面多建一個新檔，不會覆蓋或刪除外面的東西。
 */
export class FsSnapshotStore implements SnapshotStore {
  readonly #queues = new Map<string, Promise<void>>();
  readonly #link: (existing: string, created: string) => Promise<void>;

  constructor(options: FsSnapshotStoreOptions = {}) {
    this.#link = options.link ?? fsLink;
  }

  async commit(outDir: string, plan: SnapshotPlan): Promise<CommittedSnapshot> {
    const root = resolve(outDir);
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    return await this.#serialized(realRoot, async () => await this.#commit(root, realRoot, plan));
  }

  async #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.#queues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }

  async #commit(root: string, realRoot: string, plan: SnapshotPlan): Promise<CommittedSnapshot> {
    // 認不得上一次的快照就整個中止：還沒寫任何東西，也沒動任何東西。
    const previous = await previousSnapshotFiles(root, realRoot);

    const staging = await mkdtemp(join(root, STAGING_PREFIX));
    let keepStaging = false;
    try {
      // ── 1. 寫：新快照整份進暫存目錄。名字用流水號，真正的檔名切換時才決定。 ──
      const fresh = join(staging, 'new');
      const aside = join(staging, 'old');
      await mkdir(fresh);
      await mkdir(aside);
      const stagedScripts: string[] = [];
      for (const [i, script] of plan.scripts.entries()) {
        const staged = join(fresh, `script-${String(i)}`);
        await writeExclusive(staged, script.content);
        stagedScripts.push(staged);
      }
      const stagedPlace = join(fresh, 'place.json');
      await writeExclusive(stagedPlace, plan.place);

      // ── 2. 切換 ──────────────────────────────────────────────────────
      const journal: SwapJournal = { moved: [], placed: [], createdDirs: [] };
      try {
        // 先全部看過再搬：中途發現穿越就一個都不動。scripts.json 排最後。
        const doomed: string[] = [];
        for (const relative of new Set([...previous, PLACE_FILE, MANIFEST_FILE])) {
          const { target, stat } = await locate(root, realRoot, relative);
          // 只搬一般檔。symlink 或資料夾不是本工具寫的，留著（新檔撞到它會改名或中止）。
          if (stat?.isFile() === true) doomed.push(target);
        }
        for (const [i, target] of doomed.entries()) {
          const to = join(aside, String(i));
          try {
            await rename(target, to);
          } catch (error) {
            // 不分大小寫的檔案系統上，清單裡只差大小寫的兩筆是同一個檔，第二筆已經搬走了。
            if (code(error) === 'ENOENT') continue;
            throw error;
          }
          journal.moved.push({ from: target, to });
        }

        const files: string[] = [];
        for (const [i, script] of plan.scripts.entries()) {
          const staged = stagedScripts[i];
          if (staged === undefined) throw new Error(`No staged file for script #${String(i)}.`);
          files.push(await this.#placeFirstFree(root, realRoot, staged, script.target, script.content, journal));
        }
        await this.#placeScene(root, realRoot, stagedPlace, PLACE_FILE, plan.place, journal);

        const manifest = plan.manifest(files);
        const stagedManifest = join(fresh, 'scripts.json');
        await writeExclusive(stagedManifest, manifest);
        await this.#placeScene(root, realRoot, stagedManifest, MANIFEST_FILE, manifest, journal);

        // 上一次快照的資料夾若因此變空就收掉。rmdir 只收空資料夾，裡面還有別人的東西就留著。
        await removeEmptyDirs(root, journal.moved.map((entry) => dirname(entry.from)));
        return {
          files,
          written: [...files, PLACE_FILE, MANIFEST_FILE].map((relative) => join(root, ...relative.split('/'))),
        };
      } catch (error) {
        const stranded = await rollback(journal);
        await removeEmptyDirs(root, journal.createdDirs);
        if (stranded.length === 0) throw error;
        keepStaging = true;
        throw new Error(
          `${messageOf(error)}\nRestoring the previous snapshot failed for ${String(stranded.length)} file(s); `
          + `they are kept in ${aside} (original paths: ${stranded.join(', ')}).`,
          { cause: error },
        );
      }
    } finally {
      if (!keepStaging) await rm(staging, { recursive: true, force: true });
    }
  }

  /** 依序試名稱表的名字與它的後備名字，放進第一個沒被占用的。回傳實際的相對路徑。 */
  async #placeFirstFree(
    root: string,
    realRoot: string,
    staged: string,
    planned: ScriptTarget,
    content: string,
    journal: SwapJournal,
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
      const relative = (attempt === 0 ? planned.path : planned.fallback(attempt))
        .split('/')
        .map(sanitizeSegment)
        .join('/');
      try {
        await this.#place(root, realRoot, staged, relative, content, journal);
        return relative;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
    }
    throw new Error(
      `${MAX_NAME_ATTEMPTS} candidate file names are all taken in the output folder (starting at ${planned.path}).`,
    );
  }

  /** scene 檔的名字固定，被別人占走（不是本工具寫的一般檔，所以沒被搬走）就中止。 */
  async #placeScene(
    root: string,
    realRoot: string,
    staged: string,
    relative: string,
    content: string,
    journal: SwapJournal,
  ): Promise<void> {
    try {
      await this.#place(root, realRoot, staged, relative, content, journal);
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      throw new Error(
        `${relative} in the output folder is not a regular file written by this tool; refusing to replace it: `
        + `${join(root, ...relative.split('/'))}`,
        { cause: error },
      );
    }
  }

  /**
   * 把暫存檔放到輸出目錄裡的 `relative`，目標已經存在時以 EEXIST 失敗。
   *
   * 先用硬連結：一步完成、檔案一出現就是完整內容。不支援硬連結的檔案系統改成獨佔建立再寫一次，
   * 寫到一半失敗就把這個自己剛建的檔刪掉。
   */
  async #place(
    root: string,
    realRoot: string,
    staged: string,
    relative: string,
    content: string,
    journal: SwapJournal,
  ): Promise<void> {
    const segments = relative.split('/');
    const fileName = segments.pop() ?? '_';
    const dir = await ensureDirInside(root, realRoot, segments, journal.createdDirs);
    const target = join(dir, fileName);
    if (!isPathInside(root, target)) throw new Error(`Output path escapes the output folder: ${relative}`);

    try {
      await this.#link(staged, target);
      journal.placed.push(target);
      return;
    } catch (error) {
      if (code(error) === 'EEXIST') throw error;
      // 其他錯誤（EPERM、ENOTSUP…）多半是檔案系統不支援硬連結；換獨佔建立。
      // 真正的問題（資料夾不見、沒有權限）會在下面的 open 以同樣的錯誤再出現一次。
    }
    const handle = await open(target, EXCLUSIVE_CREATE, 0o666);
    // 從這裡起這個檔是自己建的，失敗時可以刪。
    journal.placed.push(target);
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  }
}

/** 獨佔建立並寫入。 */
async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, EXCLUSIVE_CREATE, 0o666);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

/** 回傳輸出目錄內這個相對路徑的狀態；所在資料夾透過 symlink 跑到外面時直接中止。 */
async function locate(root: string, realRoot: string, relative: string): Promise<Located> {
  const target = join(root, ...relative.split('/'));
  const realParent = await realpath(dirname(target)).catch(ignoreMissing);
  if (realParent === undefined) return { target, stat: undefined };
  if (!isPathInside(realRoot, realParent)) {
    throw new Error(`Output path escapes the output folder through a symlink: ${relative}`);
  }
  return { target, stat: await lstat(target).catch(ignoreMissing) };
}

/**
 * 逐層建出資料夾。每一層都先 realpath 確認還在輸出目錄裡才往下建，
 * 不然 mkdir 會順著 symlink 在外面建出資料夾。
 */
async function ensureDirInside(
  root: string,
  realRoot: string,
  segments: readonly string[],
  createdDirs: string[],
): Promise<string> {
  let dir = root;
  for (const segment of segments) {
    dir = join(dir, segment);
    try {
      await mkdir(dir);
      createdDirs.push(dir);
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    if (!isPathInside(realRoot, await realpath(dir))) {
      throw new Error(`Output path escapes the output folder through a symlink: ${dir}`);
    }
  }
  return dir;
}

/**
 * 讀上一次抽取留下的 `scene/scripts.json`，回傳它寫過的腳本檔（相對路徑）。
 *
 * 🔴 scene 檔不是本工具寫的（沒有認得出來的 scripts.json）時整個中止：
 * 那兩個檔名是固定的，不能換名字，也不能蓋掉別人的檔。
 */
async function previousSnapshotFiles(root: string, realRoot: string): Promise<readonly string[]> {
  const manifest = await locate(root, realRoot, MANIFEST_FILE);
  if (manifest.stat === undefined) {
    if ((await locate(root, realRoot, PLACE_FILE)).stat !== undefined) {
      throw new Error(
        `The output folder already has ${PLACE_FILE} but no ${MANIFEST_FILE}, so it was not written by this tool. `
        + `Nothing was changed. Use an empty folder or remove that file: ${join(root, PLACE_FILE)}`,
      );
    }
    return [];
  }
  if (!manifest.stat.isFile()) {
    throw new Error(`${MANIFEST_FILE} in the output folder is not a regular file; refusing to use it: ${manifest.target}`);
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
      `The output folder has a ${MANIFEST_FILE} that this tool did not write, or that lists paths this tool never writes. `
      + `Nothing was changed. Use an empty folder, a folder from a previous extraction, or remove that file: ${manifest.target}`,
    );
  }
  return scripts;
}

/**
 * 切換失敗時倒回去：收掉放上去的新檔，舊檔搬回原位。回傳搬不回去的原始路徑。
 *
 * 搬回去之前確認原位是空的；被別的東西占走就不搬（不覆蓋），那個檔留在暫存目錄裡。
 */
async function rollback(journal: SwapJournal): Promise<readonly string[]> {
  for (const target of [...journal.placed].reverse()) {
    await unlink(target).catch(() => undefined);
  }
  const stranded: string[] = [];
  for (const { from, to } of [...journal.moved].reverse()) {
    try {
      const occupied = await lstat(from).then(() => true, (error: unknown) => {
        if (code(error) === 'ENOENT') return false;
        throw error;
      });
      if (occupied) {
        stranded.push(from);
        continue;
      }
      // 不補建資料夾：原位的資料夾在切換時沒被動過，不在了就是別人動的，不跟著建。
      await rename(to, from);
    } catch {
      stranded.push(from);
    }
  }
  return stranded;
}

/** 由深到淺收掉變空的資料夾，到輸出目錄為止。 */
async function removeEmptyDirs(root: string, starts: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const start of starts) {
    for (let dir = start; dir !== root && isPathInside(root, dir); dir = dirname(dir)) dirs.add(dir);
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => undefined);
  }
}
