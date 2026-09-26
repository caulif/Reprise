import type { ExperimentResult } from '../application/experiment.js';
import { resolveResultPathLinks } from '../application/result-paths.js';
import { matchesKey, type KeyId } from '@earendil-works/pi-tui';
import { t, type Locale, type MessageKey } from './i18n.js';

/** Stable action ids shared by footer hints, help, keyboard, and mouse hits. */
export type ActionId =
  | 'cancel'
  | 'close'
  | 'show-help'
  | 'hide-help'
  | 'home'
  | 'back'
  | 'start-find'
  | 'clear-find'
  | 'next-hit'
  | 'prev-hit'
  | 'follow'
  | 'select-copy'
  | 'leave-reading'
  | 'enter-reading'
  | 'toggle-fold'
  | 'read-page'
  | 'cycle-fold'
  | 'cycle-fold-prev'
  | 'compare'
  | 'view-process'
  | 'toggle-details'
  | 'open-report'
  | 'open-history-final'
  | 'open-candidate-final'
  | 'open-trace'
  | 'open-replica'
  | 'confirm-run'
  | 'change-model'
  | 'retry-recovery'
  | 'open-diagnostics'
  | 'refreeze-session'
  | 'open-recovery-config'
  | 'activate-primary';

export type ActionKind = 'readonly' | 'navigate' | 'start' | 'cancel';

export type UiAction = {
  readonly id: ActionId;
  readonly labelKey: MessageKey;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly disabledReasonKey?: MessageKey;
  readonly kind: ActionKind;
  /** Higher values win footer slots; 0 = help-only. */
  readonly footerPriority: number;
};

export type ActionMode = {
  readonly processExpanded?: boolean;
  readonly finding?: boolean;
  readonly reading?: boolean;
  readonly preparing?: boolean;
  readonly comparing?: boolean;
  readonly comparePending?: boolean;
  readonly processAvailable?: boolean;
  readonly canStartConfirm?: boolean;
  readonly helpOpen?: boolean;
  readonly editingText?: boolean;
  /** False while recovery prep rejects find. */
  readonly findAllowed?: boolean;
  readonly recoveryFailureAction?: 'retry' | 'config' | 'refreeze' | 'diagnose' | 'return';
};

export type ActionArtifacts = {
  readonly report?: boolean;
  readonly diagnostic?: boolean;
  readonly historyFinal?: boolean;
  readonly candidateFinal?: boolean;
  readonly trace?: boolean;
  readonly replica?: boolean;
};

export type ActionContext = {
  readonly page: string;
  readonly locale: Locale;
  readonly mode?: ActionMode;
  readonly artifacts?: ActionArtifacts;
  readonly narrow?: boolean;
};

const FOOTER_MAX = 4;

export function artifactsFromResult(result: ExperimentResult | undefined): ActionArtifacts {
  if (!result) return {};
  const paths = resolveResultPathLinks(result);
  return {
    report: Boolean(paths.report),
    diagnostic: Boolean(paths.report) && (result.comparison.result.status === 'failed' || result.comparison.result.status === 'cancelled'),
    historyFinal: Boolean(paths.historyFinal),
    candidateFinal: Boolean(paths.candidateFinal),
    trace: Boolean(paths.trace),
    replica: Boolean(paths.replica),
  };
}

export function listActions(ctx: ActionContext): readonly UiAction[] {
  const mode = ctx.mode ?? {};
  if (mode.helpOpen) {
    return [action('hide-help', 'hintEsc', ['escape'], 'navigate', 10)];
  }
  switch (ctx.page) {
    case 'running':
      return runningActions(mode);
    case 'result':
      return mode.processExpanded ? processActions(mode) : resultActions(mode, ctx.artifacts ?? {});
    case 'compare-confirm':
      return [
        action('compare', 'compareConfirmStart', ['enter'], 'start', 40),
        action('back', 'hintBack', ['escape', 'b'], 'navigate', 30),
      ];
    case 'confirm':
      return [...confirmActions(mode), action('read-page', 'hintScrollPage', ['pageup', 'pagedown'], 'readonly', 0)];
    case 'home':
      return [action('show-help', 'hintHelp', ['?'], 'readonly', 5)];
    case 'source':
    case 'preflight':
    case 'candidate-product':
    case 'recovery-review':
    case 'candidate-model':
    case 'config':
    case 'sessions':
    case 'inspection':
    case 'history':
    case 'history-detail':
      return [
        action('back', 'hintBack', ['escape', 'b'], 'navigate', 30),
        action('show-help', 'hintHelp', ['?'], 'readonly', 5),
        ...(ctx.page === 'history-detail' || ctx.page === 'recovery-review'
          ? [action('read-page', 'hintScrollPage', ['pageup', 'pagedown'], 'readonly', 0)] : []),
      ];
    case 'error':
      return [action('home', 'hintHome', ['escape', 'enter', 'b'], 'navigate', 10)];
    default:
      return [action('show-help', 'hintHelp', ['?'], 'readonly', 1)];
  }
}

