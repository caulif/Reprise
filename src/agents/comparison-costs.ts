import type { AgentAuditEvent } from '../infrastructure/agent/host.js';

/** Costs based on provider usage and heuristic fallback remain separately auditable. */
export class ComparisonCosts {
  readonly #requests = new Set<string>();
  readonly #costs = new Map<string, { fallback: boolean; cost: number | undefined; lookup: 'hit' | 'miss' | 'invalid' }>();
  #legacyRequests = 0;
  #legacyReports = 0;

  observe(event: AgentAuditEvent): void {
    const id = typeof event.payload.requestId === 'string' ? event.payload.requestId : undefined;
    if (event.type === 'agent.model_request') {
      if (id) {
        if (this.#requests.has(id)) throw new Error('Duplicate model request ID.');
        this.#requests.add(id);
      } else this.#legacyRequests++;
      return;
    }
    if (event.type !== 'agent.usage_reported' && event.type !== 'agent.usage_estimated') return;
    if (id && !this.#requests.has(id)) throw new Error('Usage has no matching model request ID.');
    const fallback = event.type === 'agent.usage_estimated';
    if (fallback && !id) throw new Error('Usage estimate requires a model request ID.');
    const key = id ?? `legacy:${this.#legacyReports++}`;
    // A later observed usage supersedes its estimate; an estimate never replaces observed usage.
    if (fallback && this.#costs.get(key)?.fallback === false) return;
    const cost = event.payload.estimatedCostUsd;
    const amount = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    const lookup = event.payload.lookup === 'invalid' ? 'invalid' : amount === undefined ? 'miss' : 'hit';
    this.#costs.set(key, { fallback, cost: amount, lookup });
  }

  pricingLookup(): 'hit' | 'miss' | 'invalid' {
    const records = [...this.#costs.values()];
    if (records.some(row => row.lookup === 'invalid')) return 'invalid';
    return records.some(row => row.lookup === 'miss') ? 'miss' : 'hit';
  }

  snapshot() {
    const costs = [...this.#costs.values()];
    const usageReports = costs.filter(row => !row.fallback).length;
    const fallbackRequests = costs.length - usageReports;
    const knownEstimatedCostUsd = costs.reduce((sum, row) => sum + (row.fallback ? 0 : row.cost ?? 0), 0);
    const fallbackEstimatedCostUsd = costs.reduce((sum, row) => sum + (row.fallback ? row.cost ?? 0 : 0), 0);
    const missing = [...this.#requests].some(id => !this.#costs.has(id)) || this.#legacyReports < this.#legacyRequests;
    const unknownPrice = costs.some(row => row.cost === undefined);
    const complete = costs.length > 0 && !missing && !unknownPrice;
    return { usageReports, fallbackRequests, knownEstimatedCostUsd, fallbackEstimatedCostUsd,
      estimatedCostUsd: complete ? knownEstimatedCostUsd + fallbackEstimatedCostUsd : null,
      pricingIncomplete: !complete || fallbackRequests > 0,
      costBasis: !complete ? 'incomplete' as const : fallbackRequests ? 'includes_fallback' as const : 'reported_usage' as const };
  }
}
