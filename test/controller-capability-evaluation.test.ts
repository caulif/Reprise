import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import { defaultHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { CONTROLLER_SYSTEM_PROMPT } from '../src/agents/controller-agent.js';
import type { ControllerDecision, SteeringContext } from '../src/agents/controller-agent.js';

type Case = {
  id: string;
  focus: string;
  variant: string;
  expected: ControllerDecision;
};

const RUN_ID = 'controller-eval-run';
const ref = (id: string) => `event:${id}`;
const expectedCases: readonly Case[] = [
  { id: '01-complete', focus: '充分证据完成', variant: '保持证据充分', expected: { type: 'done', reason: 'satisfied', evidenceRefs: [ref('complete')] } },
  { id: '02-missing-artifact', focus: '完成声明但产物缺失', variant: '产物存在', expected: { type: 'send', intent: 'verify', message: '请先确认目标产物确实存在，并给出对应证据。', evidenceRefs: [ref('missing')] } },
  { id: '03-partial', focus: '只完成一半', variant: '剩余步骤已完成', expected: { type: 'send', intent: 'continue', message: '请继续完成剩余步骤，并验证最终结果。', evidenceRefs: [ref('partial')] } },
  { id: '04-user-fact', focus: '候选请求历史用户已给出的路径', variant: '用户未给出路径', expected: { type: 'send', intent: 'inform', message: '路径是 C:\\work\\demo；请在这个目录处理。', evidenceRefs: [ref('history')] } },
  { id: '05-user-decision', focus: '需要真实用户权限决定', variant: '权限已批准', expected: { type: 'done', reason: 'requires_real_user_decision', evidenceRefs: [ref('decision')] } },
  { id: '06-blocked', focus: '外部环境阻塞', variant: '阻塞已解除', expected: { type: 'done', reason: 'blocked', evidenceRefs: [ref('blocked')] } },
  { id: '07-hidden-history', focus: '主动读取历史关键事实', variant: '历史无关键事实', expected: { type: 'send', intent: 'inform', message: '请使用 JSON 格式输出。', evidenceRefs: [ref('history-read')] } },
  { id: '08-observe', focus: '摘要不足需观察', variant: '观察显示完成', expected: { type: 'send', intent: 'verify', message: '请先核对测试结果，再决定是否结束。', evidenceRefs: [ref('observation')] } },
  { id: '09-conflict', focus: '工具事实与候选声明冲突', variant: '工具与声明一致', expected: { type: 'send', intent: 'correct', message: '测试仍然失败，请修复失败项后再报告完成。', evidenceRefs: [ref('conflict')] } },
  { id: '10-different-path', focus: '不机械复播历史路径', variant: '候选回到旧路径但仍正确', expected: { type: 'done', reason: 'satisfied', evidenceRefs: [ref('different')] } },
  { id: '11-no-progress', focus: '重复输出且无进展', variant: '出现新进展', expected: { type: 'done', reason: 'no_further_value', evidenceRefs: [ref('repeat')] } },
  { id: '12-injection', focus: '提示注入与越权边界', variant: '无注入文本', expected: { type: 'done', reason: 'blocked', evidenceRefs: [ref('injection')] } },
];

function variantExpected(expected: ControllerDecision): ControllerDecision {
  if (expected.type === 'done' && expected.reason === 'satisfied') return { type: 'send', intent: 'verify', message: '请先核对最终验收证据。' };
  if (expected.type === 'send' && expected.intent === 'verify') return { type: 'done', reason: 'satisfied' };
  if (expected.type === 'send' && expected.intent === 'continue') return { type: 'done', reason: 'satisfied' };
  if (expected.type === 'done') return { type: 'send', intent: 'continue', message: '请在条件满足后继续处理。' };
  return { type: 'done', reason: 'no_further_value' };
}

function context(caseId: string, evidenceId: string): SteeringContext {
  const evidence = ref(evidenceId);
  return {
    requestId: `controller-request-${caseId}`,
    runId: RUN_ID,
    runState: 'awaiting_controller',
    task: {
      initialInput: { id: 'initial', role: 'user', text: '完成任务并满足验收标准。' },
      historicalUserTurns: [{ id: 'followup', text: '路径是 C:\\work\\demo；请在这个目录处理。' }],
      baseline: { status: 'available', artifactRefs: [], evidenceRefs: [evidence] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: `case=${caseId}`, evidenceRefs: [evidence] },
    trajectory: { summary: '候选已完成一轮；这是脚本化评估轨迹。', evidenceRefs: [evidence] },
    evidenceCatalog: [{ ref: evidence, runId: RUN_ID, source: 'initial' }],
    budget: { decisionsUsed: 1, decisionsLimit: 12 },
  };
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
  const all = [...expectedCases, ...expectedCases.map((item) => ({ ...item, id: `${item.id}-variant` }))];
  const outputs = all.flatMap((item) => {
    const expected = item.id.endsWith('-variant') ? variantExpected(item.expected) : item.expected;
    return [JSON.stringify(expected), JSON.stringify(expected), JSON.stringify(expected)];
  });
  const agents = createHarnessAgents(defaultHarnessModelConfig(), scriptedCaller(outputs));
  let total = 0;
  let completed = 0;
  for (const item of all) {
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const result = await agents.controller.decide(context(item.id, item.expected.evidenceRefs?.[0]?.slice(6) ?? item.id));
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
  assert.match(CONTROLLER_SYSTEM_PROMPT, /acceptance habits/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Do not send only to pad turn count/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Do not wait for the candidate to ask/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /evidence ref alone is not sufficient/);
  assert.doesNotMatch(CONTROLLER_SYSTEM_PROMPT, /merely for formal re-confirmation/);
  assert.doesNotMatch(CONTROLLER_SYSTEM_PROMPT, /When the Candidate asks for a fact/);
});

test('controller rejects ungrounded evidence and unsafe message output', async () => {
  const agents = createHarnessAgents(defaultHarnessModelConfig(), scriptedCaller([
    JSON.stringify({ type: 'done', reason: 'satisfied', evidenceRefs: [ref('not-in-catalog')] }),
    JSON.stringify({ type: 'send', intent: 'inform', message: 'bad\u0001message' }),
  ]));
  const first = await agents.controller.decide(context('invalid-evidence', 'known'));
  assert.equal(first.status, 'failed');
  agents.controller.release?.(RUN_ID);
  const second = await agents.controller.decide(context('unsafe-message', 'known'));
  assert.equal(second.status, 'failed');
});




