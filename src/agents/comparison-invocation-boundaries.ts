import type { ComparisonResources } from '../core/schema.js';
import type { FreeformInvocation } from '../infrastructure/agent/host.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { ComparisonReportFacts } from './comparison-agent.js';

export type ComparisonWorkPass = 'sources' | 'findings' | 'inspection' | 'audit' | 'preview';

export function comparisonTimeout(resources: ComparisonResourceTracker, limits: ComparisonResources, callTimeoutMs: number): number {
  resources.checkHard('phase invocation');
  if (limits.maxElapsedMs === undefined) return callTimeoutMs;
  const remaining = Math.max(1, limits.maxElapsedMs - Number(resources.snapshot().elapsedMs));
  return callTimeoutMs > 0 ? Math.min(callTimeoutMs, remaining) : remaining;
}

export function comparisonWorkDeadline(resources: ComparisonResourceTracker, phase: string, pass?: ComparisonWorkPass): { yieldDeadline?: { at: number; reason: string } } {
  const investigation = phase === 'investigate' && pass !== 'findings';
  const remaining = investigation ? resources.investigationRemainingMs() : pass === 'sources' ? resources.sourceRemainingMs() : undefined;
  return remaining === undefined ? {} : { yieldDeadline: { at: Date.now() + remaining, reason: investigation ? 'bounded_investigation_timeout' : 'bounded_source_timeout' } };
}

export function comparisonYieldBoundary(outcome: FreeformInvocation, resources: ComparisonResourceTracker, signal?: AbortSignal): FreeformInvocation {
  if (outcome.status === 'yielded') {
    resources.checkHard('after source or turn yield');
    if (signal?.aborted) return { status: 'cancelled', sessionId: outcome.sessionId };
  }
  return outcome;
}

export async function comparisonOutputContinuation(
  invoke: (prompt: string) => Promise<FreeformInvocation>,
  prompt: string,
): Promise<FreeformInvocation> {
  const first = await invoke(prompt);
  if (first.status !== 'yielded' || first.reason !== 'output_limit') return first;
  const continued = await invoke('The previous generation reached its output limit and did not complete this current phase/pass. Continue only its necessary remaining actions in this same session and audit scope; do not restart investigation or audit. Preserve unchecked task relationships and limitations. Check the actual Host metrics for each side before making cost/time comparisons. Do not assume a promised action or assessment was completed.');
  if (continued.status !== 'yielded' || continued.reason !== 'output_limit') return continued;
  return { status: 'failed', sessionId: continued.sessionId, failure: {
    code: 'invalid_output', kind: 'protocol', attempts: 2,
    message: 'Comparison generation reached its output limit again after one bounded continuation; the current phase/pass did not complete.',
  } };
}

export function comparisonDecisionMetrics(prompt: string, phase: string, metrics: ComparisonReportFacts['metrics']): string {
  if (phase !== 'compose' && phase !== 'review') return prompt;
  const side = (value: NonNullable<ComparisonReportFacts['metrics']>['candidate']) => ({
    elapsedMs: value?.elapsedMs ?? 'unknown', totalTokens: value?.tokens?.total ?? 'unknown',
    costUsd: value?.costUsd ?? 'unknown', usageStatus: value?.usageStatus ?? 'unknown',
    pricingStatus: value?.pricingStatus ?? 'unknown', pricingSource: value?.pricingSource ?? 'unknown',
    pricingVersion: value?.pricingVersion ?? 'unknown',
  });
  return `${prompt}\n\nCurrent Host-owned metric pair: ${JSON.stringify({ baseline: side(metrics?.baseline), candidate: side(metrics?.candidate) })}\nCheck comparison direction against each current side; do not infer cost from elapsed time or reuse a historical report's price claim. These recorded estimates are not invoices or semantic approval; unknown is not zero.`;
}
