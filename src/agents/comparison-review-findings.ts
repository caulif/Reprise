import { isFindingsUpdate, comparisonProtocol } from './comparison-stage-policy.js';
import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonWorkPass } from './comparison-invocation-boundaries.js';
import type { AgentToolResult, FreeformInvocation } from '../infrastructure/agent/host.js';
import { withLanguageBlock, type AgentLocale } from './language.js';
import { VISIBLE_PROCESS_NARRATION } from './visible-process.js';

export function composeComparisonReviewerSystemPrompt(locale: AgentLocale): string {
  return withLanguageBlock([
    'You independently review a concise Comparison report for the recorded task and both actual deliveries. Saved findings and the author draft are hypotheses, not evidence or semantic approval. Read the actual sources needed for decision-changing differences and counterexamples; do not repeat settled checks or inventory every implementation detail.',
    'Trace claims to the actual drawn, written or returned output. Source inference, intermediate calculations, model self-report, static samples and actual execution support different scopes. Preserve side ownership, source hashes and original question history. Check relevant branches and phase conditions before any all-state claim. Unknown is not success, absence or zero; do not infer cost from elapsed time.',
    'The Host assigns bounded source, draft inspection, findings closure, at most one supplemental source pass, full audit and preview-only steps in this session. Follow the actual available tools and rejection feedback. Complete the requested tool action promptly without a long investigation recap. Preserve important unknowns and decisive counterevidence; narrow the recommendation when evidence is incomplete.',
    'During the independent source pass, save supported observations through update_comparison_findings_delta when available as soon as they are established. Use its single delta schema and addedFindings/addedQuestions for new objects; do not reconstruct the whole snapshot. The Host pauses small source batches for an actual save-only checkpoint, where pending is valid before further checking. Current findings are hypotheses to verify, not blind input, proof or author approval.',
    'Save corrections with kind=delta and the actual current binding, retaining unchanged IDs explicitly and replacing only changed objects. Resolved questions need actual support; still-unchecked questions must become unavailable with their original decisionImpact and precise limitation. An accepted update does not approve the draft.',
    'Audit the full actual delivered draft, including folded details, against independent observations, complete current support ranges and Host metrics. Scope summaries are model-authored presentation, not evidence: reject changed domains, inflated coverage or omitted decision-changing unknowns and counterexamples. Prefer compact kind=decision corrections with every current disposition and scopeSummaries entry for each basis/boundary finding (findingId, baseline, candidate). Keep impact and uncertainty brief; never change saved evidence to fit a report budget. Main budgets are 250/600, details 400/1000 for one/multiple independent differences. Do not repeat inventories or conclusions.',
    'Completed requires a supported basis; partial support and decision-changing unavailable questions require conditional or undetermined scope. If no supported basis remains, use insufficient_evidence and undetermined. Do not invent a winner, model ranking, quotation, completed check, render or image observation. Quote only actual registered source bytes through the quote tool.',
    'After any correction, actually inspect the latest accepted complete text and binding. Inspection, rendering and accepted receipts are not semantic approval. The Host requires the actual full current inspection in a subsequent generation input, then a matching preview; stale material or an unfinished audit cannot authorize publication.',
    'Render and preview only through the controlled registered tools. Never launch or probe browser binaries, profiles or debugging endpoints through shell commands. Image registration, authorization, provider capability and actual model-visible image delivery are distinct; do not claim visual review without actual authorized image observations.',
    VISIBLE_PROCESS_NARRATION,
  ].join('\n'), locale, 'comparison');
}

export const COMPARISON_REVIEW_FINDINGS_PROMPT = [
  'This is the independent review findings closure after source observations and actual draft delivery in this same session.',
  'Call update_comparison_findings_delta when available (otherwise update_comparison_findings) now. The minimal delta has exactly these required fields: kind="delta", binding=the exact current state.binding object, findingDecisions=[{id,action:"retain"} for every existing findingIds], and questionDecisions=[one retain or replace object for every existing questionIds]. Both arrays are required even when empty; their entries are objects, never strings. Use only registered schema field names, not findings/questions aliases or invented fields. Retain unchanged findings explicitly; evidence-supported corrections may use action="replace" with a complete replacement. Saved findings are hypotheses, not evidence: decide each entry from independent observations, preserve question identity and decisive uncertainty. Retain is an explicit reviewed decision, not automatic verification; unchanged valid content may be accepted without a new revision.',
  'Only the available findings update tool and strictly registered repair reads are permitted. Do not investigate, submit a draft, inspect, write or preview. Ready saved state or a verbal promise does not replace an actual accepted update in this closure.',
  'Save only necessary changes; retain unchanged entries explicitly. If an independently discovered decision-changing question requires a source check, keep its original identity and nextCheck pending in this actual update; the Host can provide one bounded supplemental source pass. Do not repeatedly rewrite the same pending snapshot.',
  'The Host then starts full draft audit, new formal inspection and preview-only closure; accepted findings do not certify semantic correctness or publication.',
].join('\n');

