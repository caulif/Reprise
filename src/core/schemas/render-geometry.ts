import { Type, type Static } from '@sinclair/typebox';

const Coordinate = Type.Number({ minimum: -1e9, maximum: 1e9 });
const Point = Type.Object({ name: Type.String({ minLength: 1, maxLength: 32 }), x: Coordinate, y: Coordinate }, { additionalProperties: false });
const RenderGeometryQuerySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 32 }),
  selector: Type.String({ minLength: 1, maxLength: 160, description: 'CSS selector matching exactly one actual element. Identify the compared part from its source attributes; do not substitute its body, container or intended target. Missing/ambiguous selectors supply no measurement.' }),
  kind: Type.Union([Type.Literal('svg_geometry'), Type.Literal('dom_rect')], { description: 'svg_geometry supports circle/ellipse centers and line/path endpoints only. For rect, group or other element bounds use dom_rect. All successful coordinates are actual viewport CSS pixels; unsupported is not evidence of absence or contact.' }),
}, { additionalProperties: false });
export const RenderGeometryQueriesSchema = Type.Array(RenderGeometryQuerySchema, { minItems: 1, maxItems: 8 });
export type RenderGeometryQuery = Static<typeof RenderGeometryQuerySchema>;

const Identity = {
  ...RenderGeometryQuerySchema.properties,
  tagName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  elementId: Type.Optional(Type.String({ maxLength: 64 })), parentId: Type.Optional(Type.String({ maxLength: 64 })),
};
const Bounds = Type.Object({ x: Coordinate, y: Coordinate, width: Type.Number({ minimum: 0, maximum: 1e9 }), height: Type.Number({ minimum: 0, maximum: 1e9 }) }, { additionalProperties: false });
const Points = Type.Array(Point, { minItems: 1, maxItems: 4 });
const Observation = Type.Union([
  Type.Object({ ...Identity, kind: Type.Literal('svg_geometry'), status: Type.Literal('ok'), bounds: Bounds,
    localPoints: Points, screenPoints: Points,
    matrix: Type.Object({ a: Coordinate, b: Coordinate, c: Coordinate, d: Coordinate, e: Coordinate, f: Coordinate }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({ ...Identity, kind: Type.Literal('dom_rect'), status: Type.Literal('ok'), bounds: Bounds, screenPoints: Points }, { additionalProperties: false }),
  Type.Object({ ...Identity, status: Type.Union((['missing', 'ambiguous', 'invalid_selector', 'unsupported', 'unavailable'] as const).map(value => Type.Literal(value))) }, { additionalProperties: false }),
]);
export const RenderGeometrySampleSchema = Type.Object({
  schemaVersion: Type.Literal(1), coordinateDomain: Type.Literal('viewport_css_pixels'),
  startedAtMs: Type.Number({ minimum: 0, maximum: 1e9 }), finishedAtMs: Type.Number({ minimum: 0, maximum: 1e9 }),
  observations: Type.Array(Observation, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });
export type RenderGeometrySample = Static<typeof RenderGeometrySampleSchema>;
export const RENDER_GEOMETRY_MAX_SAMPLE_BYTES = 16_384;
