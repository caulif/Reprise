import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRecord, record, text } from '../../core/json.js';
import { SAFE_ID } from '../../core/identity.js';
import type {
  AvailableRuntime,
  DeliveryReceipt,
  MessageIdentity,
  PreparedRuntimeEnvironment,
  ResolvedRuntime,
  RuntimeAvailability,
  RuntimeCapabilities,
  RuntimePort,
  RuntimeRequest,
  RuntimeStopReason,
  TargetEvent,
  TargetEventSink,
  TargetRunner,
  TargetStatus,
  TurnSettlement,
  UserMessage,
} from '../../core/runtime.js';
import { discoverExecutable, forceKill, positiveTimeout, settlesWithin, summarizeDiagnostic } from '../shared/process.js';
import {
  classifyCodexTurnFailure,
  diagnosticMessage,
  parseReconnectAttempt,
  redactNotificationParams,
} from './turn-settlement.js';

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexModel = { id: string; model: string; supportedReasoningEfforts: readonly string[] };

/**
 * Windows `workspace-write` cannot apply deny-read ACLs (`helper_unknown_error`).
 * Isolation on Windows is the frozen workspace copy, not the OS sandbox.
 */
export function defaultCodexSandbox(platform: NodeJS.Platform = process.platform): CodexSandboxMode {
  return platform === 'win32' ? 'danger-full-access' : 'workspace-write';
}


export type CodexRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  effort?: CodexReasoningEffort;
  sandbox?: CodexSandboxMode;
  /** Overrides the app-server argv. Only a protocol-level test has a reason to set this. */
  args?: readonly string[];
};

type JsonRpcId = number | string;
type PendingRequest = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type PendingSettlement = { resolve: (settlement: TurnSettlement) => void; reject: (reason: Error) => void };

type StartedThread = { id: string; model: string };
type StartedTurn = { id: string };

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const PROCESS_STOP_GRACE_MS = 5_000;
const PROCESS_CLOSE_TIMEOUT_MS = 5_000;

export class CodexRuntimeUnavailableError extends Error {
  readonly code = 'unsupported_runtime';

  constructor(message: string) {
    super(message);
    this.name = 'CodexRuntimeUnavailableError';
  }
}

/**
 * Minimal app-server client for the current Codex JSONL protocol. It deliberately
 * rejects every server-initiated request, so a smoke run cannot auto-approve tools.
 */
class CodexProcessCloseError extends Error {
  readonly remainingResourceIds: readonly string[];

  constructor(resourceId: string) {
    super(`Codex app-server process ${resourceId} did not close after forced termination.`);
    this.name = 'CodexProcessCloseError';
    this.remainingResourceIds = [resourceId];
  }
}

/**
 * Minimal app-server client for the current Codex JSONL protocol. It deliberately
 * rejects every server-initiated request, so a smoke run cannot auto-approve tools.
 */
export class CodexAppServerClient {
  readonly #executable: string;
  readonly #cwd: string;
  readonly #env: Readonly<Record<string, string | undefined>> | undefined;
  readonly #notification: ((method: string, params: unknown) => Promise<void>) | undefined;
  readonly #closed$: ((error: Error) => void) | undefined;
  readonly #arguments: readonly string[];
  #process: ChildProcessWithoutNullStreams | undefined;
  #processClosed: Promise<void> | undefined;
  #readers: Interface[] = [];
  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #requestTimeoutMs: number;
  #started = false;
  #closed = false;
  #closedNotified = false;
  #closing: Promise<void> | undefined;

  constructor(input: { executable: string; cwd: string; env?: Readonly<Record<string, string | undefined>>; onNotification?: (method: string, params: unknown) => Promise<void>; onClosed?: (error: Error) => void; args?: readonly string[]; requestTimeoutMs?: number }) {
    this.#executable = input.executable;
    this.#cwd = input.cwd;
    this.#env = input.env;
    this.#notification = input.onNotification;
    this.#closed$ = input.onClosed;
    this.#arguments = input.args ?? ['app-server', '--listen', 'stdio://'];
    this.#requestTimeoutMs = positiveTimeout(input.requestTimeoutMs, DEFAULT_RPC_TIMEOUT_MS);
  }

