import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { extractInner } from '../core/comparison-html.js';

export function comparisonVisibleMainText(html: string): string {
  const textContent = (node: DefaultTreeAdapterMap['node']): string => {
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    if (node.nodeName === 'template' || node.nodeName === 'script' || node.nodeName === 'style') return '';
    if (!('childNodes' in node)) return '';
    const children = node.nodeName === 'details' && 'attrs' in node && !node.attrs.some(attr => attr.name === 'open')
      ? node.childNodes.filter(child => child.nodeName === 'summary').slice(0, 1) : node.childNodes;
    return children.map(textContent).join(' ');
  };
  const main = extractInner(html, 'data-agent-zone', 'comparison');
  const headline = extractInner(html, 'data-agent-slot', 'headline');
  return textContent(parseFragment(`${headline} ${main}`)).replace(/\s+/g, ' ').trim();
}

export function comparisonMainTextCharacters(html: string): number {
  return [...comparisonVisibleMainText(html)].length;
}
