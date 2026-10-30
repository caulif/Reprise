import { text } from '../../core/json.js';
import { redactDiagnostic } from '../../infrastructure/process/stdio.js';

/**
 * A consumer displays far less of an argument than this. The stored value only needs enough headroom that a cut
 * value stays distinguishable from a complete one, so a 4100-character command is visibly longer than the cap.
 */
const INPUT_LIMIT = 4000;

/**
 * Product-neutral tool facts for `runtime.tool_started` / `runtime.tool_finished`.
 *
 * A product that does not report a fact leaves the key out: absent means "this product does not say", while a
 * zero or an empty string would claim the tool ran without arguments or exited successfully. `name` is the
 * tool's own identifier as the product names it, never a human-readable title.
 */
export function toolFacts(facts: { name?: unknown; input?: unknown; exitCode?: unknown }): {
  name?: string;
  input?: string;
  exitCode?: number;
} {
  const name = text(facts.name)?.trim();
  const input = inputText(facts.input);
  const exitCode = facts.exitCode;
  return {
    ...(name ? { name } : {}),
    ...(input ? { input: redactDiagnostic(input).slice(0, INPUT_LIMIT) } : {}),
    ...(typeof exitCode === 'number' && Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

/**
 * Agent arguments reach the Journal as text because every structure an agent invents would otherwise become an
 * on-disk shape Reprise has to keep compatible.
 */
function inputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
