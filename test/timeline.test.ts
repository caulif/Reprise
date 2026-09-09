import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../src/core/schema.js';
import { appendTimelineEntries, projectPersistedTimeline, projectTimelineEvent, type TimelineEntry } from '../src/tui/timeline.js';
import { projectPackEntries } from './support/public-timeline.js';

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

function projectPack(type: string, payload: unknown): TimelineEntry[] {
  return projectPackEntries(event(type, payload));
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
  assert.equal(projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Edit slides.html in the current directory.' }))[0]?.detail, 'Edit slides.html in the current directory.');
  assert.deepEqual(projectTimelineEvent(event('input.submitted', { turnIndex: 0 })), []);
  assert.equal(projectTimelineEvent(event('candidate.session_bound', { sessionId: 'sess-1', productId: 'fake' }))[0]?.title, 'Candidate session · sess-1');
  assert.equal(projectTimelineEvent(event('candidate.user_view_persisted', { status: 'completed', turnIndex: 1 }))[0]?.title, 'User view · completed');

  const plan = projectPack('runtime.visible_output', {
    plan: [{ step: 'Inspect existing service', status: 'inProgress' }, { step: 'Run tests', status: 'pending' }],
  })[0];
  assert.equal(plan?.source, 'TARGET');
  assert.equal(plan?.detail, 'inProgress · Inspect existing service\npending · Run tests');
  const rawPlan = projectPersistedTimeline([event('runtime.visible_output', {
    plan: [{ step: 'Inspect existing service', status: 'inProgress' }],
  })]);
  assert.deepEqual(rawPlan, []);
  assert.deepEqual(projectTimelineEvent(event('runtime.visible_output', { plan: [] })), []);

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
    lane: 'comparison',
    kind: 'deliver',
  });
});

