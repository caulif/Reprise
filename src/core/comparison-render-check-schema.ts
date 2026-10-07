import { Type } from '@sinclair/typebox';
import { RenderGeometryQueriesSchema, RenderGeometrySampleSchema } from './schemas/render-geometry.js';

const Text = Type.String({ maxLength: 1200 });
const Identity = Type.String({ minLength: 1, maxLength: 128 });
const Time = Type.Number({ minimum: 0, maximum: 1e9 });
const CheckSchema = Type.Object({
  sourceRef: Identity, sourceHash: Identity,
  side: Type.Union(['baseline', 'candidate', 'host', 'derived'].map(value => Type.Literal(value))),
  status: Type.Union(['ok', 'motion_not_proven', 'no_browser', 'unsupported_format', 'capability_unavailable', 'cancelled', 'capture_failed', 'timeout', 'invalid_request'].map(value => Type.Literal(value))),
  requestedSampleTimesMs: Type.Array(Time, { maxItems: 8 }),
  viewport: Type.Object({ width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }), scale: Type.Number({ minimum: 1 }) }, { additionalProperties: false }),
  geometryQueries: Type.Optional(RenderGeometryQueriesSchema), geometryScope: Type.Optional(Text),
  frames: Type.Array(Type.Object({ sampleTimeMs: Time, actualTimeMs: Time, contentHash: Identity,
    geometrySample: Type.Optional(RenderGeometrySampleSchema), geometryUnavailable: Type.Optional(Text),
  }, { additionalProperties: false }), { maxItems: 8 }),
}, { additionalProperties: false });

export const ComparisonRenderMeasurementDocumentSchema = Type.Object({
  schemaVersion: Type.Literal(1), renderedCheck: CheckSchema, payload: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
