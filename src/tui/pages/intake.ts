import { basename } from 'node:path';
import { asPosixPath, canonicalRecordedRoot, pathContainedBy } from '../../core/paths.js';
import { compareSessionSummaries, type SessionDiscoveryProject, type SessionInspection, type SessionPrivacy, type SessionSummary } from '../../products/contract.js';
import {
  isUnknownProjectKey,
  PROJECTLESS_PROJECT_KEY,
  sessionGroupingKey,
} from '../../products/shared/session-project.js';
import { looksLikeInjectedInstruction, firstReplayUserMessage } from '../../products/shared/replay-user-input.js';
import { compact, truncateFit } from '../format.js';
import { t, type Locale } from '../i18n.js';
import { caretAt } from '../text-edit.js';
import { showsDetailPane, type Theme } from '../theme.js';
import { joinColumns, kv, kvBlock, panel, table, wrapBodyLine } from '../widgets.js';

export type IntakeLevel = 'products' | 'projects' | 'sessions';

export type ProductIntakeItem = {
  readonly productId: string;
  readonly displayName: string;
  readonly packVersion: string;
  readonly discoveryStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly sessionCount?: number;
  readonly scanned?: number;
  readonly limitReached?: boolean;
  readonly skipped?: number;
  readonly diagnostic?: string;
};

export type SessionProject = {
  readonly key: string;
  readonly label: string;
  readonly path?: string;
  readonly sessions: readonly SessionSummary[];
  readonly latestAt: string;
};

export type SessionsModel = {
  readonly level: IntakeLevel;
  readonly products?: readonly ProductIntakeItem[];
  readonly projects: readonly SessionProject[];
  readonly sessions: readonly SessionSummary[];
  readonly selected: number;
  readonly filterEligible: boolean;
  readonly query: string;
  readonly searchCursor?: number;
  readonly searching: boolean;
  readonly discoveryStatus?: 'idle' | 'loading' | 'ready' | 'error';
  readonly locale?: import('../i18n.js').Locale;
  /** Clock supplied by the workbench; inject it for deterministic visual audits. */
  readonly nowMs?: number;
};

export type InspectionModel = {
  readonly inspection: SessionInspection;
  readonly privacy: SessionPrivacy;
  readonly selectedTaskInput: number;
  readonly showOutcome: boolean;
  readonly locale?: import('../i18n.js').Locale;
  /** Clock supplied by the workbench; inject it for deterministic visual audits. */
  readonly nowMs?: number;
};

function isProjectless(key: string): boolean { return key === PROJECTLESS_PROJECT_KEY; }

/** Discovery list omits a/t when the summary window did not count them. Inspect uses full signals. */
export function formatDiscoverySignals(session: Pick<SessionSummary, 'signals' | 'partial' | 'availability'>): string {
  const user = `u${session.signals.userMessages}`;
  if (session.partial || session.availability === 'catalog-only') return user;
  return `${user} a${session.signals.assistantMessages} t${session.signals.toolCalls}`;
}

function sessionStatus(session: SessionSummary, locale: Locale): string {
  const titled = sessionListTitle(session, locale);
  const placeholder = t(locale, 'noTaskSummary');
  if (session.partial && (!titled || titled === placeholder || looksLikeInjectedInstruction(titled))) {
    return t(locale, 'partialSession');
  }
  if (session.recoveryReadiness === 'best-effort') return t(locale, 'bestEffortSession');
  if (session.recoveryReadiness === 'no-user-input') return t(locale, 'noUserInputSession');
  if (session.recoveryReadiness === 'corrupt') return t(locale, 'corruptSession');
  if (session.evidenceLevel === 'history') return t(locale, 'historyOnlySession');
  if (session.availability === 'catalog-only') return t(locale, 'catalogOnlySession');
  if (session.availability === 'unindexed') return t(locale, 'unindexedSession');
  if (session.availability === 'unreadable') return t(locale, 'unreadableSession');
  return '';
}

function sessionTime(session: SessionSummary | undefined): string {
  return session?.updatedAt ?? session?.startedAt ?? '';
}

function isUnknownProject(key: string): boolean {
  return isUnknownProjectKey(key);
}

function localizedProjectLabel(project: SessionProject | undefined, locale: Locale): string {
  if (!project) return t(locale, 'unknownProject');
  if (project.key === PROJECTLESS_PROJECT_KEY) return t(locale, 'projectlessSessions');
  if (isUnknownProject(project.key)) return t(locale, 'unknownProject');
  return project.label;
}

