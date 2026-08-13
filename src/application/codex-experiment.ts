import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ComparisonAgentPort, ComparisonResult } from '../agents/comparison-agent.js';
import type { ControllerDecision, ControllerPort } from '../agents/controller-agent.js';
import { comparePersistedFacts, type RunInspection } from './comparison.js';
import { CandidateRun } from './candidate-run.js';
import type { CandidateSpec, EventEnvelope, RunManifest, RunPolicy, RunRecord, TaskCase } from '../core/schema.js';
import { SAFE_ID } from '../core/identity.js';
import type { ResolvedRuntime, RuntimePort, TargetEvent, TargetEventSink } from '../core/runtime.js';
import { LocalWorkspaceProvider, type EnvironmentBaseline, type PreparedEnvironmentRef } from '../environment/local-workspace-provider.js';
import { comparisonReportTool, evidenceTools, observationTools } from '../infrastructure/agent-tools.js';
import type { StructuredAgentResult } from '../infrastructure/pi-agent-host.js';
import { ExperimentStore, writeImmutableJson } from '../infrastructure/store/experiment-store.js';
import { buildComparisonProjection, renderComparisonReport } from '../report/comparison-report.js';

export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: { callTimeoutMs: number; maxStructuredRepairAttempts: number };
};

export type CodexExperimentPreflight = {
  sourceBaseline: 'available' | 'partial' | 'unavailable';
  resolved: ResolvedRuntime;
  limitations: readonly string[];
  comparisonClass?: 'observational';
};

export type CodexExperimentResult = {
  taskCase: TaskCase;
  experimentRoot: string;
  reportPath: string;
  preflight: CodexExperimentPreflight;
  record: RunRecord;
  decision: StructuredAgentResult<ControllerDecision>;
  comparison: { result: StructuredAgentResult<ComparisonResult> };
  followupSubmission: boolean;
  targetEvents: readonly string[];
};

export type CodexExperimentInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  taskCase: TaskCase | ((baseline: EnvironmentBaseline) => TaskCase);
  candidate: CandidateSpec;
  policy: RunPolicy;
  agentConfig: ExperimentAgentConfig;
  /** Comparison may use a different persisted Harness model. */
  comparisonAgentConfig?: ExperimentAgentConfig;
  runtime: RuntimePort;
  environmentProvider?: LocalWorkspaceProvider;
  controller: ControllerPort;
  comparison: ComparisonAgentPort;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  captureArtifacts?: (input: { store: ExperimentStore; environment: PreparedEnvironmentRef; workspaceProvider: LocalWorkspaceProvider; sourceRoot: string; experimentId: string; runId: string }) => Promise<readonly RunRecord['artifactRefs'][number][] | readonly []>;
};

export type ExperimentHandle = { result: Promise<CodexExperimentResult>; cancel(): Promise<void> };

type ActiveRun = { cancel(): Promise<unknown> };

/**
 * The publishing-level Codex experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startCodexExperiment(input: CodexExperimentInput): ExperimentHandle {
  let active: ActiveRun | undefined;
  let activeController: ControllerPort | undefined;
  let activeRunId: string | undefined;
  let cancelRequested = false;
  const result = executeExperiment(input, {
    setActive(run) { active = run; },
    setController(controller, runId) { activeController = controller; activeRunId = runId; },
    cancelled() { return cancelRequested; },
  });
  return {
    result,
    async cancel(): Promise<void> {
      cancelRequested = true;
      if (activeController && activeRunId) await activeController.cancel?.(activeRunId, `run:${activeRunId}:cancelled`);
      if (active) await active.cancel();
    },
  };
}

/** Read-only admission check. It never creates a Candidate workspace or calls a target model. */
export async function preflightCodexExperiment(input: Pick<CodexExperimentInput, 'candidate' | 'runtime' | 'sourceRoot' | 'dataDir' | 'experimentId' | 'caseId'> & { taskCase: TaskCase }): Promise<CodexExperimentPreflight> {
  assertPaths(input.dataDir, input.sourceRoot);
  if (input.candidate.productId !== 'codex') throw new Error('The Codex experiment workflow only accepts Codex candidates.');
  if (input.caseId !== input.taskCase.caseId) throw new Error('Experiment caseId must match TaskCase.caseId.');
  const resolved = await resolveVerifiedCandidate(input.runtime, input.candidate);
  const provider = new LocalWorkspaceProvider(join(resolve(input.dataDir), 'experiments', input.experimentId, 'environment'));
  const baseline = await provider.inspectBaseline({ caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) }, [], {});
  return preflightFromBaseline(baseline, resolved);
}

