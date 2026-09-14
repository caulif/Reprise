import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";

export function withEvidenceShortRefs(links: readonly ComparisonLinkRecord[]): ComparisonLinkRecord[] {
  return links.map((link, index) => ({
    ...link,
    shortRef: `ev-${String(index + 1).padStart(2, "0")}`,
    label: link.label ?? evidenceLabel(link),
  }));
}

export function withMediaShortRefs(media: readonly ComparisonMediaRecord[]): ComparisonMediaRecord[] {
  return media.map((item, index) => ({
    ...item,
    shortRef: `media-${String(index + 1).padStart(2, "0")}`,
    label: item.label ?? (item.inspectPath.split("/").at(-1) ?? item.ref),
  }));
}

function evidenceLabel(link: ComparisonLinkRecord): string {
  if (link.side === "baseline") return "历史会话最终回复";
  if (link.path) return "候选会话最终交付";
  if (link.mediaType?.startsWith("image/")) return "候选生成的图片预览";
  return link.side === "candidate" ? "候选会话材料" : "比较证据";
}
