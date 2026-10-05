import type { AgentToolResult } from '../infrastructure/agent/host.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';

export function comparisonToolFeedback(result: AgentToolResult, resources: ComparisonResourceTracker, submissionState?: string): AgentToolResult {
  const snapshot = resources.snapshot();
  const feedback = {
    phase: snapshot.phase, remainingRequests: snapshot.remainingRequests,
    remainingTools: snapshot.remainingTools, remainingMs: snapshot.remainingMs,
    reviewLimit: snapshot.reviewLimit,
    ...(submissionState ? { submissionState } : {}),
    meaning: 'Resource and draft binding facts only; not semantic approval. Reserve requests for one batch correction and preview of its exact digest. Do not repeat settled checks or register duplicate analysis. If a decisive claim remains unverified, remove its guarantee and explicitly state the unresolved decision; never reuse a stale preview.',
  };
  let content: string;
  try {
    const payload: unknown = JSON.parse(result.content);
    content = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? JSON.stringify({ ...payload, hostProgress: feedback })
      : `${result.content}\n\nHost progress feedback: ${JSON.stringify(feedback)}`;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Text tools intentionally return non-JSON; preserve their content before the feedback.
    content = `${result.content}\n\nHost progress feedback: ${JSON.stringify(feedback)}`;
  }
  if (!result.contentBlocks) return { ...result, content };
  const matches = result.contentBlocks.some(block => block.type === 'text' && block.text === result.content);
  if (matches) return { ...result, content, contentBlocks: result.contentBlocks.map(block =>
    block.type === 'text' && block.text === result.content ? { ...block, text: content } : block) };
  const progressText = `Host progress feedback: ${JSON.stringify(feedback)}`;
  return { ...result, content: `${result.content}\n\n${progressText}`, contentBlocks: [...result.contentBlocks, { type: 'text', text: progressText }] };
}

export function comparisonSoftLimitFeedback(reason: string, phase: unknown): AgentToolResult {
  const review = phase === 'review';
  return { content: `status=${review ? 'review_investigation_limit' : 'investigation_limit'}\nreason=${reason}\n${review
    ? 'Stop expanding the audit. Use inspect_comparison_draft, update_comparison_findings, submit_comparison_draft and preview_report to finish supported corrections in one batch. Do not repeat denied searches. Remove unverified guarantees or report the decisive unresolved question explicitly; a resource limit is not evidence that a claim is true. Preview the exact final accepted digest before ending.'
    : 'Stop investigating. Save scoped findings and mark unresolved questions unavailable with this resource limitation, then return to compose. Do not invent missing evidence.'}` };
}
