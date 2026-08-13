import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AvailableRuntime,
  DeliveryReceipt,
  MessageIdentity,
  PreparedRuntimeEnvironment,
  ResolvedRuntime,
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

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexModel = { id: string; model: string; supportedReasoningEfforts: readonly string[] };


export type CodexRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  effort?: CodexReasoningEffort;
  sandbox?: CodexSandboxMode;
};

type JsonRecord = Record<string, unknown>;
type JsonRpcId = number;
type PendingRequest = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type PendingSettlement = { resolve: (settlement: TurnSettlement) => void; reject: (reason: Error) => void };

type StartedThread = { id: string; model: string };
type StartedTurn = { id: string };

const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
export class CodexProcessCloseError extends Error {
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
  readonly #arguments: readonly string[];
  #process: ChildProcessWithoutNullStreams | undefined;
  #processClosed: Promise<void> | undefined;
  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #requestTimeoutMs: number;
  #started = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(input: { executable: string; cwd: string; env?: Readonly<Record<string, string | undefined>>; onNotification?: (method: string, params: unknown) => Promise<void>; args?: readonly string[]; requestTimeoutMs?: number }) {
    this.#executable = input.executable;
    this.#cwd = input.cwd;
    this.#env = input.env;
    this.#notification = input.onNotification;
    this.#arguments = input.args ?? ['app-server', '--listen', 'stdio://'];
    this.#requestTimeoutMs = positiveTimeout(input.requestTimeoutMs, DEFAULT_RPC_TIMEOUT_MS);
  }

  setRequestTimeout(milliseconds: number): void {
    this.#requestTimeoutMs = positiveTimeout(milliseconds, this.#requestTimeoutMs);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new CodexRuntimeUnavailableError('Codex app-server client is closed.');
    const child = spawn(this.#executable, this.#arguments, {
      cwd: this.#cwd,
      env: this.#env ? { ...process.env, ...this.#env } : process.env,
      stdio: 'pipe',
      windowsHide: true,
      // npm exposes Codex as a .cmd shim on Windows; Node can only run it through cmd.exe.
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(this.#executable),
    });
    this.#process = child;
    this.#processClosed = new Promise((resolveClose) => child.once('close', () => resolveClose()));
    child.once('error', (error) => {
      this.#closed = true;
      this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server failed to start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      this.#closed = true;
      this.#failAll(new CodexRuntimeUnavailableError(`Codex app-server exited (${code ?? 'null'}, ${signal ?? 'none'}).`));
    });
    createInterface({ input: child.stdout }).on('line', (line) => { void this.#handleLine(line); });
    createInterface({ input: child.stderr }).on('line', (line) => { void this.#emit('codex.stderr', { line: compactDiagnostic(line) }); });
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
        void this.close().catch(() => undefined);
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
    this.#failAll(new CodexRuntimeUnavailableError('Codex app-server client closed.'));
    if (!child || !processClosed || child.exitCode !== null || child.killed) return;
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
      await this.#emit('codex.protocol_error', { message: 'Invalid JSONL frame from Codex app-server.' });
      return;
    }
    if (!isRecord(message)) {
      await this.#emit('codex.protocol_error', { message: 'Non-object JSONL frame from Codex app-server.' });
      return;
    }
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      if ('error' in message) this.#rejectPending(message.id, new CodexRuntimeUnavailableError(`Codex app-server ${rpcError(message.error)}.`));
      else this.#resolvePending(message.id, message.result);
      return;
    }
    if (typeof message.id === 'number' && typeof message.method === 'string') {
      // Server requests include an id. Reprise never grants permissions or invokes tools on its behalf.
      this.#write({ id: message.id, error: { code: -32000, message: 'Reprise rejects server-initiated requests during a smoke run.' } });
      await this.#emit('codex.server_request_rejected', { method: message.method });
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

  #failAll(error: Error): void {
    for (const id of this.#pending.keys()) this.#rejectPending(id, error);
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
  #status: TargetStatus = 'starting';

  constructor(input: { runtime: ResolvedRuntime; environment: PreparedRuntimeEnvironment; sink: TargetEventSink; effort: CodexReasoningEffort; sandbox: CodexSandboxMode; env?: Readonly<Record<string, string | undefined>> }) {
    this.#runtime = input.runtime;
    this.#environment = input.environment;
    this.#sink = input.sink;
    this.#effort = input.effort;
    this.#sandbox = input.sandbox;
    this.#client = new CodexAppServerClient({
      executable: input.runtime.executable,
      cwd: input.environment.root,
      ...(input.env ? { env: input.env } : {}),
      onNotification: async (method, params) => this.#onNotification(method, params),
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
      model: this.#runtime.requestedModel,
      cwd: this.#environment.root,
      approvalPolicy: 'never',
      sandbox: this.#sandbox,
      ephemeral: true,
      threadSource: 'reprise',
    });
    this.#thread = readStartedThread(result);
    await this.#sink.append(event('codex.thread_started', { threadId: this.#thread.id, model: this.#thread.model, requestedModel: this.#runtime.requestedModel, effort: this.#effort }));
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
    if (this.#waiter) throw new Error('Codex target already has a turn waiter.');
    return new Promise<TurnSettlement>((resolveWait, reject) => { this.#waiter = { resolve: resolveWait, reject }; });
  }

  async inspect(): Promise<TargetStatus> { return this.#status; }

  async stop(reason: RuntimeStopReason): Promise<void> {
    const thread = this.#thread;
    try {
      if (thread && this.#activeTurn) await this.#client.request('turn/interrupt', { threadId: thread.id, turnId: this.#activeTurn });
      if (thread) await this.#sink.append(event('codex.stop_requested', { reason, threadId: thread.id, turnId: this.#activeTurn ?? null }));
    } finally {
      this.#status = 'stopped';
      await this.#client.close();
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
      model: this.#runtime.requestedModel,
      effort: this.#effort,
    });
    const turn = readStartedTurn(result);
    this.#activeTurn = turn.id;
    await this.#sink.append(event('codex.turn_admitted', { threadId: thread.id, turnId: turn.id, messageId: message.id, clientMessageId: identity.clientMessageId, model: this.#runtime.requestedModel, effort: this.#effort }));
    return { delivery: 'accepted', evidence: 'rpc_response', turnId: turn.id, messageId: message.id, acceptedAt: new Date().toISOString() };
  }

  async #onNotification(method: string, params: unknown): Promise<void> {
    await this.#sink.append(event(`codex.${method.replaceAll('/', '_')}`, params));
    if (method === 'model/rerouted') {
      const payload = record(params);
      await this.#sink.append(event('codex.model_rerouted', { fromModel: text(payload.fromModel), toModel: text(payload.toModel), reason: payload.reason ?? 'unknown' }));
      return;
    }
    if (method !== 'turn/completed') return;
    const payload = record(params);
    const turn = record(payload.turn);
    const turnId = text(turn.id);
    const status = codexSettlementStatus(text(turn.status));
    if (!turnId || !status) {
      await this.#sink.append(event('codex.protocol_error', { message: 'turn/completed lacked a recognized turn id or status.' }));
      return;
    }
    const settlement: TurnSettlement = { turnId, status, confidence: 'native', observedAt: new Date().toISOString(), rawRefs: [{ method, status: text(turn.status) }] };
    if (this.#activeTurn === turnId) this.#activeTurn = undefined;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve(settlement);
    } else {
      this.#settlements.push(settlement);
    }
  }
}

export class CodexRuntimePort implements RuntimePort {
  readonly id = 'codex';
  readonly #options: CodexRuntimeOptions;

  constructor(options: CodexRuntimeOptions = {}) {
    this.#options = options;
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) return [];
    return [{ productId: 'codex', executable, ...(this.#options.version ? { version: this.#options.version } : {}) }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'codex') throw new Error(`Runtime ${request.productId} is unavailable in Codex mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  /** Lists the current Codex model catalog without starting a target task. */
  async listModels(): Promise<readonly CodexModel[]> {
    const executable = await discoverCodexExecutable(this.#options);
    if (!executable) throw new CodexRuntimeUnavailableError('Codex executable was not found. Set REPRISE_CODEX_EXECUTABLE or install Codex; Reprise does not install it.');
    const root = await mkdtemp(join(tmpdir(), 'reprise-codex-catalog-'));
    const client = new CodexAppServerClient({ executable, cwd: root, ...(this.#options.env ? { env: this.#options.env } : {}) });
    try {
      await client.start();
      const models: CodexModel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const response = record(await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }));
        const data = Array.isArray(response.data) ? response.data : [];
        models.push(...data.map(readCodexModel).filter((model): model is CodexModel => model !== undefined));
        cursor = text(response.nextCursor);
        if (!cursor) return models;
      }
      throw new CodexRuntimeUnavailableError('Codex model catalog pagination exceeded its safety limit.');
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  /** Verifies a model against Codex's current catalog; it does not modify global configuration. */
  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    const resolved = await this.resolve(request);
    const match = (await this.listModels()).find((model) => model.id === request.requestedModel || model.model === request.requestedModel);
    if (!match) throw new CodexRuntimeUnavailableError('Codex does not currently expose candidate model ' + request.requestedModel + '.');
    return { ...resolved, resolvedModel: match.model };
  }
  async createRunner(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, sink: TargetEventSink): Promise<TargetRunner> {
    if (runtime.productId !== 'codex') throw new CodexRuntimeUnavailableError('Only Codex runtimes can create a Codex app-server runner.');
    if (!isAbsolute(environment.root)) throw new CodexRuntimeUnavailableError('Codex app-server requires an absolute isolated workspace path.');
    return new CodexTargetRunner({ runtime, environment, sink, effort: this.#options.effort ?? 'medium', sandbox: this.#options.sandbox ?? 'workspace-write', ...(this.#options.env ? { env: this.#options.env } : {}) });
  }
}

export async function discoverCodexExecutable(options: CodexRuntimeOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const configured = options.executable?.trim() || env.REPRISE_CODEX_EXECUTABLE?.trim();
  const candidates = configured
    ? configuredCandidates(configured, env.PATH, options.cwd ?? process.cwd(), platform, options.pathExt)
    : pathCandidates('codex', env.PATH, platform, options.pathExt);
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
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
  return undefined;
}

function validateMessage(message: UserMessage, identity: MessageIdentity): void {
  if (!SAFE_RUNTIME_ID.test(message.id) || !SAFE_RUNTIME_ID.test(identity.clientMessageId) || !SAFE_RUNTIME_ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !message.text.trim()) {
    throw new Error('Codex runtime message identity is invalid.');
  }
}

function event(type: string, payload: unknown): TargetEvent { return { type, occurredAt: new Date().toISOString(), payload }; }
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): JsonRecord { return isRecord(value) ? value : {}; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function rpcError(value: unknown): string { const detail = record(value); return typeof detail.message === 'string' ? detail.message : 'returned an invalid error response'; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function positiveTimeout(value: number | undefined, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback; }
async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<false>((resolveWait) => { timer = setTimeout(() => resolveWait(false), milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function forceKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform !== 'win32' || !child.pid) {
    child.kill('SIGKILL');
    return;
  }
  await new Promise<void>((resolveWait) => spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).once('close', () => resolveWait()));
}
function compactDiagnostic(value: string): string { return value.replace(/[\r\n\t]/g, ' ').slice(0, 1_000); }

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
