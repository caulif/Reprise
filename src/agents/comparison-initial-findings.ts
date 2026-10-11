import { COMPARISON_IMAGE_GUIDANCE } from './comparison-image-guidance.js';
import { comparisonProtocol } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolResult } from '../infrastructure/agent/host.js';
import { withLanguageBlock, type AgentLocale } from './language.js';

export const COMPARISON_INITIAL_FINDINGS_PROMPT = 'This is the initial findings persistence checkpoint, before investigation. Call update_comparison_findings now with a minimal complete snapshot of the supplied task: criteria, both finals unavailable if not yet located, findings: [], importantLimitations: [], and a few pending decision-changing questions with nextCheck. Derive criteria from the requested observable result and relationships essential to it, not just file existence, format or implementation API. For a visual task, separate recognizable entities from the interactions/contact implied by the requested action; give each essential relationship its own concrete pending question rather than grouping all visual quality into one general scene question. For other tasks use their own observable success conditions. Do not invent observations, references, locations, resolved answers or a winner. An accepted saved snapshot allows investigation; it does not establish ready findings or task success.';

export function composeComparisonInvestigatorSystemPrompt(locale: AgentLocale): string {
  return withLanguageBlock([
    COMPARISON_IMAGE_GUIDANCE,
    'Compare both deliveries. First save a minimal snapshot; unknown finals and pending questions are valid.',
    'Use registered refs with exact side ownership. State method and scope. Self-reports and intermediate calculations do not prove final output.',
    'Save promptly through delta: exact binding, retain/replace every old ID, add complete new objects. Source batches pause for save-only; pending with nextCheck permits further checks.',
    'Ready ends investigation. Preserve question identity, history and decisionImpact. Unsupported answers become unavailable, never success. Follow schemas and feedback. Do not author, inspect or preview.',
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

}