export const COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT = [
  'This is the independent source pass of a fresh review session. Check the actual task and both sealed final deliverables using briefing/decision-map.md and source tools. Do not open the author draft or author work notes.',
  'The saved findings below are hypotheses for correction and provide the actual binding and existing IDs. Verify decision-changing observations and counterevidence against actual sources, including the final downstream output chain and materially different branches. A source trace, intermediate computation, self-report, sample and full execution have different scopes; retain decisive unchecked relationships.',
  'Prioritize the strongest claimed task-quality advantage and a meaningful counterexample before implementation inventories. Use the supplied task, findings and directory rather than rereading their full navigation metadata; read the actual deliverables. Preserve a feature-count difference only when it changes this task decision.',
  'Call update_comparison_findings_delta when available promptly after the first useful checks, not after exhausting the source window. Use the exact binding and explicit decisions for every existing ID; put only new complete objects in addedFindings/addedQuestions. Preserve all original question identities and history. Record actual observed differences and their user impact; do not leave saved findings empty when supported observations already exist.',
  'Resolve only actually supported questions; mark still-unchecked questions unavailable with the precise limitation and original decisionImpact, or pending with the one necessary nextCheck if supplemental checking can change the decision. Do not claim a resource limit proves absence or correctness. An actual accepted ready update ends this source pass; an accepted pending update leads to at most one supplemental pass.',
  'No report write, submission, inspection or preview may execute here. Findings acceptance does not approve any report: the Host still delivers and audits the full actual draft, requires current inspection in a subsequent generation and a matching preview. Return concise actions and observations, not a second investigation essay.',
].join('\n');

export function comparisonSourceReviewPrompt(options: ComparisonCompareOptions, taskPrompt: string | undefined, legacy: string): string {
  const direct = comparisonProtocol(options).direct;
  return [taskPrompt ?? '', direct ? COMPARISON_DIRECT_SOURCE_REVIEW_PROMPT : legacy,
    ...(direct ? [`Current saved findings (hypotheses only): ${options.getFindingsState?.() ?? 'unavailable'}`] : [])].join('\n\n');
}

type Work = (phase: 'review', prompt: string, pass?: ComparisonWorkPass) => Promise<FreeformInvocation>;

