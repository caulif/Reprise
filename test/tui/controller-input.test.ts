import test from 'node:test';
import assert from 'node:assert/strict';
import { handleControllerInput, type ControllerHandle } from '../../src/tui/controller-input.js';

test('Recovery diagnostics use the artifact opener instead of the HTML report opener', () => {
  let opened: { root: string | undefined; path: string | undefined } | undefined;
  const controller = {
    page: 'confirm',
    locale: 'en',
    message: '',
    inlineHelp: false,
    helpOverlay: false,
    activityDetailOverlay: false,
    activityDetailEntry: undefined,
    startupAbort: undefined,
    isEditingText: () => false,
    render() {},
    openArtifact(root: string | undefined, path: string | undefined) {
      opened = { root, path };
      return { consume: true as const };
    },
    recoveryView: {
      experimentRoot: 'C:\\data\\experiments\\exp-1',
      experimentId: 'exp-1',
      baseline: {
        mode: 'canonical',
        recovery: { status: 'failed', failureStage: 'agent_invalid_output', unresolved: [] },
      },
      recovery: { status: 'failed', failure: { kind: 'protocol', message: 'invalid output' } },
      hasAccept: false,
    },
  } as unknown as ControllerHandle;

  assert.deepEqual(handleControllerInput(controller, 'd'), { consume: true });
  assert.deepEqual(opened, {
    root: 'C:\\data\\experiments\\exp-1',
    path: 'recovery-diagnosis.json',
  });
});
