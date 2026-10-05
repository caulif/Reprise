import type { ComparisonLinkRecord, ComparisonMediaRecord } from '../core/schema.js';
import { AGENT_ZONES } from '../core/comparison-html.js';
import { evidenceQuoteMarkupOnly } from './comparison-quote-protection.js';

type ReferenceFailure = { failureClass: 'evidence'; code: 'evidence_unresolved'; message: string }
  | { failureClass: 'media'; code: 'media_unavailable'; message: string };

export function invalidAgentReferences(html: string, evidence: readonly ComparisonLinkRecord[], media: readonly ComparisonMediaRecord[]): ReferenceFailure | undefined {
  html = evidenceQuoteMarkupOnly(html);
  const unknownEvidence = [...html.matchAll(/\bdata-evidence-ref\s*=\s*(["'])([^"']+)\1/gi)]
    .map((match) => match[2] ?? '')
    .find((ref) => !evidence.some((item) => item.shortRef === ref));
  if (unknownEvidence) return { failureClass: 'evidence', code: 'evidence_unresolved', message: `Unknown evidence reference: ${unknownEvidence}.` };
  const unknownMedia = [...html.matchAll(/\bdata-media-ref\s*=\s*(["'])([^"']+)\1/gi)]
    .map((match) => match[2] ?? '')
    .find((ref) => !media.some((item) => item.shortRef === ref && item.available));
  if (unknownMedia) return { failureClass: 'media', code: 'media_unavailable', message: `Unavailable media reference: ${unknownMedia}.` };
  return undefined;
}

export function unexpectedAgentZones(html: string): string | undefined {
  html = evidenceQuoteMarkupOnly(html);
  const found = [...html.matchAll(/\bdata-agent-zone\s*=\s*(["'])([^"']+)\1/gi)].map((match) => match[2] ?? '');
  const extra = found.find((zone) => zone && !(AGENT_ZONES as readonly string[]).includes(zone));
  if (!extra) return undefined;
  return `Comparison report contains unsupported data-agent-zone="${extra}".`;
}
