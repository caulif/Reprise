import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { RenderGeometryQueriesSchema, RenderGeometrySampleSchema } from '../../src/core/schemas/render-geometry.js';

const query = { name: 'pedal', selector: '#crankFar line', kind: 'svg_geometry' };
const bounds = { x: 10, y: 20, width: 36, height: 1 };
const point = { name: 'end', x: 46, y: 20 };
const svg = {
  ...query, status: 'ok', bounds,
  localPoints: [point], screenPoints: [point],
  matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
};
const dom = { name: 'button', selector: '#toggle', kind: 'dom_rect', status: 'ok', bounds, screenPoints: [point] };
const sample = (observation: unknown = svg) => ({
  schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: 500, finishedAtMs: 501,
  observations: [observation],
});

test('geometry queries accept bounded selectors and reject expression extensions and oversized requests', () => {
  assert.equal(Value.Check(RenderGeometryQueriesSchema, [query]), true);
  assert.equal(Value.Check(RenderGeometryQueriesSchema, Array.from({ length: 8 }, () => query)), true);
  const invalid: readonly [string, unknown][] = [
    ['expression', [{ ...query, expression: 'document.cookie' }]],
    ['script', [{ ...query, script: 'return document.body' }]],
    ['empty batch', []],
    ['nine queries', Array.from({ length: 9 }, () => query)],
    ['long selector', [{ ...query, selector: 'a'.repeat(161) }]],
    ['long name', [{ ...query, name: 'a'.repeat(33) }]],
    ['empty selector', [{ ...query, selector: '' }]],
    ['unknown kind', [{ ...query, kind: 'javascript' }]],
  ];
  for (const [label, value] of invalid) assert.equal(Value.Check(RenderGeometryQueriesSchema, value), false, label);
});

test('SVG and DOM success samples require their measured geometry rather than a bare success status', () => {
  assert.equal(Value.Check(RenderGeometrySampleSchema, sample()), true);
  assert.equal(Value.Check(RenderGeometrySampleSchema, sample(dom)), true);
  const { matrix: _matrix, ...noMatrix } = svg;
  const { localPoints: _local, ...noLocal } = svg;
  const { screenPoints: _screen, ...noScreen } = svg;
  const { bounds: _bounds, ...noBounds } = dom;
  const invalid = [noMatrix, noLocal, noScreen, noBounds,
    { ...svg, localPoints: [] }, { ...svg, screenPoints: [] }, { ...dom, screenPoints: [] },
    { ...svg, localPoints: Array.from({ length: 5 }, () => point) },
    { ...svg, screenPoints: Array.from({ length: 5 }, () => point) },
  ];
  for (const value of invalid) assert.equal(Value.Check(RenderGeometrySampleSchema, sample(value)), false);
});

test('nonfinite and overflowing geometry cannot cross the serialized observation boundary', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e9 + 1, -1e9 - 1]) {
    for (const field of ['x', 'y'] as const) {
      assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, bounds: { ...bounds, [field]: value } })), false);
      assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, localPoints: [{ ...point, [field]: value }] })), false);
      assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, screenPoints: [{ ...point, [field]: value }] })), false);
    }
    for (const field of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, matrix: { ...svg.matrix, [field]: value } })), false);
    }
  }
  for (const value of [-1, NaN, Infinity, 1e9 + 1]) {
    for (const field of ['width', 'height'] as const) {
      assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, bounds: { ...bounds, [field]: value } })), false);
    }
  }
});

test('sample domain, timestamps, observation counts and identity metadata are bounded', () => {
  for (const value of [
    { ...sample(), coordinateDomain: 'svg_user_units' }, { ...sample(), schemaVersion: 2 },
    { ...sample(), observations: [] }, { ...sample(), observations: Array.from({ length: 9 }, () => svg) },
    sample({ ...svg, tagName: 'x'.repeat(65) }), sample({ ...svg, elementId: 'x'.repeat(65) }),
    sample({ ...svg, parentId: 'x'.repeat(65) }),
  ]) assert.equal(Value.Check(RenderGeometrySampleSchema, value), false);
  for (const value of [-1, NaN, Infinity, 1e9 + 1]) {
    for (const field of ['startedAtMs', 'finishedAtMs'] as const) {
      assert.equal(Value.Check(RenderGeometrySampleSchema, { ...sample(), [field]: value }), false);
    }
  }
});

test('non-success statuses remain explicit and cannot smuggle success geometry', () => {
  for (const status of ['missing', 'ambiguous', 'invalid_selector', 'unsupported', 'unavailable']) {
    assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...query, status })), true, status);
    assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...svg, status })), false, status);
  }
  for (const status of ['success', 'error', 'seen', '', null]) {
    assert.equal(Value.Check(RenderGeometrySampleSchema, sample({ ...query, status })), false);
  }
});

test('unknown fields are rejected at every nested geometry boundary', () => {
  for (const value of [
    { ...sample(), extra: true }, sample({ ...svg, extra: true }),
    sample({ ...dom, matrix: svg.matrix }), sample({ ...svg, bounds: { ...bounds, extra: true } }),
    sample({ ...svg, matrix: { ...svg.matrix, extra: true } }),
    sample({ ...svg, localPoints: [{ ...point, expression: '1+1' }] }),
    sample({ ...svg, screenPoints: [{ ...point, extra: true }] }),
    sample({ ...query, status: 'missing', extra: true }),
  ]) assert.equal(Value.Check(RenderGeometrySampleSchema, value), false);
});
