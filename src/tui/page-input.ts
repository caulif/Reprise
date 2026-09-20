import { matchesKey } from '@earendil-works/pi-tui';
import {
  type ActionArtifacts,
  type ActionId,
  type ActionMode,
  type UiAction,
  listActions,
  matchActionKey,
} from './action-model.js';
import { applyTextEdit } from './text-edit.js';
import { classifyHomeCommand, completeUniqueHomeCommand } from './home-command.js';
import { isTextInput, slashCommands, unwrapBracketedPaste } from './format.js';
import type { MessageKey } from './i18n.js';

export type Consume = { consume: true };

export type HomeComposerState = {
  readonly composer: string;
  readonly cursor: number;
  readonly showSuggestions: boolean;
};

export type HomeComposerResult = {
  readonly state: HomeComposerState;
  readonly action?: 'submit' | 'escape';
  readonly consume: true;
};

function matchingHomeCommands(composer: string): readonly string[] {
  const prefix = composer.trim().toLowerCase();
  if (!prefix || prefix === '/') return slashCommands();
  return slashCommands().filter((command) => command.startsWith(prefix));
}

export function dispatchHomeComposer(state: HomeComposerState, data: string): HomeComposerResult | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) {
    return { state: { composer: '', cursor: 0, showSuggestions: false }, action: 'escape', consume: true };
  }
  if (state.showSuggestions && (matchesKey(input, 'up') || matchesKey(input, 'down'))) {
    return cycleHomeSuggestion(state, matchesKey(input, 'up') ? -1 : 1);
  }
  if (matchesKey(input, 'tab')) {
    const matches = matchingHomeCommands(state.composer);
    const composer = matches.length === 1 ? matches[0] ?? state.composer : state.composer;
    return { state: { composer, cursor: composer.length, showSuggestions: true }, consume: true };
  }
  if (matchesKey(input, 'enter')) return { state, action: 'submit', consume: true };
  const edited = applyTextEdit(state.composer, state.cursor, input);
  if (!edited.handled) return undefined;
  return {
    state: { composer: edited.value, cursor: edited.cursor, showSuggestions: edited.value.startsWith('/') },
    consume: true,
  };
}

function cycleHomeSuggestion(state: HomeComposerState, delta: number): HomeComposerResult {
  const matches = matchingHomeCommands(state.composer.startsWith('/') ? state.composer : '/');
  if (!matches.length) return { state, consume: true };
  const current = matches.indexOf(state.composer.toLowerCase());
  const index = current < 0 ? (delta > 0 ? 0 : matches.length - 1) : (current + delta + matches.length) % matches.length;
  const composer = matches[index] ?? state.composer;
  return { state: { composer, cursor: composer.length, showSuggestions: true }, consume: true };
}

export function submittedHomeCommand(composer: string): ReturnType<typeof classifyHomeCommand> {
  return classifyHomeCommand(completeUniqueHomeCommand(composer).trim().toLowerCase());
}

export type SourceFieldState = { readonly value: string; readonly cursor: number };
export type SourceFieldResult = {
  readonly state: SourceFieldState;
  readonly action?: 'home' | 'submit';
  readonly consume: true;
};

export function dispatchSourceField(state: SourceFieldState, data: string): SourceFieldResult | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { state, action: 'home', consume: true };
  if (matchesKey(input, 'enter')) return { state, action: 'submit', consume: true };
  const edited = applyTextEdit(state.value, state.cursor, input);
  if (!edited.handled) return undefined;
  return { state: { value: edited.value, cursor: edited.cursor }, consume: true };
}

export type SearchFieldState = { readonly query: string; readonly cursor: number; readonly searching: boolean };
export type SearchFieldResult = {
  readonly state: SearchFieldState;
  readonly action?: 'escape' | 'up' | 'down' | 'enter' | 'start-search';
  readonly consume: true;
};

export function dispatchSearchField(state: SearchFieldState, data: string): SearchFieldResult | undefined {
  const input = unwrapBracketedPaste(data);
  if (state.searching) {
    if (matchesKey(input, 'escape')) return { state: { query: '', cursor: 0, searching: false }, action: 'escape', consume: true };
    if (matchesKey(input, 'up')) return { state, action: 'up', consume: true };
    if (matchesKey(input, 'down')) return { state, action: 'down', consume: true };
    if (matchesKey(input, 'enter')) return { state, action: 'enter', consume: true };
    const edited = applyTextEdit(state.query, state.cursor, input);
    if (!edited.handled) return { state, consume: true };
    return { state: { query: edited.value, cursor: edited.cursor, searching: true }, consume: true };
  }
  if (matchesKey(input, '/') || matchesKey(input, 'ctrl+/')) {
    return { state: { ...state, searching: true, cursor: state.query.length }, action: 'start-search', consume: true };
  }
  return undefined;
}

