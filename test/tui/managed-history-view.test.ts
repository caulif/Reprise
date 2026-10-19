import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInspection } from '../../src/products/contract.js';
import { inspectionHints, inspectionMaxScroll, renderInspection } from '../../src/tui/pages/intake.js';
import { createTheme } from '../../src/tui/theme.js';
import { handleControllerInput, type ControllerHandle } from '../../src/tui/controller-input.js';

const inspection: SessionInspection = {
  productId: 'claude-code', sessionId: 'native-session', sourcePath: 'C:/data/managed-session.jsonl', cwd: 'C:/replica',
  projectKey: 'reprise-managed:claude-code',
  managed: { experimentId: 'experiment-one', runId: 'run-one', role: 'candidate', origin: 'reprise', status: 'archived' },
  signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  transcript: [
    { id: 'u1', role: 'user', text: 'Read this candidate history.' },
    { id: 'a1', role: 'assistant', text: 'The candidate response is preserved.' },
    { id: 't1', role: 'tool', text: 'The tool evidence is preserved.' },
  ],
};

test('managed inspection renders the transcript as read-only even without replay-eligible user input', () => {
  const theme = createTheme(120, false);
  for (const locale of ['en', 'zh'] as const) {
    const model = { inspection, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false, locale };
    const rendered = renderInspection(theme, 120, model).join('\n');
    assert.match(rendered, /experiment-one \/ run-one/);
    assert.match(rendered, /candidate response is preserved/);
    assert.match(rendered, /tool evidence is preserved/);
    assert.match(rendered, locale === 'zh' ? /只读历史/ : /Read-only candidate history/);
    assert.equal(inspectionHints(locale, true).some(([key]) => key === 'Enter'), false);
    assert.ok(inspectionMaxScroll(theme, 120, model, 5) > 0);
    const noUser = { ...model, inspection: { ...inspection, transcript: inspection.transcript.filter(item => item.role !== 'user') } };
    assert.match(renderInspection(theme, 120, noUser).join('\n'), /candidate response is preserved/);
  }
});

test('Enter in a managed inspection cannot initiate freeze or change the current page', () => {
  let rendered = 0;
  const controller = {
    page: 'inspection', locale: 'en', inspection, message: '',
    isEditingText: () => false,
    render: () => { rendered++; },
  } as unknown as ControllerHandle;
  assert.deepEqual(handleControllerInput(controller, '\r'), { consume: true });
  assert.equal(controller.page, 'inspection');
  assert.match(controller.message, /Read-only candidate history/);
  assert.equal(rendered, 1);
  assert.deepEqual(handleControllerInput(controller, 'd'), { consume: true });
  assert.equal(controller.page, 'inspection');
});