  setRequestTimeout(milliseconds: number): void {
    this.#requestTimeoutMs = positiveTimeout(milliseconds, this.#requestTimeoutMs);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new CodexRuntimeUnavailableError('Codex app-server client is closed.');
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.#executable);
    const executable = shell ? `"${this.#executable}"` : this.#executable;
    const child = spawn(executable, this.#arguments, {
      cwd: this.#cwd,
      env: this.#env ? { ...process.env, ...this.#env } : process.env,
      stdio: 'pipe',
      windowsHide: true,
      // npm exposes Codex as a .cmd shim on Windows; Node can only run it through cmd.exe.
      shell,
    });
    this.#process = child;
    this.#processClosed = new Promise((resolveClose) => child.once('close', () => resolveClose()));
    child.once('error', (error) => {
      this.#closed = true;
      this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server failed to start: ${error.message}`), !this.#closing);
    });
    child.stdout.on('error', (error) => this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server stdout failed: ${error.message}`), !this.#closing));
    child.stderr.on('error', (error) => this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server stderr failed: ${error.message}`), !this.#closing));
    child.once('exit', (code, signal) => {
      this.#closed = true;
      this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server exited (${code ?? 'null'}, ${signal ?? 'none'}).`), !this.#closing);
    });
    this.#readers = [
      createInterface({ input: child.stdout }).on('line', (line) => { void this.#handleLine(line); }),
      createInterface({ input: child.stderr }).on('line', (line) => { void this.#emit('stderr', { line: compactDiagnostic(line) }); }),
    ];
    await this.request('initialize', {
      clientInfo: { name: 'reprise', title: 'Reprise', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: [] },
    });
    this.#started = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.#process || this.#closed) throw new CodexRuntimeUnavailableError('Codex app-server is not running.');
    const id = this.#nextId++;
    const message = { method, id, ...(params === undefined ? {} : { params }) };
    const result = new Promise<unknown>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.#rejectPending(id, new CodexRuntimeUnavailableError(`Codex app-server ${method} timed out after ${this.#requestTimeoutMs}ms.`));
        // A process that survives its own shutdown is a leak the operator has to know about.
        void this.close().catch((error: unknown) => this.#emit('close_failed', { message: errorMessage(error) }));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { resolve: resolveRequest, reject, timer });
    });
    try {
      this.#process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#rejectPending(id, new CodexRuntimeUnavailableError(`Codex app-server write failed: ${errorMessage(error)}`));
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#closeOnce();
    return this.#closing;
  }

  async #closeOnce(): Promise<void> {
    const child = this.#process;
    const processClosed = this.#processClosed;
    this.#closed = true;
    this.#process = undefined;
    for (const reader of this.#readers.splice(0)) reader.close();
    this.#failAll(new CodexRuntimeUnavailableError('Codex app-server client closed.'), false);
    if (!child || !processClosed || child.exitCode !== null || child.killed) return;
    child.stdin.destroy();
    child.kill();
    if (await settlesWithin(processClosed, PROCESS_STOP_GRACE_MS)) return;
    await forceKill(child);
    if (await settlesWithin(processClosed, PROCESS_CLOSE_TIMEOUT_MS)) return;
    throw new CodexProcessCloseError(String(child.pid ?? 'unknown'));
  }

  async #handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      await this.#emit('protocol_error', { message: 'Invalid JSONL frame from Codex app-server.' });
      return;
    }
    if (!isRecord(message)) {
      await this.#emit('protocol_error', { message: 'Non-object JSONL frame from Codex app-server.' });
      return;
    }
    if (isJsonRpcId(message.id) && ('result' in message || 'error' in message)) {
      if ('error' in message) this.#rejectPending(message.id, new CodexRuntimeUnavailableError(`Codex app-server ${rpcError(message.error)}.`));
      else this.#resolvePending(message.id, message.result);
      return;
    }
    if (isJsonRpcId(message.id) && typeof message.method === 'string') {
      // Server requests include an id. Reprise never grants permissions or invokes tools on its behalf.
      this.#write({ id: message.id, error: { code: -32000, message: 'Reprise rejects server-initiated requests during a smoke run.' } });
      await this.#emit('server_request_rejected', { method: message.method });
      return;
    }
    if (typeof message.method === 'string') await this.#notification?.(message.method, message.params);
  }

  #resolvePending(id: JsonRpcId, result: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  #rejectPending(id: JsonRpcId, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #write(message: unknown): void {
    if (!this.#process || this.#closed) return;
    try { this.#process.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* process failure is reported by exit/error. */ }
  }

  #failAll(error: Error, notify = true): void {
    for (const id of this.#pending.keys()) this.#rejectPending(id, error);
    // A caller waiting on a notification has no pending request to reject; this is its only signal.
    if (notify && !this.#closedNotified) {
      this.#closedNotified = true;
      this.#closed$?.(error);
    }
  }

  async #emit(type: string, payload: unknown): Promise<void> {
    await this.#notification?.(type, payload);
  }
}

