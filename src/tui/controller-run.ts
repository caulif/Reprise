import { dirname } from 'node:path';
import { artifactsFromResult, listActions } from './action-model.js';
import { isFsAbsolute } from '../core/paths.js';
import type { CandidateSpec, EventEnvelope, TaskCase } from '../core/schema.js';
import { candidateSpecFromOffer, catalogCursor } from '../application/candidate-spec.js';
import type { ExperimentResult, ExperimentHandle } from '../application/experiment.js';
import { historyExperimentFromResult } from '../application/history-result-facts.js';
import { hasFileApiKey, tryEnvironmentName, type HarnessConfigDraft, type HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { listSummaryIncomplete, packDefaultCandidate, runtimePacks } from '../application/intake-catalog.js';
import { errorMessage } from './format.js';
import { t, type Locale } from './i18n.js';
import { projectLabel } from './pages/intake.js';
import { bumpTimelineRevision } from './timeline-revision.js';
import { appendTimelineEntries, projectTimelineEvent } from './timeline.js';
import { syncTimelineSelection } from './timeline-read.js';
import type { Consume, ControllerHandle } from './controller-input.js';
import { candidateGateFromView, candidateStartBlocked, type CandidateStartGate } from '../application/candidate-start.js';
import { prepareExperiment } from '../application/experiment-operations.js';
import { recoveryViewFromAttempt } from '../application/recovery/view.js';
import { userRecoveryStatus } from '../application/recovery/user-status.js';
import { preflightFromBaseline } from '../application/experiment-preflight.js';
import { deriveResultPresentationFromResult } from './display-state.js';
import type { ClockScope } from './phase-state.js';

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
  return t(locale, deriveResultPresentationFromResult(result, locale).messageKey);
}

export type CancelUi = 'idle' | 'requesting' | 'failed' | 'settled';

export function resolveCompareChoice(c: ControllerHandle, run: boolean): void {
  const choice = c.compareChoice;
  c.compareChoice = undefined;
  choice?.resolve(run);
}

function defaultResultAction(c: ControllerHandle, result: ExperimentResult): ControllerHandle['resultAction'] {
  const artifacts = artifactsFromResult(result);
  const available = new Set(listActions({
    page: 'result', locale: c.locale,
    mode: { comparePending: Boolean(c.compareChoice), processAvailable: c.timeline.length > 0 },
    artifacts,
  }).filter((item) => item.enabled).map((item) => item.id));
  for (const action of ['compare', 'open-replica', 'open-report'] as const) {
    if (available.has(action)) return action;
  }
  return 'home';
}

function setCancelUi(c: ControllerHandle, next: CancelUi, detail?: string): void {
  c.cancelUi = next;
  if (next === 'requesting') {
    const stage = c.preparePhase === 'compare' || c.runDiagnostics.state.comparisonAttemptId ? 'cancellationStageComparison'
      : c.preparePhase === 'check' || c.preparePhase === 'copy' || c.runDiagnostics.state.runPhase === 'recovery' ? 'cancellationStagePreparation'
        : 'cancellationStageExecution';
    c.message = t(c.locale, 'cancellationRequestedStage', { stage: t(c.locale, stage) });
    return;
  }
  if (next === 'failed') {
    c.message = t(c.locale, 'cancellationFailed', { error: detail?.trim() || 'unknown' });
  }
}

function clearCancelRequest(c: ControllerHandle): void {
  setCancelUi(c, 'idle');
}

/** Cancel already decided or in flight — do not arm the deferred compare gate. */
function cancelBlocksCompareGate(c: ControllerHandle): boolean {
  return c.cancelUi !== 'idle';
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
  if (!hasFileApiKey(c.modelConfig) && !hasFileApiKey(c.configSession.state.draft)) {
    const envName = envNameFromConfig(c.modelConfig, c.configSession.state.draft);
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
      privacy: { ...c.privacy, allowModelText: true },
      now: c.now(),
      ...(input.initialMessageId ? { initialMessageId: input.initialMessageId } : {}),
    });
    if (token !== c.generation) return;
    c.taskCase = result.taskCase;
    c.preparedInspectionSnapshot = c.inspection ? JSON.stringify({ inspection: c.inspection, privacy: c.privacy }) : undefined;
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
  if (c.cancelUi === 'requesting') return c.close();
  resolveCompareChoice(c, false);
  setCancelUi(c, 'requesting');
  c.startupAbort?.abort();
  c.recoveryAbort?.abort();
  c.render();
  void c.activeExperiment?.cancel().catch((error: unknown) => {
    if (c.cancelUi !== 'requesting') return;
    setCancelUi(c, 'failed', errorMessage(error));
    c.render(true);
  });
  return { consume: true };
}

