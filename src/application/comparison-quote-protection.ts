import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

function quoteSpans(html: string): { start: number; end: number; bodyStart: number; bodyEnd: number }[] {
  const spans: { start: number; end: number; bodyStart: number; bodyEnd: number }[] = [];
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    if ('attrs' in node && node.nodeName === 'figure' && node.attrs.some(attr => attr.name === 'data-component' && attr.value === 'evidence-quote')) {
      const location = node.sourceCodeLocation;
      if (!location) throw new Error('Validated evidence quotation has no source span.');
      spans.push({ start: location.startOffset, end: location.endOffset,
        bodyStart: location.startTag?.endOffset ?? location.startOffset, bodyEnd: location.endTag?.startOffset ?? location.endOffset });
      return;
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node) visit(node.content);
  };
  visit(parseFragment(html, { sourceCodeLocationInfo: true }));
  return spans;
}

export function transformOutsideEvidenceQuotes(html: string, transform: (text: string) => string, omitQuotes = false): string {
  let cursor = 0;
  let output = '';
  for (const span of quoteSpans(html).sort((a, b) => a.start - b.start)) {
    output += transform(html.slice(cursor, span.start));
    if (!omitQuotes) output += html.slice(span.start, span.end);
    cursor = span.end;
  }
  return output + transform(html.slice(cursor));
}

export function evidenceQuoteMarkupOnly(html: string): string {
  let output = html;
  for (const span of quoteSpans(html).sort((a, b) => b.bodyStart - a.bodyStart)) output = output.slice(0, span.bodyStart) + output.slice(span.bodyEnd);
  return output;
}
