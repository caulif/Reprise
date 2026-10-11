import type { ComparisonDecisionDraftSubmission, ComparisonDraftSubmission } from '../core/schema.js';

export function materializeComparisonDecisionDraft(submission: ComparisonDecisionDraftSubmission): ComparisonDraftSubmission {
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const media = submission.media?.map(image => `<figure class="cell" data-component="media-single"><img data-media-ref="${escape(image.ref)}" alt="${escape(image.caption)}"><figcaption>${escape(image.caption)}</figcaption></figure>`).join('') ?? '';
  return { status: submission.status, category: submission.category, headline: submission.headline,
    decisionShape: submission.decisionShape, decisionSummary: submission.decisionSummary,
    decisionBoundary: submission.decisionBoundary, conclusionScope: submission.conclusionScope,
    findingDispositions: submission.findingDispositions, scopeSummaries: submission.scopeSummaries, comparisonHtml: media ? `<div data-component="page-row">${media}</div>` : '<p></p>',
    decisionBasis: submission.findingDispositions.filter(item => item.disposition === 'basis').map(item => item.findingId) };
}