function runningActions(mode: ActionMode): readonly UiAction[] {
  const cancelLabel: MessageKey = mode.comparing ? 'hintStopComparison' : mode.preparing ? 'hintStopPreparation' : 'hintStopExecution';
  const cancel = action('cancel', cancelLabel, ['ctrl+c'], 'cancel', 40);
  const help = action('show-help', 'hintHelp', ['?'], 'readonly', 5);
  if (mode.reading) {
    return [
      action('select-copy', 'hintSelectCopy', ['drag'], 'readonly', 35),
      action('leave-reading', 'hintLeaveReading', ['v', 'escape'], 'navigate', 30),
      cancel,
      help,
    ];
  }
  if (mode.finding) {
    return [
      action('next-hit', 'hintNextHit', ['enter'], 'readonly', 30),
      action('prev-hit', 'hintPrevHit', ['shift+enter'], 'readonly', 20),
      action('clear-find', 'hintClearFind', ['escape'], 'navigate', 25),
      cancel,
    ];
  }
  if (mode.preparing || mode.findAllowed === false) {
    return [cancel, help];
  }
  return [
    cancel,
    action('start-find', 'hintFind', ['/'], 'readonly', 0),
    action('follow', 'hintFollow', ['end'], 'navigate', 0),
    action('toggle-fold', 'hintExpand', ['enter'], 'readonly', 0),
    action('cycle-fold', 'hintCycleFold', ['tab'], 'readonly', 0),
    action('cycle-fold-prev', 'hintCycleFold', ['shift+tab'], 'readonly', 0),
    action('enter-reading', 'hintEnterReading', ['v'], 'navigate', 0),
    help,
  ];
}

function processActions(mode: ActionMode): readonly UiAction[] {
  if (mode.finding) return [
    action('next-hit', 'hintNextHit', ['enter'], 'readonly', 0),
    action('prev-hit', 'hintPrevHit', ['shift+enter'], 'readonly', 0),
    action('clear-find', 'hintClearFind', ['escape'], 'navigate', 0),
    action('show-help', 'hintHelp', ['?'], 'readonly', 5),
  ];
  return [
    action('back', 'hintBack', ['escape'], 'navigate', 30),
    action('start-find', 'hintFind', ['/'], 'readonly', 0),
    action('toggle-fold', 'hintExpand', ['enter'], 'readonly', 0),
    action('cycle-fold', 'hintCycleFold', ['tab'], 'readonly', 0),
    action('follow', 'hintFollow', ['end'], 'navigate', 0),
    action('read-page', 'hintScrollPage', ['pageup', 'pagedown'], 'readonly', 0),
    action('show-help', 'hintHelp', ['?'], 'readonly', 5),
  ];
}

function resultActions(mode: ActionMode, artifacts: ActionArtifacts): readonly UiAction[] {
  const actions: UiAction[] = [];
  actions.push(action('activate-primary', 'hintActivate', ['enter'], 'readonly', 40));
  actions.push(artifactAction('open-candidate-final', 'hintCandidateFinal', ['f'], artifacts.candidateFinal, 'noCandidateFinal'));
  actions.push(artifactAction('open-report', artifacts.diagnostic ? 'hintOpenDiagnostic' : 'hintReport', ['o'], artifacts.report, 'noReport'));
  actions.push(artifactAction('open-history-final', 'hintHistoryFinal', ['h'], artifacts.historyFinal, 'noHistoryFinal'));
  actions.push(artifactAction('open-trace', 'hintTrace', ['t'], artifacts.trace, 'noTrace'));
  actions.push(artifactAction('open-replica', 'hintReplica', ['w'], artifacts.replica, 'noReplica'));
  if (mode.processAvailable) actions.push(action('view-process', 'viewCandidateProcess', ['p'], 'readonly', 15));
  actions.push(action('toggle-details', 'resultDetails', ['d'], 'readonly', 10));
  if (mode.comparePending) actions.push(action('compare', 'hintCompare', ['c'], 'navigate', 30));
  actions.push(action('home', 'finishReview', ['escape', 'b'], 'navigate', 35));
  actions.push(action('show-help', 'hintHelp', ['?'], 'readonly', 1));
  actions.push(action('read-page', 'hintScrollPage', ['pageup', 'pagedown'], 'readonly', 0));
  return actions;
}

