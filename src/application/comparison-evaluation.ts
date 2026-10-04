import { Value } from '@sinclair/typebox/value';
import type { EventEnvelope } from '../core/schema.js';
import { record } from '../core/json.js';
import { ComparisonEvaluationLedgerSchema, ComparisonEvaluationSuiteSchema,
  type ComparisonEvaluationCase, type ComparisonEvaluationLedger, type ComparisonEvaluationSuite } from '../core/comparison-evaluation-schema.js';

export function readComparisonEvaluationSuite(value: unknown): ComparisonEvaluationSuite {
  if (!Value.Check(ComparisonEvaluationSuiteSchema, value)) throw new Error('Invalid Comparison evaluation suite.');
  const ids = new Set(value.cases.map(item => item.id));
  if (ids.size !== value.cases.length) throw new Error('Duplicate evaluation case ID.');
  for (const taskClass of ['code', 'text', 'data', 'visual', 'interaction', 'insufficient']) {
    if (value.cases.filter(item => item.taskClass === taskClass).length < 2) throw new Error(`Insufficient ${taskClass} evaluation coverage.`);
  }
  for (const item of value.cases) {
    const factIds = item.expectations.decisiveFacts.map(fact => fact.id);
    const limits = item.expectations.limitations.map(limit => limit.id);
    if (new Set([...factIds, ...limits]).size !== factIds.length + limits.length) throw new Error('Duplicate expectation ID.');
  }
  return value;
}

export function evaluationVariant(item: ComparisonEvaluationCase, variant: 'original' | 'swapped' | 'blind'): ComparisonEvaluationCase {
  if (variant === 'swapped') return { ...item, baseline: item.candidate, candidate: item.baseline };
  if (variant === 'blind') return { ...item,
    baseline: { ...item.baseline, model: 'anonymous-a' }, candidate: { ...item.candidate, model: 'anonymous-b' } };
  return item;
}

export { comparisonMainTextCharacters } from './comparison-report-text.js';

export function comparisonEvaluationUsageCoverage(events: readonly EventEnvelope[]): 'complete' | 'partial' | 'missing' {
  const requests = events.filter(event => event.type === 'agent.model_request');
  const usage = events.filter(event => event.type === 'agent.usage_reported');
  if (!usage.length) return 'missing';
  const key = (event: EventEnvelope) => {
    const payload = record(event.payload);
    return JSON.stringify([payload.sessionId, payload.invocationId, payload.requestIndex, payload.scope ?? 'generation']);
  };
  const pending = new Set<string>();
  let invalid = false;
  for (const event of events) {
    if (event.type !== 'agent.model_request' && event.type !== 'agent.usage_reported') continue;
    const id = key(event);
    if (event.type === 'agent.model_request') {
      if (pending.has(id)) invalid = true;
      pending.add(id);
    } else if (!pending.delete(id)) invalid = true;
  }
  return requests.length > 0 && !invalid && pending.size === 0 ? 'complete' : 'partial';
}

export function assessComparisonEvaluation(value: unknown, suite: ComparisonEvaluationSuite) {
  if (!Value.Check(ComparisonEvaluationLedgerSchema, value)) throw new Error('Invalid Comparison evaluation ledger.');
  const ledger: ComparisonEvaluationLedger = value;
  const cases = new Map(suite.cases.map(item => [item.id, item]));
  const reviewed = ledger.rows.filter(row => row.review !== undefined);
  const keys = new Set<string>();
  for (const row of ledger.rows) {
    const key = `${row.caseId}/${row.repetition}/${row.variant}`;
    if (keys.has(key)) throw new Error('Duplicate evaluation observation.');
    keys.add(key);
    const item = cases.get(row.caseId);
    if (!item) throw new Error('Unknown evaluation case.');
    if (!row.review) continue;
    if (row.status !== 'completed' || !row.reportHash || row.review.reviewedReportHash !== row.reportHash) throw new Error('Review is not bound to a completed report hash.');
    const facts = new Set(item.expectations.decisiveFacts.map(fact => fact.id));
    const limits = new Set(item.expectations.limitations.map(limit => limit.id));
    if (new Set(row.review.supportedFactIds).size !== row.review.supportedFactIds.length ||
      new Set(row.review.disclosedLimitationIds).size !== row.review.disclosedLimitationIds.length ||
      row.review.supportedFactIds.some(id => !facts.has(id)) || row.review.disclosedLimitationIds.some(id => !limits.has(id))) throw new Error('Unknown or duplicate adjudicated expectation.');
  }
  const distributions = (numbers: number[]) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    if (!sorted.length) return { count: 0 };
    return { count: sorted.length, min: sorted[0], median: sorted[Math.floor((sorted.length - 1) / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
  };
  const instability = suite.cases.flatMap(item => {
    const rows = reviewed.filter(row => row.caseId === item.id);
    if (rows.length < 2) return [];
    const signatures = new Set(rows.map(row => JSON.stringify({ facts: [...row.review!.supportedFactIds].sort(), limits: [...row.review!.disclosedLimitationIds].sort() })));
    const preferences = new Set(rows.map(row => row.review!.canonicalPreference));
    return [{ caseId: item.id, reviewed: rows.length, factOrLimitationDrift: signatures.size > 1,
      preferenceVaries: preferences.size > 1, requiresManualStabilityReview: signatures.size > 1 || preferences.size > 1 }];
  });
  return { schemaVersion: 1, acceptance: reviewed.length === ledger.rows.length && reviewed.length > 0 ? 'manual_review_recorded' : 'incomplete',
    generated: ledger.rows.length, completed: ledger.rows.filter(row => row.status === 'completed').length, reviewed: reviewed.length,
    unsupportedClaims: reviewed.reduce((sum, row) => sum + row.review!.unsupportedClaims, 0),
    factualErrors: reviewed.reduce((sum, row) => sum + row.review!.factualErrors, 0),
    processMisattributions: reviewed.reduce((sum, row) => sum + row.review!.processMisattributions, 0),
    decisiveFactsOmitted: reviewed.reduce((sum, row) => sum + cases.get(row.caseId)!.expectations.decisiveFacts.length - row.review!.supportedFactIds.length, 0),
    limitationsOmitted: reviewed.reduce((sum, row) => sum + cases.get(row.caseId)!.expectations.limitations.length - row.review!.disclosedLimitationIds.length, 0),
    understandableWithin30Seconds: reviewed.filter(row => row.review!.readabilityAssessment === 'human_reader_test' && row.review!.understandableWithin30Seconds).length,
    humanReaderTests: reviewed.filter(row => row.review!.readabilityAssessment === 'human_reader_test').length,
    agentReadabilityEstimates: reviewed.filter(row => row.review!.readabilityAssessment === 'agent_estimate').length,
    counterevidenceHandled: reviewed.filter(row => row.review!.counterevidenceHandled).length,
    elapsedMs: distributions(ledger.rows.map(row => row.elapsedMs)), modelRequests: distributions(ledger.rows.map(row => row.modelRequests)),
    toolCalls: distributions(ledger.rows.map(row => row.toolCalls)), estimatedCostUsd: distributions(ledger.rows.flatMap(row => row.estimatedCostUsd === undefined ? [] : [row.estimatedCostUsd])),
    mainTextCharacters: distributions(ledger.rows.flatMap(row => row.mainTextCharacters === undefined ? [] : [row.mainTextCharacters])),
    unknownCostRows: ledger.rows.filter(row => row.estimatedCostUsd === undefined).length, stability: instability,
    note: 'Manual observations, not deterministic proof of semantic quality. Preference variations require condition review, not automatic winner equality.' };
}
