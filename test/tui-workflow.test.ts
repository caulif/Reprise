import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexExperimentWorkflow, TUI_RUN_POLICY } from '../src/application/tui-workflow.js';
import { candidateStartBlocked } from '../src/tui/controller-run.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';

test('TUI run policy is a last-resort safety valve, not a completion budget', () => {
  assert.equal(TUI_RUN_POLICY.maxTargetTurns, 256);
  assert.equal(TUI_RUN_POLICY.maxModelCalls, 256);
  assert.equal(TUI_RUN_POLICY.wallClockMs, 24 * 60 * 60_000);
  assert.equal(TUI_RUN_POLICY.turnTimeoutMs, 2 * 60 * 60_000);
});

test('same-product defaults.candidate is kept instead of pack.defaultCandidate', () => {
  const custom = { candidateId: 'operator-pick', productId: 'fake', requestedModel: 'operator-model' };
  const workflow = createCodexExperimentWorkflow({
    dataDir: 'unused',
    runtime: fakeProductPack.runtime,
    pack: fakeProductPack,
    now: () => '2026-08-14T00:00:00.000Z',
    defaults: { candidate: custom, policy: TUI_RUN_POLICY },
    agents: async () => {
      throw new Error('agents should not be created for this assertion');
    },
  });
  assert.deepEqual(workflow.candidate, custom);
  assert.equal(workflow.policy.maxTargetTurns, 256);
});

test('source blockedReasons do not block a recovered candidate', () => {
  assert.equal(
    candidateStartBlocked({
      sourceBaseline: 'unavailable',
      blockedReasons: ['symlink outside root'],
      recovery: { hasAccept: true, hasStaging: true, baselineMode: 'canonical', runnable: 'isolated' },
    }),
    undefined,
  );
});

test('a failed recovery without a candidate still refuses to start', () => {
  assert.match(
    candidateStartBlocked({
      sourceBaseline: 'available',
      blockedReasons: [],
      recovery: { hasAccept: false, hasStaging: false, baselineMode: 'unsupported', runnable: 'unsupported' },
    }) ?? '',
    /runnable workspace/,
  );
});

test('current-state fallback without accept cannot start a candidate', () => {
  assert.match(
    candidateStartBlocked({
      sourceBaseline: 'available',
      blockedReasons: [],
      recovery: {
        hasAccept: false,
        hasStaging: true,
        baselineMode: 'canonical',
        runnable: 'isolated',
        userStatus: 'failed',
      },
    }) ?? '',
    /runnable workspace/,
  );
});
