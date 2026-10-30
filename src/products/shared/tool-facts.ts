import { text } from '../../core/json.js';
import { redactDiagnostic } from '../../infrastructure/process/stdio.js';

/**
 * A consumer displays far less of an argument than this. The stored value only needs enough headroom that a cut
 * value stays distinguishable from a complete one, so a 4100-character command is visibly longer than the cap.
 */
const INPUT_LIMIT = 4000;

const REDACTION_MARKER = '[REDACTED]';

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
  const name = toolName(text(facts.name));
  const input = inputText(facts.input);
  const exitCode = facts.exitCode;
  return {
    ...(name ? { name } : {}),
    ...(input ? { input: truncate(redactDiagnostic(input)) } : {}),
    ...(typeof exitCode === 'number' && Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

/**
 * An identifier is one token. A product that sends a sentence or a path is describing something rather than naming
 * the tool it called, so the key stays out instead of publishing a name no consumer can group by.
 */
function toolName(value: string | undefined): string | undefined {
  const name = value?.trim();
  return name && !/\s/.test(name) ? name : undefined;
}

/**
 * Agent arguments reach the Journal as text because every structure an agent invents would otherwise become an
 * on-disk shape Reprise has to keep compatible. Every caller hands over a value that came out of `JSON.parse`, so
 * `JSON.stringify` cannot fail on it and needs no guard.
 */
function inputText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Redaction runs on the unbounded text first, so a secret straddling the cap is still replaced whole. The cut must
 * then not land inside the marker itself, or the Journal keeps a fragment that reads like data.
 */
function truncate(value: string): string {
  if (value.length <= INPUT_LIMIT) return value;
  const head = value.slice(0, INPUT_LIMIT);
  for (let size = REDACTION_MARKER.length - 1; size >= 1; size -= 1) {
    if (head.endsWith(REDACTION_MARKER.slice(0, size))) return head.slice(0, head.length - size);
  }
  return head;
}
