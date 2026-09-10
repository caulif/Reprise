import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isRecord, record, text } from '../../../core/json.js';
import {
  runtimeTargetEvent,
  type DeliveryReceipt,
  type MessageIdentity,
  type PreparedRuntimeEnvironment,
  type ResolvedRuntime,
  type RuntimeCapabilities,
  type RuntimeStopReason,
  type TargetEventSink,
  type TargetRunner,
  type TargetStatus,
  type TurnSettlement,
  type UserMessage,
} from '../../../core/runtime.js';
import type { CandidateSessionHandle } from '../../../core/schema.js';
import { DEFAULT_RUNTIME_RPC_TIMEOUT_MS, positiveTimeout, spawnRuntimeProcess } from '../../../infrastructure/process/spawn.js';
import { forceCloseRuntimeProcess } from '../../../infrastructure/process/terminate.js';
import { summarizeDiagnostic } from '../../../infrastructure/process/stdio.js';
import { assertRuntimeMessageIdentity, TurnWaiter } from '../../shared/turn-wait.js';
import { CLAUDE_DISALLOWED_TOOLS, CLAUDE_REQUIRED_ARGS, claudeFrameEvent, claudeSettlementStatus } from './protocol.js';

type PendingControl = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };

const DEFAULT_RPC_TIMEOUT_MS = DEFAULT_RUNTIME_RPC_TIMEOUT_MS;
const NORMAL_TERMINAL = new Set(['', 'end_turn', 'completed', 'success']);

export class ClaudeRuntimeUnavailableError extends Error {
  readonly code = 'unsupported_runtime';
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeRuntimeUnavailableError';
  }
}

class ClaudeProcessCloseError extends Error {
  readonly remainingResourceIds: readonly string[];
  constructor(resourceId: string) {
    super(`Claude Code process ${resourceId} did not close after forced termination.`);
    this.name = 'ClaudeProcessCloseError';
    this.remainingResourceIds = [resourceId];
  }
}

/**
 * NDJSON + control_request/response client. Never pass --permission-prompt-tool:
 * that flag is the master switch for blocking can_use_tool control requests.
 */
export class ClaudeStreamClient {
  readonly #executable: string;
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #args: readonly string[];
  readonly #onFrame: ((frame: Record<string, unknown>) => Promise<void>) | undefined;
  readonly #onClosed: ((error: Error) => void) | undefined;
  #process: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #pending = new Map<string, PendingControl>();
  #requestTimeoutMs: number;
  #closed = false;
  #closedNotified = false;
  #exit$ = Promise.resolve();
  #replay: { uuid: string; resolve: (frame: Record<string, unknown>) => void } | undefined;

  constructor(input: {
    executable: string;
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    args?: readonly string[];
    requestTimeoutMs?: number;
    onFrame?: (frame: Record<string, unknown>) => Promise<void>;
    onClosed?: (error: Error) => void;
  }) {
    this.#executable = input.executable;
    this.#cwd = input.cwd;
    this.#env = { ...process.env, ...input.env };
    this.#args = input.args ?? [...CLAUDE_REQUIRED_ARGS];
    this.#requestTimeoutMs = positiveTimeout(input.requestTimeoutMs, DEFAULT_RPC_TIMEOUT_MS);
    this.#onFrame = input.onFrame;
    this.#onClosed = input.onClosed;
  }

  setRequestTimeout(milliseconds: number): void {
    this.#requestTimeoutMs = positiveTimeout(milliseconds, this.#requestTimeoutMs);
  }