export function projectLabel(cwd: string | undefined, locale: Locale = 'en'): string {
  if (!cwd?.trim()) return t(locale, 'unknownProject');
  const name = basename(cwd.replaceAll('\\', '/'));
  return name || t(locale, 'unknownProject');
}

/** Adds just enough parent path to distinguish projects with the same basename. */
function projectDisplayLabel(path: string | undefined, paths: readonly string[], locale: Locale = 'en'): string {
  if (!path) return t(locale, 'unknownProject');
  const parts = asPosixPath(path).split('/').filter(Boolean);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const candidate = parts.slice(-depth).join('/');
    const duplicates = paths.filter((value) => asPosixPath(value).split('/').filter(Boolean).slice(-depth).join('/').toLowerCase() === candidate.toLowerCase());
    if (duplicates.length === 1) return candidate;
  }
  return parts.slice(-Math.min(2, parts.length)).join('/');
}

export function sessionTitle(summary: string | undefined, locale: Locale = 'en', laterUserTexts: readonly string[] = []): string {
  return taskDisplaySummary(summary, laterUserTexts, locale);
}

export function sessionListTitle(session: Pick<SessionSummary, 'summary' | 'laterUserSummaries'>, locale: Locale = 'en'): string {
  return sessionTitle(session.summary, locale, session.laterUserSummaries ?? []);
}

export function taskDisplaySummary(
  text: string | undefined,
  laterUserTexts: readonly string[] = [],
  locale: Locale = 'en',
): string {
  const primary = (text ?? t(locale, 'noTaskSummary')).replace(/\s+/g, ' ').trim();
  if (looksLikeInjectedInstruction(primary)) {
    const next = laterUserTexts.map((item) => item.replace(/\s+/g, ' ').trim()).find((item) => item && !looksLikeInjectedInstruction(item) && item.length <= 280);
    if (next) return compactTitle(next);
  }
  return compactTitle(primary);
}

function compactTitle(text: string): string {
  const stripped = text
    .replace(/^.*?["']?[A-Za-z]:[\\/][^"']+["']?[^,，:]*[,，:]\s*/u, '')
    .replace(/^[,:，]\s*/, '')
    .trim();
  const value = stripped || text;
  if (looksLikeInjectedInstruction(value)) {
    const firstLine = value.split(/(?<=\.)\s/)[0] ?? value;
    if (firstLine.length > 80 && value.length > 160) return value.slice(0, 72).trim();
  }
  return value;
}

export function groupSessionsByProject(sessions: readonly SessionSummary[], catalogProjects: readonly SessionDiscoveryProject[] = []): SessionProject[] {
  const catalogKeysByRoot = new Map<string, string>();
  for (const project of catalogProjects) {
    const canonical = canonicalRecordedRoot(project.path);
    if (canonical) catalogKeysByRoot.set(canonical, project.key);
  }
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = sessionGroupingKey(session, catalogKeysByRoot);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  for (const project of catalogProjects) if (!groups.has(project.key)) groups.set(project.key, []);
  if (!groups.has(PROJECTLESS_PROJECT_KEY)) groups.set(PROJECTLESS_PROJECT_KEY, []);
  const grouped = [...groups.entries()].map(([key, items]) => {
    const ordered = [...items].sort(compareSessionSummaries);
    const path = ordered.find((item) => item.cwd)?.cwd;
    const catalog = catalogProjects.find((item) => item.key === key);
    return { key, ...(path ? { path } : catalog?.path ? { path: catalog.path } : {}), sessions: ordered, latestAt: sessionTime(ordered[0]) || '' };
  });
  const knownPaths = grouped.flatMap((project) => project.path ? [project.path] : []);
  return grouped.map((project) => {
    if (isProjectless(project.key)) return { ...project, label: t('en', 'projectlessSessions') };
    if (isUnknownProject(project.key)) return { ...project, label: t('en', 'unknownProject') };
    const samePath = grouped.filter((other) => other.path && asPosixPath(other.path).toLowerCase() === asPosixPath(project.path ?? '').toLowerCase());
    const label = catalogProjects.find((item) => item.key === project.key)?.label ?? projectDisplayLabel(project.path, knownPaths);
    return samePath.length > 1
      ? { ...project, label: `${project.sessions[0]?.productId ?? 'agent'} · ${label}` }
      : { ...project, label };
  }).sort((left, right) => {
    if (isUnknownProject(left.key)) return 1;
    if (isUnknownProject(right.key)) return -1;
    if (!left.sessions.length && !right.sessions.length) return left.key.localeCompare(right.key);
    if (!left.sessions.length) return 1;
    if (!right.sessions.length) return -1;
    const order = compareSessionSummaries(left.sessions[0]!, right.sessions[0]!);
    return order || left.key.localeCompare(right.key);
  });
}

