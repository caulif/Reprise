import { nextOption, unwrapBracketedPaste } from './format.js';
import { applyTextEdit } from './text-edit.js';
import type { HarnessConfigDraft, HarnessConfigField, HarnessModelConfig } from '../infrastructure/harness-model-config.js';
import { configFieldValue, configFieldsForKind, emptyHarnessConfigDraft, setConfigField } from '../infrastructure/harness-model-config.js';
import { t, type Locale } from './i18n.js';
import type { Option } from './types.js';
import { matchesKey } from '@earendil-works/pi-tui';
import { parseSgrMouse } from './page-input.js';

export type ConfigInputState = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly advanced?: boolean;
  readonly editing: boolean;
  readonly buffer: string;
  readonly cursor?: number;
  readonly providers: readonly Option[];
  readonly models: readonly Option[];
  readonly pendingToggle?: boolean;
  readonly dirty?: boolean;
  readonly leaveConfirm?: boolean;
  /** True while save or connection test is in flight; Ctrl+T/S must not start another. */
  readonly busy?: boolean;
  readonly locale?: Locale;
};

export type VisibleConfigItem = HarnessConfigField | 'more' | 'language';
export function visibleConfigItems(kind: HarnessConfigDraft['kind'], advanced = false): readonly VisibleConfigItem[] {
  const fields = configFieldsForKind(kind);
  const lowFrequency = new Set<HarnessConfigField>(['effort', 'reasoning', 'image input']);
  return [...(advanced ? fields : fields.filter((field) => !lowFrequency.has(field))), 'more', 'language'];
}
export type ConfigInputResult = {
  readonly state: ConfigInputState;
  readonly message?: string;
  readonly action?: 'save' | 'test' | 'home' | 'toggle-locale';
  readonly consume: true;
};

function busyMessage(locale: Locale | undefined): string {
  return t(locale ?? 'en', 'configTestBusy');
}

export function handleConfigInput(state: ConfigInputState, data: string, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }): ConfigInputResult | undefined {
  const input = unwrapBracketedPaste(data);
  const fields = visibleConfigItems(state.draft.kind, state.advanced);
  const languageIndex = fields.length - 1;
  const mouse = parseSgrMouse(input);
  if (state.editing) {
    if (mouse) return { state, consume: true };
    return editConfigValue(state, input, fields);
  }
  if (state.leaveConfirm) return handleLeaveConfirm(state, input);
  if (state.pendingToggle) {
    if (matchesKey(input, 'enter')) return applyProviderToggle(state, refreshModels);
    if (matchesKey(input, 'escape')) return { state: { ...state, pendingToggle: false }, message: 'Provider switch cancelled.', consume: true };
    return handleConfigInput({ ...state, pendingToggle: false }, input, refreshModels) ?? { state: { ...state, pendingToggle: false }, consume: true };
  }
  if (matchesKey(input, 'escape')) return leaveConfig(state);
  const wheel = mouse?.button === 64 ? -1 : mouse?.button === 65 ? 1 : 0;
  if (matchesKey(input, 'up') || matchesKey(input, 'down') || wheel !== 0) {
    const delta = matchesKey(input, 'up') || wheel < 0 ? -1 : 1;
    return { state: { ...state, selected: Math.max(0, Math.min(languageIndex, state.selected + delta)) }, consume: true };
  }
  if (mouse) return { state, consume: true };
  if (matchesKey(input, 'ctrl+t')) {
    if (state.busy) return { state, message: busyMessage(state.locale), consume: true };
    return { state, action: 'test', consume: true };
  }
  if (matchesKey(input, 'ctrl+s')) {
    if (state.busy) return { state, message: busyMessage(state.locale), consume: true };
    return { state: { ...state, leaveConfirm: false }, action: 'save', consume: true };
  }
  if (!matchesKey(input, 'enter')) return undefined;
  if (fields[state.selected] === 'language') return { state, action: 'toggle-locale', consume: true };
  if (fields[state.selected] === 'more') {
    const advanced = !state.advanced;
    const next = visibleConfigItems(state.draft.kind, advanced);
    return { state: { ...state, advanced, selected: next.indexOf('more') }, consume: true };
  }
  return beginConfigEdit(state, refreshModels, fields);
}

function leaveConfig(state: ConfigInputState): ConfigInputResult {
  if (state.dirty) {
    return {
      state: { ...state, leaveConfirm: true },
      message: t(state.locale ?? 'en', 'unsavedLeave'),
      consume: true,
    };
  }
  return { state, action: 'home', consume: true };
}

function handleLeaveConfirm(state: ConfigInputState, input: string): ConfigInputResult {
  if (matchesKey(input, 'escape') || matchesKey(input, 'enter')) return { state: { ...state, leaveConfirm: false }, consume: true };
  if (matchesKey(input, 'ctrl+s')) {
    if (state.busy) return { state, message: busyMessage(state.locale), consume: true };
    return { state: { ...state, leaveConfirm: false }, action: 'save', consume: true };
  }
  if (matchesKey(input, 'd')) return { state: { ...state, leaveConfirm: false }, action: 'home', consume: true };
  return { state, consume: true };
}

function beginConfigEdit(state: ConfigInputState, refreshModels: (draft: HarnessConfigDraft) => { draft: HarnessConfigDraft; models: readonly Option[] }, fields: readonly VisibleConfigItem[]): ConfigInputResult {
  const selected = fields[state.selected];
  const field: HarnessConfigField = selected === 'more' || selected === 'language' || !selected ? 'provider type' : selected;
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
  if (field === 'image input') {
    return { state: { ...state, draft: { ...state.draft, supportsImage: !state.draft.supportsImage } }, message: 'Image input changed in the draft.', consume: true };
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
  const selected = Math.max(0, visibleConfigItems(refreshed.draft.kind, state.advanced).indexOf('provider type'));
  return {
    state: { ...state, draft: refreshed.draft, models: refreshed.models, pendingToggle: false, selected },
    message: draft.kind === 'pi-catalog' ? 'Pi catalog selected. Sign in with pi /login, then test the connection.' : 'OpenAI-compatible selected. Enter its endpoint, model, and API key.',
    consume: true,
  };
}

function editConfigValue(state: ConfigInputState, data: string, fields: readonly VisibleConfigItem[]): ConfigInputResult {
  if (matchesKey(data, 'escape')) return { state: { ...state, editing: false, buffer: '', cursor: 0 }, message: 'Field edit discarded. Configuration remains an in-memory draft.', consume: true };
  if (matchesKey(data, 'ctrl+a') || matchesKey(data, 'ctrl+u')) return { state: { ...state, buffer: '', cursor: 0 }, consume: true };
  if (matchesKey(data, 'enter')) {
    const selected = fields[state.selected];
    const field: HarnessConfigField = selected === 'more' || selected === 'language' || !selected ? 'provider type' : selected;
    const next = state.buffer.trim();
    return { state: { ...state, draft: setConfigField(state.draft, field, next), editing: false, buffer: '', cursor: 0 }, message: t(state.locale ?? 'en', 'configDraftChanged'), consume: true };
  }
  const edited = applyTextEdit(state.buffer, state.cursor ?? state.buffer.length, data);
  return edited.handled ? { state: { ...state, buffer: edited.value, cursor: edited.cursor }, consume: true } : { state, consume: true };
}
