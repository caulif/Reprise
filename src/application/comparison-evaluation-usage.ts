import { ComparisonCosts } from '../agents/comparison-costs.js';
import { AgentUsageEstimateSchema } from '../core/schema.js';
import { Value } from '@sinclair/typebox/value';
import type { EventEnvelope } from '../core/schema.js';
import { record } from '../core/json.js';
import { comparisonEvaluationUsageCoverage } from './comparison-evaluation.js';
import { usagePricing } from './session-usage.js';
import type { ModelPricing, PricingResolveOptions } from './model-pricing.js';
import type { ComparisonEvaluationLedger } from '../core/comparison-evaluation-schema.js';

type UsageSummary = Pick<ComparisonEvaluationLedger['rows'][number], 'usage' | 'usageCoverage' | 'pricingLookup' | 'estimatedCostUsd' | 'knownEstimatedCostUsd' | 'fallbackEstimatedCostUsd' | 'fallbackRequests' | 'costBasis'>;

/** Pi usage is per actual request model; a configured model name is not a pricing fallback. */
export function summarizeComparisonEvaluationUsage(events: readonly EventEnvelope[], options?: PricingResolveOptions,
  pricingTable?: Record<string, ModelPricing>): UsageSummary {
  const usageEvents = events.filter(event => event.type === 'agent.usage_reported' || event.type === 'agent.usage_estimated');
  const usageCoverage = comparisonEvaluationUsageCoverage(events);
  if (!usageEvents.length) return { usageCoverage, pricingLookup: 'miss' as const };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const costs = new ComparisonCosts();
  let knownPrices = 0;
  for (const event of events) {
    if (event.type === 'agent.model_request') {
      costs.observe({ type: event.type, payload: record(event.payload), sessionId: 'evaluation', role: 'comparison' });
      continue;
    }
    if (event.type !== 'agent.usage_reported' && event.type !== 'agent.usage_estimated') continue;
    const fallback = event.type === 'agent.usage_estimated';
    const payload = record(event.payload);
    if (fallback && !Value.Check(AgentUsageEstimateSchema, payload)) throw new Error('Invalid evaluation usage estimate.');
    const observed = record(payload.usage);
    const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      const count = observed[key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid evaluation usage audit.');
      parts[key] = count;
      if (!fallback) usage[key] += count;
      if (!Number.isSafeInteger(usage[key])) throw new Error('Evaluation usage aggregate exceeds safe integer range.');
    }
    const priced = usagePricing({ parts: { input: parts.input, output: parts.output, cacheRead: parts.cacheRead,
      cacheCreation: parts.cacheWrite }, display: parts.totalTokens, inputIncludesCache: false },
    typeof payload.model === 'string' ? payload.model : undefined, pricingTable, options);
    costs.observe({ type: event.type, payload: { ...payload, lookup: priced.lookup, estimatedCostUsd: priced.costUsd }, sessionId: 'evaluation', role: 'comparison' });
    if (priced.costUsd !== undefined && !fallback) knownPrices++;
  }
  const summary = costs.snapshot();
  return { ...(summary.usageReports ? { usage } : {}), usageCoverage, pricingLookup: costs.pricingLookup(),
    ...(knownPrices ? { knownEstimatedCostUsd: summary.knownEstimatedCostUsd } : {}),
    fallbackEstimatedCostUsd: summary.fallbackEstimatedCostUsd, fallbackRequests: summary.fallbackRequests, costBasis: summary.costBasis,
    ...(summary.estimatedCostUsd !== null && (usageCoverage === 'complete' || summary.fallbackRequests > 0)
      ? { estimatedCostUsd: summary.estimatedCostUsd } : {}) };
}
