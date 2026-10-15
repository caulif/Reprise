import { DEFAULT_AGENT_DEADLINE_MS } from '../core/agent-defaults.js';
import { AutonomousComparisonAgent } from '../agents/comparison-autonomous.js';
import { DEFAULT_COMPARISON_RESOURCES, resolveAutonomousComparisonResources } from '../agents/comparison-resources.js';
import { RecoveryAgent } from '../agents/recovery-agent.js';
import { ControllerAgent } from '../agents/controller-agent.js';
import type { AgentLocale } from '../agents/language.js';
import { AgentHost, type ProviderAdapter } from '../infrastructure/agent/host.js';
import { PiModelCaller, PI_PROBE_POLICY } from '../infrastructure/agent/model-caller.js';
import type { HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import type { AgentBudget, EffectiveHarnessConfiguration, HarnessConfigurationReference } from '../core/schema.js';
import { frozenSnapshot } from '../core/json.js';

export type HarnessAgents = {
  readonly controller: ControllerAgent;
  readonly comparison: AutonomousComparisonAgent;
  readonly recovery: RecoveryAgent;
  readonly config: {
    readonly providerId: string;
    readonly requestedModel: string;
    readonly budget: AgentBudget;
    readonly recoveryBudget: { readonly callTimeoutMs: number; readonly maxStructuredRepairAttempts: number };
    readonly effective?: EffectiveHarnessConfiguration;
    readonly effectiveReference?: HarnessConfigurationReference;
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
  const budget: AgentBudget = frozenSnapshot({ ...(limits.budget ?? DEFAULT_BUDGET),
    comparisonResources: limits.budget?.comparisonResources ?? DEFAULT_COMPARISON_RESOURCES });
  const recoveryBudget = frozenSnapshot(limits.recoveryBudget ?? limits.budget ?? DEFAULT_BUDGET);
  const locale = options.locale ?? 'zh';
  const effective = caller instanceof PiModelCaller ? effectiveHarnessConfiguration(caller, budget, recoveryBudget, locale) : undefined;
  return {
    comparison: new AutonomousComparisonAgent({
      host,
      timeoutMs: budget.callTimeoutMs,
      locale,
      ...(budget.comparisonResources ? { resources: budget.comparisonResources } : {}),
    }),
    controller: new ControllerAgent({ host, timeoutMs: 0, maxRepairAttempts: budget.maxStructuredRepairAttempts, locale }),
    recovery: new RecoveryAgent({ host, timeoutMs: recoveryBudget.callTimeoutMs, maxRepairAttempts: recoveryBudget.maxStructuredRepairAttempts, locale }),
    config: frozenSnapshot({ providerId: config.providerId, requestedModel: config.modelId, budget, recoveryBudget, ...(effective ? { effective } : {}) }),
  };
}

function effectiveHarnessConfiguration(caller: PiModelCaller, budget: AgentBudget, recoveryBudget: AgentBudget, locale: AgentLocale): EffectiveHarnessConfiguration {
  const resources = resolveAutonomousComparisonResources(budget.callTimeoutMs, budget.comparisonResources);
  const enforcedResources = {
    maxElapsedMs: resources.maxElapsedMs!,
    ...(resources.maxModelRequests === undefined ? {} : { maxModelRequests: resources.maxModelRequests }),
    ...(resources.maxToolCalls === undefined ? {} : { maxToolCalls: resources.maxToolCalls }),
    ...(resources.maxEstimatedCostUsd === undefined ? {} : { maxEstimatedCostUsd: resources.maxEstimatedCostUsd }),
  };
  return frozenSnapshot({ schemaVersion: 1, source: 'builtin-pi', locale, model: caller.effectiveModelConfiguration,
    controller: { singleCall: { kind: 'unlimited' }, maxStructuredRepairAttempts: budget.maxStructuredRepairAttempts,
      decisionLimitScope: 'candidate-controller-loop', ...(budget.maxCalls === undefined ? {} : { decisionLimit: budget.maxCalls }) },
    recovery: { singleCall: { kind: 'finite', milliseconds: recoveryBudget.callTimeoutMs },
      operationTotal: { kind: 'finite', milliseconds: recoveryBudget.callTimeoutMs }, maxStructuredRepairAttempts: recoveryBudget.maxStructuredRepairAttempts },
    comparison: { configuredCallCap: { kind: 'finite', milliseconds: budget.callTimeoutMs },
      operationTotal: { kind: 'finite', milliseconds: resources.maxElapsedMs! }, mode: 'autonomous-total',
      requestDeadlineRule: 'min-remaining-operation-and-configured-call-cap',
      requestedResources: budget.comparisonResources ?? {}, enforcedResources }, probe: PI_PROBE_POLICY });
}
