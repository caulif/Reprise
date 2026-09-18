import type { AgentLocale } from "../agents/language.js";
import type { ComparisonMediaRecord } from "../core/schema.js";
import { reportString } from "./comparison-report-strings.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function visualEvidenceUnavailableReason(
  media: readonly ComparisonMediaRecord[],
  locale: AgentLocale,
): string | undefined {
  if (media.length === 0) return reportString(locale, "visualNoMediaRegistered");
  const baselineAvailable = media.some((item) => item.side === "baseline" && item.available);
  const candidateAvailable = media.some((item) => item.side === "candidate" && item.available);
  if (baselineAvailable && candidateAvailable) return undefined;
  if (baselineAvailable) return reportString(locale, "visualCandidateMissing");
  if (candidateAvailable) return reportString(locale, "visualBaselineMissing");
  if (media.some((item) => item.side === "baseline" || item.side === "candidate")) {
    return reportString(locale, "visualRegisteredUnavailable");
  }
  return reportString(locale, "visualSourcesMissing");
}

function renderVisualEvidenceUnavailable(
  media: readonly ComparisonMediaRecord[],
  locale: AgentLocale,
): string {
  const reason = visualEvidenceUnavailableReason(media, locale);
  return reason ? `<p class="muted" data-host="visual-unavailable">${escapeHtml(reason)}</p>` : "";
}

export function renderVisualEvidenceSeed(
  media: readonly ComparisonMediaRecord[] | undefined,
  locale: AgentLocale,
): string {
  const items = media ?? [];
  const baseline = items.filter((item) => item.side === "baseline" && item.available);
  const candidate = items.filter((item) => item.side === "candidate" && item.available);
  if (baseline.length === 0 || candidate.length === 0) {
    return renderVisualEvidenceUnavailable(items, locale);
  }
  const historical = escapeHtml(reportString(locale, "sessionHistorical"));
  const current = escapeHtml(reportString(locale, "sessionCurrent"));
  const rows: string[] = [];
  const pairs = Math.min(baseline.length, candidate.length);
  for (let index = 0; index < pairs; index += 1) {
    const left = baseline[index]!;
    const right = candidate[index]!;
    const leftRef = left.shortRef ? ` data-media-ref="${escapeHtml(left.shortRef)}"` : "";
    const rightRef = right.shortRef ? ` data-media-ref="${escapeHtml(right.shortRef)}"` : "";
    rows.push(`<div data-component="page-row" data-host="paired-visual">
    <div class="cell"><div class="who">${historical}</div><img${leftRef} alt=""></div>
    <div class="cell"><div class="who">${current}</div><img${rightRef} alt=""></div>
  </div>`);
  }
  return `<div class="pages">${rows.join("")}</div>`;
}

export function isVisualEvidenceEmpty(html: string): boolean {
  const match = html.match(/data-agent-zone="visual-evidence"[^>]*>([\s\S]*?)<\/section>/i);
  const inner = (match?.[1] ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return inner.length === 0;
}
