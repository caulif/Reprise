import { randomUUID } from 'node:crypto';
import type { AgentBudget, CandidateSpec, EventEnvelope, RunPolicy, TaskCase } from '../core/schema.js';
import type { ResolvedRuntime, RuntimeModelOffer, RuntimePort } from '../core/runtime.js';
import { readHarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/pi-model-caller.js';
import { createHarnessAgents, type HarnessAgents } from './harness-agents.js';
import { preflightCodexExperiment, recoverCodexExperiment, startCodexExperiment, type CodexExperimentPreflight, type ExperimentHandle, type RecoveryAttempt } from './experiment.js';
import { comparePersistedExperiment } from './experiment-compare-persisted.js';
import type { CodexExperimentResult } from './experiment.js';
import type { EnvironmentBaseline } from '../environment/local-workspace-provider.js';
import type { ProductPack } from '../products/contract.js';
import { findProductPack } from "../products/index.js";
import { packDefaultCandidate, packRuntime } from "../products/pack-access.js";
import type { SourceRootKind } from './replay-conditions.js';
import { assertCandidateStartAllowed, candidateGateFromAttempt } from './candidate-start.js';

/** Last-resort safety valve. Completion is a Controller decision, not these numbers. */
export const DEFAULT_RUN_POLICY: RunPolicy = {
  wallClockMs: 24 * 60 * 60_000,
  maxTargetTurns: 256,
  maxModelCalls: 256,
  turnTimeoutMs: 2 * 60 * 60_000,
  maxConsecutiveNoProgress: 2,
};

export const TUI_RUN_POLICY = DEFAULT_RUN_POLICY;

type ExperimentDefaults = { readonly candidate?: CandidateSpec; readonly policy: RunPolicy };
export type ExperimentRequest = {
  signal?: AbortSignal;
  taskCase: TaskCase;
  sourceRoot: string;
  sourceRootKind?: SourceRootKind;
  expectedSourceFingerprint?: string;
  preResolvedBaseline?: EnvironmentBaseline;
  recoveryAttempt?: RecoveryAttempt;
  experimentId?: string;
  runId?: string;
  candidate?: CandidateSpec;
  onEvent: (event: EventEnvelope) => void;
  compare?: boolean;
  deferComparison?: boolean;
};
export type RecoveryRequest = Omit<ExperimentRequest, 'onEvent' | 'expectedSourceFingerprint' | 'preResolvedBaseline' | 'recoveryAttempt' | 'experimentId' | 'runId' | 'candidate'> & { onEvent?: (event: EventEnvelope) => void; signal?: AbortSignal };

export type ExperimentWorkflow = {
  readonly candidate?: CandidateSpec;
  readonly policy: RunPolicy;
  listCatalog(productId: string): Promise<readonly RuntimeModelOffer[]>;
  verifyCandidate(candidate: CandidateSpec): Promise<ResolvedRuntime>;
  preflight(input: Omit<ExperimentRequest, 'onEvent' | 'preResolvedBaseline'> & { verifyCandidate?: boolean }): Promise<CodexExperimentPreflight>;
  recover(input: RecoveryRequest): Promise<RecoveryAttempt>;
  start(input: ExperimentRequest): Promise<ExperimentHandle>;
  comparePersisted(experimentId: string, onEvent?: (event: EventEnvelope) => void, signal?: AbortSignal, runId?: string): Promise<CodexExperimentResult>;
};

export function createExperimentWorkflow(input: { dataDir: string; runtime?: RuntimePort; pack?: ProductPack; agents: (signal?: AbortSignal) => Promise<HarnessAgents>; now: () => string; defaults?: ExperimentDefaults }): ExperimentWorkflow {
  const candidate = input.defaults?.candidate;
  const policy = input.defaults?.policy ?? DEFAULT_RUN_POLICY;
  const packFor = (productId: string): ProductPack => {
    if (input.pack?.manifest.productId === productId) return input.pack;
    return findProductPack(productId);
  };
  const resolve = (taskCase: TaskCase, chosen?: CandidateSpec) => {
    const sourcePack = packFor(taskCase.source.productId);
    const spec = chosen ?? candidate;
    const candidatePack = spec ? packFor(spec.productId) : sourcePack;
    const selected = spec?.productId === candidatePack.manifest.productId ? spec : packDefaultCandidate(candidatePack);
    return { sourcePack, pack: candidatePack, candidate: selected, runtime: input.runtime ?? packRuntime(candidatePack) };
  };
  return {
    ...(candidate ? { candidate } : {}),
    policy,
    listCatalog: (productId) => packRuntime(packFor(productId)).listCatalog(),
    verifyCandidate: (spec) => packRuntime(packFor(spec.productId)).validateCandidate(spec),
    preflight: ({ taskCase, sourceRoot, candidate: chosen, verifyCandidate }) => {
      const selected = resolve(taskCase, chosen);
      return preflightCodexExperiment({
        dataDir: input.dataDir, caseId: taskCase.caseId, experimentId: previewExperimentId(taskCase.caseId),
        sourceRoot, taskCase, candidate: selected.candidate, runtime: selected.runtime,
        ...(verifyCandidate === false ? { verifyCandidate: false } : {}),
      });
    },
    async recover(request): Promise<RecoveryAttempt> {
      request.signal?.throwIfAborted();
      const agents = await input.agents(request.signal);
      request.signal?.throwIfAborted();
      const experimentId = `recovery-${randomUUID()}`;
      const runId = `recovery-run-${randomUUID()}`;
      return recoverCodexExperiment({ dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot, taskCase: request.taskCase, recovery: agents.recovery, now: input.now(), ...(request.signal ? { signal: request.signal } : {}), ...(request.onEvent ? { onEvent: request.onEvent } : {}) });
    },
    async start(request): Promise<ExperimentHandle> {
      request.signal?.throwIfAborted();
      if (request.recoveryAttempt) {
        assertCandidateStartAllowed(candidateGateFromAttempt(request.recoveryAttempt, Boolean(request.taskCase.initialInput?.text)));
      }
      const agents = await input.agents(request.signal);
      request.signal?.throwIfAborted();
      const selected = resolve(request.taskCase, request.candidate);
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
        ...(request.compare ? { compare: true } : {}),
        ...(request.deferComparison ? { deferComparison: true } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    },
    async comparePersisted(experimentId, onEvent, signal, runId): Promise<CodexExperimentResult> {
      signal?.throwIfAborted();
      const agents = await input.agents(signal);
      signal?.throwIfAborted();
      return comparePersistedExperiment({
        dataDir: input.dataDir,
        experimentId,
        comparison: agents.comparison,
        agentConfig: agents.config,
        policy,
        now: input.now(),
        ...(runId ? { runId } : {}),
        ...(signal ? { signal } : {}),
        ...(onEvent ? { onEvent } : {}),
      });
    },
  };
}

/** Production harness agents + connection probe. Used by TUI and CLI. */
export function createHarnessWorkflow(input: { dataDir: string; runtime?: RuntimePort; pack?: ProductPack; now: () => string; defaults?: ExperimentDefaults; budget?: AgentBudget; recoveryBudget?: AgentBudget }): ExperimentWorkflow {
  let validated: { key: string; agents: HarnessAgents } | undefined;
  return createExperimentWorkflow({
    ...input,
    agents: async (signal) => {
      const config = await readHarnessModelConfig(input.dataDir);
      if (!config) throw new Error('Harness Pi setup is required before an experiment can start.');
      const key = JSON.stringify(config);
      if (validated?.key === key) return validated.agents;
      const caller = new PiModelCaller(config);
      // The connection check is a real, billable request, so it is repeated only when the configuration changes.
      try {
        await caller.validate(signal);
      } catch (error) {
        signal?.throwIfAborted();
        throw Object.assign(new Error('Harness connection probe failed.', { cause: error }), { name: 'HarnessProbeError' });
      }
      validated = { key, agents: createHarnessAgents(config, caller, input) };
      return validated.agents;
    },
  });
}

function previewExperimentId(caseId: string): string { return `preview-${caseId}`; }
