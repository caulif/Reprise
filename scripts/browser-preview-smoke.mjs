#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Version = Type.Object({ product: Type.String({ minLength: 1 }), protocolVersion: Type.String() }, { additionalProperties: true });
function checkVersion(version, executableVersion) {
  assert.ok(Value.Check(Version, version), 'invalid Browser.getVersion response');
  const binary = executableVersion.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  assert.ok(binary, 'browser executable returned no version');
  assert.equal(version.product.split('/')[1], binary, 'CDP browser must match the selected executable version');
}
if (process.argv.includes('--self-test')) {
  assert.throws(() => checkVersion({ product: 'Chrome/123.0.0.1', protocolVersion: '1.3' }, 'Google Chrome 123.0.0.2'), /selected executable version/);
  assert.throws(() => checkVersion({ failure: 'timeout' }, 'Google Chrome 123.0.0.1'), /invalid Browser.getVersion/);
  checkVersion({ product: 'Chrome/123.0.0.1', protocolVersion: '1.3' }, 'Google Chrome 123.0.0.1');
  console.log('browser-preview-smoke reverse checks: missing response and mismatched versions fail');
} else {
  const { openCdpBrowserSession } = await import('../dist/src/infrastructure/artifact-cdp.js');
  const started = Date.now(), browser = await openCdpBrowserSession(AbortSignal.timeout(20_000));
  if ('failure' in browser) throw Error(JSON.stringify({ status: 'failed', ...browser, elapsedMs: Date.now() - started }));
  try {
    const executable = browser.diagnostics.find(d => d.code === 'browser_executable')?.message;
    assert.ok(executable, 'actual browser launch must expose its executable');
    const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 5_000 });
    const version = await browser.send('Browser.getVersion');
    checkVersion(version, stdout);
    const target = await browser.send('Target.createTarget', { url: 'about:blank' });
    assert.ok(Value.Check(Type.Object({ targetId: Type.String({ minLength: 1 }) }), target), 'real CDP page target must be created');
    const { targetId } = target;
    await browser.send('Target.closeTarget', { targetId });
    console.log(JSON.stringify({ status: 'passed', resolvedExecutable: executable, executableVersion: stdout.trim(), cdpProduct: version.product, elapsedMs: Date.now() - started }));
  } finally {
    await browser.close();
  }
}
