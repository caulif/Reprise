import test from 'node:test';
import assert from 'node:assert/strict';
import { isFsAbsolute, isNativeHostPath, isWslHost, pathContainedBy, relativeInside, sameFsPath, stripWindowsExtendedPrefix } from '../../src/core/paths.js';

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
  assert.equal(sameFsPath(String.raw`C:\source\app`, 'C:/source/app'), true);
  assert.equal(sameFsPath('C:/work/app', 'C:/work/app2'), false);
  assert.equal(sameFsPath(String.raw`\\?\C:\source\app`, 'C:/source/app'), true);
  assert.equal(sameFsPath(String.raw`\\?\UNC\server\share\a`, String.raw`\\server\share\a`), true);
});

test('relativeInside keeps POSIX separators and rejects escapes', () => {
  assert.equal(relativeInside(String.raw`C:\obsidian\papers`, String.raw`C:\obsidian\papers\kimi-k3\README.md`), 'kimi-k3/README.md');
  assert.equal(relativeInside('C:/source', 'C:/other/file.txt'), undefined);
  assert.equal(stripWindowsExtendedPrefix(String.raw`\\?\C:\Users\demo\.codex\sessions\a.jsonl`), 'C:/Users/demo/.codex/sessions/a.jsonl');
});

test('WSL host rejects Windows drive and /mnt drive mounts', () => {
  const wsl = { WSL_DISTRO_NAME: 'Ubuntu' };
  assert.equal(isWslHost('linux', wsl), true);
  assert.equal(isWslHost('linux', {}), false);
  assert.equal(isNativeHostPath('/usr/bin/codex', 'linux', wsl), true);
  assert.equal(isNativeHostPath('/mnt/c/Users/x/codex.cmd', 'linux', wsl), false);
  assert.equal(isNativeHostPath(String.raw`C:\Users\x\codex.cmd`, 'linux', wsl), false);
  assert.equal(isNativeHostPath(String.raw`C:\Users\x\codex.cmd`, 'win32', {}), true);
  assert.equal(isNativeHostPath('/usr/bin/codex', 'darwin', {}), true);
});
