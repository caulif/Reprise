export const HOST_ZONES = ["style", "header", "status", "metrics", "cost-note", "evidence", "process"] as const;
export const AGENT_ZONES = ["key-differences", "visual-evidence", "delivery", "limitations"] as const;
export type HostZoneName = (typeof HOST_ZONES)[number];
export type AgentZoneName = (typeof AGENT_ZONES)[number];
export type HostZoneSnapshot = Record<HostZoneName, string>;

const ZONE_TAG = "header|section|style|p";

export function missingComparisonSlots(html: string): string | undefined {
  for (const zone of HOST_ZONES) {
    if (!html.includes(`data-host-zone="${zone}"`)) return `Comparison report is missing data-host-zone="${zone}".`;
  }
  for (const zone of AGENT_ZONES) {
    if (!html.includes(`data-agent-zone="${zone}"`)) return `Comparison report is missing data-agent-zone="${zone}".`;
  }
  return undefined;
}

export function extractHostZoneSnapshot(html: string): HostZoneSnapshot | undefined {
  const snapshot = {} as HostZoneSnapshot;
  for (const zone of HOST_ZONES) {
    const outer = extractOuter(html, "data-host-zone", zone);
    if (!outer) return undefined;
    snapshot[zone] = outer;
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
  const order = [...html.matchAll(/\bdata-host-zone="([^"]+)"/g)].map((match) => match[1]);
  if (order.join("\0") !== HOST_ZONES.join("\0")) return "Host zone order or count was modified.";
  for (const zone of HOST_ZONES) {
    if (current[zone] !== snapshot[zone]) return `Host zone "${zone}" was modified.`;
  }
  return undefined;
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
  const start = html.search(new RegExp(`<(${ZONE_TAG})\\b[^>]*${attr}="${name}"[^>]*>`, "i"));
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
