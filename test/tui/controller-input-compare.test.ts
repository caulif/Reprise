import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExperimentResult } from '../../src/application/experiment.js';
import { handleControllerInput, type ControllerHandle } from '../../src/tui/controller-input.js';
import { t } from '../../src/tui/i18n.js';
import { renderWorkbench } from '../../src/tui/workbench.js';

const gateResult = {
  reportPath: 'C:\\exp\\report.html',
  experimentRoot: 'C:\\exp',
  record: {
    attempt: { runId: 'run-1' },
    outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
  },
  decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
  comparison: { result: { status: 'skipped' } },
} as ExperimentResult;

function compareController(resolve: (run: boolean) => void, page: 'result' | 'running' = 'result'): ControllerHandle {
  const view = { page, cwd: '/', hasApiConfig: true, hasTaskCase: false, message: '' };
  return {
    page,
    compareChoice: { resolve },
    result: gateResult,
    locale: 'en',
    isEditingText: () => false,
    view: () => view,
    render() {},
  } as unknown as ControllerHandle;
}

function renderCompareGateFooter(comparePending: boolean): string {
  return renderWorkbench({
    page: 'result',
    cwd: '/workspace',
    hasApiConfig: true,
    hasTaskCase: true,
    message: t('en', 'compareGateBody'),
    comparePending,
    result: gateResult,
  }, 120, 30).join('\n');
}

test('compare gate footer shows c only after compareChoice is armed', () => {
  assert.doesNotMatch(renderCompareGateFooter(false), /\[c\]/);
  assert.match(renderCompareGateFooter(true), /\[c\]/);
});

test('compare gate paints footer c before awaiting operator choice', async () => {
  const rendered: string[] = [];
  let compareChoice: { resolve(run: boolean): void } | undefined;
  const gate = new Promise<boolean>((resolve) => {
    compareChoice = { resolve };
    rendered.push(renderCompareGateFooter(Boolean(compareChoice)));
  });
  assert.match(rendered.at(-1)!, /\[c\]/);
  compareChoice!.resolve(false);
  await gate;
});

test('result compare gate resolves true when c is pressed', () => {
  let chosen: boolean | undefined;
  const c = compareController((run) => { chosen = run; });
  const handled = handleControllerInput(c, 'c');
  assert.deepEqual(handled, { consume: true });
  assert.equal(chosen, true);
  assert.equal(c.compareChoice, undefined);
});

test('running compare gate resolves true when c is pressed', () => {
  let chosen: boolean | undefined;
  const c = compareController((run) => { chosen = run; }, 'running');
  const handled = handleControllerInput(c, 'c');
  assert.deepEqual(handled, { consume: true });
  assert.equal(chosen, true);
  assert.equal(c.compareChoice, undefined);
});
