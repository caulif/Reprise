import { randomUUID } from 'node:crypto';
import type { AgentBudget, CandidateSpec, EventEnvelope, RunPolicy, TaskCase } from '../core/schema.js';
import type { ResolvedRuntime, RuntimeAvailability, RuntimeModelOffer, ProductRuntime } from '../core/runtime.js';
import { readHarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { PiModelCaller } from '../infrastructure/agent/model-caller.js';
import { createHarnessAgents, type HarnessAgents } from './harness-agents.js';
import { startExperiment, type ExperimentHandle } from './experiment.js';
import { preflightExperiment, type ExperimentPreflight } from './experiment-preflight.js';
import { recoverExperiment } from './recovery/recover.js';
import type { RecoveryAttempt } from './recovery/types.js';
import { comparePersistedExperiment } from './experiment-compare-persisted.js';
import type { ExperimentResult } from './experiment.js';
import type { EnvironmentBaseline } from '../environment/local-workspace-provider.js';
import type { ProductPack } from '../products/contract.js';
import type { ProductLookup } from '../products/index.js';
import { packDefaultCandidate, packRuntime } from '../products/pack-access.js';
import type { SourceRootKind } from './replay-conditions.js';
import { assertCandidateStartAllowed, candidateGateFromAttempt } from './candidate-start.js';
import { activityControlReady, registerActivity, type ExperimentActivity } from './experiment-activity.js';

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
  /** Host-owned Recovery id; TUI passes this instead of a Provider-bearing attempt. */
  recoveryExperimentId?: string;
  experimentId?: string;
  runId?: string;
  candidate?: CandidateSpec;
  onEvent: (event: EventEnvelope) => void;
  onActivity?: (activity: ExperimentActivity) => void;
  compare?: boolean;
  deferComparison?: boolean;
};
export type RecoveryRequest = Omit<ExperimentRequest, 'onEvent' | 'expectedSourceFingerprint' | 'preResolvedBaseline' | 'recoveryAttempt' | 'recoveryExperimentId' | 'experimentId' | 'runId' | 'candidate'> & { onEvent?: (event: EventEnvelope) => void; signal?: AbortSignal };

export type ExperimentWorkflow = {
  readonly candidate?: CandidateSpec;
  readonly policy: RunPolicy;
  listCatalog(productId: string): Promise<readonly RuntimeModelOffer[]>;
  inspectAvailability(productId: string): Promise<readonly RuntimeAvailability[]>;
  verifyCandidate(candidate: CandidateSpec): Promise<ResolvedRuntime>;
  preflight(input: Omit<ExperimentRequest, 'onEvent' | 'preResolvedBaseline'> & { verifyCandidate?: boolean }): Promise<ExperimentPreflight>;
  recover(input: RecoveryRequest): Promise<RecoveryAttempt>;
  discardRecovery(experimentId: string): Promise<void>;
  acceptRecovery(experimentId: string): Promise<EnvironmentBaseline | undefined>;
  start(input: ExperimentRequest): Promise<ExperimentHandle>;
  comparePersisted(experimentId: string, onEvent?: (event: EventEnvelope) => void, signal?: AbortSignal, runId?: string, onActivity?: (activity: ExperimentActivity) => void): Promise<ExperimentResult>;
};

