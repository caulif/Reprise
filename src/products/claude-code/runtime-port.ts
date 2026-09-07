import { mkdtemp, rm } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { DEFAULT_RUNTIME_RPC_TIMEOUT_MS, RUNTIME_PROCESS_CLOSE_TIMEOUT_MS, RUNTIME_PROCESS_STOP_GRACE_MS, discoverExecutable, forceKill, positiveTimeout, settlesWithin, spawnRuntimeProcess, summarizeDiagnostic } from '../shared/process.js';

export const CLAUDE_DISALLOWED_TOOLS = ['CronCreate', 'CronDelete', 'ScheduleWakeup', 'SendMessage'] as const;
export const CLAUDE_REQUIRED_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  '--replay-user-messages',
  '--strict-mcp-config',
  '--disallowed-tools', CLAUDE_DISALLOWED_TOOLS.join(','),
  '--no-session-persistence',
] as const;

const DEFAULT_RPC_TIMEOUT_MS = DEFAULT_RUNTIME_RPC_TIMEOUT_MS;
const PROCESS_STOP_GRACE_MS = RUNTIME_PROCESS_STOP_GRACE_MS;
const PROCESS_CLOSE_TIMEOUT_MS = RUNTIME_PROCESS_CLOSE_TIMEOUT_MS;
const CATALOG_TTL_MS = 10 * 60_000;
const NORMAL_TERMINAL = new Set(['', 'end_turn', 'completed', 'success']);

export type ClaudeModel = { value: string; resolvedModel: string; supportedEffortLevels: readonly string[] };
export type ClaudeRuntimeOptions = {
  executable?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  platform?: NodeJS.Platform;
  pathExt?: string;
  version?: string;
  safeMode?: boolean;
  /** Overrides the CLI argv. Only a protocol-level test has a reason to set this. */
  args?: readonly string[];
};

type PendingControl = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type PendingSettlement = { resolve: (settlement: TurnSettlement) => void; reject: (reason: Error) => void };

