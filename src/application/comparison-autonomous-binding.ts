import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ComparisonAutonomousContractSchema, type EventEnvelope } from '../core/schema.js';
import { ComparisonDraftAcceptanceReceiptSchema } from '../core/comparison-review-schema.js';
import { record } from '../core/json.js';
import { reconstructModelRequests } from '../infrastructure/agent/model-input.js';
import type { ExperimentStore } from '../infrastructure/store/experiment-store.js';
import { experimentModelInputResolver } from './experiment-helpers.js';

const PreviewSchema = Type.Object({ status: Type.Literal('ok'), draftDigest: Type.String(), revision: Type.Integer(), previewDigest: Type.String() });

export function autonomousComparisonRequested(events: readonly EventEnvelope[], attemptId: string): boolean {
  const request = events.filter(event => event.type === 'comparison.requested' && record(event.payload).attemptId === attemptId).at(-1);
  const payload = record(request?.payload);
  if (!('autonomousContractVersion' in payload)) return false;
  if (!Value.Check(ComparisonAutonomousContractSchema, { attemptId, autonomousContractVersion: payload.autonomousContractVersion })) {
    throw new Error('Invalid autonomous Comparison contract.');
  }
  if ('reviewInspectionContractVersion' in payload) throw new Error('Conflicting Comparison workflow contracts.');
  return true;
}

/** Integrity and actual preview delivery only; this does not certify the model's judgment. */
export async function autonomousComparisonBinding(input: {
  events: readonly EventEnvelope[]; attemptId: string; draftDigest: string; catalogRevision: number; reportFormat?: number;
  store: Pick<ExperimentStore, 'experimentId' | 'readArtifact'>;
}): Promise<string | undefined> {
  const events = input.events.filter(event => record(event.payload).attemptId === input.attemptId);
  const contract = events.filter(event => event.type === 'comparison.requested').at(-1);
  if (record(contract?.payload).autonomousContractVersion === 2 && input.reportFormat !== 3) return 'Autonomous contract 2 requires report format 3.';
  if (record(contract?.payload).autonomousContractVersion === 3 && input.reportFormat !== 4) return 'Autonomous contract 3 requires report format 4.';
  if (record(contract?.payload).autonomousContractVersion === 4 && input.reportFormat !== 5) return 'Autonomous contract 4 requires report format 5.';
  if (record(contract?.payload).autonomousContractVersion === 5 && input.reportFormat !== 6) return 'Autonomous contract 5 requires report format 6.';
  const accepted = events.filter(event => event.type === 'agent.tool_completed' && record(event.payload).tool === 'submit_report'
    && !('nativeHook' in record(event.payload)) && Value.Check(ComparisonDraftAcceptanceReceiptSchema, record(event.payload).details)).at(-1);
  const acceptance = record(accepted?.payload);
  if (!accepted || !Value.Check(ComparisonDraftAcceptanceReceiptSchema, acceptance.details)
    || acceptance.details.draftDigest !== input.draftDigest || acceptance.details.catalogRevision !== input.catalogRevision
    || typeof acceptance.sessionId !== 'string') return 'No accepted autonomous report for this draft and catalog.';
  const sessionId = acceptance.sessionId;
  const preview = events.filter(event => event.sequence > accepted.sequence && event.type === 'agent.tool_completed'
    && record(event.payload).sessionId === sessionId && record(event.payload).tool === 'preview_report'
    && !('nativeHook' in record(event.payload)) && Value.Check(PreviewSchema, record(event.payload).details)).at(-1);
  const previewReceipt = record(preview?.payload).details;
  if (!preview || !Value.Check(PreviewSchema, previewReceipt) || previewReceipt.draftDigest !== input.draftDigest
    || previewReceipt.revision !== input.catalogRevision) return 'No successful preview of the accepted autonomous report.';
  const sessionEvents = events.filter(event => record(event.payload).sessionId === sessionId);
  const terminal = sessionEvents.filter(event => event.type.startsWith('agent.invocation_')).at(-1);
  if (terminal?.type !== 'agent.invocation_completed' || terminal.sequence <= preview.sequence) return 'Autonomous session did not complete after preview.';
  const request = sessionEvents.filter(event => event.sequence > preview.sequence && event.sequence < terminal.sequence
    && event.type === 'agent.model_request' && record(event.payload).scope === 'generation').at(-1);
  if (!request) return 'No generation received the actual autonomous report preview.';
  const resolver = Object.assign(experimentModelInputResolver(input.store), {
    forRun: (runId: string | undefined) => experimentModelInputResolver(input.store, runId),
  });
  const replay = await reconstructModelRequests(sessionEvents.filter(event => event.sequence <= request.sequence), resolver);
  const actual = replay.requests.at(-1);
  if (replay.diagnostic || !actual?.contentComplete || actual.contextSource !== 'generation_snapshot'
    || actual.sessionId !== sessionId || actual.modelRequestDigest !== record(request.payload).digest) return 'Autonomous preview input audit is incomplete.';
  const delivered = actual.messages.some(message => {
    const value = record(message);
    if (value.role !== 'toolResult' || value.toolName !== 'preview_report' || !Array.isArray(value.content)) return false;
    return value.content.some(block => {
      const item = record(block);
      if (item.type !== 'text' || typeof item.text !== 'string') return false;
      try {
        const body: unknown = JSON.parse(item.text);
        return Value.Check(PreviewSchema, body) && body.draftDigest === previewReceipt.draftDigest
          && body.revision === previewReceipt.revision && body.previewDigest === previewReceipt.previewDigest;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Other text blocks are not preview receipts.
        return false;
      }
    });
  });
  return delivered ? undefined : 'Actual generation input does not contain the current autonomous preview receipt.';
}
