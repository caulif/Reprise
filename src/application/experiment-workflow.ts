import { assertNotManagedImport, inspectManagedSession, discoverManagedSessions } from './managed-session-history.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentBudget, CandidateSpec, EventEnvelope, RunPolicy, TaskCase, RecoveryGitStart } from '../core/schema.js';
import type { ResolvedRuntime, RuntimeAvailability, RuntimeModelOffer, ProductRuntime } from '../core/runtime.js';
import { readHarnessModelConfig, resolveKeyRef } from '../infrastructure/harness-model-config.js';
import { PiModelCaller, HarnessProbeAuditError } from '../infrastructure/agent/model-caller.js';
import type { AgentLocale } from '../agents/language.js';
import { createHarnessAgents, type HarnessAgents } from './harness-agents.js';
import { readOperatorLocale } from './operator-locale.js';
import { startExperiment, type ExperimentHandle } from './experiment.js';
import { preflightExperiment, resolveVerifiedCandidate, type ExperimentPreflight } from './experiment-preflight.js';
import { recoverExperiment } from './recovery/recover.js';
import type { RecoveryAttempt } from './recovery/types.js';
import { comparePersistedExperiment } from './experiment-compare-persisted.js';
import type { ExperimentResult } from './experiment.js';
import type { EnvironmentBaseline } from '../environment/local-workspace-provider.js';
import type {
  ProductPack,
  SessionDiscoveryPage,
  SessionDiscoveryQuery,
  SessionInspection,
  SessionPrivacy,
  SessionSummary,
} from '../products/contract.js';
import type { ProductLookup } from '../products/index.js';
import { packDefaultCandidate, packHistory, packRuntime } from '../products/pack-access.js';
import { resolveHistoryRoot } from '../products/history/discover.js';
import { inspectProductSession, readImportedSession } from '../products/history/read.js';
import { freezeCase } from '../products/shared/freeze.js';
import type { HistoricalArtifactExtractFn } from '../products/shared/freeze.js';
import { DEFAULT_RUN_POLICY } from './default-run-policy.js';
import type { SourceRootKind } from './replay-conditions.js';
import { assertCandidateStartAllowed, candidateGateFromAttempt } from './candidate-start.js';
import { activityControlReady, finishActivity, registerActivity, type ExperimentActivity } from './experiment-activity.js';
import { ExperimentStartup, cleanupOperation, throwFailures, type CleanupFailure } from './experiment-startup.js';
import { harnessConfigurationScope, type HarnessConfigurationScope } from './harness-configuration.js';
import { frozenSnapshot } from '../core/json.js';

export { DEFAULT_RUN_POLICY, TUI_RUN_POLICY } from './default-run-policy.js';

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
export type RecoveryRequest = Omit<ExperimentRequest, 'onEvent' | 'expectedSourceFingerprint' | 'preResolvedBaseline' | 'recoveryAttempt' | 'recoveryExperimentId' | 'experimentId' | 'runId' | 'candidate'> & { onEvent?: (event: EventEnvelope) => void; signal?: AbortSignal; gitStart?: RecoveryGitStart };

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
  sourceRoot(productId: string, sessionsRoots?: Readonly<Record<string, string>>): string;
  discoverSource(productId: string, query: SessionDiscoveryQuery): Promise<SessionDiscoveryPage>;
  inspectSource(ref: { productId: string; sessionId: string; sourcePath: string }): Promise<SessionInspection>;
  freezeSource(input: {
    productId: string;
    session: Pick<SessionSummary, 'productId' | 'sessionId' | 'sourcePath' | 'availability' | 'evidenceLevel' | 'recoveryReadiness'>;
    sourcePath: string;
    privacy: SessionPrivacy;
    now: string;
    initialMessageId?: string;
  }): Promise<{ taskCase: TaskCase; reused: boolean }>;
};

