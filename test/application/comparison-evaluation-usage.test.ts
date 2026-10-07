import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import { summarizeComparisonEvaluationUsage } from '../../src/application/comparison-evaluation-usage.js';

const rates = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 });
function event(type: string, payload: Record<string, unknown>): EventEnvelope {
  return { schemaVersion: 1, sequence: 1, eventId: 'fixture', occurredAt: '2026-10-05T00:00:00.000Z', type, payload, checksum: 'a'.repeat(64) };
}
function pair(index: number, model: string, scope = 'generation', input = 1_000_000) {
  const identity = { sessionId: 'comparison-session', invocationId: 'inv-1', requestIndex: index, scope };
  return [event('agent.model_request', { ...identity, model: 'requested-model' }),
    event('agent.usage_reported', { ...identity, model, usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input } })];
}

test('evaluation prices the actual audited model instead of the requested configuration', () => {
  const result = summarizeComparisonEvaluationUsage(pair(1, 'actual-model'), undefined,
    { 'requested-model': rates(1), 'actual-model': rates(4) });
  assert.equal(result.usageCoverage, 'complete');
  assert.equal(result.pricingLookup, 'hit');
  assert.equal(result.estimatedCostUsd, 4);
  assert.equal(result.knownEstimatedCostUsd, 4);
});

test('mixed generation/compaction models keep unknown totals and only sum known price parts', () => {
  const result = summarizeComparisonEvaluationUsage([...pair(1, 'known-model'), ...pair(2, 'unknown-model', 'compaction')], undefined,
    { 'known-model': rates(2), 'requested-model': rates(1) });
  assert.equal(result.usage?.input, 2_000_000);
  assert.equal(result.usageCoverage, 'complete');
  assert.equal(result.pricingLookup, 'miss');
  assert.equal(result.estimatedCostUsd, undefined);
  assert.equal(result.knownEstimatedCostUsd, 2);
  const entirelyUnknown = summarizeComparisonEvaluationUsage(pair(1, 'unknown-model'), undefined, {});
  assert.equal(entirelyUnknown.knownEstimatedCostUsd, undefined);
});

test('invalid pricing wins over missing and hit; partial usage never becomes a full cost estimate', () => {
  const invalid = summarizeComparisonEvaluationUsage([...pair(1, 'known'), ...pair(2, 'missing'), ...pair(3, 'invalid')], undefined,
    { known: rates(2), invalid: rates(-1) });
  assert.equal(invalid.pricingLookup, 'invalid');
  assert.equal(invalid.estimatedCostUsd, undefined);
  assert.equal(invalid.knownEstimatedCostUsd, 2);
  const partial = summarizeComparisonEvaluationUsage([...pair(1, 'known'), pair(2, 'known')[0]!], undefined, { known: rates(2) });
  assert.equal(partial.usageCoverage, 'partial');
  assert.equal(partial.pricingLookup, 'hit');
  assert.equal(partial.estimatedCostUsd, undefined);
  assert.equal(partial.knownEstimatedCostUsd, 2);
  assert.deepEqual(summarizeComparisonEvaluationUsage([]), { usageCoverage: 'missing', pricingLookup: 'miss' });
});

test('operator override is resolved per actual model and malformed usage remains an error', () => {
  const result = summarizeComparisonEvaluationUsage(pair(1, 'actual-model'), { override: { status: 'ready', version: 'fixture-v1',
    models: [{ modelId: 'actual-model', currency: 'USD', unit: 'per_million_tokens', ...rates(7) }] } });
  assert.equal(result.estimatedCostUsd, 7);
  assert.equal(result.pricingLookup, 'hit');
  const unreadable = summarizeComparisonEvaluationUsage(pair(1, 'actual-model'), { override: { status: 'unreadable' } });
  assert.equal(unreadable.pricingLookup, 'invalid');
  assert.equal(unreadable.estimatedCostUsd, undefined);
  assert.throws(() => summarizeComparisonEvaluationUsage(pair(1, 'actual-model', 'generation', -1)), /Invalid evaluation usage/);
  assert.throws(() => summarizeComparisonEvaluationUsage(pair(1, 'actual-model', 'generation', 0.5)), /Invalid evaluation usage/);
  assert.throws(() => summarizeComparisonEvaluationUsage([...pair(1, 'actual-model', 'generation', Number.MAX_SAFE_INTEGER),
    ...pair(2, 'actual-model', 'compaction', 1)]), /safe integer/);
});
