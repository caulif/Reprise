import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { panel, wrapBodyLine } from '../widgets.js';

export type ViewerModel = {
  readonly title: string;
  readonly body: string;
  readonly locale?: Locale;
};

export function renderViewer(theme: Theme, width: number, model: ViewerModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const inner = Math.max(20, width - 4);
  const lines = wrapBodyLine(model.body, inner);
  const limit = height === undefined ? lines.length : Math.max(4, height - 6);
  const clipped = lines.length <= limit ? lines : [...lines.slice(0, limit - 1), ` ${theme.glyphs.ellipsis}`];
  return panel(theme, t(locale, 'viewerTitle', { title: model.title }), [
    ` ${t(locale, 'viewerHint')}`,
    '',
    ...clipped.map((line) => ` ${line}`),
  ], width);
}

export function viewerHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Esc', t(locale, 'hintEsc')]];
}