export function createExperimentWorkflow(input: {
  dataDir: string;
  runtime?: ProductRuntime;
  pack?: ProductPack;
  lookup?: ProductLookup;
  agents: (signal?: AbortSignal, scope?: HarnessConfigurationScope) => Promise<HarnessAgents>;
  now: () => string;
  defaults?: ExperimentDefaults;
}): ExperimentWorkflow {
  const candidate = input.defaults?.candidate;
  const policy = input.defaults?.policy ?? DEFAULT_RUN_POLICY;
  const packFor = (productId: string) => resolvePack(productId, input.pack, input.lookup);
  const runtimeFor = (pack: ProductPack) => {
    const runtime = packRuntime(pack);
    return input.runtime ?? runtime;
  };
  const sourceExtractor = (productId: string) => historicalExtractor(packFor(productId));
  const resolve = (taskCase: TaskCase, chosen?: CandidateSpec) => resolveSelection(taskCase, chosen, candidate, packFor, runtimeFor);
  const ownedRecoveries = createOwnedRecoveries();
  return {
    ...(candidate ? { candidate } : {}),
    policy,
    listCatalog: (productId) => runtimeFor(packFor(productId)).listCatalog(),
    inspectAvailability: (productId) => runtimeFor(packFor(productId)).inspectAvailability(),
    verifyCandidate: (spec) => resolveVerifiedCandidate(runtimeFor(packFor(spec.productId)), spec),
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
      const attempt = await recoverExperiment({
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, recovery: { recover: async () => { throw new Error('Recovery model was not initialized.'); } },
        ...(!request.gitStart ? { resolveRecovery: async (signal: AbortSignal, scope: HarnessConfigurationScope) => (await input.agents(signal, scope)).recovery } : {}),
        now: input.now(), pack: packFor(request.taskCase.source.productId),
        ...(request.signal ? { signal: request.signal } : {}), ...(request.onEvent ? { onEvent: request.onEvent } : {}),
        ...(request.onActivity ? { onActivity: request.onActivity } : {}),
        ...(request.gitStart ? { gitStart: request.gitStart } : {}),
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
      const selected = resolve(request.taskCase, request.candidate);
      const extractHistoricalArtifacts = sourceExtractor(request.taskCase.source.productId);
      const handle = await beginWorkflowStart(input, request, {
        dataDir: input.dataDir, caseId: request.taskCase.caseId, experimentId, runId, sourceRoot: request.sourceRoot,
        taskCase: request.taskCase, candidate: selected.candidate, runtime: selected.runtime, pack: selected.pack,
        resolveProductName: productId => packFor(productId).manifest.displayName,
        policy, now: input.now(), onEvent: request.onEvent,
        ...(request.expectedSourceFingerprint ? { expectedSourceFingerprint: request.expectedSourceFingerprint } : {}),
        ...(request.preResolvedBaseline ? { preResolvedBaseline: request.preResolvedBaseline } : {}),
        ...(live ? { environmentProvider: live.provider, requireObservations: true, ...(request.preResolvedBaseline ? {} : { preResolvedBaseline: live.baseline }) } : {}),
        ...(request.sourceRootKind ? { sourceRootKind: request.sourceRootKind } : {}),
        ...(request.compare ? { compare: true } : {}),
        ...(request.deferComparison ? { deferComparison: true } : {}),
        ...(extractHistoricalArtifacts
          ? { extractHistoricalArtifacts }
          : {}),
      });
      if (live) ownedRecoveries.take(live.experimentId);
      return handle;
    },
    comparePersisted(experimentId, onEvent, signal, runId, onActivity): Promise<ExperimentResult> {
      signal?.throwIfAborted();
      return comparePersistedExperiment({
        dataDir: input.dataDir, experimentId, policy, now: input.now(),
        resolveAgents: async (combined, scope) => {
          const agents = await input.agents(combined, scope);
          return { comparison: agents.comparison, agentConfig: agents.config };
        },
        resolveExtractHistoricalArtifacts: sourceExtractor,
        resolveCandidatePack: packFor,
        resolveProductName: productId => packFor(productId).manifest.displayName,
        ...(runId ? { runId } : {}), ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}), ...(onActivity ? { onActivity } : {}),
      });
    },
    ...sourceHistoryPorts(input.dataDir, packFor),
  };
}