async function executeExperiment(input: CodexExperimentInput, control: { setActive(run: ActiveRun): void; setController(controller: ControllerPort, runId: string): void; cancelled(): boolean }): Promise<CodexExperimentResult> {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
  if (input.candidate.productId !== 'codex') throw new Error('The Codex experiment workflow only accepts Codex candidates.');
  if (typeof input.taskCase !== 'function' && input.caseId !== input.taskCase.caseId) throw new Error('Experiment caseId must match TaskCase.caseId.');
  const experimentRoot = join(resolve(input.dataDir), 'experiments', input.experimentId);
  const provider = input.environmentProvider ?? new LocalWorkspaceProvider(join(experimentRoot, 'environment'));
  const resolved = await resolveVerifiedCandidate(input.runtime, input.candidate);
  let baseline = await provider.resolveBaseline({ caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) }, [], {});
  const taskCase = typeof input.taskCase === 'function' ? input.taskCase(baseline) : input.taskCase;
  if (taskCase.caseId !== input.caseId) throw new Error('Recovered TaskCase.caseId must match the experiment caseId.');
  await mkdir(experimentRoot, { recursive: true });
  const preflight = preflightFromBaseline(baseline, resolved);
  await ensureTaskCase(join(resolve(input.dataDir), 'cases', input.caseId, 'case.json'), taskCase);
  await writeImmutableJson(join(experimentRoot, 'preflight.json'), preflight);
  if (preflight.sourceBaseline === 'unavailable') throw new Error('Candidate was not started because the source baseline is unavailable.');
  if (control.cancelled()) throw new Error('Experiment was cancelled before Candidate startup.');

  const comparisonAgentConfig = input.comparisonAgentConfig ?? input.agentConfig;
  const spec = { experimentId: input.experimentId, taskCaseId: input.caseId, candidates: [input.candidate], controller: input.agentConfig, comparison: comparisonAgentConfig, runPolicy: input.policy, outputRoot: experimentRoot };
  await writeImmutableJson(join(experimentRoot, 'experiment.json'), { spec, runIds: [input.runId] });
  const environment = await provider.prepareRun(baseline, input.runId);
  const attempt = { schemaVersion: 1 as const, runId: input.runId, experimentId: input.experimentId, caseId: input.caseId, candidate: input.candidate, policy: input.policy, createdAt: input.now };
  const manifest: RunManifest = {
    schemaVersion: 1,
    attempt,
    resolvedModel: { requested: resolved.requestedModel, resolved: resolved.resolvedModel },
    runtime: { productId: resolved.productId, executable: resolved.executable, ...(resolved.version ? { version: resolved.version } : {}) },
    environment: { environmentId: environment.environmentId, workspacePath: environment.root },
    controller: input.agentConfig,
    comparison: comparisonAgentConfig,
    startedAt: input.now,
  };
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent ? store.subscribe(input.onEvent) : undefined;
  let released = false;
  const release = async () => { released = true; return provider.release(environment); };
  const targetEvents: string[] = [];
  let run: CandidateRun | undefined;
  try {
    await store.acquireWriter();
    const sink: TargetEventSink = { append: async (targetEvent: TargetEvent): Promise<void> => {
      const event = await store.append({ type: targetEvent.type, runId: input.runId, payload: targetEvent.payload, occurredAt: targetEvent.occurredAt });
      targetEvents.push(`event:${event.eventId}`);
    } };
    const runner = await input.runtime.createRunner(resolved, environment, sink);
    run = new CandidateRun({
      runner,
      policy: { turnTimeoutMs: input.policy.turnTimeoutMs, maxTargetTurns: input.policy.maxTargetTurns },
      release,
      persistence: {
        journal: store, attempt, manifest,
        captureArtifacts: () => input.captureArtifacts
          ? input.captureArtifacts({ store, environment, workspaceProvider: provider, sourceRoot: resolve(input.sourceRoot), experimentId: input.experimentId, runId: input.runId })
          : captureWorkspaceScope({ store, environment, workspaceProvider: provider, experimentId: input.experimentId, runId: input.runId }),
      },
    });
    control.setActive(run);
    control.setController(input.controller, input.runId);
    if (control.cancelled()) await run.cancel();
    else {
      const controller = await runControllerLoop({ run, controller: input.controller, store, runId: input.runId, taskCase, policy: input.policy, controllerModel: input.agentConfig.requestedModel, environment, workspaceProvider: provider });
      return await finishExperiment({ input, taskCase, preflight, store, run, controller, experimentRoot, targetEvents });
    }
    const cancelled = { decision: { status: 'cancelled' as const, factRef: `run:${input.runId}:cancelled` }, followupSubmission: false };
    return await finishExperiment({ input, taskCase, preflight, store, run, controller: cancelled, experimentRoot, targetEvents });
  } catch (error) {
    if (run?.states().at(-1) === 'awaiting_controller') await run.cancel();
    throw error;
  } finally {
    unsubscribe?.();
    if (!released) await release();
    await store.close();
  }
}

