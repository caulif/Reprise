import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import type { ComparisonPairedDifference } from '../core/comparison-schema.js';
import { extractInner } from '../core/comparison-html.js';
import { Value } from '@sinclair/typebox/value';
import { ComparisonPairedDifferenceSchema } from '../core/comparison-schema.js';

type Node = DefaultTreeAdapterMap['node'];
const text = (node: Node): string => node.nodeName === '#text' && 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
export const pairedEscape = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function pairedContentFromHtml(html: string): { reason: string; pairedDifferences: ComparisonPairedDifference[]; comparison: string } {
  const pairedDifferences: ComparisonPairedDifference[] = [];
  const visit = (node: Node): void => {
    if ('attrs' in node && node.attrs.some(attr => attr.name === 'data-paired-difference')) {
      const fieldNode = (name: string) => {
        const find = (child: Node): Node | undefined => 'attrs' in child && child.attrs.some(attr => attr.name === 'data-result-field' && attr.value === name) ? child : 'childNodes' in child ? child.childNodes.map(find).find(Boolean) : undefined;
        return find(node);
      };
      const field = (name: string) => { const hit = fieldNode(name); return hit ? text(hit) : ''; };
      const assessments = Object.fromEntries(['baseline', 'candidate'].flatMap(name => {
        const hit = fieldNode(name);
        const value = hit && 'attrs' in hit ? hit.attrs.find(attr => attr.name === 'data-result-assessment')?.value : undefined;
        return value === undefined ? [] : [[`${name}Assessment`, value]];
      }));
      const refs: string[] = [];
      const citations = (child: Node): void => { if ('attrs' in child) refs.push(...child.attrs.filter(attr => attr.name === 'data-evidence-ref').map(attr => attr.value)); if ('childNodes' in child) child.childNodes.forEach(citations); };
      citations(node);
      pairedDifferences.push({ dimension: field('dimension'), baseline: field('baseline'), candidate: field('candidate'), impact: field('impact'), ...assessments, ...(refs.length ? { evidenceRefs: refs } : {}) });
      return;
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html));
  return { reason: text(parseFragment(extractInner(html, 'data-agent-slot', 'reason'))), pairedDifferences, comparison: extractInner(html, 'data-report-field', 'media') };
}

function result(side: 'baseline' | 'candidate', value: string, assessment: ComparisonPairedDifference['baselineAssessment'], zh: boolean): string {
  const labels: Record<string, [string, string]> = { better: ['更好', 'Better'], worse: ['更差', 'Worse'], similar: ['相近', 'Similar'], unknown: ['未知', 'Unknown'], unverified: ['未验证', 'Unverified'] };
  const label = assessment ? labels[assessment]?.[zh ? 0 : 1] : undefined;
  const tone = assessment === 'better' ? 'better' : assessment === 'worse' ? 'worse' : 'neutral';
  return `<p><span class="side">${zh ? side === 'baseline' ? '历史' : '当前' : side === 'baseline' ? 'History' : 'Current'}</span><span class="result-phrase assessment-${tone}">${label ? `<span class="assessment-label">${label} · </span>` : ''}<strong data-result-field="${side}"${assessment === undefined ? '' : ` data-result-assessment="${pairedEscape(assessment)}"`}>${pairedEscape(value)}</strong></span></p>`;
}

export function renderPairedContent(differences: readonly ComparisonPairedDifference[], media: string, zh: boolean): string {
  return `${differences.map((d, i) => `<section class="difference" data-paired-difference><h2><span class="ordinal">${String(i + 1).padStart(2, '0')}</span><span data-result-field="dimension">${pairedEscape(d.dimension)}</span></h2><div class="outcomes">${result('baseline', d.baseline, d.baselineAssessment, zh)}${result('candidate', d.candidate, d.candidateAssessment, zh)}</div><p class="impact"><span>${zh ? '对你的影响' : 'User impact'} · </span><span data-result-field="impact">${pairedEscape(d.impact)}</span>${(d.evidenceRefs ?? []).map(ref => `<span data-evidence-ref="${pairedEscape(ref)}"></span>`).join('')}</p></section>`).join('')}<div class="media" data-report-field="media">${media}</div>`;
}

export function pairedContentError(html: string): string | undefined {
  const content = pairedContentFromHtml(html);
  const headline = text(parseFragment(extractInner(html, 'data-agent-slot', 'headline')));
  if (!['推荐当前', '推荐历史', '暂不能推荐', 'Recommend Current', 'Recommend History', 'Cannot recommend yet'].includes(headline)) return 'Use only the short recommendation title; put the reason and prerequisites in their own fields.';
  if (!content.reason.trim() || content.pairedDifferences.length > 3 || content.pairedDifferences.some(d => !Value.Check(ComparisonPairedDifferenceSchema, d))) return 'Supply a reason and at most three complete paired differences.';
  const mediaError = (node: Node, caption = false, labelled = false): boolean => {
    if (node.nodeName === '#text' && 'value' in node) return !caption && !!node.value.trim();
    if (node.nodeName === '#comment') return false;
    if (!['#document-fragment', 'figure', 'figcaption', 'div', 'img', 'a', 'span', 'br'].includes(node.nodeName)) return true;
    const figureCaption = node.nodeName === 'figure' && 'childNodes' in node && node.childNodes.some(child => child.nodeName === 'figcaption' && !!text(child).trim());
    if (node.nodeName === 'img' && !labelled) return true;
    return 'childNodes' in node && node.childNodes.some(child => mediaError(child, caption || node.nodeName === 'figcaption' || node.nodeName === 'a', labelled || figureCaption));
  };
  if (mediaError(parseFragment(content.comparison))) return 'The media fragment may contain full images and nearby captions only; put evidence and user impact in the paired differences.';
  return undefined;
}
