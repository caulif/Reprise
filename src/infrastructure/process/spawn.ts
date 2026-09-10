import { access, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { isNativeHostPath } from '../../core/paths.js';

export const DEFAULT_RUNTIME_RPC_TIMEOUT_MS = 120_000;
export const RUNTIME_PROCESS_STOP_GRACE_MS = 5_000;
export const RUNTIME_PROCESS_CLOSE_TIMEOUT_MS = 5_000;

export function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolveWait) => { timer = setTimeout(() => resolveWait(false), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type WindowsProcessInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: true;
};

function quoteWindowsCommandToken(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/** Windows `.cmd`/`.bat` must use ComSpec `/d /s /c` with a wrapping quote pair and verbatim arguments. */
export function windowsProcessInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env.ComSpec ?? 'cmd.exe',
): WindowsProcessInvocation {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { command: executable, args: [...args] };
  }
  const commandLine = [executable, ...args].map(quoteWindowsCommandToken).join(' ');
  return {
    command: comSpec,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function spawnRuntimeProcess(
  executable: string,
  args: readonly string[],
  options: SpawnOptions & { platform?: NodeJS.Platform } = {},
): ChildProcessWithoutNullStreams {
  const { platform, env, cwd, ...spawnOptions } = options;
  const invocation = windowsProcessInvocation(executable, args, platform ?? process.platform);
  const host = platform ?? process.platform;
  return spawn(invocation.command, [...invocation.args], {
    ...spawnOptions,
    cwd,
    env: isolateCandidateProcessEnv(env, typeof cwd === 'string' ? cwd : undefined),
    shell: false,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    ...(host !== 'win32' && spawnOptions.detached === undefined ? { detached: true } : {}),
  }) as ChildProcessWithoutNullStreams;
}

const GITHUB_TOKEN_KEYS = new Set(['GITHUB_TOKEN', 'GH_TOKEN']);

/** Strips GitHub tokens and points Git at the run sink home when `cwd` is a prepared replica. */
export function isolateCandidateProcessEnv(
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  for (const key of Object.keys(next)) {
    if (GITHUB_TOKEN_KEYS.has(key.toUpperCase())) delete next[key];
  }
  if (!cwd) return next;
  const home = join(dirname(dirname(resolve(cwd))), 'git-sinks', basename(resolve(cwd)));
  const gitconfig = join(home, 'gitconfig');
  if (!existsSync(gitconfig)) return next;
  next.GIT_CONFIG_GLOBAL = gitconfig;
  next.GIT_CONFIG_SYSTEM = join(home, 'missing-system-gitconfig');
  next.GIT_CONFIG_NOSYSTEM = '1';
  return next;
}

export type ExecutableDiscovery = {
  readonly command: string;
  readonly envKey?: string;
  readonly executable?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly pathExt?: string;
};

export async function discoverExecutable(input: ExecutableDiscovery): Promise<string | undefined> {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const configured = input.executable?.trim() || (input.envKey ? env[input.envKey]?.trim() : undefined);
  const candidates = configured
    ? configuredCandidates(configured, env.PATH, input.cwd ?? process.cwd(), platform, input.pathExt)
    : pathCandidates(input.command, env.PATH, platform, input.pathExt);
  for (const candidate of candidates) {
    if (!isNativeHostPath(candidate, platform, env)) continue;
    if (await isFile(candidate, platform)) return candidate;
  }
  return undefined;
}

function configuredCandidates(value: string, pathValue: string | undefined, cwd: string, platform: NodeJS.Platform, pathExt?: string): string[] {
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) return withPlatformExtensions(resolve(cwd, value), platform, pathExt);
  return pathCandidates(value, pathValue, platform, pathExt);
}

function pathCandidates(command: string, pathValue: string | undefined, platform: NodeJS.Platform, pathExt?: string): string[] {
  if (!pathValue) return [];
  const extensions = platform === 'win32' ? (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const separator = platform === 'win32' ? ';' : ':';
  return pathValue.split(separator).filter(Boolean).flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension}`)));
}

function withPlatformExtensions(path: string, platform: NodeJS.Platform, pathExt?: string): string[] {
  if (platform !== 'win32' || extname(path)) return [path];
  return [path, ...(pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => `${path}${extension}`)];
}

async function isFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    const info = await stat(path);
    return info.isFile() && (platform === 'win32' || (info.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
