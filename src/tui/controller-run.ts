import { basename, dirname, join } from 'node:path';
import { isFsAbsolute } from '../core/paths.js';
import type { EventEnvelope, TaskCase } from '../core/schema.js';
import type { CodexExperimentResult } from '../application/experiment.js';
import { hasFileApiKey, tryEnvironmentName, type HarnessConfigDraft, type HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { freezeCase } from '../products/shared/freeze.js';
import { errorMessage } from './format.js';
import { t, type Locale } from './i18n.js';
import { projectLabel } from './pages/intake.js';
import { appendTimelineEntries, projectTimelineEvent } from './timeline.js';
import type { Consume, ControllerHandle } from './controller-input.js';

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

function resultMessage(result: CodexExperimentResult, locale: Locale): string {
  const kind = result.record.outcome.termination.kind;
  if (kind === 'blocked') return t(locale, 'resultBlocked');
  if (kind === 'failed') return t(locale, 'resultFailed');
  if (kind === 'completed') return t(locale, 'resultCompleted');
  return t(locale, 'resultOther');
}

export function startRunSetup(c: ControllerHandle): Consume {
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
    void beginPreflight(c);
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
    if (session?.availability === 'catalog-only') throw new Error('Selected session has catalog metadata but no readable transcript.');
    const imported = await pack.sessions.import({
      productId: pack.manifest.productId,
      sessionId: session?.sessionId ?? 'session',
      sourcePath,
    });
    const result = await freezeCase(imported, join(c.dataDir, 'cases'), c.privacy, c.now(), {
      ...(input.initialMessageId ? { initialMessageId: input.initialMessageId } : {}),
      reuseExisting: true,
    });
    if (token !== c.generation) return;
    c.taskCase = result.taskCase;
    if (input.thenRun && c.workflow) {
      startRunSetup(c);
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
  const attempt = c.recoveryAttempt;
  c.recoveryAttempt = undefined;
  if (attempt?.staging) await attempt.provider.discardRecovery(attempt.staging).catch(() => undefined);
}

export function requestCancellation(c: ControllerHandle): Consume {
  if (c.cancelling) return c.close();
  c.cancelling = true;
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
  appendTimelineEntries(c.timeline, projectTimelineEvent(event));
  const visible = c.visibleTimeline();
  if (c.timelineFollowing) c.timelineSelected = Math.max(0, visible.length - 1);
  else c.timelineSelected = Math.max(0, Math.min(c.timelineSelected, Math.max(0, visible.length - 1)));
  if (c.page === 'running') c.scheduleTimelineRender();
}

export async function beginPreflight(c: ControllerHandle): Promise<void> {
  const token = c.beginNavigation();
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase) throw new Error('Experiment workflow is unavailable.');
    void discardRecovery(c);
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
    c.page = 'preflight';
    c.message = t(c.locale, 'inspectingSource');
    c.render(true);
    const preflight = await c.workflow.preflight({
      taskCase,
      sourceRoot: c.sourceRoot.trim(),
    });
    if (token !== c.generation) return;
    const blocked = preflight.workspace?.blockedReasons ?? [];
    if (preflight.sourceBaseline === 'unavailable' || blocked.length) {
      throw new Error(
        blocked.length
          ? blocked.join(' | ')
          : 'Candidate was not started because the source baseline is unavailable.',
      );
    }
    c.preflight = preflight;
    void beginRecovery(c);
    return;
  } catch (error) {
    if (token !== c.generation) return;
    c.showError(error, errorReturn);
  }
  c.render(true);
}

