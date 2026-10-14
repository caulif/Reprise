import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker, DEFAULT_COMPARISON_RESOURCES, comparisonUsesTotalTimeOnly } from '../../src/agents/comparison-resources.js';
import { comparisonTimeout, comparisonWorkDeadline, comparisonOutputContinuation } from '../../src/agents/comparison-invocation-boundaries.js';

test('default Comparison has only a twenty-four-hour total limit across requests, tools and save phases', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  assert.deepEqual(DEFAULT_COMPARISON_RESOURCES, { maxElapsedMs: 24 * 60 * 60_000 });
  const tracker = new ComparisonResourceTracker(DEFAULT_COMPARISON_RESOURCES, { boundedStages: true, totalTimeOnly: comparisonUsesTotalTimeOnly(DEFAULT_COMPARISON_RESOURCES) });
  assert.equal(tracker.totalTimeOnly, true);
  assert.equal(comparisonUsesTotalTimeOnly({}), false);
  assert.equal(comparisonUsesTotalTimeOnly({ maxElapsedMs: 100, maxModelRequests: 1 }), false);
  for (let index = 0; index < 100; index++) tracker.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 's', payload: {} });
  for (let index = 0; index < 500; index++) tracker.observe({ type: 'agent.tool_called', role: 'comparison', sessionId: 's', payload: { toolCallId: String(index) } });
  for (const phase of ['investigate', 'compose', 'review']) {
    for (const pass of ['source-save', 'sources', 'audit', 'preview'] as const) {
      assert.deepEqual(comparisonWorkDeadline(tracker, phase, pass), {});
      t.mock.timers.tick(130_000);
      assert.equal(tracker.beforeTool('read'), undefined);
      assert.equal(tracker.beforeTool('save_comparison_checkpoint'), undefined);
    }
  }
  assert.equal(tracker.snapshot().remainingRequests, null);
  assert.equal(tracker.snapshot().remainingTools, null);
  const remainingMs = 24 * 60 * 60_000 - 12 * 130_000;
  assert.equal(comparisonTimeout(tracker, DEFAULT_COMPARISON_RESOURCES, 5_000), remainingMs);
  t.mock.timers.tick(remainingMs - 1);
  assert.equal(tracker.beforeTool('preview_report'), undefined, 'no hidden finishing reserve');
  t.mock.timers.tick(1);
  assert.throws(() => tracker.beforeTool('preview_report'), /maxElapsedMs/);
  assert.throws(() => comparisonTimeout(tracker, DEFAULT_COMPARISON_RESOURCES, 5_000), /maxElapsedMs/);
});

test('total-time mode permits repeated truncated generations while the invocation still enforces the deadline', async () => {
  let attempts = 0;
  const result = await comparisonOutputContinuation(async () => ++attempts < 5
    ? { status: 'yielded', sessionId: 's', reason: 'output_limit' }
    : { status: 'yielded', sessionId: 's', reason: 'report_ready' }, 'continue', undefined, true);
  assert.equal(attempts, 5);
  assert.equal(result.status, 'yielded');
  await assert.rejects(comparisonOutputContinuation(async () => { throw new Error('maxElapsedMs'); }, 'continue', undefined, true), /maxElapsedMs/);
});
