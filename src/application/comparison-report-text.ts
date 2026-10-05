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

export type ComparisonDetailsTextOptions = {
  /** Only set after stateless source validation succeeds for every evidence-quote component. */
  excludeValidatedQuotes?: boolean;
};

type Node = DefaultTreeAdapterMap['node'];

function nonExplanatory(node: Node): boolean {
  return node.nodeName === 'template' || node.nodeName === 'script' || node.nodeName === 'style';
}

function validatedQuote(node: Node, options: ComparisonDetailsTextOptions): boolean {
  return options.excludeValidatedQuotes === true && node.nodeName === 'figure' && 'attrs' in node
    && node.attrs.some(attr => attr.name === 'data-component' && attr.value === 'evidence-quote');
}

function allExplanationText(node: Node, options: ComparisonDetailsTextOptions): string {
  if (nonExplanatory(node) || validatedQuote(node, options)) return '';
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(child => allExplanationText(child, options)).join(' ') : '';
}

function foldedMainExplanation(node: Node, options: ComparisonDetailsTextOptions): string {
  if (nonExplanatory(node) || validatedQuote(node, options) || !('childNodes' in node)) return '';
  if (node.nodeName === 'details' && 'attrs' in node && !node.attrs.some(attr => attr.name === 'open')) {
    const summary = node.childNodes.find(child => child.nodeName === 'summary');
    // The first summary belongs to the main budget; its own nested folds still belong to explanation.
    return [summary ? foldedMainExplanation(summary, options) : '',
      ...node.childNodes.filter(child => child !== summary).map(child => allExplanationText(child, options))].join(' ');
  }
  return node.childNodes.map(child => foldedMainExplanation(child, options)).join(' ');
}

/** Counts all explanation, including closed/hidden content, without recounting visible main text. */
export function comparisonDetailsText(html: string, options: ComparisonDetailsTextOptions = {}): string {
  const details: string[] = [];
  const folded: string[] = [];
  const visit = (node: Node): void => {
    if (nonExplanatory(node)) return;
    if ('attrs' in node) {
      const zone = node.attrs.find(attr => attr.name === 'data-agent-zone')?.value;
      if (zone === 'details') { details.push(allExplanationText(node, options)); return; }
      if (zone === 'comparison') { folded.push(foldedMainExplanation(node, options)); return; }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(parseFragment(html));
  return [...details, ...folded].join(' ').replace(/\s+/g, ' ').trim();
}

export function comparisonDetailsTextCharacters(html: string, options: ComparisonDetailsTextOptions = {}): number {
  return [...comparisonDetailsText(html, options)].length;
}
