import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { extractInner } from '../core/comparison-html.js';
import { pairedEscape } from './comparison-paired-content.js';

export function linkPairedImages(html: string): string {
  const fragment = extractInner(html, 'data-report-field', 'media');
  const wraps: { start: number; end: number; href: string; linked: boolean }[] = [];
  const visit = (node: DefaultTreeAdapterMap['node'], linked = false): void => {
    if (node.nodeName === 'img' && 'attrs' in node && node.sourceCodeLocation) {
      const src = node.attrs.find(attr => attr.name === 'src')?.value;
      if (src) wraps.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset, href: src, linked });
    }
    if ('childNodes' in node) node.childNodes.forEach(child => visit(child, linked || node.nodeName === 'a'));
  };
  visit(parseFragment(fragment, { sourceCodeLocationInfo: true }));
  let media = fragment;
  for (const wrap of wraps.sort((a, b) => b.start - a.start)) {
    if (wrap.linked) continue;
    media = media.slice(0, wrap.start) + `<a href="${pairedEscape(wrap.href)}" aria-label="放大完整原图 / Open full original image">${media.slice(wrap.start, wrap.end)}</a>` + media.slice(wrap.end);
  }
  return fragment && media !== fragment ? html.replace(fragment, () => media) : html;
}
