import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker, DEFAULT_COMPARISON_RESOURCES } from '../../src/agents/comparison-resources.js';
import { comparisonOutputContinuation, comparisonWorkDeadline } from '../../src/agents/comparison-invocation-boundaries.js';

function bounded(maxElapsedMs = 600_000) {
  return new ComparisonResourceTracker({ ...DEFAULT_COMPARISON_RESOURCES, maxElapsedMs }, { boundedStages: true });
}

test('initial findings and final findings share the investigation absolute cutoff', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  const first = comparisonWorkDeadline(tracker, 'investigate', 'initial-findings').yieldDeadline!;
  assert.deepEqual(first, { at: 121_000, reason: 'bounded_investigation_timeout' });
  t.mock.timers.tick(100_000);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'investigate', 'findings').yieldDeadline, first);
  assert.equal(tracker.investigationRemainingMs(), 20_000);
  t.mock.timers.tick(20_000);
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_investigation_timeout');
  assert.equal(tracker.snapshot().workRemainingMs, 0);
});

test('compose and output-limit continuation do not restart their stage allowance', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  tracker.phase('compose');
  const deadline = comparisonWorkDeadline(tracker, 'compose').yieldDeadline!;
  assert.deepEqual(deadline, { at: 91_000, reason: 'bounded_compose_timeout' });
  let calls = 0;
  const outcome = await comparisonOutputContinuation(async () => {
    calls++;
    t.mock.timers.tick(90_000);
    return { status: 'yielded', sessionId: 'author', reason: 'output_limit' };
  }, 'Compose', deadline);
  assert.equal(calls, 1, 'the exhausted stage cannot start another paid request');
  assert.deepEqual(outcome, { status: 'yielded', sessionId: 'author', reason: 'bounded_compose_timeout' });
  assert.deepEqual(comparisonWorkDeadline(tracker, 'compose').yieldDeadline, deadline);
  assert.equal(tracker.beforeTool('submit_comparison_draft'), 'bounded_compose_timeout');
});

test('output-limit continuation uses the original deadline while time remains', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  const deadline = comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!;
  let calls = 0;
  const outcome = await comparisonOutputContinuation(async () => {
    calls++;
    t.mock.timers.tick(40_000);
    assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline, deadline);
    return calls === 1 ? { status: 'yielded', sessionId: 'review', reason: 'output_limit' }
      : { status: 'completed', sessionId: 'review', value: {} };
  }, 'Audit', deadline);
  assert.equal(calls, 2);
  assert.equal(outcome.status, 'completed');
  assert.equal(tracker.snapshot().workRemainingMs, 10_000);
});

test('source and supplement stay bounded while findings closure has a non-renewable allowance', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  const sources = comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!;
  assert.equal(sources.at, 111_000);
  t.mock.timers.tick(110_000);
  assert.equal(tracker.beforeTool('read'), 'bounded_source_timeout');
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'inspection').yieldDeadline!.at, 201_000);
  t.mock.timers.tick(20_000);
  const supplement = comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline!;
  assert.equal(supplement.at, 151_000, 'the 30-second supplement is clamped to the remaining 20 seconds of shared review');
  for (let i = 0; i < 13; i++) tracker.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 'review', payload: {} });
  assert.equal(tracker.beforeTool('read'), undefined, 'old investigation request allowance must not block the legal supplement');
  t.mock.timers.tick(20_000);
  assert.equal(tracker.beforeTool('read'), 'bounded_source_timeout');
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline, supplement);
  const closure = comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!;
  assert.equal(closure.at, 241_000);
  t.mock.timers.tick(1);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline, closure);
  assert.equal(tracker.beforeTool('update_comparison_findings'), undefined);
  t.mock.timers.tick(89_999);
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout');
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, sources.at);
});

test('late stages preserve finishing time and the final sixty seconds of total budget', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  t.mock.timers.tick(120_000);
  assert.equal(comparisonWorkDeadline(tracker, 'compose').yieldDeadline!.at, 211_000);
  t.mock.timers.tick(90_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, 321_000);
  t.mock.timers.tick(150_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!.at, 361_000);
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout', 'closure cannot borrow the finishing reserve');
  const audit = comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!;
  assert.equal(audit.at, 451_000);
  t.mock.timers.tick(90_000);
  const preview = comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!;
  assert.equal(preview.at, 541_000);
  t.mock.timers.tick(90_000);
  assert.equal(tracker.snapshot().remainingMs, 60_000);
  assert.equal(tracker.beforeTool('preview_report'), 'bounded_preview_timeout');
  tracker.checkHard('persist publication');
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!.at, audit.at, 'returning to audit cannot borrow publication time');
});

test('small total budgets scale all allocations rather than consuming the finishing reserve', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded(60_000);
  assert.equal(comparisonWorkDeadline(tracker, 'investigate', 'findings').yieldDeadline!.at, 13_000);
  t.mock.timers.tick(12_000);
  assert.equal(comparisonWorkDeadline(tracker, 'compose').yieldDeadline!.at, 22_000);
  t.mock.timers.tick(9_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, 33_000);
  t.mock.timers.tick(11_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline!.at, 36_000);
  t.mock.timers.tick(3_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!.at, 37_000);
  t.mock.timers.tick(1_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!.at, 46_000);
  t.mock.timers.tick(9_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!.at, 55_000);
  t.mock.timers.tick(9_000);
  assert.equal(tracker.snapshot().remainingMs, 6_000);
});

