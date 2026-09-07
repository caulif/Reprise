import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ControllerAgent, CONTROLLER_SYSTEM_PROMPT, type SteeringContext } from '../src/agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../src/infrastructure/pi-agent-host.js';
import { controllerPromptContent, renderIndexMarkdown } from '../src/application/controller-briefing.js';

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
          assert.match(session.systemPrompt, /acceptance habits/);
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
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Do not fire historical user sentences in sequence/);
  assert.match(CONTROLLER_SYSTEM_PROMPT, /Do not send historical sentences merely to exhaust them/);
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

test('Controller understanding pass returns a private task image before opening', async () => {
  const appended: string[] = [];
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession() {
        return {
          append: async ({ content }) => {
            appended.push(content);
            if (content.includes('Private understanding pass')) {
              return JSON.stringify({
                markdown: '用户先要 HTML，后续明确要求新建 PPT 并复刻 HTML。',
                sourceMessageIds: ['message-1', 'message-350'],
                unresolvedActions: ['新建白底 PPT 并复刻三页 HTML'],
              });
            }
            return JSON.stringify({ type: 'send', intent: 'continue', message: '先查看当前材料。' });
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const base = briefing({ includeFollowupInIndex: false, settledTurns: 0 });
  const result = await controller.understand?.({ ...base, phase: 'opening', runState: 'created' });
  assert.equal(result?.status, 'completed');
  if (result?.status === 'completed') {
    assert.match(result.value.markdown, /PPT/);
    assert.deepEqual(result.value.sourceMessageIds, ['message-1', 'message-350']);
    assert.deepEqual(result.value.unresolvedActions, ['新建白底 PPT 并复刻三页 HTML']);
  }
  assert.match(appended[0] ?? '', /Private understanding pass/);
});
