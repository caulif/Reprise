import { Value } from '@sinclair/typebox/value';
import { ComparisonResultSchema, ControllerDecisionSchema, RecoveryAgentEnvelopeSchema, RecoveryDecisionSchema } from '../../core/schema.js';

const MAX_VISIBLE_CHARS = 4_096;

export function visibleAssistantText(content: readonly { type?: string; text?: string }[] | undefined): string {
  if (!content?.length) return "";
  const text = stripThinkBlocks(
    content
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => block.text?.trim() ?? "")
      .join("\n")
      .trim(),
  );
  if (!text) return "";
  const spoken = peelStructuredEnvelope(text);
  if (!spoken) return "";
  return spoken.length > MAX_VISIBLE_CHARS ? `${spoken.slice(0, MAX_VISIBLE_CHARS)}…` : spoken;
}

/** Keep operator prose; drop a trailing or whole-block JSON send/status envelope. */
export function peelStructuredEnvelope(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (isStructuredEnvelope(trimmed)) return "";
  const fence = trimmed.search(/\n\s*\{/);
  if (fence > 0) {
    const head = trimmed.slice(0, fence).trim();
    const tail = trimmed.slice(fence).trim();
    if (head && isStructuredEnvelope(tail)) return head;
  }
  const brace = trimmed.indexOf("{");
  if (brace > 0) {
    const head = trimmed.slice(0, brace).trim();
    const rest = trimmed.slice(brace).trim();
    if (head && isStructuredEnvelope(rest)) return head;
  }
  return trimmed;
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
}

export function isStructuredEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (Value.Check(ControllerDecisionSchema, value)) {
    const allowed = value.type === 'send'
      ? ['type', 'message', 'intent', 'rationale', 'evidenceRefs']
      : ['type', 'reason', 'rationale', 'evidenceRefs'];
    return keys.every((key) => allowed.includes(key));
  }
  if (Value.Check(RecoveryDecisionSchema, value) || Value.Check(RecoveryAgentEnvelopeSchema, value)) {
    return keys.every((key) => ['status', 'summary', 'unresolved', 'reportPath'].includes(key));
  }
  if (Value.Check(ComparisonResultSchema, value)) {
    return keys.every((key) => ['status', 'evidenceRefs', 'headline', 'reportPath'].includes(key));
  }
  return false;
}
