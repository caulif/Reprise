import type { CodexReasoningEffort, CodexRuntimeOptions } from '../src/products/packs/codex/runtime.js';
import { CodexTextCaller } from '../src/products/packs/codex/text-caller.js';

/** Runs one tool-less app-server exchange; Host tools are intentionally outside this protocol smoke. */
export async function runToollessCodexProbe(input: { model: string; effort: CodexReasoningEffort; systemPrompt: string; context: unknown; options?: CodexRuntimeOptions }): Promise<string> {
  const session = new CodexTextCaller({ model: input.model, effort: input.effort, ...(input.options ? { options: input.options } : {}) }).createSession({
    sessionId: 'reprise-codex-protocol-smoke',
    systemPrompt: input.systemPrompt,
    tools: [],
  });
  const controller = new AbortController();
  try {
    return await session.append({ content: JSON.stringify(input.context), signal: controller.signal });
  } finally {
    controller.abort();
    session.cancel();
  }
}
