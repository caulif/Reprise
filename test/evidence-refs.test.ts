import test from 'node:test';
import assert from 'node:assert/strict';
import { unknownEvidenceRefMessage } from '../src/core/evidence-refs.js';

test('unknownEvidenceRefMessage rejects refs outside the Host whitelist', () => {
  assert.equal(unknownEvidenceRefMessage(['event:keep'], new Set(['event:keep'])), undefined);
  assert.equal(unknownEvidenceRefMessage(['event:foreign'], new Set(['event:keep'])), 'unknown evidence reference');
  assert.equal(unknownEvidenceRefMessage([], new Set(['event:keep'])), undefined);
});
