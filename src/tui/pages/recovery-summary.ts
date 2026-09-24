import { truncateFit } from '../format.js';
import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { kv, wrapBodyLine } from '../widgets.js';
import type { RecoveryPreviewModel, RunningModel } from './run.js';

const MAX_SUMMARY_LINES = 5;

/** Compact recovery facts for picker/confirm — never a full timeline dump. */
export function renderRecoverySummary(
  theme: Theme,
  width: number,
  recovery: RecoveryPreviewModel | undefined,
  locale: Locale,
  expanded = false,
): string[] {
  if (!recovery) return [];
  const lines: string[] = [];
  lines.push(kv(theme, t(locale, 'recoveryField'), recoveryStatusWord(recovery.status, locale), width));
  if (recovery.summary && expanded) {
    lines.push(kv(
      theme,
      t(locale, 'recoverySummaryField'),
      recovery.summary,
      width,
    ));
  }
  if (recovery.failureSummary) {
    lines.push(...wrapBodyLine(recovery.failureSummary, Math.max(12, width - 4)).map((line) => theme.style.warn(` ${theme.glyphs.warn}  ${line}`)));
  }
  if (recovery.failureCategory && expanded) {
    lines.push(kv(theme, t(locale, 'recoveryFailureType'), t(locale, recovery.failureCategory === 'transient' ? 'recoveryFailureTransient' : recovery.failureCategory === 'authentication' ? 'recoveryFailureAuthentication' : recovery.failureCategory === 'source_changed' ? 'recoveryFailureSourceChanged' : recovery.failureCategory === 'staging_invalid' ? 'recoveryFailureStaging' : recovery.failureCategory === 'protocol' ? 'recoveryFailureProtocol' : 'recoveryFailureOther'), width));
    lines.push(kv(theme, t(locale, 'recoveryNextStep'), t(locale, recovery.failureAction === 'retry' ? 'recoveryActionRetry' : recovery.failureAction === 'config' ? 'recoveryActionConfig' : recovery.failureAction === 'refreeze' ? 'recoveryActionRefreeze' : 'recoveryActionDiagnose'), width));
  }
  if (expanded && recovery.candidateStarted === false) lines.push(theme.style.muted(` ${t(locale, 'recoveryCandidateNotStarted')}`));
  if (expanded && recovery.sourceUnchanged) lines.push(theme.style.muted(` ${t(locale, 'recoverySourceSafe')}`));
  const unresolved = recovery.unresolved.length;
  if (unresolved > 0) {
    lines.push(kv(theme, t(locale, 'recoveryUnresolvedField'), String(unresolved), width));
    for (const item of expanded ? recovery.unresolved : recovery.unresolved.slice(0, 1)) {
      lines.push(...wrapBodyLine(item, Math.max(12, width - 4)).map((line) => theme.style.warn(` ${theme.glyphs.warn}  ${line}`)));
    }
  }
  if (expanded && recovery.changedPathCount > 0) {
    lines.push(kv(theme, t(locale, 'recoveryChangedField'), String(recovery.changedPathCount), width));
  }
  return lines;
}

/** Prepare/check/copy surface — separated from the activity timeline. */
export function renderPrepareSummary(
  theme: Theme,
  width: number,
  model: RunningModel,
  locale: Locale,
): string[] {
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  if (model.preparePhase === 'check') {
    const detail = model.prepareDetail ? model.prepareDetail : t(locale, 'recoveryStagePrepare');
    const project = model.workspaceProject ?? t(locale, 'projectlessSessions');
    const session = model.taskTitle ?? t(locale, 'noTaskSummary');
    return [
      kv(theme, t(locale, 'fieldSession'), truncateFit(session, Math.max(12, width - 14), theme.glyphs.ellipsis), width),
      kv(theme, t(locale, 'fieldProject'), truncateFit(project, Math.max(12, width - 14), theme.glyphs.ellipsis), width),
      kv(theme, t(locale, 'statusLabel'), truncateFit(detail, Math.max(12, width - 14), theme.glyphs.ellipsis), width),
      theme.style.muted(` ${t(locale, 'recoveringPrepare')}`),
    ].slice(0, MAX_SUMMARY_LINES);
  }
  if (model.preparePhase === 'copy') {
    const detail = model.prepareDetail ? ` · ${model.prepareDetail}` : '';
    return [
      model.taskTitle
        ? ` ${t(locale, 'taskLabel')}  ${theme.style.strong(truncateFit(model.taskTitle, Math.max(8, width - 8), theme.glyphs.ellipsis))}`
        : '',
      ` ${t(locale, 'preparingIn', { product })}`,
      theme.style.muted(` ${t(locale, 'preparingBar', { step: 2, detail })}`),
    ].filter(Boolean).slice(0, MAX_SUMMARY_LINES);
  }
  return [];
}

function recoveryStatusWord(
  status: RecoveryPreviewModel['status'],
  locale: Locale,
): string {
  if (status === 'partial') return t(locale, 'userPartial');
  if (status === 'blocked') return t(locale, 'userBlocked');
  if (status === 'ready' || status === 'recovered') return t(locale, 'userRecovered');
  if (status === 'failed') return t(locale, 'userFailed');
  if (status === 'insufficient_evidence') return t(locale, 'comparisonInsufficient');
  return status;
}
