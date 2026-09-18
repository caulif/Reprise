import test from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { shouldEnableHyperlinks, upgradeTerminalCapabilities } from '../../src/tui/terminal-capabilities.js';

test('shouldEnableHyperlinks recognizes WT_PROFILE_ID without WT_SESSION', () => {
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}' }), true);
  assert.equal(shouldEnableHyperlinks({ WT_SESSION: 'sess' }), true);
  // Residual gap: neither SESSION nor PROFILE — stays false (no safe TERM heuristic).
  assert.equal(shouldEnableHyperlinks({}), false);
  assert.equal(shouldEnableHyperlinks({ TERM: 'xterm-256color' }), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TERM: 'screen-256color' }), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TMUX: '/tmp/tmux-0/default,123,0' }), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TERM: 'tmux-256color' }), false);
});

test('upgradeTerminalCapabilities turns hyperlinks on once for WT_PROFILE_ID', () => {
  try {
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const next = upgradeTerminalCapabilities({ WT_PROFILE_ID: '{abc}' });
    assert.equal(next.hyperlinks, true);
    assert.equal(getCapabilities().hyperlinks, true);
  } finally {
    resetCapabilitiesCache();
  }
});

test('upgradeTerminalCapabilities is a no-op under screen even with WT_PROFILE_ID', () => {
  try {
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const next = upgradeTerminalCapabilities({ WT_PROFILE_ID: '{abc}', TERM: 'screen' });
    assert.equal(next.hyperlinks, false);
    assert.equal(getCapabilities().hyperlinks, false);
  } finally {
    resetCapabilitiesCache();
  }
});