function confirmActions(mode: ActionMode): readonly UiAction[] {
  const canStart = mode.canStartConfirm !== false;
  const run: UiAction = canStart
    ? action('confirm-run', 'hintStartCandidate', ['enter'], 'start', 40)
    : {
        ...action('confirm-run', 'hintTryBlocked', ['enter'], 'start', 40),
        enabled: false,
        disabledReasonKey: 'recoveryFailed',
      };
  const recoveryAction = mode.recoveryFailureAction === 'retry'
    ? action('retry-recovery', 'recoveryActionRetry', ['r'], 'start', 35)
    : mode.recoveryFailureAction === 'diagnose'
      ? action('open-diagnostics', 'recoveryActionDiagnose', ['d'], 'readonly', 35)
      : mode.recoveryFailureAction === 'refreeze'
        ? action('refreeze-session', 'recoveryActionRefreeze', ['f'], 'navigate', 35)
        : mode.recoveryFailureAction === 'config'
          ? action('open-recovery-config', 'recoveryFailureConfig', ['c'], 'navigate', 35)
        : undefined;
  return [
    ...(recoveryAction ? [recoveryAction] : []),
    run,
    action('change-model', 'hintChangeModel', ['b', 'escape'], 'navigate', 20),
    action('show-help', 'hintHelp', ['?'], 'readonly', 1),
  ];
}

function artifactAction(
  id: ActionId,
  labelKey: MessageKey,
  keys: readonly string[],
  available: boolean | undefined,
  missingKey: MessageKey,
): UiAction {
  const enabled = Boolean(available);
  if (enabled) {
    return { id, labelKey, keys, enabled: true, kind: 'readonly', footerPriority: 20 };
  }
  return {
    id,
    labelKey,
    keys,
    enabled: false,
    disabledReasonKey: missingKey,
    kind: 'readonly',
    footerPriority: 0,
  };
}

function action(
  id: ActionId,
  labelKey: MessageKey,
  keys: readonly string[],
  kind: ActionKind,
  footerPriority: number,
): UiAction {
  return { id, labelKey, keys, enabled: true, kind, footerPriority };
}

/** Footer pairs from the shared action list (enabled only, capped). */
export function footerHintPairs(
  actions: readonly UiAction[],
  locale: Locale,
  max = FOOTER_MAX,
): readonly (readonly [string, string])[] {
  const ranked = actions
    .filter((item) => item.enabled && item.footerPriority > 0)
    .slice()
    .sort((a, b) => b.footerPriority - a.footerPriority);
  const seen = new Set<ActionId>();
  const pairs: (readonly [string, string])[] = [];
  for (const item of ranked) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const key = displayKey(item.keys[0] ?? '');
    pairs.push([key, t(locale, item.labelKey)]);
    if (pairs.length >= max) break;
  }
  // Artifact-heavy result pages must retain an explicit return and help slot;
  // otherwise four openable files crowd out the only escape path.
  const artifactCount = actions.filter((item) => item.id.startsWith('open-') && item.enabled).length;
  if (artifactCount >= 2) {
    const required = actions.filter((item) => item.enabled && (item.id === 'home' || item.id === 'back' || item.id === 'show-help'));
    for (const item of required) {
      if (pairs.some(([key]) => key === displayKey(item.keys[0] ?? ''))) continue;
      if (pairs.length >= max) pairs.pop();
      pairs.push([displayKey(item.keys[0] ?? ''), t(locale, item.labelKey)]);
    }
  }
  return pairs;
}

export function helpLinesFromActions(
  actions: readonly UiAction[],
  locale: Locale,
  page?: string,
): readonly string[] {
  const lines: string[] = [];
  if (page) lines.push(` ${t(locale, 'helpThisPage', { page })}`);
  for (const item of actions) {
    const keys = item.keys.map(displayKey).join(' / ');
    const label = t(locale, item.labelKey);
    if (item.enabled) {
      lines.push(`   ${padKey(keys)} ${label}`);
    } else {
      const reason = item.disabledReasonKey ? t(locale, item.disabledReasonKey) : t(locale, 'actionUnavailable');
      lines.push(`   ${padKey(keys)} ${label} — ${reason}`);
    }
  }
  lines.push('');
  lines.push(` ${t(locale, 'helpGlobalLine')}`);
  lines.push(` ${t(locale, 'helpCtrlC')}`);
  lines.push(` ${t(locale, 'helpQuestion')}`);
  return lines;
}

function actionById(actions: readonly UiAction[], id: ActionId): UiAction | undefined {
  return actions.find((item) => item.id === id);
}

export function isActionEnabled(actions: readonly UiAction[], id: ActionId): boolean {
  return actionById(actions, id)?.enabled === true;
}

