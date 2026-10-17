import { estimateTokens } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import type { AgentUsageEstimate } from '../../../../core/schema.js';
import { classifyAgentFailure, safeAgentFailureText } from '../../failure.js';

export function failedRequestUsage(requestId: string, model: string, context: Context,
  scope: AgentUsageEstimate['scope'], message: AssistantMessage): AgentUsageEstimate | undefined {
  // Image/audio token and billing rules cannot be inferred from encoded payload sizes.
  if (context.messages.some(entry => Array.isArray(entry.content) && entry.content.some(block => block.type === 'image')))
    return undefined;
  const input = Math.ceil(((context.systemPrompt?.length ?? 0) + JSON.stringify(context.tools ?? []).length) / 4)
    + context.messages.reduce((total, entry) => total + estimateTokens(entry) + 8, 0);
  const output = estimateTokens(message);
  const error = new Error(message.errorMessage ?? 'Provider response failed without usage.');
  return { requestId, model, scope, basis: 'pi-character-heuristic-v1', reason: 'failed_request_usage_missing',
    failureKind: classifyAgentFailure(error), errorMessage: safeAgentFailureText(error.message).slice(0, 1000),
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output } };
}
