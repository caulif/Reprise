import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker, DEFAULT_COMPARISON_RESOURCES } from '../../src/agents/comparison-resources.js';
import { comparisonOutputContinuation, comparisonWorkDeadline } from '../../src/agents/comparison-invocation-boundaries.js';

function bounded(maxElapsedMs = 600_000) {
  return new ComparisonResourceTracker({ ...DEFAULT_COMPARISON_RESOURCES, maxElapsedMs }, { boundedStages: true });
}

test('slow investigation/save no longer compresses author work to nine seconds', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  t.mock.timers.tick(111_000);
  tracker.phase('investigate', 'source-save');
  t.mock.timers.tick(90_000);
  tracker.phase('compose');
  assert.equal(tracker.workDeadline()!.at - Date.now(), 90_000);
  assert.equal(tracker.snapshot().remainingMs, 399_000);
  assert.equal(tracker.beforeTool('submit_comparison_draft'), undefined);
});

test('larger budgets expand actual stage windows and saving protects a complete author window', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  assert.equal(DEFAULT_COMPARISON_RESOURCES.maxElapsedMs, 1_200_000);
  for (const total of [60_000, 1_200_000, 2_400_000]) {
    const tracker = bounded(total), scale = total / 1_200_000;
    assert.equal(tracker.investigationRemainingMs(), Math.min(240_000 * scale, 240_000));
    t.mock.timers.tick(530_000 * scale);
    tracker.phase('investigate', 'source-save');
    const save = tracker.workDeadline()!;
    assert.equal(save.at - Date.now(), 10_000 * scale);
    t.mock.timers.tick(save.at - Date.now());
    tracker.phase('compose');
    assert.equal(tracker.workDeadline()!.at - Date.now(), 180_000 * scale);
    tracker.phase('review', 'sources');
    assert.equal(tracker.workDeadline()!.at - Date.now(), 240_000 * scale);
  }
});

test('latest legal entries retain time for every mandatory downstream stage', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  for (const total of [60_000, 1_200_000]) {
    const tracker = bounded(total), scale = total / 1_200_000;
    t.mock.timers.tick(530_000 * scale);
    for (const [phase, pass, minimum] of [
      ['investigate', 'source-save', 10_000], ['compose', undefined, 180_000], ['review', 'sources', 120_000],
      ['review', 'source-save', 60_000], ['review', 'inspection', 30_000], ['review', 'review-findings', 60_000],
      ['review', 'audit', 120_000], ['review', 'preview', 60_000],
    ] as const) {
      tracker.phase(phase, pass);
      const remaining = tracker.workDeadline()!.at - Date.now();
      assert.equal(remaining, minimum * scale, `${phase}/${pass} must not share its predecessor's deadline`);
      t.mock.timers.tick(remaining);
    }
    assert.equal(tracker.snapshot().remainingMs, 30_000 * scale);
  }
});

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
  assert.equal(sources.at, 121_000);
  t.mock.timers.tick(120_000);
  assert.equal(tracker.beforeTool('read'), 'bounded_source_timeout');
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'inspection').yieldDeadline!.at, 181_000);
  t.mock.timers.tick(20_000);
  const supplement = comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline!;
  assert.equal(supplement.at, 151_000, 'the supplement is clamped to the remaining shared source allowance');
  for (let i = 0; i < 13; i++) tracker.observe({ type: 'agent.model_request', role: 'comparison', sessionId: 'review', payload: {} });
  assert.equal(tracker.beforeTool('read'), undefined, 'old investigation request allowance must not block the legal supplement');
  t.mock.timers.tick(10_000);
  assert.equal(tracker.beforeTool('read'), 'bounded_source_timeout');
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline, supplement);
  const closure = comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!;
  assert.equal(closure.at, 211_000);
  t.mock.timers.tick(1);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline, closure);
  assert.equal(tracker.beforeTool('update_comparison_findings'), undefined);
  t.mock.timers.tick(59_999);
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout');
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, sources.at);
});

test('late stages borrow unused time while preserving audit and publication reserves', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  t.mock.timers.tick(120_000);
  assert.equal(comparisonWorkDeadline(tracker, 'compose').yieldDeadline!.at, 211_000);
  t.mock.timers.tick(90_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, 331_000);
  t.mock.timers.tick(270_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!.at, 496_000);
  t.mock.timers.tick(15_000);
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout', 'closure cannot borrow the finishing reserve');
  const audit = comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!;
  assert.equal(audit.at, 556_000);
  t.mock.timers.tick(60_000);
  const preview = comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!;
  assert.equal(preview.at, 586_000);
  t.mock.timers.tick(30_000);
  assert.equal(tracker.snapshot().remainingMs, 15_000);
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
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!.at, 34_000);
  t.mock.timers.tick(12_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-supplement').yieldDeadline!.at, 37_000);
  t.mock.timers.tick(3_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!.at, 43_000);
  t.mock.timers.tick(6_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!.at, 52_000);
  t.mock.timers.tick(9_000);
  assert.equal(comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!.at, 58_000);
  t.mock.timers.tick(6_000);
  assert.equal(tracker.snapshot().remainingMs, 3_000);
});

test('late stage entry cannot borrow reserved audit or publication time', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  t.mock.timers.tick(530_000);
  const review = comparisonWorkDeadline(tracker, 'review', 'review-findings').yieldDeadline!;
  assert.equal(review.at, 496_000, 'the global boundary is already past');
  assert.equal(tracker.beforeTool('update_comparison_findings'), 'bounded_source_timeout');
  const audit = comparisonWorkDeadline(tracker, 'review', 'audit').yieldDeadline!;
  assert.equal(audit.at, 556_000);
  const preview = comparisonWorkDeadline(tracker, 'review', 'preview').yieldDeadline!;
  assert.equal(preview.at, 586_000);
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

test('source-save has non-renewable persistence windows while source investigation retains its cutoff', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const tracker = bounded();
  const investigation = comparisonWorkDeadline(tracker, 'investigate').yieldDeadline!;
  t.mock.timers.tick(80_000);
  const initialSave = comparisonWorkDeadline(tracker, 'investigate', 'source-save').yieldDeadline!;
  assert.equal(initialSave.at, 141_000);
  t.mock.timers.tick(40_000);
  assert.equal(tracker.beforeTool('update_comparison_findings_delta'), undefined);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'investigate').yieldDeadline, investigation);
  assert.equal(tracker.beforeTool('read'), 'bounded_investigation_timeout');
  const source = comparisonWorkDeadline(tracker, 'review', 'sources').yieldDeadline!;
  assert.equal(source.at, 241_000);
  t.mock.timers.tick(80_000);
  const save = comparisonWorkDeadline(tracker, 'review', 'source-save').yieldDeadline!;
  assert.equal(save.at, 261_000);
  t.mock.timers.tick(30_000);
  assert.equal(tracker.beforeTool('update_comparison_findings_delta'), undefined);
  assert.deepEqual(comparisonWorkDeadline(tracker, 'review', 'source-save').yieldDeadline, save);
  const inspection = comparisonWorkDeadline(tracker, 'review', 'inspection').yieldDeadline!;
  assert.equal(inspection.at, 291_000, 'draft delivery has its own non-renewable cutoff');
  comparisonWorkDeadline(tracker, 'review', 'source-save');
  t.mock.timers.tick(30_000);
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
