import { isAbsolute, resolve } from 'node:path';

const WINDOWS_ABS = /^[A-Za-z]:[\\/]|^\\\\/;

/** True for POSIX/Windows host absolutes and for Windows drive/UNC paths on any host. */
export function isFsAbsolute(path: string): boolean {
  return isAbsolute(path) || WINDOWS_ABS.test(path);
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

/** Relative path from `root` to `target` using `/`, or undefined if target is outside root. */
export function relativeInside(root: string, target: string): string | undefined {
  if (!pathContainedBy(root, target)) return undefined;
  const base = compareKey(root);
  const next = compareKey(target);
  if (next === base) return '';
  return asPosixPath(target).replace(/\/+$/, '').slice(base.length + 1);
}

function compareKey(value: string): string {
  const posix = asPosixPath(value).replace(/\/+$/, '');
  if (WINDOWS_ABS.test(posix) || posix.startsWith('//')) return posix.toLowerCase();
  return asPosixPath(resolve(value)).replace(/\/+$/, '').toLowerCase();
}
