import { DEFAULT_AGENT_DEADLINE_MS } from '../core/agent-defaults.js';
import { AutonomousComparisonAgent } from '../agents/comparison-autonomous.js';
import { DEFAULT_COMPARISON_RESOURCES } from '../agents/comparison-resources.js';
import { RecoveryAgent } from '../agents/recovery-agent.js';
import { ControllerAgent } from '../agents/controller-agent.js';
import type { AgentLocale } from '../agents/language.js';
import { AgentHost, type ProviderAdapter } from '../infrastructure/agent/host.js';
import { PiModelCaller } from '../infrastructure/agent/model-caller.js';
import type { HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import type { AgentBudget } from '../core/schema.js';

export type HarnessAgents = {
  readonly controller: ControllerAgent;
  readonly comparison: AutonomousComparisonAgent;
  readonly recovery: RecoveryAgent;
  readonly config: {
    readonly providerId: string;
    readonly requestedModel: string;
    readonly budget: AgentBudget;
    readonly recoveryBudget: { readonly callTimeoutMs: number; readonly maxStructuredRepairAttempts: number };
  };
};

/**
 * Constructs all internal agents from the one persisted, non-sensitive Pi choice.
 * Credentials remain entirely in Pi's provider layer.
 */
const DEFAULT_BUDGET: AgentBudget = { callTimeoutMs: DEFAULT_AGENT_DEADLINE_MS, maxStructuredRepairAttempts: 1 };

export function createHarnessAgents(
  config: HarnessModelConfig,
  caller: ProviderAdapter = new PiModelCaller(config),
  limits: { budget?: AgentBudget; recoveryBudget?: AgentBudget } = {},
  options: { locale?: AgentLocale } = {},
): HarnessAgents {
  const host = new AgentHost(caller);
  const budget: AgentBudget = { ...(limits.budget ?? DEFAULT_BUDGET),
    comparisonResources: limits.budget?.comparisonResources ?? DEFAULT_COMPARISON_RESOURCES };
  const recoveryBudget = limits.recoveryBudget ?? limits.budget ?? DEFAULT_BUDGET;
  const locale = options.locale ?? 'zh';
  return {
    comparison: new AutonomousComparisonAgent({
      host,
      timeoutMs: budget.callTimeoutMs,
      locale,
      ...(budget.comparisonResources ? { resources: budget.comparisonResources } : {}),
    }),
    controller: new ControllerAgent({ host, timeoutMs: 0, maxRepairAttempts: budget.maxStructuredRepairAttempts, locale }),
    recovery: new RecoveryAgent({ host, timeoutMs: recoveryBudget.callTimeoutMs, maxRepairAttempts: recoveryBudget.maxStructuredRepairAttempts, locale }),
    config: { providerId: config.providerId, requestedModel: config.modelId, budget, recoveryBudget },
  };
}
