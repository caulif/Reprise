import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sha256 } from '../core/identity.js';
import type { ComparisonContext, ComparisonResult } from '../agents/comparison-agent.js';
import type { ExperimentStore } from '../infrastructure/store/experiment-store.js';
import type { ComparisonDraft } from './comparison-draft.js';
import type { ComparisonEvidenceCatalog } from './comparison-evidence.js';
import { comparisonReportModelFromHtml } from './comparison-publication.js';
import { recoveryReviewBinding } from './comparison-recovery-review.js';

const PreviewReceiptSchema = Type.Object({
  status: Type.Literal('ok'), draftDigest: Type.String(), revision: Type.Integer(),
});

/** Live and recovered publication require the same actual reviewed input. */
export async function completedReviewedComparison(input: {
  draft: Pick<ComparisonDraft, 'completedResult'>; store: Pick<ExperimentStore, 'events' | 'experimentId' | 'readArtifact'>; attemptId: string;
  attemptRoot: string; context: ComparisonContext; catalog: ComparisonEvidenceCatalog;
}): Promise<ComparisonResult | undefined> {
  const result = await input.draft.completedResult();
  if (!result) return undefined;
  const events = input.store.events();
  const belongs = (payload: unknown): payload is Record<string, unknown> => typeof payload === 'object'
    && payload !== null && 'attemptId' in payload && payload.attemptId === input.attemptId;
  if (!events.some(event => belongs(event.payload) && (event.type === 'comparison.review_started'
    || (event.type === 'comparison.requested' && 'reviewInspectionContractVersion' in event.payload)))) return result;
  const html = await readFile(join(input.attemptRoot, 'report.html'), 'utf8');
  const draftDigest = sha256(html);
  const catalog = input.catalog.snapshot();
  const accepted = events.filter(event => event.type === 'comparison.draft_accepted' && belongs(event.payload)).at(-1);
  const preview = events.filter(event => event.type === 'agent.tool_completed' && belongs(event.payload)
    && event.payload.tool === 'preview_report' && !('nativeHook' in event.payload)
    && typeof event.payload.sessionId === 'string' && Value.Check(PreviewReceiptSchema, event.payload.details)
    && event.payload.details.draftDigest === draftDigest && event.payload.details.revision === catalog.revision).at(-1);
  if (!preview || !belongs(preview.payload) || typeof preview.payload.sessionId !== 'string') return undefined;
  const model = comparisonReportModelFromHtml(html, input.context.reportFacts, result, catalog.media, catalog.links);
  const error = await recoveryReviewBinding({ store: input.store, events, attemptId: input.attemptId,
    draftDigest, catalogRevision: catalog.revision, previewSessionId: preview.payload.sessionId,
    acceptedAfterSequence: accepted?.sequence ?? 0,
    content: { headline: model.headline ?? '', comparisonHtml: model.slots.comparison ?? '', detailsHtml: model.slots.details ?? '' },
  });
  return error ? undefined : result;
}
