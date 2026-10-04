import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/host.js';

function event(type: AgentAuditEvent['type'], payload: Record<string, unknown> = {}): AgentAuditEvent {
  return { type, payload, role: 'comparison', sessionId: 'session' };
}

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
  tracker.observe(event('agent.tool_called', { toolCallId: 'two' }));
  assert.throws(() => tracker.beforeTool('read'), /maxToolCalls/);
  assert.throws(() => tracker.observe(event('agent.model_request')), /maxToolCalls/);
  assert.equal(tracker.snapshot().toolCalls, 2);
});

test('soft limits allow findings closure and preserve compose/review resources', () => {
  const tracker = new ComparisonResourceTracker({ investigationModelRequests: 1, investigationToolCalls: 1 });
  tracker.observe(event('agent.model_request'));
  assert.equal(tracker.beforeTool('read'), 'investigationModelRequests');
  assert.equal(tracker.beforeTool('update_comparison_findings'), undefined);
  tracker.phase('compose');
  assert.equal(tracker.beforeTool('submit_comparison_draft'), undefined);
  tracker.phase('review');
  assert.equal(tracker.beforeTool('preview_report'), undefined);
  const tools = new ComparisonResourceTracker({ investigationToolCalls: 1 });
  tools.observe(event('agent.tool_called', { toolCallId: 'one' }));
  assert.equal(tools.beforeTool('read'), 'investigationToolCalls');
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

test('elapsed investigation allowance does not reset during continuation', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({ investigationMs: 10, maxElapsedMs: 100 });
  t.mock.timers.tick(11);
  tracker.phase('investigate');
  assert.equal(tracker.softReason(), 'investigationMs');
  t.mock.timers.tick(90);
  assert.throws(() => tracker.beforeTool('update_comparison_findings'), /maxElapsedMs/);
});

test('compose and review time do not fabricate an investigation limit', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({ investigationMs: 10 });
  t.mock.timers.tick(5);
  tracker.phase('compose');
  t.mock.timers.tick(100);
  tracker.phase('review');
  assert.equal(tracker.softReason(), undefined);
  tracker.phase('investigate');
  t.mock.timers.tick(6);
  assert.equal(tracker.softReason(), 'investigationMs');
});
