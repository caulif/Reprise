import { Value } from '@sinclair/typebox/value';
import { ComparisonReviewRequestSchema, ComparisonReviewStartedSchema, ComparisonDraftAcceptanceReceiptSchema, ComparisonDraftInspectionSchema } from '../core/comparison-review-schema.js';
import { ComparisonDraftAcceptedSchema } from '../core/comparison-discovery-schema.js';
import type { EventEnvelope } from '../core/schema.js';
import { Type } from '@sinclair/typebox';
import { AgentTextBodySchema } from '../core/agent-model-input-schema.js';
import { sha256 } from '../core/identity.js';
import type { ExperimentStore } from '../infrastructure/store/experiment-store.js';
import { redactModelVisibleText, reconstructModelRequests } from '../infrastructure/agent/model-input.js';
import { experimentModelInputResolver } from './experiment-helpers.js';

const InspectionContentSchema = Type.Object({
  ...ComparisonDraftInspectionSchema.properties,
  headline: Type.String(), comparisonHtml: Type.String(), detailsHtml: Type.String(),
});

export async function recoveryReviewBinding(input: {
  events: readonly EventEnvelope[]; attemptId: string; draftDigest: string; catalogRevision: number;
  previewSessionId: string; acceptedAfterSequence: number;
  store: Pick<ExperimentStore, 'experimentId' | 'readArtifact'>;
  content: { headline: string; comparisonHtml: string; detailsHtml: string };
}): Promise<string | undefined> {
  const belongs = (event: EventEnvelope) => typeof event.payload === 'object' && event.payload !== null
    && 'attemptId' in event.payload && event.payload.attemptId === input.attemptId;
  const started = input.events.filter(event => event.type === 'comparison.review_started' && belongs(event)).at(-1);
  const auditStarted = input.events.filter(event => event.type === 'comparison.draft_audit_started' && belongs(event)
    && (!started || event.sequence > started.sequence)).at(-1);
  const requested = input.events.filter(event => event.type === 'comparison.requested' && belongs(event)
    && typeof event.payload === 'object' && event.payload !== null && 'reviewInspectionContractVersion' in event.payload).at(-1);
  if (requested && typeof requested.payload === 'object' && requested.payload !== null) {
    const contract = { attemptId: input.attemptId, reviewInspectionContractVersion: (requested.payload as Record<string, unknown>).reviewInspectionContractVersion };
    if (!Value.Check(ComparisonReviewRequestSchema, contract)) throw new Error('Invalid Comparison review request contract audit.');
    if (contract.reviewInspectionContractVersion === 2 && (!auditStarted || (started && auditStarted.sequence <= started.sequence))) {
      return 'Required draft audit never started after the latest independent review.';
    }
  }
  if (!started) return requested ? 'Required independent review never started.' : undefined;
  if (!Value.Check(ComparisonReviewStartedSchema, started.payload)) throw new Error('Invalid Comparison review contract audit.');
  if (auditStarted && !Value.Check(ComparisonReviewStartedSchema, auditStarted.payload)) throw new Error('Invalid Comparison draft audit contract audit.');
  if (auditStarted && Value.Check(ComparisonReviewStartedSchema, auditStarted.payload) && auditStarted.payload.sessionId !== started.payload.sessionId) {
    return 'Draft audit does not belong to the latest independent review session.';
  }
  const inspectionAfter = Math.max(started.sequence, auditStarted?.sequence ?? 0, input.acceptedAfterSequence);
  const sessionId = started.payload.sessionId;
  if (sessionId !== input.previewSessionId) return 'Preview does not belong to the latest independent review session.';
  const inspected = input.events.filter(event => event.type === 'agent.tool_completed' && belongs(event)
    && event.sequence > inspectionAfter
    && typeof event.payload === 'object' && event.payload !== null
    && 'tool' in event.payload && event.payload.tool === 'inspect_comparison_draft'
    && !('nativeHook' in event.payload)
    && 'sessionId' in event.payload && event.payload.sessionId === sessionId).at(-1);
  if (!inspected || typeof inspected.payload !== 'object' || inspected.payload === null || !('details' in inspected.payload)) {
    return 'No inspection of the latest accepted draft in the independent review session.';
  }
  const inspectionPayload = inspected.payload;
  if (!('toolCallId' in inspectionPayload) || typeof inspectionPayload.toolCallId !== 'string' || !inspectionPayload.toolCallId) {
    return 'Inspection has no completed tool call identity.';
  }
  if (input.events.some(event => event.type === 'agent.tool_failed' && event.sequence > inspected.sequence && belongs(event)
    && typeof event.payload === 'object' && event.payload !== null
    && 'sessionId' in event.payload && event.payload.sessionId === sessionId
    && 'toolCallId' in event.payload && event.payload.toolCallId === inspectionPayload.toolCallId)) {
    return 'Inspection tool call failed after its content audit; inspect again.';
  }
  if (!Value.Check(ComparisonDraftInspectionSchema, inspected.payload.details)) throw new Error('Invalid Comparison draft inspection receipt.');
  const receipt = inspected.payload.details;
  const submitted = input.events.filter(event => event.type === 'agent.tool_completed' && belongs(event)
    && typeof event.payload === 'object' && event.payload !== null && 'tool' in event.payload
    && event.payload.tool === 'submit_comparison_draft' && !('nativeHook' in event.payload)
    && 'details' in event.payload && Value.Check(ComparisonDraftAcceptanceReceiptSchema, event.payload.details)).at(-1);
  if (!submitted || typeof submitted.payload !== 'object' || submitted.payload === null || !('details' in submitted.payload)
    || !Value.Check(ComparisonDraftAcceptanceReceiptSchema, submitted.payload.details)) return 'No accepted draft receipt for the review contract.';
  const binding = submitted.payload.details;
  if (receipt.bindingRevision !== binding.bindingRevision || receipt.decisionShape !== binding.decisionShape
    || receipt.findingsRevision !== binding.findingsRevision || receipt.draftDigest !== binding.draftDigest
    || receipt.catalogRevision !== binding.catalogRevision) return 'Inspection is not bound to the latest accepted draft declaration.';
  const accepted = input.events.find(event => event.sequence === input.acceptedAfterSequence);
  if (accepted && (!Value.Check(ComparisonDraftAcceptedSchema, accepted.payload) || receipt.findingsRevision !== accepted.payload.findingsRevision)) {
    return 'Inspection is not bound to the current findings revision.';
  }
  if (!receipt.reviewInspectionRequired || receipt.draftDigest !== input.draftDigest || receipt.catalogRevision !== input.catalogRevision) {
    return 'Inspection is not bound to the current draft and evidence catalog.';
  }
  if (!('body' in inspected.payload) || !Value.Check(AgentTextBodySchema, inspected.payload.body)) {
    return 'Inspection has no complete model-facing content audit.';
  }
  const body = inspected.payload.body;
  let text: string;
  if (body.encoding === 'artifact') {
    if (!inspected.runId) throw new Error('Inspection audit artifact has no run identity.');
    const bytes = await input.store.readArtifact({ artifactId: body.artifactId, experimentId: input.store.experimentId, runId: inspected.runId });
    if (bytes.byteLength !== body.byteLength || sha256(bytes) !== body.contentHash) throw new Error('Inspection audit artifact failed integrity check.');
    text = Buffer.from(bytes).toString('utf8');
  } else text = body.text;
  const content: unknown = JSON.parse(text);
  if (!Value.Check(InspectionContentSchema, content)) return 'Inspection audit does not contain the full draft content.';
  for (const key of Object.keys(receipt) as (keyof typeof receipt)[]) {
    if (content[key] !== receipt[key]) return 'Inspection content does not match its binding receipt.';
  }
  // Apply the same model-facing redaction to the serialized content before comparing slots.
  const expected: unknown = JSON.parse(redactModelVisibleText(JSON.stringify(input.content)).text);
  if (!Value.Check(Type.Object({ headline: Type.String(), comparisonHtml: Type.String(), detailsHtml: Type.String() }), expected)) {
    return 'Draft content cannot be compared after model-facing redaction.';
  }
  if (content.headline.replace(/\s+/g, ' ').trim() !== expected.headline.replace(/\s+/g, ' ').trim()
    || content.comparisonHtml !== expected.comparisonHtml || content.detailsHtml !== expected.detailsHtml) {
    return 'Inspection audit does not contain the actual full accepted draft.';
  }
  return reviewGenerationBinding(input, sessionId, inspected.sequence, content);
}

