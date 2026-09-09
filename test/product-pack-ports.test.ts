import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  CandidateLaunchContextSchema,
  CandidateSessionHandleSchema,
} from '../src/core/schema.js';
import { PACK_API_MAJOR } from '../src/products/contract.js';
import { packHistory, packRuntime } from '../src/products/pack-access.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';
import { candidateLaunchFor } from '../src/application/candidate-launch.js';

test('fake ProductPack discovers sessions, lists models, and creates a runner', async (t) => {
  assert.equal(fakeProductPack.manifest.apiMajor, PACK_API_MAJOR);
  const discovered = await packHistory(fakeProductPack).discover();
  assert.ok(discovered.items.length > 0);
  const catalog = await packRuntime(fakeProductPack).listCatalog();
  assert.deepEqual(catalog.map((item) => item.value), ['fake-model']);
  const resolved = await packRuntime(fakeProductPack).validateCandidate({
    productId: 'fake',
    requestedModel: 'fake-model',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'reprise-fake-runner-'));
  t.after(async () => rm(workspace, { recursive: true, force: true }));
  const environment = { environmentId: 'env-1', runId: 'run-1', root: workspace };
  const runner = await packRuntime(fakeProductPack).createRunner(
    resolved,
    environment,
    { append: async () => undefined },
    candidateLaunchFor(resolved, environment),
  );
  const receipt = await runner.start({ id: 'm1', text: 'ping' }, {
    runId: 'run-1',
    turnIndex: 0,
    clientMessageId: 'client-1',
  });
  assert.equal(receipt.delivery, 'accepted');
  await runner.stop('completed');
});

test('CandidateLaunchContext and CandidateSessionHandle persist only after schema check', () => {
  const context = {
    experimentId: 'exp-1',
    runId: 'run-1',
    workspaceRoot: 'C:/reprise/workspace',
    productId: 'fake',
    requestedModel: 'fake-model',
    resolvedModel: 'fake-model',
    permissions: { filesystem: 'workspace' },
  };
  const handle = {
    sessionId: 'session-1',
    productId: 'fake',
    requestedModel: 'fake-model',
    resolvedModel: 'fake-model',
    workspaceRoot: 'C:/reprise/workspace',
  };
  assert.equal(Value.Check(CandidateLaunchContextSchema, context), true);
  assert.equal(Value.Check(CandidateSessionHandleSchema, handle), true);
  assert.equal(Value.Check(CandidateLaunchContextSchema, { ...context, experimentId: '' }), false);
  assert.equal(Value.Check(CandidateSessionHandleSchema, { ...handle, sessionId: '' }), false);
});
