import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker, DEFAULT_COMPARISON_RESOURCES } from '../../src/agents/comparison-resources.js';
import { comparisonOutputContinuation } from '../../src/agents/comparison-invocation-boundaries.js';

test('default Comparison keeps one twenty-four-hour total limit across requests and tools without stage reserves', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  assert.deepEqual(DEFAULT_COMPARISON_RESOURCES, { maxElapsedMs: 24 * 60 * 60_000 });
  const tracker = new ComparisonResourceTracker(DEFAULT_COMPARISON_RESOURCES);
  for (let index = 0; index < 100; index++) tracker.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 's', payload: {} });
  for (let index = 0; index < 500; index++) tracker.observe({ type: 'agent.tool_called', role: 'comparison', sessionId: 's', payload: { toolCallId: String(index) } });
  for (let index = 0; index < 12; index++) {
    t.mock.timers.tick(130_000);
    assert.equal(tracker.beforeTool('read'), undefined);
  }
  assert.equal(tracker.snapshot().remainingRequests, null);
  assert.equal(tracker.snapshot().remainingTools, null);
  const remainingMs = 24 * 60 * 60_000 - 12 * 130_000;
  assert.equal(tracker.snapshot().remainingMs, remainingMs);
  t.mock.timers.tick(remainingMs - 1);
  assert.equal(tracker.beforeTool('preview_report'), undefined, 'no hidden finishing reserve');
  t.mock.timers.tick(1);
  assert.throws(() => tracker.beforeTool('preview_report'), /maxElapsedMs/);
});

test('output continuation keeps repeated truncations under caller deadline and never continues unrelated outcomes', async () => {
  let attempts = 0;
  const result = await comparisonOutputContinuation(async () => ++attempts < 5
    ? { status: 'yielded', sessionId: 's', reason: 'output_limit' }
    : { status: 'yielded', sessionId: 's', reason: 'report_ready' }, 'continue');
  assert.equal(attempts, 5);
  assert.equal(result.status, 'yielded');
  for (const outcome of [{ status: 'cancelled' as const, sessionId: 's' },
    { status: 'failed' as const, sessionId: 's', failure: { code: 'agent_timeout' as const, message: 'timed out', attempts: 1 } }]) {
    let calls = 0;
    assert.deepEqual(await comparisonOutputContinuation(async () => { calls++; return outcome; }, 'continue'), outcome);
    assert.equal(calls, 1);
  }
  await assert.rejects(comparisonOutputContinuation(async () => { throw new Error('maxElapsedMs'); }, 'continue'), /maxElapsedMs/);
});