test('late stage entry cannot borrow reserved audit or publication time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  t.mock.timers.tick(400_000);
  const review = comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!;
  assert.equal(review.at, 361_000, 'the global boundary is already past; do not grant a fresh 150 seconds');
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout');
  const audit = comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!;
  assert.equal(audit.at, 451_000);
  const preview = comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!;
  assert.equal(preview.at, 491_000);
});

test('a shorter investigation override remains binding and an explicit empty override remains unlimited', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const short = new ComparisonResourceTracker({ maxElapsedMs: 600_000, investigationMs: 5_000 }, { boundedStages: true });
  assert.equal(comparisonWorkDeadline(short, 'investigate', 'findings').yieldDeadline!.at, 6_000);
  const unlimited = new ComparisonResourceTracker({}, { boundedStages: true });
  for (const pass of ['sources', 'review-findings', 'inspection', 'audit', 'preview'] as const) {
    assert.deepEqual(comparisonWorkDeadline(unlimited, 'review', pass), {});
  }
  t.mock.timers.tick(1_000_000);
  assert.equal(unlimited.beforeTool('preview_report'), undefined);
  assert.equal(unlimited.snapshot().remainingMs, null);
  assert.equal(unlimited.snapshot().workDeadlineAt, undefined);
});

test('legacy findings/audit/preview deadlines retain their previous opt-out semantics', () => {
  const legacy = new ComparisonResourceTracker(DEFAULT_COMPARISON_RESOURCES);
  assert.deepEqual(comparisonWorkDeadline(legacy, 'investigate', 'findings'), {});
  assert.deepEqual(comparisonWorkDeadline(legacy, 'review', 'audit'), {});
  assert.deepEqual(comparisonWorkDeadline(legacy, 'review', 'preview'), {});
  assert.equal(legacy.workDeadline(), undefined);
});

test('source-save retains investigation cutoff but gets a non-renewable review save allowance', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  const investigation = comparisonWorkDeadline(tracker, 'investigate').yieldDeadline!;
  t.mock.timers.tick(80_000);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'investigate', 'source-save').yieldDeadline, investigation);
  t.mock.timers.tick(40_000);
  assert.equal(tracker.beforeTool('update_comparison_findings_delta'), 'bounded_investigation_timeout');
  const source = comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!;
  assert.equal(source.at, 231_000);
  t.mock.timers.tick(80_000);
  const save = comparisonWorkDeadline(tracker, 'review', 'source-save').yieldDeadline!;
  assert.equal(save.at, 291_000);
  t.mock.timers.tick(30_000);
  assert.equal(tracker.beforeTool('update_comparison_findings_delta'), undefined);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'source-save').yieldDeadline, save);
  const inspection = comparisonWorkDeadline(tracker, 'review', 'inspection').yieldDeadline!;
  assert.equal(inspection.at, 321_000, 'draft delivery has its own non-renewable cutoff');
  comparisonWorkDeadline(tracker, 'review', 'source-save');
  t.mock.timers.tick(60_000);
  assert.equal(tracker.beforeTool('update_comparison_findings_delta'), 'bounded_source_timeout');
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'inspection').yieldDeadline, inspection);
  assert.equal(tracker.beforeTool('inspect_comparison_draft'), undefined, 'expired save does not expire draft delivery');
  t.mock.timers.tick(30_000);
  assert.equal(tracker.beforeTool('inspect_comparison_draft'), 'bounded_source_timeout');
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline, source);
});

test('bounded review protects finishing requests and tools without blocking findings or overriding hard limits', () => {
  const requests = new ComparisonResourceTracker({ maxElapsedMs: 600_000, maxModelRequests: 5 }, { boundedStages: true });
  assert.equal(requests.sourceRemainingMs(), undefined);
  requests.phase('review', 'review-supplement');
  assert.equal(requests.beforeTool('read'), undefined);
  requests.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 'review', payload: {} });
  assert.equal(requests.reviewReason(), 'reserve_finish');
  assert.equal(requests.beforeTool('read'), 'reserve_finish');
  assert.equal(requests.beforeTool('update_comparison_findings'), undefined);
  for (let i = 0; i < 4; i++) requests.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 'review', payload: {} });
  assert.throws(() => requests.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 'review', payload: {} }), /maxModelRequests/);
  const tools = new ComparisonResourceTracker({ maxElapsedMs: 600_000, maxToolCalls: 7 }, { boundedStages: true });
  tools.phase('review', 'sources');
  assert.equal(tools.beforeTool('read'), undefined);
  tools.observe({ type: 'agent.tool_called', role: 'comparison', sessionId: 'review', payload: { toolCallId: 'one' } });
  assert.equal(tools.beforeTool('read'), 'reserve_finish');
  assert.equal(tools.beforeTool('inspect_comparison_draft'), undefined);
  for (let i = 0; i < 7; i++) tools.observe({ type: 'agent.tool_called', role: 'comparison', sessionId: 'review', payload: { toolCallId: `other-${i}` } });
  assert.throws(() => tools.beforeTool('preview_report'), /maxToolCalls/);
});
