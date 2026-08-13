import { randomUUID } from 'node:crypto';
import type { CandidateSpec, EventEnvelope, RunPolicy, TaskCase } from '../core/schema.js';
import type { RuntimePort } from '../core/runtime.js';
import { readHarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import { createHarnessAgents, type HarnessAgents } from './harness-agents.js';
import { preflightCodexExperiment, startCodexExperiment, type CodexExperimentPreflight, type ExperimentHandle } from './codex-experiment.js';

export const DEFAULT_CANDIDATE: CandidateSpec = { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' };
export const TUI_RUN_POLICY: RunPolicy = {
  wallClockMs: 30 * 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10 * 60_000, maxConsecutiveNoProgress: 1,
};

type ExperimentDefaults = { readonly candidate: CandidateSpec; readonly policy: RunPolicy };
type ExperimentRequest = { taskCase: TaskCase; sourceRoot: string; onEvent(event: EventEnvelope): void };

export type CodexTuiWorkflow = {
  readonly candidate: CandidateSpec;
  readonly policy?: RunPolicy;
  preflight(input: Omit<ExperimentRequest, 'onEvent'>): Promise<CodexExperimentPreflight>;
  start(input: ExperimentRequest): Promise<ExperimentHandle>;
};

/** One experiment composition root shared by the interactive TUI and explicit protocol smoke. */
export function createCodexExperimentWorkflow(input: { dataDir: string; runtime: RuntimePort; agents: () => Promise<HarnessAgents>; now: () => string; defaults?: ExperimentDefaults }): CodexTuiWorkflow {
  const { candidate, policy } = input.defaults ?? { candidate: DEFAULT_CANDIDATE, policy: TUI_RUN_POLICY };
  return {
    candidate,
    policy,
    preflight: ({ taskCase, sourceRoot }) => preflightCodexExperiment({ dataDir: input.dataDir, caseId: taskCase.caseId, experimentId: previewExperimentId(taskCase.caseId), sourceRoot, taskCase, candidate, runtime: input.runtime }),
    async start(request): Promise<ExperimentHandle> {
      const agents = await input.agents();
      const experimentId = `experiment-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      return startCodexExperiment({
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, candidate, runtime: input.runtime, controller: agents.controller, comparison: agents.comparison,
        agentConfig: agents.config, policy, now: input.now(), onEvent: request.onEvent,
      });
    },
  };
}

/** Creates the production TUI bridge; it does not run anything until the TUI explicitly confirms. */
export function createCodexTuiWorkflow(input: { dataDir: string; runtime: RuntimePort; now: () => string }): CodexTuiWorkflow {
  return createCodexExperimentWorkflow({
    ...input,
    agents: async () => {
      const config = await readHarnessModelConfig(input.dataDir);
      if (!config) throw new Error('Harness Pi setup is required before an experiment can start.');
      const caller = new PiModelCaller(config);
      await caller.validate();
      return createHarnessAgents(config, caller);
    },
  });
}

function previewExperimentId(caseId: string): string { return `preview-${caseId}`; }
