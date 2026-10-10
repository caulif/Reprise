import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import { ComparisonReviewFindingsClosure } from './comparison-review-findings.js';
import { ComparisonInitialFindings } from './comparison-initial-findings.js';
import { ComparisonFindingsCheckpoints } from './comparison-findings-checkpoints.js';
import { ComparisonCompositionTools } from './comparison-composition-tools.js';
import { resourceBoundTools } from './comparison-phase-tools.js';
import { comparisonToolFeedback } from './comparison-tool-feedback.js';
import { isFindingsUpdate, comparisonProtocol, comparisonStagePolicy, bindComparisonStageTools, stageToolNames,
  type ComparisonStage, type ComparisonStagePolicy } from './comparison-stage-policy.js';

type Phase = 'understand' | 'investigate' | 'compose' | 'review';

export class ComparisonStages {
  readonly bounded: boolean;
  readonly initialFindings: ComparisonInitialFindings;
  readonly checkpoints: ComparisonFindingsCheckpoints;
  readonly reviewFindings: ComparisonReviewFindingsClosure;
  readonly #composition: ComparisonCompositionTools;
  readonly #resources: ComparisonResourceTracker;
  readonly #options: ComparisonCompareOptions | undefined;
  readonly #strict: boolean;
  readonly #hasDelta: boolean;
  #phase: Phase = 'investigate';
  #stage: ComparisonStage = 'investigate';
  #policy: ComparisonStagePolicy;

  constructor(tools: readonly AgentToolDefinition[], resources: ComparisonResourceTracker, options?: ComparisonCompareOptions) {
    this.#resources = resources; this.#options = options;
    this.#strict = comparisonProtocol(options).strict;
    this.#hasDelta = tools.some(tool => tool.name === 'update_comparison_findings_delta');
    this.bounded = comparisonProtocol(options).direct;
    this.initialFindings = new ComparisonInitialFindings(options);
    this.checkpoints = new ComparisonFindingsCheckpoints(tools, options, () => resources.workDeadline());
    this.reviewFindings = new ComparisonReviewFindingsClosure(options);
    this.#composition = new ComparisonCompositionTools(options, () => this.#phase);
    this.#policy = this.#select();
  }
  begin(phase: Phase, pass?: ComparisonWorkPass): void {
    this.#phase = phase; this.#stage = pass ?? phase;
    this.reviewFindings.begin(pass); this.initialFindings.begin(pass); this.checkpoints.begin(phase, pass);
    this.#policy = this.#select();
  }
  prompt(): string { return this.#composition.prompt(); }
  toolNames(tools: readonly AgentToolDefinition[]): readonly string[] | undefined {
    const names = stageToolNames(this.#policy, tools);
    if (!this.#policy.meterExposure || !this.#resources.reviewReason()) return names;
    return tools.filter(tool => this.#policy.allows(tool.name) && (tool.name === 'read' || !this.#resources.beforeTool(tool.name))).map(tool => tool.name);
  }
  async exit(): Promise<string | undefined> {
    this.#resources.checkHard('completed provider turn');
    return this.#policy.exit();
  }
  #select(): ComparisonStagePolicy {
    const policy = comparisonStagePolicy(this.#stage, { strict: this.#strict, direct: this.bounded, initial: this.initialFindings.enabled,
      options: this.#options, preferFindingsDelta: this.#hasDelta, checkpointDue: () => this.checkpoints.due(), state: {
        initialSaved: () => this.initialFindings.saved(), checkpointSaved: () => this.checkpoints.saved(),
        reviewReady: () => this.reviewFindings.ready(), reviewPending: () => this.reviewFindings.pending(),
        sourceReady: () => this.reviewFindings.sourceReady(), sourcePending: () => this.reviewFindings.sourcePending(),
        softReason: () => this.#resources.softReason(), reviewReason: () => this.#resources.reviewReason(),
      },
      observed: (name, params, result) => {
        this.initialFindings.observe(name, result); this.checkpoints.observe(name, params, result); this.reviewFindings.observe(name, result);
      } });
    return policy;
  }
  bind(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
    const metered = resourceBoundTools(tools, this.#resources, this.#options, () => this.#policy.repairReads !== false, reason => this.#policy.limitFeedback?.(reason));
    const guarded = bindComparisonStageTools(metered, () => this.#policy, name => this.#resources.checkHard(name));
    return guarded.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
      let result = await tool.execute(params, signal);
      if (this.#options?.enforcePhaseBoundaries) result = this.#phaseFeedback(tool.name, result);
      return this.#options?.getSubmittedResult ? comparisonToolFeedback(result, this.#resources, this.#options.getSubmissionState?.(), tool.name) : result;
    } }));
  }
  #phaseFeedback(name: string, result: AgentToolResult): AgentToolResult {
    if (isFindingsUpdate(name) && this.#phase === 'investigate' && result.content.startsWith('status=accepted')) return {
      ...result, content: `${result.content}\nIf readyToCompose=true, finish this turn with a brief findings summary. The Host starts compose next; do not submit or preview in this turn.`,
    };
    return name === 'submit_comparison_draft' && result.content.startsWith('status=accepted')
      ? { ...result, content: `${result.content}\ncurrentPhase=${this.#phase}\nnextLegalPhase=review` } : result;
  }
}
