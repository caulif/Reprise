import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessComparisonEvaluation, evaluationVariant, readComparisonEvaluationSuite, comparisonMainTextCharacters, comparisonEvaluationUsageCoverage } from '../../src/application/comparison-evaluation.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import type { ComparisonEvaluationLedger } from '../../src/core/comparison-evaluation-schema.js';
import { prepareComparisonEvaluationFixture } from '../../scripts/comparison-evaluation-fixtures.js';

async function suite() {
  return readComparisonEvaluationSuite(JSON.parse(await readFile(new URL('../fixtures/comparison-evaluation/suite.json', import.meta.url), 'utf8')) as unknown);
}

test('suite freezes six task classes with missing final, self-check, conflicts and environmental limits', async () => {
  const frozen = await suite();
  assert.equal(frozen.cases.length, 12);
  assert.equal(new Set(frozen.cases.map(item => item.taskClass)).size, 6);
  assert.equal(frozen.cases.find(item => item.id === 'insufficient-missing')?.baseline.content, undefined);
  assert.ok(frozen.cases.find(item => item.id === 'code-self-check'));
  assert.ok(frozen.cases.find(item => item.id === 'insufficient-environment'));
  assert.throws(() => readComparisonEvaluationSuite({ ...frozen, cases: [...frozen.cases.slice(1), frozen.cases[1]] }), /Duplicate/);
  assert.throws(() => readComparisonEvaluationSuite({ ...frozen, cases: frozen.cases.map(item => ({ ...item, taskClass: 'text' })) }), /coverage/);
  assert.throws(() => readComparisonEvaluationSuite(null), /Invalid/);
  const first = frozen.cases[0]!;
  assert.throws(() => readComparisonEvaluationSuite({ ...frozen, cases: [{ ...first, expectations: { ...first.expectations,
    decisiveFacts: [first.expectations.decisiveFacts[0], first.expectations.decisiveFacts[0]] } }, ...frozen.cases.slice(1)] }), /Duplicate/);
});

test('order and identity perturbation preserve frozen content, expectations and canonical sides', async () => {
  const item = (await suite()).cases[0]!;
  assert.equal(evaluationVariant(item, 'original'), item);
  const swapped = evaluationVariant(item, 'swapped');
  assert.equal(swapped.baseline, item.candidate);
  assert.equal(swapped.candidate, item.baseline);
  const blind = evaluationVariant(item, 'blind');
  assert.equal(blind.baseline.model, 'anonymous-a');
  assert.equal(blind.candidate.model, 'anonymous-b');
  assert.equal(blind.baseline.content, item.baseline.content);
  assert.equal(blind.expectations, item.expectations);
  assert.notEqual(item.baseline.model, blind.baseline.model);
});

test('main text measurement decodes entities and excludes folded methods and inert templates', () => {
  assert.equal(comparisonMainTextCharacters('<p data-agent-slot="headline">A &amp; B</p><section data-agent-zone="comparison">正文<template>隐藏稿</template></section><section data-agent-zone="details">很长的方法</section>'), 8);
  assert.equal(comparisonMainTextCharacters(''), 0);
  const folded = '<p data-agent-slot="headline">A</p><section data-agent-zone="comparison">B<details><summary>M</summary>long methods</details></section>';
  assert.equal(comparisonMainTextCharacters(folded), 5);
  assert.equal(comparisonMainTextCharacters(folded.replace('<details>', '<details open>')), 18);
});

test('usage coverage pairs exact request identity and scope, including compaction and missing/duplicate calls', () => {
  const event = (type: string, index: number, scope?: string): EventEnvelope => ({ schemaVersion: 1, eventId: 'event',
    sequence: 1, occurredAt: '2026-10-04T00:00:00.000Z', type, checksum: 'a'.repeat(64),
    payload: { sessionId: 'session', invocationId: 'invocation', requestIndex: index, ...(scope ? { scope } : {}) } });
  const req = event('agent.model_request', 1);
  const usage = event('agent.usage_reported', 1, 'generation');
  assert.equal(comparisonEvaluationUsageCoverage([req]), 'missing');
  assert.equal(comparisonEvaluationUsageCoverage([usage]), 'partial');
  assert.equal(comparisonEvaluationUsageCoverage([req, usage]), 'complete');
  assert.equal(comparisonEvaluationUsageCoverage([req, usage, req, usage]), 'complete');
  assert.equal(comparisonEvaluationUsageCoverage([req, usage, event('agent.model_request', 2, 'compaction'), event('agent.usage_reported', 2, 'compaction')]), 'complete');
  assert.equal(comparisonEvaluationUsageCoverage([req, usage, event('agent.model_request', 2, 'compaction')]), 'partial');
  assert.equal(comparisonEvaluationUsageCoverage([req, usage, usage]), 'partial');
  assert.equal(comparisonEvaluationUsageCoverage([req, req, usage]), 'partial');
  assert.equal(comparisonEvaluationUsageCoverage([req, event('agent.usage_reported', 1, 'compaction')]), 'partial');
});

