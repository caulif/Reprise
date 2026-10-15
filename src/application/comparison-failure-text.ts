import { safeAgentFailureText } from '../infrastructure/agent/failure.js';

export function comparisonFailureText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    if (current instanceof AggregateError) {
      for (let index = current.errors.length - 1; index >= 0; index--) pending.push(current.errors[index]);
    }
  }
  return safeAgentFailureText(messages.join(' | '));
}
