import type { ComparisonResources } from '../core/schema.js';
import type { AgentAuditEvent } from '../infrastructure/agent/host.js';

export const DEFAULT_COMPARISON_RESOURCES: Readonly<ComparisonResources> = Object.freeze({
  investigationModelRequests: 12, investigationToolCalls: 30, investigationMs: 240_000,
  maxModelRequests: 40, maxToolCalls: 120, maxElapsedMs: 1_200_000,
});

class ComparisonResourceLimit extends Error {}

type WorkStage = 'investigate' | 'investigation-checkpoint' | 'compose' | 'review' | 'review-checkpoint' | 'review-inspection' | 'review-findings' | 'audit' | 'preview';
const STAGE_BUDGETS: Readonly<Record<WorkStage, number>> = { investigate: 240_000, compose: 180_000, review: 300_000,
  'investigation-checkpoint': 120_000, 'review-checkpoint': 120_000, 'review-inspection': 120_000, 'review-findings': 120_000, audit: 180_000, preview: 120_000 };
// Saving protects the complete author allowance in addition to the author's downstream reserve.
const FINISH_RESERVES: Readonly<Record<WorkStage, number>> = { investigate: 780_000, compose: 480_000, review: 360_000,
  'investigation-checkpoint': 660_000, 'review-checkpoint': 300_000, 'review-inspection': 270_000, 'review-findings': 210_000, audit: 90_000, preview: 30_000 };
const STAGE_REASONS: Readonly<Record<WorkStage, string>> = {
  investigate: 'bounded_investigation_timeout', compose: 'bounded_compose_timeout', review: 'bounded_source_timeout',
  'investigation-checkpoint': 'bounded_investigation_timeout',
  'review-checkpoint': 'bounded_source_timeout', 'review-inspection': 'bounded_source_timeout', 'review-findings': 'bounded_source_timeout',
  audit: 'bounded_audit_timeout', preview: 'bounded_preview_timeout',
};

export class ComparisonResourceTracker {
  readonly #limits: ComparisonResources;
  readonly #started = Date.now();
  #phaseStarted = this.#started;
  #investigationElapsed = 0;
  #reviewElapsed = 0;
  #requests = 0;
  #tools = 0;
  #investigationRequests = 0;
  #investigationTools = 0;
  #reviewRequests = 0;
  #reviewTools = 0;
  #estimatedCost = 0;
  #usageReports = 0;
  #priceUnknown = false;
  #phase = 'investigate';
  readonly #toolIds = new Set<string>();
  readonly #boundedStages: boolean;
  readonly #stageDeadlines = new Map<WorkStage, number>();
  readonly #sourceDeadlines = new Map<string, number>();
  #workStage: WorkStage = 'investigate';
  #workPass: string | undefined;
  #investigationSaveSpent = 0;
  #investigationSaveStarted: number | undefined;

