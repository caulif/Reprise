import type { AgentToolResult } from '../infrastructure/agent/host.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';

export function comparisonToolFeedback(result: AgentToolResult, resources: ComparisonResourceTracker, toolName: string): AgentToolResult {
  return { ...result, contentBlocks: [
    ...(result.contentBlocks ?? [{ type: 'text' as const, text: result.content }]),
    { type: 'text', text: `Host total-time budget remaining: ${String(resources.snapshot().remainingMs)} ms. Plan investigation, reporting and revision within this remaining time; no separate stage allowance is reserved.` },
    ...(toolName === 'read' ? [{ type: 'text' as const, text: `Host read coverage: ${JSON.stringify(comparisonReadCoverage(result.details))}` }] : []),
  ] };
}

export function comparisonReadCoverage(details: unknown): Record<string, number | boolean> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const source = details as Record<string, unknown>;
  const coverage: Record<string, number | boolean> = {};
  for (const key of ['available', 'truncated']) {
    if (typeof source[key] === 'boolean') coverage[key] = source[key];
  }
  for (const key of ['offset', 'byteLength', 'returnedBytes', 'totalBytes', 'nextCursor']) {
    const value = source[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) coverage[key] = value;
  }
  return coverage;
}
