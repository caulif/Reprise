import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ComparisonEvidenceProgressSchema } from '../../src/core/schema.js';

const receipt = { schemaVersion: 1, phase: 'review', sourceToolCallId: 'invocation:tool:1', tool: 'render_artifact',
  contentDigest: 'a'.repeat(64), byteLength: 100, semanticAssessment: 'not_certified' };

test('historical evidence checkpoint schema preserves actual receipt identity without semantic certification', () => {
  for (const phase of ['investigate', 'review']) assert.equal(Value.Check(ComparisonEvidenceProgressSchema, { ...receipt, phase }), true);
  for (const altered of [{ contentDigest: 'bad' }, { byteLength: -1 }, { semanticAssessment: 'verified' }, { sourceToolCallId: '' }, { phase: 'autonomous' }]) {
    assert.equal(Value.Check(ComparisonEvidenceProgressSchema, { ...receipt, ...altered }), false);
  }
});
