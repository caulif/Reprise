import {
  HARNESS_CONFIG_FIELDS, apiKeyValidity, baseUrlValidity, configFieldValue, hasFileApiKey, maskSecret, shellEnvAssignment,
  type HarnessConfigDraft, type HarnessConfigField,
} from '../../infrastructure/harness-model-config.js';
import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { pad, panel } from '../widgets.js';
import { caretAt } from '../text-edit.js';

export const CONFIG_FIELDS = HARNESS_CONFIG_FIELDS;
export const LANGUAGE_FIELD_INDEX = CONFIG_FIELDS.length;
export type ConfigField = HarnessConfigField;

export type ConfigModel = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly editing: boolean;
  readonly buffer: string;
  readonly cursor?: number;
  readonly dirty: boolean;
  readonly saved: boolean;
  readonly envName?: string;
  readonly envSet?: boolean;
  readonly pendingToggle?: boolean;
  readonly locale?: Locale;
};

export function renderConfig(theme: Theme, width: number, model: ConfigModel): string[] {
  const locale = model.locale ?? 'en';
  const field = CONFIG_FIELDS[model.selected] ?? CONFIG_FIELDS[0];
  if (model.editing) {
    const reason = fieldReason(field, model.buffer, model.draft.kind);
    return panel(theme, t(locale, 'editingField', { field: fieldLabel(locale, field) }), [
      ` ${t(locale, 'currentValue')}  ${fieldValue(theme, field, configFieldValue(model.draft, field), model.draft.kind, locale)}`,
      '',
      ` ${theme.glyphs.cursor} ${caretAt(model.buffer, model.cursor ?? model.buffer.length)}`,
      ...(reason ? [` ${theme.style.warn(`${theme.glyphs.warn} ${reason}`)}`] : []),
      ` ${t(locale, 'neverPasteSecret')}`,
    ], width);
  }
  const values = CONFIG_FIELDS.flatMap((item, index) => {
    const marker = index === model.selected ? theme.glyphs.cursor : ' ';
    const hint = fieldHint(item, locale);
    const value = fieldValue(theme, item, configFieldValue(model.draft, item), model.draft.kind, locale);
    const reason = fieldReason(item, configFieldValue(model.draft, item), model.draft.kind);
    const line = ` ${marker} ${pad(fieldLabel(locale, item), 18, theme.glyphs.ellipsis)} ${value}${hint ? `  ${theme.style.muted(hint)}` : ''}`;
    const painted = index === model.selected ? theme.style.selected(line) : line;
    return reason ? [painted, `     ${theme.style.warn(`${theme.glyphs.warn} ${reason}`)}`] : [painted];
  });
  const languageMarker = model.selected === LANGUAGE_FIELD_INDEX ? theme.glyphs.cursor : ' ';
  const languageValue = t(locale, locale === 'zh' ? 'chinese' : 'english');
  const languageLine = ` ${languageMarker} ${pad(t(locale, 'languageField'), 18, theme.glyphs.ellipsis)} ${languageValue}  ${theme.style.muted(t(locale, 'langToggleHint'))}`;
  const paintedLanguage = model.selected === LANGUAGE_FIELD_INDEX ? theme.style.selected(languageLine) : languageLine;
  const dirty = model.dirty
    ? theme.style.warn(` ${theme.glyphs.dot} ${t(locale, 'unsavedDraft')}`)
    : theme.style.ok(` ${theme.glyphs.ok} ${t(locale, 'savedLocally')}`);
  const status = model.saved || model.dirty ? dirty : ` ${theme.glyphs.dot} ${t(locale, 'inMemoryDraft')}`;
  return panel(theme, theme.style.harness(t(locale, 'configTitle')), [
    ...connectionStatus(theme, model, locale),
    '',
    ...values,
    paintedLanguage,
    '',
    status,
    ` ${t(locale, 'configFile')}`,
    ...(model.pendingToggle ? [theme.style.warn(` ${theme.glyphs.warn} ${t(locale, 'confirmProviderSwitch')}`)] : []),
  ], width);
}