async function finishExperiment(input: {
  input: CodexExperimentInput;
  taskCase: TaskCase;
  preflight: CodexExperimentPreflight;
  store: ExperimentStore;
  run: CandidateRun;
  controller: { decision: StructuredAgentResult<ControllerDecision>; followupSubmission: boolean };
  experimentRoot: string;
  targetEvents: readonly string[];
}): Promise<CodexExperimentResult> {
  const finishedRecord = input.run.result().record;
  if (!finishedRecord) throw new Error('Candidate run did not produce a RunRecord.');
  const traceArtifact = await input.store.commitArtifact({
    artifactId: 'host-trace.json', runId: input.input.runId, kind: 'host_run_trace', mediaType: 'application/json',
    bytes: Buffer.from(JSON.stringify(input.store.events(input.input.runId), null, 2), 'utf8'),
  });
  const traceRef = { artifactId: traceArtifact.artifactId, experimentId: input.input.experimentId, runId: input.input.runId };
  const record = { ...finishedRecord, artifactRefs: [...finishedRecord.artifactRefs, traceRef] };
  await writeImmutableJson(join(input.experimentRoot, 'runs', input.input.runId, 'record.json'), record);
  await input.store.append({ type: 'comparison.started', runId: input.input.runId, operationId: 'comparison-started', payload: { model: (input.input.comparisonAgentConfig ?? input.input.agentConfig).requestedModel } });
  const inspection = await inspectRun(input.store, record, input.taskCase.privacy.allowModelText);
  const comparison = await comparePersistedFacts({ taskCase: input.taskCase, runs: [record], inspections: [inspection], agent: input.input.comparison, tools: [...evidenceTools(input.store, record.artifactRefs), ...observationTools(input.store, { runId: input.input.runId, transcript: input.taskCase.transcript }), comparisonReportTool(input.experimentRoot)] });
  let comparisonResult = comparison.result;
  if (comparisonResult.status === 'completed' && !(await reportExists(input.experimentRoot, comparisonResult.value.reportPath))) {
    comparisonResult = { status: 'failed', sessionId: comparisonResult.sessionId, failure: { code: 'agent_failure', message: 'Comparison agent completed without writing comparison.md.', attempts: 1 } };
  }
  await input.store.append({ type: 'comparison.completed', runId: input.input.runId, operationId: 'comparison-completed', payload: invocationFact(comparisonResult) });
  await writeImmutableJson(join(input.experimentRoot, 'comparison.json'), comparisonResult);
  const completedComparison = comparisonResult.status === 'completed' ? comparisonResult.value : undefined;
  const reportPath = join(input.experimentRoot, 'report.html');
  const artifacts = (await input.store.listArtifacts(input.input.runId)).map((manifest) => ({ ref: { artifactId: manifest.artifactId, experimentId: input.input.experimentId, runId: input.input.runId }, kind: manifest.kind, ...(manifest.mediaType ? { mediaType: manifest.mediaType } : {}), byteLength: manifest.byteLength }));
  const comparisonNarrative = completedComparison && input.taskCase.privacy.allowModelText ? await readComparisonNarrative(input.experimentRoot, completedComparison.reportPath) : undefined;
  await writeFile(reportPath, renderComparisonReport(buildComparisonProjection({ taskCase: input.taskCase, runs: [record], inspections: [inspection], artifacts, ...(completedComparison ? { comparison: completedComparison } : {}), ...(comparisonNarrative ? { comparisonNarrative } : {}) })), 'utf8');
  await input.store.append({ type: 'report.created', runId: input.input.runId, operationId: 'report-created', payload: { path: reportPath } });
  return { taskCase: input.taskCase, experimentRoot: input.experimentRoot, reportPath, preflight: input.preflight, record, decision: input.controller.decision, comparison: { result: comparisonResult }, followupSubmission: input.controller.followupSubmission, targetEvents: input.targetEvents };
}

