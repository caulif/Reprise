import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ControllerAgent, CONTROLLER_SYSTEM_PROMPT, type SteeringContext } from '../../src/agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../../src/infrastructure/agent/host.js';
import { controllerPromptContent, renderIndexMarkdown } from '../../src/application/controller-briefing.js';

function briefing(input: { includeFollowupInIndex: boolean; settledTurns: number }): SteeringContext {
  const marker = '第二页太空了，补上漏洞条目。';
  const index = renderIndexMarkdown(input.settledTurns > 0 ? 'run/turns/0001' : undefined);
  const promptContent = controllerPromptContent({
    phase: 'steering',
    briefingRoot: '/briefing',
    indexMarkdown: input.includeFollowupInIndex ? `${index}\n${marker}\n` : index,
  });
  return {
    requestId: 'controller-request-run-1-2',
    runId: 'run-1',
    runState: 'awaiting_controller',
    phase: 'steering',
    task: {
      initialInput: { id: 'message-1', role: 'user', text: '根据漏洞统计做 PPT 风 HTML。' },
      baseline: {
        status: 'available',
        finalMessage: '已生成可打开的 PPT 样式 HTML。',
        artifactRefs: [],
        evidenceRefs: [],
      },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
      historicalUserTurns: [{ id: 'message-3', text: marker }],
    },
    current: {
      summary: 'Latest target settlement: completed. Observed commands: 2; changed paths: 1; rejected approvals: 0.',
      evidenceRefs: [],
    },
    trajectory: {
      summary: `Settled turns: ${input.settledTurns}; commands: 2; changed paths: 1; runtime-generated paths: 0.`,
      evidenceRefs: [],
    },
    evidenceCatalog: [],
    budget: { decisionsUsed: 1 },
    promptContent,
  };
}

function policyStub(): PiTextCaller {
  return {
    createSession(session) {
      return {
        append: async ({ content }) => {
          assert.match(session.systemPrompt, /验收习惯/);
          assert.doesNotMatch(content, /第二页太空了/);
          assert.match(content, /INDEX\.md/);
          const firstPass = /Latest turn: run\/turns\/0001/.test(content);
          if (firstPass) {
            return JSON.stringify({ type: 'send', intent: 'correct', message: '第二页按上次那样补上内容。' });
          }
          return JSON.stringify({ type: 'done', reason: 'satisfied' });
        },
        cancel() {},
      };
    },
  };
}

test('session callbacks are bound to the actual tool and current request', async () => {
  const callbacks: string[] = [];
  let calls = 0;
  const controller = new ControllerAgent({ host: new PiAgentHost({ createSession: (session) => ({
    append: async () => {
      calls += 1;
      const name = calls === 1 ? 'ls' : 'read';
      await session.tools.find((tool) => tool.name === name)!.execute({}, new AbortController().signal);
      return JSON.stringify({ type: 'done', reason: 'satisfied' });
    },
    cancel() {},
  }) }), timeoutMs: 1_000, maxRepairAttempts: 0 });
  for (const index of [1, 2]) {
    const result = await controller.decide({ ...briefing({ includeFollowupInIndex: false, settledTurns: 1 }), requestId: `request-${index}` }, ['ls', 'read'].map((name) => ({
      name, description: name, parameters: Type.Object({}),
      execute: async () => ({ content: 'result', details: { available: true, path: 'project/output.html' } }),
      onCompleted: async () => { callbacks.push(`${name}-${index}`); },
    })));
    assert.equal(result.status, 'completed');
  }
  assert.deepEqual(callbacks, ['ls-1', 'read-2']);
});

test('first-pass same-kind deliverable with historical user steering is send, not done', async () => {
  const controller = new ControllerAgent({
    host: new PiAgentHost(policyStub()),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await controller.decide(briefing({ includeFollowupInIndex: false, settledTurns: 1 }));
  assert.equal(result.status, 'completed');
  assert.equal(result.value.type, 'send');
  if (result.value.type === 'send') assert.equal(result.value.intent, 'correct');
});

test('without later user steering, the same first pass may stop', async () => {
  const controller = new ControllerAgent({
    host: new PiAgentHost(policyStub()),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const result = await controller.decide(briefing({ includeFollowupInIndex: false, settledTurns: 0 }));
  assert.equal(result.status, 'completed');
  assert.equal(result.value.type, 'done');
  if (result.value.type === 'done') assert.equal(result.value.reason, 'satisfied');
});

test('controller prompt does not treat unused historical user turns as a stop reason', () => {
  assert.match(CONTROLLER_SYSTEM_PROMPT, /不要机械重放原句/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /不要为了测试、增加轮数/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /候选自称完成也不是充分的结束依据/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /验收习惯/);
});

test('Controller without promptContent still does not dump historical user turns', async () => {
  const marker = 'MARKER_MUST_NOT_INLINE';
  const appended: string[] = [];
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession() {
        return {
          append: async ({ content }) => {
            appended.push(content);
            return JSON.stringify({ type: 'done', reason: 'satisfied' });
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const ctx = briefing({ includeFollowupInIndex: false, settledTurns: 1 });
  const { promptContent: _unused, ...rest } = ctx;
  void _unused;
  const result = await controller.decide({
    ...rest,
    task: {
      ...ctx.task,
      historicalUserTurns: [{ id: 'message-3', text: marker }],
    },
  });
  assert.equal(result.status, 'completed');
  assert.doesNotMatch(appended[0] ?? '', new RegExp(marker));
  assert.doesNotMatch(appended[0] ?? '', /finalMessage/);
});

test('opening and later decide share one Controller Session without a private understanding pass', async () => {
  let sessions = 0;
  const appended: string[] = [];
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession() {
        sessions += 1;
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (appended.length === 1) {
              return 'Working understanding of the historical user demand.';
            }
            if (content.includes('phase=opening')) {
              return JSON.stringify({ type: 'send', intent: 'continue', message: '先查看当前材料。' });
            }
            return JSON.stringify({ type: 'done', reason: 'satisfied' });
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const opening = await controller.decide({
    ...briefing({ includeFollowupInIndex: false, settledTurns: 0 }),
    runState: 'created',
    phase: 'opening',
    requestId: 'controller-request-run-1-1',
    budget: { decisionsUsed: 0 },
    promptContent: controllerPromptContent({
      phase: 'opening',
      briefingRoot: '/briefing',
      indexMarkdown: renderIndexMarkdown(undefined),
    }),
  });
  const later = await controller.decide({
    ...briefing({ includeFollowupInIndex: false, settledTurns: 1 }),
    requestId: 'controller-request-run-1-2',
  });
  assert.equal(sessions, 1);
  assert.equal(appended.length, 3);
  assert.equal(opening.status, 'completed');
  assert.equal(later.status, 'completed');
  assert.doesNotMatch(appended.join('\n'), /Private understanding pass/);
  assert.match(appended[0] ?? '', /history\/user-inputs\/INDEX\.tsv/);
  assert.doesNotMatch(appended[0] ?? '', /Return send/);
  assert.doesNotMatch(appended[0] ?? '', /output contract/);
  assert.match(appended[1] ?? '', /第一条自然用户消息/);
});
