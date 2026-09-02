export type Delivery = 'accepted' | 'rejected' | 'unknown';
export type RuntimeStopReason = 'completed' | 'cancelled' | 'failed' | 'shutdown';
export type UserMessage = { id: string; text: string };
export type MessageIdentity = { runId: string; turnIndex: number; clientMessageId: string };
export type DeliveryReceipt = {
  delivery: Delivery;
  evidence: 'preflight' | 'rpc_response' | 'native_admission' | 'persisted' | 'native_event';
  turnId?: string;
  messageId?: string;
  acceptedAt?: string;
};
export type RuntimeFailureKind = 'upstream' | 'authentication' | 'protocol' | 'process' | 'unknown';
export type TurnFailure = {
  kind: RuntimeFailureKind;
  summary: string;
  retryable: boolean;
  reconnectCount?: number;
};
export type TurnSettlement = {
  turnId: string;
  status: 'completed' | 'failed' | 'waiting_input' | 'aborted';
  confidence: 'native' | 'composite' | 'heuristic';
  observedAt: string;
  rawRefs: unknown[];
  failure?: TurnFailure;
};

export type AvailableRuntime = {
  productId: string;
  executable: string;
  version?: string;
};
export type RuntimeAvailabilityStatus = 'available' | 'not_installed' | 'unsupported_platform';
export type RuntimeAvailability = {
  productId: string;
  executable?: string;
  observedVersion?: string;
  status: RuntimeAvailabilityStatus;
  observedAt: string;
  installHint?: string;
};
export type RuntimeRequest = {
  productId: string;
  requestedModel: string;
};
/** Product-owned catalog entry. `value` is what CandidateSpec.requestedModel stores. */
export type RuntimeModelOffer = {
  readonly value: string;
  readonly displayName: string;
  readonly resolvedModel?: string;
};
export type ResolvedRuntime = AvailableRuntime & {
  requestedModel: string;
  /** The model the runtime actually reported, or 'unknown' when it never named one. */
  resolvedModel: string;
};
export type PreparedRuntimeEnvironment = { environmentId: string; runId: string; root: string };
export type TargetEvent = { type: string; occurredAt: string; payload: unknown };
export type TargetEventSink = { append(event: TargetEvent): Promise<void> };
export type RuntimeCapabilities = {
  nativeAdmission: boolean;
  clientMessageId: boolean;
  nativeTurnSettlement: boolean;
  tokenTelemetry: 'native' | 'partial' | 'none';
  reconnectSession: boolean;
  querySubmissionByClientId: boolean;
  confirmProcessTermination: boolean;
};
export type TargetStatus = 'starting' | 'running' | 'stopped' | 'unknown';
/** Product-owned sources that Recovery may investigate without consulting credentials. */
export type RecoveryRuntimeCapabilities = {
  sessionHistory: 'available' | 'limited' | 'unavailable';
  localArtifacts: boolean;
  workspaceHistory: boolean;
  /** Local workspace checkpoints never imply that remote, IDE, browser, or database effects were reversed. */
  externalSideEffects: 'unobserved' | 'compensatable';
};

export interface RuntimePort {
  readonly id: string;
  inspectAvailable(): Promise<readonly AvailableRuntime[]>;
  inspectAvailability(): Promise<readonly RuntimeAvailability[]>;
  resolve(request: RuntimeRequest): Promise<ResolvedRuntime>;
  /** Confirms that the requested model is available to this runtime now. */
  validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime>;
  /** Current models this runtime will accept as CandidateSpec.requestedModel. */
  listCatalog(): Promise<readonly RuntimeModelOffer[]>;
  /** Declares local, credential-free evidence sources exposed by this product pack. */
  recoveryCapabilities(): RecoveryRuntimeCapabilities;
  createRunner(runtime: ResolvedRuntime, environment: PreparedRuntimeEnvironment, sink: TargetEventSink): Promise<TargetRunner>;
}

export interface TargetRunner {
  capabilities(): RuntimeCapabilities;
  start(initial: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt>;
  send(message: UserMessage, identity: MessageIdentity): Promise<DeliveryReceipt>;
  waitForTurn(): Promise<TurnSettlement>;
  /**
   * Releases an in-flight waitForTurn() after the Harness stops waiting. Without it a late
   * settlement would resolve the abandoned wait and leak into the next turn.
   */
  cancelWait?(reason: string): void;
  /** CandidateRun gives native RPC calls the same limit as its turn wait. */
  setRequestTimeout(milliseconds: number): void;
  inspect(): Promise<TargetStatus>;
  stop(reason: RuntimeStopReason): Promise<void>;
}
