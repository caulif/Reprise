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

test('review allowance is independent from investigation and persists across repair turns', () => {
  const tracker = new ComparisonResourceTracker({ investigationModelRequests: 2 });
  tracker.observe(event('agent.model_request'));
  tracker.observe(event('agent.model_request'));
  assert.equal(tracker.beforeTool('read'), 'investigationModelRequests');
  tracker.phase('review');
  assert.equal(tracker.beforeTool('read'), undefined);
  tracker.observe(event('agent.model_request'));
  tracker.phase('review');
  tracker.observe(event('agent.model_request', { scope: 'compaction' }));
  assert.equal(tracker.beforeTool('render_artifact'), 'reviewModelRequests');
  tracker.phase('compose');
  tracker.phase('review');
  assert.equal(tracker.beforeTool('shell_exec'), 'reviewModelRequests');
  for (const name of ['inspect_comparison_draft', 'quote_evidence', 'update_comparison_findings', 'submit_comparison_draft', 'preview_report', 'write', 'edit']) {
    assert.equal(tracker.beforeTool(name), undefined);
  }
  assert.equal(tracker.snapshot().reviewLimit, 'reviewModelRequests');
});

test('review tools count canonical calls once and deny broad investigation after allowance', () => {
  const tracker = new ComparisonResourceTracker({ investigationToolCalls: 1 });
  tracker.observe(event('agent.tool_called', { toolCallId: 'investigation' }));
  tracker.phase('review');
  assert.equal(tracker.beforeTool('grep'), undefined);
  tracker.observe(event('agent.tool_called', { toolCallId: 'review' }));
  tracker.observe(event('agent.tool_called', { toolCallId: 'review' }));
  tracker.observe(event('agent.tool_called', { nativeHook: 'before' }));
  assert.equal(tracker.beforeTool('register_evidence'), 'reviewToolCalls');
  assert.equal(tracker.snapshot().toolCalls, 2);
  assert.equal(tracker.beforeTool('submit_comparison_draft'), undefined);
});

test('review elapsed time accumulates across repairs without counting compose time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({ investigationMs: 10 });
  tracker.phase('review');
  t.mock.timers.tick(6);
  tracker.phase('compose');
  t.mock.timers.tick(1_000);
  tracker.phase('review');
  assert.equal(tracker.beforeTool('read'), undefined);
  t.mock.timers.tick(4);
  tracker.phase('review');
  assert.equal(tracker.beforeTool('read'), 'reviewMs');
  assert.equal(tracker.beforeTool('preview_report'), undefined);
});

test('review reserves remaining hard resources for explicit finishing without relaxing hard limits', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const requests = new ComparisonResourceTracker({ maxModelRequests: 8 });
  requests.phase('review');
  requests.observe(event('agent.model_request'));
  assert.equal(requests.beforeTool('read'), undefined);
  requests.observe(event('agent.model_request'));
  assert.equal(requests.beforeTool('read'), 'reserve_finish');
  assert.equal(requests.snapshot().remainingRequests, 6);
  assert.equal(requests.beforeTool('preview_report'), undefined);
  assert.equal(requests.beforeTool('quote_evidence'), undefined);
  for (let i = 0; i < 6; i++) requests.observe(event('agent.model_request'));
  assert.throws(() => requests.observe(event('agent.model_request')), /maxModelRequests/);
  const tools = new ComparisonResourceTracker({ maxToolCalls: 21 });
  tools.phase('review');
  assert.equal(tools.beforeTool('ls'), undefined);
  tools.observe(event('agent.tool_called', { toolCallId: 'one' }));
  assert.equal(tools.beforeTool('ls'), 'reserve_finish');
  assert.equal(tools.snapshot().remainingTools, 20);
  const elapsed = new ComparisonResourceTracker({ maxElapsedMs: 90_001 });
  elapsed.phase('review');
  assert.equal(elapsed.sourceRemainingMs(), 1);
  assert.equal(elapsed.beforeTool('shell_exec'), undefined);
  t.mock.timers.tick(1);
  assert.equal(elapsed.sourceRemainingMs(), 0);
  assert.equal(elapsed.beforeTool('shell_exec'), 'reserve_finish');
  assert.equal(elapsed.snapshot().remainingMs, 90_000);
  t.mock.timers.tick(90_000);
  assert.throws(() => elapsed.beforeTool('preview_report'), /maxElapsedMs/);
  assert.throws(() => elapsed.beforeTool('quote_evidence'), /maxElapsedMs/);
});

test('empty resource override keeps all review investigation and finishing tools unlimited', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({});
  tracker.phase('review');
  for (let i = 0; i < 50; i++) {
    tracker.observe(event('agent.model_request'));
    tracker.observe(event('agent.tool_called', { toolCallId: `tool-${i}` }));
  }
  t.mock.timers.tick(1_000_000);
  assert.equal(tracker.beforeTool('read'), undefined);
  assert.equal(tracker.beforeTool('preview_report'), undefined);
  assert.equal(tracker.snapshot().phase, 'review');
  assert.equal(tracker.snapshot().reviewLimit, null);
  assert.equal(tracker.snapshot().remainingRequests, null);
  assert.equal(tracker.snapshot().remainingTools, null);
  assert.equal(tracker.snapshot().remainingMs, null);
  assert.equal(tracker.sourceRemainingMs(), undefined);
});

test('source deadline uses accumulated review time and the existing global finishing reserve', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({ investigationMs: 120_000, maxElapsedMs: 600_000 });
  t.mock.timers.tick(100_000);
  assert.equal(tracker.sourceRemainingMs(), 120_000, 'investigation time does not spend the independent review allowance');
  tracker.phase('review');
  assert.equal(tracker.sourceRemainingMs(), 120_000);
  t.mock.timers.tick(30_000);
  assert.equal(tracker.sourceRemainingMs(), 90_000);
  tracker.phase('compose');
  t.mock.timers.tick(330_000);
  tracker.phase('review');
  assert.equal(tracker.sourceRemainingMs(), 50_000, 'global 90s finishing reserve is stricter than 90s local review remainder');
  t.mock.timers.tick(50_000);
  assert.equal(tracker.sourceRemainingMs(), 0);
  assert.equal(tracker.beforeTool('read'), 'reserve_finish');
  assert.equal(tracker.beforeTool('preview_report'), undefined);
  t.mock.timers.tick(90_000);
  assert.throws(() => tracker.checkHard('after local yield'), /maxElapsedMs/);
});

test('source local allowance does not reset after returning to review and clamps exhausted time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = new ComparisonResourceTracker({ investigationMs: 10 });
  tracker.phase('review');
  t.mock.timers.tick(6);
  tracker.phase('compose');
  t.mock.timers.tick(1_000);
  tracker.phase('review');
  assert.equal(tracker.sourceRemainingMs(), 4);
  t.mock.timers.tick(4);
  assert.equal(tracker.sourceRemainingMs(), 0);
  t.mock.timers.tick(4);
  assert.equal(tracker.sourceRemainingMs(), 0);
  assert.equal(tracker.beforeTool('read'), 'reviewMs');
});
