import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSession } from '../../src/tui/config-session.js';
import { configForDraft, emptyHarnessConfigDraft, type HarnessConfigDraft } from '../../src/infrastructure/harness-model-config.js';
import { IntakeTui } from '../../src/tui/intake-tui.js';
import { mockTui } from '../../scripts/tui-audit-lib.js';

const draft: HarnessConfigDraft = { ...emptyHarnessConfigDraft(), kind: 'pi-catalog', providerId: 'fixture', modelId: 'one' };
const models = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }];
const input = { providers: [{ id: 'fixture', name: 'Fixture' }], models, savedConfig: configForDraft(draft), locale: 'en' as const };
const refresh = (next: HarnessConfigDraft) => ({ draft: next, models });

for (const outcome of ['passed', 'failed'] as const) test(`abandoned or foreign requests cannot replace the current ${outcome} result`, () => {
  const session = new ConfigSession();
  session.reset(draft);
  const abandoned = session.beginRequest('test')!;
  assert.equal(session.beginRequest('save'), undefined);
  session.reset(draft);
  const current = session.beginRequest('test')!;
  const other = new ConfigSession().beginRequest('test')!;
  for (const ticket of [abandoned, other]) {
    session.finishRequest(ticket);
    assert.equal(session.completeTest(ticket, 'passed', 'Old result'), 'ignored');
    assert.equal(session.state.busy, 'test');
    assert.equal(session.state.testStatus, 'testing');
  }
  session.finishRequest(current);
  assert.equal(session.completeTest(current, outcome, 'Current result'), outcome);
  assert.equal(session.state.busy, 'idle');
  assert.equal(session.state.testDetail, outcome === 'failed' ? 'Current result' : undefined);
  session.clearTest();
  assert.equal(session.state.testStatus, 'idle', 'saving is not a connection verification');
});

test('the existing editor invalidates a connection result only for a different draft identity', () => {
  const session = new ConfigSession();
  session.reset(draft);
  assert.equal(session.dirty(input.savedConfig), false);
  const ticket = session.beginRequest('test')!;
  const before = session.state;
  session.dispatch('\r', input, refresh);
  assert.equal(session.state.draft.modelId, 'two');
  assert.equal(before.draft.modelId, 'one');
  assert.equal(session.dirty(input.savedConfig), true);
  session.finishRequest(ticket);
  assert.equal(session.completeTest(ticket, 'passed', 'Previous draft passed'), 'stale');
  assert.equal(session.state.testDetail, undefined);
  session.reset(draft);
  assert.equal(session.dirty(input.savedConfig), false);
});

test('real home navigation resets the editor and invalidates its request while preserving navigation generation', () => {
  const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  app.modelConfig = input.savedConfig;
  app.hasSavedModelConfig = true;
  app.page = 'config';
  app.configSession.reset(draft);
  const ticket = app.configSession.beginRequest('test')!;
  app.configSession.dispatch('\r', input, refresh);
  const generation = app.generation;
  app.backToHome();
  assert.equal(app.generation, generation + 1);
  assert.equal(app.page, 'home');
  assert.equal(app.configSession.state.draft.modelId, 'one');
  assert.equal(app.configSession.state.busy, 'idle');
  assert.equal(app.configSession.state.testStatus, 'idle');
  assert.equal(app.configSession.state.buffer, '');
  assert.equal(app.configSession.completeTest(ticket, 'failed', 'Late result'), 'ignored');
});