export class ComparisonReviewFindingsClosure {
  #active = false;
  #accepted = false;
  #source = false;
  #sourceAccepted = false;
  #sourceState: string | undefined;
  readonly directSources: boolean;
  readonly #options: ComparisonCompareOptions | undefined;
  constructor(options: ComparisonCompareOptions | undefined) { this.#options = options; this.directSources = comparisonProtocol(options).direct; }
  begin(pass?: ComparisonWorkPass): void {
    this.#active = pass === 'review-findings'; this.#accepted = false;
    this.#source = this.directSources && (pass === 'sources' || pass === 'source-save');
    if (this.#source) { this.#sourceAccepted = false; this.#sourceState = undefined; }
  }
  sourceSaved(): boolean { return this.#sourceAccepted && typeof this.#sourceState === 'string' && this.#sourceState.length > 0 && this.#sourceState === this.#options?.getFindingsState?.(); }
  sourceReady(): boolean { return this.sourceSaved() && this.#options?.findingsReady?.() === true; }
  sourcePending(): boolean { return this.sourceSaved() && this.#options?.findingsReady?.() === false; }
  ready(): boolean { return this.#active && this.#accepted && this.#options?.findingsReady?.() === true; }
  pending(): boolean { return this.#active && this.#accepted && this.#options?.enforcePhaseBoundaries === true && this.#options.findingsReady?.() === false; }
  observe(name: string, result: AgentToolResult): void {
    if (!isFindingsUpdate(name) || !/^status=accepted(?:\r?\n|$)/.test(result.content)) return;
    if (this.#source) { this.#sourceAccepted = true; this.#sourceState = this.#options?.getFindingsState?.(); }
    if (this.#active) this.#accepted = true;
  }
  async run(work: Work, sessionId: string, toolAvailable: boolean, sourceCompleted = false, sourceInterrupted = false): Promise<Extract<FreeformInvocation, { status: 'failed' | 'cancelled' }> | undefined> {
    if (!this.#options?.reviewFindings) return undefined;
    if (!toolAvailable || !this.#options.findingsReady || !this.#options.hasReviewDraftMaterial?.()) return { status: 'failed', sessionId, failure: {
      code: 'draft_invalid', kind: 'protocol', attempts: 0, message: 'Independent findings closure requires actual delivered draft material, update_comparison_findings and findings readiness.' } };
    if (!sourceInterrupted && sourceCompleted && this.sourceReady()) return undefined;
    let supplemented = false;
    const firstCall = sourceInterrupted || (sourceCompleted && this.sourcePending()) ? 2 : 1;
    if (firstCall === 2 && !sourceInterrupted) {
      const supplement = await this.#checkSupplement(work);
      if (supplement.status !== 'completed' && supplement.status !== 'yielded') return supplement;
      sessionId = supplement.sessionId; supplemented = true;
    }
    for (let call = firstCall; call <= 2; call++) {
      const final = (sourceInterrupted || this.#options.enforcePhaseBoundaries) && call === 2
        ? '\nThis is the final bounded findings closure. Use only actually received evidence. Retain every unchanged existing finding in findingDecisions; evidence-supported corrections may replace complete objects. For each still-unchecked question, use questionDecisions action="replace" with its complete original question object, exact id/question/decisionImpact and history, status="unavailable", evidenceRefs and a precise resolution from actual retained observations. Do not retain pending questions or invent an answer; unavailable cannot support an unconditional recommendation. No further source pass will be opened, including after a source deadline interruption. Do not restate the investigation, add new field names or promise future work.' : '';
      const outcome = await work('review', `${COMPARISON_REVIEW_FINDINGS_PROMPT}${final}\n\nCurrent saved findings (hypotheses only): ${this.#options.getFindingsState?.() ?? 'unavailable'}`, 'review-findings');
      if (outcome.status !== 'completed' && outcome.status !== 'yielded') return outcome;
      if (outcome.status === 'yielded' && outcome.reason === 'bounded_source_timeout') return {
        status: 'failed', sessionId: outcome.sessionId, failure: { code: 'draft_invalid', kind: 'timeout', attempts: 0,
          message: 'Independent findings closure exhausted its review deadline. Saved readiness cannot certify an unfinished closure; no additional request is started.' },
      };
      sessionId = outcome.sessionId;
      const completed = outcome.status === 'completed' || outcome.reason === 'review_findings_ready' || outcome.reason === 'review_findings_pending';
      if (completed && this.ready()) return undefined;
      if (call === 1 && completed && this.pending()) {
        const supplement = await this.#checkSupplement(work);
        if (supplement.status !== 'completed' && supplement.status !== 'yielded') return supplement;
        sessionId = supplement.sessionId; supplemented = true;
      }
    }
    return { status: 'failed', sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: sourceInterrupted ? 1 : 2,
      message: `Independent findings closure did not execute an accepted, ready update after ${sourceInterrupted ? 'one actual final closure following source interruption' : 'two actual calls'}${supplemented ? ' and one bounded supplemental source pass' : ''}. Old readiness, rejections and promises cannot satisfy this step.` } };
  }
  #checkSupplement(work: Work): Promise<FreeformInvocation> {
    return work('review', `This is the only bounded supplemental source pass. Check only the saved pending questions that can change the recommendation, a decisive counterexample or an important limitation. Use actual source tools and registered evidence, not saved findings as proof. Do not open unrelated checks or repeat settled observations. Do not update findings, inspect, submit, edit or preview a draft here. Return scoped observations promptly; the Host then requires the final findings update, with remaining uncertainty unavailable. Current saved hypotheses and pending questions: ${this.#options?.getFindingsState?.() ?? 'unavailable'}`, 'review-supplement');
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
    if (inspected.status === 'yielded' && inspected.reason === 'bounded_source_timeout') return {
      status: 'failed', sessionId: inspected.sessionId, failure: { code: 'draft_invalid', kind: 'timeout', attempts: 0,
        message: 'Review draft inspection exhausted its deadline before completing the checkpoint; no additional inspection request is started.' },
    };
    sessionId = inspected.sessionId;
  }
  if (options.hasReviewDraftMaterial()) return undefined;
  return { status: 'failed', sessionId, failure: { code: 'draft_invalid', kind: 'protocol', attempts: 2,
    message: 'Actual review draft material is unavailable after two inspection checkpoint calls. Verbal promises or unavailable receipts do not permit draft audit.' } };
}
