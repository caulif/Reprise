import { parse } from 'parse5';
import { reportString, type ComparisonReportStringKey } from './comparison-report-strings.js';

const KEYS: readonly ComparisonReportStringKey[] = [
  'hostLimitationHeadlineMissing', 'hostLimitationLeakedInternal', 'hostLimitationShareCardPresentation',
  'hostLimitationVerifiedWordlist', 'hostLimitationVisualWordlist', 'hostLimitationCitedMediaUnresolved',
  'hostLimitationUnpairedImages', 'hostLimitationOneSidedMissingNote',
];
type Node = {
  tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[]; parentNode?: Node;
  sourceCodeLocation?: { startOffset: number; endOffset: number };
};

/** Prior publication repairs may have removed the source of a diagnostic; retain its identity, not duplicate prose. */
export function extractHostLimitations(html: string): { html: string; limitations: ComparisonReportStringKey[] } {
  const edits: { start: number; end: number }[] = [];
  const limitations = new Set<ComparisonReportStringKey>();
  const text = (node: Node): string => node.value ?? (node.childNodes ?? []).map(text).join('');
  const visit = (node: Node, agentZone = false): void => {
    const inside = agentZone || !!node.attrs?.some(attr => attr.name === 'data-agent-zone');
    if (inside && node.tagName === 'p' && node.attrs?.some(attr => attr.name === 'data-host-limitation')) {
      const body = text(node);
      const key = KEYS.find(key => ['zh', 'en'].some(locale => body === reportString(locale as 'zh' | 'en', key)));
      if (key && node.sourceCodeLocation) {
        edits.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset });
        if (key !== 'hostLimitationVisualWordlist') limitations.add(key);
        return;
      }
    }
    for (const child of node.childNodes ?? []) visit(child, inside);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }) as unknown as Node);
  let next = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, edit.start) + next.slice(edit.end);
  return { html: next, limitations: [...limitations] };
}
