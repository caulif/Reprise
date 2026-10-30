import test from 'node:test';
import assert from 'node:assert/strict';
import { acpSessionUpdateEvents } from '../../src/products/shared/acp/events.js';
import { claudeFrameEvents } from '../../src/products/packs/claude-code/protocol.js';
import { codexNotificationEvent } from '../../src/products/packs/codex/protocol.js';

/** Tool payloads only, because the adapters also emit text rows the tool facts do not belong to. */
function toolPayloads(events: readonly { type: string; payload: unknown }[]): { type: string; payload: Record<string, unknown> }[] {
  return events
    .filter((event) => event.type === 'runtime.tool_started' || event.type === 'runtime.tool_finished')
    .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }));
}

function acpTool(update: Record<string, unknown>) {
  return toolPayloads(acpSessionUpdateEvents('s1', { sessionId: 's1', update }));
}

test('an ACP tool call journals its arguments, its tool name and its exit status', () => {
  const [started, finished] = acpTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-9',
    title: 'grep',
    kind: 'search',
    status: 'completed',
    rawInput: { pattern: 'usage', path: 'src' },
    rawOutput: { exitCode: 1 },
  });
  assert.equal(started?.type, 'runtime.tool_started');
  assert.equal(finished?.type, 'runtime.tool_finished');
  // The terminal `tool_call` is the only record of that tool, so both rows must carry the same facts.
  for (const event of [started, finished]) {
    assert.equal(event?.payload.name, 'grep');
    assert.equal(event?.payload.input, '{"pattern":"usage","path":"src"}');
    assert.equal(event?.payload.exitCode, 1);
    // The agent's own title is kept verbatim, never replaced by the derived name.
    assert.equal(event?.payload.title, 'grep');
  }
});

test('an ACP title that is a sentence stays a title and is never promoted to a tool name', () => {
  const [started] = acpTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read experiment-history-list.ts',
    kind: 'read',
    status: 'pending',
  });
  assert.equal(started?.payload.title, 'Read experiment-history-list.ts');
  assert.equal('name' in (started?.payload ?? {}), false);
});

test('an ACP update that reports no arguments and no exit status claims neither', () => {
  const [started] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read', kind: 'read', status: 'pending' });
  assert.equal(started?.payload.name, 'read');
  // Absent is "the agent did not say"; a zero or an empty string would claim a real value.
  assert.equal('input' in (started?.payload ?? {}), false);
  assert.equal('exitCode' in (started?.payload ?? {}), false);
});

test('agent-supplied arguments reach the Journal redacted', () => {
  const [started] = acpTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'pwsh',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: `curl -H "Authorization: Bearer ${'A'.repeat(40)}"` },
  });
  const input = String(started?.payload.input);
  assert.match(input, /\[REDACTED\]/);
  assert.doesNotMatch(input, /A{40}/);
});

test('a Claude tool_use journals the tool name and its arguments', () => {
  const events = claudeFrameEvents({
    type: 'assistant',
    sessionId: 's1',
    message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] },
  });
  const [started] = toolPayloads(events);
  assert.equal(started?.payload.callId, 'toolu_1');
  assert.equal(started?.payload.name, 'Bash');
  assert.equal(started?.payload.input, '{"command":"npm test"}');
});

test('a Codex item journals the tool name, the command and its exit code', () => {
  const started = codexNotificationEvent('item/started', {
    item: { id: 'call-1', type: 'commandExecution', command: 'npm test', status: 'inProgress' },
  });
  const finished = codexNotificationEvent('item/completed', {
    item: { id: 'call-1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 },
  });
  assert.equal((started?.payload as Record<string, unknown>).name, 'commandExecution');
  assert.equal((started?.payload as Record<string, unknown>).input, 'npm test');
  // A zero exit code is a fact, so it must survive the "only publish what was reported" rule.
  assert.equal((finished?.payload as Record<string, unknown>).exitCode, 0);
});
