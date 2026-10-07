import { comparisonProtocol } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';

export const COMPARISON_COMPOSITION_BOUNDARY_PROMPT = [
  'This is report composition from the observations and saved findings already received.',
  'Use read for existing source/material, quote_evidence for registered excerpts, write/edit for report authoring, and submit_comparison_draft. Do not start new shell checks, rendering, evidence registration, draft inspection or preview here. The fresh independent reviewer retains its investigation and correction tools.',
  'Do not repeatedly resave findings while drafting. Update only when existing received evidence requires a substantive correction or an actually new finding/question. Prefer kind=delta with current state.binding and explicit retain/replace decisions for all existing IDs; use addedFindings/addedQuestions for new complete objects. Retaining a finding does not certify it, and an unavailable check remains unknown.',
  'If a draft is rejected for length, shorten headline, decisionSummary, decisionBoundary, comparisonHtml or detailsHtml as appropriate. Host-rendered support scope may also need concise equivalent wording. Preserve criteria meaning, source observations, evidence facts, finding/question identity, question history, decisive counterevidence and uncertainty; never delete or change them merely to meet a word limit.',
  'Finish after an accepted draft. Composition does not certify review, preview or publication, and there is no requirement to invent a winner when the received evidence is insufficient.',
].join('\n');

const decisionPrompt = [
  'This is provisional decision composition from the task and saved hypotheses already supplied. Only submit_comparison_draft and necessary update_comparison_findings corrections are available.',
  'Submit the compact kind=decision variant promptly. Do not reread sources, collect quotations, write HTML or restart investigation. Missing support remains unknown and must qualify the decision. The independent source reviewer retains reading, quoting, authoring and investigation tools, followed by actual full draft inspection and audit.',
  'Prefer a bound delta for a substantive correction from already received observations. Preserve all findings, question history, decisive counterevidence and limitations. Do not rewrite or erase evidence merely to reduce text length. Shorten the actual headline, decisionSummary and decisionBoundary instead of repeating them in HTML.',
  'An accepted draft ends this provisional author turn; it certifies neither semantics nor publication.',
].join('\n');
type Phase = 'understand' | 'investigate' | 'compose' | 'review';

export class ComparisonCompositionTools {
  readonly #strict: boolean;
  readonly #phase: () => Phase;
  readonly #decision: boolean;
  constructor(options: Pick<ComparisonCompareOptions, 'getSubmittedResult' | 'enforcePhaseBoundaries' | 'reviewFindings'> | undefined, phase: () => Phase) {
    this.#strict = comparisonProtocol(options).strict;
    this.#decision = comparisonProtocol(options).direct;
    this.#phase = phase;
  }
  #active(): boolean { return this.#strict && this.#phase() === 'compose'; }
  prompt(): string { return this.#active() ? this.#decision ? decisionPrompt : COMPARISON_COMPOSITION_BOUNDARY_PROMPT : ''; }
}