async function beginRecovery(c: ControllerHandle): Promise<void> {
  const token = c.beginNavigation();
  try {
    if (!c.workflow || !c.taskCase || !c.preflight) throw new Error('Recovery is unavailable before preflight.');
    await discardRecovery(c);
    c.timeline = [];
    c.timelineSelected = 0;
    c.timelineFollowing = true;
    c.preparePhase = 'check';
    c.prepareDetail = 'Preparing the isolated environment';
    c.page = 'running';
    startRunClock(c);
    c.render(true);
    const attempt = await c.workflow.recover({
      taskCase: c.taskCase,
      sourceRoot: c.sourceRoot.trim(),
      onEvent: (event) => appendTimeline(c, event),
    });
    if (token !== c.generation) {
      if (attempt.staging) await attempt.provider.discardRecovery(attempt.staging);
      return;
    }
    c.recoveryAttempt = attempt;
    const recovered = attempt.baseline.match === 'recovered' || attempt.baseline.match === 'recovered_partial';
    c.preflight = {
      ...c.preflight,
      comparisonClass: attempt.baseline.match === 'recovered'
        ? 'recovered'
        : attempt.baseline.match === 'recovered_partial'
          ? 'recovered_partial'
          : 'observational',
      limitations: [
        ...c.preflight.limitations,
        ...attempt.baseline.warnings,
        ...(attempt.providerPreview?.reportText
          ? [`Recovery preview: ${attempt.providerPreview.changedPaths.length} workspace paths changed; report captured as recovery.md.`]
          : []),
      ],
    };
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
    stopRunClock(c);
    c.page = 'confirm';
    c.message = recovered ? t(c.locale, 'recoveryReady') : t(c.locale, 'recoveryFailed');
  } catch (error) {
    if (token !== c.generation) return;
    c.showError(error, 'preflight');
    stopRunClock(c);
  }
  c.render(true);
}

export async function beginRun(c: ControllerHandle): Promise<void> {
  void c.refreshProductAuth();
  const token = c.beginNavigation();
  const errorReturn = c.runFromSource ? 'source' : 'home';
  try {
    if (!c.workflow || !c.taskCase) throw new Error('Experiment workflow is unavailable.');
    c.timeline = [];
    c.timelineSelected = 0;
    c.timelineFilterIndex = 0;
    c.timelineFollowing = true;
    c.detailExpanded = false;
    c.cancelling = false;
    c.finding = false;
    c.findQuery = '';
    c.findCursor = 0;
    const taskCase = c.taskCase;
    if (!c.preflight) throw new Error('Run confirmation requires a completed preflight.');
    const blocked = c.preflight.workspace?.blockedReasons ?? [];
    if (c.preflight.sourceBaseline === 'unavailable' || blocked.length) {
      throw new Error(
        blocked.length
          ? blocked.join(' | ')
          : 'Candidate was not started because the source baseline is unavailable.',
      );
    }
    c.preparePhase = 'copy';
    c.prepareDetail = undefined;
    c.page = 'running';
    startRunClock(c);
    c.message = '';
    c.render(true);
    c.prepareDetail = workspaceDetail(c.preflight.workspace);
    c.render(true);
    const recoveryAttempt = c.recoveryAttempt;
    const acceptedBaseline = recoveryAttempt?.accept ? await recoveryAttempt.accept() : undefined;
    c.recoveryAttempt = undefined;
    const handle = await c.workflow.start({
      taskCase,
      sourceRoot: c.sourceRoot.trim(),
      onEvent: (event) => appendTimeline(c, event),
      ...(c.preflight.sourceFingerprint ? { expectedSourceFingerprint: c.preflight.sourceFingerprint } : {}),
      ...(recoveryAttempt
        ? {
            recoveryAttempt,
            ...(acceptedBaseline ? { preResolvedBaseline: acceptedBaseline } : {}),
          }
        : {}),
    });
    if (token !== c.generation) {
      await handle.cancel().catch(() => undefined);
      return;
    }
    c.preparePhase = undefined;
    c.prepareDetail = undefined;
    c.activeExperiment = handle;
    if (c.cancelling) await handle.cancel();
    c.message = c.cancelling ? t(c.locale, 'cancellationRequested') : '';
    c.render(true);
    const result = await handle.result;
    if (token !== c.generation) return;
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
  } catch (error) {
    if (token !== c.generation) return;
    c.activeExperiment = undefined;
    c.showError(error, errorReturn);
  }
  stopRunClock(c);
  c.render(true);
}
