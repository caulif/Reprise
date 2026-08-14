import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextEdit, caretAt } from '../src/tui/text-edit.js';

test('plain text editor inserts and deletes at terminal cursor positions', () => {
  let state = applyTextEdit('ac', 1, 'b');
  assert.deepEqual(state, { value: 'abc', cursor: 2, handled: true });
  state = applyTextEdit(state.value, state.cursor, '\x1b[D');
  assert.deepEqual(state, { value: 'abc', cursor: 1, handled: true });
  state = applyTextEdit(state.value, state.cursor, '\x7f');
  assert.deepEqual(state, { value: 'bc', cursor: 0, handled: true });
  state = applyTextEdit(state.value, state.cursor, '\x1b[F');
  assert.deepEqual(state, { value: 'bc', cursor: 2, handled: true });
  assert.equal(caretAt(state.value, 1), 'b▌c');
});
