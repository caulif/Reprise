import { ComparisonAgent } from '../agents/comparison-agent.js';
import { ControllerAgent } from '../agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../infrastructure/pi-agent-host.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import type { HarnessModelConfig } from '../infrastructure/harness-model-config.js';

export type HarnessAgents = {
  readonly controller: ControllerAgent;
  readonly comparison: ComparisonAgent;
  readonly config: {
    readonly providerId: string;
    readonly requestedModel: string;
    readonly budget: { readonly callTimeoutMs: number; readonly maxStructuredRepairAttempts: number };
  };
};

/**
 * Constructs all internal agents from the one persisted, non-sensitive Pi choice.
 * Credentials remain entirely in Pi's provider layer.
 */
export function createHarnessAgents(config: HarnessModelConfig, caller: PiTextCaller = new PiModelCaller(config)): HarnessAgents {
  const host = new PiAgentHost(caller);
  const budget = { callTimeoutMs: 90_000, maxStructuredRepairAttempts: 1 };
  const options = { host, timeoutMs: budget.callTimeoutMs, maxRepairAttempts: budget.maxStructuredRepairAttempts };
  return {
    controller: new ControllerAgent(options),
    comparison: new ComparisonAgent(options),
    config: { providerId: config.providerId, requestedModel: config.modelId, budget },
  };
}