export function selectDefaultProjectIndex(
  projects: readonly SessionProject[],
  displayCwd: string,
  lastProjectKey = '',
  dataDir = '',
): number {
  if (!projects.length) return 0;
  if (lastProjectKey) {
    const remembered = projects.findIndex((project) => project.key === lastProjectKey);
    if (remembered >= 0) return remembered;
  }
  const cwdHits = projects
    .map((project, index) => ({ index, path: project.path }))
    .filter((item): item is { index: number; path: string } => Boolean(item.path) && pathContainedBy(item.path!, displayCwd))
    .filter((item) => !isHarnessCheckout(item.path, displayCwd, dataDir));
  if (cwdHits.length) {
    cwdHits.sort((left, right) => right.path.length - left.path.length);
    return cwdHits[0]!.index;
  }
  return 0;
}

function isHarnessCheckout(projectPath: string, displayCwd: string, dataDir: string): boolean {
  if (!dataDir) return false;
  const dataInsideProject = pathContainedBy(projectPath, dataDir);
  const dataInsideCwd = pathContainedBy(displayCwd, dataDir);
  const projectIsCwd = asPosixPath(projectPath).toLowerCase() === asPosixPath(displayCwd).toLowerCase();
  return dataInsideProject || (projectIsCwd && dataInsideCwd);
}

export function relativeTime(iso: string | undefined, now = Date.now(), locale: Locale = 'en'): string {
  if (!iso) return t(locale, 'unknownTime');
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso.replace('T', ' ').slice(0, 16);
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return t(locale, 'justNow');
  if (minutes < 60) return t(locale, 'minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(locale, 'hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days === 1) return t(locale, 'yesterday');
  if (days < 7) return t(locale, 'daysAgo', { n: days });
  return iso.slice(0, 10);
}

export function matchesIntakeQuery(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    session.sessionId, session.cwd ?? '', session.summary ?? '', sessionListTitle(session),
    ...(session.laterUserSummaries ?? []),
    projectLabel(session.cwd), session.startedAt ?? '', session.updatedAt ?? '',
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}

export function matchesProjectQuery(project: SessionProject, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (`${project.label} ${project.path ?? ''}`.toLowerCase().includes(needle)) return true;
  return project.sessions.some((session) => matchesIntakeQuery(session, query));
}

export function renderSessions(theme: Theme, width: number, model: SessionsModel, height?: number, showPreview = true, showSearch = true): string[] {
  const limit = height === undefined ? 12 : Math.max(1, height - 5);
  if (model.level === 'products') return renderProducts(theme, width, model, limit);
  if (model.level === 'projects') return renderProjects(theme, width, model, limit, showPreview, showSearch);
  return renderSessionList(theme, width, model, limit, showPreview, showSearch);
}

