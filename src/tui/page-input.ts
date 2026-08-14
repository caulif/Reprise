import { matchesKey } from '@earendil-works/pi-tui';
import { applyTextEdit } from './text-edit.js';
import { classifyHomeCommand, completeUniqueHomeCommand } from './home-command.js';
import { slashCommands, unwrapBracketedPaste } from './format.js';

export type Consume = { consume: true };

export type HomeComposerState = {
  readonly composer: string;
  readonly cursor: number;
  readonly showSuggestions: boolean;
};

export type HomeComposerResult = {
  readonly state: HomeComposerState;
  readonly action?: 'submit' | 'start-run' | 'start-intake' | 'open-config' | 'escape';
  readonly consume: true;
};

export function dispatchHomeComposer(state: HomeComposerState, data: string): HomeComposerResult | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) {
    return { state: { composer: '', cursor: 0, showSuggestions: false }, action: 'escape', consume: true };
  }
  if (matchesKey(input, 'tab')) {
    const matches = slashCommands().filter((command) => command.startsWith(state.composer.toLowerCase()));
    const composer = matches.length === 1 ? matches[0] ?? state.composer : state.composer;
    return { state: { composer, cursor: composer.length, showSuggestions: true }, consume: true };
  }
  if (matchesKey(input, 'enter')) return { state, action: 'submit', consume: true };
  if (!state.composer && (input === 'r' || input === 'i' || input === 'c')) {
    return {
      state,
      action: input === 'r' ? 'start-run' : input === 'i' ? 'start-intake' : 'open-config',
      consume: true,
    };
  }
  const edited = applyTextEdit(state.composer, state.cursor, input);
  if (!edited.handled) return undefined;
  return {
    state: { composer: edited.value, cursor: edited.cursor, showSuggestions: edited.value.startsWith('/') },
    consume: true,
  };
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
  readonly viewer: boolean;
  readonly actorsOpen: boolean;
  readonly helpOpen: boolean;
};

export type GlobalInputAction = 'cancel' | 'close' | 'close-viewer' | 'close-actors' | 'hide-help' | 'show-help';

export function dispatchGlobalInput(ctx: GlobalInputContext, data: string): { action: GlobalInputAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'ctrl+c')) return { action: ctx.page === 'running' ? 'cancel' : 'close', consume: true };
  if (ctx.viewer && matchesKey(input, 'escape')) return { action: 'close-viewer', consume: true };
  if (ctx.actorsOpen && matchesKey(input, 'escape')) return { action: 'close-actors', consume: true };
  if (ctx.helpOpen && matchesKey(input, 'escape')) return { action: 'hide-help', consume: true };
  if (!ctx.editingText && matchesKey(input, '?')) return { action: 'show-help', consume: true };
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
  | 'edit-search'
  | 'consume';

export function dispatchSessionsInput(state: SessionsInputState, data: string): { state: SearchFieldState; action: SessionsAction; consume: true } | undefined {
  const search = dispatchSearchField(state, data);
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
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { state, action: state.canLeaveProject ? 'leave-project' : 'home', consume: true };
  if (matchesKey(input, 'backspace') && state.canLeaveProject) return { state, action: 'leave-project', consume: true };
  if (matchesKey(input, 'up')) return { state, action: 'up', consume: true };
  if (matchesKey(input, 'down')) return { state, action: 'down', consume: true };
  if (matchesKey(input, 'f')) return { state, action: 'toggle-filter', consume: true };
  if (matchesKey(input, 'enter')) return { state, action: 'enter', consume: true };
  return undefined;
}

export type InspectionAction = 'toggle-model-text' | 'toggle-outcome' | 'back-sessions' | 'freeze';

export function dispatchInspectionInput(data: string, hasInspection: boolean): { action: InspectionAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 't')) return { action: 'toggle-model-text', consume: true };
  if (matchesKey(input, 'd')) return { action: 'toggle-outcome', consume: true };
  if (matchesKey(input, 'escape')) return { action: 'back-sessions', consume: true };
  if (matchesKey(input, 'enter') && hasInspection) return { action: 'freeze', consume: true };
  return undefined;
}

export type PreflightAction = 'home' | 'source' | 'recovery' | 'confirm';

export function dispatchPreflightInput(data: string, hasContamination: boolean): { action: PreflightAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { action: 'home', consume: true };
  if (matchesKey(input, 'b')) return { action: 'source', consume: true };
  if (matchesKey(input, '2') && hasContamination) return { action: 'recovery', consume: true };
  if (matchesKey(input, '1') || matchesKey(input, 'enter')) return { action: 'confirm', consume: true };
  return undefined;
}

export type ConfirmAction = 'home' | 'preflight' | 'run';

export function dispatchConfirmInput(data: string): { action: ConfirmAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'escape')) return { action: 'home', consume: true };
  if (matchesKey(input, 'b')) return { action: 'preflight', consume: true };
  if (matchesKey(input, 'enter')) return { action: 'run', consume: true };
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
export type CanvasAction = 'clear-find' | 'move' | 'toggle-detail' | 'edit-find' | 'start-find' | 'follow' | 'cycle-filter' | 'consume';

export function dispatchCanvasInput(
  state: CanvasFindState,
  data: string,
  blocked: boolean,
): { state: CanvasFindState; action: CanvasAction; amount?: number; consume: true } | undefined {
  if (blocked) return undefined;
  const input = unwrapBracketedPaste(data);
  if (state.finding) {
    if (matchesKey(input, 'escape')) return { state, action: 'clear-find', consume: true };
    if (matchesKey(input, 'up')) return { state, action: 'move', amount: -1, consume: true };
    if (matchesKey(input, 'down')) return { state, action: 'move', amount: 1, consume: true };
    if (matchesKey(input, 'pageUp')) return { state, action: 'move', amount: -10, consume: true };
    if (matchesKey(input, 'pageDown')) return { state, action: 'move', amount: 10, consume: true };
    if (matchesKey(input, 'enter')) return { state, action: 'toggle-detail', consume: true };
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
  if (matchesKey(input, 'end') || matchesKey(input, 'l')) return { state, action: 'follow', consume: true };
  if (matchesKey(input, 'f')) return { state, action: 'cycle-filter', consume: true };
  return undefined;
}

export type RunningAction = 'toggle-detail' | 'toggle-actors' | 'open-detail' | 'active-message';

export function dispatchRunningKeys(data: string): { action: RunningAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'd') || matchesKey(input, 'enter')) return { action: 'toggle-detail', consume: true };
  if (matchesKey(input, 'ctrl+g')) return { action: 'toggle-actors', consume: true };
  if (matchesKey(input, 'o')) return { action: 'open-detail', consume: true };
  if (matchesKey(input, 'escape')) return { action: 'active-message', consume: true };
  return undefined;
}

export type ResultAction = 'open-report' | 'open-trace' | 'home';

export function dispatchResultKeys(data: string): { action: ResultAction; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'o')) return { action: 'open-report', consume: true };
  if (matchesKey(input, 't')) return { action: 'open-trace', consume: true };
  if (matchesKey(input, 'enter') || matchesKey(input, 'b')) return { action: 'home', consume: true };
  return undefined;
}

export function dispatchErrorKeys(data: string): { action: 'return'; consume: true } | undefined {
  const input = unwrapBracketedPaste(data);
  if (matchesKey(input, 'enter') || matchesKey(input, 'b')) return { action: 'return', consume: true };
  return undefined;
}

export function historyDetailKind(detail: object | undefined): HistoryDetailKind {
  if (!detail) return 'none';
  return 'taskCase' in detail ? 'case' : 'experiment';
}
