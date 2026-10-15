import test from 'node:test';
import assert from 'node:assert/strict';
import { protocolPreviewRenderer } from '../support/protocol-preview-renderer.js';
import { DEFAULT_RENDER_VIEWPORT, type RenderRequest, type RenderResult } from '../../src/infrastructure/artifact-render-types.js';

const request = (): RenderRequest => ({ bundleRoot: 'fixture', entryRelativePath: 'preview.html', outputRoot: 'fixture/review',
  viewport: DEFAULT_RENDER_VIEWPORT, sampleTimesMs: [0], signal: new AbortController().signal });
const timeout: RenderResult = { ok: false, failure: { kind: 'timeout', message: 'timed out waiting for DevToolsActivePort' }, diagnostics: [] };
const success: RenderResult = { ok: true, frames: [], diagnostics: [], measured: { loadMs: 1, viewport: DEFAULT_RENDER_VIEWPORT, origin: 'fixture' } };

test('protocol preview retries a timeout once with the same request and records its diagnostics', async () => {
  const submitted: RenderRequest[] = [], diagnostics: string[] = [];
  const render = protocolPreviewRenderer(message => diagnostics.push(message), async value => {
    submitted.push(value); return submitted.length === 1 ? timeout : success;
  });
  const input = request();
  assert.equal(await render(input), success);
  assert.deepEqual(submitted, [input, input]);
  assert.ok(diagnostics[0]?.includes(JSON.stringify(timeout)));
});

test('a persistent timeout remains failure after exactly two attempts', async () => {
  let calls = 0;
  assert.equal(await protocolPreviewRenderer(() => {}, async () => { calls++; return timeout; })(request()), timeout);
  assert.equal(calls, 2);
});

for (const result of [success,
  { ok: false, failure: { kind: 'no_browser' }, diagnostics: [] },
  { ok: false, failure: { kind: 'cancelled' }, diagnostics: [] },
  { ok: false, failure: { kind: 'capture_failed', message: 'invalid frame' }, diagnostics: [] },
  { ...timeout, diagnostics: [{ code: 'profile_cleanup_failed', message: 'locked' }] },
  { ...timeout, diagnostics: [{ code: 'browser_kill_failed', message: 'still alive' }] },
] satisfies RenderResult[]) test(`protocol preview does not retry ${result.ok ? 'success' : `${result.failure.kind}/${result.diagnostics[0]?.code ?? 'clean'}`}`, async () => {
  let calls = 0;
  assert.equal(await protocolPreviewRenderer(() => {}, async () => { calls++; return result; })(request()), result);
  assert.equal(calls, 1);
});

test('cancellation before or during the initial preview never starts another render', async () => {
  for (const before of [true, false]) {
    let calls = 0;
    const abort = new AbortController();
    if (before) abort.abort();
    const render = protocolPreviewRenderer(() => {}, async () => { calls++; abort.abort(); return timeout; });
    await assert.rejects(render({ ...request(), signal: abort.signal }), { name: 'AbortError' });
    assert.equal(calls, before ? 0 : 1);
  }
});

test('renderer exceptions remain failures without a retry', async () => {
  let calls = 0;
  await assert.rejects(protocolPreviewRenderer(() => {}, async () => { calls++; throw new Error('renderer invariant'); })(request()), /renderer invariant/);
  assert.equal(calls, 1);
});
