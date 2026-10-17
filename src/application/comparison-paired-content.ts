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
      const field = (name: string) => {
        const find = (child: Node): Node | undefined => 'attrs' in child && child.attrs.some(attr => attr.name === 'data-result-field' && attr.value === name) ? child : 'childNodes' in child ? child.childNodes.map(find).find(Boolean) : undefined;
        const hit = find(node); return hit ? text(hit) : '';
      };
      const refs: string[] = [];
      const citations = (child: Node): void => { if ('attrs' in child) refs.push(...child.attrs.filter(attr => attr.name === 'data-evidence-ref').map(attr => attr.value)); if ('childNodes' in child) child.childNodes.forEach(citations); };
      citations(node);
      pairedDifferences.push({ dimension: field('dimension'), baseline: field('baseline'), candidate: field('candidate'), impact: field('impact'), ...(refs.length ? { evidenceRefs: refs } : {}) });
      return;
    }
    if ('childNodes' in node) node.childNodes.forEach(visit);
  };
  visit(parseFragment(html));
  return { reason: text(parseFragment(extractInner(html, 'data-agent-slot', 'reason'))), pairedDifferences, comparison: extractInner(html, 'data-report-field', 'media') };
}

export function renderPairedContent(differences: readonly ComparisonPairedDifference[], media: string, zh: boolean): string {
  return `${differences.map((d, i) => `<section class="difference" data-paired-difference><h2><span class="ordinal">${String(i + 1).padStart(2, '0')}</span><span data-result-field="dimension">${pairedEscape(d.dimension)}</span></h2><div class="outcomes"><p><span class="side">${zh ? '历史' : 'History'}</span><strong data-result-field="baseline">${pairedEscape(d.baseline)}</strong></p><p><span class="side">${zh ? '当前' : 'Current'}</span><strong data-result-field="candidate">${pairedEscape(d.candidate)}</strong></p></div><p class="impact"><span>${zh ? '对你的影响' : 'User impact'} · </span><span data-result-field="impact">${pairedEscape(d.impact)}</span>${(d.evidenceRefs ?? []).map(ref => `<span data-evidence-ref="${pairedEscape(ref)}"></span>`).join('')}</p></section>`).join('')}<div class="media" data-report-field="media">${media}</div>`;
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
