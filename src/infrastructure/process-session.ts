import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ManagedProcessSession, ManagedProcessSnapshot } from '../core/runtime.js';
import { ProcessBoundaryError, type ProcessSpawner } from './process-runner.js';
import { spawnCancelOptions, terminateProcessTree } from './platform.js';
import { spawnRuntimeProcess, settlesWithin } from './process/spawn.js';
import { processOutputLog } from './process-output-log.js';
import { processOutputRedactor } from './process-output-redactor.js';

export type ProcessSessionInput = {
  command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv;
  signal: AbortSignal; spawnProcess?: ProcessSpawner; outputLogPath?: string; createOutputLog?: typeof processOutputLog;
};

export function startProcessSession(input: ProcessSessionInput): ManagedProcessSession {
  input.signal.throwIfAborted();
  const spawn = input.spawnProcess ?? spawnRuntimeProcess;
  return new PipeProcessSession(spawn(input.command, input.args, {
    ...spawnCancelOptions(true), cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'],
  }), input.signal, input.outputLogPath, input.createOutputLog);
}

class PipeProcessSession implements ManagedProcessSession {
  #state: ManagedProcessSnapshot['state'] = 'running';
  #output: Buffer = Buffer.alloc(0);
  #pendingOutput: Buffer[] = [];
  #pendingBytes = 0;
  #truncated = false;
  #redactionTruncated = false;
  #exitCode: number | undefined;
  #failure: Error | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #closed: Promise<void>;
  #processClosed: Promise<void>;
  #cancelRequested = false;
  readonly #child: ChildProcess;
  #cancel: Promise<void> | undefined;
  #rootClosed = false;
  #log: ReturnType<typeof processOutputLog> | undefined;

  constructor(child: ChildProcess, signal: AbortSignal, outputLogPath?: string, createOutputLog = processOutputLog) {
    this.#child = child;
    const log = outputLogPath ? createOutputLog(outputLogPath, error => {
      this.#failure ??= new Error('Process output log persistence failed.', { cause: error });
      void this.cancel().catch(() => { /* poll/drain surfaces persistence and termination failure. */ });
    }) : undefined;
    this.#log = log;
    const outputs = [child.stdout, child.stderr].map(() => processOutputRedactor(text => {
      const bytes = Buffer.from(text); log?.append(bytes); this.#collect(bytes);
    }));
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const abort = () => { void this.cancel().catch(() => { /* poll/drain surfaces termination uncertainty. */ }); };
    let processClosed!: () => void;
    this.#processClosed = new Promise(resolve => { processClosed = resolve; });
    this.#closed = new Promise(resolve => child.once('close', code => {
      this.#rootClosed = true;
      this.#state = 'flushing';
      processClosed();
      this.#exitCode = typeof code === 'number' ? code : undefined;
      signal.removeEventListener('abort', abort);
      for (const [index, output] of outputs.entries()) {
        output.append(decoders[index]!.end());
        output.finish();
        this.#redactionTruncated ||= output.truncated;
      }
      void (async () => {
        try { await log?.finish(); }
        catch (error) { this.#failure ??= new Error('Process output log persistence failed.', { cause: error }); }
        this.#state = this.#failure ? 'failed' : this.#cancelRequested ? 'cancelled' : 'completed';
        resolve();
      })();
    }));
    const failure = (category: 'spawn_error' | 'stdio_disconnected') => {
      this.#failure ??= new ProcessBoundaryError({ operation: 'exec_command', executableKind: 'shell', exitCategory: category });
      void this.cancel().catch(() => { /* poll/drain surfaces termination uncertainty. */ });
    };
    child.on('error', () => failure('spawn_error'));
    child.stdin?.on('error', () => failure('stdio_disconnected'));
    for (const [index, pipe] of [child.stdout, child.stderr].entries()) {
      pipe?.on('error', () => failure('stdio_disconnected'));
      pipe?.on('data', (chunk: Buffer | string) => {
        const output = outputs[index]!;
        output.append(decoders[index]!.write(Buffer.from(chunk)));
        this.#redactionTruncated ||= output.truncated;
      });
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }

  get state(): ManagedProcessSnapshot['state'] { return this.#state; }
  get running(): boolean { return this.#state === 'running' || this.#state === 'flushing'; }
  get logTruncated(): boolean { return this.#redactionTruncated || (this.#log?.truncated ?? false); }

  #collect(chunk: Buffer): void {
    const remaining = 1_048_576 - this.#output.length - this.#pendingBytes;
    if (chunk.length > remaining) this.#truncated = true;
    let end = Math.min(chunk.length, Math.max(0, remaining));
    while (end > 0 && end < chunk.length && (chunk[end]! & 0xc0) === 0x80) end--;
    if (end > 0) {
      this.#pendingOutput.push(chunk.subarray(0, end));
      this.#pendingBytes += end;
    }
  }

  poll(waitMs: number, maxBytes: number, chars = ''): Promise<ManagedProcessSnapshot> {
    const next = this.#chain.then(async () => {
      if (chars && !this.#rootClosed && this.running) this.#child.stdin?.write(chars);
      if (this.running && waitMs > 0) await settlesWithin(this.#closed, waitMs);
      if (this.#failure) throw this.#failure;
      if (this.#pendingBytes > 0) {
        this.#output = Buffer.concat([this.#output].concat(this.#pendingOutput), this.#output.length + this.#pendingBytes);
        this.#pendingOutput = []; this.#pendingBytes = 0;
      }
      // Decode at a UTF-8 boundary so paging cannot split a multi-byte character.
      let end = Math.min(maxBytes, this.#output.length);
      while (end > 0 && end < this.#output.length && (this.#output[end]! & 0xc0) === 0x80) end--;
      const output = this.#output.subarray(0, end).toString('utf8');
      this.#output = this.#output.subarray(end);
      return { state: this.#state, output, truncated: this.#truncated || this.#redactionTruncated, remainingOutput: this.#output.length > 0,
        ...(this.#exitCode !== undefined ? { exitCode: this.#exitCode } : {}) };
    });
    this.#chain = next.catch(() => undefined);
    return next;
  }

  cancel(): Promise<void> {
    if (!this.#cancel) {
      this.#cancel = this.#terminate().then(() => { this.#cancel = undefined; });
    }
    return this.#cancel;
  }

  async #terminate(): Promise<void> {
    if (!this.running) { if (this.#failure) throw this.#failure; return; }
    if (!this.#rootClosed) {
      this.#cancelRequested = true;
      const treeTerminated = terminateProcessTree(this.#child, true);
      if (!await settlesWithin(this.#processClosed, 5_000) || !treeTerminated) {
        this.#failure ??= new Error('Process tree termination was not confirmed; workspace cannot be sealed.');
        throw this.#failure;
      }
    }
    // A wait window expiring while logs drain is not a process termination failure.
    await settlesWithin(this.#closed, 5_000);
    if (this.#failure) throw this.#failure;
  }
}
