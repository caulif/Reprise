import type { CodexExperimentPreflight, CodexExperimentResult, RecoveryAttempt } from '../application/experiment.js';
import type { CandidateSpec, RunPolicy, TaskCase } from '../core/schema.js';
import type { HarnessConfigDraft, HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import type { SessionInspection, SessionPrivacy, SessionSummary } from '../products/contract.js';
import { countCalls, countTurns, currentRunState, elapsedFrom } from './pages/run.js';
import { TIMELINE_FILTERS } from './format.js';
import type { HistoryCase, HistoryExperiment } from './local-history.js';
import type { IntakeLevel, SessionProject } from './pages/intake.js';
import type { TimelineEntry } from './timeline.js';
import type { WorkbenchView } from './workbench.js';
import type { Locale } from './i18n.js';
import { projectLabel, sessionTitle, type ProductIntakeItem } from './pages/intake.js';
import type { PreparePhase } from './widgets.js';

type Input = {
  readonly page: WorkbenchView['page']; readonly modelConfig: HarnessModelConfig; readonly hasSavedModelConfig: boolean; readonly harnessAuthOk: boolean; readonly envName?: string; readonly productLabel?: string; readonly productConfigured?: boolean; readonly taskCase?: TaskCase | undefined; readonly message: string; readonly inlineHelp: boolean; readonly cancelling: boolean; readonly locale?: Locale;
  readonly recentExperiment?: HistoryExperiment | undefined; readonly composer: string; readonly composerCursor: number; readonly showSuggestions: boolean; readonly commandOverlay: boolean;
  readonly configDraft: HarnessConfigDraft; readonly configSelected: number; readonly configEditing: boolean; readonly configBuffer: string; readonly configCursor: number; readonly configDirty: boolean; readonly configPendingToggle: boolean;
  readonly historyTotalBytes: number; readonly historyTab: 'runs' | 'cases'; readonly historyItems: readonly (HistoryCase | HistoryExperiment)[]; readonly historySelected: number; readonly historyDetail?: HistoryCase | HistoryExperiment | undefined;
  readonly intakeLevel: IntakeLevel; readonly products: readonly ProductIntakeItem[]; readonly visibleProjects: readonly SessionProject[]; readonly activeProjectKey: string; readonly visibleSessions: readonly SessionSummary[]; readonly selected: number; readonly filterEligible: boolean; readonly searchQuery: string; readonly searchCursor: number; readonly searching: boolean; readonly discoveryStatus?: 'idle' | 'loading' | 'ready' | 'error';
  readonly inspection?: SessionInspection | undefined; readonly privacy: SessionPrivacy; readonly inspectionTaskInput: number; readonly inspectionShowOutcome: boolean;
  readonly sourceRoot: string; readonly sourceCursor: number; readonly preflight?: CodexExperimentPreflight | undefined; readonly recoveryAttempt?: RecoveryAttempt | undefined; readonly candidate?: CandidateSpec | undefined; readonly effort: string; readonly policy: RunPolicy | undefined;
  readonly preparePhase?: PreparePhase; readonly prepareDetail?: string;
  readonly nowMs?: number;
  readonly timeline: readonly TimelineEntry[]; readonly visibleTimeline: readonly TimelineEntry[]; readonly timelineSelected: number; readonly timelineFilterIndex: number; readonly timelineFollowing: boolean; readonly detailExpanded: boolean; readonly runStartedAt: number; readonly result?: CodexExperimentResult | undefined;
  readonly viewer?: { readonly title: string; readonly body: string };
  readonly actorsOpen?: boolean;
  readonly finding?: boolean;
  readonly findQuery?: string;
  readonly findCursor?: number;
  readonly cwd?: string;
};

function homeModel(input: Input, envSet: boolean) {
  return {
    taskCase: input.taskCase, recentExperiment: input.recentExperiment,
    hasApiConfig: input.hasSavedModelConfig, hasUsableAuth: input.hasSavedModelConfig && input.harnessAuthOk,
    ...(input.envName ? { envName: input.envName, envSet } : {}),
    ...(input.hasSavedModelConfig ? { providerLabel: input.modelConfig.providerId, modelId: input.modelConfig.modelId } : {}),
    composer: input.composer, composerCursor: input.composerCursor, showSuggestions: input.showSuggestions && !input.commandOverlay,
    locale: input.locale ?? 'en',
  };
}

function runningModel(input: Input) {
  return {
    entries: input.visibleTimeline, selected: input.timelineSelected, filter: TIMELINE_FILTERS[input.timelineFilterIndex] ?? 'ALL',
    following: input.timelineFollowing, cancelling: input.cancelling, currentState: currentRunState(input.timeline),
    elapsed: elapsedFrom(input.timeline, input.nowMs ?? Date.now(), input.runStartedAt || undefined),
    turns: { used: countTurns(input.timeline), ...(input.policy ? { max: input.policy.maxTargetTurns } : {}) },
    calls: { used: countCalls(input.timeline), ...(input.policy ? { max: input.policy.maxModelCalls } : {}) },
    detailExpanded: input.detailExpanded, ...(input.policy ? { policy: input.policy } : {}),
    ...(input.preparePhase ? { preparePhase: input.preparePhase, ...(input.prepareDetail ? { prepareDetail: input.prepareDetail } : {}) } : {}),
    locale: input.locale ?? 'en', ...(input.productLabel ? { productLabel: input.productLabel } : {}),
    ...(input.taskCase ? {
      taskTitle: sessionTitle(input.taskCase.initialInput.text),
      workspaceProject: projectLabel(
        typeof input.taskCase.taskContext?.historicalCwd === 'string' ? input.taskCase.taskContext.historicalCwd : undefined,
        input.locale ?? 'en',
      ),
    } : {}),
    ...(input.finding ? { finding: true, findQuery: input.findQuery ?? '', findCursor: input.findCursor ?? 0 } : {}),
    tick: input.nowMs ?? Date.now(),
  };
}

export function projectWorkbenchView(input: Input): WorkbenchView {
  const envSet = Boolean(input.envName && process.env[input.envName]);
  const home = homeModel(input, envSet);
  const base: WorkbenchView = {
    page: input.page, cwd: input.cwd ?? process.cwd(),
    ...(input.hasSavedModelConfig ? { modelId: input.modelConfig.modelId, effort: input.modelConfig.effort } : {}),
    hasApiConfig: input.hasSavedModelConfig,
    hasUsableAuth: input.hasSavedModelConfig && input.harnessAuthOk,
    ...(input.envName ? { envName: input.envName } : {}),
    ...(input.productLabel ? { productLabel: input.productLabel } : {}),
    ...(input.productConfigured !== undefined ? { productConfigured: input.productConfigured } : {}),
    hasTaskCase: Boolean(input.taskCase),
    locale: input.locale ?? 'en',
    message: input.message,
    ...(input.inlineHelp ? { inlineHelp: true } : {}),
    cancelling: input.cancelling,
    home,
    ...(input.viewer ? { viewer: { ...input.viewer, locale: input.locale ?? 'en' } } : {}),
    ...(input.actorsOpen ? { actorsOpen: true } : {}),
  };
  if (input.page === 'home') return base;
  if (input.page === 'config') {
    return {
      ...base,
      config: {
        draft: input.configDraft, selected: input.configSelected, editing: input.configEditing, buffer: input.configBuffer, cursor: input.configCursor,
        dirty: input.configDirty, saved: input.hasSavedModelConfig,
        ...(input.envName ? { envName: input.envName, envSet } : {}),
        pendingToggle: input.configPendingToggle,
        locale: input.locale ?? 'en',
      },
    };
  }
  if (input.page === 'history' || input.page === 'history-detail') {
    return {
      ...base,
      history: {
        totalBytes: input.historyTotalBytes, tab: input.historyTab, items: input.historyItems, selected: input.historySelected,
        locale: input.locale ?? 'en',
        ...(input.historyDetail ?? input.historyItems[input.historySelected]
          ? { detail: input.historyDetail ?? input.historyItems[input.historySelected] }
          : {}),
      },
      ...(input.historyDetail ? { historyDetail: input.historyDetail } : {}),
    };
  }
  const sessions = {
    level: input.intakeLevel,
    products: input.products,
    projects: input.intakeLevel === 'projects' ? input.visibleProjects : input.visibleProjects.filter((project) => project.key === input.activeProjectKey),
    sessions: input.visibleSessions, selected: input.selected, filterEligible: input.filterEligible,
    query: input.searchQuery, searchCursor: input.searchCursor, searching: input.searching,
    ...(input.discoveryStatus ? { discoveryStatus: input.discoveryStatus } : {}),
    locale: input.locale ?? 'en', ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  };
  if (input.page === 'sessions') return { ...base, sessions };
  if (input.page === 'inspection' && input.inspection) {
    return {
      ...base, sessions,
      inspection: { inspection: input.inspection, privacy: input.privacy, selectedTaskInput: input.inspectionTaskInput, showOutcome: input.inspectionShowOutcome, locale: input.locale ?? 'en', ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}) },
    };
  }
  if (input.page === 'source') return { ...base, source: { sourceRoot: input.sourceRoot, sourceCursor: input.sourceCursor, step: 1, locale: input.locale ?? 'en' } };
  const recovery = input.recoveryAttempt?.baseline.recovery ? {
    status: input.recoveryAttempt.baseline.recovery.status,
    ...(input.recoveryAttempt.providerPreview?.reportText ? { reportText: input.recoveryAttempt.providerPreview.reportText } : {}),
    unresolved: input.recoveryAttempt.baseline.recovery.unresolved,
    changedPathCount: input.recoveryAttempt.providerPreview?.changedPaths.length ?? 0,
  } : undefined;
  if (input.page === 'preflight' && input.preflight) return { ...base, preflight: { preflight: input.preflight, candidate: input.candidate, ...(recovery ? { recovery } : {}), step: 2, locale: input.locale ?? 'en', ...(input.productLabel ? { productLabel: input.productLabel } : {}) } };
  if (input.page === 'confirm' && input.preflight) return { ...base, confirm: { preflight: input.preflight, candidate: input.candidate, sourceRoot: input.sourceRoot, effort: input.effort, harnessModel: input.modelConfig.modelId, harnessAuthOk: input.harnessAuthOk, ...(recovery ? { recovery } : {}), ...(input.policy ? { policy: input.policy } : {}), step: 3, locale: input.locale ?? 'en', ...(input.productLabel ? { productLabel: input.productLabel } : {}) } };
  if (input.page === 'running') return { ...base, running: runningModel(input) };
  if (input.page === 'result' && input.result) return { ...base, running: runningModel(input), result: input.result };
  return base;
}
