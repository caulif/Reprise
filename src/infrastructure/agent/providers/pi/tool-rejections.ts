import type { Agent } from '@earendil-works/pi-agent-core';
import { sha256 } from '../../../../core/identity.js';
import type { ProviderAdapter } from '../../types.js';
import { observePiFailure } from './yield-deadline.js';

export function piToolRejections(input: Parameters<ProviderAdapter['createSession']>[0], recordFailure: (error: unknown) => void) {
  const entered = new Set<string>();
  const registered = new Set(input.tools.map(tool => tool.name));
  return {
    before(callId: string): void { entered.add(callId); },
    subscribe(agent: Agent): void {
      agent.subscribe(async event => {
        if (event.type === 'tool_execution_start') { entered.delete(event.toolCallId); return; }
        if (event.type !== 'tool_execution_end') return;
        if (entered.delete(event.toolCallId) || !event.isError) return;
        await observePiFailure(() => input.onToolRejected?.({
          tool: registered.has(event.toolName) ? event.toolName : 'unregistered_tool',
          callDigest: sha256(event.toolCallId),
        }), recordFailure);
      });
    },
  };
}
