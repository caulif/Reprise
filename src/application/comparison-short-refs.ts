import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";

const SHORT_REF_MAX = 999_999;

export function withEvidenceShortRefs(links: readonly ComparisonLinkRecord[]): ComparisonLinkRecord[] {
  return appendEvidenceShortRefs([], links);
}

export function withMediaShortRefs(media: readonly ComparisonMediaRecord[]): ComparisonMediaRecord[] {
  return appendMediaShortRefs([], media);
}

/** Append-only: preserve existing shortRefs; assign the next unused number to new items. */
export function appendEvidenceShortRefs(
  existing: readonly ComparisonLinkRecord[],
  incoming: readonly ComparisonLinkRecord[],
): ComparisonLinkRecord[] {
  const used = new Set(existing.flatMap((link) => link.shortRef ? [link.shortRef] : []));
  let next = nextShortIndex(used, "ev");
  return incoming.map((link) => {
    if (link.shortRef && used.has(link.shortRef)) {
      return { ...link, label: link.label ?? evidenceLabel(link) };
    }
    if (link.shortRef && /^ev-[0-9]{2,6}$/.test(link.shortRef) && !used.has(link.shortRef)) {
      used.add(link.shortRef);
      next = Math.max(next, parseShortIndex(link.shortRef, "ev") + 1);
      return { ...link, label: link.label ?? evidenceLabel(link) };
    }
    const shortRef = formatShortRef("ev", next);
    used.add(shortRef);
    next += 1;
    return { ...link, shortRef, label: link.label ?? evidenceLabel(link) };
  });
}

/** Append-only: preserve existing shortRefs; assign the next unused number to new items. */
export function appendMediaShortRefs(
  existing: readonly ComparisonMediaRecord[],
  incoming: readonly ComparisonMediaRecord[],
): ComparisonMediaRecord[] {
  const used = new Set(existing.flatMap((item) => item.shortRef ? [item.shortRef] : []));
  let next = nextShortIndex(used, "media");
  return incoming.map((item) => {
    if (item.shortRef && used.has(item.shortRef)) {
      return { ...item, label: item.label ?? mediaLabel(item) };
    }
    if (item.shortRef && /^media-[0-9]{2,6}$/.test(item.shortRef) && !used.has(item.shortRef)) {
      used.add(item.shortRef);
      next = Math.max(next, parseShortIndex(item.shortRef, "media") + 1);
      return { ...item, label: item.label ?? mediaLabel(item) };
    }
    const shortRef = formatShortRef("media", next);
    used.add(shortRef);
    next += 1;
    return { ...item, shortRef, label: item.label ?? mediaLabel(item) };
  });
}

export function formatShortRef(prefix: "ev" | "media", index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > SHORT_REF_MAX) {
    throw new Error(`Short ref index out of range for ${prefix}.`);
  }
  return `${prefix}-${String(index).padStart(2, "0")}`;
}

function nextShortIndex(used: ReadonlySet<string>, prefix: "ev" | "media"): number {
  let max = 0;
  for (const ref of used) {
    if (!ref.startsWith(`${prefix}-`)) continue;
    max = Math.max(max, parseShortIndex(ref, prefix));
  }
  return max + 1;
}

function parseShortIndex(ref: string, prefix: "ev" | "media"): number {
  const raw = ref.slice(prefix.length + 1);
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : 0;
}

function mediaLabel(item: ComparisonMediaRecord): string {
  return item.inspectPath.split("/").at(-1) ?? item.ref;
}

function evidenceLabel(link: ComparisonLinkRecord): string {
  if (link.origin === "derived_analysis" || link.side === "derived") return "派生分析证据";
  if (link.origin === "host_review" || link.side === "host") return "Host 审阅材料";
  if (link.origin === "historical_artifact") return "历史终稿产物";
  if (link.origin === "reconstructed_from_history") return "自历史重建的产物";
  if (link.origin === "candidate_delivery" || (link.side === "candidate" && link.path)) return "候选会话最终交付";
  if (link.side === "baseline") return "历史会话最终回复";
  if (link.path) return "候选会话最终交付";
  if (link.mediaType?.startsWith("image/")) return "候选生成的图片预览";
  if (link.side === "candidate") return "候选会话材料";
  return "比较证据";
}
