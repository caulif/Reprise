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

type VisualEvidenceSideStatus = {
  baselineAvailable: boolean;
  candidateAvailable: boolean;
  baselineCount: number;
  candidateCount: number;
};

function visualEvidenceSideStatus(
  media: readonly ComparisonMediaRecord[],
): VisualEvidenceSideStatus {
  const baseline = media.filter((item) => item.side === "baseline" && item.available);
  const candidate = media.filter((item) => item.side === "candidate" && item.available);
  return {
    baselineAvailable: baseline.length > 0,
    candidateAvailable: candidate.length > 0,
    baselineCount: baseline.length,
    candidateCount: candidate.length,
  };
}

export function visualEvidenceUnavailableReason(
  media: readonly ComparisonMediaRecord[],
  locale: AgentLocale,
): string | undefined {
  if (media.length === 0) return reportString(locale, "visualNoMediaRegistered");
  const status = visualEvidenceSideStatus(media);
  if (status.baselineAvailable && status.candidateAvailable) return undefined;
  if (status.baselineAvailable) return reportString(locale, "visualCandidateMissing");
  if (status.candidateAvailable) return reportString(locale, "visualBaselineMissing");
  if (media.some((item) => item.side === "baseline" || item.side === "candidate")) {
    return reportString(locale, "visualRegisteredUnavailable");
  }
  return reportString(locale, "visualSourcesMissing");
}

function renderUnavailableNote(
  media: readonly ComparisonMediaRecord[],
  locale: AgentLocale,
): string {
  const reason = visualEvidenceUnavailableReason(media, locale);
  return reason ? `<p class="muted" data-host="visual-unavailable">${escapeHtml(reason)}</p>` : "";
}

/**
 * Host hint for the Agent comparison zone: candidate pairing refs when both
 * sides have available media, otherwise a source-fact note. Does not assert
 * that array-index pairs are business-comparable; Agent chooses verified peers.
 */
export function renderVisualEvidenceSeed(
  media: readonly ComparisonMediaRecord[] | undefined,
  locale: AgentLocale,
): string {
  const items = media ?? [];
  const baseline = items.filter((item) => item.side === "baseline" && item.available);
  const candidate = items.filter((item) => item.side === "candidate" && item.available);
  if (baseline.length === 0 && candidate.length === 0) {
    return renderUnavailableNote(items, locale);
  }
  if (baseline.length === 0 || candidate.length === 0) {
    const available = baseline.length > 0 ? baseline : candidate;
    const missingNote = renderUnavailableNote(items, locale);
    const who = escapeHtml(reportString(
      locale,
      baseline.length > 0 ? "sessionHistorical" : "sessionCurrent",
    ));
    const cells = available.map((item) => {
      const ref = item.shortRef ? ` data-media-ref="${escapeHtml(item.shortRef)}"` : "";
      return `<div class="cell" data-host="one-sided-visual"><div class="who">${who}</div><img${ref} alt=""></div>`;
    }).join("");
    return `${missingNote}<div class="pages" data-host="visual-candidates">${cells}</div>`;
  }
  const historical = escapeHtml(reportString(locale, "sessionHistorical"));
  const current = escapeHtml(reportString(locale, "sessionCurrent"));
  const candidates: string[] = [];
  for (const left of baseline) {
    for (const right of candidate) {
      const leftRef = left.shortRef ? ` data-media-ref="${escapeHtml(left.shortRef)}"` : "";
      const rightRef = right.shortRef ? ` data-media-ref="${escapeHtml(right.shortRef)}"` : "";
      candidates.push(`<div data-component="page-row" data-host="pairing-candidate" data-baseline-ref="${escapeHtml(left.shortRef ?? left.ref)}" data-candidate-ref="${escapeHtml(right.shortRef ?? right.ref)}">
    <div class="cell"><div class="who">${historical}</div><img${leftRef} alt=""></div>
    <div class="cell"><div class="who">${current}</div><img${rightRef} alt=""></div>
  </div>`);
    }
  }
  const note = `<p class="muted" data-host="pairing-hint">${escapeHtml(reportString(locale, "visualPairingHint"))}</p>`;
  return `${note}<div class="pages" data-host="visual-candidates">${candidates.join("")}</div>`;
}

export function isComparisonZoneEmpty(html: string): boolean {
  const match = html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/i)
    ?? html.match(/<section\b[^>]*\bdata-agent-zone="comparison"[^>]*>([\s\S]*?)<\/section>/i);
  const inner = (match?.[1] ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return inner.length === 0;
}
