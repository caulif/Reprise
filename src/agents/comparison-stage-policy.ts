import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';

export type ComparisonStage = 'understand' | 'investigate' | 'compose' | 'review' | 'initial-findings' | 'source-save'
  | 'sources' | 'findings' | 'inspection' | 'audit' | 'preview' | 'review-findings' | 'review-supplement';
export const COMPARISON_SOURCE_TOOLS: ReadonlySet<string> = new Set(['read', 'ls', 'grep', 'shell_exec', 'render_artifact', 'register_evidence', 'quote_evidence']);
const findingsTools = ['update_comparison_findings', 'update_comparison_findings_delta'];
export const isFindingsUpdate = (name: string): boolean => findingsTools.includes(name);

export function comparisonProtocol(options?: ComparisonCompareOptions): { strict: boolean; direct: boolean } {
  const strict = !!options?.getSubmittedResult && options.enforcePhaseBoundaries === true;
  return { strict, direct: strict && options?.reviewFindings === true };
}

type Guard = (name: string, params: unknown) => boolean | string | Promise<boolean | string>;
export type ComparisonStagePolicy = {
  allows: (name: string) => boolean;
  guard?: Guard;
  restricted: boolean;
  names?: readonly string[];
  code: string;
  message: string;
  denial?: (name: string) => Record<string, string>;
  repairReads?: boolean;
  meterExposure?: boolean;
  limitFeedback?: (reason: string) => AgentToolResult;
  exit: () => Promise<string | undefined>;
  observed?: (name: string, params: unknown, result: AgentToolResult) => void;
};

type PolicyInput = {
  strict: boolean; direct: boolean; initial: boolean; checkpointDue?: () => boolean;
  options?: ComparisonCompareOptions | undefined;
  state?: {
    initialSaved: () => boolean; checkpointSaved: () => boolean;
    reviewReady: () => boolean; reviewPending: () => boolean;
    sourceReady: () => boolean; sourcePending: () => boolean;
    softReason: () => string | undefined; reviewReason: () => string | undefined;
  };
  observed?: ComparisonStagePolicy['observed'];
};

