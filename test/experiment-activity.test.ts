import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finishExperimentActivity,
  parseActivityId,
  registerActivity,
  requestInProcessCancel,
} from '../src/application/experiment-activity.js';
import { runCli } from '../src/cli/main.js';

test('activity ids distinguish operation, experiment, and run', () => {
  assert.equal(parseActivityId('op-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee').kind, 'operation');
  assert.equal(parseActivityId('experiment-1').kind, 'experiment');
  assert.equal(parseActivityId('recovery-abc').kind, 'experiment');
  assert.equal(parseActivityId('run-1').kind, 'run');
  assert.equal(parseActivityId('recovery-run-1').kind, 'run');
  assert.equal(parseActivityId('not a safe id!').kind, 'ambiguous');
});

test('in-process cancel binds the current operation and does not follow the next one', async () => {
  const cancelled: string[] = [];
  const prepare = registerActivity({
    kind: 'prepare',
    experimentId: 'experiment-bind',
    runId: 'run-bind',
    cancel: async () => { cancelled.push('prepare'); },
  });
  finishExperimentActivity('experiment-bind');
  const run = registerActivity({
    kind: 'run',
    experimentId: 'experiment-bind',
    runId: 'run-bind',
    cancel: async () => { cancelled.push('run'); },
  });
  const stale = await requestInProcessCancel(prepare.operationId);
  assert.equal(stale.status, 'already_finished');
  assert.deepEqual(cancelled, []);
  const live = await requestInProcessCancel('experiment-bind');
  assert.equal(live.status, 'cancel_requested');
  if (live.status === 'cancel_requested') {
    assert.equal(live.activity.operationId, run.operationId);
    assert.equal(live.activity.kind, 'run');
  }
  assert.deepEqual(cancelled, ['run']);
  finishExperimentActivity('experiment-bind');
});

test('CLI cancel prints id kinds and does not touch an unknown owner', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stdout: (message: string) => stdout.push(message), stderr: (message: string) => stderr.push(message) };
  assert.equal(await runCli(['cancel'], io), 2);
  assert.match(stderr.join('\n'), /operationId\|experimentId\|runId/);
  stderr.length = 0;
  assert.equal(await runCli(['cancel', 'experiment-missing'], io), 3);
  assert.match(stdout.join('\n'), /unknown experiment experiment-missing/);
  assert.match(stdout.join('\n'), /lock untouched/);
  const help: string[] = [];
  await runCli(['--help'], { stdout: (message) => help.push(message), stderr: () => undefined });
  assert.match(help.join('\n'), /reprise cancel/);
  assert.match(help.join('\n'), /operationId/);
});
