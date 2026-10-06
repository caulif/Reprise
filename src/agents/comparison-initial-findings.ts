import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolDefinition } from '../infrastructure/agent/host.js';
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
