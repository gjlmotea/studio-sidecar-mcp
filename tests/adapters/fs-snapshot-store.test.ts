import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSnapshotStore, STAGING_PREFIX } from '../../src/adapters/fs-snapshot-store.js';
import { planScriptTargets } from '../../src/domain/extraction.js';
import type { SnapshotPlan } from '../../src/ports/snapshot-store.js';

let base: string;
let outDir: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'studio-sidecar-store-'));
  outDir = join(base, 'out');
  outside = join(base, 'outside');
  await mkdir(outDir);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function plan(scripts: readonly { path: string; className: string; source: string }[]): SnapshotPlan {
  const targets = planScriptTargets(scripts);
  return {
    scripts: scripts.map((script, i) => {
      const target = targets[i];
      if (target === undefined) throw new Error('no target');
      return { target, content: script.source };
    }),
    place: '{}\n',
    manifest: (files) => `${JSON.stringify({
      extractedBy: 'studio-sidecar extract_place (read-only)',
      scripts: files.map((file) => ({ file })),
    })}\n`,
  };
}

const main = plan([{ path: 'ServerScriptService/Main', className: 'Script', source: 'print(1)' }]);

describe('🔴 快照層不跟著 symlink 寫出輸出目錄', () => {
  it('輸出目錄裡的資料夾 symlink 指到外面時拒絕，外面連資料夾都不建', async () => {
    await symlink(outside, join(outDir, 'src'), 'dir');
    await expect(new FsSnapshotStore().commit(outDir, main)).rejects.toThrow(/escapes the output folder/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('沒有 scripts.json 卻有 scene 檔（含 symlink）時什麼都不寫', async () => {
    await mkdir(join(outDir, 'scene'));
    await writeFile(join(outside, 'notes.txt'), 'keep me');
    await symlink(join(outside, 'notes.txt'), join(outDir, 'scene', 'place.json'));
    await expect(new FsSnapshotStore().commit(outDir, main)).rejects.toThrow(/place\.json/);

    await rm(join(outDir, 'scene', 'place.json'));
    await symlink(join(outside, 'created-by-write.txt'), join(outDir, 'scene', 'place.json'));
    await expect(new FsSnapshotStore().commit(outDir, main)).rejects.toThrow(/place\.json/);

    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(await readdir(outside)).toEqual(['notes.txt']);
    expect(await readdir(outDir)).toEqual(['scene']);
  });

  it('上一次的 place.json 被換成 symlink：拒絕取代，已經放上去的新檔收掉、舊快照搬回原位', async () => {
    const store = new FsSnapshotStore();
    await store.commit(outDir, main);
    const manifest = await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8');
    await writeFile(join(outside, 'notes.txt'), 'keep me');
    await rm(join(outDir, 'scene', 'place.json'));
    await symlink(join(outside, 'notes.txt'), join(outDir, 'scene', 'place.json'));

    const next = plan([
      { path: 'ServerScriptService/Main', className: 'Script', source: 'print(2)' },
      { path: 'ReplicatedStorage/Util', className: 'ModuleScript', source: 'return {}' },
    ]);
    await expect(store.commit(outDir, next)).rejects.toThrow(/place\.json/);

    expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(await readFile(join(outDir, 'scene', 'scripts.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8')).toBe('print(1)');
    expect(await readdir(join(outDir, 'src'))).toEqual(['ServerScriptService']);
    expect((await readdir(outDir)).sort()).toEqual(['scene', 'src']);
  });
});

describe('🔴 快照層不覆蓋既有檔案', () => {
  it('腳本的名字被別人的檔或 symlink 占走時改用下一個名字，原本的內容留著', async () => {
    await mkdir(join(outDir, 'src', 'ServerScriptService'), { recursive: true });
    await writeFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'keep me');
    await writeFile(join(outside, 'target.txt'), 'outside');
    await symlink(join(outside, 'target.txt'), join(outDir, 'src', 'ServerScriptService', 'Main~2.server.luau'));

    const { files } = await new FsSnapshotStore().commit(outDir, main);
    expect(files).toEqual(['src/ServerScriptService/Main~3.server.luau']);
    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'), 'utf8')).toBe('keep me');
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside');
    expect(await readFile(join(outDir, 'src', 'ServerScriptService', 'Main~3.server.luau'), 'utf8')).toBe('print(1)');
  });

  it('寫完不留暫存目錄，回報的是實際寫入的絕對路徑', async () => {
    const { written } = await new FsSnapshotStore().commit(outDir, main);
    expect(written).toEqual([
      join(outDir, 'src', 'ServerScriptService', 'Main.server.luau'),
      join(outDir, 'scene', 'place.json'),
      join(outDir, 'scene', 'scripts.json'),
    ]);
    expect((await readdir(outDir)).filter((name) => name.startsWith(STAGING_PREFIX))).toEqual([]);
  });
});
