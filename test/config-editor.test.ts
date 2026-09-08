import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessConfigDraft } from '../src/infrastructure/harness-model-config.js';
import { handleConfigInput, type ConfigInputState } from '../src/tui/config-input.js';
import { renderConfig } from '../src/tui/pages/config.js';
import { createTheme } from '../src/tui/theme.js';

const draft: HarnessConfigDraft = {
  kind: 'openai-compatible',
  providerId: 'openai-compatible',
  modelId: 'gpt-test',
  effort: 'medium',
  baseUrl: 'https://api.example.test/v1',
  keyRef: '',
  api: 'openai-completions',
  reasoning: false,
};

function refresh(next: HarnessConfigDraft) {
  return { draft: next, models: [] as const };
}

function editingState(overrides: Partial<ConfigInputState> = {}): ConfigInputState {
  return {
    draft,
    selected: 7,
    editing: true,
    buffer: '',
    cursor: 0,
    providers: [],
    models: [],
    ...overrides,
  };
}

function caretLine(text: string): string {
  return text.split('\n').find((line) => line.includes('▌')) ?? '';
}

test('config editor paints the raw buffer instead of keyRef validity copy', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft, selected: 7, editing: true, buffer: 'e', cursor: 1, dirty: true, saved: false,
  }).join('\n');
  const caret = caretLine(text);
  assert.match(caret, /e/);
  assert.doesNotMatch(caret, /required for OpenAI-compatible/);
  assert.doesNotMatch(text, /expected env:NAME/);
});

test('typing e keeps the letter visible in the editor buffer', () => {
  const result = handleConfigInput(editingState(), 'e', refresh);
  assert.equal(result?.state.buffer, 'e');
  const theme = createTheme(120);
  const caret = caretLine(renderConfig(theme, 120, {
    draft, selected: 7, editing: true, buffer: result?.state.buffer ?? '', cursor: result?.state.cursor ?? 0, dirty: true, saved: false,
  }).join('\n'));
  assert.match(caret, /e/);
});

test('applying a pasted secret writes it into the local draft', () => {
  const result = handleConfigInput(editingState({ buffer: 'sk-abc' }), '\r', refresh);
  assert.equal(result?.state.editing, false);
  assert.equal(result?.state.draft.keyRef, 'sk-abc');
  assert.match(result?.message ?? '', /local config file/);
});

test('switching provider with an existing URL requires a second Enter', () => {
  const filled = {
    ...draft,
    baseUrl: 'https://api.example.test/v1',
    keyRef: 'env:OPENAI_API_KEY',
  };
  const first = handleConfigInput({
    draft: filled, selected: 0, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(first?.state.pendingToggle, true);
  assert.equal(first?.state.draft.baseUrl, filled.baseUrl);
  assert.equal(first?.state.draft.keyRef, filled.keyRef);
  assert.ok(first);
  const second = handleConfigInput(first.state, '\r', refresh);
  assert.equal(second?.state.pendingToggle, false);
  assert.equal(second?.state.draft.kind, 'pi-catalog');
  assert.equal(second?.state.draft.baseUrl, '');
  assert.equal(second?.state.draft.keyRef, '');
});

test('opening a text field prefills the current value', () => {
  const result = handleConfigInput({
    draft: { ...draft, keyRef: 'env:OPENAI_API_KEY' },
    selected: 7, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(result?.state.editing, true);
  assert.equal(result?.state.buffer, 'env:OPENAI_API_KEY');
});


test('config editor supports cursor movement, insertion, and delete', () => {
  const initial = editingState({ buffer: 'ac', cursor: 1 });
  const inserted = handleConfigInput(initial, 'b', refresh);
  assert.deepEqual({ buffer: inserted?.state.buffer, cursor: inserted?.state.cursor }, { buffer: 'abc', cursor: 2 });
  const moved = handleConfigInput(inserted?.state ?? initial, '\x1b[H', refresh);
  const deleted = handleConfigInput(moved?.state ?? initial, '\x1b[3~', refresh);
  assert.deepEqual({ buffer: deleted?.state.buffer, cursor: deleted?.state.cursor }, { buffer: 'bc', cursor: 0 });
});

test('Pi catalog hides the API key and asks the operator to log in with Pi', () => {
  const catalog = { ...draft, kind: 'pi-catalog' as const, providerId: 'catalog', keyRef: '' };
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft: catalog, selected: 0, editing: false, buffer: '', dirty: false, saved: false,
  }).join('\n');
  assert.doesNotMatch(text, /API key|base URL/);
  assert.match(text, /pi \/login/i);
});

test('Enter cycles API type and reasoning on an OpenAI-compatible draft', () => {
  const api = handleConfigInput({
    draft, selected: 4, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(api?.state.draft.api, 'openai-responses');
  const reasoning = handleConfigInput({
    draft, selected: 5, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(reasoning?.state.draft.reasoning, true);
});

test('config save and test use control chords, not letters', () => {
  const idle = { draft, selected: 0, editing: false, buffer: '', cursor: 0, providers: [], models: [] };
  assert.equal(handleConfigInput(idle, 's', refresh), undefined);
  assert.equal(handleConfigInput(idle, '\x13', refresh)?.action, 'save');
  assert.equal(handleConfigInput(idle, '\x14', refresh)?.action, 'test');
});

test('leaving config with a dirty draft asks to save or discard', () => {
  const dirty = { draft, selected: 0, editing: false, buffer: '', cursor: 0, providers: [], models: [], dirty: true };
  const prompt = handleConfigInput(dirty, '\x1b', refresh);
  assert.equal(prompt?.state.leaveConfirm, true);
  assert.equal(prompt?.action, undefined);
  assert.equal(handleConfigInput(prompt?.state ?? dirty, '\r', refresh)?.action, 'home');
  assert.equal(handleConfigInput({ ...dirty, leaveConfirm: true }, '\x13', refresh)?.action, 'save');
});
