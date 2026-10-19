import { pairedContentFromHtml } from './comparison-paired-content.js';
import type { ComparisonReportFacts, ComparisonResult } from '../agents/comparison-contract.js';
import type { ComparisonLinkRecord, ComparisonMediaRecord, ComparisonReportModel } from '../core/schema.js';
import type { AgentLocale } from '../agents/language.js';
import { comparisonReportFormat, evidenceQuoteMarkupOnly, extractInner } from '../core/comparison-html.js';
import { comparisonDifferenceTexts, comparisonPlainText } from './comparison-report-text.js';
import { candidateStatusLabel, reportString } from './comparison-report-strings.js';
const plainLine = (html: string) => comparisonPlainText(html).replace(/\s+/g, ' ').trim();

export function comparisonReportModelFromHtml(
  html: string,
  facts: ComparisonReportFacts,
  result: ComparisonResult,
  media: readonly ComparisonMediaRecord[],
  evidence: readonly ComparisonLinkRecord[] = [],
  locale: AgentLocale = "zh",
): ComparisonReportModel {
  const paired = comparisonReportFormat(html) >= 6 ? pairedContentFromHtml(html) : undefined;
  const slots = {
    header: extractInner(html, "data-host-zone", "header"),
    comparison: paired?.comparison ?? extractInner(html, "data-agent-zone", "comparison"),
    details: extractInner(html, "data-agent-zone", "details"),
    evidence: extractInner(html, "data-host-zone", "evidence"),
    process: extractInner(html, "data-host-zone", "process"),
  };
  const evidenceRefs = result.evidenceRefs.flatMap((short) => {
    const hit = evidence.find((item) => item.shortRef === short)?.evidenceRef;
    return hit ? [hit] : [];
  });
  const evidenceIdentities = result.evidenceRefs.flatMap((short) => {
    const hit = evidence.find((item) => item.shortRef === short);
    return hit?.contentHash ? [{ shortRef: short, contentHash: hit.contentHash, sourceRefs: hit.sourceRefs ?? [] }] : [];
  });
  const markup = evidenceQuoteMarkupOnly(html);
  const mediaRefs = media.filter((item) => markup.includes(item.reportHref) || (item.shortRef && markup.includes(item.shortRef))).map((item) => item.ref);
  const slotHeadline = plainLine(extractInner(html, "data-agent-slot", "headline"));
  const headline = comparisonReportFormat(html) >= 6 ? slotHeadline
    : result.headline ?? (slotHeadline.length > 0 && slotHeadline.length <= 280 ? slotHeadline : undefined);
  const base = {
    schemaVersion: 1 as const,

    task: plainLine(extractInner(html, "data-agent-slot", "task")) || plainLine(extractInner(html, "data-slot", "task")) || reportString(locale, "defaultCategory"),
    status: {
      baseline: facts.replay.baselineEvidence,
      candidate: candidateStatusLabel(facts.run.outcome, facts.run.terminationCode, locale),
      candidateOutcome: facts.run.outcome,
      terminationCode: facts.run.terminationCode,
    },
    ...(facts.metrics ? { metrics: facts.metrics } : {}),
    slots,
    evidenceRefs,
    ...(evidenceIdentities.length ? { evidenceIdentities } : {}),
    mediaRefs,
    ...(headline ? { headline } : {}),
  };
  if (paired) {
    const content = { ...base, task: comparisonPlainText(extractInner(html, "data-agent-slot", "category")), headline: headline ?? "", reason: paired.reason, pairedDifferences: paired.pairedDifferences };
    return comparisonReportFormat(html) === 7 ? { ...content, formatVersion: 7, ...(facts.sessionAgents ? { sessionAgents: facts.sessionAgents } : {}) }
      : { ...content, formatVersion: 6, boundary: comparisonPlainText(extractInner(html, "data-agent-slot", "boundary")) };
  }
  return comparisonReportFormat(html) >= 3
    ? { ...base, ...(comparisonReportFormat(html) >= 4 ? { task: comparisonPlainText(extractInner(html, 'data-agent-slot', 'category')) } : {}), formatVersion: comparisonReportFormat(html) as 3 | 4 | 5, headline: headline ?? '', boundary: comparisonPlainText(extractInner(html, 'data-agent-slot', 'boundary')), differences: comparisonDifferenceTexts(html) }
    : { ...base, formatVersion: 2 };
}
