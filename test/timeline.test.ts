import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../src/core/schema.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../src/tui/timeline.js';

const timestamp = '2026-08-10T11:33:12.000Z';

function event(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

test('timeline projects operator-relevant persisted facts', () => {
  assert.deepEqual(projectTimelineEvent(event('run.state_changed', { from: 'created', to: 'preparing' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'HARNESS',
    title: 'State: created → preparing',
    hidden: true,
  });

  assert.deepEqual(projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Fix the failing test.' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'TARGET',
    title: 'Prompt · Fix the failing test.',
    detail: 'Fix the failing test.',
  });
  assert.deepEqual(projectTimelineEvent(event('input.submitted', { turnIndex: 0 })), []);

  const plan = projectTimelineEvent(event('codex.turn_plan_updated', {
    plan: [{ step: 'Inspect existing service', status: 'inProgress' }, { step: 'Run tests', status: 'pending' }],
  }))[0];
  assert.equal(plan?.source, 'TARGET');
  assert.equal(plan?.detail, 'inProgress · Inspect existing service\npending · Run tests');

  const sent = projectTimelineEvent(event('controller.decision', {
    status: 'completed', sessionId: 'controller-1', value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
  }));
  assert.deepEqual(sent.map(({ title, detail }) => ({ title, detail })), [
    { title: 'Decision: SEND', detail: 'One check remains.' },
    { title: 'Input to Target', detail: 'Run the focused test.' },
  ]);

  const done = projectTimelineEvent(event('controller.decision', {
    status: 'completed', sessionId: 'controller-1', value: { type: 'done', reason: 'blocked', rationale: 'Sandbox denied the path.' },
  }))[0];
  assert.equal(done?.title, 'Decision: DONE · blocked');
  assert.equal(done?.detail, 'Sandbox denied the path.');
  assert.deepEqual(projectTimelineEvent(event('controller.decision', { status: 'failed', failure: { message: 'Model text is disallowed by TaskCase privacy policy.' } })), []);

  assert.equal(projectTimelineEvent(event('run.stop_requested', { code: 'blocked.controller_done', reason: 'failed' }))[0]?.title, 'Candidate stopped · blocked');
  assert.equal(projectTimelineEvent(event('run.stop_requested', { code: 'failed.controller', reason: 'failed' }))[0]?.title, 'Stop requested: failed');

  assert.deepEqual(projectTimelineEvent(event('controller.done', { reason: 'satisfied' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Done: satisfied',
    hidden: true,
  });

  assert.deepEqual(projectTimelineEvent(event('comparison.completed', { status: 'failed', failure: { message: 'missing narrative' } }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Comparison failed',
    detail: 'missing narrative',
    level: 'error',
  });
});

test('timeline keeps Codex items and merges streamed deltas into one row', () => {
  assert.equal(projectTimelineEvent(event('codex.item_commandExecution_outputDelta', { itemId: 'call-1', delta: 'noise' }))[0]?.patch, 'append');
  assert.equal(projectTimelineEvent(event('codex.item_commandExecution_outputDelta', { itemId: 'call-1', delta: 'noise' }))[0]?.detail, 'noise');

  const emptyThought = projectTimelineEvent(event('codex.item_completed', { item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] } }))[0];
  assert.equal(emptyThought?.hidden, true);

  const thinking = projectTimelineEvent(event('codex.item_started', { item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] } }))[0];
  assert.equal(thinking?.title, 'Thinking');
  assert.equal(thinking?.itemId, 'rs-1');

  const prompt = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'Please inspect the workspace.\n' }] },
  }))[0];
  assert.equal(prompt?.title, 'Prompt · Please inspect the workspace.');
  assert.equal(prompt?.detail, 'Please inspect the workspace.\n');

  const working = projectTimelineEvent(event('codex.turn_started', { turnId: 'turn-1' }))[0];
  assert.equal(working?.title, 'Working');
  assert.equal(working?.detail, 'The target is running this turn.');

  const runningPwsh = projectTimelineEvent(event('codex.item_started', {
    item: { type: 'commandExecution', command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command Get-ChildItem', status: 'inProgress' },
  }))[0];
  assert.equal(runningPwsh?.title, 'Running · pwsh · Get-ChildItem');

  const running = projectTimelineEvent(event('codex.item_started', {
    item: { type: 'commandExecution', command: 'npm test', status: 'inProgress' },
  }))[0];
  assert.equal(running?.title, 'Running · npm test');

  const sandbox = projectTimelineEvent(event('codex.item_completed', {
    item: {
      type: 'commandExecution', command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command Get-ChildItem',
      status: 'failed', cwd: 'C:\\work', exitCode: -1, durationMs: 12,
      aggregatedOutput: 'execution error: Io(Custom { kind: Other, error: "Windows sandbox: helper_unknown_error: apply deny-read ACLs" })',
    },
  }))[0];
  assert.equal(sandbox?.title, 'pwsh · Get-ChildItem');
  assert.equal(sandbox?.level, 'warning');
  assert.match(sandbox?.detail ?? '', /Sandbox blocked a path outside the isolated workspace/);
  assert.match(sandbox?.detail ?? '', /^\$ Get-ChildItem/m);
  assert.doesNotMatch(sandbox?.detail ?? '', /Io\(Custom/);
  assert.match(sandbox?.original ?? '', /cwd {2}C:\\work/);
  assert.match(sandbox?.original ?? '', /exit -1/);
  assert.match(sandbox?.original ?? '', /Io\(Custom/);
  assert.equal(running?.detail, '$ npm test');

  const thread = projectTimelineEvent(event('codex.thread_started', { sandbox: 'danger-full-access' }))[0];
  assert.equal(thread?.title, 'Sandbox · full access');
  assert.equal(thread?.source, 'HARNESS');

  const writing = projectTimelineEvent(event('codex.item_started', { item: { type: 'agentMessage', id: 'msg-1', text: '' } }))[0];
  assert.equal(writing?.title, 'Writing');
  assert.equal(writing?.detail, 'The target is writing a reply.');
  assert.equal(writing?.itemId, 'msg-1');

  const command = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' },
  }))[0];
  assert.equal(command?.title, 'npm test');
  assert.match(command?.detail ?? '', /^\$ npm test/);
  assert.doesNotMatch(command?.detail ?? '', /^Command$/m);
  assert.doesNotMatch(command?.detail ?? '', /^Output$/m);
  assert.match(command?.detail ?? '', /one/);
  assert.match(command?.original ?? '', /^npm test\none/);
  assert.match(command?.original ?? '', /seven/);

  const longCommandOutput = `${Array.from({ length: 200 }, (_, index) => `public output ${index + 1}`).join('\n')}\nCOMMAND_OUTPUT_END`;
  const fullCommand = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: longCommandOutput },
  }))[0];
  assert.match(fullCommand?.detail ?? '', /public output 1/);
  assert.match(fullCommand?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.doesNotMatch(fullCommand?.detail ?? '', /COMMAND_OUTPUT_END/);
  assert.match(fullCommand?.original ?? '', /COMMAND_OUTPUT_END/);

  const longScript = `"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "${'Get-ChildItem -Recurse | Format-Table; '.repeat(12)}"`;
  const longOneLiner = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: longScript, status: 'completed', cwd: 'C:\\\\work', exitCode: 0, durationMs: 12, aggregatedOutput: 'Mode Length Name\n---- ------ ----' },
  }))[0];
  assert.match(longOneLiner?.title ?? '', /^pwsh · Get-ChildItem/);
  assert.match(longOneLiner?.detail ?? '', /^\$ Get-ChildItem/);
  assert.match(longOneLiner?.detail ?? '', /Mode Length Name/);
  assert.match(longOneLiner?.detail ?? '', /exit 0/);
  assert.doesNotMatch(longOneLiner?.detail ?? '', /Program Files/);
  assert.doesNotMatch(longOneLiner?.detail ?? '', /^Command$/m);
  assert.match(longOneLiner?.original ?? '', /Program Files/);

  const runningLong = projectTimelineEvent(event('codex.item_started', {
    item: { type: 'commandExecution', command: longScript, status: 'inProgress' },
  }))[0];
  assert.doesNotMatch(runningLong?.detail ?? '', /Program Files/);
  assert.match(runningLong?.original ?? '', /Program Files/);
  assert.match(runningLong?.detail ?? '', /^\$ Get-ChildItem/);

  const nested = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command \'$target=\'"\'C:\\\\software\\\\weixdocuments\\\\xwechat_files\'; Get-ChildItem -LiteralPath $target\'';
  const nestedCompleted = projectTimelineEvent(event('codex.item_completed', {
    item: {
      type: 'commandExecution', command: nested, status: 'completed', exitCode: 0, durationMs: 466,
      cwd: 'C:\\\\Users\\\\15893\\\\Documents\\\\model-test\\\\Reprise\\\\.reprise\\\\experiments\\\\exp\\\\environment\\\\runs\\\\run-e35ec7e8-b8b9-4979-a961-014a6c4d20bd',
      commandActions: [{ type: 'unknown', command: '$target=C:\\\\software\\\\weixdocuments\\\\xwechat_files' }],
      aggregatedOutput: 'Mode  Length Name\n----  ------ ----\nd----       Backup',
    },
  }))[0];
  assert.equal(nestedCompleted?.title, 'pwsh · Get-ChildItem');
  assert.match(nestedCompleted?.detail ?? '', /^\$ Get-ChildItem/);
  assert.match(nestedCompleted?.detail ?? '', /Backup/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /unknown:/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /Program Files/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /isolated workspace/);
  assert.match(nestedCompleted?.original ?? '', /unknown:/);
  assert.match(nestedCompleted?.original ?? '', /run-e35ec7e8/);

  const streaming: TimelineEntry[] = [];
  appendTimelineEntries(streaming, projectTimelineEvent(event('codex.item_started', {
    item: { type: 'commandExecution', id: 'cmd-stream', command: nested, status: 'inProgress' },
  })));
  appendTimelineEntries(streaming, projectTimelineEvent(event('codex.item_commandExecution_outputDelta', { itemId: 'cmd-stream', delta: 'Mode\n' })));
  for (let index = 0; index < 8; index += 1) {
    appendTimelineEntries(streaming, projectTimelineEvent(event('codex.item_commandExecution_outputDelta', {
      itemId: 'cmd-stream', delta: `file-${index}.txt\n`,
    })));
  }
  assert.doesNotMatch(streaming[0]?.detail ?? '', /Program Files/);
  assert.match(streaming[0]?.title ?? '', /^Running · pwsh/);
  assert.match(streaming[0]?.original ?? '', /file-7\.txt/);

  const response = projectTimelineEvent(event('codex.item_completed', { item: { type: 'agentMessage', text: 'Visible final answer.' } }))[0];
  assert.equal(response?.title, 'Visible response');
  assert.equal(response?.detail, 'Visible final answer.');
});

