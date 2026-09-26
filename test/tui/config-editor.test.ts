import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configForDraft,
  draftForConfig,
  readHarnessModelConfig,
  saveHarnessModelConfig,
  type HarnessConfigDraft,
} from '../../src/infrastructure/harness-model-config.js';
import { handleConfigInput, visibleConfigItems, type ConfigInputState } from '../../src/tui/config-input.js';
import { configHints, renderConfig } from '../../src/tui/pages/config.js';
import { createTheme } from '../../src/tui/theme.js';

const draft: HarnessConfigDraft = {
  kind: 'openai-compatible',
  providerId: 'openai-compatible',
  modelId: 'gpt-test',
  effort: 'medium',
  baseUrl: 'https://api.example.test/v1',
  keyRef: '',
  api: 'openai-completions',
  reasoning: false,
  supportsImage: false,
};

function refresh(next: HarnessConfigDraft) {
  return { draft: next, models: [] as const };
}

function editingState(overrides: Partial<ConfigInputState> = {}): ConfigInputState {
  return {
    draft,
    selected: visibleConfigItems(draft.kind).indexOf('API key'),
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

test('config editor masks the secret buffer within the settings form', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft, selected: visibleConfigItems(draft.kind).indexOf('API key'), editing: true, buffer: 'secret-value', cursor: 12, dirty: true, saved: false,
  }).join('\n');
  const caret = caretLine(text);
  assert.match(caret, /\*+▌/);
  assert.doesNotMatch(text, /secret-value/);
  assert.match(text, /provider type/);
  assert.doesNotMatch(caret, /required for OpenAI-compatible/);
  assert.doesNotMatch(text, /expected env:NAME/);
});

test('typing a secret keeps it in the editor buffer without showing the character', () => {
  const selected = visibleConfigItems(draft.kind).indexOf('API key');
  const result = handleConfigInput(editingState({ selected }), 'e', refresh);
  assert.equal(result?.state.buffer, 'e');
  const theme = createTheme(120);
  const caret = caretLine(renderConfig(theme, 120, {
    draft, selected, editing: true, buffer: result?.state.buffer ?? '', cursor: result?.state.cursor ?? 0, dirty: true, saved: false,
  }).join('\n'));
  assert.match(caret, /\*▌/);
  assert.doesNotMatch(caret, /e/);
});

test('applying a pasted secret writes it into the local draft', () => {
  const result = handleConfigInput(editingState({ selected: visibleConfigItems(draft.kind).indexOf('API key'), buffer: 'sk-abc' }), '\r', refresh);
  assert.equal(result?.state.editing, false);
  assert.equal(result?.state.draft.keyRef, 'sk-abc');
  assert.equal(result?.message, 'Draft changed, not saved yet.');
  const chinese = handleConfigInput(editingState({ selected: visibleConfigItems(draft.kind).indexOf('model'), buffer: 'model-zh', locale: 'zh' }), '\r', refresh);
  assert.equal(chinese?.message, '草稿已修改，尚未保存。');
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
    selected: visibleConfigItems(draft.kind).indexOf('API key'), editing: false, buffer: '', cursor: 0, providers: [], models: [],
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
  const catalog = { ...draft, kind: 'pi-catalog' as const, providerId: 'catalog', keyRef: '', supportsImage: false };
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft: catalog, selected: 0, editing: false, buffer: '', dirty: false, saved: false,
  }).join('\n');
  assert.doesNotMatch(text, /API key|base URL|image input|支持图片输入/);
  assert.match(text, /pi \/login/i);
});

