import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256 } from '../core/identity.js';
import type { RecoveryGitStart } from '../core/schema.js';
import { runProcess } from '../infrastructure/process-runner.js';
import { assertNoSymlinkAncestors, recoveryPath } from './local-workspace-fs.js';

export function assertGitStartPaths(start: RecoveryGitStart): void {
  const paths = new Set<string>();
  for (const input of start.inputs) {
    const segments = input.path.split('/');
    if (input.path.includes('\\') || segments.some((part) => !part || /[<>:"|?*\u0000-\u001f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) ||
        segments.some((part) => part.toLowerCase() === '.git') || segments[0]?.toLowerCase() === '.reprise' ||
        input.path.toLowerCase() === 'recovery.md')
      throw new Error('Git start input must be a regular task file outside Harness/Git metadata.');
    const key = input.path.toLowerCase();
    if (paths.has(key)) throw new Error('Git start input paths must be unique.');
    paths.add(key);
  }
}

/** Builds only the confirmed commit's ancestry and explicitly hashed input files, never future answers. */
export async function materializeGitStart(source: string, target: string, start: RecoveryGitStart, signal?: AbortSignal): Promise<void> {
  assertGitStartPaths(start);
  signal?.throwIfAborted();
  const inputs = await readInputs(source, start);
  const gitInfo = await lstat(join(source, '.git'));
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink()) throw new Error('Git start requires an isolated, materialized repository.');
  await mkdir(target);
  const git = gitCommand(target, signal);
  await git(['init', '--template=']);
  await git(['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-recurse-submodules', source, start.commit]);
  const commit = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  if (commit !== start.commit) throw new Error('Git start commit did not resolve to the confirmed object.');
  const tree = await git(['ls-tree', '-rz', start.commit]);
  if (tree.split('\0').some((entry) => /^(120000|160000) /.test(entry)))
    throw new Error('Git start with symlinks or submodules requires investigated Recovery.');
  await git(['checkout', '--detach', start.commit]);
  await rejectLfsAttributes(target, tree);
  for (const input of inputs) {
    signal?.throwIfAborted();
    const path = recoveryPath(target, input.path);
    await assertNoSymlinkAncestors(target, input.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.bytes);
  }
  signal?.throwIfAborted();
}

async function readInputs(source: string, start: RecoveryGitStart): Promise<{ path: string; bytes: Buffer }[]> {
  const inputs: { path: string; bytes: Buffer }[] = [];
  for (const input of start.inputs) {
    await assertNoSymlinkAncestors(source, input.path);
    const path = recoveryPath(source, input.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Git start input must be a regular file.');
    const bytes = await readFile(path);
    if (sha256(bytes) !== input.sha256) throw new Error('Git start input hash does not match the confirmed input.');
    inputs.push({ path: input.path, bytes });
  }
  return inputs;
}

async function rejectLfsAttributes(root: string, tree: string): Promise<void> {
  for (const entry of tree.split('\0').filter(Boolean)) {
    const path = entry.slice(entry.indexOf('\t') + 1);
    if (path.split('/').at(-1) !== '.gitattributes') continue;
    if (/filter\s*=\s*lfs/.test(await readFile(recoveryPath(root, path), 'utf8')))
      throw new Error('Git start with LFS filters requires investigated Recovery.');
  }
}

function gitCommand(root: string, signal?: AbortSignal): (args: string[]) => Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return async (args) => (await runProcess({
    operation: 'recovery_git_start', executableKind: 'git', command: 'git',
    args: ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', ...args],
    cwd: root, timeoutMs: 120_000, maxOutputBytes: 8 * 1024 * 1024, killTree: true,
    env: { ...env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'missing-global-config'), GIT_ALLOW_PROTOCOL: 'file' },
    ...(signal ? { signal } : {}),
  })).stdout;
}