test('assessment requires report-bound manual annotations, keeps unknown costs, flags factual drift without forcing a winner', async () => {
  const frozen = await suite();
  const item = frozen.cases[0]!;
  const hash = 'a'.repeat(64);
  const row: ComparisonEvaluationLedger['rows'][number] = { caseId: item.id, repetition: 1, variant: 'original', status: 'completed',
    eventsPath: '/events.jsonl', reportPath: '/report.html', reportHash: hash, elapsedMs: 123,
    modelRequests: 3, toolCalls: 5, compactions: 0, pricingLookup: 'miss' };
  const ledger: ComparisonEvaluationLedger = { schemaVersion: 1, suiteHash: hash, model: 'fixture-evaluator', rows: [row] };
  const pending = assessComparisonEvaluation(ledger, frozen);
  assert.equal(pending.acceptance, 'incomplete');
  assert.equal(pending.reviewed, 0);
  assert.equal(pending.unknownCostRows, 1);
  assert.equal(pending.estimatedCostUsd.count, 0);
  assert.throws(() => assessComparisonEvaluation(null, frozen), /Invalid/);
  const review = { reviewer: 'human-1', reviewedReportHash: hash, supportedFactIds: ['empty-handled'], disclosedLimitationIds: ['history-logs'],
    unsupportedClaims: 0, factualErrors: 0, processMisattributions: 0, counterevidenceHandled: true,
    understandableWithin30Seconds: true, readingSeconds: 20, canonicalPreference: 'conditional' as const,
    preferenceReason: 'Quality matters with a wait-time tradeoff.', notes: '' };
  row.review = review;
  ledger.rows.push({ ...row, variant: 'swapped', estimatedCostUsd: 0.01, pricingLookup: 'hit',
    review: { ...review, supportedFactIds: [], canonicalPreference: 'candidate', preferenceReason: 'Different condition; requires review.' } });
  const assessed = assessComparisonEvaluation(ledger, frozen);
  assert.equal(assessed.acceptance, 'manual_review_recorded');
  assert.equal(assessed.decisiveFactsOmitted, 1);
  assert.equal(assessed.stability[0]?.factOrLimitationDrift, true);
  assert.equal(assessed.stability[0]?.preferenceVaries, true);
  assert.equal(assessed.unknownCostRows, 1);
  assert.equal(assessed.humanReaderTests, 0);
  assert.equal(assessed.understandableWithin30Seconds, 0);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [row, row] }, frozen), /Duplicate/);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [{ ...row, caseId: 'unknown' }] }, frozen), /Unknown evaluation/);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [{ ...row, review: { ...review, reviewedReportHash: 'b'.repeat(64) } }] }, frozen), /bound/);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [{ ...row, status: 'failed' }] }, frozen), /bound/);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [{ ...row, review: { ...review, supportedFactIds: ['invented'] } }] }, frozen), /Unknown or duplicate/);
  assert.throws(() => assessComparisonEvaluation({ ...ledger, rows: [{ ...row, review: { ...review, supportedFactIds: ['empty-handled', 'empty-handled'] } }] }, frozen), /Unknown or duplicate/);
  assert.equal(assessComparisonEvaluation({ ...ledger, rows: [] }, frozen).elapsedMs.count, 0);
});

test('offline preparation materializes immutable final artifacts and records without any generated Comparison report', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-comparison-eval-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const item = (await suite()).cases[0]!;
  const prepared = await prepareComparisonEvaluationFixture(root, item);
  const experimentRoot = join(prepared.dataDir, 'experiments', prepared.experimentId);
  const events = await readFile(join(experimentRoot, 'events.jsonl'), 'utf8');
  assert.ok(!events.includes('agent.model_request'));
  assert.ok(!events.includes('comparison.started'));
  await assert.rejects(stat(join(experimentRoot, 'report.html')), { code: 'ENOENT' });
  assert.equal(await readFile(join(prepared.dataDir, 'cases', `case-${item.id}`, 'baseline-artifacts/files/fixture-bundle/average.js'), 'utf8'), item.baseline.content);
  const frozenCase = JSON.parse(await readFile(join(prepared.dataDir, 'cases', `case-${item.id}`, 'case.json'), 'utf8')) as { transcript: Array<{ id: string; text: string }> };
  assert.ok(frozenCase.transcript.find(message => message.id === 'historical-artifact')?.text.includes(item.baseline.content!));
  const manifest = JSON.parse(await readFile(join(prepared.dataDir, 'cases', `case-${item.id}`, 'baseline-artifacts/manifest.json'), 'utf8')) as { artifacts: Array<{ sourceRefs: string[] }> };
  assert.deepEqual(manifest.artifacts[0]?.sourceRefs, ['message:historical-artifact']);
});
