import type { ComparisonFindingsDelta, ComparisonFindingsSubmission } from '../core/schema.js';

export function materializeFindingsDelta(saved: ComparisonFindingsSubmission, delta: ComparisonFindingsDelta): ComparisonFindingsSubmission | undefined {
  const exactDecisions = (ids: readonly string[], decisions: readonly { id: string; action: string; replacement?: { id: string } }[]) =>
    decisions.length === ids.length && new Set(decisions.map(item => item.id)).size === ids.length
    && decisions.every(item => ids.includes(item.id) && (item.action === 'retain' || item.replacement?.id === item.id));
  if (!exactDecisions(saved.findings.map(item => item.id), delta.findingDecisions)
    || !exactDecisions(saved.decisionQuestions.map(item => item.id), delta.questionDecisions)) return undefined;
  const validAdditions = (existing: readonly { id: string }[], additions: readonly { id: string }[]) =>
    new Set(additions.map(item => item.id)).size === additions.length
    && additions.every(item => !existing.some(previous => previous.id === item.id));
  if (!validAdditions(saved.findings, delta.addedFindings ?? [])
    || !validAdditions(saved.decisionQuestions, delta.addedQuestions ?? [])) return undefined;
  const materialized = structuredClone(saved);
  for (const item of delta.findingDecisions) if (item.action === 'replace') {
    materialized.findings[materialized.findings.findIndex(finding => finding.id === item.id)] = structuredClone(item.replacement);
  }
  for (const item of delta.questionDecisions) if (item.action === 'replace') {
    materialized.decisionQuestions[materialized.decisionQuestions.findIndex(question => question.id === item.id)] = structuredClone(item.replacement);
  }
  materialized.findings.push(...structuredClone(delta.addedFindings ?? []));
  materialized.decisionQuestions.push(...structuredClone(delta.addedQuestions ?? []));
  if (delta.criteria !== undefined) materialized.criteria = structuredClone(delta.criteria);
  if (delta.finals !== undefined) materialized.finals = structuredClone(delta.finals);
  if (delta.importantLimitations !== undefined) materialized.importantLimitations = structuredClone(delta.importantLimitations);
  return materialized;
}
