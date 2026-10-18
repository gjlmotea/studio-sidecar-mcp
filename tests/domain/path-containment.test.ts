import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isPathInside } from '../../src/domain/path-containment.js';

const win = path.win32;

describe('isPathInside (win32 semantics)', () => {
  it('🔴 跨磁碟：C:\\uploads 不能放行 D:\\ 底下的檔案', () => {
    // path.win32.relative() 跨磁碟時回的是絕對路徑（不以 .. 開頭），只看 .. 會放行。
    expect(isPathInside('C:\\uploads', 'C:\\uploads\\cube.fbx', win)).toBe(true);
    expect(isPathInside('C:\\uploads', 'c:\\Uploads\\cube.fbx', win)).toBe(true);
    expect(isPathInside('C:\\uploads', 'D:\\private\\photo.png', win)).toBe(false);
    expect(isPathInside('C:\\uploads', 'D:\\uploads\\photo.png', win)).toBe(false);
  });

  it('🔴 UNC 路徑不在本機根目錄底下', () => {
    expect(isPathInside('C:\\uploads', '\\\\server\\share\\photo.png', win)).toBe(false);
    expect(isPathInside('C:\\uploads', '\\\\server\\share\\uploads\\photo.png', win)).toBe(false);
  });

  it('🔴 根目錄在一個 share 上時，另一個 share 的檔案不算在內', () => {
    const root = '\\\\server\\share\\uploads';
    expect(isPathInside(root, '\\\\server\\share\\uploads\\photo.png', win)).toBe(true);
    expect(isPathInside(root, '\\\\server\\other\\uploads\\photo.png', win)).toBe(false);
    expect(isPathInside(root, '\\\\other\\share\\uploads\\photo.png', win)).toBe(false);
    expect(isPathInside('\\\\server\\share', '\\\\other\\share\\photo.png', win)).toBe(false);
  });
});
