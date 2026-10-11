import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Preserve all received tool evidence and call pairing; omit assistant narration for save-only inference. */
export function evidenceContext(messages: AgentMessage[]): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    if (message.role !== 'assistant') return [message];
    const calls = message.content.filter(block => block.type === 'toolCall');
    return calls.length ? [{ ...message, content: calls }] : [];
  });
}
