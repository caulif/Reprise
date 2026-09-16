import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCompareAuditFrames } from '../../scripts/tui-audit-lib.js';

test('TUI frame byte-compare applies only on Windows', () => {
  assert.equal(shouldCompareAuditFrames('win32'), true);
  assert.equal(shouldCompareAuditFrames('linux'), false);
  assert.equal(shouldCompareAuditFrames('darwin'), false);
});
