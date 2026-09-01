import { actorVerb } from '../agent-activity.js';
import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import type { RunningModel } from './run.js';
import { kv, panel } from '../widgets.js';

export function renderActors(theme: Theme, width: number, model: RunningModel, locale: Locale = 'en'): string[] {
  const inner = Math.min(width, 56);
  const recoveryVerb = actorVerb(model.entries, 'recovery');
  const recovery = model.preparePhase === 'check' || model.runPhase === 'recovery'
    ? (recoveryVerb ?? t(locale, 'inProgress'))
    : t(locale, 'done');
  const controllerVerb = actorVerb(model.entries, 'controller');
  const controllerCalls = model.calls.max === undefined
    ? `${model.calls.used}`
    : `${model.calls.used}/${model.calls.max}`;
  const controller = `${controllerCalls}${controllerVerb ? ` · ${controllerVerb}` : ` · ${t(locale, 'actorWaiting')}`}`;
  const target = model.turns.max === undefined
    ? `${model.turns.used}`
    : `${model.turns.used}/${model.turns.max}`;
  const comparisonVerb = actorVerb(model.entries, 'comparison');
  const comparison = model.preparePhase === 'compare'
    ? (comparisonVerb ?? t(locale, 'inProgress'))
    : model.currentState === 'finished' ? t(locale, 'done') : t(locale, 'actorWaiting');
  return panel(theme, t(locale, 'actorsTitle'), [
    kv(theme, t(locale, 'actorRecovery'), recovery, inner - 2),
    kv(theme, t(locale, 'actorController'), `${t(locale, 'actorCalls')} ${controller}`, inner - 2),
    kv(theme, t(locale, 'actorTarget'), `${model.currentState ?? t(locale, 'waiting')} · ${t(locale, 'replayRound', { n: Math.max(1, model.turns.used) })} · ${target}`, inner - 2),
    kv(theme, t(locale, 'actorComparison'), comparison, inner - 2),
  ], inner);
}

export function actorsHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Ctrl+G', t(locale, 'hintActors')], ['Esc', t(locale, 'hintEsc')]];
}