async function runControllerLoop(input: {
  run: CandidateRun;
  controller: ControllerPort;
  store: ExperimentStore;
  runId: string;
  taskCase: TaskCase;
  policy: RunPolicy;
  controllerModel: string;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
}): Promise<{ decision: StructuredAgentResult<ControllerDecision>; followupSubmission: boolean }> {
  let state = await input.run.start({ id: input.taskCase.initialInput.id, text: input.taskCase.initialInput.text }, { runId: input.runId, turnIndex: 0, clientMessageId: `initial-${input.runId}` });
  const decisions: StructuredAgentResult<ControllerDecision>[] = [];
  let controllerCalls = 0;
  let duplicateInputs = 0;
  let followupSubmission = false;
  const startedAt = Date.now();
  await input.store.append({ type: 'controller.started', runId: input.runId, operationId: 'controller-started', payload: { model: input.controllerModel } });
  while (state === 'awaiting_controller') {
    if (Date.now() - startedAt >= input.policy.wallClockMs) { state = await input.run.stopByHarness('limit.wall_clock'); break; }
    if (controllerCalls >= input.policy.maxModelCalls) { state = await input.run.stopByHarness('limit.controller_calls'); break; }
    const observation = await inspectRun(input.store, undefined, input.taskCase.privacy.allowModelText, {
      runId: input.runId, environment: input.environment, workspaceProvider: input.workspaceProvider,
    });
    const decision = await input.controller.decide({
      runId: input.runId,
      runState: state,
      task: { initialInput: input.taskCase.initialInput, baseline: input.taskCase.baseline, privacy: input.taskCase.privacy },
      current: { summary: observation.currentSummary, evidenceRefs: observation.evidenceRefs },
      trajectory: { summary: observation.trajectorySummary, evidenceRefs: observation.evidenceRefs },
      budget: { decisionsUsed: controllerCalls, decisionsLimit: input.policy.maxModelCalls },
    }, observationTools(input.store, { runId: input.runId, transcript: input.taskCase.transcript }));
    controllerCalls += 1;
    decisions.push(decision);
    await input.store.append({ type: 'controller.decision', runId: input.runId, operationId: `controller-decision-${controllerCalls}`, payload: invocationFact(decision) });
    if (decision.status !== 'completed') { state = decision.status === 'failed' ? await input.run.failController({ code: decision.failure.code, message: decision.failure.message }) : await input.run.stopByHarness('stalled.no_progress'); break; }
    if (decision.value.type === 'done') { state = await input.run.settleController(decision.value.reason); break; }
    const previous = decisions.at(-2);
    duplicateInputs = isCompleted(previous) && previous.value.type === 'send' && previous.value.message === decision.value.message ? duplicateInputs + 1 : 0;
    if (duplicateInputs >= input.policy.maxConsecutiveNoProgress) { state = await input.run.stopByHarness('stalled.no_progress'); break; }
    followupSubmission = true;
    state = await input.run.submit({ id: `controller-${input.runId}-${controllerCalls}`, text: decision.value.message }, { runId: input.runId, turnIndex: controllerCalls, clientMessageId: `controller-${controllerCalls}-${input.runId}` });
  }
  if (state !== 'finished') throw new Error(`Candidate did not reach a terminal state: ${state}.`);
  const last = decisions.at(-1);
  if (!last) return { decision: { status: 'failed', failure: { code: 'agent_failure', message: 'Controller produced no decision.', attempts: controllerCalls } }, followupSubmission };
  return { decision: last, followupSubmission };
}

