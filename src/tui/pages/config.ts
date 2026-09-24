import {
  apiKeyValidity, baseUrlValidity, configFieldValue, hasFileApiKey,
  type HarnessConfigDraft, type HarnessConfigField,
} from '../../infrastructure/harness-model-config.js';
import { t, type Locale } from '../i18n.js';
import { visibleConfigItems } from '../config-input.js';
import type { Theme } from '../theme.js';
import { pad, panel } from '../widgets.js';
import { caretAt } from '../text-edit.js';

export type ConfigField = HarnessConfigField;

export type ConfigConnectionTestStatus = 'idle' | 'testing' | 'passed' | 'failed' | 'stale';
export type ConfigBusy = 'idle' | 'save' | 'test';

export type ConfigModel = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly advanced?: boolean;
  readonly editing: boolean;
  readonly buffer: string;
  readonly cursor?: number;
  readonly dirty: boolean;
  readonly saved: boolean;
  readonly envName?: string;
  readonly envSet?: boolean;
  readonly pendingToggle?: boolean;
  readonly leaveConfirm?: boolean;
  readonly locale?: Locale;
  /** True while save or connection test is in flight (hints / input gate). */
  readonly busy?: boolean;
  /** Save-only progress chrome — test progress uses connectionTest.status. */
  readonly busyKind?: 'save';
  readonly connectionTest?: {
    readonly status: ConfigConnectionTestStatus;
    readonly detail?: string;
  };
};

export function renderConfig(theme: Theme, width: number, model: ConfigModel): string[] {
  const locale = model.locale ?? 'en';
  const fields = visibleConfigItems(model.draft.kind, model.advanced);
  const languageIndex = fields.indexOf('language');
  const values = fields.flatMap((item, index) => {
    if (item === 'language') return [];
    const marker = index === model.selected ? theme.glyphs.cursor : ' ';
    if (item === 'more') {
      const line = ` ${marker} ${t(locale, model.advanced ? 'configLessSettings' : 'configMoreSettings')}`;
      return [index === model.selected ? theme.style.selected(line) : line];
    }
    const hint = fieldHint(item, locale);
    const value = fieldValue(theme, item, configFieldValue(model.draft, item), model.draft.kind, locale);
    const reason = fieldReason(item, configFieldValue(model.draft, item), model.draft.kind, locale);
    const line = ` ${marker} ${pad(fieldLabel(locale, item), 18, theme.glyphs.ellipsis)} ${value}${hint ? `  ${theme.style.muted(hint)}` : ''}`;
    const painted = index === model.selected ? theme.style.selected(line) : line;
    const editing = model.editing && index === model.selected;
    const editor = editing
      ? [`     ${item === 'API key' ? `${'*'.repeat(model.buffer.length)}▌` : caretAt(model.buffer, model.cursor ?? model.buffer.length)}`,
        ...(item === 'API key' ? [`     ${t(locale, 'neverPasteSecret')}`] : []),
        ...(fieldReason(item, model.buffer, model.draft.kind, locale) ? [`     ${theme.style.warn(`${theme.glyphs.warn} ${fieldReason(item, model.buffer, model.draft.kind, locale)}`)}`] : [])]
      : [];
    return [...(reason ? [painted, `     ${theme.style.warn(`${theme.glyphs.warn} ${reason}`)}`] : [painted]), ...editor];
  });
  const languageMarker = model.selected === languageIndex ? theme.glyphs.cursor : ' ';
  const languageValue = t(locale, locale === 'zh' ? 'chinese' : 'english');
  const languageLine = ` ${languageMarker} ${pad(t(locale, 'languageField'), 18, theme.glyphs.ellipsis)} ${languageValue}  ${theme.style.muted(t(locale, 'langToggleHint'))}`;
  const paintedLanguage = model.selected === languageIndex ? theme.style.selected(languageLine) : languageLine;
  return panel(theme, theme.style.harness(t(locale, 'configTitle')), [
    theme.style.muted(` ${t(locale, 'configSharedHint')}`),
    ...values,
    paintedLanguage,
    '',
    ...configStateLines(theme, model, locale),
    ...(model.pendingToggle ? [theme.style.warn(` ${theme.glyphs.warn} ${t(locale, 'confirmProviderSwitch')}`)] : []),
    ...(model.leaveConfirm ? [theme.style.warn(` ${theme.glyphs.warn} ${t(locale, 'unsavedLeave')}`)] : []),
  ], width);
}

export function configHints(
  editing: boolean,
  field?: ConfigField | 'more' | 'less',
  pendingToggle = false,
  languageSelected = false,
  locale: Locale = 'en',
  leaveConfirm = false,
  busy = false,
): readonly (readonly [string, string])[] {
  if (editing) return [['Enter', t(locale, 'hintApply')], ['Ctrl+U', t(locale, 'hintClear')], ['Esc', t(locale, 'hintKeepPrev')]];
  if (leaveConfirm) return [['Enter', t(locale, 'hintStay')], ['d', t(locale, 'hintDiscardDraft')], ['Ctrl+S', t(locale, 'hintSave')]];
  if (pendingToggle) return [['Enter', t(locale, 'hintConfirmSwitch')], ['Esc', t(locale, 'hintCancelSwitch')]];
  const enter = languageSelected
    ? t(locale, 'hintToggleLang')
    : field === 'more' ? t(locale, 'configMoreSettings')
      : field === 'less' ? t(locale, 'configLessSettings')
    : field === 'provider type' ? t(locale, 'hintToggleProvider')
      : field === 'effort' || field === 'API' || field === 'reasoning' || field === 'image input' ? t(locale, 'hintCycleEffort')
        : t(locale, 'hintEdit');
  return [
    ['↑↓', t(locale, 'hintSelect')],
    ['Enter', enter],
    ['Ctrl+T', busy ? t(locale, 'hintTestBusy') : t(locale, 'hintTest')],
    ['Ctrl+S', t(locale, 'hintSave')],
    ['Esc', t(locale, 'hintHome')],
  ];
}

