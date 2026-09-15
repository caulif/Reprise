import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperatorLocale } from '../../src/application/operator-locale.js';

test('parseOperatorLocale accepts aliases and rejects unknown strings', () => {
  assert.equal(parseOperatorLocale(undefined), undefined);
  assert.equal(parseOperatorLocale('en'), 'en');
  assert.equal(parseOperatorLocale('english'), 'en');
  assert.equal(parseOperatorLocale('zh'), 'zh');
  assert.equal(parseOperatorLocale('zh-cn'), 'zh');
  assert.equal(parseOperatorLocale('chinese'), 'zh');
  assert.equal(parseOperatorLocale('中文'), 'zh');
  assert.equal(parseOperatorLocale('foo'), undefined);
});
