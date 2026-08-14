import { randomUUID } from 'node:crypto';
import type { CandidateSpec, EventEnvelope, RunPolicy, TaskCase } from '../core/schema.js';
import type { RuntimePort } from '../core/runtime.js';
import { readHarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import { createHarnessAgents, type HarnessAgents } from './harness-agents.js';
import { preflightCodexExperiment, recoverCodexExperiment, startCodexExperiment, type CodexExperimentPreflight, type ExperimentHandle, type RecoveryAttempt } from './experiment.js';
import type { EnvironmentBaseline } from '../environment/local-workspace-provider.js';
import type { ProductPack } from '../products/contract.js';
import { findProductPack } from '../products/index.js';
import type { SourceRootKind } from './replay-conditions.js';

export const DEFAULT_CANDIDATE: CandidateSpec = { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' };
/** Last-resort safety valve. Completion is a Controller decision, not these numbers. */
export const TUI_RUN_POLICY: RunPolicy = {
  wallClockMs: 24 * 60 * 60_000,
  maxTargetTurns: 256,
  maxModelCalls: 256,
  turnTimeoutMs: 2 * 60 * 60_000,
  maxConsecutiveNoProgress: 2,
};

type ExperimentDefaults = { readonly candidate: CandidateSpec; readonly policy: RunPolicy };
type ExperimentRequest = { taskCase: TaskCase; sourceRoot: string; sourceRootKind?: SourceRootKind; expectedSourceFingerprint?: string; preResolvedBaseline?: EnvironmentBaseline; recoveryAttempt?: RecoveryAttempt; experimentId?: string; runId?: string; onEvent: (event: EventEnvelope) => void };
type RecoveryRequest = Omit<ExperimentRequest, 'onEvent' | 'expectedSourceFingerprint' | 'preResolvedBaseline' | 'recoveryAttempt' | 'experimentId' | 'runId'> & { onEvent?: (event: EventEnvelope) => void };

export type CodexTuiWorkflow = {
  readonly candidate: CandidateSpec;
  readonly policy: RunPolicy;
  preflight(input: Omit<ExperimentRequest, 'onEvent' | 'preResolvedBaseline'>): Promise<CodexExperimentPreflight>;
  recover(input: RecoveryRequest): Promise<RecoveryAttempt>;
  start(input: ExperimentRequest): Promise<ExperimentHandle>;
};

/** One experiment composition root shared by the interactive TUI and explicit protocol smoke. */
export function createCodexExperimentWorkflow(input: { dataDir: string; runtime: RuntimePort; pack?: ProductPack; agents: () => Promise<HarnessAgents>; now: () => string; defaults?: ExperimentDefaults }): CodexTuiWorkflow {
  const fallbackPack = input.pack ?? findProductPack(input.runtime.id);
  const { candidate, policy } = input.defaults ?? { candidate: fallbackPack.defaultCandidate(), policy: TUI_RUN_POLICY };
  const resolve = (taskCase: TaskCase) => {
    const pack = findProductPack(taskCase.source.productId);
    const selected = candidate.productId === pack.manifest.productId ? candidate : pack.defaultCandidate();
    return { pack, candidate: selected, runtime: pack.runtime };
  };
  return {
    candidate,
    policy,
    preflight: ({ taskCase, sourceRoot }) => {
      const selected = resolve(taskCase);
      return preflightCodexExperiment({ dataDir: input.dataDir, caseId: taskCase.caseId, experimentId: previewExperimentId(taskCase.caseId), sourceRoot, taskCase, candidate: selected.candidate, runtime: selected.runtime });
    },
    async recover(request): Promise<RecoveryAttempt> {
      const agents = await input.agents();
      const experimentId = `recovery-${randomUUID()}`;
      const runId = `recovery-run-${randomUUID()}`;
      return recoverCodexExperiment({ dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot, taskCase: request.taskCase, recovery: agents.recovery, maxToolCalls: agents.config.recoveryBudget.maxToolCalls, now: input.now(), ...(request.onEvent ? { onEvent: request.onEvent } : {}) });
    },
    async start(request): Promise<ExperimentHandle> {
      const agents = await input.agents();
      const selected = resolve(request.taskCase);
      const experimentId = request.recoveryAttempt?.experimentId ?? request.experimentId ?? `experiment-${randomUUID()}`;
      const runId = request.runId ?? `run-${randomUUID()}`;
      return startCodexExperiment({
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, candidate: selected.candidate, runtime: selected.runtime, controller: agents.controller, comparison: agents.comparison,
        agentConfig: agents.config, policy, now: input.now(), onEvent: request.onEvent,
        ...(request.expectedSourceFingerprint ? { expectedSourceFingerprint: request.expectedSourceFingerprint } : {}),
        ...(request.preResolvedBaseline ? { preResolvedBaseline: request.preResolvedBaseline } : {}),
        ...(request.recoveryAttempt ? { environmentProvider: request.recoveryAttempt.provider, ...(request.preResolvedBaseline ? {} : { preResolvedBaseline: request.recoveryAttempt.baseline }) } : {}),
        ...(request.sourceRootKind ? { sourceRootKind: request.sourceRootKind } : {}),
      });
    },
  };
}

/** Creates the production TUI bridge. Selecting a session, or `/run` on a current TaskCase, starts the isolated experiment. */
export function createCodexTuiWorkflow(input: { dataDir: string; runtime: RuntimePort; pack?: ProductPack; now: () => string }): CodexTuiWorkflow {
  let validated: { key: string; agents: HarnessAgents } | undefined;
  return createCodexExperimentWorkflow({
    ...input,
    agents: async () => {
      const config = await readHarnessModelConfig(input.dataDir);
      if (!config) throw new Error('Harness Pi setup is required before an experiment can start.');
      const key = JSON.stringify(config);
      if (validated?.key === key) return validated.agents;
      const caller = new PiModelCaller(config);
      // The connection check is a real, billable request, so it is repeated only when the configuration changes.
      await caller.validate();
      validated = { key, agents: createHarnessAgents(config, caller) };
      return validated.agents;
    },
  });
}

function previewExperimentId(caseId: string): string { return `preview-${caseId}`; }
