#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Node installer layouts: Windows next to node.exe; Unix under prefix/lib. */
export function npmCliCandidates(execPath) {
  const execDir = dirname(execPath);
  return [
    join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

function existingFile(path, tried) {
  if (!path) return undefined;
  tried.push(path);
  try {
    if (existsSync(path)) return realpathSync(path);
  } catch {
    // broken symlink or unreadable candidate; keep searching
  }
  return undefined;
}

function cliFromShim(shim, tried) {
  const resolved = existingFile(shim, tried);
  return resolved?.endsWith('npm-cli.js') ? resolved : undefined;
}

function cliFromPathEnv(tried) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const fromShim = cliFromShim(join(dir, 'npm'), tried);
    if (fromShim) return fromShim;
    const unixLayout = join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const winLayout = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const hit = existingFile(unixLayout, tried) ?? existingFile(winLayout, tried);
    if (hit) return hit;
  }
  return undefined;
}

/** Locate npm-cli.js without spawning `npm.cmd` (Windows `shell:false`). */
export function resolveNpmCliJs(execPath = process.execPath) {
  const tried = [];
  if (execPath === process.execPath) {
    const envHit = existingFile(process.env.npm_execpath, tried);
    if (envHit) return envHit;
  }
  for (const candidate of npmCliCandidates(execPath)) {
    const hit = existingFile(candidate, tried);
    if (hit) return hit;
  }
  const bundled = join(dirname(execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const fromBundled = cliFromShim(bundled, tried);
  if (fromBundled) return fromBundled;
  if (execPath === process.execPath) {
    const fromPath = cliFromPathEnv(tried);
    if (fromPath) return fromPath;
  }
  throw new Error(`Cannot locate npm-cli.js next to ${execPath}. Tried: ${tried.join(', ')}`);
}

export function selfTestNpmCli() {
  const candidates = npmCliCandidates(join('prefix', 'bin', 'node'));
  const unixLayout = candidates.find((path) => path.includes(join('lib', 'node_modules', 'npm')));
  const winLayout = candidates.find((path) => path.includes(join('bin', 'node_modules', 'npm')));
  if (!unixLayout) throw new Error('npm-cli 候选必须包含 Unix hostedtoolcache 的 lib/node_modules/npm');
  if (!winLayout) throw new Error('npm-cli 候选必须包含 Windows hostedtoolcache 的 node.exe 旁 node_modules/npm');
  if (winLayout.includes(`${sep}lib${sep}`)) throw new Error('Windows 候选不得走 lib/node_modules');

  const root = join(tmpdir(), `reprise-npm-cli-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  try {
    const winNode = join(root, 'win', 'node.exe');
    const winCli = join(root, 'win', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(dirname(winCli), { recursive: true });
    writeFileSync(winNode, '');
    writeFileSync(winCli, 'ok\n');
    if (resolveNpmCliJs(winNode) !== realpathSync(winCli)) {
      throw new Error('Windows hostedtoolcache 布局必须解析到 npm-cli.js');
    }

    const unixNode = join(root, 'unix', 'bin', 'node');
    const unixCli = join(root, 'unix', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(dirname(unixNode), { recursive: true });
    mkdirSync(dirname(unixCli), { recursive: true });
    writeFileSync(unixNode, '');
    writeFileSync(unixCli, 'ok\n');
    if (resolveNpmCliJs(unixNode) !== realpathSync(unixCli)) {
      throw new Error('Unix hostedtoolcache 布局必须解析到 npm-cli.js');
    }

    const savedExecpath = process.env.npm_execpath;
    process.env.npm_execpath = unixCli;
    try {
      if (resolveNpmCliJs(winNode) !== realpathSync(winCli)) {
        throw new Error('假节点树不得被 npm_execpath 抢先匹配');
      }
    } finally {
      if (savedExecpath === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = savedExecpath;
    }

    const winOnlyOnUnix = npmCliCandidates(unixNode)[0];
    if (winOnlyOnUnix && existsSync(winOnlyOnUnix)) {
      throw new Error('Unix 树不得满足仅 Windows 的 bin/node_modules/npm 候选');
    }
    resolveNpmCliJs();
    console.log('npm-cli self-test: Windows/Unix hostedtoolcache 布局可解析；仅 Windows 候选找不到 Unix npm-cli.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  selfTestNpmCli();
}
