import { Value } from '@sinclair/typebox/value';
import { join } from 'node:path';
import { ComparisonRenderMeasurementDocumentSchema } from '../core/schema.js';
import { sha256, writeAtomic } from '../core/identity.js';
import type { ComparisonRenderedCheck, ComparisonRenderCatalogPort } from './comparison-render-tools.js';

export function comparisonToolTextBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(value) }]));
}

/** Byte-range read pages must not split a UTF-8 character. JSON escapes remain lossless when concatenated. */
export function serializeComparisonPagedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0080-\uffff]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Persist full measurements before replacing an oversized model-facing result. */
export async function boundedRenderOutput(input: { payload: Record<string, unknown>; check: ComparisonRenderedCheck;
  attemptRoot: string; catalog: ComparisonRenderCatalogPort; signal: AbortSignal }): Promise<Record<string, unknown>> {
  const complete = { ...input.payload, renderedCheck: input.check };
  if (comparisonToolTextBytes(complete) <= 10_240) return complete;
  const document = { schemaVersion: 1, renderedCheck: input.check, payload: input.payload };
  if (!Value.Check(ComparisonRenderMeasurementDocumentSchema, document)) throw new Error('Invalid persisted render measurement document.');
  const bytes = serializeComparisonPagedJson(document);
  const contentHash = sha256(bytes);
  const relativePath = `render-check-${contentHash.slice(0, 24)}.json`;
  input.signal.throwIfAborted();
  await writeAtomic(join(input.attemptRoot, 'scratch', relativePath), bytes);
  const registered = await input.catalog.registerAnalysisEvidence?.({ relativePath, sourceRef: input.check.sourceRef }, input.signal);
  const summary = {
    status: input.check.status, sourceRef: input.check.sourceRef, sourceHash: input.check.sourceHash,
    revision: input.catalog.revision(), viewport: input.check.viewport,
    ...(input.payload.media ? { media: input.payload.media } : {}),
    fullMeasurement: { path: `scratch/${relativePath}`, contentHash, byteLength: Buffer.byteLength(bytes),
      evidenceRef: registered?.shortRef, registration: registered?.shortRef ? 'registered' : 'unavailable',
      registrationCode: registered?.code ?? (registered ? undefined : 'port_unavailable'), registrationMessage: registered?.message,
      read: 'Use read with path, byte offset and maxBytes (for example 4096); continue at nextCursor. All original frames, local points, transforms, diagnostics and unknown statuses are preserved there.' },
    renderedCheck: { sourceRef: input.check.sourceRef, side: input.check.side, sourceHash: input.check.sourceHash,
      status: input.check.status, viewport: input.check.viewport, requestedSampleTimesMs: input.check.requestedSampleTimesMs,
      geometryScope: input.check.geometryScope, frames: input.check.frames.map(frame => ({
        sampleTimeMs: frame.sampleTimeMs, actualTimeMs: frame.actualTimeMs, contentHash: frame.contentHash,
        geometryUnavailable: frame.geometryUnavailable,
        geometryProjection: frame.geometrySample && { coordinateDomain: frame.geometrySample.coordinateDomain,
          startedAtMs: frame.geometrySample.startedAtMs, finishedAtMs: frame.geometrySample.finishedAtMs,
          observations: frame.geometrySample.observations.map(observation => ({ name: observation.name, selector: observation.selector,
            kind: observation.kind, status: observation.status,
            ...('screenPoints' in observation ? { screenPoints: observation.screenPoints } : {}),
          })),
        },
      })) },
    inlineGeometryFrames: input.check.frames.filter(frame => frame.geometrySample).length,
    omittedGeometryFrames: 0,
    projection: 'Compact screen-point measurements retain names, selectors, statuses and collection windows. Local points, matrices, bounds and diagnostics are in fullMeasurement. Omitted inline frames must be read before extending claims to those states; no measurement certifies a whole cycle or visual success.',
  };
  for (const frame of summary.renderedCheck.frames) {
    if (comparisonToolTextBytes(summary) <= 10_240) break;
    if (frame.geometryProjection) {
      frame.geometryProjection = undefined;
      summary.inlineGeometryFrames--;
      summary.omittedGeometryFrames++;
    }
  }
  if (comparisonToolTextBytes(summary) > 10_240) throw new Error('Render measurement inventory exceeds the bounded output budget.');
  return summary;
}