type ControllerObservation = RunInspection & { evidenceRefs: string[]; currentSummary: string; trajectorySummary: string };
type WorkspaceInspection = { runId: string; environment: PreparedEnvironmentRef; workspaceProvider: LocalWorkspaceProvider };

/** Deterministically condenses persisted Target facts; no model inference is involved. */
async function inspectRun(store: ExperimentStore, record: RunRecord | undefined, allowModelText: boolean, workspace?: WorkspaceInspection): Promise<ControllerObservation> {
  const runId = record?.attempt.runId ?? workspace?.runId;
  if (!runId) throw new Error('Run inspection requires a RunRecord or active workspace.');
  const events = store.events(runId);
  const targetItems = events.filter((event) => event.type === 'codex.item_completed').map((event) => recordValue(event.payload).item).filter(isRecord);
  const finalMessage = targetItems.filter((item) => item.type === 'agentMessage').map((item) => typeof item.text === 'string' ? item.text : undefined).filter((value): value is string => Boolean(value)).at(-1);
  const commands = [...new Set(targetItems.filter((item) => item.type === 'commandExecution').map((item) => typeof item.command === 'string' ? item.command : undefined).filter((value): value is string => Boolean(value)))];
  const settled = events.filter((event) => event.type === 'runtime.turn_settled');
  const rejectedApprovals = events.filter((event) => event.type === 'codex.server_request_rejected').length;
  const workspaceFacts = record ? await readWorkspaceScope(store, record) : await inspectWorkspace(workspace);
  const wallClockMs = elapsedWallClock(events, settled);
  const tokenCount = totalTokenCount(events);
  const inspection: RunInspection = {
    runId, ...(allowModelText && finalMessage ? { finalMessage } : {}), commands, rejectedApprovals,
    turns: settled.length, ...(wallClockMs === undefined ? {} : { wallClockMs }),
    ...(tokenCount === undefined ? {} : { tokenCount }), ...workspaceFacts,
  };
  const evidenceRefs = events.filter((event) => event.type === 'runtime.turn_settled' || event.type === 'codex.item_completed' || event.type === 'codex.server_request_rejected').map((event) => `event:${event.eventId}`);
  const latestSettlement = settled.at(-1);
  const status = latestSettlement && typeof recordValue(latestSettlement.payload).status === 'string' ? recordValue(latestSettlement.payload).status : 'unknown';
  const currentSummary = [
    `Latest target settlement: ${status}.`,
    allowModelText && finalMessage ? `Visible final response: ${finalMessage}` : 'No model text is available to the Controller.',
    `Observed commands: ${commands.length}; changed paths: ${inspection.changedPaths.length}; rejected approvals: ${rejectedApprovals}.`,
  ].join(' ');
  const trajectorySummary = `Settled turns: ${inspection.turns}; commands: ${commands.length}; changed paths: ${inspection.changedPaths.length}; runtime-generated paths: ${inspection.runtimeGeneratedPaths.length}.`;
  return { ...inspection, evidenceRefs, currentSummary, trajectorySummary };
}

async function inspectWorkspace(workspace: WorkspaceInspection | undefined): Promise<Pick<RunInspection, 'changedPaths' | 'runtimeGeneratedPaths'>> {
  if (!workspace) return { changedPaths: [], runtimeGeneratedPaths: [] };
  const after = await workspace.workspaceProvider.fingerprint(workspace.environment);
  const paths = changedPathsBetween(workspace.environment.beforeFingerprint, after);
  return { changedPaths: paths.filter((path) => !path.startsWith('node_modules/')), runtimeGeneratedPaths: paths.filter((path) => path.startsWith('node_modules/')) };
}

