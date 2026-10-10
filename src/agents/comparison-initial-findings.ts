import { COMPARISON_IMAGE_GUIDANCE } from './comparison-image-guidance.js';
import { comparisonProtocol } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolResult } from '../infrastructure/agent/host.js';
import { withLanguageBlock, type AgentLocale } from './language.js';

export const COMPARISON_INITIAL_FINDINGS_PROMPT = 'This is the initial findings persistence checkpoint, before investigation. Call update_comparison_findings now with a minimal complete snapshot of the supplied task: criteria, both finals unavailable if not yet located, findings: [], importantLimitations: [], and pending decision-changing questions with nextCheck. Do not invent observations, references, locations, resolved answers or a winner. An accepted saved snapshot allows investigation; it does not establish ready findings or task success.';

export function composeComparisonInvestigatorSystemPrompt(locale: AgentLocale): string {
  return withLanguageBlock([
    COMPARISON_IMAGE_GUIDANCE,
    'Investigate both actual deliveries for a concise Comparison. First save a minimal provisional snapshot; unknown finals and pending questions are valid.',
    'Check consequential differences using registered refs with exact side ownership. State method and scope; source inference, rendered output and execution support different claims. Unknown stays unknown.',
    'Save promptly with update_comparison_findings_delta when available: exact binding, retain/replace every old ID, new complete objects only in addedFindings/addedQuestions. Do not reconstruct the snapshot. Host source batches pause for save-only checkpoints; pending with nextCheck permits further checks.',
    'Saved ready findings end investigation. Preserve question identity, history and decisionImpact; unsupported answers become unavailable when no necessary check remains. Follow schemas and rejection feedback. Deadline closure marks pending unavailable, never certifies answers. Do not author, inspect or preview; separate sessions do that.',
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
