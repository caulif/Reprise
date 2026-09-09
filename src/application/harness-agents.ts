import { ComparisonAgent } from '../agents/comparison-agent.js';
import { RecoveryAgent } from '../agents/recovery-agent.js';
import { ControllerAgent } from '../agents/controller-agent.js';
import { AgentHost, type ProviderAdapter } from '../infrastructure/agent/host.js';
import { PiModelCaller } from '../infrastructure/agent/model-caller.js';
import type { HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import type { AgentBudget } from '../core/schema.js';

export type HarnessAgents = {
  readonly controller: ControllerAgent;
  readonly comparison: ComparisonAgent;
  readonly recovery: RecoveryAgent;
  readonly config: {
    readonly providerId: string;
    readonly requestedModel: string;
    readonly budget: { readonly callTimeoutMs: number; readonly maxStructuredRepairAttempts: number };
    readonly recoveryBudget: { readonly callTimeoutMs: number; readonly maxStructuredRepairAttempts: number };
  };
};

/**
 * Constructs all internal agents from the one persisted, non-sensitive Pi choice.
 * Credentials remain entirely in Pi's provider layer.
 */
const DEFAULT_BUDGET: AgentBudget = { callTimeoutMs: 24 * 60 * 60_000, maxStructuredRepairAttempts: 1 };

export function createHarnessAgents(config: HarnessModelConfig, caller: ProviderAdapter = new PiModelCaller(config), limits: { budget?: AgentBudget; recoveryBudget?: AgentBudget } = {}): HarnessAgents {
  const host = new AgentHost(caller);
  const budget = limits.budget ?? DEFAULT_BUDGET;
  const recoveryBudget = limits.recoveryBudget ?? budget;
  return {
    comparison: new ComparisonAgent({ host, timeoutMs: 0, maxRepairAttempts: budget.maxStructuredRepairAttempts }),
    controller: new ControllerAgent({ host, timeoutMs: 0, maxRepairAttempts: budget.maxStructuredRepairAttempts }),
    recovery: new RecoveryAgent({ host, timeoutMs: recoveryBudget.callTimeoutMs, maxRepairAttempts: recoveryBudget.maxStructuredRepairAttempts }),
    config: { providerId: config.providerId, requestedModel: config.modelId, budget, recoveryBudget },
  };
}