function startRunClock(c: ControllerHandle, scope?: ClockScope): void {
  stopRunClock(c);
  if (scope) c.runDiagnostics.startClock(scope, c.nowMs());
  c.runClock = setInterval(() => {
    if (c.page === 'running') c.scheduleTimelineRender();
  }, 250);
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
  c.runDiagnostics.observe(event, c.preparePhase);
  appendTimelineEntries(c.timeline, projectTimelineEvent(event), c);
  syncTimelineSelection(c);
  if (c.page === 'running') c.scheduleTimelineRender();
}

export async function beginPreflight(c: ControllerHandle, input: { afterFreeze?: boolean } = {}): Promise<void> {
  const token = c.beginNavigation();
  clearCancelRequest(c);
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
        allowModelText: true,
        redactions: [...c.privacy.redactions],
      },
    };
    c.taskCase = taskCase;
    c.page = 'running';
    c.preparePhase = 'check';
    c.prepareDetail = t(c.locale, 'recoveryStagePrepare');
    c.message = t(c.locale, input.afterFreeze ? 'frozenEnteringRecovery' : 'inspectingSource');
    startRunClock(c, 'recovery');
    c.render(true);
    const preflight = await c.workflow.preflight({
      taskCase,
      sourceRoot: c.sourceRoot.trim(),
      verifyCandidate: false,
    });
    if (token !== c.generation) return;
    if (c.cancelUi === 'requesting' || c.cancelUi === 'failed') {
      setCancelUi(c, 'settled');
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
  clearCancelRequest(c);
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase || !c.preflight) throw new Error('Recovery is unavailable before preflight.');
    await discardRecovery(c);
    c.timeline = [];
    c.timelineSelected = 0;
    bumpTimelineRevision(c);
    c.timelineFollowing = true;
    c.runDiagnostics.beginPhase('recovery');
    c.preparePhase = 'check';
    c.prepareDetail = t(c.locale, 'recoveryStageAgent');
    c.page = 'running';
    startRunClock(c, 'recovery');
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
    const currentPreflight = preflightFromBaseline(view.baseline, c.preflight.resolved);
    c.preflight = {
      ...currentPreflight,
      ...(c.preflight.contamination ? { contamination: c.preflight.contamination } : {}),
      comparisonClass: userStatus === 'recovered'
        ? 'recovered'
        : userStatus === 'partial'
          ? 'recovered_partial'
          : 'observational',
      limitations: currentPreflight.limitations,
    };
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
    c.runDiagnostics.freezeClock('recovery', c.nowMs());
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
      setCancelUi(c, 'settled');
    } else c.showError(error, errorReturn);
    stopRunClock(c);
  } finally {
    if (c.recoveryAbort === abort) {
      c.recoveryAbort = undefined;
      if (c.cancelUi === 'requesting') setCancelUi(c, 'settled');
    }
  }
  c.render(true);
}

async function settleRun(
  c: ControllerHandle,
  handle: ExperimentHandle,
  token: number,
): Promise<ExperimentResult | undefined> {
  if (c.autoCompare || cancelBlocksCompareGate(c)) return handle.result;
  const partial = await handle.candidateFinished;
  if (token !== c.generation) {
    // Navigation/close may have already decided via cancel(); settle is idempotent.
    await handle.skipComparison();
    return undefined;
  }
  if (cancelBlocksCompareGate(c)) return handle.result;
  c.runDiagnostics.freezeClock('candidate', c.nowMs());
  c.result = partial;
  c.resultDetails = false;
  c.processExpanded = false;
  c.timelineReadOffset = 0;
  c.resultAction = defaultResultAction(c, partial);
  c.page = 'result';
  c.preparePhase = undefined;
  c.prepareDetail = undefined;
  c.message = t(c.locale, 'compareGateBody');
  const runCompare = await new Promise<boolean>((resolve) => {
    c.compareChoice = { resolve };
    c.render(true);
  });
  // Always close the deferred comparison gate exactly once. Generation may bump
  // from Esc/backToHome/close after the operator choice is resolved.
  if (runCompare && !cancelBlocksCompareGate(c)) {
    if (token === c.generation) {
      c.page = 'running';
      c.preparePhase = 'compare';
      c.render(true);
    }
    startRunClock(c, 'comparison');
    await handle.runComparison();
    c.runDiagnostics.freezeClock('comparison', c.nowMs());
  } else {
    await handle.skipComparison();
  }
  if (token !== c.generation) return undefined;
  return handle.result;
}