class ClaudeRuntimeUnavailableError extends Error {
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
    if (await settlesWithin(this.#exit$, PROCESS_STOP_GRACE_MS)) return;
    await forceKill(child);
    if (await settlesWithin(this.#exit$, PROCESS_CLOSE_TIMEOUT_MS)) return;
    throw new ClaudeProcessCloseError(this.#executable);
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

class ClaudeTargetRunner implements TargetRunner {
  readonly #sink: TargetEventSink;
  readonly #client: ClaudeStreamClient;
  readonly #sessionId: string;
  #status: TargetStatus = 'starting';
  #settlements: TurnSettlement[] = [];
  #waiter: PendingSettlement | undefined;
  #settlementFailure: Error | undefined;
  #processExitRecorded = false;
  #init: Record<string, unknown> | undefined;
  #turnIndex = 0;

  constructor(input: { runtime: ResolvedRuntime; environment: PreparedRuntimeEnvironment; sink: TargetEventSink; env?: Readonly<Record<string, string | undefined>>; args?: readonly string[]; safeMode?: boolean }) {
    this.#sink = input.sink;
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
    validateMessage(message, identity);
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
    const settlement = this.#settlements.shift();
    if (settlement) return settlement;
    const failure = this.#settlementFailure;
    if (failure) {
      this.#settlementFailure = undefined;
      throw failure;
    }
    if (this.#waiter) throw new Error('Claude target already has a turn waiter.');
    return new Promise<TurnSettlement>((resolveWait, reject) => { this.#waiter = { resolve: resolveWait, reject }; });
  }

  cancelWait(reason: string): void {
    this.#settlements.length = 0;
    this.#failSettlement(new ClaudeRuntimeUnavailableError(reason));
    this.#settlementFailure = undefined;
  }

  async inspect(): Promise<TargetStatus> { return this.#status; }

  async stop(reason: RuntimeStopReason): Promise<void> {
    await this.#sink.append(event('claude-code.stop_requested', { reason, sessionId: this.#sessionId }));
    if (this.#status !== 'stopped') {
      try { await this.#client.request('interrupt'); } catch { /* interrupt is best-effort; process kill is the final means. */ }
    }
    let closeError: unknown;
    try { await this.#client.close(); } catch (error) { closeError = error; }
    this.#status = 'stopped';
    if (closeError) throw closeError instanceof Error ? closeError : new Error(errorMessage(closeError));
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
    const type = text(frame.type);
    if (type === 'system' && text(frame.subtype) === 'init') {
      this.#init = frame;
      await this.#sink.append(event('claude-code.system_init', frame));
      return;
    }
    if (type === 'assistant' || type === 'user') {
      await this.#sink.append(event(`claude-code.${type}`, frame));
      return;
    }
    if (type === 'result') {
      await this.#sink.append(event('claude-code.result', frame));
      this.#settle(frame);
    }
  }

  #settle(frame: Record<string, unknown>): void {
    const subtype = text(frame.subtype);
    const terminal = text(frame.terminal_reason);
    const errored = frame.is_error === true || (terminal !== undefined && !NORMAL_TERMINAL.has(terminal));
    let status: TurnSettlement['status'] | undefined;
    if (errored) status = 'failed';
    else if (subtype?.startsWith('error_')) status = 'failed';
    else if (subtype === 'success' && frame.is_error !== true) status = 'completed';
    if (!status) {
      void this.#sink.append(event('claude-code.protocol_error', { message: 'Unrecognized result subtype or terminal_reason.', subtype: subtype ?? null, terminal_reason: terminal ?? null }));
      this.#failSettlement(new ClaudeRuntimeUnavailableError(`Claude Code reported an unrecognized turn settlement (${subtype ?? 'missing subtype'}).`));
      return;
    }
    const failure = status === 'failed' || status === 'aborted'
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
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve(settlement);
    } else {
      this.#settlements.push(settlement);
    }
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

  #onClosed(error: Error): void {
    this.#status = 'stopped';
    this.#failSettlement(error);
    if (this.#processExitRecorded) return;
    this.#processExitRecorded = true;
    void this.#sink.append(event('claude-code.process_exited', { message: error.message })).catch((appendError: unknown) => {
      this.#settlementFailure ??= new ClaudeRuntimeUnavailableError(`Failed to record Claude process exit: ${errorMessage(appendError)}`);
    });
  }
}

const catalogCache = new Map<string, { models: readonly ClaudeModel[]; expiresAt: number }>();

export function clearClaudeCatalogCache(): void {
  catalogCache.clear();
}

export class ClaudeCodeRuntimePort implements RuntimePort {
  readonly id = 'claude-code';
  readonly #options: ClaudeRuntimeOptions;

  constructor(options: ClaudeRuntimeOptions = {}) {
    this.#options = options;
  }

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return (await this.inspectAvailability())
      .filter((item): item is RuntimeAvailability & { executable: string } => item.status === 'available' && Boolean(item.executable))
      .map((item) => ({ productId: item.productId, executable: item.executable, ...(item.observedVersion ? { version: item.observedVersion } : {}) }));
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    const executable = await discoverClaudeExecutable(this.#options);
    const observedAt = new Date().toISOString();
    if (!executable) {
      return [{
        productId: 'claude-code',
        status: 'not_installed',
        observedAt,
        installHint: 'Install Claude Code and ensure it is on PATH, or set REPRISE_CLAUDE_EXECUTABLE. Reprise does not install it.',
      }];
    }
    return [{
      productId: 'claude-code',
      executable,
      status: 'available',
      observedAt,
      ...(this.#options.version ? { observedVersion: this.#options.version } : {}),
    }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'claude-code') throw new Error(`Runtime ${request.productId} is unavailable in Claude Code mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    const available = (await this.inspectAvailable())[0];
    if (!available) throw new ClaudeRuntimeUnavailableError('Claude Code executable was not found. Set REPRISE_CLAUDE_EXECUTABLE or install Claude Code; Reprise does not install it.');
    return { ...available, requestedModel: request.requestedModel, resolvedModel: 'unknown' };
  }

  async listModels(): Promise<readonly ClaudeModel[]> {
    const executable = await discoverClaudeExecutable(this.#options);
    if (!executable) throw new ClaudeRuntimeUnavailableError('Claude Code executable was not found. Set REPRISE_CLAUDE_EXECUTABLE or install Claude Code; Reprise does not install it.');
    const cacheKey = `${executable}\0${this.#options.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''}`;
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    const models = await this.#fetchModels(executable);
    catalogCache.set(cacheKey, { models, expiresAt: Date.now() + CATALOG_TTL_MS });
    return models;
  }

  async listCatalog(): Promise<readonly import('../../core/runtime.js').RuntimeModelOffer[]> {
    const models = await this.listModels();
    return models.map((model) => ({
      value: model.value,
      displayName: model.value,
      resolvedModel: model.resolvedModel,
    }));
  }

  async #fetchModels(executable: string): Promise<readonly ClaudeModel[]> {
    const root = await mkdtemp(join(tmpdir(), 'reprise-claude-catalog-'));
    const client = new ClaudeStreamClient({
      executable,
      cwd: root,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
    });
    try {
      await client.start();
      const response = record(await client.request('initialize'));
      const models = Array.isArray(response.models) ? response.models : Array.isArray(response.data) ? response.data : [];
      return models.map(readClaudeModel).filter((model): model is ClaudeModel => model !== undefined);
    } finally {
      try { await client.close(); } catch { /* catalog probe */ }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    const resolved = await this.resolve(request);
    const match = (await this.listModels()).find((model) => model.value === request.requestedModel || model.resolvedModel === request.requestedModel);
    if (!match) {
      throw new ClaudeRuntimeUnavailableError(
        `The current Claude CLI catalog does not expose ${request.requestedModel}. If this model appears in a historical session, it cannot be used as a candidate until the CLI lists it.`,
      );
    }
    return { ...resolved, resolvedModel: match.resolvedModel };
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
    if (runtime.productId !== 'claude-code') throw new ClaudeRuntimeUnavailableError('Only Claude Code runtimes can create a stream-json runner.');
    if (!isAbsolute(environment.root)) throw new ClaudeRuntimeUnavailableError('Claude Code requires an absolute isolated workspace path.');
    return new ClaudeTargetRunner({
      runtime,
      environment,
      sink,
      ...(this.#options.env ? { env: this.#options.env } : {}),
      ...(this.#options.args ? { args: this.#options.args } : {}),
      ...(this.#options.safeMode ? { safeMode: true } : {}),
    });
  }
}

async function discoverClaudeExecutable(options: ClaudeRuntimeOptions = {}): Promise<string | undefined> {
  return discoverExecutable({
    command: 'claude',
    envKey: 'REPRISE_CLAUDE_EXECUTABLE',
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.pathExt ? { pathExt: options.pathExt } : {}),
  });
}

function readClaudeModel(value: unknown): ClaudeModel | undefined {
  const model = record(value);
  const id = text(model.value) ?? text(model.id);
  const resolved = text(model.resolvedModel) ?? text(model.model);
  if (!id || !resolved) return undefined;
  return {
    value: id,
    resolvedModel: resolved,
    supportedEffortLevels: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((item): item is string => typeof item === 'string') : [],
  };
}

function validateMessage(message: UserMessage, identity: MessageIdentity): void {
  if (!SAFE_ID.test(message.id) || !SAFE_ID.test(identity.clientMessageId) || !SAFE_ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !message.text.trim()) {
    throw new Error('Claude runtime message identity is invalid.');
  }
}

function event(type: string, payload: unknown): TargetEvent {
  return { type, occurredAt: new Date().toISOString(), payload };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