export function comparisonStagePolicy(stage: ComparisonStage, input: PolicyInput): ComparisonStagePolicy {
  const { strict, direct, options, state } = input;
  const base: ComparisonStagePolicy = { allows: () => true, restricted: false, code: 'phase_not_ready',
    message: 'Finish the current turn. The Host starts the next legal stage; do not retry unavailable tools.',
    exit: async () => undefined, ...(input.observed ? { observed: input.observed } : {}) };
  const only = (names: readonly string[], code: string, message: string, guard?: Guard, exit: ComparisonStagePolicy['exit'] = base.exit): ComparisonStagePolicy => ({ ...base,
    allows: name => names.includes(name), names, restricted: true, code, message, exit, ...(guard ? { guard } : {}) });
  switch (stage) {
    case 'initial-findings': return input.initial ? only(['update_comparison_findings'], 'initial_findings_only',
      'Save a minimal actual findings snapshot first. Reading, checks and report tools are unavailable at this checkpoint.', undefined, async () => state?.initialSaved() ? 'initial_findings_saved' : state?.softReason()) : base;
    case 'source-save': return only(['update_comparison_findings_delta'], 'findings_checkpoint_required',
      'Save this bounded source batch through the bound delta tool before further source or report effects.', undefined, async () => state?.checkpointSaved() ? 'findings_checkpoint_saved' : undefined);
    case 'findings': return only(findingsTools, 'closure_only', 'Save findings from already observed evidence; do not investigate, write, submit or preview here.', undefined, async () => options?.findingsReady?.() ? 'findings_ready' : undefined);
    case 'inspection': return only(['inspect_comparison_draft'], 'draft_inspection_only',
      'Call inspect_comparison_draft to receive the actual full accepted text. Delivery does not approve publication.', undefined, async () => options?.hasReviewDraftMaterial?.() ? 'review_draft_material_ready' : undefined);
    case 'preview': return only(['preview_report'], 'preview_closure_only',
      'Only preview_report after actual formal inspection of the current binding is permitted.', () => options?.hasCurrentReviewInspection?.() === true, async () => await options?.getSubmittedResult?.() ? 'report_ready' : undefined);
    case 'review-findings': return only([...findingsTools, ...(options?.isRepairRead ? ['read'] : [])], 'review_findings_only',
      'Only an actual findings update or registered repair read may execute in this closure.',
      async (name, params) => name !== 'read' || await options?.isRepairRead?.(params) === true, async () => state?.reviewReady() ? 'review_findings_ready' : state?.reviewPending() ? 'review_findings_pending' : undefined);
    case 'review-supplement': return only([...COMPARISON_SOURCE_TOOLS], 'review_supplement_only',
      'Only source checks for saved pending questions may execute. The Host starts actual findings closure next.', undefined, async () => state?.reviewReason());
    case 'sources': {
      const sourcePolicy: ComparisonStagePolicy = direct ? only([...COMPARISON_SOURCE_TOOLS, ...findingsTools], 'source_review_not_ready',
      'Check actual sources and save findings; no draft or publication tool may execute.',
      name => input.checkpointDue?.() && COMPARISON_SOURCE_TOOLS.has(name) ? 'findings_checkpoint_required' : true, async () => input.checkpointDue?.() ? 'findings_checkpoint_required'
        : state?.sourceReady() ? 'independent_findings_ready' : state?.sourcePending() ? 'independent_findings_pending' : state?.reviewReason()) : { ...base,
      exit: async () => state?.reviewReason(),
      allows: name => !['inspect_comparison_draft', 'submit_comparison_draft', 'preview_report', ...findingsTools].includes(name), restricted: false,
      code: 'source_review_not_ready', message: 'Finish independent source review without opening the author draft or revising saved findings.' };
      return { ...sourcePolicy, repairReads: false, limitFeedback: reason => ({ content: JSON.stringify({ status: 'source_review_limit', reason,
        message: direct
          ? 'This source window has ended. Return only actual observations and decisive uncertainty; do not repeat denied checks. The Host starts the next bounded step.'
          : 'This source window has ended. Return your independently supported observations and decisive uncertainty; do not repeat denied checks. The Host starts draft audit next.' }) }) };
    }
    case 'compose': return strict ? only(direct ? ['submit_comparison_draft', 'update_comparison_findings']
      : ['read', 'quote_evidence', 'write', 'edit', 'submit_comparison_draft', 'update_comparison_findings'], 'composition_only',
      'Compose from received observations using the available authoring and necessary findings correction tools. Independent review owns further investigation, inspection and preview.', undefined, async () => options?.hasAcceptedDraft?.() ? 'author_draft_ready' : undefined)
      : { ...base, denial: () => ({ currentPhase: 'compose', nextLegalPhase: 'review' }), allows: name => !options?.enforcePhaseBoundaries || name !== 'preview_report',
        exit: async () => options?.hasAcceptedDraft?.() ? 'author_draft_ready' : undefined };
    case 'audit': return { ...base, meterExposure: true, exit: async () => options?.hasCurrentReviewInspection?.() ? 'final_inspection_ready' : undefined, allows: name => name !== 'preview_report', restricted: true, code: 'preview_not_ready',
      message: 'Finish the actual full draft audit and formally inspect the current binding. The Host then starts preview-only closure.' };
    case 'understand': case 'investigate': {
      const exit = async () => stage !== 'investigate' ? undefined : input.checkpointDue?.() ? 'findings_checkpoint_required'
        : options?.enforcePhaseBoundaries && options.reviewFindings && options.hasSavedFindings?.() && options.findingsReady?.() ? 'findings_ready' : state?.softReason();
      return { ...base, exit, restricted: direct, denial: name => ({ currentPhase: stage, nextLegalPhase: name === 'preview_report' ? 'review' : 'compose' }),
      allows: name => !options?.enforcePhaseBoundaries || !['submit_comparison_draft', 'preview_report', ...(stage === 'understand' ? ['shell_exec', 'render_artifact', 'register_evidence'] : [])].includes(name),
      guard: (name, params) => {
        const path = params && typeof params === 'object' && 'path' in params ? String(params.path).replaceAll('\\', '/').replace(/^(\.\/)+/, '') : '';
        if (options?.enforcePhaseBoundaries && ['write', 'edit'].includes(name) && path === 'report.html') return false;
        if (stage === 'investigate' && ((input.checkpointDue?.() && COMPARISON_SOURCE_TOOLS.has(name))
          || (['shell_exec', 'render_artifact', 'register_evidence'].includes(name) && options?.hasSavedFindings && !options.hasSavedFindings()))) return 'findings_checkpoint_required';
        return true;
      } };
    }
    case 'review': return { ...base, exit: async () => await options?.getSubmittedResult?.() ? 'report_ready' : undefined };
  }
}

export function stageToolNames(policy: ComparisonStagePolicy, tools: readonly AgentToolDefinition[]): readonly string[] | undefined {
  return policy.restricted ? tools.filter(tool => policy.allows(tool.name)).map(tool => tool.name) : undefined;
}

export function bindComparisonStageTools(tools: readonly AgentToolDefinition[], policy: () => ComparisonStagePolicy,
  before?: (name: string) => void): AgentToolDefinition[] {
  return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    before?.(tool.name); signal.throwIfAborted();
    const current = policy();
    const allowed = current.allows(tool.name);
    const guarded = allowed && current.guard ? await current.guard(tool.name, params) : allowed;
    if (guarded !== true) return {
      content: JSON.stringify({ code: typeof guarded === 'string' ? guarded : current.code, ...current.denial?.(tool.name), message: current.message }),
    };
    signal.throwIfAborted();
    const result = await tool.execute(params, signal);
    signal.throwIfAborted(); before?.(`${tool.name} result`);
    current.observed?.(tool.name, params, result);
    return result;
  }, ...(tool.onCompleted ? { onCompleted: async result => {
    const current = policy();
    if (!current.allows(tool.name) || result.content.includes(`"code":"${current.code}"`) || result.content.includes('"code":"findings_checkpoint_required"')) return;
    await tool.onCompleted!(result);
  } } : {}) }));
}
