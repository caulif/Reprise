import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setCapabilities, resetCapabilitiesCache } from '@earendil-works/pi-tui';
import { fileLink } from '../../src/tui/format.js';
import { upgradeTerminalCapabilities } from '../../src/tui/terminal-capabilities.js';

test('fileLink uses OSC 8 only when capabilities allow it and strips controls', () => {
  const abs = process.platform === 'win32' ? 'C:\\data\\报告.html' : '/data/报告.html';
  try {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true });
    const linked = fileLink(`\u001b[31mopen\u001b]8;;evil\u0007`, abs);
    assert.equal(linked.includes('\u001b]8;;evil'), false);
    assert.match(linked, /\u001b]8;;/);
    assert.equal(linked.includes(pathToFileURL(abs).href), true);
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const plain = fileLink('open', abs);
    assert.equal(plain.includes('\u001b]8;;'), false);
    assert.equal(plain, 'open');
    assert.equal(plain.includes(abs), false);
  } finally {
    resetCapabilitiesCache();
  }
});

test('upgradeTerminalCapabilities enables OSC 8 fileLink for WT_PROFILE_ID hosts', () => {
  const abs = process.platform === 'win32' ? 'C:\\data\\报告.html' : '/data/报告.html';
  try {
    resetCapabilitiesCache();
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    assert.equal(fileLink('报告', abs).includes('\u001b]8;;'), false);
    upgradeTerminalCapabilities({ WT_PROFILE_ID: '{abc}' });
    const linked = fileLink('报告', abs);
    assert.match(linked, /\u001b]8;;/);
    assert.equal(linked.includes(pathToFileURL(abs).href), true);
    if (process.platform === 'win32') {
      assert.match(pathToFileURL(abs).href, /^file:\/\/\/C:/);
    }
  } finally {
    resetCapabilitiesCache();
  }
});
