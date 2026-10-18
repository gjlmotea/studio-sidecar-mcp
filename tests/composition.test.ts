import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeIntoOutDir } from '../src/composition.js';

let base: string;
let outDir: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'roblox-mcp-out-'));
  outDir = join(base, 'out');
  outside = join(base, 'outside');
  await mkdir(outDir);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('🔴 writeIntoOutDir 不跟著 symlink 寫出輸出目錄', () => {
  it('輸出目錄裡的資料夾 symlink 指到外面時拒絕，外面連資料夾都不建', async () => {
    await symlink(outside, join(outDir, 'src'), 'dir');
    await expect(
      writeIntoOutDir(outDir, 'src/ServerScriptService/Main.server.luau', 'print(1)'),
    ).rejects.toThrow(/escapes the output folder/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('目標檔本身是 symlink 時拒絕寫入 —— 指到外面的檔案或還不存在的檔案都一樣', async () => {
    await mkdir(join(outDir, 'scene'));
    await writeFile(join(outside, 'notes.txt'), 'keep me');
    await symlink(join(outside, 'notes.txt'), join(outDir, 'scene', 'place.json'));
    await symlink(join(outside, 'created-by-write.txt'), join(outDir, 'scene', 'scripts.json'));

    await expect(writeIntoOutDir(outDir, 'scene/place.json', '{}')).rejects.toThrow(/symlink/);
    await expect(writeIntoOutDir(outDir, 'scene/scripts.json', '{}')).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(await readdir(outside)).toEqual(['notes.txt']);
  });
});