export function renderInspection(theme: Theme, width: number, model: InspectionModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const { inspection, privacy, showOutcome } = model;
  const inputs = inspection.transcript.filter((message) => message.role === 'user');
  if (!inputs.length) {
    return panel(theme, `${t(locale, 'chooseTaskStart')} ${theme.glyphs.sep} ${projectLabel(inspection.cwd, locale)}`, [
      ` ${t(locale, 'notReplayableNoUserInput')}`,
    ], width);
  }
  const start = firstReplayUserMessage(inputs) ?? inputs[0];
  const later = start ? inputs.filter((message) => message.id !== start.id) : inputs.slice(1);
  const laterTasks = later.filter((message) => !looksLikeInjectedInstruction(message.text));
  const project = projectLabel(inspection.cwd, locale);
  const tight = height !== undefined && height < 26;
  const freezePreview = wrapPreview(start?.text ?? t(locale, 'unavailableValue'), Math.max(20, width - 4), tight ? 2 : 4, locale);
  const laterTotal = laterTasks.length + 1;
  const laterLines = laterTasks.length
    ? laterTasks.map((input, index) => ` ${index + 2}/${laterTotal}  ${compact(sessionTitle(input.text, locale), 72, theme.glyphs.ellipsis)}`)
    : [` ${t(locale, 'noneWord')}`];
  const outcome = compact(inspection.finalMessage ?? t(locale, 'unavailableValue'), showOutcome ? 400 : 120, theme.glyphs.ellipsis);
  const meta = ` ${project} ${theme.glyphs.sep} ${relativeTime(inspection.startedAt, model.nowMs ?? Date.now(), locale)} ${theme.glyphs.sep} u${inspection.signals.userMessages} a${inspection.signals.assistantMessages} t${inspection.signals.toolCalls}`;
  const ruleWidth = Math.max(1, width - (theme.framed ? 2 : 3));
  const rule = theme.glyphs.h.repeat(ruleWidth);
  const body = [
    ` ${t(locale, 'freezeIntro')}`,
    meta,
    rule,
    ` ${t(locale, 'freezeThis')}`,
    ...freezePreview.map((line) => ` ${line}`),
    rule,
    ` ${t(locale, 'laterUserTurns')}`,
    ...laterLines,
    rule,
    ` ${t(locale, 'outcomeLabel')}    ${outcome}`,
    ` ${t(locale, 'privacyLabel')}    ${t(locale, 'fieldModelText')} ${privacy.allowModelText ? t(locale, 'allowed') : t(locale, 'blocked')} ${theme.glyphs.sep} ${t(locale, 'fieldBinary')} ${privacy.allowBinary ? t(locale, 'allowed') : t(locale, 'blocked')} ${theme.glyphs.sep} ${t(locale, 'fieldRedactions')} ${privacy.redactions.length || t(locale, 'noneWord')}`,
    ` ${t(locale, 'nothingWritten')}`,
    ...(inspection.recoveryDiagnostics?.length
      ? [` ${t(locale, 'recoveryDiagnostics')} ${inspection.recoveryDiagnostics.map((item) => item.code).join(' / ')}`]
      : []),
    ...(tight ? [] : [kv(theme, t(locale, 'fieldSource'), inspection.sourcePath, width - 2)]),
  ];
  const inner = height === undefined ? body.length : Math.max(1, height - (theme.framed ? 2 : 1));
  const clipped = body.length <= inner ? body : [...body.slice(0, inner - 1), ` ${theme.glyphs.ellipsis}`];
  return panel(theme, `${t(locale, 'chooseTaskStart')} ${theme.glyphs.sep} ${project}`, clipped, width);
}

export function sessionsHints(model?: SessionsModel, locale: Locale = 'en'): readonly (readonly [string, string])[] {
  if (model?.searching) return [['Esc', t(locale, 'hintClearSearch')], ['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintOpenProject')]];
  if (model?.level === 'products') {
    return [['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'openProduct')], ['Esc', t(locale, 'hintHome')]];
  }
  if (model?.level === 'projects') {
    return [['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintOpenProject')], ['/', t(locale, 'hintSearch')], ['f', t(locale, 'hintFilterEligible')], ['m', t(locale, 'moreSessions')], ['r', t(locale, 'refreshSessions')], ['Esc', t(locale, 'hintHome')]];
  }
  return [['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintInspect')], ['/', t(locale, 'hintSearch')], ['m', t(locale, 'moreSessions')], ['r', t(locale, 'refreshSessions')], ['Backspace', t(locale, 'hintProjects')], ['Esc', t(locale, 'hintBack')]];
}

export function inspectionHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', t(locale, 'hintFreeze')], ['d', t(locale, 'hintExpandOutcome')], ['t', t(locale, 'hintToggleText')], ['Esc', t(locale, 'hintBack')]];
}


function renderProducts(theme: Theme, width: number, model: SessionsModel, limit: number): string[] {
  const rows = (model.products ?? []).map((product, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    product: product.displayName,
    version: `pack ${product.packVersion}`,
    status: product.discoveryStatus === 'error'
      ? `error: ${product.diagnostic ?? t(model.locale ?? 'en', 'sessionDiscoveryFailed')}`
      : product.discoveryStatus === 'ready'
        ? `${t(model.locale ?? 'en', 'productSessionCount', { n: product.sessionCount ?? 0 })}${product.limitReached ? '+' : ''}${product.skipped ? t(model.locale ?? 'en', 'productSkippedCount', { n: product.skipped }) : ''}`
        : product.discoveryStatus === 'loading' ? t(model.locale ?? 'en', 'sessionsLoading') : t(model.locale ?? 'en', 'sessionsNotScanned'),
  }));
  const range = visibleRange(rows, model.selected, limit);
  const inner = Math.max(20, width - (theme.framed ? 2 : 3));
  const body = rows.length
    ? paintSelectedRows(theme, fitRows(table(theme, rows.slice(range.start, range.end), [
      { key: 'marker', width: 2 }, { key: 'product', flex: 1 }, { key: 'version', width: 12 }, { key: 'status', width: 24 },
    ], inner), inner), range.start, model.selected)
    : [` ${t(model.locale ?? 'en', 'noRegisteredProducts')}`];
  return panel(theme, theme.style.harness(t(model.locale ?? 'en', 'selectAgentProduct')), body, width);
}

