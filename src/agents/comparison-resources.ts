import type { ComparisonResources } from '../core/schema.js';
import type { AgentAuditEvent } from '../infrastructure/agent/host.js';

export const DEFAULT_COMPARISON_RESOURCES: Readonly<ComparisonResources> = Object.freeze({
  investigationModelRequests: 12, investigationToolCalls: 30, investigationMs: 120_000,
  maxModelRequests: 40, maxToolCalls: 120, maxElapsedMs: 600_000,
});

class ComparisonResourceLimit extends Error {}

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

  constructor(limits: ComparisonResources) { this.#limits = limits; }

  phase(phase: string): void {
    if (phase === this.#phase) return;
    if (this.#phase === 'investigate') this.#investigationElapsed += Date.now() - this.#phaseStarted;
    if (this.#phase === 'review') this.#reviewElapsed += Date.now() - this.#phaseStarted;
    this.#phaseStarted = Date.now();
    this.#phase = phase;
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
    if (this.#phase === 'review') {
      if (['inspect_comparison_draft', 'update_comparison_findings', 'submit_comparison_draft', 'preview_report', 'write', 'edit'].includes(name)) return undefined;
      return this.reviewReason();
    }
    if (this.#phase !== 'investigate' || name === 'update_comparison_findings') return undefined;
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

  snapshot(): Record<string, unknown> {
    return { schemaVersion: 1, modelRequests: this.#requests, toolCalls: this.#tools, elapsedMs: Date.now() - this.#started,
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
