import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extname, isAbsolute, join, resolve } from 'node:path';

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:api[_-]?key|authorization|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/-]{8,}=*/gi,
];

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

export async function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGKILL');
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  await new Promise<void>((resolveWait) => spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).once('close', () => resolveWait()));
}

/** Target stderr is persisted verbatim into the run journal, so credentials must never survive the trip. */
export function redactDiagnostic(value: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), value);
}

export function summarizeDiagnostic(value: string, limit = 240): string {
  const flattened = value.replace(/https?:\/\/[^\s]+/gi, '[endpoint]').replace(/[\r\n\t]/g, ' ');
  return redactDiagnostic(flattened).slice(0, limit);
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