function catalogStats(projects: readonly SessionProject[]): { projects: number; sessions: number; projectless: number; unreadable: number } {
  const sessions = projects.flatMap((project) => project.sessions);
  return {
    projects: projects.length,
    sessions: sessions.length,
    projectless: projects.find((project) => isProjectless(project.key))?.sessions.length ?? 0,
    unreadable: sessions.filter((session) => session.availability === 'catalog-only' || session.availability === 'unreadable').length,
  };
}

function renderProjects(theme: Theme, width: number, model: SessionsModel, limit: number, showPreview = true, showSearch = true): string[] {
  const locale = model.locale ?? 'en';
  const stats = catalogStats(model.projects);
  const title = `${t(locale, 'projectsTitle')} ${theme.glyphs.sep} ${t(locale, 'catalogCounts', stats)} ${theme.glyphs.sep} ${t(locale, 'filterLabel')}: ${model.filterEligible ? t(locale, 'filterEligibleLabel') : t(locale, 'filterAllLabel')}`;
  if (model.discoveryStatus === 'loading' && stats.sessions === 0) {
    return [...panel(theme, title, [` ${t(locale, 'sessionsLoading')}`], width), ...(showSearch ? searchLine(theme, width, model) : [])];
  }
  if (!model.projects.length) {
    return [...panel(theme, title, [` ${t(locale, 'noMatchingProjects')}`], width), ...(showSearch ? searchLine(theme, width, model) : [])];
  }
  const previewWidth = showPreview && showsDetailPane(theme) ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.projects.map((project, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    name: localizedProjectLabel(project, locale),
    gap: ' ',
    count: project.sessions.length ? String(project.sessions.length) : t(locale, 'emptyProjectSessions'),
    when: relativeTime(project.latestAt, model.nowMs ?? Date.now(), locale),
  }));
  const range = visibleRange(rows, model.selected, limit);
  const listBody = paintSelectedRows(theme, fitRows(table(theme, rows.slice(range.start, range.end), [
    { key: 'marker', width: 2 },
    { key: 'name', flex: 1 },
    { key: 'gap', width: 1 },
    { key: 'count', width: 10 },
    { key: 'when', width: 12 },
  ], inner), inner), range.start, model.selected);
  listBody.push(theme.style.muted(` ${model.selected + 1}/${rows.length}`));
  const list = panel(theme, theme.style.harness(title), listBody, listWidth);
  const selected = model.projects[model.selected];
  const latest = selected?.sessions[0];
  const preview = previewWidth ? panel(theme, theme.style.harness(t(locale, 'previewTitle')), selected ? [
    kv(theme, t(locale, 'fieldProject'), localizedProjectLabel(selected, locale), previewWidth - 2),
    ...kvBlock(theme, t(locale, 'fieldPath'), selected.path ?? t(locale, 'unavailableValue'), previewWidth - 2),
    kv(theme, t(locale, 'fieldSessions'), selected.sessions.length ? String(selected.sessions.length) : t(locale, 'emptyProjectSessions'), previewWidth - 2),
    '',
    kv(theme, t(locale, 'fieldLatest'), latest ? sessionListTitle(latest, locale) : t(locale, 'unavailableValue'), previewWidth - 2),
  ] : [` ${t(locale, 'noProjectSelected')}`], previewWidth) : [];
  const body = previewWidth ? joinColumns(list, preview, listWidth, previewWidth, 1, theme) : list;
  return [...body, ...(showSearch ? searchLine(theme, width, model) : [])];
}

