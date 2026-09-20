import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonPresentation, displayLiveCaption, displayOperatorDetail, displayOperatorTitle, displayTaskStatus, resultHeaderStatus, severityLabel, terminationTone } from '../../src/tui/display-copy.js';
import { createTheme, resolveColorModeForTest, resolveDensity, FORBIDDEN_COMPACT } from '../../src/tui/theme.js';

test('presentation labels stay localized and preserve semantic tones', () => {
  assert.equal(displayLiveCaption('working', 'ignored', 'zh'), '正在处理');
  assert.equal(displayOperatorTitle('阅读', 'en'), 'Reading evidence');
  assert.equal(displayOperatorDetail('不是 Git 仓库', 'en'), 'Not a Git repository');
  assert.equal(displayTaskStatus('apparently_completed', 'en'), 'Controller judged complete');
  assert.equal(terminationTone('failed'), 'danger');
  assert.equal(comparisonPresentation({ status: 'cancelled' }, 'zh').tone, 'warn');
  assert.equal(resultHeaderStatus({ record: { outcome: { termination: { kind: 'completed' } } }, comparison: { result: { status: 'cancelled' } } }, 'zh').tone, 'warn');
  assert.equal(severityLabel('error', 'en', createTheme(80, false)), 'error');
});

test('density and NO_COLOR remain deterministic', () => {
  assert.equal(resolveDensity(31), 'minimum');
  assert.equal(resolveDensity(78), 'regular');
  assert.equal(resolveColorModeForTest({ NO_COLOR: '1' }, true), 'off');
  const compact = createTheme(60, false);
  assert.doesNotMatch(Object.values(compact.glyphs).join(''), FORBIDDEN_COMPACT);
  assert.equal(compact.style.danger('x'), 'x');
});
