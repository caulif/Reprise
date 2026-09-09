import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistRecoveryPreflight, runRecoveryPreflight } from '../src/application/recovery/preflight.js';

test('Recovery preflight returns a ready record after one real validation call', async () => {
  let calls = 0;
  const record = await runRecoveryPreflight({
    providerId: 'provider-a', modelId: 'model-a',
    caller: { async validate() { calls += 1; return { source: 'must-not-persist' }; } },
  }, () => '2026-08-18T00:00:00.000Z');
  assert.deepEqual(record, {
    schemaVersion: 1, status: 'passed', outcome: 'ready', providerId: 'provider-a', modelId: 'model-a', checkedAt: '2026-08-18T00:00:00.000Z', operation: 'preflight.validate', providerReachable: true, modelAccepted: true, toolRoundTrip: true, retryable: false,
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(record).includes('must-not-persist'), false);
});

test('Recovery preflight classifies auth, endpoint, model, and timeout failures without throwing', async () => {
  const cases = [
    ['authentication_failed', 'auth'], ['endpoint_invalid', 'endpoint'],
    ['model_unavailable', 'model'], ['timed_out', 'timeout'],
  ] as const;
  for (const [preflightReason, expected] of cases) {
    const record = await runRecoveryPreflight({
      providerId: 'provider-a', modelId: 'model-a',
      caller: { async validate() { throw Object.assign(new Error('private C:\\secret\\path'), { preflightReason }); } },
    }, () => '2026-08-18T00:00:00.000Z');
    assert.equal(record.status, 'failed', expected);
    assert.equal(record.outcome, 'blocked_before_sampling', expected);
    assert.equal(record.reasonCode, preflightReason, expected);
    assert.equal(JSON.stringify(record).includes('secret'), false);
  }
});

test('Recovery preflight persistence is schema-checked and atomic', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await runRecoveryPreflight({
    providerId: 'provider-a', modelId: 'model-a', caller: { async validate() {} },
  });
  const path = join(root, 'run', 'preflight.json');
  await persistRecoveryPreflight(path, record);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
  await assert.rejects(persistRecoveryPreflight(join(root, 'bad.json'), { ...record, providerId: 'bad id' }), /invalid/);
});
