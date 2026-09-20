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
  | 'start-find'
  | 'clear-find'
  | 'next-hit'
  | 'prev-hit'
  | 'follow'
  | 'leave-reading'
  | 'enter-reading'
  | 'toggle-fold'
  | 'cycle-fold'
  | 'cycle-fold-prev'
  | 'running-escape'
  | 'compare'
  | 'open-report'
  | 'open-history-final'
  | 'open-candidate-final'
  | 'open-trace'
  | 'open-replica'
  | 'confirm-run'
  | 'change-model';

export type UiAction = {
  readonly id: ActionId;
  readonly labelKey: MessageKey;
  readonly keys: readonly string[];
  readonly enabled: boolean;
  readonly disabledReasonKey?: MessageKey;
  /** Higher values win footer slots; 0 = help-only / non-footer. */
  readonly footerPriority: number;
};

export type ActionMode = {
  readonly finding?: boolean;
  readonly reading?: boolean;
  readonly preparing?: boolean;
  readonly comparePending?: boolean;
  readonly canStartConfirm?: boolean;
  readonly helpOpen?: boolean;
  readonly editingText?: boolean;
  /** False while recovery prep rejects find. */
  readonly findAllowed?: boolean;
};

export type ActionArtifacts = {
  readonly report?: boolean;
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
};

const FOOTER_MAX = 4;

export function artifactsFromResult(result: ExperimentResult | undefined): ActionArtifacts {
  if (!result) return {};
  const paths = resolveResultPathLinks(result);
  return {
    report: Boolean(paths.report),
    historyFinal: Boolean(paths.historyFinal),
    candidateFinal: Boolean(paths.candidateFinal),
    trace: Boolean(paths.trace),
    replica: Boolean(paths.replica),
  };
}

export function listActions(ctx: ActionContext): readonly UiAction[] {
  const mode = ctx.mode ?? {};
  if (mode.helpOpen) {
    return [action('hide-help', 'hintEsc', ['escape'], 10)];
  }
  switch (ctx.page) {
    case 'running':
      return runningActions(mode);
    case 'result':
      return resultActions(mode, ctx.artifacts ?? {});
    case 'confirm':
      return confirmActions(mode);
    default:
      return [action('show-help', 'hintHelp', ['?'], 1)];
  }
}

function runningActions(mode: ActionMode): readonly UiAction[] {
  const cancelLabel: MessageKey = mode.preparing ? 'hintCancel' : 'hintStop';
  const cancel = action('cancel', cancelLabel, ['ctrl+c'], 40);
  const help = action('show-help', 'hintHelp', ['?'], 5);
  if (mode.reading) {
    return [
      action('leave-reading', 'hintLeaveReading', ['v', 'escape'], 30),
      cancel,
      help,
    ];
  }
  if (mode.finding) {
    return [
      action('next-hit', 'hintNextHit', ['enter'], 30),
      action('prev-hit', 'hintPrevHit', ['shift+enter'], 20),
      action('clear-find', 'hintClearFind', ['escape'], 25),
      cancel,
    ];
  }
  if (mode.preparing || mode.findAllowed === false) {
    return [
      cancel,
      help,
      action('running-escape', 'experimentActive', ['escape'], 0),
    ];
  }
  return [
    cancel,
    action('start-find', 'hintFind', ['/'], 25),
    action('follow', 'hintFollow', ['end'], 20),
    action('toggle-fold', 'hintExpand', ['enter'], 15),
    action('cycle-fold', 'hintCycleFold', ['tab'], 0),
    action('cycle-fold-prev', 'hintCycleFold', ['shift+tab'], 0),
    action('enter-reading', 'hintEnterReading', ['v'], 0),
    action('running-escape', 'experimentActive', ['escape'], 0),
    help,
  ];
}

function resultActions(mode: ActionMode, artifacts: ActionArtifacts): readonly UiAction[] {
  const actions: UiAction[] = [];
  if (mode.comparePending) {
    actions.push(action('compare', 'hintCompare', ['c', 'enter'], 50));
  }
  actions.push(artifactAction('open-report', 'hintReport', ['o'], artifacts.report, 'noReport'));
  actions.push(artifactAction('open-history-final', 'hintHistoryFinal', ['h'], artifacts.historyFinal, 'noHistoryFinal'));
  actions.push(artifactAction('open-candidate-final', 'hintCandidateFinal', ['f'], artifacts.candidateFinal, 'noCandidateFinal'));
  actions.push(artifactAction('open-trace', 'hintTrace', ['t'], artifacts.trace, 'noTrace'));
  actions.push(artifactAction('open-replica', 'hintReplica', ['w'], artifacts.replica, 'noReplica'));
  actions.push(action('home', 'hintHome', mode.comparePending ? ['escape', 'b'] : ['escape', 'b', 'enter'], 10));
  actions.push(action('show-help', 'hintHelp', ['?'], 1));
  return actions;
}

function confirmActions(mode: ActionMode): readonly UiAction[] {
  const canStart = mode.canStartConfirm !== false;
  const run = canStart
    ? action('confirm-run', 'hintStartCandidate', ['enter'], 40)
    : disabled('confirm-run', 'hintTryBlocked', ['enter'], 'recoveryFailed', 40);
  return [
    run,
    action('change-model', 'hintChangeModel', ['b'], 20),
    action('home', 'hintHome', ['escape'], 10),
    action('show-help', 'hintHelp', ['?'], 1),
  ];
}

function artifactAction(
  id: ActionId,
  labelKey: MessageKey,
  keys: readonly string[],
  available: boolean | undefined,
  missingKey: MessageKey,
): UiAction {
  if (available) return action(id, labelKey, keys, 20);
  return disabled(id, labelKey, keys, missingKey, 0);
}

function action(
  id: ActionId,
  labelKey: MessageKey,
  keys: readonly string[],
  footerPriority: number,
): UiAction {
  return { id, labelKey, keys, enabled: true, footerPriority };
}

function disabled(
  id: ActionId,
  labelKey: MessageKey,
  keys: readonly string[],
  disabledReasonKey: MessageKey,
  footerPriority: number,
): UiAction {
  return { id, labelKey, keys, enabled: false, disabledReasonKey, footerPriority };
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
    if (item.footerPriority === 0 && item.id === 'running-escape') continue;
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

export function actionById(actions: readonly UiAction[], id: ActionId): UiAction | undefined {
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
  let disabledHit: UiAction | undefined;
  for (const item of actions) {
    if (!item.keys.some((key) => keyMatches(data, key))) continue;
    if (item.enabled) return item;
    if (includeDisabled && !disabledHit) disabledHit = item;
  }
  return includeDisabled ? disabledHit : undefined;
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
  if (key.length === 1) return key;
  return key.replace(/^\w/, (ch) => ch.toUpperCase());
}

function padKey(keys: string): string {
  return keys.length >= 10 ? keys : `${keys}${' '.repeat(10 - keys.length)}`;
}
