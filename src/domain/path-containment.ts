import path, { type PlatformPath } from 'node:path';

/**
 * target 是否落在 root 之內（含 root 本身）。
 *
 * 純字串運算，不碰檔案系統；symlink／junction 要由呼叫端先把兩邊都 realpath 再丟進來。
 * `impl` 可換成 `path.win32`／`path.posix`，讓 Windows 的語意在任何平台都測得到。
 *
 * 🔴 不能只看 `rel.startsWith('..')`：Windows 跨磁碟（`C:` 對 `D:`）或碰到 UNC 時，
 * `path.relative()` 回的是**絕對路徑**，不以 `..` 開頭，舊版就這樣把 `D:\` 放行了。
 * 只看前綴也會誤擋 `..foo` 這種合法檔名，所以比的是 `..` 這一整段。
 */
export function isPathInside(root: string, target: string, impl: PlatformPath = path): boolean {
  const rel = impl.relative(root, target);
  if (rel === '') return true;
  return !impl.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${impl.sep}`);
}
