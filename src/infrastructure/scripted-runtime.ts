import type {
  DeliveryReceipt,
  MessageIdentity,
  RuntimeCapabilities,
  RuntimeStopReason,
  TargetEventSink,
  TargetRunner,
  TargetStatus,
  TurnSettlement,
  UserMessage,
} from '../core/runtime.js';
import type { CandidateSessionHandle } from '../core/schema.js';

export type ScriptedSettlement = TurnSettlement | Error | Promise<TurnSettlement>;

export class ScriptedRunner implements TargetRunner {
  readonly started: MessageIdentity[] = [];
  readonly sent: MessageIdentity[] = [];
  stopped?: RuntimeStopReason;
  closed = false;
  readonly handle: CandidateSessionHandle;
  #deliveries: DeliveryReceipt[];
  #settlements: ScriptedSettlement[];
  #stopError: Error | undefined;
  #hangStop: boolean;
  #cancelled = false;
  #waitReject: ((reason: Error) => void) | undefined;
  #sink: TargetEventSink | undefined;

  constructor(
    deliveries: readonly DeliveryReceipt[],
    settlements: readonly ScriptedSettlement[],
    stopError?: Error,
    options?: {
      hangStop?: boolean;
      sessionId?: string;
      workspaceRoot?: string;
      productId?: string;
      requestedModel?: string;
      resolvedModel?: string;
      sink?: TargetEventSink;
    },
  ) {
    this.#deliveries = [...deliveries];
    this.#settlements = [...settlements];
    this.#stopError = stopError;
    this.#hangStop = options?.hangStop === true;
    this.#sink = options?.sink;
    this.handle = {
      sessionId: options?.sessionId ?? 'scripted-session',
      productId: options?.productId ?? 'fake',
      requestedModel: options?.requestedModel ?? 'fake-model',
      resolvedModel: options?.resolvedModel ?? 'fake-model',
      workspaceRoot: options?.workspaceRoot ?? '.',
    };
  }

  capabilities(): RuntimeCapabilities {
    return { nativeAdmission: true, clientMessageId: true, nativeTurnSettlement: true, tokenTelemetry: 'none', reconnectSession: false, querySubmissionByClientId: false, confirmProcessTermination: true };
  }

  session(): CandidateSessionHandle {
    return this.handle;
  }

  setRequestTimeout(_milliseconds: number): void {}

  cancelWait(reason: string): void {
    this.#cancelled = true;
    this.#waitReject?.(new Error(reason));
  }

  async inspect(): Promise<TargetStatus> {
    return this.stopped || this.closed ? 'stopped' : 'running';
  }

  async start(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    this.started.push(identity);
    await this.#emit('session_started', { sessionId: this.handle.sessionId });
    await this.#emit('message_submitted', { sessionId: this.handle.sessionId, messageId: message.id });
    const receipt = this.#nextDelivery();
    await this.#emit('delivery_observed', { sessionId: this.handle.sessionId, delivery: receipt.delivery, turnId: receipt.turnId });
    return receipt;
  }

  async send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    this.sent.push(identity);
    await this.#emit('message_submitted', { sessionId: this.handle.sessionId, messageId: message.id });
    const receipt = this.#nextDelivery();
    await this.#emit('delivery_observed', { sessionId: this.handle.sessionId, delivery: receipt.delivery, turnId: receipt.turnId });
    return receipt;
  }

  async waitForTurn(): Promise<TurnSettlement> {
    if (this.#cancelled) throw new Error('Harness stopped waiting for this turn.');
    const result = this.#settlements.shift();
    if (result instanceof Error) throw result;
    if (result instanceof Promise) {
      return new Promise<TurnSettlement>((resolve, reject) => {
        this.#waitReject = reject;
        void result.then((value) => {
          if (this.#cancelled) return;
          void this.#emit('turn_settled', { sessionId: this.handle.sessionId, turnId: value.turnId, status: value.status }).then(() => resolve(value));
        }, reject);
      });
    }
    if (!result) throw new Error('Scripted Runtime is missing a settlement.');
    if (result.status === 'completed') {
      await this.#emit('visible_output', { sessionId: this.handle.sessionId, turnId: result.turnId, text: 'Done.' });
    }
    await this.#emit('turn_settled', { sessionId: this.handle.sessionId, turnId: result.turnId, status: result.status });
    return result;
  }

  async stop(reason: RuntimeStopReason): Promise<void> {
    this.stopped = reason;
    await this.#emit('session_stopped', { sessionId: this.handle.sessionId, reason });
    if (this.#hangStop) return new Promise(() => undefined);
    if (this.#stopError) throw this.#stopError;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.stopped) await this.stop('shutdown');
    await this.#emit('session_closed', { sessionId: this.handle.sessionId });
  }

  #nextDelivery(): DeliveryReceipt {
    const result = this.#deliveries.shift();
    if (!result) throw new Error('Scripted Runtime is missing a delivery receipt.');
    return result;
  }

  async #emit(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.#sink) return;
    await this.#sink.append({
      type: `runtime.${type}`,
      occurredAt: '2026-09-09T00:00:00.000Z',
      payload: { ...payload, evidenceRefs: [] },
    });
  }
}
