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
  const unavailable = findings?.decisionQuestions.filter(question => question.status === 'unavailable') ?? [];
  if (unavailable.length && (draft.conclusionScope === 'supported_in_scope' || !draft.decisionBoundary?.trim())) {
    return `code=decision_questions_unavailable\nquestions=${JSON.stringify(unavailable.map(({ id, question, decisionImpact, resolution }) => ({ id, question, decisionImpact, resolution })))}\nmessage=Decision-changing questions remain unavailable. Use conditional or undetermined and a nonempty visible decisionBoundary explaining their effect on this choice. A deadline closes investigation, not the task relationship; saved question text and resolutions are repair hypotheses, not certified facts.`;
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
  const boundaries = draft.decisionSummary === undefined ? [] : (findings?.findings ?? []).flatMap(finding => {
    if (!relevant.has(finding.id)) return [];
    const observations = finding.observations.filter(observation => incomplete(observation.supportBoundary));
    const groups = [true, false].flatMap(partial => {
      const sides = observations.filter(observation => (observation.supportBoundary?.supportStage === 'delivered_output') === partial)
        .map(observation => sideName(observation.side, locale));
      if (!sides.length) return [];
      return locale === 'en' ? [`${sides.join(' and ')}: ${partial ? 'limited delivered-output coverage' : 'delivered-output support unverified'}`]
        : [`${sides.join('、')}${partial ? '仅有局部交付支持' : '交付结果未确认'}`];
    });
    return groups.length ? [locale === 'en' ? `${finding.criterion}: ${groups.join('; ')}.` : `${finding.criterion}：${groups.join('；')}。`] : [];
  });
  return `${paragraph(draft.decisionSummary)}${paragraph(draft.decisionBoundary)}${boundaries.map(paragraph).join('')}${draft.comparisonHtml}`;
}

function sideName(side: 'baseline' | 'candidate', locale: AgentLocale): string {
  return locale === 'en' ? (side === 'baseline' ? 'Historical run' : 'Current run') : (side === 'baseline' ? '历史运行' : '当前运行');
}

export function decisionSupportDetailsHtml(draft: ComparisonDraftSubmission, findings?: ComparisonFindingsSubmission, locale: AgentLocale = 'zh'): string {
  if (draft.decisionSummary === undefined) return '';
  const relevant = new Set(draft.findingDispositions?.filter(item => item.disposition !== 'not_decisive').map(item => item.findingId));
  return (findings?.findings ?? []).flatMap(finding => relevant.has(finding.id)
    ? finding.observations.filter(observation => incomplete(observation.supportBoundary)).map(observation => {
      const support = observation.supportBoundary;
      const identity = `${finding.criterion} · ${sideName(observation.side, locale)}`;
      if (!support) return paragraph(locale === 'en' ? `${identity}: delivered output has not been verified.` : `${identity}：交付结果未确认。`);
      const instances = (values: string[]) => values.length ? values.join(locale === 'en' ? ', ' : '、') : (locale === 'en' ? 'none recorded' : '未记录');
      return paragraph(locale === 'en'
        ? `${identity}: ${support.relationship}; scope: ${support.domain}; checked: ${instances(support.coveredInstances)}; unchecked: ${instances(support.uncheckedInstances)}.`
        : `${identity}：${support.relationship}；范围：${support.domain}；已检查：${instances(support.coveredInstances)}；未检查：${instances(support.uncheckedInstances)}。`);
    }) : []).join('');
}