test('Enter cycles API type and reasoning on an OpenAI-compatible draft', () => {
  const api = handleConfigInput({
    draft, selected: 4, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(api?.state.draft.api, 'openai-responses');
  const reasoning = handleConfigInput({
    draft, selected: visibleConfigItems(draft.kind, true).indexOf('reasoning'), advanced: true, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.equal(reasoning?.state.draft.reasoning, true);
});

test('Enter toggles image input and draft/config round-trip keeps it', async () => {
  const toggled = handleConfigInput({
    draft, selected: visibleConfigItems(draft.kind, true).indexOf('image input'), advanced: true, editing: false, buffer: '', cursor: 0, providers: [], models: [],
  }, '\r', refresh);
  assert.ok(toggled);
  assert.equal(toggled.state.draft.supportsImage, true);
  const config = configForDraft({ ...toggled.state.draft, keyRef: 'env:REPRISE_TEST_KEY' });
  assert.deepEqual(config.schemaVersion === 2 ? config.inputCapabilities : undefined, ['text', 'image']);
  assert.equal(draftForConfig(config).supportsImage, true);
  const root = await mkdtemp(join(tmpdir(), 'reprise-image-input-'));
  try {
    await saveHarnessModelConfig(root, config);
    const loaded = await readHarnessModelConfig(root);
    assert.ok(loaded);
    assert.deepEqual(loaded.schemaVersion === 2 ? loaded.inputCapabilities : undefined, ['text', 'image']);
    assert.equal(draftForConfig(loaded).supportsImage, true);
    const off = configForDraft({ ...draftForConfig(loaded), supportsImage: false });
    await saveHarnessModelConfig(root, off);
    const again = await readHarnessModelConfig(root);
    assert.equal(again && again.schemaVersion === 2 ? again.inputCapabilities : 'missing', undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  assert.equal(handleConfigInput(prompt?.state ?? dirty, '\r', refresh)?.action, undefined);
  assert.equal(handleConfigInput(prompt?.state ?? dirty, 'd', refresh)?.action, 'home');
  assert.equal(handleConfigInput({ ...dirty, leaveConfirm: true }, '\x13', refresh)?.action, 'save');
});

test('config page keeps draft, credentials, and connection test as separate lines', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft: { ...draft, keyRef: 'env:OPENAI_API_KEY' },
    selected: 0,
    editing: false,
    buffer: '',
    dirty: true,
    saved: true,
    envName: 'OPENAI_API_KEY',
    envSet: true,
    connectionTest: { status: 'passed' },
    locale: 'en',
  }).join('\n');
  assert.match(text, /Save status: unsaved draft/);
  assert.match(text, /Credentials: local reference available \(not a connection test\)/);
  assert.match(text, /Connection test: passed for this draft — not saved automatically/);
  assert.doesNotMatch(text, /Saved locally[\s\S]*Connection verified|verified[\s\S]*Saved locally/i);
  const hints = configHints(false, 'model', false, false, 'en', false, false);
  assert.deepEqual(hints.find((item) => item[0] === 'Ctrl+T'), ['Ctrl+T', 'Test connection (calls model)']);
});

test('invalid config fields retain an explicit error marker in draft and editor', () => {
  const theme = createTheme(120, false);
  const invalid = { ...draft, baseUrl: 'not-a-url' };
  const selected = visibleConfigItems(draft.kind).indexOf('base URL');
  const model = { draft: invalid, selected, editing: false, buffer: '', dirty: true, saved: false };
  assert.match(renderConfig(theme, 120, model).join('\n'), /✗ Invalid URL|✗ invalid URL|✗ 无效的 URL/i);
  assert.match(renderConfig(theme, 120, { ...model, editing: true, buffer: 'not-a-url' }).join('\n'), /✗ Invalid URL|✗ invalid URL|✗ 无效的 URL/i);
});

test('busy config disables repeated connection tests without starting another action', () => {
  const busy = { draft, selected: 0, editing: false, buffer: '', cursor: 0, providers: [], models: [], busy: true, locale: 'en' as const };
  const blocked = handleConfigInput(busy, '\x14', refresh);
  assert.equal(blocked?.action, undefined);
  assert.match(blocked?.message ?? '', /already in progress/i);
  const zh = handleConfigInput({ ...busy, locale: 'zh' }, '\x14', refresh);
  assert.match(zh?.message ?? '', /进行中/);
  const hints = configHints(false, 'model', false, false, 'zh', false, true);
  assert.deepEqual(hints.find((item) => item[0] === 'Ctrl+T'), ['Ctrl+T', '测试不可用（进行中）']);
});

test('credential gap keeps connection-test idle instead of failed', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft,
    selected: 0,
    editing: false,
    buffer: '',
    dirty: true,
    saved: false,
    connectionTest: { status: 'idle' },
    locale: 'en',
  }).join('\n');
  assert.match(text, /Credentials: missing or unset/);
  assert.match(text, /Connection test: not run for this draft/);
  assert.doesNotMatch(text, /Connection test: failed/);
});

