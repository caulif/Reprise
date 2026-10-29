import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { record, text } from '../../../core/json.js';
import {
  runtimeTargetEvent,
  type DeliveryReceipt,
  type MessageIdentity,
  type PreparedRuntimeEnvironment,
  type ResolvedRuntime,
  type RuntimeCapabilities,
  type RuntimeStopReason,
  type TargetEvent,
  type TargetEventSink,
  type TargetRunner,
  type TargetStatus,
  type TurnSettlement,
  type UserMessage,
} from '../../../core/runtime.js';
import type { CandidateSessionHandle } from '../../../core/schema.js';
import { summarizeDiagnostic } from '../../../infrastructure/process/stdio.js';
import { AcpClient, AcpUnavailableError, allowFirstOption, type AcpPermissionDecision } from './client.js';
import { acpSessionUpdateEvents } from './events.js';
import { acpTurnSettlement } from './settlement.js';
import { assertRuntimeMessageIdentity, TurnWaiter } from '../turn-wait.js';

const ACP_PROTOCOL_VERSION = 1;

export type AcpRunnerOptions = {
  /** Product label used in operator-facing errors. */
  displayName: string;
  runtime: ResolvedRuntime;
  environment: PreparedRuntimeEnvironment;
  sink: TargetEventSink;
  args: readonly string[];
  completeEnv?: NodeJS.ProcessEnv;
  temporaryDirectory?: string;
  requestTimeoutMs?: number;
};

/**
 * One ACP session per CandidateRun. The turn settles from the `session/prompt` response, so
 * this runner reports native settlement and no client message id: ACP has no admission receipt
 * to correlate, and Reprise does not fabricate one.
 */
export class AcpTargetRunner implements TargetRunner {
  readonly #displayName: string;
  readonly #sink: TargetEventSink;
  readonly #client: AcpClient;
  readonly #runtime: ResolvedRuntime;
  readonly #workspaceRoot: string;
  readonly #temporaryDirectory: string | undefined;
  readonly #turns = new TurnWaiter();
  readonly #appends = new Set<Promise<void>>();
  readonly #finishedCalls = new Set<string>();
  readonly #startedCalls = new Set<string>();
  #sessionId: string = randomUUID();
  #status: TargetStatus = 'starting';
  #activeTurnId: string | undefined;
  #stopRequested = false;
  #temporaryOwned = false;
  #started = false;
  #stoppedEventAppended = false;
  #closedEventAppended = false;

