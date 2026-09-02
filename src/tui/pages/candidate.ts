import type { RuntimeAvailabilityStatus, RuntimeModelOffer } from '../../core/runtime.js';
import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { kv, panel, table } from '../widgets.js';

export type CandidateProductRow = {
  readonly productId: string;
  readonly displayName: string;
  readonly sourceSession: boolean;
  readonly availability?: RuntimeAvailabilityStatus | 'loading';
};

export type CandidateProductModel = {
  readonly taskTitle?: string;
  readonly sourceProductLabel: string;
  readonly products: readonly CandidateProductRow[];
  readonly selected: number;
  readonly locale?: Locale;
};

export type CandidateModelPage = {
  readonly taskTitle?: string;
  readonly sourceProductLabel: string;
  readonly candidateProductLabel: string;
  readonly offers: readonly RuntimeModelOffer[];
  readonly selected: number;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error?: string;
  readonly suggestedValue?: string;
  readonly locale?: Locale;
};

export function renderCandidateProductPicker(theme: Theme, width: number, model: CandidateProductModel): string[] {
  const locale = model.locale ?? 'en';
  const rows = model.products.map((product, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    product: product.displayName,
    note: product.sourceSession ? t(locale, 'sourceSessionTag') : '',
    status: availabilityLabel(product.availability, locale),
  }));
  const inner = Math.max(20, width - (theme.framed ? 2 : 3));
  const body = [
    kv(theme, t(locale, 'taskLabel'), model.taskTitle ?? t(locale, 'unavailableValue'), width - 2),
    kv(theme, t(locale, 'sourceSessionLabel'), model.sourceProductLabel, width - 2),
    '',
    ...(rows.length
      ? table(theme, rows, [
        { key: 'marker', width: 2 },
        { key: 'product', flex: 1 },
        { key: 'note', width: 16 },
        { key: 'status', width: 14 },
      ], inner)
      : [` ${t(locale, 'noRegisteredProducts')}`]),
  ];
  return panel(theme, theme.style.harness(t(locale, 'selectCandidateProduct')), body, width);
}

export function renderCandidateModelPicker(theme: Theme, width: number, model: CandidateModelPage): string[] {
  const locale = model.locale ?? 'en';
  const header = [
    kv(theme, t(locale, 'sourceSessionLabel'), model.sourceProductLabel, width - 2),
    kv(theme, t(locale, 'candidateLabel'), model.candidateProductLabel, width - 2),
  ];
  if (model.status === 'loading') {
    return panel(theme, theme.style.harness(t(locale, 'selectCandidateModel')), [
      ...header,
      '',
      ` ${t(locale, 'catalogLoading', { product: model.candidateProductLabel })}`,
    ], width);
  }
  if (model.status === 'error' || !model.offers.length) {
    return panel(theme, theme.style.harness(t(locale, 'selectCandidateModel')), [
      ...header,
      '',
      theme.style.danger(` ${model.error ?? t(locale, 'catalogEmpty')}`),
    ], width);
  }
  const inner = Math.max(20, width - (theme.framed ? 2 : 3));
  const rows = model.offers.map((offer, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    value: offer.displayName || offer.value,
    note: offer.value === model.suggestedValue ? t(locale, 'suggestedModel') : (offer.resolvedModel && offer.resolvedModel !== offer.value ? offer.resolvedModel : ''),
  }));
  return panel(theme, theme.style.harness(t(locale, 'selectCandidateModel')), [
    ...header,
    '',
    ...table(theme, rows, [
      { key: 'marker', width: 2 },
      { key: 'value', flex: 1 },
      { key: 'note', width: 28 },
    ], inner),
  ], width);
}

export function candidateProductHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintChooseModels')], ['b', t(locale, 'hintBack')], ['Esc', t(locale, 'hintHome')]];
}

export function candidateModelHints(canEnter: boolean, locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [
    ...(canEnter ? [['↑↓', t(locale, 'hintSelect')] as const, ['Enter', t(locale, 'hintUseModel')] as const] : []),
    ['b', t(locale, 'hintChangeProduct')],
    ['Esc', t(locale, 'hintHome')],
  ];
}

function availabilityLabel(status: CandidateProductRow['availability'], locale: Locale): string {
  if (status === 'available') return t(locale, 'availableValue');
  if (status === 'not_installed') return t(locale, 'runtimeNotInstalled');
  if (status === 'unsupported_platform') return t(locale, 'runtimeUnsupported');
  return t(locale, 'sessionsLoading');
}