test('timeline merges agentMessage deltas into the Writing row then keeps the completed reply', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.item_started', { item: { type: 'agentMessage', id: 'msg-1', text: '' } })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.item_agentMessage_delta', { itemId: 'msg-1', delta: '可以' })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.item_agentMessage_delta', { itemId: 'msg-1', delta: '帮你' })));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'Writing');
  assert.equal(timeline[0]?.detail, '可以帮你');
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.item_completed', { item: { type: 'agentMessage', id: 'msg-1', text: '可以帮你导出记录。' } })));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'Visible response');
  assert.equal(timeline[0]?.detail, '可以帮你导出记录。');
});

test('timeline updates MCP and token rows in place', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.mcpServer_startupStatus_updated', { name: 'github', status: 'starting' })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.mcpServer_startupStatus_updated', {
    name: 'github', status: 'failed', error: 'GITHUB_PAT_TOKEN is not set',
  })));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'MCP · github failed');
  assert.equal(timeline[0]?.level, 'warning');
  assert.match(timeline[0]?.detail ?? '', /GITHUB_PAT_TOKEN/);

  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.thread_tokenUsage_updated', {
    tokenUsage: { total: { totalTokens: 24648, inputTokens: 23803, outputTokens: 845, reasoningOutputTokens: 462 } },
  })));
  assert.equal(timeline.length, 2);
  assert.equal(timeline[1]?.title, 'Tokens · 24,648');
  assert.match(timeline[1]?.detail ?? '', /reasoning 462/);
});

