import type {
  AvailableRuntime,
  PreparedRuntimeEnvironment,
  ResolvedRuntime,
  RuntimeAvailability,
  RuntimeModelOffer,
  RuntimePort,
  RuntimeRequest,
  TargetEventSink,
  TargetRunner,
} from '../../../src/core/runtime.js';

export class FakeRuntimePort implements RuntimePort {
  readonly id = 'fake';

  async inspectAvailable(): Promise<readonly AvailableRuntime[]> {
    return [];
  }

  async inspectAvailability(): Promise<readonly RuntimeAvailability[]> {
    return [{
      productId: 'fake',
      status: 'not_installed',
      observedAt: new Date().toISOString(),
      installHint: 'The fake pack is a contract fixture and has no installable CLI.',
    }];
  }

  async resolve(request: RuntimeRequest): Promise<ResolvedRuntime> {
    if (request.productId !== 'fake') throw new Error(`Unknown product ${request.productId}.`);
    throw new Error('Fake runtime is not installed.');
  }

  async validateCandidate(request: RuntimeRequest): Promise<ResolvedRuntime> {
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

  async createRunner(_runtime: ResolvedRuntime, _environment: PreparedRuntimeEnvironment, _sink: TargetEventSink): Promise<TargetRunner> {
    throw new Error('Fake runtime cannot create a runner.');
  }
}