test('testing paints a single connection-test line without a duplicate busy clone', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft,
    selected: 0,
    editing: false,
    buffer: '',
    dirty: false,
    saved: true,
    busy: true,
    connectionTest: { status: 'testing' },
    locale: 'en',
  }).join('\n');
  const matches = text.match(/Connection test: in progress/g) ?? [];
  assert.equal(matches.length, 1);
  assert.doesNotMatch(text, /Saving configuration locally/);
});

test('save busy adds a save note without claiming connection test progress', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft,
    selected: 0,
    editing: false,
    buffer: '',
    dirty: true,
    saved: true,
    busy: true,
    busyKind: 'save',
    connectionTest: { status: 'idle' },
    locale: 'en',
  }).join('\n');
  assert.match(text, /Saving configuration locally/);
  assert.match(text, /Connection test: not run for this draft/);
  assert.doesNotMatch(text, /Connection test: in progress/);
});

test('stale connection test copy does not claim the current draft is verified', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft,
    selected: 0,
    editing: false,
    buffer: '',
    dirty: true,
    saved: false,
    connectionTest: { status: 'stale' },
    locale: 'zh',
  }).join('\n');
  assert.match(text, /保存状态：未保存草稿/);
  assert.match(text, /连接测试：先前结果已过期/);
  assert.doesNotMatch(text, /当前草稿已通过/);
});

test('failed connection test shows a redacted detail without a single shared green light', () => {
  const theme = createTheme(120);
  const text = renderConfig(theme, 120, {
    draft,
    selected: 0,
    editing: false,
    buffer: '',
    dirty: false,
    saved: true,
    connectionTest: { status: 'failed', detail: 'provider rejected [secret redacted]' },
    locale: 'en',
  }).join('\n');
  assert.match(text, /Save status: saved locally/);
  assert.match(text, /Connection test: failed: provider rejected \[secret redacted\]/);
  assert.doesNotMatch(text, /not saved automatically/);
});

test('openConfig remembers inspection return target and leave restores it without recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-return-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  app.page = 'inspection';
  app.inspection = {
    sourcePath: 'C:/session.jsonl',
    transcript: [{ role: 'user', text: 'hello' }],
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  } as never;
  app.inspectionTaskInput = 2;
  app.inspectionShowOutcome = true;
  await app.openConfig();
  assert.equal(app.page, 'config');
  assert.deepEqual(app.configReturnTarget, {
    page: 'inspection',
    inspectionTaskInput: 2,
    inspectionShowOutcome: true,
  });
  app.leaveConfig();
  assert.equal(app.page, 'inspection');
  assert.equal(app.inspectionTaskInput, 2);
  assert.equal(app.inspectionShowOutcome, true);
  assert.equal(app.configReturnTarget, undefined);
  assert.match(app.message, /Review the session|核对会话/);
});

test('stale inspection return target falls back to sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-stale-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  app.page = 'inspection';
  app.inspection = { sourcePath: 'C:/session.jsonl', transcript: [], signals: { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 } } as never;
  await app.openConfig();
  app.inspection = undefined;
  app.leaveConfig();
  assert.equal(app.page, 'sessions');
  assert.match(app.message, /no longer available|已失效/);
});

test('draft changes while a connection test is pending keep the new draft unverified', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-race-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const piModels = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'fixture' }),
    completeSimple: async () => {
      await gate;
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    },
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const { saveHarnessModelConfig } = await import('../../src/infrastructure/harness-model-config.js');
  const dataDir = join(root, 'data');
  await saveHarnessModelConfig(dataDir, {
    schemaVersion: 2,
    provider: { kind: 'pi-catalog', id: 'provider-a' },
    providerId: 'provider-a',
    modelId: 'model-a',
    effort: 'medium',
  });
  const app = new IntakeTui({
    dataDir,
    tui,
    piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  await app.openConfig();
  const started = app.testConfigConnection();
  await waitUntil(() => app.configTestStatus === 'testing');
  assert.equal(app.configBusy, 'test');
  const testedVersion = app.configDraftVersion;
  // Mutate the draft the way the editor does: bump identity so a late success cannot verify it.
  app.configAdvanced = true;
  app.configSelected = visibleConfigItems('pi-catalog', true).indexOf('effort');
  app.configPageInput('\r');
  assert.notEqual(app.configDraftVersion, testedVersion);
  release();
  await started;
  assert.equal(app.configTestStatus, 'stale');
  assert.match(app.message, /previous draft|已变更前的草稿|Re-test|重新测试/);
  assert.doesNotMatch(app.message, /^Connection test passed/);
});

