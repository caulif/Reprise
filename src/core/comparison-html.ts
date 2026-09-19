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
    if (!html.includes(`data-component-template="${name}"`)) return `Comparison report is missing component template "${name}".`;
  }
  return shareCardLayoutError(html);
}

function shareCardLayoutError(html: string): string | undefined {
  if (!/\bdata-report-format\s*=\s*(["'])2\1/i.test(html)) {
    return 'Share card must declare data-report-format="2".';
  }
  const header = tagMarkerIndex(html, "data-host-zone", "header");
  const headline = tagMarkerIndex(html, "data-agent-slot", "headline");
  const comparison = tagMarkerIndex(html, "data-agent-zone", "comparison");
  const metrics = tagMarkerIndex(html, "data-host-zone", "metrics");
  const details = tagMarkerIndex(html, "data-agent-zone", "details");
  if (header < 0 || headline < 0 || comparison < 0 || metrics < 0 || details < 0) {
    return "Share card order must be header, headline, comparison, then metrics; details stay after the share card.";
  }
  if (!(header < headline && headline < comparison && comparison < metrics && metrics < details)) {
    return "Share card order must be header, headline, comparison, then metrics; details stay after the share card.";
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
  const escapedAttr = attr.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  return html.search(new RegExp(`<(?:${ZONE_TAG})\\b[^>]*\\b${escapedAttr}\\s*=\\s*(["'])${escapedValue}\\1`, "i"));
}

function hasMarker(html: string, attr: string, value: string): boolean {
  const escapedAttr = attr.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedAttr}\\s*=\\s*(["'])${escapedValue}\\1`, "i").test(html);
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

export function hostZonesChanged(html: string, snapshot: HostZoneSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return hostZoneIntegrityError(html, snapshot) !== undefined;
}

export function hostZoneIntegrityError(html: string, snapshot: HostZoneSnapshot): string | undefined {
  const missing = missingComparisonSlots(html);
  if (missing) return missing;
  const current = extractHostZoneSnapshot(html);
  if (!current) return "Host zone snapshot is incomplete.";
  const order = [...html.matchAll(/\bdata-host-zone\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]);
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
  const escapedAttr = attr.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const escapedName = name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  const start = html.search(new RegExp(`<(${ZONE_TAG})\\b[^>]*\\b${escapedAttr}\\s*=\\s*(["'])${escapedName}\\2[^>]*>`, "i"));
  if (start < 0) return undefined;
  const open = html.slice(start).match(new RegExp(`^<(${ZONE_TAG})\\b[^>]*>`, "i"));
  if (!open) return undefined;
  const tag = open[1] ?? "section";
  const innerStart = start + open[0].length;
  const inner = innerUntilClose(html.slice(innerStart), tag);
  const close = `</${tag}>`;
  return html.slice(start, innerStart + inner.length + close.length);
}

function innerUntilClose(html: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b`, "ig");
  const close = new RegExp(`</${tag}>`, "ig");
  let depth = 1;
  let index = 0;
  while (index < html.length && depth > 0) {
    open.lastIndex = index;
    close.lastIndex = index;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return html;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      index = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return html.slice(0, nextClose.index);
    index = nextClose.index + nextClose[0].length;
  }
  return html;
}
