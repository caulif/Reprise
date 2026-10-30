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

test('an exit status that arrives on the terminal update row is still journaled', () => {
  const [finished] = acpTool({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'pwsh',
    status: 'completed',
    rawOutput: { exit_code: 2 },
  });
  assert.equal(finished?.type, 'runtime.tool_finished');
  assert.equal(finished?.payload.exitCode, 2);
});

test('a raw output that is not an object claims no exit status', () => {
  const [started] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read', status: 'pending', rawOutput: 'done' });
  assert.equal('exitCode' in (started?.payload ?? {}), false);
});

test('an exit status that is not an integer claims nothing', () => {
  // A float and a numeric string are both shapes an agent invents; storing either would put a value in the Journal
  // that no consumer can compare against zero.
  for (const rawOutput of [{ exitCode: 1.5 }, { exitCode: '2' }]) {
    const [started] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'pwsh', status: 'pending', rawOutput });
    assert.equal('exitCode' in (started?.payload ?? {}), false, JSON.stringify(rawOutput));
  }
});

test('arguments longer than the cap are cut, and the cut stays visible', () => {
  const [started] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'pwsh', status: 'pending', rawInput: 'x'.repeat(4100) });
  // A stored value that is exactly the cap tells the reader the original was longer.
  assert.equal(String(started?.payload.input).length, 4000);
});

test('a Codex MCP item journals its arguments instead of a command', () => {
  const started = codexNotificationEvent('item/started', {
    item: { id: 'call-2', type: 'mcpToolCall', server: 'fs', tool: 'read_file', arguments: { path: 'a.ts' }, status: 'inProgress' },
  });
  assert.equal((started?.payload as Record<string, unknown>).input, '{"path":"a.ts"}');
  // A Codex item names its own MCP tool, so the category is only a fallback.
  assert.equal((started?.payload as Record<string, unknown>).name, 'read_file');
});

test('a title that names a file or a version stays a title', () => {
  for (const title of ['README.md', 'main.ts', 'v1.2.3', 'package.json']) {
    const [started] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title, status: 'pending' });
    assert.equal(started?.payload.title, title);
    assert.equal('name' in (started?.payload ?? {}), false, `${title} became a tool name`);
  }
  // A dotted tool name whose last segment is not an extension still names the tool.
  const [named] = acpTool({ sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'mcp.filesystem.read', status: 'pending' });
  assert.equal(named?.payload.name, 'mcp.filesystem.read');
});

test('a cut that lands inside a redaction marker does not leave a fragment', () => {
  const secret = `Bearer ${'B'.repeat(40)}`;
  const [started] = acpTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'pwsh',
    status: 'pending',
    rawInput: `${'x'.repeat(3990)} ${secret}`,
  });
  const input = String(started?.payload.input);
  assert.ok(input.length <= 4000);
  assert.doesNotMatch(input, /B{10}/);
  // Either the whole marker survives or it is gone; a half-written marker reads like data.
  assert.equal(input.includes('[REDACTED'), input.includes('[REDACTED]'));
});

test('a cut right after the first marker character leaves no fragment', () => {
  const [started] = acpTool({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'pwsh',
    status: 'pending',
    rawInput: `${'x'.repeat(3998)} ${`Bearer ${'E'.repeat(40)}`}`,
  });
  const input = String(started?.payload.input);
  // Only the marker's opening bracket fit under the cap, and a lone bracket still reads like the start of a marker.
  assert.equal(input.endsWith('['), false);
  assert.equal(input.length, 3999);
});

test('a snake_case Codex exit code is still an exit code', () => {
  const finished = codexNotificationEvent('item/completed', {
    item: { id: 'call-3', type: 'commandExecution', command: 'npm run lint', exit_code: 3 },
  });
  assert.equal((finished?.payload as Record<string, unknown>).exitCode, 3);
});

test('a Codex MCP item without a tool name falls back to its category', () => {
  const started = codexNotificationEvent('item/started', {
    item: { id: 'call-4', type: 'mcpToolCall', server: 'fs', arguments: {}, status: 'inProgress' },
  });
  // Without `item.tool` the item only declares what kind of call it is.
  assert.equal((started?.payload as Record<string, unknown>).name, 'mcpToolCall');
  assert.equal((started?.payload as Record<string, unknown>).input, '{}');
});
