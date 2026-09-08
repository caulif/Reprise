import type { ExperimentHandle, RecoveryAttempt } from "./experiment.js";
import { assertCandidateStartAllowed, candidateGateFromAttempt } from "./candidate-start.js";
import type { EventEnvelope, TaskCase, CandidateSpec } from "../core/schema.js";
import type { EnvironmentBaseline } from "../environment/local-workspace-provider.js";
import type { SourceRootKind } from "./replay-conditions.js";
import { persistPreparedScene, loadSealedScene } from "./experiment-scene.js";
import { CliError } from "./cli-error.js";

type RecoverFn = (request: {
  signal?: AbortSignal;
  taskCase: TaskCase;
  sourceRoot: string;
  sourceRootKind?: SourceRootKind;
  onEvent?: (event: EventEnvelope) => void;
}) => Promise<RecoveryAttempt>;

type StartFn = (request: {
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
}) => Promise<ExperimentHandle>;

type Workflow = { recover: RecoverFn; start: StartFn };
type PrepareInput = Parameters<RecoverFn>[0];
type RunInput = Parameters<StartFn>[0];

/** Sealed-scene prepare. Same function the TUI Recovery step and CLI `prepare` call. */
export async function prepareExperiment(workflow: Workflow, request: PrepareInput): Promise<RecoveryAttempt> {
  const attempt = await workflow.recover(request);
  await persistPreparedScene(attempt, request.sourceRoot, request.taskCase);
  return attempt;
}

export async function runSealedScenario(workflow: Workflow, request: {
  dataDir: string;
  scenario: string;
  onEvent: RunInput["onEvent"];
  candidate?: CandidateSpec;
  compare?: boolean;
  deferComparison?: boolean;
  signal?: AbortSignal;
}): Promise<ExperimentHandle> {
  const loaded = await loadSealedScene(request.dataDir, request.scenario);
  return runPreparedExperiment(workflow, {
    taskCase: loaded.taskCase,
    sourceRoot: loaded.descriptor.sourceRoot,
    recoveryAttempt: loaded.attempt,
    experimentId: loaded.descriptor.experimentId,
    onEvent: request.onEvent,
    ...(request.candidate ? { candidate: request.candidate } : {}),
    ...(request.compare ? { compare: true } : {}),
    ...(request.deferComparison ? { deferComparison: true } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

export function assertExclusiveRunInputs(source: { sourceRoot?: string | undefined; taskCasePath?: string | undefined }, scenario?: string): void {
  const hasSource = Boolean(source.sourceRoot || source.taskCasePath);
  if (hasSource && scenario) throw new CliError("usage", "Use either --source-root/--task-case or --scenario, not both.");
  if (!hasSource && !scenario) throw new CliError("usage", "Provide --source-root and --task-case, or --scenario.");
}

/** Scene run after prepare. Refuses to start a candidate before a runnable sealed scene. */
export async function runPreparedExperiment(workflow: Workflow, request: RunInput): Promise<ExperimentHandle> {
  if (!request.recoveryAttempt) throw new Error("Candidate cannot start before scene prepare completes.");
  assertCandidateStartAllowed(candidateGateFromAttempt(request.recoveryAttempt, Boolean(request.taskCase.initialInput?.text)));
  return workflow.start(request);
}

/** Full run is prepare then the same scene-run function. */
export async function runFullExperiment(workflow: Workflow, request: PrepareInput & Pick<RunInput, "onEvent" | "candidate" | "compare" | "deferComparison" | "experimentId" | "runId">): Promise<ExperimentHandle> {
  const recoveryAttempt = await prepareExperiment(workflow, request);
  return runPreparedExperiment(workflow, {
    ...request,
    onEvent: request.onEvent ?? (() => {}),
    recoveryAttempt,
  });
}

export function compareExperiment(handle: ExperimentHandle): Promise<void> {
  return handle.runComparison();
}