test('timeline keeps Codex items without journaling stream deltas', () => {
  assert.deepEqual(projectPack('codex.item_commandExecution_outputDelta', { itemId: 'call-1', delta: 'noise' }), []);

  const emptyThought = projectPack('runtime.tool_finished', { item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] } });
  assert.equal(emptyThought.length, 0);

  const thinking = projectPack('runtime.tool_started', { item: { type: 'reasoning', id: 'rs-1', summary: [], content: [] } });
  assert.equal(thinking.length, 0);

  const prompt = projectPack('runtime.visible_prompt', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'Please inspect the workspace.\n' }] },
  })[0];
  assert.equal(prompt?.title, 'Prompt · Please inspect the workspace.');
  assert.equal(prompt?.detail, 'Please inspect the workspace.\n');

  const working = projectPack('runtime.turn_started', { turnId: 'turn-1' })[0];
  assert.equal(working?.title, 'Working');
  assert.equal(working?.detail, 'The target is running this turn.');

  const runningPwsh = projectPack('runtime.tool_started', {
    item: { type: 'commandExecution', command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command Get-ChildItem', status: 'inProgress' },
  })[0];
  assert.equal(runningPwsh?.title, 'Running · pwsh · Get-ChildItem');

  const running = projectPack('runtime.tool_started', {
    item: { type: 'commandExecution', command: 'npm test', status: 'inProgress' },
  })[0];
  assert.equal(running?.title, 'Running · npm test');

  const sandbox = projectPack('runtime.tool_finished', {
    item: {
      type: 'commandExecution', command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command Get-ChildItem',
      status: 'failed', cwd: 'C:\\work', exitCode: -1, durationMs: 12,
      aggregatedOutput: 'execution error: Io(Custom { kind: Other, error: "Windows sandbox: helper_unknown_error: apply deny-read ACLs" })',
    },
  })[0];
  assert.equal(sandbox?.title, 'pwsh · Get-ChildItem');
  assert.equal(sandbox?.level, 'warning');
  assert.match(sandbox?.detail ?? '', /Sandbox blocked a path outside the isolated workspace/);
  assert.match(sandbox?.detail ?? '', /^\$ Get-ChildItem/m);
  assert.doesNotMatch(sandbox?.detail ?? '', /Io\(Custom/);
  assert.match(sandbox?.original ?? '', /cwd {2}C:\\work/);
  assert.match(sandbox?.original ?? '', /exit -1/);
  assert.match(sandbox?.original ?? '', /Io\(Custom/);
  assert.equal(running?.detail, '$ npm test');

  const thread = projectPack('runtime.session_started', { sandbox: 'danger-full-access' })[0];
  assert.equal(thread?.title, 'Sandbox · full access');
  assert.equal(thread?.source, 'HARNESS');

  const writing = projectPack('runtime.visible_output', { item: { type: 'agentMessage', id: 'msg-1', text: '' }, streaming: true })[0];
  assert.equal(writing?.title, 'Writing');
  assert.equal(writing?.detail, 'The target is writing a reply.');
  assert.equal(writing?.itemId, 'msg-1');

  const command = projectPack('runtime.tool_finished', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' },
  })[0];
  assert.equal(command?.title, 'npm test');
  assert.match(command?.detail ?? '', /^\$ npm test/);
  assert.doesNotMatch(command?.detail ?? '', /^Command$/m);
  assert.doesNotMatch(command?.detail ?? '', /^Output$/m);
  assert.match(command?.detail ?? '', /one/);
  assert.match(command?.original ?? '', /^npm test\none/);
  assert.match(command?.original ?? '', /seven/);

  const longCommandOutput = `${Array.from({ length: 200 }, (_, index) => `public output ${index + 1}`).join('\n')}\nCOMMAND_OUTPUT_END`;
  const fullCommand = projectPack('runtime.tool_finished', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: longCommandOutput },
  })[0];
  assert.match(fullCommand?.detail ?? '', /public output 1/);
  assert.match(fullCommand?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.doesNotMatch(fullCommand?.detail ?? '', /COMMAND_OUTPUT_END/);
  assert.match(fullCommand?.original ?? '', /COMMAND_OUTPUT_END/);

  const longScript = `"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "${'Get-ChildItem -Recurse | Format-Table; '.repeat(12)}"`;
  const longOneLiner = projectPack('runtime.tool_finished', {
    item: { type: 'commandExecution', command: longScript, status: 'completed', cwd: 'C:\\\\work', exitCode: 0, durationMs: 12, aggregatedOutput: 'Mode Length Name\n---- ------ ----' },
  })[0];
  assert.match(longOneLiner?.title ?? '', /^pwsh · Get-ChildItem/);
  assert.match(longOneLiner?.detail ?? '', /^\$ Get-ChildItem/);
  assert.match(longOneLiner?.detail ?? '', /Mode Length Name/);
  assert.match(longOneLiner?.detail ?? '', /exit 0/);
  assert.doesNotMatch(longOneLiner?.detail ?? '', /Program Files/);
  assert.doesNotMatch(longOneLiner?.detail ?? '', /^Command$/m);
  assert.match(longOneLiner?.original ?? '', /Program Files/);

  const runningLong = projectPack('runtime.tool_started', {
    item: { type: 'commandExecution', command: longScript, status: 'inProgress' },
  })[0];
  assert.doesNotMatch(runningLong?.detail ?? '', /Program Files/);
  assert.match(runningLong?.original ?? '', /Program Files/);
  assert.match(runningLong?.detail ?? '', /^\$ Get-ChildItem/);

  const nested = '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command \'$target=\'"\'C:\\\\software\\\\weixdocuments\\\\xwechat_files\'; Get-ChildItem -LiteralPath $target\'';
  const nestedCompleted = projectPack('runtime.tool_finished', {
    item: {
      type: 'commandExecution', command: nested, status: 'completed', exitCode: 0, durationMs: 466,
      cwd: 'C:\\\\Users\\\\15893\\\\Documents\\\\model-test\\\\Reprise\\\\.reprise\\\\experiments\\\\exp\\\\environment\\\\runs\\\\run-e35ec7e8-b8b9-4979-a961-014a6c4d20bd',
      commandActions: [{ type: 'unknown', command: '$target=C:\\\\software\\\\weixdocuments\\\\xwechat_files' }],
      aggregatedOutput: 'Mode  Length Name\n----  ------ ----\nd----       Backup',
    },
  })[0];
  assert.equal(nestedCompleted?.title, 'pwsh · Get-ChildItem');
  assert.match(nestedCompleted?.detail ?? '', /^\$ Get-ChildItem/);
  assert.match(nestedCompleted?.detail ?? '', /Backup/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /unknown:/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /Program Files/);
  assert.doesNotMatch(nestedCompleted?.detail ?? '', /isolated workspace/);
  assert.match(nestedCompleted?.original ?? '', /unknown:/);
  assert.match(nestedCompleted?.original ?? '', /run-e35ec7e8/);

  const streaming: TimelineEntry[] = [];
  appendTimelineEntries(streaming, projectPack('runtime.tool_started', {
    item: { type: 'commandExecution', id: 'cmd-stream', command: nested, status: 'inProgress' },
  }));
  appendTimelineEntries(streaming, projectPack('runtime.tool_finished', {
    item: {
      type: 'commandExecution', id: 'cmd-stream', command: nested, status: 'completed',
      aggregatedOutput: 'Mode\nfile-7.txt\n',
    },
  }));
  assert.doesNotMatch(streaming[0]?.detail ?? '', /Program Files/);
  assert.match(streaming[0]?.title ?? '', /^pwsh · Get-ChildItem|^Running · pwsh/);
  assert.match(streaming[0]?.original ?? streaming[1]?.original ?? '', /file-7\.txt/);

  const response = projectPack('runtime.visible_output', { item: { type: 'agentMessage', text: 'Visible final answer.' } })[0];
  assert.equal(response?.title, 'Visible response');
  assert.equal(response?.detail, 'Visible final answer.');
});