function renderSessionList(theme: Theme, width: number, model: SessionsModel, limit: number, showPreview = true, showSearch = true): string[] {
  const locale = model.locale ?? 'en';
  const project = model.projects[0];
  const title = `${localizedProjectLabel(project, locale)} ${theme.glyphs.sep} ${model.sessions.length} ${t(locale, 'sessionsWord')} ${theme.glyphs.sep} ${t(locale, 'filterLabel')}: ${model.filterEligible ? t(locale, 'filterEligibleLabel') : t(locale, 'filterAllLabel')}`;
  if (!model.sessions.length) {
    return [...panel(theme, title, [model.query.trim() ? ` ${t(locale, 'noSessionsMatch')}` : ` ${t(locale, 'noEligibleSessions')}`], width), ...(showSearch ? searchLine(theme, width, model) : [])];
  }
  const previewWidth = showPreview && showsDetailPane(theme) ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.sessions.map((session, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    started: relativeTime(session.startedAt, model.nowMs ?? Date.now(), locale),
    summary: `${sessionStatus(session, locale) ? `${sessionStatus(session, locale)} ` : ''}${sessionListTitle(session, locale)}`,
    gap: ' ',
    signals: formatDiscoverySignals(session),
  }));
  const range = visibleRange(rows, model.selected, limit);
  const listBody = paintSelectedRows(theme, fitRows(table(theme, rows.slice(range.start, range.end), [
    { key: 'marker', width: 2 },
    { key: 'started', width: 12 },
    { key: 'summary', flex: 1 },
    { key: 'gap', width: 1 },
    { key: 'signals', width: 14 },
  ], inner), inner), range.start, model.selected);
  listBody.push(theme.style.muted(` ${model.selected + 1}/${rows.length}`));
  const list = panel(theme, theme.style.harness(title), listBody, listWidth);
  const selected = model.sessions[model.selected];
  const preview = previewWidth ? panel(theme, theme.style.harness(t(locale, 'previewTitle')), selected ? [
    kv(theme, t(locale, 'fieldProject'), projectLabel(selected.cwd, locale), previewWidth - 2),
    kv(theme, t(locale, 'fieldSession'), selected.sessionId.slice(0, 8), previewWidth - 2),
    kv(theme, t(locale, 'fieldStarted'), (selected.startedAt ?? t(locale, 'unknownTime')).replace('T', ' ').slice(0, 16), previewWidth - 2),
    kv(theme, t(locale, 'fieldUpdated'), (selected.updatedAt ?? selected.startedAt ?? t(locale, 'unknownTime')).replace('T', ' ').slice(0, 16), previewWidth - 2),
    kv(theme, t(locale, 'fieldSignals'), formatDiscoverySignals(selected), previewWidth - 2),
    '',
    kv(theme, t(locale, 'fieldStatus'), sessionStatus(selected, locale) || t(locale, 'availableSession'), previewWidth - 2),
    kv(theme, t(locale, 'fieldTask'), `${sessionListTitle(selected, locale)}`, previewWidth - 2),
  ] : [` ${t(locale, 'noSessionSelected')}`], previewWidth) : [];
  const body = previewWidth ? joinColumns(list, preview, listWidth, previewWidth, 1, theme) : list;
  return [...body, ...(showSearch ? searchLine(theme, width, model) : [])];
}

function searchLine(theme: Theme, width: number, model: SessionsModel): string[] {
  const locale = model.locale ?? 'en';
  const prefix = model.searching ? ` ${t(locale, 'searchLabel')} ` : ` ${theme.glyphs.cursor} ${theme.style.muted(t(locale, 'searchHint'))}`;
  const value = model.searching ? caretAt(model.query, model.searchCursor ?? model.query.length) : '';
  return ['', truncateFit(`${prefix}${value}`, Math.max(8, width), theme.glyphs.ellipsis)];
}

function paintSelectedRows(theme: Theme, rows: readonly string[], start: number, selected: number): string[] {
  return rows.map((row, index) => (start + index === selected ? theme.style.selected(row) : row));
}

function fitRows(rows: readonly string[], width: number): string[] {
  return rows.map((row) => truncateFit(row, width, '...'));
}

function wrapPreview(text: string, width: number, maxLines = 4, locale: Locale = 'en'): string[] {
  const lines = wrapBodyLine(text.replace(/\s+/g, ' ').trim(), Math.max(8, width));
  if (!lines.length) return [t(locale, 'unavailableValue')];
  if (lines.length <= maxLines) return lines;
  const keep = Math.max(1, maxLines - 1);
  return [...lines.slice(0, keep), compact(lines.slice(keep).join(' '), width, '...')];
}

function visibleRange<T>(items: readonly T[], selected: number, limit = 12): { start: number; end: number } {
  if (items.length <= limit) return { start: 0, end: items.length };
  const start = Math.max(0, Math.min(items.length - limit, selected - Math.floor(limit / 2)));
  return { start, end: start + limit };
}
