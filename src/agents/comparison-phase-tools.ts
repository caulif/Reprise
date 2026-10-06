import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { AgentToolDefinition } from '../infrastructure/agent/host.js';
import { comparisonSoftLimitFeedback } from './comparison-tool-feedback.js';

type Phase = 'understand' | 'investigate' | 'compose' | 'review';
export type ComparisonToolPhase = { phase: Phase; sourceReview: boolean; findingsClosure: boolean; draftInspection: boolean; draftAudit: boolean; previewClosure: boolean };
export function setComparisonPass(current: ComparisonToolPhase, phase: Phase, pass?: ComparisonWorkPass): void {
  Object.assign(current, { phase, sourceReview: pass === 'sources', findingsClosure: pass === 'findings',
    draftInspection: pass === 'inspection', draftAudit: pass === 'audit', previewClosure: pass === 'preview' });
}

function sourceReviewFeedback(name: string, reason: string | undefined, directFindings: boolean): { content: string } | undefined {
  const forbidden = ['inspect_comparison_draft', 'submit_comparison_draft', 'preview_report',
    ...(directFindings ? ['write', 'edit'] : ['update_comparison_findings'])];
  if (forbidden.includes(name)) return { content: JSON.stringify({ code: 'source_review_not_ready',
    message: directFindings
      ? 'Check actual sources and save findings now; do not open, write, submit or preview the author draft. The Host starts actual draft inspection and audit next.'
      : 'Finish the independent source pass without opening the author draft or revising saved findings. Return your scoped observations and counterexample; the Host enables draft inspection, findings correction and preview next.' }) };
  if (reason) return { content: JSON.stringify({ status: 'source_review_limit', reason,
    message: directFindings
      ? 'This source window has ended. Return only actual observations and decisive uncertainty; do not repeat denied checks. The Host starts the next bounded step.'
      : 'This source window has ended. Return your independently supported observations and decisive uncertainty; do not repeat denied checks. The Host starts draft audit next.' }) };
  return undefined;
}

export function resourceBoundTools(tools: readonly AgentToolDefinition[], current: ComparisonToolPhase, resources: ComparisonResourceTracker,
  options?: ComparisonCompareOptions): AgentToolDefinition[] {
  const directFindings = !!options?.getSubmittedResult && options.enforcePhaseBoundaries === true && options.reviewFindings === true;
  return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    const reason = resources.beforeTool(tool.name);
    signal.throwIfAborted();
    if (current.previewClosure && (tool.name !== 'preview_report' || !options?.hasCurrentReviewInspection?.())) return { content: JSON.stringify({ code: 'preview_closure_only',
      message: 'This closure permits only preview_report after actual formal inspection of the current binding. A missing or stale inspection requires full draft audit; no changes or investigation may execute here.' }) };
    if (current.draftAudit && tool.name === 'preview_report') return { content: JSON.stringify({ code: 'preview_not_ready',
      message: 'Finish this actual full draft audit turn and formally inspect the current accepted binding. The Host then starts a preview-only closure in the same session; do not retry preview in this audit.' }) };
    if (current.draftInspection && tool.name !== 'inspect_comparison_draft') return { content: JSON.stringify({ code: 'draft_inspection_only',
      message: 'Call inspect_comparison_draft to receive the actual full accepted text. This checkpoint permits no investigation, findings changes, submission, writing or preview. Delivery is not semantic or publication approval.' }) };
    if (current.findingsClosure && tool.name !== 'update_comparison_findings') return { content: JSON.stringify({ code: 'closure_only',
      message: 'This findings closure permits only update_comparison_findings from already observed evidence. Do not investigate, write, submit or preview here.' }) };
    const sourceFeedback = current.sourceReview ? sourceReviewFeedback(tool.name, reason, directFindings) : undefined;
    if (sourceFeedback) return sourceFeedback;
    if (reason && !reason.startsWith('bounded_') && resources.snapshot().phase === 'review' && !current.sourceReview && tool.name === 'read'
      && await options?.isRepairRead?.(params)) {
      signal.throwIfAborted();
      const afterReadPolicy = resources.beforeTool(tool.name);
      if (afterReadPolicy?.startsWith('bounded_')) return comparisonSoftLimitFeedback(afterReadPolicy, 'review');
      return tool.execute(params, signal);
    }
    if (reason) return comparisonSoftLimitFeedback(reason, resources.snapshot().phase);
    const checkpoint = current.phase === 'investigate' && !current.findingsClosure && !current.sourceReview && options?.hasSavedFindings !== undefined;
    const costlyCheck = ['shell_exec', 'render_artifact', 'register_evidence'].includes(tool.name);
    if (checkpoint && costlyCheck && !options?.hasSavedFindings?.()) return { content: JSON.stringify({ code: 'findings_checkpoint_required',
      message: 'Before this check, call update_comparison_findings with a minimal complete snapshot from what you actually read: task criteria and their sources, both final locations (unavailable if not located), findings: [] if not yet checked, and pending decision questions with nextCheck. Read/navigation remains available. Do not invent observations or settle unknown questions.' }) };
    return tool.execute(params, signal);
  } }));
}