export type GlobalInputContext = {
  readonly page: string;
  readonly editingText: boolean;
  readonly helpOpen: boolean;
  readonly startupActive?: boolean;
};

export type GlobalInputAction = 'cancel' | 'close' | 'hide-help' | 'show-help';

export function dispatchGlobalInput(ctx: GlobalInputContext, data: string): { action: GlobalInputAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'ctrl+c')) {
    return { action: ctx.page === 'running' || ctx.startupActive ? 'cancel' : 'close', consume: true };
  }
  if (ctx.helpOpen) {
    const matched = matchActionKey(listActions({ page: ctx.page, locale: 'en', mode: { helpOpen: true } }), input);
    if (matched?.id === 'hide-help') return { action: 'hide-help', consume: true };
  }
  if (ctx.editingText) return undefined;
  const migrated = ctx.page === 'running' || ctx.page === 'result' || ctx.page === 'confirm';
  if (migrated) {
    const matched = matchActionKey(listActions({ page: ctx.page, locale: 'en' }), input);
    if (matched?.id === 'show-help') return { action: 'show-help', consume: true };
    if (matched?.id === 'cancel') return { action: 'cancel', consume: true };
    return undefined;
  }
  if (matchesKey(input, '?')) return { action: 'show-help', consume: true };
  return undefined;
}

export type SessionsInputState = SearchFieldState & { readonly canLeaveProject: boolean };
export type SessionsAction =
  | 'escape-search'
  | 'up'
  | 'down'
  | 'enter'
  | 'start-search'
  | 'leave-project'
  | 'home'
  | 'toggle-filter'
  | 'more'
  | 'refresh'
  | 'edit-search'
  | 'consume';

export function dispatchSessionsInput(state: SessionsInputState, data: string): { state: SearchFieldState; action: SessionsAction; consume: true } | undefined {
  const pointer = dispatchListPointer(data);
  if (pointer?.action === 'up') return { state, action: 'up', consume: true };
  if (pointer?.action === 'down') return { state, action: 'down', consume: true };
  if (pointer) return { state, action: 'consume', consume: true };
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'ctrl+f')) return { state, action: 'toggle-filter', consume: true };
  if (matchesKey(input, 'ctrl+n')) return { state, action: 'more', consume: true };
  if (matchesKey(input, 'ctrl+r')) return { state, action: 'refresh', consume: true };
  const search = dispatchSearchField(state, input);
  if (search) {
    const action: SessionsAction = search.action === 'escape' ? 'escape-search'
      : search.action === 'up' ? 'up'
      : search.action === 'down' ? 'down'
      : search.action === 'enter' ? 'enter'
      : search.action === 'start-search' ? 'start-search'
      : search.state.query !== state.query || search.state.cursor !== state.cursor ? 'edit-search'
      : 'consume';
    return { state: search.state, action, consume: true };
  }
  if (!state.searching && isTextInput(input)) {
    const edited = applyTextEdit(state.query, state.cursor, input);
    return { state: { query: edited.value, cursor: edited.cursor, searching: true }, action: 'edit-search', consume: true };
  }
  if (matchesKey(input, 'escape')) return { state, action: state.canLeaveProject ? 'leave-project' : 'home', consume: true };
  if (matchesKey(input, 'backspace') && state.canLeaveProject) return { state, action: 'leave-project', consume: true };
  if (matchesKey(input, 'up')) return { state, action: 'up', consume: true };
  if (matchesKey(input, 'down')) return { state, action: 'down', consume: true };
  if (matchesKey(input, 'enter')) return { state, action: 'enter', consume: true };
  return undefined;
}

export type InspectionAction = 'toggle-outcome' | 'back-sessions' | 'freeze';

export function dispatchInspectionInput(data: string, hasInspection: boolean): { action: InspectionAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'd')) return { action: 'toggle-outcome', consume: true };
  if (matchesKey(input, 'escape')) return { action: 'back-sessions', consume: true };
  if (matchesKey(input, 'enter') && hasInspection) return { action: 'freeze', consume: true };
  return undefined;
}

export type PreflightAction = 'home';

/** Recovery starts automatically after preflight; this transient page only allows navigation away. */
export function dispatchPreflightInput(data: string): { action: PreflightAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape') || matchesKey(input, 'b')) return { action: 'home', consume: true };
  return undefined;
}

export type ConfirmAction = 'home' | 'models' | 'run';

export type ConfirmKeyContext = {
  readonly canStart?: boolean;
};

