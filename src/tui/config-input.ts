import { nextOption, unwrapBracketedPaste } from './format.js';
import { applyTextEdit } from './text-edit.js';
import type { HarnessConfigDraft, HarnessConfigField, HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { configFieldValue, configFieldsForKind, emptyHarnessConfigDraft, languageFieldIndex, setConfigField } from '../infrastructure/harness-model-config.js';
import type { Option } from './types.js';
import { matchesKey } from '@earendil-works/pi-tui';

export type ConfigInputState = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly editing: boolean;
  readonly buffer: string;
  readonly cursor?: number;
  readonly providers: readonly Option[];
  readonly models: readonly Option[];
  readonly pendingToggle?: boolean;
  readonly dirty?: boolean;
  readonly leaveConfirm?: boolean;
};
export type ConfigInputResult = {
  readonly state: ConfigInputState;
  readonly message?: string;
  readonly action?: 'save' | 'test' | 'home' | 'toggle-locale';
  readonly consume: true;
};

export function handleConfigInput(state: ConfigInputState, data: string, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }): ConfigInputResult | undefined {
  const input = unwrapBracketedPaste(data);
  const fields = configFieldsForKind(state.draft.kind);
  const languageIndex = languageFieldIndex(state.draft.kind);
  if (state.editing) return editConfigValue(state, input, fields);
  if (state.leaveConfirm) return handleLeaveConfirm(state, input);
  if (state.pendingToggle) {
    if (matchesKey(input, 'enter')) return applyProviderToggle(state, refreshModels);
    if (matchesKey(input, 'escape')) return { state: { ...state, pendingToggle: false }, message: 'Provider switch cancelled.', consume: true };
    return handleConfigInput({ ...state, pendingToggle: false }, input, refreshModels) ?? { state: { ...state, pendingToggle: false }, consume: true };
  }
  if (matchesKey(input, 'escape')) return leaveConfig(state);
  if (matchesKey(input, 'up') || matchesKey(input, 'down')) return { state: { ...state, selected: Math.max(0, Math.min(languageIndex, state.selected + (matchesKey(input, 'up') ? -1 : 1))) }, consume: true };
  if (matchesKey(input, 'ctrl+t')) return { state, action: 'test', consume: true };
  if (matchesKey(input, 'ctrl+s')) return { state: { ...state, leaveConfirm: false }, action: 'save', consume: true };
  if (!matchesKey(input, 'enter')) return undefined;
  if (state.selected === languageIndex) return { state, action: 'toggle-locale', consume: true };
  return beginConfigEdit(state, refreshModels, fields);
}

function leaveConfig(state: ConfigInputState): ConfigInputResult {
  if (state.dirty) {
    return {
      state: { ...state, leaveConfirm: true },
      message: 'Unsaved draft. Ctrl+S saves, Enter discards, Esc stays.',
      consume: true,
    };
  }
  return { state, action: 'home', consume: true };
}

function handleLeaveConfirm(state: ConfigInputState, input: string): ConfigInputResult {
  if (matchesKey(input, 'escape')) return { state: { ...state, leaveConfirm: false }, message: 'Still editing the in-memory draft.', consume: true };
  if (matchesKey(input, 'ctrl+s')) return { state: { ...state, leaveConfirm: false }, action: 'save', consume: true };
  if (matchesKey(input, 'enter')) return { state: { ...state, leaveConfirm: false }, action: 'home', consume: true };
  return { state, consume: true };
}

function beginConfigEdit(state: ConfigInputState, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }, fields: readonly HarnessConfigField[]): ConfigInputResult {
  const field = fields[state.selected] ?? 'provider type';
  if (field === 'provider type') {
    if (state.draft.baseUrl || state.draft.keyRef) {
      return { state: { ...state, pendingToggle: true }, message: 'Enter again to switch provider and clear URL and API key. Esc cancels.', consume: true };
    }
    return applyProviderToggle(state, refreshModels);
  }
  if (field === 'effort') {
    const efforts: readonly HarnessModelConfig['effort'][] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const effort = efforts[(efforts.indexOf(state.draft.effort) + 1) % efforts.length] ?? state.draft.effort;
    return { state: { ...state, draft: { ...state.draft, effort } }, message: 'Effort changed in the draft.', consume: true };
  }
  if (field === 'API') {
    const api = state.draft.api === 'openai-completions' ? 'openai-responses' : 'openai-completions';
    return { state: { ...state, draft: { ...state.draft, api } }, message: 'API changed in the draft.', consume: true };
  }
  if (field === 'reasoning') {
    return { state: { ...state, draft: { ...state.draft, reasoning: !state.draft.reasoning } }, message: 'Reasoning changed in the draft.', consume: true };
  }
  if (state.draft.kind === 'pi-catalog' && field === 'provider label') {
    const provider = nextOption(state.providers, state.draft.providerId);
    if (!provider) return { state, consume: true };
    const refreshed = refreshModels({ ...state.draft, providerId: provider.id, modelId: '' });
    return { state: { ...state, draft: refreshed.draft, models: refreshed.models }, message: 'Provider changed in the draft.', consume: true };
  }
  if (state.draft.kind === 'pi-catalog' && field === 'model') {
    const model = nextOption(state.models, state.draft.modelId);
    return model ? { state: { ...state, draft: { ...state.draft, modelId: model.id } }, message: 'Model changed in the draft.', consume: true } : { state, consume: true };
  }
  const current = configFieldValue(state.draft, field);
  return { state: { ...state, editing: true, buffer: current, cursor: current.length }, message: `Editing ${field}. Type to change the visible value. Enter applies it. Esc keeps the previous value.`, consume: true };
}

function applyProviderToggle(state: ConfigInputState, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }): ConfigInputResult {
  const draft = state.draft.kind === 'pi-catalog'
    ? { ...emptyHarnessConfigDraft(), effort: state.draft.effort }
    : { ...emptyHarnessConfigDraft(), kind: 'pi-catalog' as const, providerId: state.providers[0]?.id ?? 'openai-codex', effort: state.draft.effort };
  const refreshed = draft.kind === 'pi-catalog' ? refreshModels(draft) : { draft, models: state.models };
  const selected = Math.min(state.selected, languageFieldIndex(refreshed.draft.kind));
  return {
    state: { ...state, draft: refreshed.draft, models: refreshed.models, pendingToggle: false, selected },
    message: draft.kind === 'pi-catalog' ? 'Pi catalog selected. Sign in with pi /login, then test the connection.' : 'OpenAI-compatible selected. Enter its endpoint, model, and API key.',
    consume: true,
  };
}

function editConfigValue(state: ConfigInputState, data: string, fields: readonly HarnessConfigField[]): ConfigInputResult {
  if (matchesKey(data, 'escape')) return { state: { ...state, editing: false, buffer: '', cursor: 0 }, message: 'Field edit discarded. Configuration remains an in-memory draft.', consume: true };
  if (matchesKey(data, 'ctrl+a') || matchesKey(data, 'ctrl+u')) return { state: { ...state, buffer: '', cursor: 0 }, consume: true };
  if (matchesKey(data, 'enter')) {
    const field = fields[state.selected] ?? 'provider type';
    const next = state.buffer.trim();
    return { state: { ...state, draft: setConfigField(state.draft, field, next), editing: false, buffer: '', cursor: 0 }, message: 'Draft changed. Ctrl+S writes the local config file; Ctrl+T tests the connection.', consume: true };
  }
  const edited = applyTextEdit(state.buffer, state.cursor ?? state.buffer.length, data);
  return edited.handled ? { state: { ...state, buffer: edited.value, cursor: edited.cursor }, consume: true } : { state, consume: true };
}