async function readWorkspaceScope(store: ExperimentStore, record: RunRecord): Promise<Pick<RunInspection, 'changedPaths' | 'runtimeGeneratedPaths'>> {
  const ref = record.artifactRefs.find((item) => item.artifactId === 'candidate-workspace-scope.json');
  if (!ref) return { changedPaths: [], runtimeGeneratedPaths: [] };
  try {
    const scope = recordValue(JSON.parse(Buffer.from(await store.readArtifact(ref)).toString('utf8')));
    return { changedPaths: strings(scope.changedPaths), runtimeGeneratedPaths: strings(scope.runtimeGeneratedPaths) };
  } catch { return { changedPaths: [], runtimeGeneratedPaths: [] }; }
}

function elapsedWallClock(events: readonly EventEnvelope[], settled: readonly EventEnvelope[]): number | undefined {
  const start = events.find((event) => event.type === 'input.submitted' || event.type === 'run.state_changed');
  const end = settled.at(-1);
  if (!start || !end) return undefined;
  const startedAt = Date.parse(start.occurredAt);
  const endedAt = Date.parse(end.occurredAt);
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt ? endedAt - startedAt : undefined;
}

function totalTokenCount(events: readonly EventEnvelope[]): number | undefined {
  const values = events.filter((event) => event.type.includes('token_count')).map((event) => tokenValue(event.payload)).filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}
