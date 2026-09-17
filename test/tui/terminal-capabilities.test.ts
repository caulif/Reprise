import test from 'node:test';
import assert from 'node:assert/strict';
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { shouldEnableHyperlinks, upgradeTerminalCapabilities } from '../../src/tui/terminal-capabilities.js';

test('shouldEnableHyperlinks recognizes WT_PROFILE_ID without WT_SESSION', () => {
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}' }, 'win32'), true);
  assert.equal(shouldEnableHyperlinks({ WT_SESSION: 'sess' }, 'win32'), true);
  assert.equal(shouldEnableHyperlinks({}, 'win32'), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TERM: 'screen-256color' }, 'win32'), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TMUX: '/tmp/tmux-0/default,123,0' }, 'linux'), false);
  assert.equal(shouldEnableHyperlinks({ WT_PROFILE_ID: '{abc}', TERM: 'tmux-256color' }, 'linux'), false);
});

test('upgradeTerminalCapabilities turns hyperlinks on once for WT_PROFILE_ID', () => {
  try {
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const next = upgradeTerminalCapabilities({ WT_PROFILE_ID: '{abc}' }, 'win32');
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
    const next = upgradeTerminalCapabilities({ WT_PROFILE_ID: '{abc}', TERM: 'screen' }, 'win32');
    assert.equal(next.hyperlinks, false);
    assert.equal(getCapabilities().hyperlinks, false);
  } finally {
    resetCapabilitiesCache();
  }
});