function showRunResult(c: ControllerHandle, result: ExperimentResult): void {
  c.result = result;
  c.resultDetails = false;
  c.processExpanded = false;
  c.timelineReadOffset = 0;
  c.resultAction = defaultResultAction(c, result);
  const experimentRoot = result.experimentRoot ?? dirname(result.reportPath);
  const completedCase = result.taskCase ?? c.taskCase;
  c.recentExperiment = historyExperimentFromResult(result, {
    experimentRoot,
    taskCaseId: completedCase?.caseId ?? 'unknown',
    ...(completedCase ? { taskCase: completedCase } : {}),
  });
  c.activeExperiment = undefined;
  c.page = 'result';
  c.timelineFilterIndex = 0;
  c.canvasFind.reset();
  if (c.cancelUi === 'requesting' || c.cancelUi === 'failed') setCancelUi(c, 'settled');
  else if (c.cancelUi !== 'settled') clearCancelRequest(c);
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
    clearCancelRequest(c);
    c.canvasFind.reset();
    const taskCase = c.taskCase;
    if (!c.preflight) throw new Error('Run confirmation requires a completed preflight.');
    const candidate = c.selectedCandidate;
    if (!candidate) throw new Error('A candidate product and model must be selected before the isolated run starts.');
    const blocked = candidateStartBlocked(candidateGateFrom(c));
    if (blocked) throw new Error(blocked);
    if (!await verifyConfirmedModel(c, candidate, token, abort.signal)) return;
    c.runDiagnostics.beginPhase('candidate_starting');
    c.preparePhase = 'copy';
    c.prepareDetail = undefined;
    c.page = 'running';
    startRunClock(c, 'candidate');
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
    if (c.cancelUi === 'requesting' || c.cancelUi === 'failed') await handle.cancel();
    c.message = c.cancelUi === 'requesting' || c.cancelUi === 'failed' ? c.message : '';
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
        setCancelUi(c, 'settled');
      } catch (cleanupError) { c.showError(cleanupError, errorReturn); }
    } else c.showError(error, errorReturn);
  } finally {
    if (c.startupAbort === abort) c.startupAbort = undefined;
  }
  stopRunClock(c);
  c.render(true);
}

async function verifyConfirmedModel(c: ControllerHandle, candidate: CandidateSpec, token: number, signal: AbortSignal): Promise<boolean> {
  if (!c.workflow || !c.preflight) return false;
  const previous = c.preflight.resolved.resolvedModel;
  const verified = await c.workflow.verifyCandidate(candidate);
  if (token !== c.generation) return false;
  signal.throwIfAborted();
  c.preflight = { ...c.preflight, resolved: verified };
  if (verified.resolvedModel === previous) return true;
  c.page = 'confirm';
  c.confirmStartArmed = true;
  c.message = t(c.locale, 'modelChangedReconfirm', { previous, next: verified.resolvedModel });
  c.render(true);
  return false;
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
  if (c.candidateVerifyPending) return;
  const generation = c.generation;
  const productId = pack.manifest.productId;
  const offerValue = offer.value;
  c.candidateVerifyPending = { generation, productId, offerValue };
  try {
    const spec = candidateSpecFromOffer(productId, offer);
    const resolved = await c.workflow.verifyCandidate(spec);
    if (generation !== c.generation) return;
    const pending = c.candidateVerifyPending;
    if (!pending || pending.generation !== generation || pending.productId !== productId || pending.offerValue !== offerValue) return;
    if (c.candidateProductId !== productId) return;
    const current = c.candidateModelOffers[c.candidateModelCursor];
    if (!current || current.value !== offerValue) return;
    c.selectedCandidate = spec;
    if (c.preflight) c.preflight = { ...c.preflight, resolved };
    const blocked = candidateStartBlocked(candidateGateFrom(c));
    if (blocked) {
      c.message = blocked;
      c.render();
      return;
    }
    c.message = '';
    c.confirmStartArmed = false;
    c.page = 'confirm';
    c.render(true);
    c.confirmStartArmed = true;
  } catch (error) {
    if (generation !== c.generation) return;
    c.candidateCatalogStatus = 'error';
    c.candidateCatalogError = errorMessage(error);
    c.render();
  } finally {
    const pending = c.candidateVerifyPending;
    if (pending && pending.generation === generation && pending.productId === productId && pending.offerValue === offerValue) {
      c.candidateVerifyPending = undefined;
    }
  }
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