class CodexTargetRunner implements TargetRunner {
  readonly #runtime: ResolvedRuntime;
  readonly #environment: PreparedRuntimeEnvironment;
  readonly #sink: TargetEventSink;
  readonly #effort: CodexReasoningEffort;
  readonly #sandbox: CodexSandboxMode;
  readonly #client: CodexAppServerClient;
  #thread: StartedThread | undefined;
  #activeTurn: string | undefined;
  #settlements: TurnSettlement[] = [];
  #waiter: PendingSettlement | undefined;
  #settlementFailure: Error | undefined;
  #earlySettlements = new Map<string, Record<string, unknown>>();
  #status: TargetStatus = 'starting';
  #processExitRecorded = false;
  #reconnectCount = 0;
  #endpointKind: 'custom_base_url' | 'default';

  constructor(input: { runtime: ResolvedRuntime; environment: PreparedRuntimeEnvironment; sink: TargetEventSink; effort: CodexReasoningEffort; sandbox: CodexSandboxMode; env?: Readonly<Record<string, string | undefined>>; args?: readonly string[] }) {
    this.#runtime = input.runtime;
    this.#environment = input.environment;
    this.#sink = input.sink;
    this.#effort = input.effort;
    this.#sandbox = input.sandbox;
    this.#endpointKind = endpointKind(input.env);
    this.#client = new CodexAppServerClient({
      executable: input.runtime.executable,
      cwd: input.environment.root,
      ...(input.env ? { env: input.env } : {}),
      ...(input.args ? { args: input.args } : {}),
      onNotification: async (method, params) => this.#onNotification(method, params),
      onClosed: (error) => this.#onClosed(error),
    });
  }

  capabilities(): RuntimeCapabilities {
    return { nativeAdmission: true, clientMessageId: true, nativeTurnSettlement: true, tokenTelemetry: 'partial', reconnectSession: false, querySubmissionByClientId: false, confirmProcessTermination: true };
  }

  setRequestTimeout(milliseconds: number): void {
    this.#client.setRequestTimeout(milliseconds);
  }

  async start(initial: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    if (this.#thread) throw new Error('Codex target has already started.');
    await this.#client.start();
    const result = await this.#client.request('thread/start', {
      model: this.#effectiveModel(),
      cwd: this.#environment.root,
      approvalPolicy: 'never',
      sandbox: this.#sandbox,
      ephemeral: true,
      threadSource: 'reprise',
    });
    this.#thread = readStartedThread(result);
    await this.#sink.append(event('codex.thread_started', {
      threadId: this.#thread.id,
      model: this.#thread.model,
      requestedModel: this.#runtime.requestedModel,
      resolvedModel: this.#runtime.resolvedModel,
      productId: this.#runtime.productId,
      ...(this.#runtime.version ? { runtimeVersion: this.#runtime.version } : {}),
      endpointKind: this.#endpointKind,
      effort: this.#effort,
      sandbox: this.#sandbox,
    }));
    if (this.#status === 'stopped') throw new CodexRuntimeUnavailableError('Codex app-server exited before the target started.');
    this.#status = 'running';
    return this.#send(initial, identity);
  }

  async send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    if (!this.#thread) throw new Error('Codex target has not started.');
    return this.#send(message, identity);
  }

  async waitForTurn(): Promise<TurnSettlement> {
    const settlement = this.#settlements.shift();
    if (settlement) return settlement;
    const failure = this.#settlementFailure;
    if (failure) {
      this.#settlementFailure = undefined;
      throw failure;
    }
    if (this.#waiter) throw new Error('Codex target already has a turn waiter.');
    return new Promise<TurnSettlement>((resolveWait, reject) => { this.#waiter = { resolve: resolveWait, reject }; });
  }

  /** Releases an in-flight wait so a Harness-side timeout cannot leave a settlement queued for the next turn. */
  cancelWait(reason: string): void {
    this.#settlements.length = 0;
    this.#failSettlement(new CodexRuntimeUnavailableError(reason));
    this.#settlementFailure = undefined;
  }

  #failSettlement(error: Error): void {
    const waiter = this.#waiter;
    if (!waiter) {
      this.#settlementFailure ??= error;
      return;
    }
    this.#waiter = undefined;
    waiter.reject(error);
  }

  async inspect(): Promise<TargetStatus> { return this.#status; }

  #onClosed(error: Error): void {
    this.#status = 'stopped';
    this.#failSettlement(error);
    if (this.#processExitRecorded) return;
    this.#processExitRecorded = true;
    void this.#sink.append(event('codex.process_exited', { message: error.message })).catch((appendError: unknown) => {
      this.#settlementFailure ??= new CodexRuntimeUnavailableError(`Failed to record Codex process exit: ${errorMessage(appendError)}`);
    });
  }

  async stop(reason: RuntimeStopReason): Promise<void> {
    const thread = this.#thread;
    if (thread) await this.#sink.append(event('codex.stop_requested', { reason, threadId: thread.id, turnId: this.#activeTurn ?? null }));
    try {
      if (this.#status !== 'stopped' && thread && this.#activeTurn) await this.#client.request('turn/interrupt', { threadId: thread.id, turnId: this.#activeTurn });
    } catch (error) {
      await this.#sink.append(event('codex.stop_interrupt_failed', { message: errorMessage(error), threadId: thread?.id ?? null, turnId: this.#activeTurn ?? null }));
    }
    let closeError: unknown;
    try {
      await this.#client.close();
    } catch (error) {
      closeError = error;
    }
    this.#status = 'stopped';
    // An interrupt can legitimately race process exit; a successful close proves cleanup completed.
    if (closeError) {
      if (closeError instanceof Error) throw closeError;
      throw new Error(errorMessage(closeError));
    }
  }

  async #send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    const thread = this.#thread;
    if (!thread) throw new Error('Codex target has not started.');
    validateMessage(message, identity);
    const result = await this.#client.request('turn/start', {
      threadId: thread.id,
      clientUserMessageId: identity.clientMessageId,
      input: [{ type: 'text', text: message.text, text_elements: [] }],
      model: thread.model,
      effort: this.#effort,
    });
    const turn = readStartedTurn(result);
    this.#activeTurn = turn.id;
    const earlySettlement = this.#earlySettlements.get(turn.id);
    if (earlySettlement) {
      this.#earlySettlements.delete(turn.id);
      await this.#settleTurn(earlySettlement);
    }
    await this.#sink.append(event('codex.turn_admitted', { threadId: thread.id, turnId: turn.id, messageId: message.id, clientMessageId: identity.clientMessageId, model: thread.model, effort: this.#effort }));
    return { delivery: 'accepted', evidence: 'rpc_response', turnId: turn.id, messageId: message.id, acceptedAt: new Date().toISOString() };
  }

  #effectiveModel(): string {
    const resolvedModel = this.#runtime.resolvedModel.trim();
    return resolvedModel && resolvedModel !== 'unknown' ? resolvedModel : this.#runtime.requestedModel;
  }

  async #onNotification(method: string, params: unknown): Promise<void> {
    if (method === 'model/rerouted') {
      const payload = record(params);
      await this.#sink.append(event('codex.model_rerouted', { fromModel: text(payload.fromModel), toModel: text(payload.toModel), reason: payload.reason ?? 'unknown' }));
      return;
    }
    this.#noteReconnect(method, params);
    await this.#sink.append(event(`codex.${method.replaceAll('/', '_')}`, redactNotificationParams(method, params)));
    if (method !== 'turn/completed') return;
    const payload = record(params);
    const turn = record(payload.turn);
    const turnId = text(turn.id);
    if (!turnId) {
      await this.#settleTurn(turn);
      return;
    }
    // A terminal notification may be received before the turn/start RPC continuation records activeTurn.
    if (!this.#activeTurn) { this.#earlySettlements.set(turnId, turn); return; }
    await this.#settleTurn(turn);
  }

  async #settleTurn(turn: Record<string, unknown>): Promise<void> {
    const turnId = text(turn.id);
    const status = codexSettlementStatus(text(turn.status));
    if (!turnId || !status) {
      const reported = text(turn.status) ?? null;
      await this.#sink.append(event('codex.protocol_error', { message: 'turn/completed lacked a recognized turn id or status.', turnId: turnId ?? null, status: reported }));
      // Failing fast beats waiting for the turn budget: an unmapped status is a protocol gap, not a slow turn.
      this.#failSettlement(new CodexRuntimeUnavailableError(`Codex app-server reported an unrecognized turn settlement (${reported ?? 'missing status'}).`));
      return;
    }
    const failure = classifyCodexTurnFailure(turn, { ...(this.#reconnectCount ? { reconnectCount: this.#reconnectCount } : {}) });
    const settlement: TurnSettlement = {
      turnId,
      status,
      confidence: 'native',
      observedAt: new Date().toISOString(),
      rawRefs: [{ method: 'turn/completed', status: text(turn.status) }],
      ...(failure ? { failure } : {}),
    };
    if (this.#activeTurn === turnId) this.#activeTurn = undefined;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve(settlement);
    } else {
      this.#settlements.push(settlement);
    }
  }

  #noteReconnect(method: string, params: unknown): void {
    const message = diagnosticMessage(params) ?? '';
    const attempt = parseReconnectAttempt(message);
    if (attempt) {
      this.#reconnectCount = Math.max(this.#reconnectCount, attempt.current);
    } else if (method === 'error' && /HTTP\s*503|\b503\b/i.test(message) && this.#reconnectCount === 0) {
      this.#reconnectCount = 1;
    }
  }
}

