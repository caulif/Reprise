import type { ComparisonDraftSubmission, ComparisonFindingsSubmission, ComparisonSupportBoundary } from '../core/schema.js';
import type { AgentLocale } from '../agents/language.js';

function paragraph(text: string | undefined): string {
  return text?.trim() ? `<p>${text.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}</p>` : '';
}

function incomplete(boundary: ComparisonSupportBoundary | undefined): boolean {
  return !boundary || boundary.supportStage !== 'delivered_output' || boundary.uncheckedInstances.length > 0;
}

export function decisionContractError(draft: ComparisonDraftSubmission, findings?: ComparisonFindingsSubmission): string | undefined {
  if (draft.decisionBasis === undefined && draft.conclusionScope === undefined && draft.findingDispositions === undefined) return undefined;
  const basis = draft.decisionBasis ?? [];
  const dispositions = draft.findingDispositions ?? [];
  const ids = new Set(findings?.findings.map(finding => finding.id) ?? []);
  const listed = dispositions.map(item => item.findingId);
  if (findings && (new Set(listed).size !== listed.length || listed.length !== ids.size || listed.some(id => !ids.has(id)))) {
    return 'code=decision_findings_invalid\nmessage=Cover every current finding exactly once with its existing ID; do not omit task-critical branches.';
  }
  const selected = dispositions.filter(item => item.disposition === 'basis').map(item => item.findingId);
  if (new Set(basis).size !== basis.length || basis.length !== selected.length || basis.some(id => !selected.includes(id))
    || (findings && basis.some(id => !ids.has(id)))) {
    return 'code=decision_basis_invalid\nmessage=decisionBasis must exactly match the basis finding dispositions.';
  }
  if (findings && draft.status === 'completed' && !basis.length) {
    return 'code=decision_basis_missing\nmessage=A completed decision requires at least one current basis finding; use insufficient_evidence when no basis is available.';
  }
  if (draft.status === 'insufficient_evidence' && draft.conclusionScope !== 'undetermined') {
    return 'code=decision_scope_invalid\nmessage=insufficient_evidence requires conclusionScope=undetermined.';
  }
  const relevant = new Set(dispositions.filter(item => item.disposition !== 'not_decisive').map(item => item.findingId));
  if (draft.conclusionScope === 'supported_in_scope' && findings?.findings.some(finding => relevant.has(finding.id)
    && finding.observations.some(observation => incomplete(observation.supportBoundary)))) {
    return 'code=decision_scope_incomplete\nmessage=Selected basis and boundary findings include incomplete or unavailable output support. Use conditional or undetermined and preserve this boundary in the visible decision.';
  }
  return undefined;
}

export function decisionTextHtml(draft: ComparisonDraftSubmission, findings?: ComparisonFindingsSubmission, locale: AgentLocale = 'zh'): string {
  const relevant = new Set(draft.findingDispositions?.filter(item => item.disposition !== 'not_decisive').map(item => item.findingId));
  const boundaries = draft.decisionSummary === undefined ? [] : (findings?.findings ?? []).flatMap(finding => relevant.has(finding.id)
    ? finding.observations.filter(observation => incomplete(observation.supportBoundary)).map(observation => {
      const support = observation.supportBoundary;
      const side = locale === 'en' ? (observation.side === 'baseline' ? 'Historical run' : 'Current run') : (observation.side === 'baseline' ? '历史运行' : '当前运行');
      const relationship = support?.relationship ?? finding.criterion;
      const unchecked = support?.uncheckedInstances.length ? support.uncheckedInstances.join('、') : undefined;
      const partial = support?.supportStage === 'delivered_output';
      if (locale === 'en') return `${side}: ${relationship} ${partial ? 'has limited output coverage' : 'remains unverified in the delivered output'}${unchecked ? `; unchecked instances: ${unchecked}` : ''}.`;
      return `${side}：${relationship}${partial ? '的结果覆盖有限' : '的交付结果仍未确认'}${unchecked ? `；未检查：${unchecked}` : ''}。`;
    }) : []);
  return `${paragraph(draft.decisionSummary)}${paragraph(draft.decisionBoundary)}${boundaries.map(paragraph).join('')}${draft.comparisonHtml}`;
}