export function dispatchConfirmInput(
  data: string,
  ctx: ConfirmKeyContext = {},
): { action: ConfirmAction; consume: true; enabled?: boolean; disabledReasonKey?: MessageKey } | undefined {
  const actions = listActions({
    page: 'confirm',
    locale: 'en',
    mode: { canStartConfirm: ctx.canStart !== false },
  });
  const matched = matchActionKey(actions, unwrapBracketedPaste(data), { includeDisabled: true });
  if (!matched) return undefined;
  if (matched.id === 'show-help') return undefined;
  if (matched.id === 'confirm-run') {
    return {
      action: 'run',
      consume: true,
      enabled: matched.enabled,
      ...(matched.disabledReasonKey ? { disabledReasonKey: matched.disabledReasonKey } : {}),
    };
  }
  if (matched.id === 'change-model') return { action: 'models', consume: true, enabled: true };
  if (matched.id === 'home') return { action: 'home', consume: true, enabled: true };
  return undefined;
}

export type CandidatePickerAction = 'home' | 'up' | 'down' | 'enter' | 'back' | 'consume';

export function dispatchListPointer(data: string): { action: 'up' | 'down' | 'click' | 'ignore'; row?: number; col?: number; consume: true } | undefined {
  const mouse = parseSgrMouse(unwrapBracketedPaste(data));
  if (!mouse) return undefined;
  if (mouse.button === 64) return { action: 'up', consume: true };
  if (mouse.button === 65) return { action: 'down', consume: true };
  if (mouse.button === 0 && !mouse.release) return { action: 'click', row: mouse.row, col: mouse.col, consume: true };
  return { action: 'ignore', consume: true };
}

export function dispatchCandidatePickerInput(data: string): { action: CandidatePickerAction; consume: true } | undefined {
  const pointer = dispatchListPointer(data);
  if (pointer?.action === 'up' || pointer?.action === 'down') return { action: pointer.action, consume: true };
  if (pointer) return { action: 'consume', consume: true };
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { action: 'home', consume: true };
  if (matchesKey(input, 'b')) return { action: 'back', consume: true };
  if (matchesKey(input, 'up')) return { action: 'up', consume: true };
  if (matchesKey(input, 'down')) return { action: 'down', consume: true };
  if (matchesKey(input, 'enter')) return { action: 'enter', consume: true };
  return undefined;
}

export type HistoryDetailKind = 'none' | 'case' | 'experiment';
export type HistoryDetailAction = 'back' | 'open-report' | 'open-local' | 'use-case';

export function dispatchHistoryDetailInput(data: string, kind: HistoryDetailKind): { action: HistoryDetailAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { action: 'back', consume: true };
  if (matchesKey(input, 'o') && kind === 'experiment') return { action: 'open-report', consume: true };
  if (matchesKey(input, 't') && kind !== 'none') return { action: 'open-local', consume: true };
  if (matchesKey(input, 'enter') && kind === 'case') return { action: 'use-case', consume: true };
  return undefined;
}

export type CanvasFindState = { readonly finding: boolean; readonly query: string; readonly cursor: number };
export type CanvasAction =
  | 'clear-find'
  | 'move'
  | 'next-hit'
  | 'prev-hit'
  | 'edit-find'
  | 'start-find'
  | 'follow'
  | 'home'
  | 'click'
  | 'consume';

export type SgrMouse = {
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly release: boolean;
};

/** SGR mouse: `\x1b[<btn;col;rowM` (press) / `m` (release). Wheel is 64/65. */
export function parseSgrMouse(data: string): SgrMouse | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return undefined;
  return {
    button: Number(match[1]),
    col: Number(match[2]),
    row: Number(match[3]),
    release: match[4] === 'm',
  };
}

export function dispatchCanvasInput(
  state: CanvasFindState,
  data: string,
  blocked: boolean,
): { state: CanvasFindState; action: CanvasAction; amount?: number; row?: number; col?: number; consume: true } | undefined {
  if (blocked) return undefined;
  const input = unwrapBracketedPaste(data);
  const mouse = parseSgrMouse(input);
  if (mouse && !state.finding) {
    if (mouse.button === 64) return { state, action: 'move', amount: -1, consume: true };
    if (mouse.button === 65) return { state, action: 'move', amount: 1, consume: true };
    if (mouse.button === 0 && !mouse.release) {
      return { state, action: 'click', row: mouse.row, col: mouse.col, consume: true };
    }
    return { state, action: 'consume', consume: true };
  }
  if (state.finding) {
    if (matchesKey(input, 'escape')) return { state, action: 'clear-find', consume: true };
    if (matchesKey(input, 'up')) return { state, action: 'move', amount: -1, consume: true };
    if (matchesKey(input, 'down')) return { state, action: 'move', amount: 1, consume: true };
    if (matchesKey(input, 'pageUp')) return { state, action: 'move', amount: -10, consume: true };
    if (matchesKey(input, 'pageDown')) return { state, action: 'move', amount: 10, consume: true };
    if (matchesKey(input, 'shift+enter')) return { state, action: 'prev-hit', consume: true };
    if (matchesKey(input, 'enter')) return { state, action: 'next-hit', consume: true };
    const edited = applyTextEdit(state.query, state.cursor, input);
    if (!edited.handled) return { state, action: 'consume', consume: true };
    return { state: { finding: true, query: edited.value, cursor: edited.cursor }, action: 'edit-find', consume: true };
  }
  if (matchesKey(input, '/') || matchesKey(input, 'ctrl+/')) {
    return { state: { ...state, finding: true, cursor: state.query.length }, action: 'start-find', consume: true };
  }
  if (matchesKey(input, 'up')) return { state, action: 'move', amount: -1, consume: true };
  if (matchesKey(input, 'down')) return { state, action: 'move', amount: 1, consume: true };
  if (matchesKey(input, 'pageUp')) return { state, action: 'move', amount: -10, consume: true };
  if (matchesKey(input, 'pageDown')) return { state, action: 'move', amount: 10, consume: true };
  if (matchesKey(input, 'home')) return { state, action: 'home', consume: true };
  if (matchesKey(input, 'end') || matchesKey(input, 'l')) return { state, action: 'follow', consume: true };
  return undefined;
}

