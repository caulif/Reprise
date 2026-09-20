import test from 'node:test';
import assert from 'node:assert/strict';
import { mockTui, shouldCompareAuditFrames } from '../../scripts/tui-audit-lib.js';
import { createFakeClock, syntheticFlowEvents } from './fixtures/synthetic-flow.js';

test('TUI frame byte-compare applies only on Windows', () => {
  assert.equal(shouldCompareAuditFrames('win32'), true);
  assert.equal(shouldCompareAuditFrames('linux'), false);
  assert.equal(shouldCompareAuditFrames('darwin'), false);
});

test('audit recorder seam stays on mockTui while synthetic flow supplies events', () => {
  const mocked = mockTui({ rows: 24, columns: 80 });
  assert.equal(typeof mocked.tui.requestRender, 'function');
  assert.equal(mocked.render(80), '');
  const clock = createFakeClock();
  clock.advance(60_000);
  const events = syntheticFlowEvents({
    clock: createFakeClock(),
    comparison: { status: 'cancelled' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
    multiLineLive: true,
    repeatedToolFailures: 2,
  });
  assert.equal(events[0]?.type, 'recovery.started');
  assert.equal(events.at(-1)?.type, 'comparison.completed');
  assert.equal((events.at(-1)?.payload as { status?: string }).status, 'cancelled');
});
