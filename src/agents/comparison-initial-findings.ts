import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolDefinition } from '../infrastructure/agent/host.js';
import { withLanguageBlock, type AgentLocale } from './language.js';

export const COMPARISON_INITIAL_FINDINGS_PROMPT = 'This is the initial findings persistence checkpoint, before investigation. Call update_comparison_findings now with a minimal complete snapshot of the supplied task: criteria, both finals unavailable if not yet located, findings: [], importantLimitations: [], and pending decision-changing questions with nextCheck. Do not invent observations, references, locations, resolved answers or a winner. An accepted saved snapshot allows investigation; it does not establish ready findings or task success.';

export function composeComparisonInvestigatorSystemPrompt(locale: AgentLocale): string {
  return withLanguageBlock([
    'You investigate the recorded task and two actual deliveries for a concise Comparison report. Save a minimal provisional findings snapshot before any reading or checking; unknown finals and pending questions are valid.',
    'After the actual checkpoint, read only sources needed for consequential result or process differences. Keep findings and decision-changing questions current with registered references and exact side ownership. Declare what the actual method supports: source inspection is not a rendered-output measurement, an intermediate result is not the final output, and unknown remains unknown.',
    'Use the registered tool schemas and actual rejection feedback. Preserve question identity and history. At the investigation deadline the Host may close pending questions as unavailable, without certifying their answers. Do not author, inspect or preview the report here; the Host assigns later independent author and review sessions.',
  ].join('\n'), locale, 'comparison');
}

export class ComparisonInitialFindings {
  readonly enabled: boolean;
  readonly #options: ComparisonCompareOptions | undefined;
  #active = false;
  #accepted = false;
  constructor(options: ComparisonCompareOptions | undefined) {
    this.#options = options;
    this.enabled = !!options?.getSubmittedResult && options.enforcePhaseBoundaries === true && options.reviewFindings === true && typeof options.hasSavedFindings === 'function';
  }
  needed(): boolean { return this.enabled && this.#options?.hasSavedFindings?.() !== true; }
  begin(pass?: ComparisonWorkPass): void { this.#active = this.enabled && pass === 'initial-findings'; this.#accepted = false; }
  saved(): boolean { return this.#active && this.#accepted && this.#options?.hasSavedFindings?.() === true; }
  toolNames(tools: readonly AgentToolDefinition[]): readonly string[] | undefined {
    return this.#active ? tools.filter(t => t.name === 'update_comparison_findings').map(t => t.name) : undefined;
  }
  bind(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
    if (!this.enabled) return [...tools];
    return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
      if (!this.#active) return tool.execute(params, signal);
      signal.throwIfAborted();
      if (tool.name !== 'update_comparison_findings') return { content: JSON.stringify({ code: 'initial_findings_only', message: 'Save a minimal actual findings snapshot first. Reading, shell, rendering, registration and report tools are unavailable at this checkpoint.' }) };
      const result = await tool.execute(params, signal); signal.throwIfAborted();
      if (/^status=accepted(?:\r?\n|$)/.test(result.content)) this.#accepted = true;
      return result;
    }, ...(tool.onCompleted ? { onCompleted: async result => {
      if (!this.#active || tool.name === 'update_comparison_findings') await tool.onCompleted!(result);
    } } : {}) }));
  }
}
