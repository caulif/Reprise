import type {
  AvailableRuntime,
  PreparedRuntimeEnvironment,
  ResolvedRuntime,
  RuntimeAvailability,
  RuntimeModelOffer,
  ProductRuntime,
  RuntimeRequest,
  TargetEventSink,
  TargetRunner,
} from '../../../src/core/runtime.js';
import type { CandidateLaunchContext } from '../../../src/core/schema.js';
import { ScriptedRunner } from '../../../src/infrastructure/scripted-runtime.js';

export type FakeRunnerMode =
  | 'accepted-complete'
  | 'rejected'
  | 'unknown-delivery'
  | 'waiting-input'
  | 'failed'
  | 'timeout'
  | 'cancel-late';

export class FakeProductRuntime implements ProductRuntime {
  readonly id = 'fake';
  mode: FakeRunnerMode = 'accepted-complete';
  lastLaunch?: CandidateLaunchContext;

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return [{ productId: 'fake', executable: 'fake' }];
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    return [{
      productId: 'fake',
      executable: 'fake',
      status: 'available',
      observedAt: '2026-09-09T00:00:00.000Z',
    }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    return this.validateCandidate(request);
  }

  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'fake') throw new Error(`Unknown product ${request.productId}.`);
    if (request.requestedModel !== 'fake-model') {
      throw new Error(`Fake catalog does not list ${request.requestedModel}.`);
    }
    return { productId: 'fake', executable: 'fake', requestedModel: request.requestedModel, resolvedModel: 'fake-model' };
  }

  async listCatalog(): Promise<readonly RuntimeModelOffer[]> {
    return [{ value: 'fake-model', displayName: 'fake-model', resolvedModel: 'fake-model' }];
  }

  recoveryCapabilities() {
    return { sessionHistory: 'available' as const, localArtifacts: true, workspaceHistory: false, externalSideEffects: 'unobserved' as const };
  }

  async createRunner(
    runtime: ResolvedRuntime,
    environment: PreparedRuntimeEnvironment,
    sink: TargetEventSink,
    launch: CandidateLaunchContext,
  ): Promise<TargetRunner> {
    if (launch.workspaceRoot !== environment.root) {
      throw new Error('Fake runner must start in CandidateLaunchContext.workspaceRoot.');
    }
    this.lastLaunch = launch;
    const workspaceRoot = launch.workspaceRoot;
    const handle = {
      sessionId: 'fake-session-1',
      productId: runtime.productId,
      requestedModel: runtime.requestedModel,
      resolvedModel: runtime.resolvedModel,
      workspaceRoot,
    };
    const observedAt = '2026-09-09T00:00:01.000Z';
    if (this.mode === 'rejected') {
      return new ScriptedRunner([{ delivery: 'rejected', evidence: 'rpc_response' }], [], undefined, { ...handle, sink });
    }
    if (this.mode === 'unknown-delivery') {
      return new ScriptedRunner([{ delivery: 'unknown', evidence: 'native_event' }], [], undefined, { ...handle, sink });
    }
    if (this.mode === 'waiting-input') {
      return new ScriptedRunner(
        [{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fake-turn-1' }],
        [{ turnId: 'fake-turn-1', status: 'waiting_input', confidence: 'native', observedAt, rawRefs: [] }],
        undefined,
        { ...handle, sink },
      );
    }
    if (this.mode === 'failed') {
      return new ScriptedRunner(
        [{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fake-turn-1' }],
        [{ turnId: 'fake-turn-1', status: 'failed', confidence: 'native', observedAt, rawRefs: [], failure: { kind: 'process', summary: 'Fake process exited.', retryable: false } }],
        undefined,
        { ...handle, sink },
      );
    }
    if (this.mode === 'timeout') {
      return new ScriptedRunner(
        [{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fake-turn-1' }],
        [new Promise<never>(() => undefined)],
        undefined,
        { ...handle, sink },
      );
    }
    if (this.mode === 'cancel-late') {
      let releaseLate: ((settlement: { turnId: string; status: 'completed'; confidence: 'native'; observedAt: string; rawRefs: never[] }) => void) | undefined;
      const late = new Promise<{ turnId: string; status: 'completed'; confidence: 'native'; observedAt: string; rawRefs: never[] }>((resolve) => {
        releaseLate = resolve;
      });
      const runner = new ScriptedRunner(
        [{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fake-turn-1' }],
        [late],
        undefined,
        { ...handle, sink },
      );
      queueMicrotask(() => {
        runner.cancelWait('Harness stopped waiting for this turn.');
        releaseLate?.({ turnId: 'fake-turn-late', status: 'completed', confidence: 'native', observedAt, rawRefs: [] });
      });
      return runner;
    }
    return new ScriptedRunner(
      [{ delivery: 'accepted', evidence: 'native_admission', turnId: 'fake-turn-1', messageId: 'fake-msg-1', acceptedAt: '2026-09-09T00:00:00.000Z' }],
      [{ turnId: 'fake-turn-1', status: 'completed', confidence: 'native', observedAt, rawRefs: [] }],
      undefined,
      { ...handle, sink },
    );
  }
}