test('timeline replaces a streaming visible output with the settled reply', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectPack('runtime.visible_output', { item: { type: 'agentMessage', id: 'msg-1', text: '' }, streaming: true }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'Writing');
  appendTimelineEntries(timeline, projectPack('runtime.visible_output', { item: { type: 'agentMessage', id: 'msg-1', text: '可以帮你导出记录。' } }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'Visible response');
  assert.equal(timeline[0]?.detail, '可以帮你导出记录。');
});

test('timeline updates MCP and token rows in place', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectPack('runtime.tool_started', { name: 'github', status: 'starting' }));
  appendTimelineEntries(timeline, projectPack('runtime.tool_started', {
    name: 'github', status: 'failed', error: 'GITHUB_PAT_TOKEN is not set',
  }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.title, 'MCP · github failed');
  assert.equal(timeline[0]?.level, 'warning');
  assert.match(timeline[0]?.detail ?? '', /GITHUB_PAT_TOKEN/);

  appendTimelineEntries(timeline, projectPack('runtime.usage_reported', {
    tokenUsage: { total: { totalTokens: 24648, inputTokens: 23803, outputTokens: 845, reasoningOutputTokens: 462 } },
  }));
  assert.equal(timeline.length, 2);
  assert.equal(timeline[1]?.title, 'Tokens · 24,648');
  assert.match(timeline[1]?.detail ?? '', /reasoning 462/);
});

test('timeline caps an oversized command output and points at the trace for the rest', () => {
  const output = 'x'.repeat(40_000);
  const entry = projectPack('runtime.tool_finished', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: output },
  })[0];
  assert.match(entry?.detail ?? '', /^\$ npm test/);
  assert.match(entry?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.ok((entry?.detail?.length ?? 0) < 4_000);
  assert.match(entry?.original ?? '', /truncated \d+ characters; remainder is in the run trace\.$/);

  const message = projectPack('runtime.visible_output', { item: { type: 'agentMessage', text: output } })[0];
  assert.match(message?.detail ?? '', /\.\.\. \+\d+ lines/);
  assert.match(message?.original ?? '', /truncated \d+ characters/);
});

