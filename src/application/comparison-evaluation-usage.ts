import type { EventEnvelope } from '../core/schema.js';
import { record } from '../core/json.js';
import { comparisonEvaluationUsageCoverage } from './comparison-evaluation.js';
import { usagePricing } from './session-usage.js';
import type { ModelPricing, PricingResolveOptions } from './model-pricing.js';
import type { ComparisonEvaluationLedger } from '../core/comparison-evaluation-schema.js';

type UsageSummary = Pick<ComparisonEvaluationLedger['rows'][number], 'usage' | 'usageCoverage' | 'pricingLookup' | 'estimatedCostUsd' | 'knownEstimatedCostUsd'>;

/** Pi usage is per actual request model; a configured model name is not a pricing fallback. */
export function summarizeComparisonEvaluationUsage(events: readonly EventEnvelope[], options?: PricingResolveOptions,
  pricingTable?: Record<string, ModelPricing>): UsageSummary {
  const usageEvents = events.filter(event => event.type === 'agent.usage_reported');
  const usageCoverage = comparisonEvaluationUsageCoverage(events);
  if (!usageEvents.length) return { usageCoverage, pricingLookup: 'miss' as const };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let knownEstimatedCostUsd = 0;
  let knownPrices = 0;
  let pricingLookup: 'hit' | 'miss' | 'invalid' = 'hit';
  for (const event of usageEvents) {
    const payload = record(event.payload);
    const observed = record(payload.usage);
    const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      const count = observed[key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid evaluation usage audit.');
      parts[key] = count;
      usage[key] += count;
      if (!Number.isSafeInteger(usage[key])) throw new Error('Evaluation usage aggregate exceeds safe integer range.');
    }
    const priced = usagePricing({ parts: { input: parts.input, output: parts.output, cacheRead: parts.cacheRead,
      cacheCreation: parts.cacheWrite }, display: parts.totalTokens, inputIncludesCache: false },
    typeof payload.model === 'string' ? payload.model : undefined, pricingTable, options);
    if (priced.lookup === 'invalid') pricingLookup = 'invalid';
    else if (priced.lookup === 'miss' && pricingLookup !== 'invalid') pricingLookup = 'miss';
    if (priced.costUsd !== undefined) { knownEstimatedCostUsd += priced.costUsd; knownPrices++; }
  }
  return { usage, usageCoverage, pricingLookup,
    ...(knownPrices ? { knownEstimatedCostUsd } : {}),
    ...(usageCoverage === 'complete' && pricingLookup === 'hit' ? { estimatedCostUsd: knownEstimatedCostUsd } : {}) };
}
