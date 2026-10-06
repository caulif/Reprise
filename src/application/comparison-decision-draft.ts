import type { ComparisonDecisionDraftSubmission, ComparisonDraftSubmission } from '../core/schema.js';

export function materializeComparisonDecisionDraft(submission: ComparisonDecisionDraftSubmission): ComparisonDraftSubmission {
  return { status: submission.status, category: submission.category, headline: submission.headline,
    decisionShape: submission.decisionShape, decisionSummary: submission.decisionSummary,
    decisionBoundary: submission.decisionBoundary, conclusionScope: submission.conclusionScope,
    findingDispositions: submission.findingDispositions, comparisonHtml: '<p></p>',
    decisionBasis: submission.findingDispositions.filter(item => item.disposition === 'basis').map(item => item.findingId) };
}
