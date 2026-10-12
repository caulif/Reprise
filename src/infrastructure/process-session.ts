import type { ChildProcess } from 'node:child_process';
import type { ManagedProcessSession, ManagedProcessSnapshot } from '../core/runtime.js';
import { ProcessBoundaryError, type ProcessSpawner } from './process-runner.js';
import { spawnCancelOptions, terminateProcessTree } from './platform.js';
import { spawnRuntimeProcess, settlesWithin } from './process/spawn.js';
import { processOutputLog } from './process-output-log.js';

export type ProcessSessionInput = {
  command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; spawnProcess?: ProcessSpawner; outputLogPath?: string;
};

export function startProcessSession(input: ProcessSessionInput): ManagedProcessSession {
  input.signal.throwIfAborted();
  const spawn = input.spawnProcess ?? spawnRuntimeProcess;
  return new PipeProcessSession(spawn(input.command, input.args, {
    ...spawnCancelOptions(true), cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
  }), input.signal, input.outputLogPath);
}

class PipeProcessSession implements ManagedProcessSession {
  #state: ManagedProcessSnapshot['state'] = 'running';
  #output = Buffer.alloc(0);
  #truncated = false;
  #exitCode: number | undefined;
  #failure: Error | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #closed: Promise<void>;
  readonly #child: ChildProcess;
  #cancel: Promise<void> | undefined;
  #rootClosed = false;
  #log: ReturnType<typeof processOutputLog> | undefined;

  constructor(child: ChildProcess, signal: AbortSignal, outputLogPath?: string) {
    this.#child = child;
    const log = outputLogPath ? processOutputLog(outputLogPath, error => {
      this.#failure ??= new Error('Process output log persistence failed.', { cause: error });
      void this.cancel().catch(() => { /* poll/drain surfaces persistence and termination failure. */ });
    }) : undefined;
    this.#log = log;
    const abort = () => { void this.cancel().catch(() => { /* poll/drain surfaces termination uncertainty. */ }); };
    this.#closed = new Promise(resolve => child.once('close', code => {
      this.#rootClosed = true;
      this.#exitCode = typeof code === 'number' ? code : undefined;
      signal.removeEventListener('abort', abort);
      void (async () => {
        try { await log?.finish(); }
        catch (error) { this.#failure ??= new Error('Process output log persistence failed.', { cause: error }); }
        if (this.#state === 'running') this.#state = this.#failure ? 'failed' : 'completed';
        resolve();
      })();
    }));
    const failure = (category: 'spawn_error' | 'stdio_disconnected') => {
      this.#failure ??= new ProcessBoundaryError({ operation: 'exec_command', executableKind: 'shell', exitCategory: category });
      void this.cancel().catch(() => { /* poll/drain surfaces termination uncertainty. */ });
    };
    child.on('error', () => failure('spawn_error'));
    child.stdin?.on('error', () => failure('stdio_disconnected'));
    for (const pipe of [child.stdout, child.stderr]) {
      pipe?.on('error', () => failure('stdio_disconnected'));
      pipe?.on('data', (chunk: Buffer | string) => { const bytes = Buffer.from(chunk); log?.append(bytes); this.#collect(bytes); });
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }

  get running(): boolean { return this.#state === 'running'; }
  get logTruncated(): boolean { return this.#log?.truncated ?? false; }

  #collect(chunk: Buffer): void {
    const remaining = 1_048_576 - this.#output.length;
    if (chunk.length > remaining) this.#truncated = true;
    this.#output = Buffer.concat([this.#output, chunk.subarray(0, Math.max(0, remaining))]);
  }

  poll(waitMs: number, maxBytes: number, chars = ''): Promise<ManagedProcessSnapshot> {
    const next = this.#chain.then(async () => {
      if (chars && this.running) this.#child.stdin?.write(chars);
      if (this.running && waitMs > 0) await settlesWithin(this.#closed, waitMs);
      if (this.#failure) throw this.#failure;
      // Decode at a UTF-8 boundary so paging cannot split a multi-byte character.
      let end = Math.min(maxBytes, this.#output.length);
      while (end > 0 && end < this.#output.length && (this.#output[end]! & 0xc0) === 0x80) end--;
      const output = this.#output.subarray(0, end).toString('utf8');
      this.#output = this.#output.subarray(end);
      return { state: this.#state, output, truncated: this.#truncated, remainingOutput: this.#output.length > 0,
        ...(this.#exitCode !== undefined ? { exitCode: this.#exitCode } : {}) };
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  cancel(): Promise<void> {
    this.#cancel ??= this.#terminate();
    return this.#cancel;
  }

  async #terminate(): Promise<void> {
    if (!this.running) { if (this.#failure) throw this.#failure; return; }
    const treeTerminated = this.#rootClosed || terminateProcessTree(this.#child, true);
    if (!await settlesWithin(this.#closed, 5_000)) {
      this.#failure ??= new Error('Process tree termination was not confirmed; workspace cannot be sealed.');
      throw this.#failure;
    }
    if (!treeTerminated) {
      this.#failure ??= new Error('Process tree termination was not confirmed; workspace cannot be sealed.');
      throw this.#failure;
    }
    if (this.#failure) this.#state = 'failed';
    else this.#state = 'cancelled';
  }
}
