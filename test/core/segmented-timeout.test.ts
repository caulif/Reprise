import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { segmentedTimeout } from '../../src/infrastructure/segmented-timeout.js';

test('long deadlines wait through multiple Node timer segments', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const maximum = 2 ** 31 - 1;
  let fired = 0;
  segmentedTimeout(() => { fired++; }, maximum * 2 + 100);
  t.mock.timers.tick(maximum);
  assert.equal(fired, 0);
  t.mock.timers.tick(maximum);
  assert.equal(fired, 0);
  t.mock.timers.tick(99);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});

test('MAX_SAFE_INTEGER does not expire immediately and cancellation clears a rearmed timer', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let fired = false;
  const cancel = segmentedTimeout(() => { fired = true; }, Number.MAX_SAFE_INTEGER);
  t.mock.timers.tick(1);
  assert.equal(fired, false);
  t.mock.timers.tick(2 ** 31 - 1);
  assert.equal(fired, false);
  cancel();
  t.mock.timers.tick(Number.MAX_SAFE_INTEGER);
  assert.equal(fired, false);
});

test('short deadlines and cancellation preserve normal timeout behavior', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let fired = 0;
  const cancel = segmentedTimeout(() => { fired++; }, 10);
  segmentedTimeout(() => { fired++; }, 20);
  t.mock.timers.tick(9);
  assert.equal(fired, 0);
  cancel();
  t.mock.timers.tick(10);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});


test('Agent Session accepts MAX_SAFE_INTEGER timeout without immediately aborting', async () => {
  const host = new AgentHost({ createSession: () => ({
    append: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'completed';
    },
    cancel() {},
  }) });
  const session = await host.createSession({ role: 'comparison', systemPrompt: 'test' });
  try {
    const result = await session.work({ promptContent: 'Continue', timeoutMs: Number.MAX_SAFE_INTEGER });
    assert.equal(result.status, 'completed');
  } finally {
    await session.close();
  }
});