/** Match a key against enabled actions first; disabled matches return the action for no-op handling. */
export function matchActionKey(
  actions: readonly UiAction[],
  data: string,
  opts?: { readonly includeDisabled?: boolean },
): UiAction | undefined {
  const includeDisabled = opts?.includeDisabled === true;
  let disabled: UiAction | undefined;
  for (const item of actions) {
    if (!item.keys.some((key) => keyMatches(data, key))) continue;
    if (item.enabled) return item;
    if (includeDisabled && !disabled) disabled = item;
  }
  return includeDisabled ? disabled : undefined;
}

function keyMatches(data: string, key: string): boolean {
  if (key.length === 1) {
    return data === key || data === key.toUpperCase();
  }
  return matchesKey(data, key as KeyId);
}

function displayKey(key: string): string {
  if (key === 'ctrl+c') return 'Ctrl+C';
  if (key === 'shift+enter') return 'S-Enter';
  if (key === 'shift+tab') return 'S-Tab';
  if (key === 'escape') return 'Esc';
  if (key === 'enter') return 'Enter';
  if (key === 'pageup') return 'PgUp';
  if (key === 'pagedown') return 'PgDn';
  if (key.length === 1) return key;
  return key.replace(/^\w/, (ch) => ch.toUpperCase());
}

function padKey(keys: string): string {
  return keys.length >= 10 ? keys : `${keys}${' '.repeat(10 - keys.length)}`;
}

function optionalMode(parts: {
  processExpanded?: boolean;
  preparing?: boolean;
  comparing?: boolean;
  finding?: boolean;
  reading?: boolean;
  comparePending?: boolean;
  processAvailable?: boolean;
  canStartConfirm?: boolean;
  helpOpen?: boolean;
  editingText?: boolean;
  findAllowed?: boolean;
  recoveryFailureAction?: ActionMode['recoveryFailureAction'];
}): ActionMode {
  const mode: ActionMode = {};
  if (parts.processExpanded !== undefined) Object.assign(mode, { processExpanded: parts.processExpanded });
  if (parts.preparing !== undefined) Object.assign(mode, { preparing: parts.preparing });
  if (parts.comparing !== undefined) Object.assign(mode, { comparing: parts.comparing });
  if (parts.finding !== undefined) Object.assign(mode, { finding: parts.finding });
  if (parts.reading !== undefined) Object.assign(mode, { reading: parts.reading });
  if (parts.comparePending !== undefined) Object.assign(mode, { comparePending: parts.comparePending });
  if (parts.processAvailable !== undefined) Object.assign(mode, { processAvailable: parts.processAvailable });
  if (parts.canStartConfirm !== undefined) Object.assign(mode, { canStartConfirm: parts.canStartConfirm });
  if (parts.helpOpen !== undefined) Object.assign(mode, { helpOpen: parts.helpOpen });
  if (parts.editingText !== undefined) Object.assign(mode, { editingText: parts.editingText });
  if (parts.findAllowed !== undefined) Object.assign(mode, { findAllowed: parts.findAllowed });
  if (parts.recoveryFailureAction !== undefined) Object.assign(mode, { recoveryFailureAction: parts.recoveryFailureAction });
  return mode;
}

export function runningFooterHints(
  locale: Locale,
  opts: {
    readonly preparing?: boolean;
    readonly comparing?: boolean;
    readonly finding?: boolean;
    readonly reading?: boolean;
    readonly findAllowed?: boolean;
    readonly narrow?: boolean;
  } = {},
): readonly (readonly [string, string])[] {
  return footerHintPairs(listActions({
    page: 'running',
    locale,
    mode: optionalMode({
      ...(opts.preparing !== undefined ? { preparing: opts.preparing } : {}),
      ...(opts.comparing !== undefined ? { comparing: opts.comparing } : {}),
      ...(opts.finding !== undefined ? { finding: opts.finding } : {}),
      ...(opts.reading !== undefined ? { reading: opts.reading } : {}),
      ...(opts.findAllowed !== undefined ? { findAllowed: opts.findAllowed } : {}),
    }),
    ...(opts.narrow !== undefined ? { narrow: opts.narrow } : {}),
  }), locale);
}

export function resultFooterHints(
  locale: Locale,
  opts: {
    readonly comparePending?: boolean;
    readonly artifacts?: ActionArtifacts;
  } = {},
): readonly (readonly [string, string])[] {
  return footerHintPairs(listActions({
    page: 'result',
    locale,
    mode: optionalMode({
      ...(opts.comparePending !== undefined ? { comparePending: opts.comparePending } : {}),
    }),
    ...(opts.artifacts !== undefined ? { artifacts: opts.artifacts } : {}),
  }), locale);
}

export { optionalMode };
