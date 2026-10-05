import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { AgentToolDefinition, FreeformInvocation } from '../infrastructure/agent/host.js';

export const COMPARISON_REVIEW_FINDINGS_PROMPT = [
  'This is the independent review findings closure after source observations and actual draft delivery in this same session.',
  'Call update_comparison_findings now using kind=delta and current state.binding: list every findingIds and questionIds exactly once with action=retain or replace; supply complete replacement objects only for changes. Saved findings are hypotheses, not evidence: decide each entry from independent observations, preserve question identity and decisive uncertainty. Retain is an explicit reviewed decision, not automatic verification; unchanged valid content may be accepted without a new revision. Use the complete variant only when adding new findings or questions.',
  'Only update_comparison_findings and strictly registered repair reads are permitted. Do not investigate, submit a draft, inspect, write or preview. Ready saved state or a verbal promise does not replace an actual accepted update in this closure.',
  'The Host then starts full draft audit, new formal inspection and preview-only closure; accepted findings do not certify semantic correctness or publication.',
].join('\n');

type Work = (phase: 'review', prompt: string, pass?: ComparisonWorkPass) => Promise<FreeformInvocation>;

export class ComparisonReviewFindingsClosure {
  #active = false;
  #accepted = false;
  readonly #options: ComparisonCompareOptions | undefined;
  constructor(options: ComparisonCompareOptions | undefined) { this.#options = options; }
  begin(pass?: ComparisonWorkPass): void { this.#active = pass === 'review-findings'; this.#accepted = false; }
  ready(): boolean { return this.#active && this.#accepted && this.#options?.findingsReady?.() === true; }
  toolNames(tools: readonly AgentToolDefinition[]): readonly string[] {
    return tools.filter(tool => tool.name === 'update_comparison_findings' || (tool.name === 'read' && this.#options?.isRepairRead)).map(tool => tool.name);
  }
  bind(tools: readonly AgentToolDefinition[], resources: ComparisonResourceTracker): AgentToolDefinition[] {
    return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
      if (!this.#active) return tool.execute(params, signal);
      resources.checkHard(tool.name); signal.throwIfAborted();
      if (tool.name !== 'update_comparison_findings' && (tool.name !== 'read' || !await this.#options?.isRepairRead?.(params))) return {
        content: JSON.stringify({ code: 'review_findings_only', message: 'Only an actual findings update or registered repair read may execute in this closure.' }),
      };
      signal.throwIfAborted(); resources.checkHard(tool.name);
      const result = await tool.execute(params, signal);
      signal.throwIfAborted(); resources.checkHard('review findings result');
      if (tool.name === 'update_comparison_findings' && /^status=accepted(?:\r?\n|$)/.test(result.content)) this.#accepted = true;
      return result;
    } }));
  }
  async run(work: Work, sessionId: string, toolAvailable: boolean): Promise<Extract<FreeformInvocation, { status: 'failed' | 'cancelled' }> | undefined> {
    if (!this.#options?.reviewFindings) return undefined;
    if (!toolAvailable || !this.#options.findingsReady || !this.#options.hasReviewDraftMaterial?.()) return { status: 'failed', sessionId, failure: {
      code: 'draft_invalid', kind: 'protocol', attempts: 0, message: 'Independent findings closure requires actual delivered draft material, update_comparison_findings and findings readiness.' } };
    for (let call = 1; call <= 2; call++) {
      const outcome = await work('review', `${COMPARISON_REVIEW_FINDINGS_PROMPT}\n\nCurrent saved findings (hypotheses only): ${this.#options.getFindingsState?.() ?? 'unavailable'}`, 'review-findings');
      if (outcome.status !== 'completed' && outcome.status !== 'yielded') return outcome;
      sessionId = outcome.sessionId;
      if (!(outcome.status === 'yielded' && outcome.reason === 'output_limit') && this.ready()) return undefined;
    }
    return { status: 'failed', sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: 2,
      message: 'Independent findings closure did not execute an accepted, ready update after two actual calls. Old readiness, rejections and promises cannot satisfy this step.' } };
  }
}

export async function reviewDraftInspectionCheckpoint(options: ComparisonCompareOptions, work: Work,
  toolAvailable: boolean, sessionId: string, prompt: string): Promise<Extract<FreeformInvocation, { status: 'failed' | 'cancelled' }> | undefined> {
  if (!options.hasReviewDraftMaterial) return undefined;
  if (!toolAvailable) return { status: 'failed', sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: 0,
    message: 'Review draft checkpoint requires inspect_comparison_draft; no actual draft material can be delivered.' } };
  for (let call = 1; call <= 2 && !options.hasReviewDraftMaterial(); call++) {
    const inspected = await work('review', prompt, 'inspection');
    if (inspected.status !== 'completed' && inspected.status !== 'yielded') return inspected;
    sessionId = inspected.sessionId;
  }
  if (options.hasReviewDraftMaterial()) return undefined;
  return { status: 'failed', sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: 2,
    message: 'Actual review draft material is unavailable after two inspection checkpoint calls. Verbal promises or unavailable receipts do not permit draft audit.' } };
}
