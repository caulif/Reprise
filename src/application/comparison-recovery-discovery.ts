import { Value } from '@sinclair/typebox/value';
import { randomUUID } from 'node:crypto';
import { ComparisonDiscoveryRecordSchema, ComparisonDraftAcceptedSchema, ComparisonFindingsUpdatedSchema, type ComparisonDraftBinding } from '../core/comparison-discovery-schema.js';
import type { EventEnvelope } from '../core/schema.js';
import { runOperationId, sha256 } from '../core/identity.js';
import type { ExperimentStore } from '../infrastructure/store/experiment-store.js';

export async function persistComparisonDraftAcceptance(store: ExperimentStore, runId: string, attemptId: string, binding: ComparisonDraftBinding): Promise<void> {
  await store.append({ type: 'comparison.draft_accepted', runId,
    operationId: runOperationId(runId, `comparison-draft-${randomUUID()}`),
    payload: { schemaVersion: 1, attemptId, ...binding } });
}

export async function recoveryFindingsBinding(input: {
  store: ExperimentStore; events: readonly EventEnvelope[]; attemptId: string; draftDigest: string; catalogRevision: number;
}): Promise<{ error?: string; previewAfterSequence?: number }> {
  const { events, store, attemptId, draftDigest, catalogRevision } = input;
  const belongs = (event: EventEnvelope) => typeof event.payload === 'object' && event.payload !== null &&
    'attemptId' in event.payload && event.payload.attemptId === attemptId;
  const latest = events.filter(event => event.type === 'comparison.findings_updated' && belongs(event)).at(-1);
  if (!latest) return {};
  if (!Value.Check(ComparisonFindingsUpdatedSchema, latest.payload) || !latest.runId) throw new Error('Invalid findings update audit.');
  const fact = latest.payload;
  const bytes = await store.readArtifact({ artifactId: fact.artifactId, experimentId: store.experimentId, runId: latest.runId });
  const record: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!Value.Check(ComparisonDiscoveryRecordSchema, record) || record.attemptId !== attemptId || record.revision !== fact.revision ||
    record.catalogRevision !== fact.catalogRevision || record.digest !== fact.digest || sha256(JSON.stringify(record.submission)) !== record.digest) {
    throw new Error('Findings artifact does not match its committed audit identity.');
  }
  if (record.catalogRevision !== catalogRevision) return { error: 'Findings are not bound to the current evidence catalog.' };
  if (record.submission.decisionQuestions.some(question => question.status === 'pending')) return { error: 'Latest findings still contain pending decision questions.' };
  const accepted = events.filter(event => event.type === 'comparison.draft_accepted' && belongs(event)).at(-1);
  if (!accepted || !Value.Check(ComparisonDraftAcceptedSchema, accepted.payload) || accepted.runId !== latest.runId ||
    accepted.sequence <= latest.sequence || accepted.payload.findingsRevision !== record.revision ||
    accepted.payload.draftDigest !== draftDigest || accepted.payload.catalogRevision !== catalogRevision) {
    return { error: 'Draft is not bound to the latest settled findings and evidence catalog.' };
  }
  return { previewAfterSequence: accepted.sequence };
}
