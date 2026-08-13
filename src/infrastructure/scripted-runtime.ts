import type {
  DeliveryReceipt,
  MessageIdentity,
  RuntimeCapabilities,
  RuntimeStopReason,
  TargetRunner,
  TargetStatus,
  TurnSettlement,
  UserMessage,
} from '../core/runtime.js';

export type ScriptedSettlement = TurnSettlement | Error | Promise<never>;

export class ScriptedRunner implements TargetRunner {
  readonly started: MessageIdentity[] = [];
  readonly sent: MessageIdentity[] = [];
  stopped?: RuntimeStopReason;
  #deliveries: DeliveryReceipt[];
  #settlements: ScriptedSettlement[];
  #stopError: Error | undefined;

  constructor(deliveries: readonly DeliveryReceipt[], settlements: readonly ScriptedSettlement[], stopError?: Error) {
    this.#deliveries = [...deliveries];
    this.#settlements = [...settlements];
    this.#stopError = stopError;
  }

  capabilities(): RuntimeCapabilities {
    return { nativeAdmission: true, clientMessageId: true, nativeTurnSettlement: true, tokenTelemetry: 'none', reconnectSession: false, querySubmissionByClientId: false, confirmProcessTermination: true };
  }

  setRequestTimeout(_milliseconds: number): void {}

  async inspect(): Promise<TargetStatus> {
    return this.stopped ? 'stopped' : 'running';
  }

  async start(_message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    this.started.push(identity);
    return this.#nextDelivery();
  }

  async send(_message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt> {
    this.sent.push(identity);
    return this.#nextDelivery();
  }

  async waitForTurn(): Promise<TurnSettlement> {
    const result = this.#settlements.shift();
    if (result instanceof Error) throw result;
    if (result instanceof Promise) return result;
    if (!result) throw new Error('Scripted Runtime is missing a settlement.');
    return result;
  }

  async stop(reason: RuntimeStopReason): Promise<void> {
    this.stopped = reason;
    if (this.#stopError) throw this.#stopError;
  }

  #nextDelivery(): DeliveryReceipt {
    const result = this.#deliveries.shift();
    if (!result) throw new Error('Scripted Runtime is missing a delivery receipt.');
    return result;
  }
}
