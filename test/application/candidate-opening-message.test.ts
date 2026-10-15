import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateOpeningMessage } from '../../src/application/candidate-opening-message.js';
import { startExperiment } from '../../src/application/experiment.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import type { MessageIdentity, UserMessage } from '../../src/core/runtime.js';
import type { TaskCase } from '../../src/core/schema.js';
import { ScriptedRunner } from '../support/scripted-runtime.js';
import { input, now, VerifiedRuntime } from '../codex-experiment-support.js';

class RecordingRuntime extends VerifiedRuntime {
  readonly messages: { message: UserMessage; identity: MessageIdentity }[] = [];
  workspaceRoot = '';
  constructor(readonly delivery: 'accepted' | 'unknown' = 'accepted') { super(); }
  override async createRunner(...args: Parameters<VerifiedRuntime['createRunner']>) {
    this.workspaceRoot = args[1].root;
    const runner = new ScriptedRunner(
      Array.from({ length: 2 }, () => ({ delivery: this.delivery, evidence: 'native_admission' as const })),
      Array.from({ length: 2 }, (_, i) => ({ turnId: `turn-${i}`, status: 'waiting_input' as const, confidence: 'native' as const, observedAt: now, rawRefs: [] })),
      undefined, { workspaceRoot: this.workspaceRoot },
    );
    const start = runner.start.bind(runner);
    const send = runner.send.bind(runner);
    runner.start = async (message, identity) => { this.messages.push({ message, identity }); return start(message, identity); };
    runner.send = async (message, identity) => { this.messages.push({ message, identity }); return send(message, identity); };
    return runner;
  }
}

for (const mode of ['completion', 'explicit', 'legacy', 'historical'] as const) {
  test(`${mode}: runtime, persisted inputs and briefing agree; followups stay verbatim`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'reprise-opening-contract-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const runtime = new RecordingRuntime();
    const base = input(root, runtime);
    await mkdir(base.sourceRoot);
    const external = join(root, 'input.txt');
    await writeFile(external, 'input copy');
    const authorization = mode === 'explicit' ? '允许本地 commit 和 push；不得安装依赖。\n仅发布到已授权分支。' : '只在副本修改、编译测试和保存草稿；不 commit，不 push。';
    const execution: TaskCase['execution'] = mode === 'legacy' ? undefined : mode === 'historical' ? { mode: 'historical_simulation' }
      : { mode: 'task_completion', goal: '完整冻结目标：编辑输入并保存草稿。', deliverables: ['draft/result.txt', '保留输入格式'], authorization };
    const taskCase: TaskCase = { ...base.taskCase, initialInput: { ...base.taskCase.initialInput, text: `Edit ${external}` },
      taskContext: mode === 'explicit' ? {} : { historicalCwd: base.sourceRoot }, ...(execution ? { execution } : {}) };
    const opening = '请修改文件。';
    const followup = '继续检查第二页，原样发送。';
    for (const runId of ['run-a', 'run-b']) {
      let calls = 0;
      const result = await startExperiment({ ...base, taskCase, runId, experimentId: `experiment-${runId}`, compare: false,
        policy: { turnTimeoutMs: 5000, maxTargetTurns: 3, maxModelCalls: 8, maxConsecutiveNoProgress: 3 },
        controller: { decide: async () => ({ status: 'completed', sessionId: `controller-${runId}`, value: ++calls === 1
          ? { type: 'send', message: opening, intent: 'continue' }
          : calls === 2 ? { type: 'send', message: followup, intent: 'continue' }
            : { type: 'done', reason: 'satisfied' } }) },
      }).result;
      const transmitted = runtime.messages.slice(-2);
      const full = transmitted[0]!.message.text;
      if (execution?.mode === 'task_completion') {
        for (const text of [opening, execution.goal, ...execution.deliverables, authorization, runtime.workspaceRoot,
          `${external} -> ${join(runtime.workspaceRoot, 'imported-inputs', 'input.txt')}`]) assert.ok(full.includes(text), text);
        assert.equal(full.split('# Host task execution information').length, 2);
        assert.ok(full.endsWith(authorization));
        assert.match(full, /explicit task authorization does not say otherwise/);
        assert.match(full, /takes precedence/);
        assert.match(full, /Do not initiate local commits without explicit task authorization/);
        assert.match(full, /Delivery location/);
        assert.ok(full.includes(`Original workspace ${base.sourceRoot} maps to this working copy`));
      } else assert.equal(full, opening);
      assert.equal(transmitted[1]!.message.text, followup);
      const store = await ExperimentStore.open(result.experimentRoot, `experiment-${runId}`);
      const events = store.events(runId);
      const inputs = events.filter(event => event.type === 'input.submitted').map(event => event.payload);
      assert.deepEqual(inputs, transmitted.map(({ message, identity }) => ({ messageId: message.id, clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, text: message.text })));
      const sent = (await readFile(join(result.experimentRoot, 'runs', runId, 'controller-briefing', 'run', 'sent-user-messages.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as UserMessage);
      assert.deepEqual(sent, transmitted.map(row => row.message));
      assert.ok(JSON.stringify(events.find(event => event.type === 'controller.decision')?.payload).includes(opening));
      assert.ok(!JSON.stringify(events.find(event => event.type === 'controller.decision')?.payload).includes('# Host task execution information'));
      assert.equal(result.record.outcome.task.status, 'apparently_completed');
      await store.close();
    }
  });
}

test('already complete opening avoids duplicate frozen text; absent mappings are not invented', () => {
  const taskCase = input('unused', new VerifiedRuntime()).taskCase;
  taskCase.execution = { mode: 'task_completion', goal: 'frozen goal', deliverables: ['draft.txt'], authorization: 'edit only' };
  const message = candidateOpeningMessage({ message: 'frozen goal\ndraft.txt', taskCase, workspaceRoot: 'copy', importedInputs: [] });
  assert.equal(message.split('frozen goal').length, 2);
  assert.equal(message.split('draft.txt').length, 2);
  assert.doesNotMatch(message, /Copied input:|Original workspace|imported-inputs/);
  assert.match(message, /copy/);
});

test('unknown first delivery retains augmented input and identity without resubmitting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-opening-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtime = new RecordingRuntime('unknown');
  const base = input(root, runtime);
  await mkdir(base.sourceRoot);
  base.taskCase.execution = { mode: 'task_completion', goal: 'edit', deliverables: ['draft'], authorization: 'no commit' };
  const result = await startExperiment({ ...base, compare: false, policy: { ...base.policy, wallClockMs: 10000 } }).result;
  assert.equal(result.record.outcome.termination.code, 'uncertain.input_delivery');
  assert.equal(runtime.messages.length, 1);
  const submitted = runtime.messages[0]!;
  assert.match(submitted.message.text, /execution.authorization \(verbatim\):\nno commit/);
  const store = await ExperimentStore.open(result.experimentRoot, base.experimentId);
  assert.deepEqual(store.events(base.runId).filter(event => event.type === 'input.submitted').map(event => event.payload), [{
    messageId: submitted.message.id, clientMessageId: submitted.identity.clientMessageId, turnIndex: 0, text: submitted.message.text,
  }]);
  assert.deepEqual(JSON.parse((await readFile(join(result.experimentRoot, 'runs', base.runId, 'controller-briefing', 'run', 'sent-user-messages.jsonl'), 'utf8')).trim()), submitted.message);
  await store.close();
});