function configStateLines(theme: Theme, model: ConfigModel, locale: Locale): readonly string[] {
  const saveLine = model.dirty
    ? theme.style.warn(` ${theme.glyphs.dot} ${t(locale, 'configSaveStatusUnsaved')}`)
    : model.saved
      ? ` ${theme.glyphs.dot} ${t(locale, 'configSaveStatusSaved')}`
      : ` ${theme.glyphs.dot} ${t(locale, 'configSaveStatusMemory')}`;
  const credLine = credentialStateLine(theme, model, locale);
  const testLine = connectionTestLine(theme, model, locale);
  // Save-only busy note — never a second "testing" line beside connectionTest.
  const busyLine = model.busyKind === 'save'
    ? theme.style.warn(` ${theme.glyphs.dot} ${t(locale, 'configSavingLocally')}`)
    : undefined;
  return busyLine ? [saveLine, credLine, testLine, busyLine] : [saveLine, credLine, testLine];
}

function credentialStateLine(theme: Theme, model: ConfigModel, locale: Locale): string {
  if (model.draft.kind === 'pi-catalog') {
    return ` ${theme.glyphs.dot} ${t(locale, 'configCredPi')}`;
  }
  const available = Boolean(model.envName && model.envSet) || hasFileApiKey(model.draft);
  return available
    ? ` ${theme.glyphs.dot} ${t(locale, 'configCredAvailable')}`
    : theme.style.warn(` ${theme.glyphs.warn} ${t(locale, 'configCredMissing')}`);
}

function connectionTestLine(theme: Theme, model: ConfigModel, locale: Locale): string {
  const status = model.connectionTest?.status ?? 'idle';
  if (status === 'testing') {
    return theme.style.warn(` ${theme.glyphs.dot} ${t(locale, 'configTestStatusTesting')}`);
  }
  if (status === 'passed') {
    return ` ${theme.glyphs.dot} ${t(locale, 'configTestStatusPassed')}`;
  }
  if (status === 'failed') {
    const detail = model.connectionTest?.detail;
    const base = t(locale, 'configTestStatusFailed');
    return theme.style.warn(` ${theme.glyphs.warn} ${detail ? `${base}: ${detail}` : base}`);
  }
  if (status === 'stale') {
    return theme.style.warn(` ${theme.glyphs.dot} ${t(locale, 'configTestStatusStale')}`);
  }
  return ` ${theme.glyphs.dot} ${t(locale, 'configTestStatusIdle')}`;
}

function fieldLabel(locale: Locale, field: ConfigField): string {
  if (field === 'provider type') return t(locale, 'fieldProviderType');
  if (field === 'provider label') return t(locale, 'fieldProviderLabel');
  if (field === 'base URL') return t(locale, 'fieldBaseUrl');
  if (field === 'model') return t(locale, 'fieldModel');
  if (field === 'API') return t(locale, 'fieldApi');
  if (field === 'reasoning') return t(locale, 'fieldReasoning');
  if (field === 'image input') return t(locale, 'fieldImageInput');
  if (field === 'effort') return t(locale, 'fieldEffort');
  return t(locale, 'fieldKeyRef');
}

function fieldValue(theme: Theme, field: ConfigField, value: string, kind: HarnessConfigDraft['kind'], locale: Locale): string {
  if (field === 'reasoning' || field === 'image input') return t(locale, value === 'true' ? 'configOn' : 'configOff');
  if (field === 'API key') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = apiKeyValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return !value && locale === 'zh' ? t(locale, 'required') : validity.display;
  }
  if (field === 'base URL') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = baseUrlValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return !value && locale === 'zh' ? t(locale, 'required') : validity.display;
  }
  return value || t(locale, 'required');
}

function fieldReason(field: ConfigField, value: string, kind: HarnessConfigDraft['kind'], locale: Locale = 'en'): string | undefined {
  if (field === 'API key' && kind === 'openai-compatible') {
    const validity = apiKeyValidity(value);
    return validity.ok || !value ? undefined : validity.reason;
  }
  if (field === 'base URL' && kind === 'openai-compatible') {
    const validity = baseUrlValidity(value);
    if (validity.ok || !value) return undefined;
    return validity.reason === 'invalid URL' ? t(locale, 'baseUrlInvalid') : validity.reason;
  }
  return undefined;
}

function fieldHint(field: ConfigField, locale: Locale): string {
  if (field === 'provider type' || field === 'effort' || field === 'API' || field === 'reasoning' || field === 'image input') return t(locale, 'langToggleHint');
  return '';
}