function tokenValue(value: unknown): number | undefined {
  const payload = recordValue(value);
  for (const key of ['totalTokens', 'total_tokens', 'tokenCount', 'token_count']) if (Number.isSafeInteger(payload[key]) && (payload[key] as number) >= 0) return payload[key] as number;
  return undefined;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function recordValue(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

/** Captures bounded, immutable evidence before CandidateRun releases its workspace. */
async function captureWorkspaceScope(input: {
  store: ExperimentStore;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
  experimentId: string;
  runId: string;
}): Promise<RunRecord['artifactRefs']> {
  const after = await input.workspaceProvider.fingerprint(input.environment);
  const allChangedPaths = changedPathsBetween(input.environment.beforeFingerprint, after);
  const runtimeGeneratedPaths = allChangedPaths.filter((path) => path.startsWith('node_modules/'));
  const changedPaths = allChangedPaths.filter((path) => !path.startsWith('node_modules/'));
  const before = fingerprintEntries(input.environment.beforeFingerprint);
  const current = fingerprintEntries(after);
  const snapshots = await Promise.all(changedPaths.slice(0, 16).map((path) => textSnapshot(input.environment.root, path)));
  const artifactId = 'candidate-workspace-scope.json';
  await input.store.commitArtifact({
    artifactId,
    runId: input.runId,
    kind: 'candidate_workspace_scope',
    mediaType: 'application/json',
    bytes: Buffer.from(JSON.stringify({
      baselineFingerprint: input.environment.beforeFingerprint.digest,
      candidateFingerprint: after.digest,
      changedPaths,
      runtimeGeneratedPaths,
      changes: changedPaths.map((path) => ({ path, before: before.get(path), after: current.get(path) })),
      textSnapshots: snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined),
    }, null, 2), 'utf8'),
  });
  return [{ artifactId, experimentId: input.experimentId, runId: input.runId }];
}

function fingerprintEntries(fingerprint: PreparedEnvironmentRef['beforeFingerprint']): Map<string, unknown> {
  return new Map(fingerprint.resources.map((entry) => [entry.path.replaceAll('\\', '/'), entry]));
}

async function textSnapshot(root: string, path: string): Promise<{ path: string; content: string; truncated: boolean } | undefined> {
  const fullPath = resolve(root, path);
  if (!fullPath.startsWith(`${resolve(root)}${'\\'}`) && !fullPath.startsWith(`${resolve(root)}/`)) return undefined;
  try {
    if (!(await lstat(fullPath)).isFile()) return undefined;
    const bytes = await readFile(fullPath);
    if (bytes.includes(0)) return undefined;
    const slice = bytes.subarray(0, 32_768);
    return { path: path.replaceAll('\\', '/'), content: slice.toString('utf8'), truncated: bytes.byteLength > slice.byteLength };
  } catch { return undefined; }
}

function changedPathsBetween(before: PreparedEnvironmentRef['beforeFingerprint'], after: PreparedEnvironmentRef['beforeFingerprint']): string[] {
  const entries = (fingerprint: PreparedEnvironmentRef['beforeFingerprint']) => new Map(fingerprint.resources
    .filter((entry) => entry.kind === 'file')
    .map((entry) => [entry.path.replaceAll('\\', '/'), JSON.stringify(entry)]));
  const initial = entries(before);
  const current = entries(after);
  return [...new Set([...initial.keys(), ...current.keys()])].filter((path) => initial.get(path) !== current.get(path)).sort();
}

function isCompleted<T>(result: StructuredAgentResult<T> | undefined): result is Extract<StructuredAgentResult<T>, { status: 'completed' }> {
  return result?.status === 'completed';
}
function invocationFact<T>(result: StructuredAgentResult<T>): Record<string, unknown> {
  if (result.status === 'completed') return { status: result.status, sessionId: result.sessionId, value: result.value };
  return { status: result.status, ...(result.sessionId ? { sessionId: result.sessionId } : {}), ...(result.status === 'failed' ? { failure: result.failure } : {}), ...(result.status === 'cancelled' && result.factRef ? { factRef: result.factRef } : {}) };
}

async function resolveVerifiedCandidate(runtime: RuntimePort, candidate: CandidateSpec): Promise<ResolvedRuntime> {
  const resolved = await runtime.validateCandidate(candidate);
  if (resolved.resolvedModel === 'unknown') throw new Error('Candidate model is not verified by the target runtime.');
  return resolved;
}

function preflightFromBaseline(baseline: EnvironmentBaseline, resolved: ResolvedRuntime): CodexExperimentPreflight {
  if (baseline.readiness.runnable === 'unsupported') return {
    sourceBaseline: 'unavailable', resolved, comparisonClass: 'observational',
    limitations: baseline.warnings,
  };
  const limitation = "Replay starts from the selected directory's current state, not the historical start; historical results may already be present.";
  return {
    sourceBaseline: 'available', resolved, comparisonClass: 'observational',
    limitations: [limitation, ...baseline.warnings],
  };
}

async function ensureTaskCase(path: string, taskCase: TaskCase): Promise<void> {
  try {
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Partial<TaskCase>;
    if (persisted.caseId !== taskCase.caseId || persisted.contentHash !== taskCase.contentHash) throw new Error(`TaskCase ${taskCase.caseId} conflicts with existing immutable content.`);
  } catch (error) {
    if (isMissing(error)) await writeImmutableJson(path, taskCase);
    else throw error;
  }
}

function assertPaths(dataDir: string, sourceRoot: string): void {
  if (!isAbsolute(dataDir) || !isAbsolute(sourceRoot)) throw new Error('Codex experiments require absolute data and source paths.');
}

function assertIds(input: Pick<CodexExperimentInput, 'caseId' | 'experimentId' | 'runId'>): void {
  for (const [label, value] of [['caseId', input.caseId], ['experimentId', input.experimentId], ['runId', input.runId]] as const) {
    if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier.`);
  }
}

function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
async function readComparisonNarrative(experimentRoot: string, reportPath: string): Promise<string | undefined> {
  try { return (await readFile(join(experimentRoot, reportPath), 'utf8')).slice(0, 64 * 1024); } catch (error) { return isMissing(error) ? undefined : Promise.reject(error); }
}

async function reportExists(experimentRoot: string, reportPath: string): Promise<boolean> {
  try { await readFile(join(experimentRoot, reportPath), 'utf8'); return true; } catch (error) { return !isMissing(error) ? Promise.reject(error) : false; }
}
