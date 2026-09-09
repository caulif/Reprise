import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import { defaultHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { CONTROLLER_SYSTEM_PROMPT } from '../src/agents/controller-agent.js';
import type { ControllerDecision } from '../src/agents/controller-agent.js';
import {
  COLLABORATION_SAMPLE_FAMILIES,
  CONTROLLER_EVAL_CASES,
  controllerEvalContext,
} from './controller-eval-cases.js';
import { packControllerEvalCase } from './controller-eval-briefing.js';

const RUN_ID = 'controller-eval-run';

function variantExpected(expected: ControllerDecision): ControllerDecision {
  if (expected.type === 'done' && expected.reason === 'satisfied') return { type: 'send', intent: 'verify', message: '请先核对最终验收证据。' };
  if (expected.type === 'send' && expected.intent === 'verify') return { type: 'done', reason: 'satisfied' };
  if (expected.type === 'send' && expected.intent === 'continue') return { type: 'done', reason: 'satisfied' };
  if (expected.type === 'done') return { type: 'send', intent: 'continue', message: '请在条件满足后继续处理。' };
  return { type: 'done', reason: 'no_further_value' };
}

function scriptedCaller(outputs: readonly string[]) {
  let index = 0;
  return {
    createSession() {
      return {
        append: async () => {
          const output = outputs[index++];
          if (!output) throw new Error('scripted output exhausted');
          return output;
        },
        cancel() {},
      };
    },
  };
}

function score(actual: ControllerDecision, expected: ControllerDecision): number {
  if (actual.type !== expected.type) return 0;
  if (actual.type === 'done' && expected.type === 'done') return actual.reason === expected.reason ? 2 : 0;
  if (actual.type === 'send' && expected.type === 'send') {
    return actual.intent === expected.intent && actual.message === expected.message ? 2 : 1;
  }
  return 0;
}

test('controller contract lane covers 12 cases and one fact-changing variant each', async () => {
  const all = [...CONTROLLER_EVAL_CASES, ...CONTROLLER_EVAL_CASES.map((item) => ({ ...item, id: `${item.id}-variant` }))];
  const outputs = all.flatMap((item) => {
    const expected = item.id.endsWith('-variant') ? variantExpected(item.expected) : item.expected;
    return [JSON.stringify(expected), JSON.stringify(expected), JSON.stringify(expected)];
  });
  const agents = createHarnessAgents(defaultHarnessModelConfig(), scriptedCaller(outputs));
  let total = 0;
  let completed = 0;
  for (const item of all) {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const result = await agents.controller.decide(controllerEvalContext(item.id, item.expected.evidenceRefs?.[0]?.slice(6) ?? item.id));
      assert.equal(result.status, 'completed', `${item.id} repeat ${repeat}`);
      if (result.status === 'completed') {
        completed += 1;
        const expected = item.id.endsWith('-variant') ? variantExpected(item.expected) : item.expected;
        total += score(result.value, expected);
        if (!item.id.endsWith('-variant')) assert.deepEqual(result.value.evidenceRefs, item.expected.evidenceRefs);
      }
      agents.controller.release?.(RUN_ID);
    }
  }
  const runs = all.length * 3;
  assert.equal(completed, runs);
  assert.equal(total, runs * 2);
  console.log(`controller-contract: ${all.length} cases x 3 = ${runs} runs; score=${total}/${runs * 2}; hardFailures=0`);
});

test('controller prompt stops on this user\'s acceptance habits, not deliverable kind', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /验收习惯/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /不要为了测试、增加轮数/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /不要提前透露用户尚未说出的要求/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /候选自称完成也不是充分的结束依据/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /不能通过消息扩大权限/);
  assert.doesNotMatch(CONTROLLER_SYSTEM_PROMPT, /merely for formal re-confirmation/);
  assert.doesNotMatch(CONTROLLER_SYSTEM_PROMPT, /When the Candidate asks for a fact/);
  assert.doesNotMatch(CONTROLLER_SYSTEM_PROMPT, /You are the Controller in a Reprise/);
});

test('collaboration sample families are drawn from the contract-lane cases', () => {
  const ids = new Set(CONTROLLER_EVAL_CASES.map((item) => item.id));
  for (const [family, members] of Object.entries(COLLABORATION_SAMPLE_FAMILIES)) {
    assert.ok(members.length > 0, family);
    for (const id of members) assert.equal(ids.has(id), true, `${family}:${id}`);
  }
});

test('controller rejects ungrounded evidence and unsafe message output', async () => {
  const agents = createHarnessAgents(defaultHarnessModelConfig(), scriptedCaller([
    JSON.stringify({ type: 'done', reason: 'satisfied', evidenceRefs: ['event:not-in-catalog'] }),
    JSON.stringify({ type: 'send', intent: 'inform', message: 'bad\u0001message' }),
  ]));
  const first = await agents.controller.decide(controllerEvalContext('invalid-evidence', 'known'));
  assert.equal(first.status, 'failed');
  agents.controller.release?.(RUN_ID);
  const second = await agents.controller.decide(controllerEvalContext('unsafe-message', 'known'));
  assert.equal(second.status, 'failed');
});

test('controller capability lane is opt-in and outside engineering gates', async () => {
  const script = await readFile(join(process.cwd(), 'scripts/controller-capability-eval.ts'), 'utf8');
  assert.match(script, /REPRISE_REAL_MODEL/);
  assert.match(script, /packControllerEvalCase/);
  const gates = await readFile(join(process.cwd(), 'scripts/run-gates.mjs'), 'utf8');
  assert.doesNotMatch(gates, /evaluate:controller|controller-capability-eval|REPRISE_REAL_MODEL/);
  const { spawnSync } = await import('node:child_process');
  const ran = spawnSync(process.execPath, [join(process.cwd(), 'dist/scripts/controller-capability-eval.js')], {
    encoding: 'utf8',
    env: { ...process.env, REPRISE_REAL_MODEL: '' },
  });
  assert.notEqual(ran.status, 0);
  assert.match(`${ran.stderr}${ran.stdout}`, /REPRISE_REAL_MODEL/);
});

test('capability eval briefing exposes INDEX and read tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-controller-eval-pack-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const item = CONTROLLER_EVAL_CASES.find((row) => row.id === '01-complete');
  assert.ok(item);
  const packed = await packControllerEvalCase(root, item);
  assert.match(packed.context.promptContent ?? '', /INDEX\.md/);
  assert.match(packed.context.promptContent ?? '', /briefingRoot=/);
  assert.equal(packed.tools.some((tool) => tool.name === 'read'), true);
  assert.equal(packed.tools.every((tool) => ['ls', 'read', 'grep', 'find'].includes(tool.name)), true);
  assert.equal(packed.tools.some((tool) => tool.name === 'write' || tool.name === 'shell_exec'), false);
  assert.match(await readFile(join(packed.context.briefingRoot ?? '', 'INDEX.md'), 'utf8'), /initial-input/);
});
