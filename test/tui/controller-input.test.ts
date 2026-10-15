import test from 'node:test';
import assert from 'node:assert/strict';
import { handleControllerInput, type ControllerHandle } from '../../src/tui/controller-input.js';
import { CanvasFind } from '../../src/tui/canvas-find.js';
import { RunDiagnostics } from '../../src/tui/run-diagnostics.js';

function runningController(): ControllerHandle {
  const timeline = [{ sequence: 1, occurredAt: '', source: 'TARGET', title: 'First activity' },
    { sequence: 2, occurredAt: '', source: 'TARGET', title: 'Latest activity' }];
  return {
    page: 'running',
    locale: 'en',
    message: '',
    inlineHelp: false,
    helpOverlay: undefined,
    activityDetailOverlay: undefined,
    activityDetailEntry: undefined,
    startupAbort: undefined,
    canvasFind: new CanvasFind(), runDiagnostics: new RunDiagnostics(),
    expandedFolds: [],
    timelineFilterIndex: 0,
    timelineRevision: 0,
    generation: 11,
    readingMode: false,
    readingVisibleAt: 0,
    timeline,
    timelineSelected: 0,
    timelineFollowing: true,
    timelineAnchor: undefined,
    timelineReadOffset: 0,
    isEditingText: () => false,
    visibleTimeline(this: ControllerHandle) { return this.timeline; },
    setMouseReporting() {},
    render() {},
  } as unknown as ControllerHandle;
}

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

test('reading mode yields late SGR click and wheel input without moving the frozen timeline', () => {
  const controller = runningController();
  const mouseCalls: boolean[] = [];
  controller.setMouseReporting = (enabled) => { mouseCalls.push(enabled); };

  assert.deepEqual(handleControllerInput(controller, 'v'), { consume: true });
  assert.equal(controller.readingMode, true);
  assert.equal(controller.timelineFollowing, false);
  assert.deepEqual(mouseCalls, []);

  assert.equal(handleControllerInput(controller, '\x1b[<65;1;2M'), undefined);
  assert.equal(handleControllerInput(controller, '\x1b[<0;4;8M'), undefined);
  assert.equal(controller.timelineSelected, 0);
  assert.equal(controller.timelineReadOffset, 0);
  assert.deepEqual(mouseCalls, []);
});

test('End leaves reading mode, restores mouse reporting, and follows the latest activity', () => {
  const controller = runningController();
  const mouseCalls: boolean[] = [];
  controller.setMouseReporting = (enabled) => { mouseCalls.push(enabled); };

  handleControllerInput(controller, 'v');
  assert.deepEqual(handleControllerInput(controller, '\x1b[F'), { consume: true });
  assert.equal(controller.readingMode, false);
  assert.equal(controller.timelineFollowing, true);
  assert.equal(controller.timelineSelected, 1);
  assert.deepEqual(mouseCalls, [true]);
});

test('find owns query editing while escape restores the reading position despite appended output', () => {
  const controller = runningController();
  controller.timelineFollowing = false;
  controller.timelineAnchor = 'seq:1';
  controller.timelineReadOffset = 7;
  handleControllerInput(controller, '/');
  assert.equal(controller.canvasFind.state.finding, true);
  handleControllerInput(controller, 'activity');
  assert.equal(controller.canvasFind.state.query, 'activity');
  handleControllerInput(controller, '\r');
  assert.equal(controller.timelineSelected, 1);
  handleControllerInput(controller, '\x1b[13;2u');
  assert.equal(controller.timelineSelected, 0);
  controller.timeline = [...controller.timeline, { sequence: 3, occurredAt: '', source: 'TARGET', title: 'New output' }];
  handleControllerInput(controller, '\x1b');
  assert.deepEqual(controller.canvasFind.state, { finding: false, query: '', cursor: 0 });
  assert.equal(controller.timelineSelected, 0);
  assert.equal(controller.timelineAnchor, 'seq:1');
  assert.equal(controller.timelineReadOffset, 7);
  assert.equal(controller.timelineFollowing, false);
  assert.equal(controller.generation, 11);
});