test('leave and reopen clears sticky busy so reconnect does not fake a connection test', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-sticky-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const piModels = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'fixture' }),
    completeSimple: async () => {
      await gate;
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    },
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const { saveHarnessModelConfig } = await import('../../src/infrastructure/harness-model-config.js');
  const { view } = await import('../../src/tui/controller-view.js');
  const { createTheme } = await import('../../src/tui/theme.js');
  const { renderConfig } = await import('../../src/tui/pages/config.js');
  const dataDir = join(root, 'data');
  await saveHarnessModelConfig(dataDir, {
    schemaVersion: 2,
    provider: { kind: 'pi-catalog', id: 'provider-a' },
    providerId: 'provider-a',
    modelId: 'model-a',
    effort: 'medium',
  });
  const app = new IntakeTui({
    dataDir,
    tui,
    piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  await app.openConfig();
  const started = app.testConfigConnection();
  await waitUntil(() => app.configBusy === 'test');
  app.leaveConfig();
  assert.equal(app.configBusy, 'idle');
  assert.equal(app.configTestStatus, 'idle');
  await waitUntil(() => app.page === 'home' && /background|后台/.test(app.message));
  await app.openConfig();
  assert.equal(app.configBusy, 'idle');
  assert.equal(app.configTestStatus, 'idle');
  const projected = view(app).config;
  assert.ok(projected);
  assert.equal(projected.busy, false);
  assert.equal(projected.busyKind, undefined);
  assert.equal(projected.connectionTest?.status, 'idle');
  const text = renderConfig(createTheme(120), 120, projected).join('\n');
  assert.match(text, /Connection test: not run for this draft|连接测试：当前草稿尚未测试/);
  assert.doesNotMatch(text, /Connection test: in progress|连接测试：进行中/);
  release();
  await started;
});

test('abandoned probe finally does not clear a newer in-flight connection test', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-busy-owner-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const gates: Array<() => void> = [];
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const piModels = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'fixture' }),
    completeSimple: async () => {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    },
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const { saveHarnessModelConfig } = await import('../../src/infrastructure/harness-model-config.js');
  const dataDir = join(root, 'data');
  await saveHarnessModelConfig(dataDir, {
    schemaVersion: 2,
    provider: { kind: 'pi-catalog', id: 'provider-a' },
    providerId: 'provider-a',
    modelId: 'model-a',
    effort: 'medium',
  });
  const app = new IntakeTui({
    dataDir,
    tui,
    piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  await app.openConfig();
  const first = app.testConfigConnection();
  await waitUntil(() => app.configBusy === 'test' && gates.length === 1);
  app.leaveConfig();
  await waitUntil(() => app.page === 'home');
  await app.openConfig();
  assert.equal(app.configBusy, 'idle');
  const second = app.testConfigConnection();
  await waitUntil(() => app.configBusy === 'test' && gates.length === 2);
  // Finish the abandoned first probe — must not drop the second request's busy gate.
  gates[0]!();
  await first;
  assert.equal(app.configBusy, 'test');
  assert.equal(app.configTestStatus, 'testing');
  // Second probe still owns the gate: another Ctrl+T must not start a third flight.
  assert.deepEqual(app.configPageInput('\x14'), { consume: true });
  assert.match(app.message, /already in progress|进行中/);
  assert.equal(gates.length, 2);
  gates[1]!();
  await second;
  assert.equal(app.configBusy, 'idle');
  assert.equal(app.configTestStatus, 'passed');
});

test('missing credentials refuse Ctrl+T without marking connection-test failed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-config-cred-gap-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const tui = {
    addChild() {},
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as never;
  const { IntakeTui } = await import('../../src/tui/intake-app.js');
  const { view } = await import('../../src/tui/controller-view.js');
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  await app.openConfig();
  // Force openai-compatible draft with empty key.
  app.configDraft = {
    kind: 'openai-compatible',
    providerId: 'openai-compatible',
    modelId: 'gpt-test',
    effort: 'medium',
    baseUrl: 'https://api.example.test/v1',
    keyRef: '',
    api: 'openai-completions',
    reasoning: false,
    supportsImage: false,
  };
  await app.testConfigConnection();
  assert.equal(app.configTestStatus, 'idle');
  assert.equal(app.configBusy, 'idle');
  assert.match(app.message, /API key|env:NAME|密钥/i);
  assert.equal(view(app).config?.connectionTest?.status, 'idle');
});

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
