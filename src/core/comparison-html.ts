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

function comparisonElements(html: string): DefaultTreeAdapterMap['element'][] {
  const elements: DefaultTreeAdapterMap['element'][] = [];
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    if ('attrs' in node) elements.push(node);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node) visit(node.content);
  };
  visit(parseFragment(html, { sourceCodeLocationInfo: true }));
  return elements;
}

const HOST_ZONES = ["style", "header", "metrics", "cost-note", "evidence", "process"] as const;
/** Format-2 agent zones. Legacy visual-evidence / key-differences / delivery / limitations are not accepted on new drafts. */
export const AGENT_ZONES = ["comparison", "details"] as const;
const AGENT_SLOTS = ["headline", "category", "task"] as const;
const COMPONENT_TEMPLATES = [
  "headline",
  "difference-card",
  "split-compare",
  "diff-table",
  "timeline",
  "media-compare",
  "pair-pages",
] as const;
export type HostZoneName = (typeof HOST_ZONES)[number];
export type AgentZoneName = (typeof AGENT_ZONES)[number];
export type HostZoneSnapshot = Record<HostZoneName, string>;

const ZONE_TAG = "header|section|style|p|span";

export function missingComparisonSlots(html: string): string | undefined {
  for (const zone of HOST_ZONES) {
    if (!hasMarker(html, "data-host-zone", zone)) return `Comparison report is missing data-host-zone="${zone}".`;
  }
  for (const zone of AGENT_ZONES) {
    if (!hasMarker(html, "data-agent-zone", zone)) return `Comparison report is missing data-agent-zone="${zone}".`;
  }
  for (const slot of AGENT_SLOTS) {
    if (!hasMarker(html, "data-agent-slot", slot)) return `Comparison report is missing data-agent-slot="${slot}".`;
  }
  for (const name of COMPONENT_TEMPLATES) {
    if (!hasMarker(html, "data-component-template", name)) return `Comparison report is missing component template "${name}".`;
  }
  return shareCardLayoutError(html);
}

function shareCardLayoutError(html: string): string | undefined {
  if (!hasMarker(html, "data-report-format", "2")) {
    return 'Share card must declare data-report-format="2".';
  }
  const header = tagMarkerIndex(html, "data-host-zone", "header");
  const headline = tagMarkerIndex(html, "data-agent-slot", "headline");
  const comparison = tagMarkerIndex(html, "data-agent-zone", "comparison");
  const metrics = tagMarkerIndex(html, "data-host-zone", "metrics");
  const details = tagMarkerIndex(html, "data-agent-zone", "details");
  const compact = hasMarker(extractOuter(html, "data-host-zone", "metrics") ?? "", "data-metrics-layout", "compact");
  const costNote = tagMarkerIndex(html, "data-host-zone", "cost-note");
  const orderError = compact
    ? "Share card order must be header, headline, metrics, cost-note, then comparison; details stay after the share card."
    : "Share card order must be header, headline, comparison, then metrics; details stay after the share card.";
  if (header < 0 || headline < 0 || comparison < 0 || metrics < 0 || details < 0) {
    return orderError;
  }
  const valid = compact
    ? header < headline && headline < metrics && metrics < costNote && costNote < comparison && comparison < details
    : header < headline && headline < comparison && comparison < metrics && metrics < details;
  if (!valid) {
    return orderError;
  }
  return undefined;
}

/** True when the zone has no visible text and no media/table after stripping comments. */
export function agentZoneBlank(html: string, zone: AgentZoneName): boolean {
  const outer = extractOuter(html, "data-agent-zone", zone);
  if (!outer) return true;
  const open = outer.match(new RegExp(`^<(${ZONE_TAG})\\b[^>]*>`, "i"));
  if (!open) return true;
  const tag = open[1] ?? "section";
  const inner = outer.slice(open[0].length, outer.length - `</${tag}>`.length);
  const stripped = inner
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length > 0) return false;
  return !/<img\b|<table\b|<svg\b|<pre\b|<code\b|<video\b/i.test(inner);
}

function tagMarkerIndex(html: string, attr: string, value: string): number {
  return comparisonElements(html).find(node => node.attrs.some(item => item.name === attr && item.value === value))?.sourceCodeLocation?.startOffset ?? -1;
}

function hasMarker(html: string, attr: string, value: string): boolean {
  return comparisonElements(html).some(node => node.attrs.some(item => item.name === attr && item.value === value));
}

export function extractHostZoneSnapshot(html: string): HostZoneSnapshot | undefined {
  const snapshot = {} as HostZoneSnapshot;
  for (const zone of HOST_ZONES) {
    const outer = extractOuter(html, "data-host-zone", zone);
    if (!outer) return undefined;
    snapshot[zone] = canonicalizeHostZone(outer);
  }
  return snapshot;
}

export function hostZoneIntegrityError(html: string, snapshot: HostZoneSnapshot): string | undefined {
  const missing = missingComparisonSlots(html);
  if (missing) return missing;
  const current = extractHostZoneSnapshot(html);
  if (!current) return "Host zone snapshot is incomplete.";
  const order = comparisonElements(html).flatMap(node => node.attrs.filter(attr => attr.name === "data-host-zone").map(attr => attr.value));
  if (order.join("\0") !== HOST_ZONES.join("\0")) return "Host zone order or count was modified.";
  for (const zone of HOST_ZONES) {
    if (current[zone] !== snapshot[zone]) return `Host zone "${zone}" was modified.`;
  }
  return undefined;
}

function canonicalizeHostZone(html: string): string {
  const withoutAgentContent = html.replace(
    /<(p|div|h[1-6]|span)(\b[^>]*\bdata-agent-slot="[^"]+"[^>]*)>[\s\S]*?<\/\1>/gi,
    "<$1$2></$1>",
  );
  return withoutAgentContent
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<([A-Za-z][\w:-]*)([^>]*)>/g, (_all, tag: string, attrs: string) => `<${tag.toLowerCase()}${canonicalAttributes(attrs)}>`)
    .replace(/<\/([A-Za-z][\w:-]*)>/g, (_all, tag: string) => `</${tag.toLowerCase()}>`)
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

function canonicalAttributes(source: string): string {
  const attrs: string[] = [];
  const pattern = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name) continue;
    const raw = match[2];
    if (raw === undefined) attrs.push(name);
    else attrs.push(`${name}="${decodeHtml(raw.replace(/^['"]|['"]$/g, ""))}"`);
  }
  return attrs.length ? ` ${attrs.sort().join(" ")}` : "";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export function extractInner(html: string, attr: string, name: string): string {
  const outer = extractOuter(html, attr, name);
  if (!outer) return "";
  const open = outer.match(new RegExp(`^<(${ZONE_TAG})\\b[^>]*>`, "i"));
  if (!open) return "";
  const tag = open[1] ?? "section";
  return outer.slice(open[0].length, outer.length - `</${tag}>`.length).trim();
}

export function extractOuter(html: string, attr: string, name: string): string | undefined {
  const node = comparisonElements(html).find(node => node.attrs.some(item => item.name === attr && item.value === name));
  const location = node?.sourceCodeLocation;
  return location ? html.slice(location.startOffset, location.endOffset) : undefined;
}