  constructor(options: AcpRunnerOptions) {
    this.#displayName = options.displayName;
    this.#sink = options.sink;
    this.#runtime = options.runtime;
    this.#workspaceRoot = options.environment.root;
    this.#temporaryDirectory = options.temporaryDirectory;
    this.#client = new AcpClient({
      executable: options.runtime.executable,
      args: options.args,
      cwd: options.environment.root,
      ...(options.completeEnv ? { completeEnv: options.completeEnv } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      onNotification: (method, params) => this.#onNotification(method, params),
      onClosed: (error) => this.#onClosed(error),
      decidePermission: (request) => this.#decidePermission(request),
    });
  }

  capabilities(): RuntimeCapabilities {
    return {
      nativeAdmission: false,
      clientMessageId: false,
      nativeTurnSettlement: true,
      tokenTelemetry: 'none',
      reconnectSession: false,
      querySubmissionByClientId: false,
      confirmProcessTermination: true,
    };
  }

  setRequestTimeout(milliseconds: number): void {
    this.#client.setRequestTimeout(milliseconds);
  }

  async start(initial: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    if (this.#temporaryDirectory) {
      await mkdir(this.#temporaryDirectory, { recursive: true });
      this.#temporaryOwned = true;
    }
    this.#client.start();
    await this.#client.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    const created = record(await this.#client.request('session/new', { cwd: this.#workspaceRoot, mcpServers: [] }));
    const sessionId = text(created.sessionId);
    if (!sessionId) throw new AcpUnavailableError(`${this.#displayName} did not return a session id for session/new.`);
    this.#sessionId = sessionId;
    this.#status = 'running';
    await this.#sink.append(runtimeTargetEvent('session_started', { sessionId }));
    this.#started = true;
    return this.send(initial, identity);
  }

  async send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    if (this.#status === 'stopped') throw new AcpUnavailableError(`${this.#displayName} is stopped; no further input will be sent.`);
    assertRuntimeMessageIdentity(message, identity, this.#displayName);
    this.#activeTurnId = identity.clientMessageId;
    const prompt = this.#client.request('session/prompt', {
      sessionId: this.#sessionId,
      prompt: [{ type: 'text', text: message.text }],
    });
    void prompt.then(
      (result) => this.#settle(text(record(result).stopReason)),
      (error: unknown) => this.#turns.fail(asError(error)),
    );
    return {
      delivery: 'accepted',
      evidence: 'preflight',
      turnId: identity.clientMessageId,
      messageId: identity.clientMessageId,
      acceptedAt: new Date().toISOString(),
    };
  }

  async waitForTurn(): Promise<TurnSettlement> {
    return this.#turns.wait(`${this.#displayName} target already has a turn waiter.`);
  }

  cancelWait(reason: string): void {
    this.#turns.cancel(new AcpUnavailableError(reason));
  }

  async inspect(): Promise<TargetStatus> {
    return this.#status;
  }

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
    this.#stopRequested = true;
    await this.#flush();
    let stopError: unknown;
    if (this.#started && !this.#stoppedEventAppended) {
      this.#stoppedEventAppended = true;
      try {
        await this.#sink.append(runtimeTargetEvent('session_stopped', { reason, sessionId: this.#sessionId }));
      } catch (error) {
        stopError = error;
      }
    }
    if (this.#status === 'running') this.#client.notify('session/cancel', { sessionId: this.#sessionId });
    let closeError: unknown;
    try {
      await this.#client.close();
    } catch (error) {
      closeError = error;
    }
    this.#status = 'stopped';
    let releaseError: unknown;
    try {
      await this.#releaseTemporaryDirectory();
    } catch (error) {
      releaseError = error;
    }
    if (closeError) throw asError(closeError);
    if (stopError) throw asError(stopError);
    if (releaseError) throw asError(releaseError);
  }

  async close(): Promise<void> {
    await this.#flush();
    if (this.#status !== 'stopped') await this.stop('shutdown');
    if (this.#started && !this.#closedEventAppended) {
      this.#closedEventAppended = true;
      await this.#sink.append(runtimeTargetEvent('session_closed', { sessionId: this.#sessionId }));
    }
    await this.#releaseTemporaryDirectory();
  }

  async #releaseTemporaryDirectory(): Promise<void> {
    if (!this.#temporaryOwned || !this.#temporaryDirectory) return;
    await rm(this.#temporaryDirectory, { recursive: true, force: true });
    this.#temporaryOwned = false;
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    for (const event of acpSessionUpdateEvents(this.#sessionId, params)) this.#record(event);
  }

  /** A settlement must not outrun the events it describes: the report reads both from the Journal. */
  #record(event: TargetEvent, hostObserved = false): void {
    const scoped = this.#scopeToolEvent(event, hostObserved);
    if (!scoped) return;
    const append = this.#sink.append(scoped)
      .catch((error: unknown) => {
        this.#turns.stash(new AcpUnavailableError(`Failed to record ${this.#displayName} update: ${asError(error).message}`));
      })
      .finally(() => this.#appends.delete(append));
    this.#appends.add(append);
  }

  /**
   * A denied permission is the only approval fact worth a Journal row: `rejectedApprovals` in the comparison report
   * is read from it. A granted request would repeat itself for every tool call and is already declared as an
   * `ExecutionBoundary` limitation, so it stays out.
   */
  #decidePermission(request: Record<string, unknown>): AcpPermissionDecision {
    const decision = allowFirstOption(request);
    if (!('cancelled' in decision)) return decision;
    const toolCall = record(request.toolCall);
    const callId = text(toolCall.toolCallId);
    const title = text(toolCall.title);
    const kind = text(toolCall.kind);
    this.#record(runtimeTargetEvent('tool_finished', {
      ...(callId ? { callId } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      status: 'failed',
      permissionDecision: 'cancelled',
    }), true);
    return decision;
  }

  /**
   * ACP only guarantees a `toolCallId` inside one turn, while the Journal refuses a second `tool_finished` for the
   * same id. Scoping the id to its turn keeps a reused id legal without dropping the later turn's tool from evidence;
   * a repeat inside one turn is still recorded once, because the Journal rejects the duplicate.
   *
   * A terminal update whose call was never announced in this scope belongs to a turn that already settled: its
   * evidence is recorded, and keeping the update would file it under the next turn, where `#finishedCalls` would
   * swallow that turn's real `tool_started`/`tool_finished` when the agent reuses the id. Dropping it loses nothing.
   * A denied permission is the one exception, because the Host observes that decision itself.
   */
  #scopeToolEvent(event: TargetEvent, hostObserved: boolean): TargetEvent | undefined {
    if (event.type !== 'runtime.tool_started' && event.type !== 'runtime.tool_finished') return event;
    const payload = record(event.payload);
    const callId = text(payload.callId);
    if (!callId) return event;
    const scoped = `${this.#activeTurnId ?? this.#sessionId}:${callId}`;
    if (event.type === 'runtime.tool_started') {
      if (this.#finishedCalls.has(scoped)) return undefined;
      this.#startedCalls.add(scoped);
      return { ...event, payload: { ...payload, callId: scoped } };
    }
    if (this.#finishedCalls.has(scoped)) return undefined;
    if (!hostObserved && !this.#startedCalls.has(scoped)) return undefined;
    this.#finishedCalls.add(scoped);
    return { ...event, payload: { ...payload, callId: scoped } };
  }

  async #flush(): Promise<void> {
    await Promise.allSettled([...this.#appends]);
  }

  async #settle(stopReason: string | undefined): Promise<void> {
    await this.#flush();
    const turnId = this.#activeTurnId ?? this.#sessionId;
    this.#activeTurnId = undefined;
    const settlement = acpTurnSettlement({ stopReason, turnId });
    if (!settlement) {
      const detail = stopReason === undefined ? 'missing stopReason' : summarizeDiagnostic(stopReason);
      this.#record(runtimeTargetEvent('runtime_failed', {
        message: 'Unrecognized session/prompt stopReason.',
        stopReason: stopReason === undefined ? null : detail,
      }));
      this.#turns.fail(new AcpUnavailableError(`${this.#displayName} reported an unrecognized turn settlement (${detail}).`));
      return;
    }
    this.#turns.deliver(settlement);
  }

  #onClosed(error: Error): void {
    this.#status = 'stopped';
    this.#turns.fail(error);
    if (this.#stopRequested) return;
    // `session_failed` is the opener for a run that died before `session_started`; the Journal refuses any other type there.
    // `AcpClient` wraps JSON-RPC error text verbatim, so agent-authored text is redacted before the Journal sees it.
    const message = summarizeDiagnostic(error.message);
    this.#record(this.#started
      ? runtimeTargetEvent('runtime_failed', { message })
      : runtimeTargetEvent('session_failed', { message }));
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new AcpUnavailableError(String(value));
}
