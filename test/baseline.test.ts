import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedNodeVersion, main } from '../src/cli/main.js';

test('accepts the supported minimum Node.js version', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.19.0'));
  assert.throws(() => assertSupportedNodeVersion('22.18.9'), /requires Node\.js >= 22\.19\.0/);
});

test('CLI help is side-effect free and documents the TUI entrypoint', () => {
  const output: string[] = [];
  const exitCode = main(['--help'], {
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(`stderr:${message}`),
  });

  assert.equal(exitCode, 0);
  assert.match(output.join('\n'), /Usage:/);
  assert.match(output.join('\n'), /--sessions-dir/);
  assert.doesNotMatch(output.join('\n'), /smoke-record/);
  assert.doesNotMatch(output.join('\n'), /stderr:/);
});
