import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { AgentToolDefinition } from '../infrastructure/agent/host.js';

export const COMPARISON_COMPOSITION_BOUNDARY_PROMPT = [
  'This is report composition from the observations and saved findings already received.',
  'Use read for existing source/material, quote_evidence for registered excerpts, write/edit for report authoring, and submit_comparison_draft. Do not start new shell checks, rendering, evidence registration, draft inspection or preview here. The fresh independent reviewer retains its investigation and correction tools.',
  'Do not repeatedly resave findings while drafting. Update only when existing received evidence requires a substantive correction or an actually new finding/question. Prefer kind=delta with current state.binding and explicit retain/replace decisions for all existing IDs; use the complete variant when adding IDs. Retaining a finding does not certify it, and an unavailable check remains unknown.',
  'If a draft is rejected for length, shorten headline, decisionSummary, decisionBoundary, comparisonHtml or detailsHtml as appropriate. Host-rendered support scope may also need concise equivalent wording. Preserve criteria meaning, source observations, evidence facts, finding/question identity, question history, decisive counterevidence and uncertainty; never delete or change them merely to meet a word limit.',
  'Finish after an accepted draft. Composition does not certify review, preview or publication, and there is no requirement to invent a winner when the received evidence is insufficient.',
].join('\n');

const authoringTools = new Set(['read', 'quote_evidence', 'write', 'edit', 'submit_comparison_draft', 'update_comparison_findings']);
type Phase = 'understand' | 'investigate' | 'compose' | 'review';

export class ComparisonCompositionTools {
  readonly #strict: boolean;
  readonly #phase: () => Phase;
  constructor(options: Pick<ComparisonCompareOptions, 'getSubmittedResult' | 'enforcePhaseBoundaries'> | undefined, phase: () => Phase) {
    this.#strict = !!options?.getSubmittedResult && options.enforcePhaseBoundaries === true;
    this.#phase = phase;
  }
  #active(): boolean { return this.#strict && this.#phase() === 'compose'; }
  prompt(): string { return this.#active() ? COMPARISON_COMPOSITION_BOUNDARY_PROMPT : ''; }
  allowedToolNames(tools: readonly AgentToolDefinition[]): readonly string[] | undefined {
    return this.#active() ? tools.filter(tool => authoringTools.has(tool.name)).map(tool => tool.name) : undefined;
  }
  bind(tools: readonly AgentToolDefinition[]): AgentToolDefinition[] {
    if (!this.#strict) return [...tools];
    return tools.map(tool => ({ ...tool,
      ...(tool.onCompleted ? { onCompleted: async result => {
        if (!this.#active() || authoringTools.has(tool.name)) await tool.onCompleted!(result);
      } } : {}),
      execute: async (params: unknown, signal: AbortSignal) => {
        if (this.#active()) {
          signal.throwIfAborted();
          if (!authoringTools.has(tool.name)) return { content: JSON.stringify({ code: 'composition_only',
            message: 'Compose from existing material with read, quote_evidence, write/edit, findings correction and submit_comparison_draft. New investigation, registration, inspection and preview belong to the other Host phases.' }) };
        }
        return tool.execute(params, signal);
      },
    }));
  }
}