function sourceHistoryPorts(dataDir: string, packFor: (productId: string) => ProductPack) {
  return {
    sourceRoot(productId: string, sessionsRoots?: Readonly<Record<string, string>>) {
      return resolveHistoryRoot(packHistory(packFor(productId)), sessionsRoots, productId);
    },
    async discoverSource(productId: string, query: Parameters<ExperimentWorkflow["discoverSource"]>[1]) {
      const history = packHistory(packFor(productId));
      return discoverManagedSessions(dataDir, productId, history, query);
    },
    async inspectSource(ref: Parameters<ExperimentWorkflow["inspectSource"]>[0]) {
      const history = packHistory(packFor(ref.productId));
      return await inspectManagedSession(dataDir, history, ref) ?? inspectProductSession(history, ref);
    },
    async freezeSource(request: Parameters<ExperimentWorkflow["freezeSource"]>[0]) {
      const pack = packFor(request.productId);
      const history = packHistory(pack);
      await assertNotManagedImport(dataDir, { ...request.session, sourcePath: request.sourcePath });
      const imported = await readImportedSession(history, request.session, request.sourcePath);
      return freezeCase(imported, join(dataDir, 'cases'), request.privacy, request.now, {
        ...(request.initialMessageId ? { initialMessageId: request.initialMessageId } : {}),
        reuseExisting: true,
        ...(history.extractHistoricalArtifacts
          ? {
            extractHistoricalArtifacts: (extractInput) =>
              history.extractHistoricalArtifacts!(extractInput),
          }
          : {}),
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
  locale?: AgentLocale;
}): ExperimentWorkflow {
  let cached: { key: string; agents: HarnessAgents } | undefined;
  let validatedConnection: string | undefined;
  return createExperimentWorkflow({
    ...input,
    agents: async (signal, scope) => {
      if (!scope) throw new Error('Harness initialization requires operation-owned configuration auditing.');
      const limits = frozenSnapshot({ ...(input.budget ? { budget: input.budget } : {}), ...(input.recoveryBudget ? { recoveryBudget: input.recoveryBudget } : {}) });
      const config = await readHarnessModelConfig(input.dataDir);
      if (!config) throw new Error('Harness Pi setup is required before an experiment can start.');
      const locale = input.locale ?? await readOperatorLocale(input.dataDir);
      const caller = new PiModelCaller(config);
      const modelKey = caller.executionFingerprint;
      const environmentCredential = config.schemaVersion === 2 && config.keyRef ? resolveKeyRef(config.keyRef) : undefined;
      const connectionKey = JSON.stringify({ config, modelKey, environmentCredential });
      const key = JSON.stringify({ connectionKey, locale, ...limits });
      const agents = cached?.key === key ? cached.agents : createHarnessAgents(config, caller, limits, { locale });
      const binding = await scope.bind(agents.config.effective!);
      // The connection check is a real, billable request, so it is repeated only when the configuration changes.
      try {
        if (validatedConnection !== connectionKey) await caller.validate(signal, binding.probeAudit);
      } catch (error) {
        if (error instanceof AggregateError || error instanceof HarnessProbeAuditError) throw error;
        signal?.throwIfAborted();
        throw Object.assign(new Error('Harness connection probe failed.', { cause: error }), { name: 'HarnessProbeError' });
      }
      validatedConnection = connectionKey;
      cached = { key, agents };
      return { ...agents, config: frozenSnapshot({ ...agents.config, effectiveReference: binding.reference }) };
    },
  });
}

function previewExperimentId(caseId: string): string { return `preview-${caseId}`; }

function historicalExtractor(pack: ProductPack): HistoricalArtifactExtractFn | undefined {
  const history = packHistory(pack);
  return history.extractHistoricalArtifacts
    ? (extractInput) => history.extractHistoricalArtifacts!(extractInput)
    : undefined;
}

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
  runtimeFor: (pack: ProductPack) => ProductRuntime,
) {
  const sourcePack = packFor(taskCase.source.productId);
  const spec = chosen ?? fallback;
  const candidatePack = spec ? packFor(spec.productId) : sourcePack;
  const selected = spec?.productId === candidatePack.manifest.productId ? spec : packDefaultCandidate(candidatePack);
  return { sourcePack, pack: candidatePack, candidate: selected, runtime: runtimeFor(candidatePack) };
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
    cancel: async () => { localAbort.abort({ source: 'user' }); },
  });
  try {
    onActivity?.(activity);
    await activityControlReady(activity);
  } catch (error) {
    const cleanup: CleanupFailure[] = [];
    await cleanupOperation(cleanup, 'activity', () => finishActivity(activity));
    throwFailures([error, ...cleanup.map(item => item.error)], 'Activity preparation and cleanup failed.');
  }
  return { activity, signal: combined };
}

async function beginWorkflowStart(
  workflow: Pick<Parameters<typeof createExperimentWorkflow>[0], 'agents'>,
  request: ExperimentRequest,
  input: Omit<Parameters<typeof startExperiment>[0], 'controller' | 'comparison' | 'agentConfig'>,
): Promise<ExperimentHandle> {
  const startup = await ExperimentStartup.admit(input);
  let owned: Awaited<ReturnType<typeof beginOwnedActivity>> | undefined;
  try {
    owned = await beginOwnedActivity(request.compare ? 'compare' : 'run', input.experimentId, input.runId, input.dataDir, request.signal, request.onActivity);
    startup.stage = 'agents';
    const agents = await workflow.agents(owned.signal, harnessConfigurationScope(startup.store,
      { experimentId: input.experimentId, runId: input.runId, operation: 'run' }));
    owned.signal.throwIfAborted();
    return startExperiment({ ...input, taskCase: startup.taskCase, candidate: startup.attempt.candidate, policy: startup.attempt.policy,
      controller: agents.controller, comparison: agents.comparison, agentConfig: agents.config,
      activity: owned.activity, signal: owned.signal, startup });
  } catch (error) {
    const cleanup: CleanupFailure[] = [];
    if (owned) await cleanupOperation(cleanup, 'activity', () => finishActivity(owned!.activity));
    const signal = owned?.signal ?? request.signal;
    const reason: unknown = signal?.reason;
    const source = reason && typeof reason === 'object' && 'source' in reason && reason.source === 'user' ? 'user'
      : reason instanceof Error && reason.name === 'TimeoutError' ? 'budget' : 'supervisor';
    await cleanupOperation(cleanup, 'startup_audit', () => startup.fail(error, signal?.aborted ?? false, cleanup, source));
    await startup.close(cleanup);
    throwFailures([error, ...cleanup.map(item => item.error)], 'Workflow startup and cleanup failed.');
  }
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

