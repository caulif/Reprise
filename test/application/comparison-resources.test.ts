import test from 'node:test';

import assert from 'node:assert/strict';

import { ComparisonResourceTracker, DEFAULT_COMPARISON_RESOURCES } from '../../src/agents/comparison-resources.js';

import { comparisonToolFeedback } from '../../src/agents/comparison-tool-feedback.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/host.js';

function event(type: AgentAuditEvent['type'], payload: Record<string, unknown> = {}): AgentAuditEvent {
  return { type, payload, role: 'comparison', sessionId: 'session' };
}

test('default Comparison permits work beyond thirty minutes and stops at twenty-four hours', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker(DEFAULT_COMPARISON_RESOURCES);
  t.mock.timers.tick(30 * 60_000);
  assert.equal(tracker.beforeTool('read'), undefined);
  assert.equal(tracker.snapshot().remainingMs, 23.5 * 60 * 60_000);

  t.mock.timers.tick(23.5 * 60 * 60_000 - 1);
  assert.equal(tracker.beforeTool('preview_report'), undefined);
  t.mock.timers.tick(1);
  assert.throws(() => tracker.beforeTool('preview_report'), /maxElapsedMs/);
});

test('hard model limit rejects the next generation or compaction before counting it', () => {
  const tracker = new ComparisonResourceTracker({ maxModelRequests: 1 });
  tracker.observe(event('agent.model_request'));
  assert.throws(() => tracker.observe(event('agent.model_request', { scope: 'compaction' })), /maxModelRequests/);
  assert.equal(tracker.snapshot().modelRequests, 1);
});

test('canonical tools count once and exhausted hard tool budget blocks further requests', () => {
  const tracker = new ComparisonResourceTracker({ maxToolCalls: 1 });
  tracker.observe(event('agent.tool_called', { toolCallId: 'one' }));
  tracker.observe(event('agent.tool_called', { toolCallId: 'one' }));
  tracker.observe(event('agent.tool_called', { nativeHook: 'before' }));
  assert.equal(tracker.beforeTool('read'), undefined);
  assert.throws(() => tracker.observe(event('agent.tool_called', { toolCallId: 'two' })), /maxToolCalls/);
  assert.equal(tracker.snapshot().toolCalls, 1);
});

test('unknown or incomplete usage is never zero and explicit cost protection fails closed', () => {
  const empty = new ComparisonResourceTracker({});
  assert.equal(empty.snapshot().estimatedCostUsd, null);
  assert.equal(empty.snapshot().pricingIncomplete, true);
  const tracker = new ComparisonResourceTracker({ maxEstimatedCostUsd: 1 });
  tracker.observe(event('agent.model_request'));
  assert.throws(() => tracker.checkHard('next call'), /missing usage or pricing/);
  tracker.observe(event('agent.usage_reported', { estimatedCostUsd: 0.5 }));
  assert.equal(tracker.snapshot().estimatedCostUsd, 0.5);
  tracker.observe(event('agent.model_request'));
  assert.equal(tracker.snapshot().estimatedCostUsd, null);
  tracker.observe(event('agent.usage_reported'));
  assert.throws(() => tracker.beforeTool('read'), /missing usage or pricing/);
  assert.equal(tracker.snapshot().knownEstimatedCostUsd, 0.5);
  const priced = new ComparisonResourceTracker({ maxEstimatedCostUsd: 0.1 });
  priced.observe(event('agent.usage_reported', { estimatedCostUsd: 0.1 }));
  assert.throws(() => priced.checkHard('request'), /maxEstimatedCostUsd/);
});

test('failed-attempt fallback is separate from returned usage and later telemetry replaces it', () => {
  const tracker = new ComparisonResourceTracker({});
  const emit = (type: AgentAuditEvent['type'], requestId: string, cost?: number) => tracker.observe(event(type,
    { requestId, ...(cost === undefined ? {} : { estimatedCostUsd: cost }) }));
  emit('agent.model_request', 'failed');
  emit('agent.usage_estimated', 'failed', 0.023016);
  emit('agent.model_request', 'retry');
  emit('agent.usage_reported', 'retry', 0.177824232);
  assert.equal(tracker.snapshot().estimatedCostUsd, 0.200840232);
  assert.equal(tracker.snapshot().costBasis, 'includes_fallback');
  const feedback = comparisonToolFeedback({ content: 'file contents' }, tracker, 'read');
  assert.match(JSON.stringify(feedback.contentBlocks), /fallback estimate.*1 failed requests/);
  assert.match(JSON.stringify(feedback.contentBlocks), /not a bill or upper bound/);
  assert.equal(tracker.snapshot().knownEstimatedCostUsd, 0.177824232);
  assert.equal(tracker.snapshot().fallbackRequests, 1);
  assert.equal(tracker.snapshot().pricingIncomplete, true);
  emit('agent.usage_reported', 'failed', 0.001);
  emit('agent.usage_estimated', 'failed', 10);
  assert.equal(tracker.snapshot().estimatedCostUsd, 0.178824232);
  assert.equal(tracker.snapshot().costBasis, 'reported_usage');
  assert.equal(tracker.snapshot().fallbackEstimatedCostUsd, 0);
  assert.equal(tracker.snapshot().pricingIncomplete, false);
});

test('unpriced fallback, unpaired telemetry and duplicate request IDs cannot certify a total', () => {
  const tracker = new ComparisonResourceTracker({});
  tracker.observe(event('agent.model_request', { requestId: 'one' }));
  tracker.observe(event('agent.usage_estimated', { requestId: 'one' }));
  assert.equal(tracker.snapshot().estimatedCostUsd, null);
  assert.equal(tracker.snapshot().costBasis, 'incomplete');
  assert.throws(() => tracker.observe(event('agent.model_request', { requestId: 'one' })), /Duplicate/);
  assert.equal(tracker.snapshot().modelRequests, 1);
  assert.throws(() => tracker.observe(event('agent.usage_reported', { requestId: 'other' })), /no matching/);
  assert.throws(() => tracker.observe(event('agent.usage_estimated')), /requires/);
});

test('fallback cost cannot satisfy a hard money protection even when below its limit', () => {
  const tracker = new ComparisonResourceTracker({ maxEstimatedCostUsd: 1 });
  tracker.checkHard('first request');
  tracker.observe(event('agent.model_request', { requestId: 'failed' }));
  tracker.observe(event('agent.usage_estimated', { requestId: 'failed', estimatedCostUsd: 0.1 }));
  assert.throws(() => tracker.beforeTool('write'), /missing usage or pricing/);
});