export type RunningAction = 'toggle-fold' | 'cycle-fold' | 'cycle-fold-prev' | 'active-message' | 'enter-reading' | 'leave-reading';

export type RunningKeyContext = {
  readonly preparing?: boolean;
  readonly finding?: boolean;
  readonly reading?: boolean;
  readonly findAllowed?: boolean;
};

const RUNNING_ID_TO_ACTION: Partial<Record<ActionId, RunningAction>> = {
  'toggle-fold': 'toggle-fold',
  'cycle-fold': 'cycle-fold',
  'cycle-fold-prev': 'cycle-fold-prev',
  'running-escape': 'active-message',
  'enter-reading': 'enter-reading',
  'leave-reading': 'leave-reading',
};

export function dispatchRunningKeys(
  data: string,
  ctx: RunningKeyContext = {},
): { action: RunningAction; consume: true } | undefined {
  const mode: ActionMode = {
    ...(ctx.preparing !== undefined ? { preparing: ctx.preparing } : {}),
    ...(ctx.finding !== undefined ? { finding: ctx.finding } : {}),
    ...(ctx.reading !== undefined ? { reading: ctx.reading } : {}),
    ...(ctx.findAllowed !== undefined ? { findAllowed: ctx.findAllowed } : {}),
  };
  const matched = matchActionKey(listActions({ page: 'running', locale: 'en', mode }), unwrapBracketedPaste(data));
  if (!matched) return undefined;
  const mapped = RUNNING_ID_TO_ACTION[matched.id];
  if (!mapped) return undefined;
  return { action: mapped, consume: true };
}

export type ResultAction = 'open-report' | 'open-trace' | 'open-replica' | 'open-history-final' | 'open-candidate-final' | 'compare' | 'home';

export type ResultKeyContext = {
  readonly comparePending?: boolean;
  readonly artifacts?: ActionArtifacts;
};

export type MatchedKeyResult<T extends string> = {
  readonly action: T;
  readonly consume: true;
  readonly enabled: boolean;
  readonly disabledReasonKey?: MessageKey;
  readonly matched: UiAction;
};

export function dispatchResultKeys(
  data: string,
  ctx: ResultKeyContext = {},
): MatchedKeyResult<ResultAction> | undefined {
  const actions = listActions({
    page: 'result',
    locale: 'en',
    mode: {
      ...(ctx.comparePending !== undefined ? { comparePending: ctx.comparePending } : {}),
    },
    ...(ctx.artifacts !== undefined ? { artifacts: ctx.artifacts } : {}),
  });
  const matched = matchActionKey(actions, unwrapBracketedPaste(data), { includeDisabled: true });
  if (!matched) return undefined;
  if (matched.id === 'show-help') return undefined;
  if (
    matched.id !== 'compare'
    && matched.id !== 'home'
    && matched.id !== 'open-report'
    && matched.id !== 'open-history-final'
    && matched.id !== 'open-candidate-final'
    && matched.id !== 'open-trace'
    && matched.id !== 'open-replica'
  ) {
    return undefined;
  }
  return {
    action: matched.id,
    consume: true,
    enabled: matched.enabled,
    ...(matched.disabledReasonKey ? { disabledReasonKey: matched.disabledReasonKey } : {}),
    matched,
  };
}

export function dispatchErrorKeys(data: string): { action: 'return'; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'enter') || matchesKey(input, 'b') || matchesKey(input, 'escape')) {
    return { action: 'return', consume: true };
  }
  return undefined;
}

export function historyDetailKind(detail: object | undefined): HistoryDetailKind {
  if (!detail) return 'none';
  return 'taskCase' in detail ? 'case' : 'experiment';
}
