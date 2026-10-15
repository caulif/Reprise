import type { FreeformInvocation } from '../infrastructure/agent/host.js';

export async function comparisonOutputContinuation(
  invoke: (prompt: string) => Promise<FreeformInvocation>, prompt: string,
): Promise<FreeformInvocation> {
  let result = await invoke(prompt);
  while (result.status === 'yielded' && result.reason === 'output_limit') {
    result = await invoke('Continue the necessary remaining actions in this same session. The previous generation reached its output limit; no completion was certified. Preserve received evidence and current bindings.');
  }
  return result;
}
