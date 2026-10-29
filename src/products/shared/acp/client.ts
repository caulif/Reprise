import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { record, text } from '../../../core/json.js';
import { DEFAULT_RUNTIME_RPC_TIMEOUT_MS, positiveTimeout, spawnRuntimeProcess } from '../../../infrastructure/process/spawn.js';
import { summarizeDiagnostic } from '../../../infrastructure/process/stdio.js';
import { forceCloseRuntimeProcess } from '../../../infrastructure/process/terminate.js';

export class AcpUnavailableError extends Error {
  readonly code = 'unsupported_runtime';
  constructor(message: string) {
    super(message);
    this.name = 'AcpUnavailableError';
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** ACP answers permission requests with either a selected option or a cancellation. */
export type AcpPermissionDecision = { optionId: string } | { cancelled: true };

export type AcpClientOptions = {
  executable: string;
  args: readonly string[];
  cwd: string;
  completeEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  onClosed?: (error: Error) => void;
  /** Automation clients must answer permission requests; an unanswered request blocks the turn. */
  decidePermission?: (request: Record<string, unknown>) => AcpPermissionDecision;
};

const METHOD_NOT_FOUND = -32601;

/**
 * JSON-RPC 2.0 over stdio with newline-delimited framing, as ACP transports require.
 * Inbound agent requests other than permission prompts are refused: this client advertises
 * no file-system, terminal, or elicitation capability, so the agent must use its own tools.
 */
export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #exit: Promise<void> = Promise.resolve();
  #buffer = '';
  #stderrSummary = '';
  #nextRequestId = 1;
  #requestTimeoutMs: number;
  #closed = false;
  #closeNotified = false;

  constructor(options: AcpClientOptions) {
    this.#options = options;
    this.#requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_RUNTIME_RPC_TIMEOUT_MS);
  }

  get running(): boolean {
    return this.#child !== undefined && !this.#closed;
  }

  setRequestTimeout(milliseconds: number): void {
    this.#requestTimeoutMs = positiveTimeout(milliseconds, this.#requestTimeoutMs);
  }

  start(): void {
    if (this.#closed) throw new AcpUnavailableError('ACP client is closed.');
    if (this.#child) return;
    const child = spawnRuntimeProcess(this.#options.executable, this.#options.args, {
      cwd: this.#options.cwd,
      ...(this.#options.completeEnv ? { completeEnv: this.#options.completeEnv } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#exit = new Promise<void>((resolveExit) => {
      child.once('close', () => resolveExit());
      child.once('error', () => resolveExit());
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onChunk(chunk));
    child.stdin.on('error', () => {
      // Swallowed: a write to the agent's already-closed stdin must not crash the host process.
    });
    child.stdout.on('error', (error: Error) => this.#fail(new AcpUnavailableError(`ACP agent stdout failed: ${error.message}`)));
    child.stderr.on('error', () => {
      // Swallowed: stderr carries diagnostics only, so a broken diagnostic pipe is not a protocol failure.
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Redacted and bounded like the Codex adapter: an unread pipe blocks a chatty agent, and stderr reaches the Journal.
      this.#stderrSummary = summarizeDiagnostic(`${this.#stderrSummary} ${chunk}`, 400);
    });
    child.on('error', (error: Error) => this.#fail(new AcpUnavailableError(`ACP agent failed to start: ${error.message}`)));
    child.once('close', (code: number | null) => this.#fail(new AcpUnavailableError(`ACP agent exited (code ${code ?? 'unknown'})${this.#stderrSummary ? `: ${this.#stderrSummary}` : ''}.`)));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.running) throw new AcpUnavailableError('ACP client is not running.');
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AcpUnavailableError(`ACP request ${method} timed out.`));
        // A process that survives its own shutdown is a leak the operator has to know about.
        void this.close().catch((error: unknown) => this.#fail(asError(error)));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#write({ jsonrpc: '2.0', id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    if (!this.running) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    const child = this.#child;
    this.#closed = true;
    this.#rejectPending(new AcpUnavailableError('ACP client closed.'));
    if (!child) return;
    child.stdin.end();
    await forceCloseRuntimeProcess(child, this.#exit, () => new AcpUnavailableError('ACP agent did not close after forced termination.'));
  }

  #write(frame: Record<string, unknown>): void {
    this.#child?.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #onChunk(chunk: string): void {
    this.#buffer += chunk;
    for (let end = this.#buffer.indexOf('\n'); end >= 0; end = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (line) this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON stdout noise is not a protocol frame; the agent owns that stream and the turn
      // settlement still arrives through session/prompt.
      return;
    }
    if (Array.isArray(parsed)) {
      for (const frame of parsed) this.#onFrame(frame);
      return;
    }
    this.#onFrame(parsed);
  }

  #onFrame(parsed: unknown): void {
    const frame = record(parsed);
    const id = typeof frame.id === 'number' ? frame.id : undefined;
    const method = text(frame.method);
    if (id !== undefined && method) {
      this.#onAgentRequest(id, method, frame.params);
      return;
    }
    if (id !== undefined) {
      this.#settleRequest(id, frame);
      return;
    }
    if (method) this.#options.onNotification?.(method, frame.params);
  }

  #settleRequest(id: number, frame: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = record(frame.error);
    if (Object.keys(error).length) {
      // The agent's error text reaches the run outcome and Journal through this message, so redact it like stderr.
      pending.reject(new AcpUnavailableError(`ACP request failed: ${summarizeDiagnostic(text(error.message) ?? 'unknown error')}.`));
      return;
    }
    pending.resolve(frame.result);
  }

  #onAgentRequest(id: number, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      this.#write({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `Reprise does not serve ${method}.` } });
      return;
    }
    const request = record(params);
    const decision = (this.#options.decidePermission ?? allowFirstOption)(request);
    this.#write({
      jsonrpc: '2.0',
      id,
      result: 'cancelled' in decision
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: decision.optionId } },
    });
  }

  #fail(error: Error): void {
    this.#closed = true;
    this.#rejectPending(error);
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#options.onClosed?.(error);
  }

  #rejectPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

/** Automation default: take the first allow option, otherwise cancel instead of blocking. */
export function allowFirstOption(request: Record<string, unknown>): AcpPermissionDecision {
  const options = Array.isArray(request.options) ? request.options : [];
  const allow = options.map((option) => record(option)).find((option) => (text(option.kind) ?? '').startsWith('allow'));
  const optionId = allow ? text(allow.optionId) : undefined;
  return optionId ? { optionId } : { cancelled: true };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new AcpUnavailableError(String(value));
}
