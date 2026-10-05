import type { ComparisonResources } from '../core/schema.js';
import type { FreeformInvocation } from '../infrastructure/agent/host.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';

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
