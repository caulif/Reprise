import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { runBrowserActions } from '../../src/infrastructure/artifact-browser-actions.js';
import type { CdpSession } from '../../src/infrastructure/artifact-cdp.js';
import { RenderBrowserActionsSchema, RenderBrowserMediaSchema } from '../../src/core/schemas/render-browser.js';

const observation = { actionIndex: 0, matched: 1, text: 'Pause', tag: 'BUTTON', value: '', visible: true,
  disabled: false, checked: false, expanded: null, rect: { x: 10, y: 10, width: 80, height: 20 } };
function mockCdp(value: unknown = observation) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const cdp: CdpSession = { async send<T>(method: string, params?: Record<string, unknown>) {
    calls.push({ method, ...(params ? { params } : {}) });
    return (method === 'Runtime.evaluate' ? { result: { value } } : {}) as T;
  }, on: () => () => {}, close: async () => {}, diagnostics: [] };
  return { cdp, calls };
}

test('browser actions dispatch real mouse/keyboard/text events in order and inspect validated DOM data', async () => {
  const { cdp, calls } = mockCdp();
  const result = await runBrowserActions(cdp, 'page', [
    { kind: 'click', selector: '#toggle' }, { kind: 'key', key: 'Enter' },
    { kind: 'fill', selector: '#name', text: '中文' }, { kind: 'scroll', x: 0, y: 300 },
    { kind: 'wait', ms: 1 }, { kind: 'inspect', selector: '#toggle' },
  ], new AbortController().signal);
  assert.equal(result.length, 3);
  assert.deepEqual(calls.map(call => call.method), [
    'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Runtime.evaluate',
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Runtime.evaluate',
    'Input.insertText', 'Input.dispatchMouseEvent', 'Runtime.evaluate',
  ]);
  assert.equal(calls[1]?.params?.x, 50);
  assert.equal(calls[3]?.params?.windowsVirtualKeyCode, 13);
  assert.equal(calls[9]?.params?.text, '中文');
  assert.match(String(calls[0]?.params?.expression), /#toggle/);
});

test('ambiguous, missing, disabled and hidden click targets fail before dispatch; inspect remains useful', async () => {
  for (const patch of [{ matched: 2 }, { matched: 0 }, { disabled: true }, { visible: false }]) {
    const { cdp, calls } = mockCdp({ ...observation, ...patch });
    await assert.rejects(runBrowserActions(cdp, 'page', [{ kind: 'click', selector: 'button' }], new AbortController().signal), /one visible enabled/);
    assert.equal(calls.length, 1);
    const result = await runBrowserActions(cdp, 'page', [{ kind: 'inspect', selector: 'button' }], new AbortController().signal);
    assert.equal(result[0]?.matched, patch.matched ?? 1);
  }
  const { cdp } = mockCdp({ bad: 'untrusted result' });
  await assert.rejects(runBrowserActions(cdp, 'page', [{ kind: 'inspect', selector: 'body' }], new AbortController().signal), /Invalid browser observation/);
});

test('browser action waits and dispatch respect cancellation', async () => {
  const controller = new AbortController();
  const { cdp, calls } = mockCdp();
  const running = runBrowserActions(cdp, 'page', [{ kind: 'wait', ms: 10000 }, { kind: 'key', key: 'Enter' }], controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(running, /stop/);
  assert.equal(calls.length, 0);
  await assert.rejects(runBrowserActions(cdp, 'page', [{ kind: 'inspect', selector: 'body' }], controller.signal), /stop/);
});

test('browser schemas reject arbitrary script, URL, unsupported keys and invalid media values', () => {
  for (const action of [{ kind: 'evaluate', script: 'fetch(url)' }, { kind: 'navigate', url: 'file:///secret' },
    { kind: 'click', selector: 'body', script: 'bad' }, { kind: 'key', key: 'F12' }, { kind: 'wait', ms: -1 }]) {
    assert.equal(Value.Check(RenderBrowserActionsSchema, [action]), false);
  }
  assert.equal(Value.Check(RenderBrowserMediaSchema, { reducedMotion: 'reduce', colorScheme: 'dark' }), true);
  assert.equal(Value.Check(RenderBrowserMediaSchema, { reducedMotion: 'yes' }), false);
});
