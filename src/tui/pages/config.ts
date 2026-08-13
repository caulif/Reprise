import { HARNESS_CONFIG_FIELDS, baseUrlValidity, configFieldValue, keyRefValidity, type HarnessConfigDraft, type HarnessConfigField } from '../../infrastructure/harness-model-config.js';
import type { Theme } from '../theme.js';
import { panel } from '../widgets.js';

export const CONFIG_FIELDS = HARNESS_CONFIG_FIELDS;
export type ConfigField = HarnessConfigField;

export type ConfigModel = {
  readonly draft: HarnessConfigDraft;
  readonly selected: number;
  readonly editing: boolean;
  readonly buffer: string;
  readonly dirty: boolean;
  readonly saved: boolean;
};

export function renderConfig(theme: Theme, width: number, model: ConfigModel): string[] {
  const field = CONFIG_FIELDS[model.selected] ?? CONFIG_FIELDS[0];
  if (model.editing) {
    return panel(theme, `Editing ${field}`, [
      ` Current  ${fieldValue(theme, field, configFieldValue(model.draft, field), model.draft.kind)}`,
      '',
      ` ${theme.glyphs.cursor} ${fieldValue(theme, field, model.buffer, model.draft.kind) || '▌'}`,
    ], width);
  }
  const values = CONFIG_FIELDS.flatMap((item, index) => {
    const marker = index === model.selected ? theme.glyphs.cursor : ' ';
    const hint = fieldHint(item);
    const value = fieldValue(theme, item, configFieldValue(model.draft, item), model.draft.kind);
    const reason = fieldReason(item, configFieldValue(model.draft, item), model.draft.kind);
    const line = ` ${marker} ${item.padEnd(18)} ${value}${hint ? `  ${theme.style.muted(hint)}` : ''}`;
    return reason ? [line, `     ${theme.style.warn(`${theme.glyphs.warn} ${reason}`)}`] : [line];
  });
  const credentialNote = model.draft.kind === 'openai-compatible'
    ? ' Keys stay in your environment. Reprise saves only env:NAME or ${NAME}.'
    : ' Pi catalog credentials are discovered by Pi and are not copied into Reprise.';
  const dirty = model.dirty
    ? theme.style.warn(` ${theme.glyphs.dot} Unsaved draft`)
    : theme.style.ok(` ${theme.glyphs.ok} Saved locally`);
  const status = model.saved || model.dirty ? dirty : ` ${theme.glyphs.dot} In-memory draft`;
  return panel(theme, 'Harness API', [
    ...values,
    '',
    status,
    credentialNote,
    ' Configuration file: .reprise/harness-model.json',
  ], width);
}

export function configHints(editing: boolean): readonly (readonly [string, string])[] {
  if (editing) return [['Enter', 'Apply'], ['Ctrl+A', 'Clear'], ['Esc', 'Keep previous']];
  return [['↑↓', 'Select'], ['Enter', 'Change'], ['s', 'Save locally'], ['t', 'Test connection'], ['Esc', 'Home']];
}

function fieldValue(theme: Theme, field: ConfigField, value: string, kind: HarnessConfigDraft['kind']): string {
  if (field === 'API key reference') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = keyRefValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return validity.display;
  }
  if (field === 'base URL') {
    if (kind !== 'openai-compatible' && !value) return '';
    const validity = baseUrlValidity(value);
    if (validity.ok) return `${validity.display}  ${theme.style.ok(theme.glyphs.ok)}`;
    return validity.display;
  }
  return value || '(required)';
}

function fieldReason(field: ConfigField, value: string, kind: HarnessConfigDraft['kind']): string | undefined {
  if (field === 'API key reference' && kind === 'openai-compatible') {
    const validity = keyRefValidity(value);
    return validity.ok || !value ? undefined : validity.reason;
  }
  if (field === 'base URL' && kind === 'openai-compatible') {
    const validity = baseUrlValidity(value);
    return validity.ok || !value ? undefined : validity.reason;
  }
  return undefined;
}

function fieldHint(field: ConfigField): string {
  if (field === 'provider type') return '[Enter] toggles';
  if (field === 'effort') return '[Enter] cycles';
  return '';
}
