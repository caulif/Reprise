import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { decodeStructured } from '../../src/infrastructure/agent/structured.js';

const schema = Type.Object({ status: Type.String(), boundary: Type.Object({ statement: Type.String() }) });
test('structured output preserves nested objects and braces inside strings', () => {
  const value = { status: 'ready', boundary: { statement: 'quoted { braces } and "escapes"' } };
  for (const text of [JSON.stringify(value), '```json\n' + JSON.stringify(value) + '\n```', 'Result: ' + JSON.stringify(value)]) {
    assert.deepEqual(decodeStructured(schema, text), { value });
  }
});
test('structured output selects the last complete top-level object', () => {
  const value = { status: 'ready', boundary: { statement: 'last' } };
  assert.deepEqual(decodeStructured(schema, '{"status":"draft","boundary":{"statement":"first"}}\n' + JSON.stringify(value)), { value });
});
