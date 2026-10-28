import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProductRuntime } from '../../src/core/runtime.js';
import { resolveVerifiedCandidate } from '../../src/application/experiment-preflight.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import { dshPackDefinition, dshProductPack } from '../../src/products/packs/dsh/pack.js';

test('a runtime that declares it cannot verify model identity passes admission with an honest unknown', async () => {
  const installed = createAcpPack(dshPackDefinition, { executable: process.execPath });
  assert.equal(installed.runtime.verifiesModelIdentity?.(), false);
  const resolved = await resolveVerifiedCandidate(installed.runtime, dshProductPack.defaultCandidate());
  // Admission must let 'unknown' through without turning it into a claimed model.
  assert.equal(resolved.resolvedModel, 'unknown');
  assert.equal(resolved.requestedModel, 'deepseek-v4-flash');
  assert.equal(resolved.executable, process.execPath);
});

test('a runtime that stays silent on model identity still rejects an unknown resolved model', async () => {
  await assert.rejects(
    resolveVerifiedCandidate(silentRuntime(), { candidateId: 'fixture-model', productId: 'fixture', requestedModel: 'fixture-model' }),
    { message: 'Candidate model is not verified by the target runtime.' },
  );
});

/** Minimal runtime that omits the optional declaration, so the shared rule must keep rejecting 'unknown'. */
function silentRuntime(): ProductRuntime {
  const resolved = (request: { requestedModel: string }) => ({
    productId: 'fixture',
    executable: 'fixture',
    requestedModel: request.requestedModel,
    resolvedModel: 'unknown',
  });
  return {
    id: 'fixture',
    inspectAvailable: async () => [{ productId: 'fixture', executable: 'fixture' }],
    inspectAvailability: async () => [{ productId: 'fixture', executable: 'fixture', status: 'available', observedAt: '2026-01-01T00:00:00.000Z' }],
    resolve: async (request) => resolved(request),
    validateCandidate: async (request) => resolved(request),
    listCatalog: async () => [],
    recoveryCapabilities: () => ({ sessionHistory: 'unavailable', localArtifacts: false, workspaceHistory: false, externalSideEffects: 'unobserved' }),
    createRunner: async () => { throw new Error('This runtime never creates a runner in an admission test.'); },
  };
}