  constructor(limits: ComparisonResources, options?: { boundedStages?: boolean }) {
    this.#limits = limits;
    this.#boundedStages = !!options?.boundedStages && limits.maxElapsedMs !== undefined;
    if (this.#boundedStages) this.#enterStage('investigate');
  }

  phase(phase: string, pass?: string): void {
    if (this.#investigationSaveStarted !== undefined && (phase !== 'investigate' || pass !== 'source-save')) {
      this.#investigationSaveSpent += Date.now() - this.#investigationSaveStarted;
      this.#investigationSaveStarted = undefined;
      this.#stageDeadlines.delete('investigation-checkpoint');
    }
    this.#workPass = pass;
    if (this.#boundedStages) this.#enterStage(phase === 'compose' ? 'compose' : phase === 'review'
      ? pass === 'final-inspection' ? 'audit' : pass === 'audit' || pass === 'preview' || pass === 'review-findings' ? pass
        : pass === 'source-save' ? 'review-checkpoint' : pass === 'inspection' ? 'review-inspection' : 'review'
      : pass === 'source-save' ? 'investigation-checkpoint' : 'investigate');
    if (this.#boundedStages && (pass === 'sources' || pass === 'review-supplement') && !this.#sourceDeadlines.has(pass)) {
      const scale = this.#limits.maxElapsedMs! / 1_200_000;
      this.#sourceDeadlines.set(pass, this.#deadline((pass === 'sources' ? 240_000 : 60_000) * scale));
    }
    if (phase === this.#phase) return;
    if (this.#phase === 'investigate') this.#investigationElapsed += Date.now() - this.#phaseStarted;
    if (this.#phase === 'review') this.#reviewElapsed += Date.now() - this.#phaseStarted;
    this.#phaseStarted = Date.now();
    this.#phase = phase;
  }

  #enterStage(stage: WorkStage): void {
    this.#workStage = stage;
    if (this.#stageDeadlines.has(stage)) return;
    const scale = this.#limits.maxElapsedMs! / 1_200_000;
    const allowance = Math.min(STAGE_BUDGETS[stage] * scale - (stage === 'investigation-checkpoint' ? this.#investigationSaveSpent : 0),
      stage === 'investigate' ? this.#limits.investigationMs ?? Infinity : Infinity);
    if (stage === 'investigation-checkpoint') this.#investigationSaveStarted = Date.now();
    const globalBoundary = this.#started + this.#limits.maxElapsedMs! - FINISH_RESERVES[stage] * scale;
    this.#stageDeadlines.set(stage, this.#deadline(allowance, globalBoundary));
  }

  #deadline(allowance: number, boundary = Infinity): number {
    return Math.floor(Math.min(Date.now() + allowance, boundary));
  }

  workDeadline(): { at: number; reason: string } | undefined {
    const at = this.#stageDeadlines.get(this.#workStage);
    const source = this.#workPass === undefined ? undefined : this.#sourceDeadlines.get(this.#workPass);
    return at === undefined ? undefined : { at: Math.min(at, source ?? Infinity), reason: STAGE_REASONS[this.#workStage] };
  }

  observe(event: AgentAuditEvent): void {
    if (event.type === 'agent.usage_reported') {
      this.#usageReports++;
      const cost = event.payload.estimatedCostUsd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) this.#estimatedCost += cost;
      else this.#priceUnknown = true;
    }
    if (event.type === 'agent.model_request') {
      this.checkHard('model request');
      if (this.#limits.maxModelRequests !== undefined && this.#requests >= this.#limits.maxModelRequests) {
        throw new ComparisonResourceLimit('Comparison resource limit: maxModelRequests.');
      }
      this.#requests++;
      if (this.#phase === 'investigate') this.#investigationRequests++;
      if (this.#phase === 'review') this.#reviewRequests++;
    }
    if (event.type === 'agent.tool_called' && typeof event.payload.toolCallId === 'string' && !this.#toolIds.has(event.payload.toolCallId)) {
      this.#toolIds.add(event.payload.toolCallId);
      this.#tools++;
      if (this.#phase === 'investigate') this.#investigationTools++;
      if (this.#phase === 'review') this.#reviewTools++;
    }
  }

  checkHard(action: string): void {
    const limits = this.#limits;
    if (limits.maxToolCalls !== undefined && this.#tools > limits.maxToolCalls) {
      throw new ComparisonResourceLimit('Comparison resource limit: maxToolCalls.');
    }
    if (limits.maxElapsedMs !== undefined && Date.now() - this.#started >= limits.maxElapsedMs) {
      throw new ComparisonResourceLimit(`Comparison resource limit: maxElapsedMs before ${action}.`);
    }
    if (limits.maxEstimatedCostUsd !== undefined && this.#estimatedCost >= limits.maxEstimatedCostUsd) {
      throw new ComparisonResourceLimit(`Comparison resource limit: maxEstimatedCostUsd before ${action}.`);
    }
    if (limits.maxEstimatedCostUsd !== undefined && (this.#priceUnknown || this.#usageReports < this.#requests)) {
      throw new ComparisonResourceLimit(`Comparison cost protection unavailable: missing usage or pricing before ${action}.`);
    }
  }

  beforeTool(name: string): string | undefined {
    this.checkHard(name);
    const deadline = this.workDeadline();
    if (deadline && Date.now() >= deadline.at) return deadline.reason;
    if (this.#phase === 'review') {
      if (['inspect_comparison_draft', 'quote_evidence', 'update_comparison_findings', 'update_comparison_findings_delta', 'save_comparison_checkpoint', 'submit_comparison_draft', 'preview_report', 'write', 'edit'].includes(name)) return undefined;
      return this.reviewReason();
    }
    if (this.#phase !== 'investigate' || name === 'update_comparison_findings' || name === 'update_comparison_findings_delta' || name === 'save_comparison_checkpoint') return undefined;
    return this.softReason();
  }

  softReason(): string | undefined {
    const limits = this.#limits;
    if (limits.investigationModelRequests !== undefined && this.#investigationRequests >= limits.investigationModelRequests) return 'investigationModelRequests';
    if (limits.investigationToolCalls !== undefined && this.#investigationTools >= limits.investigationToolCalls) return 'investigationToolCalls';
    const elapsed = this.#investigationElapsed + (this.#phase === 'investigate' ? Date.now() - this.#phaseStarted : 0);
    if (limits.investigationMs !== undefined && elapsed >= limits.investigationMs) return 'investigationMs';
    return undefined;
  }

  reviewReason(): string | undefined {
    if (this.#boundedStages) {
      const deadline = this.workDeadline();
      if (deadline && Date.now() >= deadline.at) return deadline.reason;
      if ((this.#limits.maxModelRequests !== undefined && this.#limits.maxModelRequests - this.#requests <= 4)
        || (this.#limits.maxToolCalls !== undefined && this.#limits.maxToolCalls - this.#tools <= 6)) return 'reserve_finish';
      return undefined;
    }
    const limits = this.#limits;
    if ((limits.maxModelRequests !== undefined && limits.maxModelRequests - this.#requests <= 6)
      || (limits.maxToolCalls !== undefined && limits.maxToolCalls - this.#tools <= 20)
      || (limits.maxElapsedMs !== undefined && limits.maxElapsedMs - (Date.now() - this.#started) <= 90_000)) return 'reserve_finish';
    if (limits.investigationModelRequests !== undefined && this.#reviewRequests >= limits.investigationModelRequests) return 'reviewModelRequests';
    if (limits.investigationToolCalls !== undefined && this.#reviewTools >= limits.investigationToolCalls) return 'reviewToolCalls';
    const elapsed = this.#reviewElapsed + (this.#phase === 'review' ? Date.now() - this.#phaseStarted : 0);
    if (limits.investigationMs !== undefined && elapsed >= limits.investigationMs) return 'reviewMs';
    return undefined;
  }

  investigationRemainingMs(): number | undefined {
    if (this.#boundedStages) return Math.max(0, this.#stageDeadlines.get('investigate')! - Date.now());
    const now = Date.now();
    const remaining: number[] = [];
    if (this.#limits.investigationMs !== undefined) remaining.push(this.#limits.investigationMs
      - this.#investigationElapsed - (this.#phase === 'investigate' ? now - this.#phaseStarted : 0));
    if (this.#limits.maxElapsedMs !== undefined) remaining.push(this.#limits.maxElapsedMs - (now - this.#started) - 90_000);
    return remaining.length ? Math.max(0, Math.min(...remaining)) : undefined;
  }

  sourceRemainingMs(): number | undefined {
    if (this.#boundedStages) {
      const deadline = this.#workStage === 'review' ? this.workDeadline()?.at : this.#stageDeadlines.get('review');
      return deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    }
    const now = Date.now();
    const remaining: number[] = [];
    if (this.#limits.investigationMs !== undefined) remaining.push(this.#limits.investigationMs
      - this.#reviewElapsed - (this.#phase === 'review' ? now - this.#phaseStarted : 0));
    if (this.#limits.maxElapsedMs !== undefined) remaining.push(this.#limits.maxElapsedMs - (now - this.#started) - 90_000);
    return remaining.length ? Math.max(0, Math.min(...remaining)) : undefined;
  }

  snapshot(): Record<string, unknown> {
    const deadline = this.workDeadline();
    return { schemaVersion: 1, modelRequests: this.#requests, toolCalls: this.#tools, elapsedMs: Date.now() - this.#started,
      ...(deadline ? { workStage: this.#workStage, workDeadlineAt: deadline.at, workRemainingMs: Math.max(0, deadline.at - Date.now()) } : {}),
      estimatedCostUsd: this.#priceUnknown || this.#usageReports === 0 || this.#usageReports < this.#requests ? null : this.#estimatedCost,
      knownEstimatedCostUsd: this.#estimatedCost, usageReports: this.#usageReports,
      pricingIncomplete: this.#priceUnknown || this.#usageReports < this.#requests || this.#usageReports === 0,
      investigationLimit: this.softReason() ?? null, phase: this.#phase,
      remainingRequests: this.#limits.maxModelRequests === undefined ? null : Math.max(0, this.#limits.maxModelRequests - this.#requests),
      remainingTools: this.#limits.maxToolCalls === undefined ? null : Math.max(0, this.#limits.maxToolCalls - this.#tools),
      remainingMs: this.#limits.maxElapsedMs === undefined ? null : Math.max(0, this.#limits.maxElapsedMs - (Date.now() - this.#started)),
      reviewLimit: this.#phase === 'review' ? this.reviewReason() ?? null : null };
  }
}