  async start(): Promise<void> {
    if (this.#process) return;
    const child = spawnRuntimeProcess(this.#executable, this.#args, {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#process = child;
    child.stdin.on('error', () => { /* Windows EPIPE must not crash the host. */ });
    child.stdout.on('error', (error) => this.#failAll(new ClaudeRuntimeUnavailableError(error.message)));
    child.stderr.on('error', () => { /* stderr pipe failures are consumed; process close reports availability. */ });
    child.stdout.on('data', (chunk: Buffer | string) => { void this.#onChunk(String(chunk)); });
    child.stderr.on('data', () => { /* stderr is diagnostic-only; persist via runner if needed. */ });
    child.on('error', (error) => this.#failAll(new ClaudeRuntimeUnavailableError(error.message)));
    this.#exit$ = new Promise<void>((resolveExit) => {
      child.on('close', (code) => {
        this.#closed = true;
        this.#failAll(new ClaudeRuntimeUnavailableError(`Claude Code process exited with code ${code ?? 'unknown'}.`));
        resolveExit();
      });
    });
  }

  async request(subtype: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed || !this.#process) throw new ClaudeRuntimeUnavailableError('Claude Code process is not running.');
    const requestId = randomUUID();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ClaudeRuntimeUnavailableError(`Claude control request ${subtype} timed out.`));
        void this.close();
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve: resolveRequest, reject, timer });
      this.#write({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } });
    });
  }

  async sendUser(uuid: string, textValue: string): Promise<void> {
    this.#write({ type: 'user', uuid, message: { role: 'user', content: textValue }, parent_tool_use_id: null });
  }

  waitForReplay(uuid: string, milliseconds = 2_000): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        if (this.#replay?.uuid === uuid) this.#replay = undefined;
        resolveWait(undefined);
      }, milliseconds);
      this.#replay = {
        uuid,
        resolve: (frame) => {
          clearTimeout(timer);
          this.#replay = undefined;
          resolveWait(frame);
        },
      };
    });
  }

  async close(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    await forceCloseRuntimeProcess(child, this.#exit$, () => new ClaudeProcessCloseError(this.#executable));
  }

  async #onChunk(chunk: string): Promise<void> {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) await this.#handleLine(line);
  }

  async #handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!isRecord(parsed)) return;
    const type = text(parsed.type);
    if (type === 'keep_alive') return;
    if (type === 'control_response') {
      const wrapper = record(parsed.response);
      const id = text(parsed.request_id) ?? text(wrapper.request_id);
      const nested = record(wrapper.response);
      const payload = Object.keys(nested).length ? nested : (parsed.response ?? parsed);
      if (id) this.#resolvePending(id, payload);
      return;
    }
    const replay = this.#replay;
    if (type === 'user' && parsed.isReplay === true && replay && text(parsed.uuid) === replay.uuid) {
      replay.resolve(parsed);
    }
    await this.#onFrame?.(parsed);
  }

  #write(message: unknown): void {
    if (!this.#process || this.#closed) return;
    try { this.#process.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* process failure is reported by exit. */ }
  }

  #resolvePending(id: string, result: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (!this.#closedNotified) {
      this.#closedNotified = true;
      this.#onClosed?.(error);
    }
  }
}

export class ClaudeTargetRunner implements TargetRunner {
  readonly #sink: TargetEventSink;
  readonly #client: ClaudeStreamClient;
  readonly #sessionId: string;
  readonly #runtime: ResolvedRuntime;
  readonly #workspaceRoot: string;
  #status: TargetStatus = 'starting';
  readonly #turns = new TurnWaiter();
  #processExitRecorded = false;
  #init: Record<string, unknown> | undefined;
  #turnIndex = 0;

