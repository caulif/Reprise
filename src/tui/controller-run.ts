import { basename, dirname } from 'node:path';
import { isFsAbsolute } from '../core/paths.js';
import type { EventEnvelope, TaskCase } from '../core/schema.js';
import { candidateSpecFromOffer, catalogCursor } from '../application/candidate-spec.js';
import type { ExperimentResult, ExperimentHandle } from '../application/experiment.js';
import { hasFileApiKey, tryEnvironmentName, type HarnessConfigDraft, type HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { listSummaryIncomplete, packDefaultCandidate, runtimePacks } from '../application/intake-catalog.js';
import { errorMessage } from './format.js';
import { t, type Locale } from './i18n.js';
import { projectLabel } from './pages/intake.js';
import { appendTimelineEntries, projectTimelineEvent } from './timeline.js';
import { syncTimelineSelection } from './timeline-read.js';
import type { Consume, ControllerHandle } from './controller-input.js';
import { candidateGateFromView, candidateStartBlocked, type CandidateStartGate } from '../application/candidate-start.js';
import { prepareExperiment } from '../application/experiment-operations.js';
import { recoveryViewFromAttempt } from '../application/recovery/view.js';
import { userRecoveryStatus } from '../application/recovery/user-status.js';
import { record, text } from '../core/json.js';
import type { CandidateRunPhase } from './pages/run.js';

function historicalCwd(taskCase: TaskCase | undefined): string | undefined {
  const cwd = taskCase?.taskContext?.historicalCwd;
  return typeof cwd === 'string' && isFsAbsolute(cwd) ? cwd : undefined;
}

export function envNameFromConfig(config: HarnessModelConfig, draft: HarnessConfigDraft): string | undefined {
  return tryEnvironmentName(draft.keyRef) ?? (config.schemaVersion === 2 ? tryEnvironmentName(config.keyRef ?? '') : undefined);
}

function workspaceDetail(workspace: { fileCount: number; totalBytes: number } | undefined): string | undefined {
  if (!workspace) return undefined;
  return `${workspace.fileCount.toLocaleString()} files · ${(workspace.totalBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resultMessage(result: ExperimentResult, locale: Locale): string {
  if (result.comparison.result.status === 'skipped') return t(locale, 'resultSkipped');
  const kind = result.record.outcome.termination.kind;
  if (kind === 'blocked') return t(locale, 'resultBlocked');
  if (kind === 'failed') return t(locale, 'resultFailed');
  if (kind === 'cancelled') return t(locale, 'resultCancelled');
  if (kind === 'completed') return t(locale, 'resultCompleted');
  return t(locale, 'resultOther');
}

export function startRunSetup(c: ControllerHandle, input: { afterFreeze?: boolean } = {}): Consume {
  if (!c.taskCase) {
    c.page = 'home';
    return c.setHomeMessage(t(c.locale, 'noTask'));
  }
  if (!c.workflow) {
    c.page = 'home';
    return c.setHomeMessage(t(c.locale, 'runUnavailable'));
  }
  if (!hasFileApiKey(c.modelConfig) && !hasFileApiKey(c.configDraft)) {
    const envName = envNameFromConfig(c.modelConfig, c.configDraft);
    if (envName && !process.env[envName]) {
      c.page = 'home';
      return c.setHomeMessage(t(c.locale, 'envNotSetRun', { name: envName }));
    }
  }
  c.sourceRoot = historicalCwd(c.taskCase) ?? '';
  c.sourceCursor = c.sourceRoot.length;
  if (isFsAbsolute(c.sourceRoot.trim())) {
    c.runFromSource = false;
    bindWorkflow(c, beginPreflight(c, { afterFreeze: input.afterFreeze === true }));
    return { consume: true };
  }
  c.runFromSource = true;
  c.page = 'source';
  c.message = t(c.locale, 'enterSourceRoot');
  c.render();
  return { consume: true };
}

export async function freeze(
  c: ControllerHandle,
  sourcePath: string,
  input: { initialMessageId?: string; thenRun?: boolean } = {},
): Promise<void> {
  const token = c.beginNavigation();
  try {
    const session = c.inspection ?? c.sessions.find((item) => item.sourcePath === sourcePath);
    const pack = c.packs.find((item) => item.manifest.productId === session?.productId);
    if (!pack) throw new Error(`No Product Pack is registered for session ${session?.productId ?? 'unknown'}.`);
    if (!session) throw new Error('Selected session is no longer available.');
    const alreadyInspected = c.inspection?.sourcePath === sourcePath;
    c.message = t(c.locale, !alreadyInspected && listSummaryIncomplete(session) ? 'inspectingIncompleteSummary' : 'inspectingSelectedSession');
    c.render(true);
    if (!c.workflow) throw new Error('Experiment workflow is required to freeze a session.');
    const result = await c.workflow.freezeSource({
      productId: pack.manifest.productId,
      session,
      sourcePath,
      privacy: c.privacy,
      now: c.now(),
      ...(input.initialMessageId ? { initialMessageId: input.initialMessageId } : {}),
    });
    if (token !== c.generation) return;
    c.taskCase = result.taskCase;
    if (input.thenRun && c.canStartExperiment) {
      startRunSetup(c, { afterFreeze: true });
      return;
    }
    c.page = 'home';
    const project = projectLabel(historicalCwd(result.taskCase));
    c.message = result.reused
      ? t(c.locale, 'taskReused', { project, id: result.taskCase.caseId })
      : t(c.locale, 'taskFrozen', { project, id: result.taskCase.caseId });
  } catch (error) {
    if (token !== c.generation) return;
    c.showError(error, 'sessions');
  }
  c.render(true);
}

export async function discardRecovery(c: ControllerHandle): Promise<void> {
  const view = c.recoveryView;
  if (!view) return;
  try {
    await c.workflow?.discardRecovery(view.experimentId);
    if (c.recoveryView === view) c.recoveryView = undefined;
  } catch (error) {
    throw Object.assign(new Error(t(c.locale, 'cleanupFailed'), { cause: error }), { name: 'RecoveryCleanupError' });
  }
}

export function requestCancellation(c: ControllerHandle): Consume {
  if (c.cancelling) return c.close();
  c.cancelling = true;
  c.startupAbort?.abort();
  c.recoveryAbort?.abort();
  c.message = t(c.locale, 'cancellationRequested');
  c.render();
  void c.activeExperiment?.cancel().catch((error: unknown) => {
    c.cancelling = false;
    c.message = errorMessage(error);
    c.render(true);
  });
  return { consume: true };
}

function startRunClock(c: ControllerHandle): void {
  stopRunClock(c);
  c.runStartedAt = Date.now();
  c.runClock = setInterval(() => {
    if (c.page === 'running') c.render();
  }, 400);
  c.runClock.unref?.();
}

export function stopRunClock(c: ControllerHandle): void {
  if (c.runClock) clearInterval(c.runClock);
  c.runClock = undefined;
}

function appendTimeline(c: ControllerHandle, event: EventEnvelope): void {
  if (event.type === 'comparison.started') {
    c.preparePhase = 'compare';
    c.prepareDetail = 'Writing comparison report' ;
  } else if (event.type === 'comparison.completed') {
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
  } else if (c.preparePhase && c.preparePhase !== 'compare') {
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
  }
  noteRunDiagnostics(c, event);
  appendTimelineEntries(c.timeline, projectTimelineEvent(event));
  syncTimelineSelection(c);
  if (c.page === 'running') c.scheduleTimelineRender();
}

export async function beginPreflight(c: ControllerHandle, input: { afterFreeze?: boolean } = {}): Promise<void> {
  const token = c.beginNavigation();
  c.cancelling = false;
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase) throw new Error('Experiment workflow is unavailable.');
    await discardRecovery(c);
    if (token !== c.generation) return;
    c.preflight = undefined;
    const taskCase = {
      ...c.taskCase,
      privacy: {
        ...c.taskCase.privacy,
        ...c.privacy,
        redactions: [...c.privacy.redactions],
      },
    };
    c.taskCase = taskCase;
    c.page = 'running';
    c.preparePhase = 'check';
    c.prepareDetail = t(c.locale, 'recoveryStagePrepare');
    c.message = t(c.locale, input.afterFreeze ? 'frozenEnteringRecovery' : 'inspectingSource');
    startRunClock(c);
    c.render(true);
    const preflight = await c.workflow.preflight({
      taskCase,
      sourceRoot: c.sourceRoot.trim(),
      verifyCandidate: false,
    });
    if (token !== c.generation) return;
    if (c.cancelling) {
      c.cancelling = false;
      c.page = 'home';
      c.preparePhase = undefined;
      c.prepareDetail = undefined;
      c.message = t(c.locale, 'recoveryCancelled');
      stopRunClock(c);
      c.render(true);
      return;
    }
    c.preflight = preflight;
    bindRecovery(c, beginRecovery(c));
    return;
  } catch (error) {
    if (token !== c.generation) return;
    c.showError(error, errorReturn);
  }
  c.render(true);
}

async function beginRecovery(c: ControllerHandle): Promise<void> {
  const token = c.beginNavigation();
  const abort = new AbortController();
  c.recoveryAbort = abort;
  c.cancelling = false;
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase || !c.preflight) throw new Error('Recovery is unavailable before preflight.');
    await discardRecovery(c);
    c.timeline = [];
    c.timelineSelected = 0;
    c.timelineFollowing = true;
    resetRunDiagnostics(c);
    c.runPhase = 'recovery';
    c.preparePhase = 'check';
    c.prepareDetail = t(c.locale, 'recoveryStageAgent');
    c.page = 'running';
    startRunClock(c);
    c.render(true);
    const attempt = await prepareExperiment(c.workflow, {
      signal: abort.signal,
      taskCase: c.taskCase,
      sourceRoot: c.sourceRoot.trim(),
      onEvent: (event) => appendTimeline(c, event),
    });
    if (token !== c.generation) {
      c.recoveryView = recoveryViewFromAttempt(attempt);
      await discardRecovery(c);
      return;
    }
    const view = recoveryViewFromAttempt(attempt);
    c.recoveryView = view;
    if (view.cleanupFailed) throw Object.assign(new Error(t(c.locale, 'cleanupFailed')), { name: 'RecoveryCleanupError' });
    if (abort.signal.aborted) {
      await discardRecovery(c);
      abort.signal.throwIfAborted();
    }
    const userStatus = userRecoveryStatus({
      baseline: view.baseline,
      transcriptOk: Boolean(c.taskCase.initialInput?.text),
      hasAccept: view.hasAccept,
    });
    c.preflight = {
      ...c.preflight,
      comparisonClass: userStatus === 'recovered'
        ? 'recovered'
        : userStatus === 'partial'
          ? 'recovered_partial'
          : 'observational',
      limitations: [
        ...c.preflight.limitations,
        ...(view.baseline.warnings ?? []),
        ...(view.providerPreview?.reportText
          ? [`Recovery preview: ${view.providerPreview.changedPaths.length} workspace paths changed; report captured as recovery.md.`]
          : []),
      ],
    };
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
    stopRunClock(c);
    c.selectedCandidate = undefined;
    if (userStatus === 'failed') {
      c.page = 'confirm';
      c.message = t(c.locale, 'recoveryFailed');
    } else {
      openCandidateProductPicker(c);
      c.message = userStatus === 'recovered'
        ? t(c.locale, 'recoveryReady')
        : t(c.locale, 'recoveryPartial', { n: view.providerPreview?.changedPaths.length ?? 0 });
    }
  } catch (error) {
    if (token !== c.generation) {
      if (error instanceof Error && error.name === 'RecoveryCleanupError') throw error;
      return;
    }
    if (abort.signal.aborted && !(error instanceof Error && error.name === 'RecoveryCleanupError')) {
      c.page = 'home';
      c.preparePhase = undefined;
      c.prepareDetail = undefined;
      c.message = t(c.locale, 'recoveryCancelled');
    } else c.showError(error, errorReturn);
    stopRunClock(c);
  } finally {
    if (c.recoveryAbort === abort) {
      c.recoveryAbort = undefined;
      c.cancelling = false;
    }
  }
  c.render(true);
}

async function settleRun(
  c: ControllerHandle,
  handle: ExperimentHandle,
  token: number,
): Promise<ExperimentResult | undefined> {
  if (c.autoCompare || c.cancelling) return handle.result;
  const partial = await handle.candidateFinished;
  if (token !== c.generation) return undefined;
  c.result = partial;
  c.page = 'result';
  c.preparePhase = undefined;
  c.prepareDetail = undefined;
  c.message = t(c.locale, 'compareGateBody');
  c.render(true);
  const runCompare = await new Promise<boolean>((resolve) => {
    c.compareChoice = { resolve };
  });
  if (token !== c.generation) return undefined;
  if (runCompare) {
    c.page = 'running';
    c.preparePhase = 'compare';
    c.render(true);
    await handle.runComparison();
  } else {
    await handle.skipComparison();
  }
  return handle.result;
}

function showRunResult(c: ControllerHandle, result: ExperimentResult): void {
  c.result = result;
  const experimentRoot = result.experimentRoot ?? dirname(result.reportPath);
  const completedCase = result.taskCase ?? c.taskCase;
  c.recentExperiment = {
    experimentId: basename(experimentRoot),
    taskCaseId: completedCase?.caseId ?? 'unknown',
    runId: result.record.attempt.runId,
    outcome: result.record.outcome.termination.kind,
    startedAt: result.record.attempt.createdAt,
    reportPath: result.reportPath,
    path: experimentRoot,
    sizeBytes: 0,
  };
  c.activeExperiment = undefined;
  c.page = 'result';
  c.timelineFilterIndex = 0;
  c.finding = false;
  c.findQuery = '';
  c.findCursor = 0;
  c.message = resultMessage(result, c.locale);
}

export async function beginRun(c: ControllerHandle): Promise<void> {
  void c.refreshProductAuth();
  const token = c.beginNavigation();
  const abort = new AbortController();
  c.startupAbort = abort;
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase) throw new Error('Experiment workflow is unavailable.');
    c.timelineSelected = Math.max(0, c.visibleTimeline().length - 1);
    c.timelineFilterIndex = 0;
    c.timelineFollowing = true;
    c.detailExpanded = false;
    c.cancelling = false;
    c.finding = false;
    c.findQuery = '';
    c.findCursor = 0;
    const taskCase = c.taskCase;
    if (!c.preflight) throw new Error('Run confirmation requires a completed preflight.');
    const candidate = c.selectedCandidate;
    if (!candidate) throw new Error('A candidate product and model must be selected before the isolated run starts.');
    const blocked = candidateStartBlocked(candidateGateFrom(c));
    if (blocked) throw new Error(blocked);
    c.preflight = { ...c.preflight, resolved: await c.workflow.verifyCandidate(candidate) };
    if (token !== c.generation) return;
    abort.signal.throwIfAborted();
    resetRunDiagnostics(c);
    c.runPhase = 'candidate_starting';
    c.preparePhase = 'copy';
    c.prepareDetail = undefined;
    c.page = 'running';
    startRunClock(c);
    c.message = '';
    c.render(true);
    c.prepareDetail = workspaceDetail(c.preflight.workspace);
    c.render(true);
    const recoveryView = c.recoveryView;
    const acceptedBaseline = recoveryView ? await c.workflow.acceptRecovery(recoveryView.experimentId) : undefined;
    if (token !== c.generation) return;
    abort.signal.throwIfAborted();
    const handle = await c.workflow.start({
      signal: abort.signal,
      taskCase,
      sourceRoot: c.sourceRoot.trim(),
      candidate,
      onEvent: (event) => appendTimeline(c, event),
      ...(c.preflight.sourceFingerprint ? { expectedSourceFingerprint: c.preflight.sourceFingerprint } : {}),
      ...(recoveryView
        ? {
            recoveryExperimentId: recoveryView.experimentId,
            ...(acceptedBaseline ? { preResolvedBaseline: acceptedBaseline } : {}),
          }
        : {}),
      ...(c.autoCompare ? { compare: true } : { deferComparison: true }),
    });
    c.recoveryView = undefined;
    if (token !== c.generation) {
      await handle.cancel();
      const result = await handle.result;
      if (result.record.outcome.cleanup.status !== 'complete') throw new Error(t(c.locale, 'cleanupFailed'));
      return;
    }
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
    c.activeExperiment = handle;
    if (c.cancelling) await handle.cancel();
    c.message = c.cancelling ? t(c.locale, 'cancellationRequested') : '';
    c.render(true);
    const result = await settleRun(c, handle, token);
    if (!result || token !== c.generation) return;
    showRunResult(c, result);
  } catch (error) {
    if (token !== c.generation) {
      if (error instanceof Error && error.name === 'AbortError') return;
      throw error;
    }
    c.activeExperiment = undefined;
    if (abort.signal.aborted && error instanceof Error && error.name === 'AbortError') {
      try {
        await discardRecovery(c);
        c.page = 'home';
        c.preparePhase = undefined;
        c.prepareDetail = undefined;
        c.message = t(c.locale, 'startupCancelled');
        c.cancelling = false;
      } catch (cleanupError) { c.showError(cleanupError, errorReturn); }
    } else c.showError(error, errorReturn);
  } finally {
    if (c.startupAbort === abort) c.startupAbort = undefined;
  }
  stopRunClock(c);
  c.render(true);
}

export { candidateStartBlocked, type CandidateStartGate } from "../application/candidate-start.js";

export function candidateGateFrom(c: ControllerHandle): CandidateStartGate {
  const recovered = c.recoveryView
    ? candidateGateFromView(c.recoveryView, Boolean(c.taskCase?.initialInput?.text)).recovery
    : undefined;
  return {
    blockedReasons: c.preflight?.workspace?.blockedReasons ?? [],
    ...(c.preflight?.sourceBaseline ? { sourceBaseline: c.preflight.sourceBaseline } : {}),
    ...(recovered ? { recovery: recovered } : {}),
  };
}

function resetRunDiagnostics(c: ControllerHandle): void {
  c.runPhase = undefined;
  c.lastRuntimeEventAt = undefined;
  c.lastRuntimeEventKind = undefined;
  c.modelOutputSeen = false;
  c.reconnectCount = 0;
  c.reconnectTotal = 0;
}

function noteRunDiagnostics(c: ControllerHandle, event: EventEnvelope): void {
  c.lastRuntimeEventAt = event.occurredAt;
  c.lastRuntimeEventKind = event.type;
  const phase = phaseForEvent(event);
  if (phase) c.runPhase = phase;
  if (event.type === 'runtime.visible_output' || event.type === 'runtime.turn_settled') c.modelOutputSeen = true;
  if (event.type !== 'runtime.runtime_failed') return;
  const attempt = parseReconnectAttempt(text(record(event.payload).message) ?? '');
  if (!attempt) return;
  c.reconnectCount = attempt.current;
  c.reconnectTotal = attempt.total;
  c.runPhase = 'candidate_reconnecting';
}

function parseReconnectAttempt(message: string): { current: number; total: number } | undefined {
  const match = /Reconnecting\s+(\d+)\s*\/\s*(\d+)/i.exec(message);
  if (!match) return undefined;
  return { current: Number(match[1]), total: Number(match[2]) };
}

function phaseForEvent(event: EventEnvelope): CandidateRunPhase | undefined {
  const type = event.type;
  if (type.startsWith('recovery.')) return 'recovery';
  if (type.startsWith('agent.') && text(record(event.payload).role) === 'recovery') return 'recovery';
  if (type === 'run.attempt_created' || type === 'runtime.session_started') return 'candidate_starting';
  if (type === 'runtime.delivery_observed' || (type === 'run.state_changed' && record(event.payload).to === 'awaiting_target')) return 'candidate_generating';
  if (
    type === 'runtime.turn_started'
    || type === 'runtime.tool_started'
    || type === 'runtime.tool_finished'
    || type === 'runtime.visible_output'
    || type === 'runtime.visible_prompt'
  ) return 'candidate_generating';
  return undefined;
}

function openCandidateProductPicker(c: ControllerHandle): void {
  const sourceId = c.taskCase?.source.productId ?? '';
  c.candidateProductId = sourceId;
  const packs = runtimePacks(c.packs);
  c.candidateProductCursor = Math.max(0, packs.findIndex((pack) => pack.manifest.productId === sourceId));
  c.selectedCandidate = undefined;
  c.candidateModelOffers = [];
  c.candidateCatalogStatus = 'idle';
  c.candidateCatalogError = undefined;
  c.page = 'candidate-product';
  void refreshCandidateAvailability(c);
}

async function refreshCandidateAvailability(c: ControllerHandle): Promise<void> {
  const generation = ++c.candidateAvailabilityGeneration;
  const entries = await Promise.all(runtimePacks(c.packs).map(async (pack) => {
    try {
      const [item] = await c.workflow?.inspectAvailability(pack.manifest.productId) ?? [];
      return [pack.manifest.productId, item?.status ?? 'not_installed'] as const;
    } catch {
      // inspectAvailability is best-effort listing; a throw is not_installed, not a TUI crash.
      return [pack.manifest.productId, 'not_installed'] as const;
    }
  }));
  if (generation !== c.candidateAvailabilityGeneration) return;
  c.candidateAvailability = Object.fromEntries(entries);
  if (c.page === 'candidate-product') c.render();
}

export async function loadCandidateCatalog(c: ControllerHandle): Promise<void> {
  const packs = runtimePacks(c.packs);
  const pack = packs[c.candidateProductCursor] ?? packs.find((item) => item.manifest.productId === c.candidateProductId);
  if (!c.workflow || !pack) throw new Error('Candidate product is unavailable.');
  const generation = ++c.candidateCatalogGeneration;
  c.candidateProductId = pack.manifest.productId;
  c.selectedCandidate = undefined;
  c.candidateModelOffers = [];
  c.candidateCatalogStatus = 'loading';
  c.candidateCatalogError = undefined;
  c.candidateSuggestedValue = packDefaultCandidate(pack).requestedModel;
  c.page = 'candidate-model';
  c.render();
  try {
    const offers = await c.workflow.listCatalog(pack.manifest.productId);
    if (generation !== c.candidateCatalogGeneration) return;
    c.candidateModelOffers = offers;
    c.candidateModelCursor = catalogCursor(offers, c.candidateSuggestedValue);
    if (!offers.length) {
      c.candidateCatalogStatus = 'error';
      c.candidateCatalogError = t(c.locale, 'catalogEmpty');
    } else {
      c.candidateCatalogStatus = 'ready';
    }
  } catch (error) {
    if (generation !== c.candidateCatalogGeneration) return;
    c.candidateModelOffers = [];
    c.candidateCatalogStatus = 'error';
    c.candidateCatalogError = errorMessage(error);
  }
  c.render();
}

export async function acceptCandidateModel(c: ControllerHandle): Promise<void> {
  const pack = c.packs.find((item) => item.manifest.productId === c.candidateProductId);
  const offer = c.candidateModelOffers[c.candidateModelCursor];
  if (!c.workflow || !pack || !offer || c.candidateCatalogStatus !== 'ready') return;
  const generation = c.generation;
  try {
    const spec = candidateSpecFromOffer(pack.manifest.productId, offer);
    const resolved = await c.workflow.verifyCandidate(spec);
    if (generation !== c.generation) return;
    c.selectedCandidate = spec;
    if (c.preflight) c.preflight = { ...c.preflight, resolved };
    c.page = 'confirm';
    c.message = '';
  } catch (error) {
    if (generation !== c.generation) return;
    c.candidateCatalogStatus = 'error';
    c.candidateCatalogError = errorMessage(error);
  }
  c.render();
}

/** A second observer so close() is not the only listener on background run promises. */
export function bindWorkflow(c: ControllerHandle, work: Promise<void>): void {
  c.workflowFinished = work;
  void work.catch(() => undefined);
}

function bindRecovery(c: ControllerHandle, work: Promise<void>): void {
  c.recoveryFinished = work;
  void work.catch(() => undefined);
}

