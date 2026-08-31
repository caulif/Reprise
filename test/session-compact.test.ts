import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { compactAgentMessages } from '../src/infrastructure/session-compact.js';
import { PiAgentHost, type AgentAuditEvent } from '../src/infrastructure/pi-agent-host.js';
import { sha256 } from '../src/core/identity.js';

test('compactAgentMessages keeps the latest tool batch and digests earlier tool bodies', () => {
  const first = { role: 'toolResult', toolName: 'ls', toolCallId: '1', content: [{ type: 'text', text: 'FIRST_BODY' }] };
  const assistant = { role: 'assistant', content: [] };
  const second = { role: 'toolResult', toolName: 'read', toolCallId: '2', content: [{ type: 'text', text: 'SECOND_BODY' }] };
  const compacted = compactAgentMessages([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    first,
    assistant,
    second,
  ]);
  assert.equal(compacted.replaced.length, 1);
  assert.equal(compacted.replaced[0]?.digest, sha256('FIRST_BODY'));
  const compactedText = (compacted.messages[1] as { content: { text: string }[] }).content[0]!.text;
  const marker = JSON.parse(compactedText) as { compacted: boolean };
  assert.equal(marker.compacted, true);
  assert.match(JSON.stringify(compacted.messages[3]), /SECOND_BODY/);
  assert.doesNotMatch(JSON.stringify(compacted.messages[3]), /compacted":true/);
});

test('compactAgentMessages refuses to treat a mismatched digest as the original body', () => {
  const first = { role: 'toolResult', toolName: 'ls', toolCallId: '1', content: [{ type: 'text', text: 'FIRST_BODY' }] };
  const compacted = compactAgentMessages([{ role: 'assistant', content: [] }, first, { role: 'assistant', content: [] }]);
  const stored = compacted.replaced[0];
  assert.ok(stored);
  assert.notEqual(stored.digest, sha256('NOT_THE_ORIGINAL'));
  assert.equal(stored.digest, sha256('FIRST_BODY'));
});

test('Host records agent.context_compacted from the Pi session compact hook', async () => {
  const events: AgentAuditEvent[] = [];
  let compact: ((payload: { replaced: readonly { toolName: string; digest: string; byteLength: number }[] }) => Promise<void>) | undefined;
  const host = new PiAgentHost({
    createSession: (input) => {
      compact = input.onContextCompact;
      return {
        append: async () => JSON.stringify({ ok: true }),
        cancel() {},
      };
    },
  });
  const result = await host.request({
    role: 'recovery',
    systemPrompt: 'fixed prompt',
    context: {},
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    audit: {
      append: async (event) => {
        events.push(event);
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(typeof compact, 'function');
  await compact!({
    replaced: [{ toolName: 'ls', digest: 'a'.repeat(64), byteLength: 12 }],
  });
  assert.ok(events.some((event) => event.type === 'agent.context_compacted'));
});
