import { pairedContentError } from './comparison-paired-content.js';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { comparisonReportFormat, extractInner } from '../core/comparison-html.js';
import { extractHostLimitations } from './comparison-host-limitations.js';

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

/** Format 3 counts every author code point, including closed and hidden fragments. */
export function comparisonCompactTextCharacters(html: string): number {
  html = extractHostLimitations(html).html;
  const parts = [extractInner(html, 'data-agent-slot', 'reason'), extractInner(html, 'data-agent-slot', 'category'), extractInner(html, 'data-agent-slot', 'headline'), extractInner(html, 'data-agent-slot', 'boundary'),
    extractInner(html, 'data-agent-zone', 'comparison'), extractInner(html, 'data-agent-zone', 'differences')];
  const text = (node: Node): string => {
    if (nonExplanatory(node)) return '';
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    return 'childNodes' in node ? node.childNodes.map(text).join(' ') : '';
  };
  return nonWhitespaceCodePoints(text(parseFragment(parts.join(' '))));
}
export function nonWhitespaceCodePoints(text: string): number { return [...text.replace(/\s/gu, '')].length; }

function nodePlainText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value;
  return 'childNodes' in node ? node.childNodes.map(nodePlainText).join('') : '';
}
export function comparisonPlainText(html: string): string { return nodePlainText(parseFragment(html)).trim(); }
export function comparisonDifferenceTexts(html: string): string[] {
  const items: string[] = [];
  const visit = (node: Node): void => {
    if ('attrs' in node && node.attrs.some(attr => attr.name === 'data-difference')) {
      items.push(nodePlainText(node).trim()); return;
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(parseFragment(extractInner(html, 'data-agent-zone', 'differences')));
  return items;
}

export function comparisonCompactTextBudgetError(html: string): string | undefined {
  if (comparisonReportFormat(html) === 6) { const error = pairedContentError(html); if (error) return error; }
  const hasDetails = (node: Node): boolean => node.nodeName === 'details' || ('childNodes' in node && node.childNodes.some(hasDetails));
  if (hasDetails(parseFragment(html))) return 'Format 3 cannot contain expandable details.';
  const headline = comparisonPlainText(extractInner(html, 'data-agent-slot', 'headline'));
  const differences = comparisonDifferenceTexts(html);
  if (comparisonReportFormat(html) === 4) {
    const category = comparisonPlainText(extractInner(html, 'data-agent-slot', 'category'));
    if (!category.trim() || nonWhitespaceCodePoints(category) > 32 || nonWhitespaceCodePoints(headline) > 60
      || differences.length || comparisonCompactTextCharacters(html) > 500) {
      return 'Shareable reports require an abstract title (32 characters), a conclusion (60 characters), one comparison body and at most 500 author characters.';
    }
  }
  if (comparisonReportFormat(html) >= 4) {
    const category = comparisonPlainText(extractInner(html, 'data-agent-slot', 'category'));
    if (!category.trim() || nonWhitespaceCodePoints(category) > 32) return 'Abstract title exceeds 32 characters.';
    const author = ['category', 'headline', 'boundary', 'reason'].map(slot => extractInner(html, 'data-agent-slot', slot)).join(' ')
      + extractInner(html, 'data-agent-zone', 'comparison') + extractInner(html, 'data-agent-zone', 'differences');
    const texts: string[] = [];
    const attributes: string[] = [];
    const visit = (node: Node): void => {
      if (['p', 'li', 'td', 'th', 'div', 'section', 'figure', 'figcaption', 'br'].includes(node.nodeName)) texts.push(' ');
      if (node.nodeName === '#text' && 'value' in node) texts.push(node.value);
      if ('attrs' in node) attributes.push(...node.attrs.filter(attr => ['alt', 'title', 'aria-label'].includes(attr.name)).map(attr => attr.value));
      if ('childNodes' in node) node.childNodes.forEach(visit);
      if ('content' in node) visit(node.content);
      if (['p', 'li', 'td', 'th', 'div', 'section', 'figure', 'figcaption'].includes(node.nodeName)) texts.push(' ');
    };
    visit(parseFragment(author));
    const text = `${texts.join('')} ${attributes.join(' ')}`;
    if (/[a-z]:[\\/]|\\\\[^\s\\]+|file:\/\/|\/(?:Users|home|mnt|var|tmp)\//i.test(text)
      || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)
      || /[\w\u4e00-\u9fff-]+\.(?:docx?|pdf|xlsx?|pptx?|html?|svg|png|jpe?g|tsx?|jsx?|json|md|rs|py)\b/i.test(text)
      || /(?:\+?\d[\d ()-]{8,}\d)/.test(text)) {
      return 'Shareable report contains a possible path, filename or contact detail. Abstract or omit it, including captions and image labels; do not quote private source text.';
    }
  }
  if (!headline.trim() || nonWhitespaceCodePoints(headline) > 80 || differences.length > 3
    || differences.some(text => !text.trim() || nonWhitespaceCodePoints(text) > 60) || comparisonCompactTextCharacters(html) > 900) {
    return 'Format 3 author text exceeds the recommendation, difference or 900-character budget.';
  }
  return undefined;
}