export function createExperimentWorkflow(input: {
  dataDir: string;
  runtime?: ProductRuntime;
  pack?: ProductPack;
  lookup?: ProductLookup;
  agents: (signal?: AbortSignal) => Promise<HarnessAgents>;
  now: () => string;
  defaults?: ExperimentDefaults;
}): ExperimentWorkflow {
  const candidate = input.defaults?.candidate;
  const policy = input.defaults?.policy ?? DEFAULT_RUN_POLICY;
  const packFor = (productId: string) => resolvePack(productId, input.pack, input.lookup);
  const resolve = (taskCase: TaskCase, chosen?: CandidateSpec) => resolveSelection(taskCase, chosen, candidate, packFor, input.runtime);
  const ownedRecoveries = createOwnedRecoveries();
  return {
    ...(candidate ? { candidate } : {}),
    policy,
    listCatalog: (productId) => packRuntime(packFor(productId)).listCatalog(),
    inspectAvailability: (productId) => packRuntime(packFor(productId)).inspectAvailability(),
    verifyCandidate: (spec) => packRuntime(packFor(spec.productId)).validateCandidate(spec),
    preflight: ({ taskCase, sourceRoot, candidate: chosen, verifyCandidate }) => {
      const selected = resolve(taskCase, chosen);
      return preflightExperiment({
        dataDir: input.dataDir, caseId: taskCase.caseId, experimentId: previewExperimentId(taskCase.caseId),
        sourceRoot, taskCase, candidate: selected.candidate, runtime: selected.runtime,
        ...(verifyCandidate === false ? { verifyCandidate: false } : {}),
      });
    },
    async recover(request): Promise<RecoveryAttempt> {
      request.signal?.throwIfAborted();
      const experimentId = `recovery-${randomUUID()}`;
      const runId = `recovery-run-${randomUUID()}`;
      const owned = await beginOwnedActivity("prepare", experimentId, runId, input.dataDir, request.signal, request.onActivity);
      const agents = await input.agents(owned.signal);
      owned.signal.throwIfAborted();
      const attempt = await recoverExperiment({
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, recovery: agents.recovery, now: input.now(), pack: packFor(request.taskCase.source.productId),
        activity: owned.activity, signal: owned.signal, ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      });
      return ownedRecoveries.retain(attempt);
    },
    discardRecovery: (experimentId) => ownedRecoveries.discard(experimentId),
    acceptRecovery: (experimentId) => ownedRecoveries.accept(experimentId),
    async start(request): Promise<ExperimentHandle> {
      request.signal?.throwIfAborted();
      const live = request.recoveryAttempt ?? ownedRecoveries.peek(request.recoveryExperimentId);
      if (live) {
        assertCandidateStartAllowed(candidateGateFromAttempt(live, Boolean(request.taskCase.initialInput?.text)));
      }
      const experimentId = live?.experimentId ?? request.experimentId ?? `experiment-${randomUUID()}`;
      const runId = request.runId ?? `run-${randomUUID()}`;
      const owned = await beginOwnedActivity(request.compare ? "compare" : "run", experimentId, runId, input.dataDir, request.signal, request.onActivity);
      const agents = await input.agents(owned.signal);
      owned.signal.throwIfAborted();
      const selected = resolve(request.taskCase, request.candidate);
      const handle = startExperiment({
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, candidate: selected.candidate, runtime: selected.runtime, pack: selected.pack,
        controller: agents.controller, comparison: agents.comparison,
        agentConfig: agents.config, policy, now: input.now(), onEvent: request.onEvent, activity: owned.activity,
        ...(request.expectedSourceFingerprint ? { expectedSourceFingerprint: request.expectedSourceFingerprint } : {}),
        ...(request.preResolvedBaseline ? { preResolvedBaseline: request.preResolvedBaseline } : {}),
        ...(live ? { environmentProvider: live.provider, requireObservations: true, ...(request.preResolvedBaseline ? {} : { preResolvedBaseline: live.baseline }) } : {}),
        ...(request.sourceRootKind ? { sourceRootKind: request.sourceRootKind } : {}),
        ...(request.compare ? { compare: true } : {}),
        ...(request.deferComparison ? { deferComparison: true } : {}),
        signal: owned.signal,
      });
      if (live) ownedRecoveries.take(live.experimentId);
      return handle;
    },
    async comparePersisted(experimentId, onEvent, signal, runId, onActivity): Promise<ExperimentResult> {
      signal?.throwIfAborted();
      return comparePersistedExperiment({
        dataDir: input.dataDir, experimentId, policy, now: input.now(),
        resolveAgents: async (combined) => {
          const agents = await input.agents(combined);
          return { comparison: agents.comparison, agentConfig: agents.config };
        },
        ...(runId ? { runId } : {}), ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}), ...(onActivity ? { onActivity } : {}),
      });
    },
  };
}

/** Production harness agents + connection probe. Used by TUI and CLI. */
export function createHarnessWorkflow(input: {
  dataDir: string;
  runtime?: ProductRuntime;
  pack?: ProductPack;
  lookup?: ProductLookup;
  now: () => string;
  defaults?: ExperimentDefaults;
  budget?: AgentBudget;
  recoveryBudget?: AgentBudget;
}): ExperimentWorkflow {
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

function resolvePack(productId: string, pack: ProductPack | undefined, lookup: ProductLookup | undefined): ProductPack {
  if (pack?.manifest.productId === productId) return pack;
  if (lookup) return lookup.find(productId);
  throw new Error(`Unknown product '${productId}'. Workflow has no injected pack lookup.`);
}

function resolveSelection(
  taskCase: TaskCase,
  chosen: CandidateSpec | undefined,
  fallback: CandidateSpec | undefined,
  packFor: (productId: string) => ProductPack,
  runtime: ProductRuntime | undefined,
) {
  const sourcePack = packFor(taskCase.source.productId);
  const spec = chosen ?? fallback;
  const candidatePack = spec ? packFor(spec.productId) : sourcePack;
  const selected = spec?.productId === candidatePack.manifest.productId ? spec : packDefaultCandidate(candidatePack);
  return { sourcePack, pack: candidatePack, candidate: selected, runtime: runtime ?? packRuntime(candidatePack) };
}

async function beginOwnedActivity(
  kind: ExperimentActivity["kind"],
  experimentId: string,
  runId: string,
  dataDir: string,
  signal: AbortSignal | undefined,
  onActivity: ((activity: ExperimentActivity) => void) | undefined,
): Promise<{ activity: ExperimentActivity; signal: AbortSignal }> {
  const localAbort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
  const activity = registerActivity({
    kind, experimentId, runId, dataDir,
    cancel: async () => { localAbort.abort(); },
  });
  onActivity?.(activity);
  await activityControlReady(activity);
  return { activity, signal: combined };
}

function createOwnedRecoveries() {
  const owned = new Map<string, RecoveryAttempt>();
  return {
    retain(attempt: RecoveryAttempt): RecoveryAttempt {
      owned.set(attempt.experimentId, attempt);
      return attempt;
    },
    peek(experimentId: string | undefined): RecoveryAttempt | undefined {
      return experimentId ? owned.get(experimentId) : undefined;
    },
    take(experimentId: string): RecoveryAttempt | undefined {
      const attempt = owned.get(experimentId);
      owned.delete(experimentId);
      return attempt;
    },
    async discard(experimentId: string): Promise<void> {
      const attempt = owned.get(experimentId);
      owned.delete(experimentId);
      if (attempt?.staging) await attempt.provider.discardRecovery(attempt.staging);
    },
    async accept(experimentId: string): Promise<EnvironmentBaseline | undefined> {
      return owned.get(experimentId)?.accept?.();
    },
  };
}
