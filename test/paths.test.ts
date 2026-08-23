import test from 'node:test';
import assert from 'node:assert/strict';
import { isFsAbsolute, pathContainedBy, relativeInside } from '../src/core/paths.js';

test('Windows drive paths stay absolute on any host', () => {
  assert.equal(isFsAbsolute('C:/source'), true);
  assert.equal(isFsAbsolute(String.raw`C:\source`), true);
  assert.equal(isFsAbsolute('notes/index.md'), false);
  assert.equal(isFsAbsolute('/tmp/abs'), true);
});

test('Windows recorded cwd is not treated as under the POSIX process cwd', () => {
  assert.equal(pathContainedBy(process.cwd(), 'C:/source'), false);
  assert.equal(pathContainedBy('C:/source', 'C:/source'), true);
  assert.equal(pathContainedBy(String.raw`C:\source`, 'C:/source/app'), true);
  assert.equal(pathContainedBy('C:/work/app', 'C:/work/app2'), false);
  assert.equal(pathContainedBy('C:/source', String.raw`C:\Windows\System32\evil.dll`), false);
});

test('relativeInside keeps POSIX separators and rejects escapes', () => {
  assert.equal(relativeInside(String.raw`C:\obsidian\papers`, String.raw`C:\obsidian\papers\kimi-k3\README.md`), 'kimi-k3/README.md');
  assert.equal(relativeInside('C:/source', 'C:/other/file.txt'), undefined);
});
