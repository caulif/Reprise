import type { ComparisonCompareOptions } from './comparison-agent.js';
import type { ComparisonResourceTracker } from './comparison-resources.js';
import type { AgentToolDefinition, AgentToolResult } from '../infrastructure/agent/host.js';
import { comparisonSoftLimitFeedback } from './comparison-tool-feedback.js';

export function resourceBoundTools(tools: readonly AgentToolDefinition[], resources: ComparisonResourceTracker,
  options?: ComparisonCompareOptions, repairReads: () => boolean = () => true, limitFeedback?: (reason: string) => AgentToolResult | undefined): AgentToolDefinition[] {
  return tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    const reason = resources.beforeTool(tool.name);
    signal.throwIfAborted();
    if (reason && !reason.startsWith('bounded_') && resources.snapshot().phase === 'review' && tool.name === 'read' && repairReads()
      && await options?.isRepairRead?.(params)) {
      signal.throwIfAborted();
      const afterReadPolicy = resources.beforeTool(tool.name);
      if (afterReadPolicy?.startsWith('bounded_')) return comparisonSoftLimitFeedback(afterReadPolicy, 'review');
      return tool.execute(params, signal);
    }
    if (reason) return limitFeedback?.(reason) ?? comparisonSoftLimitFeedback(reason, resources.snapshot().phase);
    return tool.execute(params, signal);
  } }));
}
