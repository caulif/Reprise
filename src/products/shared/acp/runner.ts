import { randomUUID } from 'node:crypto';
import { record, text } from '../../../core/json.js';
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
import { AcpClient, AcpUnavailableError } from './client.js';
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
  env?: Readonly<Record<string, string | undefined>>;
  completeEnv?: NodeJS.ProcessEnv;
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
  readonly #turns = new TurnWaiter();
  #sessionId: string = randomUUID();
  #status: TargetStatus = 'starting';
  #activeTurnId: string | undefined;
  #stopRequested = false;

  constructor(options: AcpRunnerOptions) {
    this.#displayName = options.displayName;
    this.#sink = options.sink;
    this.#runtime = options.runtime;
    this.#workspaceRoot = options.environment.root;
    this.#client = new AcpClient({
      executable: options.runtime.executable,
      args: options.args,
      cwd: options.environment.root,
      ...(options.env ? { env: options.env } : {}),
      ...(options.completeEnv ? { completeEnv: options.completeEnv } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      onNotification: (method, params) => this.#onNotification(method, params),
      onClosed: (error) => this.#onClosed(error),
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
    this.#client.start();
    await this.#client.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    const created = record(await this.#client.request('session/new', { cwd: this.#workspaceRoot, mcpServers: [] }));
    const sessionId = text(created.sessionId);
    if (!sessionId) throw new AcpUnavailableError(`${this.#displayName} did not return a session id for session/new.`);
    this.#sessionId = sessionId;
    this.#status = 'running';
    await this.#sink.append(runtimeTargetEvent('session_started', { sessionId }));
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
    await this.#sink.append(runtimeTargetEvent('session_stopped', { reason, sessionId: this.#sessionId }));
    if (this.#status === 'running') this.#client.notify('session/cancel', { sessionId: this.#sessionId });
    let closeError: unknown;
    try {
      await this.#client.close();
    } catch (error) {
      closeError = error;
    }
    this.#status = 'stopped';
    if (closeError) throw asError(closeError);
  }

  async close(): Promise<void> {
    if (this.#status !== 'stopped') await this.stop('shutdown');
    await this.#sink.append(runtimeTargetEvent('session_closed', { sessionId: this.#sessionId }));
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    for (const event of acpSessionUpdateEvents(this.#sessionId, params)) {
      void this.#sink.append(event).catch((error: unknown) => {
        this.#turns.stash(new AcpUnavailableError(`Failed to record ${this.#displayName} update: ${asError(error).message}`));
      });
    }
  }

  #settle(stopReason: string | undefined): void {
    const turnId = this.#activeTurnId ?? this.#sessionId;
    this.#activeTurnId = undefined;
    const settlement = acpTurnSettlement({ stopReason, turnId });
    if (!settlement) {
      void this.#sink.append(runtimeTargetEvent('runtime_failed', { message: 'Unrecognized session/prompt stopReason.', stopReason: stopReason ?? null }));
      this.#turns.fail(new AcpUnavailableError(`${this.#displayName} reported an unrecognized turn settlement (${stopReason ?? 'missing stopReason'}).`));
      return;
    }
    this.#turns.deliver(settlement);
  }

  #onClosed(error: Error): void {
    this.#status = 'stopped';
    this.#turns.fail(error);
    if (this.#stopRequested) return;
    void this.#sink.append(runtimeTargetEvent('runtime_failed', { message: error.message })).catch((appendError: unknown) => {
      this.#turns.stash(new AcpUnavailableError(`Failed to record ${this.#displayName} process exit: ${asError(appendError).message}`));
    });
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new AcpUnavailableError(String(value));
}