const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map<string, { models: readonly CodexModel[]; expiresAt: number }>();

function catalogCacheKey(executable: string, env: Readonly<Record<string, string | undefined>> | undefined): string {
  const codeHome = env && Object.prototype.hasOwnProperty.call(env, 'CODEX_HOME') ? env.CODEX_HOME : process.env.CODEX_HOME;
  return `${executable}` + String.fromCharCode(0) + (codeHome ?? '');
}

/** Exposed so tests and long-lived TUI sessions can force a fresh catalog read. */
export function clearCodexCatalogCache(): void {
  catalogCache.clear();
}

export class CodexRuntimePort implements RuntimePort {
  readonly id = 'codex';
  readonly #options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions = {}) {
    this.#options = options;
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return (await this.inspectAvailability())
      .filter((item): item is RuntimeAvailability & { executable: string } => item.status === 'available' && Boolean(item.executable))
      .map((item) => ({ productId: item.productId, executable: item.executable, ...(item.observedVersion ? { version: item.observedVersion } : {}) }));
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    const executable = await discoverCodexExecutable(this.#options);
    const observedAt = new Date().toISOString();
    if (!executable) {
      return [{
        productId: 'codex',
        status: 'not_installed',
        observedAt,
        installHint: 'Install Codex and ensure it is on PATH, or set REPRISE_CODEX_EXECUTABLE. Reprise does not install it.',
      }];
    }
    return [{
      productId: 'codex',
      executable,
      status: 'available',
      observedAt,
      ...(this.#options.version ? { observedVersion: this.#options.version } : {}),
    }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'codex') throw new Error(`Runtime ${request.productId} is unavailable in Codex mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  /**
   * Lists the current Codex model catalog without starting a target task. Each call spawns an app-server and
   * pages a full RPC catalog, so repeated preflights within one session reuse a short-lived snapshot.
   */
  async listModels(): Promise<readonly CodexModel[]> {
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    const cacheKey = catalogCacheKey(executable, this.#options.env);
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const models = await this.#fetchModels(executable);
    catalogCache.set(cacheKey, { models, expiresAt: Date.now() + CATALOG_TTL_MS });
    return models;
  }

  async #fetchModels(executable: string): Promise<readonly CodexModel[]> {
    const root = await mkdtemp(join(tmpdir(), 'reprise-codex-catalog-'));
    const client = new CodexAppServerClient({ executable, cwd: root, ...(this.#options.env ? { env: this.#options.env } : {}), ...(this.#options.args ? { args: this.#options.args } : {}) });
    const models: CodexModel[] = [];
    let primaryError: unknown;
    let hasPrimaryError = false;
    let cleanupError: unknown;
    let hasCleanupError = false;
    try {
      await client.start();
      let cursor: string | undefined;
      let completed = false;
      for (let page = 0; page < 100; page += 1) {
        const response = record(await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
        const data = Array.isArray(response.data) ? response.data : [];
        models.push(...data.map(readCodexModel).filter((model): model is CodexModel => model !== undefined));
        cursor = text(response.nextCursor);
        if (!cursor) {
          completed = true;
          break;
        }
      }
      if (!completed) throw new CodexRuntimeUnavailableError('Codex model catalog pagination exceeded its safety limit.');
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    try {
      await client.close();
    } catch (closeError) {
      cleanupError = closeError;
      hasCleanupError = true;
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (removeError) {
      if (!hasCleanupError) {
        cleanupError = removeError;
        hasCleanupError = true;
      }
    }
    if (hasPrimaryError) throw primaryError;
    if (hasCleanupError) throw cleanupError;
    return models;
  }

  /** Verifies a model against Codex's current catalog; it does not modify global configuration. */
  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    const resolved = await this.resolve(request);
    const match = (await this.listModels()).find((model) => model.id === request.requestedModel || model.model === request.requestedModel);
    if (!match) throw new CodexRuntimeUnavailableError('Codex does not currently expose candidate model ' + request.requestedModel + '.');
    return { ...resolved, resolvedModel: match.model };
  }
  recoveryCapabilities() {
    return {
      sessionHistory: 'available' as const,
      localArtifacts: true,
      workspaceHistory: false,
      externalSideEffects: "unobserved" as const,
    };
  }

  async createRunner(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, sink: TargetEventSink): Promise<TargetRunner> {
    if (runtime.productId !== 'codex') throw new CodexRuntimeUnavailableError('Only Codex runtimes can create a Codex app-server runner.');
    if (!isAbsolute(environment.root)) throw new CodexRuntimeUnavailableError('Codex app-server requires an absolute isolated workspace path.');
    return new CodexTargetRunner({
      runtime, environment, sink,
      effort: this.#options.effort ?? 'medium',
      sandbox: this.#options.sandbox ?? defaultCodexSandbox(),
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
    });
  }
}

export async function discoverCodexExecutable(options: CodexRuntimeOptions = {}): Promise<string | undefined> {
  return discoverExecutable({
    command: 'codex',
    envKey: 'REPRISE_CODEX_EXECUTABLE',
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.pathExt ? { pathExt: options.pathExt } : {}),
  });
}

function readCodexModel(value: unknown): CodexModel | undefined {
  const model = record(value);
  const id = text(model.id);
  const name = text(model.model);
  if (!id || !name) return undefined;
  return { id, model: name, supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter((item): item is string => typeof item === 'string') : [] };
}
function readStartedThread(value: unknown): StartedThread {
  const response = record(value);
  const thread = record(response.thread);
  const id = text(thread.id);
  const model = text(response.model);
  if (!id || !model) throw new CodexRuntimeUnavailableError('Codex app-server thread/start response was incomplete.');
  return { id, model };
}

function readStartedTurn(value: unknown): StartedTurn {
  const response = record(value);
  const turn = record(response.turn);
  const id = text(turn.id);
  if (!id) throw new CodexRuntimeUnavailableError('Codex app-server turn/start response was incomplete.');
  return { id };
}

export function codexSettlementStatus(status: string | undefined): TurnSettlement['status'] | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'aborted';
  if (status === 'waiting_input' || status === 'waitingInput') return 'waiting_input';
  return undefined;
}

function validateMessage(message: UserMessage, identity: MessageIdentity): void {
  if (!SAFE_ID.test(message.id) || !SAFE_ID.test(identity.clientMessageId) || !SAFE_ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !message.text.trim()) {
    throw new Error('Codex runtime message identity is invalid.');
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId { return typeof value === 'number' || typeof value === 'string'; }
function event(type: string, payload: unknown): TargetEvent { return { type, occurredAt: new Date().toISOString(), payload }; }
function rpcError(value: unknown): string { const detail = record(value); return typeof detail.message === 'string' ? detail.message : 'returned an invalid error response'; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function compactDiagnostic(value: string): string { return summarizeDiagnostic(value, 1_000); }
function endpointKind(env?: Readonly<Record<string, string | undefined>>): 'custom_base_url' | 'default' {
  const configured = env && Object.prototype.hasOwnProperty.call(env, 'OPENAI_BASE_URL') ? env.OPENAI_BASE_URL : process.env.OPENAI_BASE_URL;
  return configured?.trim() ? 'custom_base_url' : 'default';
}
