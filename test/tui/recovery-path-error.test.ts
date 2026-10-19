import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorErrorMessage } from '../../src/tui/format.js';
import { formatRecoveryFailureSummary, isHostExplanationKey } from '../../src/tui/i18n.js';

test('Git directory overflow explains how to change the data path without suggesting an unchanged retry', () => {
  const error = Object.assign(new Error("fatal: '$GIT_DIR' too big at private-source"), { code: 'git_path_too_long' });
  const text = operatorErrorMessage(error, 'zh');
  assert.match(text, /路径超限/);
  assert.match(text, /--data-dir/);
  assert.doesNotMatch(text, /private-source|intake/);
  assert.equal(isHostExplanationKey('errorGitSinkPathTooLong'), true);
  assert.equal(formatRecoveryFailureSummary('zh', 'preflight_failed', { explanationKey: 'errorGitSinkPathTooLong' }), text);
});
