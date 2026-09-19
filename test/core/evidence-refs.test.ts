import test from 'node:test';
import assert from 'node:assert/strict';
import { unknownEvidenceRefMessage } from '../../src/core/evidence-refs.js';

test('unknownEvidenceRefMessage rejects refs outside the Host whitelist', () => {
  assert.equal(unknownEvidenceRefMessage(['event:keep'], new Set(['event:keep'])), undefined);
  assert.equal(unknownEvidenceRefMessage(['event:foreign'], new Set(['event:keep'])), 'unknown evidence reference: event:foreign');
  assert.equal(
    unknownEvidenceRefMessage(['event:a', 'event:b'], new Set(['event:keep'])),
    'unknown evidence reference: event:a, event:b',
  );
  assert.equal(unknownEvidenceRefMessage([], new Set(['event:keep'])), undefined);
});