  constructor(input: { runtime: ResolvedRuntime; environment: PreparedRuntimeEnvironment; sink: TargetEventSink; env?: Readonly<Record<string, string | undefined>>; args?: readonly string[]; safeMode?: boolean }) {
    this.#sink = input.sink;
    this.#runtime = input.runtime;
    this.#workspaceRoot = input.environment.root;
    this.#sessionId = randomUUID();
    const args = input.args ?? [
      ...CLAUDE_REQUIRED_ARGS,
      '--model', input.runtime.requestedModel,
      '--session-id', this.#sessionId,
      ...(input.safeMode ? ['--safe-mode'] : []),
    ];
    this.#client = new ClaudeStreamClient({
      executable: input.runtime.executable,
      cwd: input.environment.root,
      ...(input.env ? { env: input.env } : {}),
      args,
      onFrame: (frame) => this.#onFrame(frame),
      onClosed: (error) => this.#onClosed(error),
    });
  }

  capabilities(): RuntimeCapabilities {
    return {
      nativeAdmission: true,
      clientMessageId: true,
      nativeTurnSettlement: true,
      tokenTelemetry: 'native',
      reconnectSession: true,
      querySubmissionByClientId: false,
      confirmProcessTermination: true,
    };
  }

  setRequestTimeout(milliseconds: number): void {
    this.#client.setRequestTimeout(milliseconds);
  }

  async start(initial: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    await this.#client.start();
    if (this.#status === 'stopped') throw new ClaudeRuntimeUnavailableError('Claude Code exited before the target started.');
    this.#status = 'running';
    return this.send(initial, identity);
  }

  async send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    assertRuntimeMessageIdentity(message, identity, 'Claude');
    const replay = this.#client.waitForReplay(identity.clientMessageId);
    await this.#client.sendUser(identity.clientMessageId, message.text);
    const frame = await replay;
    this.#turnIndex += 1;
    return {
      delivery: 'accepted',
      evidence: frame ? 'native_event' : 'preflight',
      messageId: identity.clientMessageId,
      acceptedAt: new Date().toISOString(),
    };
  }

  async waitForTurn(): Promise<TurnSettlement> {
    return this.#turns.wait('Claude target already has a turn waiter.');
  }

  cancelWait(reason: string): void {
    this.#turns.cancel(new ClaudeRuntimeUnavailableError(reason));
  }

  async inspect(): Promise<TargetStatus> { return this.#status; }

  session(): CandidateSessionHandle {
    return {
      sessionId: this.#sessionId,
      productId: this.#runtime.productId,
      requestedModel: this.#runtime.requestedModel,
      resolvedModel: this.#runtime.resolvedModel,
      workspaceRoot: this.#workspaceRoot,
    };
  }

  async stop(reason: RuntimeStopReason): Promise<void> {
    await this.#sink.append(runtimeTargetEvent('session_stopped', { reason, sessionId: this.#sessionId }));
    if (this.#status !== 'stopped') {
      try { await this.#client.request('interrupt'); } catch { /* interrupt is best-effort; process kill is the final means. */ }
    }
    let closeError: unknown;
    try { await this.#client.close(); } catch (error) { closeError = error; }
    this.#status = 'stopped';
    if (closeError) throw closeError instanceof Error ? closeError : new Error(errorMessage(closeError));
  }

  async close(): Promise<void> {
    if (this.#status !== 'stopped') await this.stop('shutdown');
    await this.#sink.append(runtimeTargetEvent('session_closed', { sessionId: this.#sessionId ?? this.session().sessionId }));
  }

  observableConfig(): Record<string, string> {
    const init = this.#init ?? {};
    return {
      model: text(init.model) ?? 'unknown',
      permissionMode: text(init.permissionMode) ?? 'unknown',
      claude_code_version: text(init.claude_code_version) ?? 'unknown',
      apiKeySource: text(init.apiKeySource) ?? 'unknown',
      disallowedTools: CLAUDE_DISALLOWED_TOOLS.join(','),
      sessionPersistence: 'off',
    };
  }

  async #onFrame(frame: Record<string, unknown>): Promise<void> {
    if (text(frame.type) === 'system' && text(frame.subtype) === 'init') this.#init = frame;
    const event = claudeFrameEvent(frame);
    if (event) await this.#sink.append(event);
    if (text(frame.type) === 'result') this.#settle(frame);
  }

  #settle(frame: Record<string, unknown>): void {
    const subtype = text(frame.subtype);
    const terminal = text(frame.terminal_reason);
    const status = claudeSettlementStatus(frame, NORMAL_TERMINAL);
    if (!status) {
      void this.#sink.append(runtimeTargetEvent('runtime_failed', { message: 'Unrecognized result subtype or terminal_reason.', subtype: subtype ?? null, terminal_reason: terminal ?? null }));
      this.#turns.fail(new ClaudeRuntimeUnavailableError(`Claude Code reported an unrecognized turn settlement (${subtype ?? 'missing subtype'}).`));
      return;
    }
    const failure = status === 'failed'
      ? {
          kind: 'unknown' as const,
          summary: summarizeDiagnostic(terminal ?? subtype ?? `Claude Code turn settled as ${status}.`),
          retryable: false,
        }
      : undefined;
    const settlement: TurnSettlement = {
      turnId: `turn-${this.#turnIndex || 1}`,
      status,
      confidence: 'native',
      observedAt: new Date().toISOString(),
      rawRefs: [{ type: 'result', subtype: subtype ?? null, is_error: frame.is_error === true, terminal_reason: terminal ?? null }],
      ...(failure ? { failure } : {}),
    };
    this.#turns.deliver(settlement);
  }

  #onClosed(error: Error): void {
    this.#status = 'stopped';
    this.#turns.fail(error);
    if (this.#processExitRecorded) return;
    this.#processExitRecorded = true;
    void this.#sink.append(runtimeTargetEvent('runtime_failed', { message: error.message })).catch((appendError: unknown) => {
      this.#turns.stash(new ClaudeRuntimeUnavailableError(`Failed to record Claude process exit: ${errorMessage(appendError)}`));
    });
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