test('timeline caps an oversized command output and points at the trace for the rest', () => {
  const output = 'x'.repeat(40_000);
  const entry = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: output },
  }))[0];
  assert.match(entry?.detail ?? '', /^\$ npm test/);
  assert.match(entry?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.ok((entry?.detail?.length ?? 0) < 4_000);
  assert.match(entry?.original ?? '', /truncated \d+ characters; remainder is in the run trace\.$/);

  const message = projectTimelineEvent(event('codex.item_completed', { item: { type: 'agentMessage', text: output } }))[0];
  assert.match(message?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.match(message?.original ?? '', /truncated \d+ characters/);
});

test('timeline keeps target stderr in the trace instead of the operator list', () => {
  assert.deepEqual(projectTimelineEvent(event('codex.codex.stderr', { line: 'windows sandbox: helper_unknown_error' })), []);
});

test('timeline drops a second Prompt with the same title', () => {
  const timeline = [...projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Please inspect the workspace.' }))];
  appendTimelineEntries(timeline, projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'Please inspect the workspace.' }] },
  })));
  assert.equal(timeline.filter((entry) => entry.title.startsWith('Prompt ·')).length, 1);
});

test('recovery timeline keeps report writes, powershell, and failures visible', () => {
  const listed = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'ls' }))[0];
  const deleted = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'powershell', params: { command: 'Remove-Item ppt_build/out.pptx' } }))[0];
  const reported = projectTimelineEvent(event('agent.tool_completed', { role: 'recovery', tool: 'write' }))[0];
  const failed = projectTimelineEvent(event('agent.tool_failed', { role: 'recovery', tool: 'read_observation', message: 'tool budget exhausted' }))[0];
  assert.equal(listed?.hidden, true);
  assert.equal(deleted?.hidden, undefined);
  assert.equal(reported?.hidden, undefined);
  assert.equal(failed?.hidden, undefined);
  assert.equal(failed?.level, 'error');
});

test('recovery timeline collapses identical consecutive tool failures', () => {
  const timeline: TimelineEntry[] = [];
  const message = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
  for (let index = 0; index < 34; index += 1) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'recovery',
      tool: 'powershell',
      message,
    })));
  }
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0]?.detail ?? '', / ×34$/);
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'powershell',
    message: 'Recovery tool-call budget of 64 was exhausted.',
  })));
  assert.equal(timeline.filter((entry) => !entry.hidden).length, 2);
});

test('powershell completion is visible when git reports the candidate is not a repository', () => {
  const entry = projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery',
    tool: 'powershell',
    content: 'fatal: not a git repository (or any of the parent directories): .git',
  }))[0];
  assert.equal(entry?.hidden, undefined);
  assert.match(entry?.detail ?? '', /不是 Git 仓库/);
});

test('recovery start does not show a source digest as timeline detail', () => {
  const started = projectTimelineEvent(event('recovery.started', {
    sourceDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }))[0];
  assert.equal(started?.title, 'Recovery started');
  assert.equal(started?.detail, undefined);
  assert.doesNotMatch(JSON.stringify(started), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});
