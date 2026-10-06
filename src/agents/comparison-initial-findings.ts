import { comparisonProtocol, comparisonStagePolicy, stageToolNames, bindComparisonStageTools } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import { withLanguageBlock, type AgentLocale } from './language.js';

export const COMPARISON_INITIAL_FINDINGS_PROMPT = 'This is the initial findings persistence checkpoint, before investigation. Call update_comparison_findings now with a minimal complete snapshot of the supplied task: criteria, both finals unavailable if not yet located, findings: [], importantLimitations: [], and pending decision-changing questions with nextCheck. Do not invent observations, references, locations, resolved answers or a winner. An accepted saved snapshot allows investigation; it does not establish ready findings or task success.';

export function composeComparisonInvestigatorSystemPrompt(locale: AgentLocale): string {
  return withLanguageBlock([
    'Investigate the recorded task and both actual deliveries for a concise Comparison. First save a minimal provisional snapshot; unknown finals and pending questions are valid.',
    'Check only consequential result or process differences. Use registered references with exact side ownership. State the actual method and scope: source inference, intermediate calculations, rendered output and execution records support different claims. Unknown remains unknown.',
    'Save useful observations promptly. Prefer update_comparison_findings_delta when available: exact binding, explicit retain/replace for every old ID, new complete objects only in addedFindings/addedQuestions. Do not reconstruct the whole snapshot. The Host pauses small source batches for save-only checkpoints; pending with nextCheck allows further necessary checks.',
    'A saved ready snapshot ends investigation. Preserve question identity, history and decisionImpact; unsupported answers become unavailable when no necessary check remains. Follow tool schemas and actual rejection feedback. At the deadline the Host can close saved pending questions as unavailable, never certify answers. Do not author, inspect or preview; later independent author and review sessions do that.',
  ].join('\n'), locale, 'comparison');
}

export class ComparisonInitialFindings {
  readonly enabled: boolean;
  readonly #options: ComparisonCompareOptions | undefined;
  #active = false;
  #accepted = false;
  constructor(options: ComparisonCompareOptions | undefined) {
    this.#options = options;
    this.enabled = comparisonProtocol(options).direct && typeof options?.hasSavedFindings === 'function';
  }
  needed(): boolean { return this.enabled && this.#options?.hasSavedFindings?.() !== true; }
  begin(pass?: ComparisonWorkPass): void { this.#active = this.enabled && pass === 'initial-findings'; this.#accepted = false; }
  saved(): boolean { return this.#active && this.#accepted && this.#options?.hasSavedFindings?.() === true; }
  observe(name: string, result: AgentToolResult): void {
    if (this.#active && name === 'update_comparison_findings' && /^status=accepted(?:\r?\n|$)/.test(result.content)) this.#accepted = true;
  }
  #policy() { return comparisonStagePolicy(this.#active ? 'initial-findings' : 'review', {
    strict: false, direct: false, initial: this.enabled, observed: (name, _params, result) => this.observe(name, result),
  }); }
  toolNames(tools: readonly AgentToolDefinition[]): readonly string[] | undefined { return stageToolNames(this.#policy(), tools); }
  bind(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
    return this.enabled ? bindComparisonStageTools(tools, () => this.#policy()) : [...tools];
  }
}
