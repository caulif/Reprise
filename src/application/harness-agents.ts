import { ComparisonAgent } from '../agents/comparison-agent.js';
import { RecoveryAgent } from '../agents/recovery-agent.js';
import { ControllerAgent } from '../agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../infrastructure/pi-agent-host.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import type { HarnessModelConfig } from '../infrastructure/harness-model-config.js';

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
/** Persisted snapshot only; schema requires callTimeoutMs >= 1. Live Host calls use timeoutMs 0. */
const UNBOUNDED_CALL_SNAPSHOT_MS = 24 * 60 * 60_000;

export function createHarnessAgents(config: HarnessModelConfig, caller: PiTextCaller = new PiModelCaller(config)): HarnessAgents {
  const host = new PiAgentHost(caller);
  const budget = { callTimeoutMs: UNBOUNDED_CALL_SNAPSHOT_MS, maxStructuredRepairAttempts: 1 };
  const recoveryBudget = { callTimeoutMs: UNBOUNDED_CALL_SNAPSHOT_MS, maxStructuredRepairAttempts: 1 };
  const options = { host, timeoutMs: 0, maxRepairAttempts: budget.maxStructuredRepairAttempts };
  return {
    controller: new ControllerAgent(options),
    comparison: new ComparisonAgent(options),
    recovery: new RecoveryAgent({ host, timeoutMs: 0, maxRepairAttempts: recoveryBudget.maxStructuredRepairAttempts }),
    config: { providerId: config.providerId, requestedModel: config.modelId, budget, recoveryBudget },
  };
}
