import { isAbsolute, resolve } from 'node:path';

const WINDOWS_ABS = /^[A-Za-z]:[\\/]|^\\\\/;

/** Map `\\?\C:\...` / `\\?\UNC\...` to the ordinary Windows path used for containment. */
export function stripWindowsExtendedPrefix(path: string): string {
  const posix = asPosixPath(path.trim());
  if (/^\/\/\?\/unc\//i.test(posix)) return `//${posix.slice(8)}`;
  if (/^\/\/\?\//.test(posix)) return posix.slice(4);
  return path;
}

/** True for POSIX/Windows host absolutes and for Windows drive/UNC paths on any host. */
export function isFsAbsolute(path: string): boolean {
  const value = stripWindowsExtendedPrefix(path);
  return isAbsolute(value) || WINDOWS_ABS.test(value);
}

export function asPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Whether `target` is `root` or a descendant. Windows drive paths stay drive paths
 * on POSIX hosts so `C:/source` is not treated as `process.cwd()/C:/source`.
 */
export function pathContainedBy(root: string, target: string): boolean {
  const base = compareKey(root);
  const next = compareKey(target);
  return next === base || next.startsWith(`${base}/`);
}

/** True when both recorded paths name the same file after host-independent normalization. */
export function sameFsPath(left: string, right: string): boolean {
  return pathContainedBy(left, right) && pathContainedBy(right, left);
}

/** Relative path from `root` to `target` using `/`, or undefined if target is outside root. */
export function relativeInside(root: string, target: string): string | undefined {
  if (!pathContainedBy(root, target)) return undefined;
  const base = compareKey(root);
  const next = compareKey(target);
  if (next === base) return '';
  return asPosixPath(stripWindowsExtendedPrefix(target)).replace(/\/+$/, '').slice(base.length + 1);
}

function compareKey(value: string): string {
  const posix = asPosixPath(stripWindowsExtendedPrefix(value)).replace(/\/+$/, '');
  if (WINDOWS_ABS.test(posix) || posix.startsWith('//')) return posix.toLowerCase();
  return asPosixPath(resolve(posix)).replace(/\/+$/, '').toLowerCase();
}

/** Absolute Windows/POSIX recorded roots only. Relative cwd cannot identify a workspace. */
export function canonicalRecordedRoot(path: string | undefined): string | undefined {
  const value = stripWindowsExtendedPrefix(path?.trim() ?? '');
  if (!value || !isFsAbsolute(value)) return undefined;
  return asPosixPath(value).replace(/\/+$/, '').toLowerCase();
}