export function configHints(
  editing: boolean,
  field?: ConfigField,
  pendingToggle = false,
  languageSelected = false,
  locale: Locale = 'en',
): readonly (readonly [string, string])[] {
  if (editing) return [['Enter', t(locale, 'hintApply')], ['Ctrl+U', t(locale, 'hintClear')], ['Esc', t(locale, 'hintKeepPrev')]];
  if (pendingToggle) return [['Enter', t(locale, 'hintConfirmSwitch')], ['Esc', t(locale, 'hintCancelSwitch')]];
  const enter = languageSelected
    ? t(locale, 'hintToggleLang')
    : field === 'provider type' ? t(locale, 'hintToggleProvider') : field === 'effort' ? t(locale, 'hintCycleEffort') : t(locale, 'hintEdit');
  return [['↑↓', t(locale, 'hintSelect')], ['Enter', enter], ['t', t(locale, 'hintTest')], ['s', t(locale, 'hintSave')], ['Esc', t(locale, 'hintHome')]];
}

function connectionStatus(theme: Theme, model: ConfigModel, locale: Locale): readonly string[] {
  const endpoint = model.draft.kind === 'openai-compatible' ? (model.draft.baseUrl || t(locale, 'notSet')) : `Pi catalog ${model.draft.providerId}`;
  const fileKey = hasFileApiKey(model.draft);
  const secret = model.envName
    ? (model.envSet
      ? `env ${model.envName}   ${theme.style.ok(t(locale, 'setInShell'))}`
      : `env ${model.envName}   ${theme.style.warn(`${theme.glyphs.warn} ${t(locale, 'notSetInShell')}`)}`)
    : fileKey
      ? `${maskSecret(model.draft.keyRef)}   ${theme.style.ok(t(locale, 'savedInConfig'))}`
      : model.draft.kind === 'openai-compatible'
        ? theme.style.warn(`${theme.glyphs.warn} ${t(locale, 'envNameMissing')}`)
        : t(locale, 'piManagesCreds');
  const hint = model.envName && model.envSet === false
    ? ` ${shellEnvAssignment(model.envName)}   ${t(locale, 'neverPasteValue')}`
    : ` ${t(locale, 'keysStayInEnv')}`;
  return [
    ` ${t(locale, 'endpointLabel')}   ${endpoint}`,
    ` ${t(locale, 'modelLabel')}      ${model.draft.modelId} ${theme.glyphs.sep} ${model.draft.effort}`,
    ` ${t(locale, 'secretLabel')}     ${secret}`,
    hint,
  ];
}

function fieldLabel(locale: Locale, field: ConfigField): string {
  if (field === 'provider type') return t(locale, 'fieldProviderType');
  if (field === 'provider label') return t(locale, 'fieldProviderLabel');
  if (field === 'base URL') return t(locale, 'fieldBaseUrl');
  if (field === 'model') return t(locale, 'fieldModel');
  if (field === 'effort') return t(locale, 'fieldEffort');
  return t(locale, 'fieldKeyRef');
}

function fieldValue(theme: Theme, field: ConfigField, value: string, kind: HarnessConfigDraft['kind'], locale: Locale): string {
  if (field === 'API key') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = apiKeyValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return validity.display;
  }
  if (field === 'base URL') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = baseUrlValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return validity.display;
  }
  return value || t(locale, 'required');
}

function fieldReason(field: ConfigField, value: string, kind: HarnessConfigDraft['kind']): string | undefined {
  if (field === 'API key' && kind === 'openai-compatible') {
    const validity = apiKeyValidity(value);
    return validity.ok || !value ? undefined : validity.reason;
  }
  if (field === 'base URL' && kind === 'openai-compatible') {
    const validity = baseUrlValidity(value);
    return validity.ok || !value ? undefined : validity.reason;
  }
  return undefined;
}

function fieldHint(field: ConfigField, locale: Locale): string {
  if (field === 'provider type' || field === 'effort') return t(locale, 'langToggleHint');
  return '';
}
