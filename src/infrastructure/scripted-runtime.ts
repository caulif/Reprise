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
  TargetEventSink,
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

export class ScriptedRuntime implements RuntimePort {
  readonly id = 'scripted';

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return [{ productId: 'codex', executable: 'scripted-runtime', version: 'fixture' }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'codex') throw new Error(`Runtime ${request.productId} is unavailable in fixture mode.`);
    if (!request.requestedModel.trim()) throw new Error('A candidate model is required.');
    return { productId: 'codex', executable: 'scripted-runtime', version: 'fixture', requestedModel: request.requestedModel, resolvedModel: request.requestedModel };
  }

  async createRunner(_runtime: ResolvedRuntime, _environment: PreparedRuntimeEnvironment, _sink: TargetEventSink): Promise<TargetRunner> {
    return new ScriptedRunner(
      [{ delivery: 'accepted', evidence: 'native_admission' }],
      [{ turnId: 'turn-1', status: 'waiting_input', confidence: 'native', observedAt: new Date().toISOString(), rawRefs: [] }],
    );
  }
}
