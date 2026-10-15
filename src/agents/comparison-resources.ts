import type { ComparisonResources } from '../core/schema.js';
import type { AgentAuditEvent } from '../infrastructure/agent/host.js';

export const DEFAULT_COMPARISON_RESOURCES: Readonly<ComparisonResources> = Object.freeze({ maxElapsedMs: 24 * 60 * 60_000 });
class ComparisonResourceLimit extends Error {}

export class ComparisonResourceTracker {
  readonly #limits: ComparisonResources;
  readonly #started = Date.now();
  readonly #toolIds = new Set<string>();
  #requests = 0;
  #tools = 0;
  #toolLimitReached = false;
  #estimatedCost = 0;
  #usageReports = 0;
  #priceUnknown = false;

  constructor(limits: ComparisonResources) { this.#limits = limits; }

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
    }
    if (event.type === 'agent.tool_called' && typeof event.payload.toolCallId === 'string' && !this.#toolIds.has(event.payload.toolCallId)) {
      if (this.#limits.maxToolCalls !== undefined && this.#tools >= this.#limits.maxToolCalls) {
        this.#toolLimitReached = true;
        throw new ComparisonResourceLimit('Comparison resource limit: maxToolCalls before tool admission.');
      }
      this.#toolIds.add(event.payload.toolCallId);
      this.#tools++;
    }
  }

  checkHard(action: string): void {
    const limits = this.#limits;
    if (this.#toolLimitReached || (limits.maxToolCalls !== undefined && this.#tools > limits.maxToolCalls)) {
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


  beforeTool(name: string): void { this.checkHard(name); }

  snapshot(): Record<string, unknown> {
    return { schemaVersion: 1, modelRequests: this.#requests, toolCalls: this.#tools, elapsedMs: Date.now() - this.#started,
      estimatedCostUsd: this.#priceUnknown || this.#usageReports === 0 || this.#usageReports < this.#requests ? null : this.#estimatedCost,
      knownEstimatedCostUsd: this.#estimatedCost, usageReports: this.#usageReports,
      pricingIncomplete: this.#priceUnknown || this.#usageReports < this.#requests || this.#usageReports === 0,
      investigationLimit: null, phase: 'autonomous', reviewLimit: null,
      remainingRequests: this.#limits.maxModelRequests === undefined ? null : Math.max(0, this.#limits.maxModelRequests - this.#requests),
      remainingTools: this.#limits.maxToolCalls === undefined ? null : Math.max(0, this.#limits.maxToolCalls - this.#tools),
      remainingMs: this.#limits.maxElapsedMs === undefined ? null : Math.max(0, this.#limits.maxElapsedMs - (Date.now() - this.#started)) };
  }
}
