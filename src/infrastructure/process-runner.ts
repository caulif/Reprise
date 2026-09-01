import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';

export type ProcessExitCategory = 'spawn_error' | 'stdio_disconnected' | 'nonzero_exit' | 'timed_out' | 'cancelled' | 'output_limit_exceeded';

export class ProcessBoundaryError extends Error {
  readonly operation: string;
  readonly executableKind: string;
  readonly exitCategory: ProcessExitCategory;
  readonly errnoCode: string | undefined;
  readonly exitCode: number | undefined;

  constructor(input: { operation: string; executableKind: string; exitCategory: ProcessExitCategory; errnoCode?: string; exitCode?: number }) {
    super(`Process boundary failed: ${input.operation} (${input.exitCategory.replaceAll('_', ' ')}).`);
    this.name = 'ProcessBoundaryError';
    this.operation = input.operation;
    this.executableKind = input.executableKind;
    this.exitCategory = input.exitCategory;
    this.errnoCode = input.errnoCode;
    this.exitCode = input.exitCode;
  }
}

export type ProcessResult = { stdout: string; stderr: string; exitCode: number; outputTruncated: boolean };
export type ProcessSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Runs a local command without letting child-process or pipe errors escape as unhandled events.
 * Diagnostics intentionally contain categories only; callers must not persist cwd, arguments, or raw stderr.
 */
export async function runProcess(input: {
  operation: string;
  executableKind: string;
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  truncateOutput?: boolean;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  killTree?: boolean;
  signal?: AbortSignal;
  spawnProcess?: ProcessSpawner;
  /** Return nonzero exit codes as ordinary results for tools such as shell. */
  allowNonzeroExit?: boolean;
}): Promise<ProcessResult> {
  const start = input.spawnProcess ?? spawn;
  const child = start(input.command, input.args, {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    windowsHide: true,
    shell: input.shell ?? false,
    ...(input.env ? { env: input.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maxOutputBytes = input.maxOutputBytes ?? 262_144;
  const output = { bytes: 0, truncated: false };

  return new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const finish = (error?: ProcessBoundaryError, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const boundary = (exitCategory: ProcessExitCategory, error?: unknown) => {
      const code = errnoCode(error);
      return finish(new ProcessBoundaryError({
        operation: input.operation,
        executableKind: input.executableKind,
        exitCategory,
        ...(code ? { errnoCode: code } : {}),
      }));
    };
    const abort = () => {
      cancelled = true;
      terminateChild(child, input.killTree === true);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, input.killTree === true);
    }, input.timeoutMs);
    timer.unref();
    attachProcessIo(child, input, stdout, stderr, output, maxOutputBytes, boundary);
    child.on('close', (code) => settleProcessClose(input, { timedOut, cancelled, code, stdout, stderr, truncated: output.truncated }, finish, boundary));
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
  });
}

function attachProcessIo(
  child: ChildProcess,
  input: { killTree?: boolean; truncateOutput?: boolean },
  stdout: Buffer[],
  stderr: Buffer[],
  output: { bytes: number; truncated: boolean },
  maxOutputBytes: number,
  boundary: (exitCategory: ProcessExitCategory, error?: unknown) => unknown,
): void {
  child.on('error', (error) => boundary('spawn_error', error));
  const collect = (target: Buffer[], chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    const remaining = maxOutputBytes - output.bytes;
    if (remaining <= 0) {
      output.truncated = true;
      if (!input.truncateOutput) {
        terminateChild(child, input.killTree === true);
        boundary('output_limit_exceeded');
      }
      return;
    }
    const accepted = buffer.subarray(0, remaining);
    target.push(accepted);
    output.bytes += accepted.byteLength;
    if (accepted.byteLength < buffer.byteLength) {
      output.truncated = true;
      if (!input.truncateOutput) {
        terminateChild(child, input.killTree === true);
        boundary('output_limit_exceeded');
      }
    }
  };
  child.stdin?.on('error', (error) => boundary('stdio_disconnected', error));
  child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
  child.stderr?.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
  child.stdout?.on('error', (error) => boundary('stdio_disconnected', error));
  child.stderr?.on('error', (error) => boundary('stdio_disconnected', error));
  child.stdin?.end();
}

function settleProcessClose(
  input: { operation: string; executableKind: string; allowNonzeroExit?: boolean },
  state: { timedOut: boolean; cancelled: boolean; code: number | null; stdout: Buffer[]; stderr: Buffer[]; truncated: boolean },
  finish: (error?: ProcessBoundaryError, result?: ProcessResult) => void,
  boundary: (exitCategory: ProcessExitCategory) => unknown,
): void {
  if (state.timedOut) { boundary('timed_out'); return; }
  if (state.cancelled) { boundary('cancelled'); return; }
  if (state.code !== 0 && !input.allowNonzeroExit) {
    finish(new ProcessBoundaryError({
      operation: input.operation, executableKind: input.executableKind, exitCategory: 'nonzero_exit',
      ...(typeof state.code === 'number' ? { exitCode: state.code } : {}),
    }));
    return;
  }
  finish(undefined, {
    stdout: Buffer.concat(state.stdout).toString('utf8'),
    stderr: Buffer.concat(state.stderr).toString('utf8'),
    exitCode: typeof state.code === 'number' ? state.code : 0,
    outputTruncated: state.truncated,
  });
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

export function windowsTaskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'taskkill.exe');
}

function terminateChild(child: ChildProcess, killTree: boolean): void {
  if (!killTree || process.platform !== 'win32' || child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn(windowsTaskkillExecutable(), ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  killer.once('error', () => child.kill());
  killer.once('close', () => { if (!child.killed) child.kill(); });
}