test('timeline keeps target stderr in the trace instead of the operator list', () => {
  assert.deepEqual(projectTimelineEvent(event('codex.codex.stderr', { line: 'windows sandbox: helper_unknown_error' })), []);
});

test('timeline drops a second Prompt with the same title', () => {
  const timeline = [...projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Please inspect the workspace.' }))];
  appendTimelineEntries(timeline, projectPack('runtime.visible_prompt', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'Please inspect the workspace.' }] },
  }));
  assert.equal(timeline.filter((entry) => entry.title.startsWith('Prompt ·')).length, 1);
});

test('send and input.submitted keep one presented user sentence', () => {
  const timeline: TimelineEntry[] = [];
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: message })));
  const presented = timeline.filter((entry) => entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·'));
  assert.equal(presented.length, 1);
  assert.equal(presented[0]?.title, 'Input to Target');
});

test('recovery timeline keeps inspect, shell_exec, writes, and failures visible', () => {
  const listed = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'ls', params: { path: '.' } }))[0];
  const deleted = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'shell_exec', params: { command: 'Remove-Item ppt_build/out.pptx' } }))[0];
  const reported = projectTimelineEvent(event('agent.tool_completed', { role: 'recovery', tool: 'write', params: { path: 'recovery.md' } }))[0];
  const failed = projectTimelineEvent(event('agent.tool_failed', { role: 'recovery', tool: 'read_observation', message: 'tool budget exhausted' }))[0];
  assert.equal(listed?.hidden, undefined);
  assert.match(listed?.title ?? '', /Recovery · inspect/);
  assert.equal(deleted?.hidden, undefined);
  assert.match(deleted?.detail ?? '', /Remove-Item/);
  assert.equal(reported?.hidden, undefined);
  assert.match(reported?.detail ?? '', /recovery.md/);
  assert.equal(failed?.hidden, undefined);
  assert.equal(failed?.level, 'error');
  const duplicate = projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'ls',
    message: 'path not found',
  }))[0];
  assert.equal(duplicate?.hidden, undefined);
  assert.equal(duplicate?.level, 'error');
});

test('recovery timeline collapses identical consecutive tool failures', () => {
  const timeline: TimelineEntry[] = [];
  const message = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
  for (let index = 0; index < 34; index += 1) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'recovery',
      tool: 'shell_exec',
      message,
    })));
  }
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0]?.detail ?? '', / ×34$/);
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'shell_exec',
    message: 'Recovery tool-call budget of 64 was exhausted.',
  })));
  assert.equal(timeline.filter((entry) => !entry.hidden).length, 2);
});

test('shell_exec completion is visible when git reports the candidate is not a repository', () => {
  const entry = projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery',
    tool: 'shell_exec',
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
  assert.equal(started?.hidden, true);
  assert.equal(started?.detail, undefined);
  assert.doesNotMatch(JSON.stringify(started), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test('persisted public activity does not require the original pack at read time', () => {
  const timeline = projectPersistedTimeline([
    event('recovery.completed', { status: 'recovered' }),
    event('runtime.public_activity', {
      schemaVersion: 1,
      sourceEventId: 'src-1',
      sourceEventType: 'unknown-product.item',
      activity: { kind: 'message', text: 'Visible reply from a missing pack.' },
    }),
    event('run.outcome_created', {
      task: { status: 'apparently_completed', evidenceRefs: [] },
      termination: { kind: 'completed', code: 'completed.controller_done', initiatedBy: 'controller' },
      cleanup: { status: 'complete' },
    }),
  ]);
  assert.equal(timeline.some((entry) => entry.title === 'Recovery recovered'), true);
  assert.equal(timeline.some((entry) => entry.title === 'Visible response' && entry.detail === 'Visible reply from a missing pack.'), true);
  assert.equal(timeline.some((entry) => entry.title === 'Task · apparently_completed'), true);
  assert.equal(timeline.some((entry) => entry.title.startsWith('Termination · completed')), true);
  assert.equal(timeline.some((entry) => entry.title === 'Cleanup · complete'), true);
});