async function reviewGenerationBinding(input: Parameters<typeof recoveryReviewBinding>[0], sessionId: string, inspectedSequence: number, content: unknown): Promise<string | undefined> {
  const reviewEvents = input.events.filter(event => typeof event.payload === 'object' && event.payload !== null
    && 'sessionId' in event.payload && event.payload.sessionId === sessionId);
  const resolver = Object.assign(experimentModelInputResolver(input.store), {
    forRun: (runId: string | undefined) => experimentModelInputResolver(input.store, runId),
  });
  for (const request of reviewEvents.filter(event => event.sequence > inspectedSequence && event.type === 'agent.model_request'
    && typeof event.payload === 'object' && event.payload !== null && 'scope' in event.payload && event.payload.scope === 'generation')) {
    const replay = await reconstructModelRequests(reviewEvents.filter(event => event.sequence <= request.sequence), resolver);
    if (replay.diagnostic) return `Independent review input audit is incomplete: ${replay.diagnostic.code}.`;
    const actual = replay.requests.at(-1);
    const payload = request.payload;
    if (!actual?.contentComplete || actual.contextSource !== 'generation_snapshot'
      || !actual.modelRequestDigest || typeof payload !== 'object' || payload === null
      || !('digest' in payload) || actual.modelRequestDigest !== payload.digest
      || actual.sessionId !== sessionId) continue;
    if (actual.messages.some(message => {
      if (typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'toolResult'
        || !('toolName' in message) || message.toolName !== 'inspect_comparison_draft'
        || !('content' in message) || !Array.isArray(message.content)) return false;
      return message.content.some((block: unknown) => {
        if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text'
          || !('text' in block) || typeof block.text !== 'string') return false;
        try { return Value.Equal(JSON.parse(block.text), content); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Non-JSON messages cannot carry the complete inspection response.
          return false;
        }
      });
    })) return undefined;
  }
  return 'No generation input snapshot includes the complete inspected draft in the independent review session. Legacy event projections remain readable but cannot certify actual model delivery.';
}
