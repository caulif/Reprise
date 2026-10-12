import { Type } from '@sinclair/typebox';
import { RenderBrowserActionsSchema, RenderBrowserMediaSchema } from './render-browser.js';
import { RenderGeometryQueriesSchema } from './render-geometry.js';

const Path = Type.String({ minLength: 1, maxLength: 1024 });
const Size = Type.Integer({ minimum: 1, maximum: 4096 });
export const CodingTrialInputHashesSchema = Type.Record(Type.String(), Type.String({ pattern: '^[a-f0-9]{64}$' }));
export const CodingTrialAuditSchema = Type.Object({
  type: Type.String(), sessionId: Type.String(), role: Type.String(), occurredAt: Type.String(), payload: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export const CodingTrialImageSchema = Type.Object({ path: Path }, { additionalProperties: false });
export const CodingTrialRenderSchema = Type.Object({
  path: Path,
  viewport: Type.Optional(Type.Object({ width: Type.Integer(), height: Type.Integer() }, { additionalProperties: false })),
  sampleTimesMs: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 10000 }), { minItems: 1, maxItems: 8 })),
  actions: Type.Optional(RenderBrowserActionsSchema), media: Type.Optional(RenderBrowserMediaSchema),
  geometryQueries: Type.Optional(RenderGeometryQueriesSchema),
  includeImages: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const CodingTrialTransformSchema = Type.Object({
  path: Path, crop: Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Size, height: Size }, { additionalProperties: false }),
  width: Size, height: Size,
}, { additionalProperties: false });
export const CodingTrialSummarySchema = Type.Object({
  schemaVersion: Type.Literal(1), status: Type.Union(['completed', 'failed', 'cancelled', 'yielded', 'incomplete'].map(value => Type.Literal(value))),
  model: Type.String(), elapsedMs: Type.Number(), inputUnchanged: Type.Boolean(),
  inputHashes: CodingTrialInputHashesSchema, reportHash: Type.Optional(Type.String()),
  failure: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
