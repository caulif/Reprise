import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { assertSafeLogicalPath } from '../products/shared/historical-artifact-files.js';

const execute = promisify(execFile);
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const gitArgs = (repository: string, args: string[]) => ['--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.longpaths=true', '-C', repository, ...args];
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return { ...env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '0' };
}

export type CapturedGitFile = { logicalPath: string; bytes: Buffer; executable: boolean };

async function git(repository: string, args: string[], maxBuffer = MAX_FILE): Promise<Buffer> {
  const result = await execute('git', gitArgs(repository, args), {
    encoding: 'buffer', maxBuffer, timeout: 60_000, windowsHide: true,
    env: gitEnvironment(),
  }).catch(() => { throw new Error('Historical Git capture failed; commit objects must be available locally.'); });
  return result.stdout;
}

export async function captureGitTree(repository: string, commit: string): Promise<{ commit: string; tree: string; files: CapturedGitFile[] }> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('A full lowercase commit object ID is required.');
  if ((await git(repository, ['cat-file', '-t', commit])).toString().trim() !== 'commit') throw new Error('Historical endpoint is not a commit.');
  const tree = (await git(repository, ['rev-parse', `${commit}^{tree}`])).toString().trim();
  const listing = await git(repository, ['ls-tree', '-rlz', '--full-tree', commit], 4 * 1024 * 1024);
  const text = listing.toString('utf8');
  if (!Buffer.from(text).equals(listing)) throw new Error('Git paths are not valid UTF-8.');
  const entries = text.split('\0').filter(Boolean);
  if (entries.length > 4096) throw new Error('Historical tree exceeds the supported file budget.');
  const seen = new Set<string>();
  let total = 0;
  const planned = entries.map(row => {
    const match = row.match(/^(\d{6}) (\w+) ([a-f0-9]+)\s+([0-9]+|-)\t([\s\S]+)$/);
    if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1]!)) throw new Error('Historical tree contains unsupported links or gitlinks.');
    const logicalPath = match[5]!;
    assertCapturePath(logicalPath);
    const key = logicalPath.toLowerCase();
    if (seen.has(key)) throw new Error('Historical tree has case-conflicting paths.');
    seen.add(key);
    const size = Number(match[4]);
    total += size;
    if (size > MAX_FILE || total > MAX_TOTAL) throw new Error('Historical tree exceeds the byte budget.');
    return { logicalPath, object: match[3]!, size, executable: match[1] === '100755' };
  });
  if (!planned.length) return { commit, tree, files: [] };
  const packed = await new Promise<Buffer>((resolve, reject) => {
    const child = execFile('git', gitArgs(repository, ['cat-file', '--batch']), {
      encoding: 'buffer', maxBuffer: total + planned.length * 200, timeout: 60_000, windowsHide: true, env: gitEnvironment(),
    }, (error, stdout) => error ? reject(new Error('Historical Git blob batch failed.')) : resolve(stdout));
    child.stdin!.on('error', () => reject(new Error('Historical Git blob input failed.')));
    child.stdin!.end(planned.map(entry => entry.object).join('\n') + '\n');
  });
  const files: CapturedGitFile[] = [];
  let offset = 0;
  for (const entry of planned) {
    const end = packed.indexOf(10, offset);
    if (end < 0 || packed.subarray(offset, end).toString() !== `${entry.object} blob ${entry.size}`) throw new Error('Git blob identity or size mismatch.');
    const bytes = packed.subarray(end + 1, end + 1 + entry.size);
    offset = end + 1 + entry.size + 1;
    const objectHash = createHash(entry.object.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (objectHash !== entry.object || packed[offset - 1] !== 10) throw new Error('Git blob content does not match its object ID.');
    if (bytes.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error('Historical tree contains an unresolved LFS pointer.');
    files.push({ logicalPath: entry.logicalPath, bytes, executable: entry.executable });
  }
  if (offset !== packed.length) throw new Error('Unexpected trailing Git blob data.');
  return { commit, tree, files };
}

export function assertCapturePath(path: string): void {
  assertSafeLogicalPath(path);
  const parts = path.split('/');
  if (parts.some(part => /[. ]$|[\x00-\x1f]|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || /^\.git$/i.test(part) || /^(?:\.env(?:\.(?:local|production))?|auth\.json|harness-model\.json|\.credentials\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(part))) {
    throw new Error('Historical capture path is reserved, sensitive, or unsupported on Windows.');
  }
  if (path.toLowerCase() === 'manifest.json') throw new Error('Historical capture cannot replace the finals manifest.');
}
