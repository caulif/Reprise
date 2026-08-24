import { basename } from 'node:path';
import { asPosixPath, isFsAbsolute } from '../../core/paths.js';
import { compareSessionSummaries, type SessionDiscoveryProject, type SessionInspection, type SessionPrivacy, type SessionSummary } from '../../products/contract.js';
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

const UNKNOWN_PROJECT_PREFIX = 'unknown:';
const PROJECTLESS_PROJECT_KEY = 'projectless';

function projectKey(session: SessionSummary): string {
  const cwd = canonicalHistoricalCwd(session.cwd);
  if (session.sourceKind === 'projectless') return PROJECTLESS_PROJECT_KEY;
  if (cwd) return `${session.productId}\0${cwd}`;
  // Unknown cwd is not evidence of one shared project; keep each session separate.
  return `${UNKNOWN_PROJECT_PREFIX}\0${session.productId}\0${session.sessionId}`;
}

/** A relative historical cwd cannot identify a workspace outside the original product runtime. */
function canonicalHistoricalCwd(cwd: string | undefined): string | undefined {
  const value = cwd?.trim();
  if (!value || !isFsAbsolute(value)) return undefined;
  return asPosixPath(value).replace(/\/+$/, '').toLowerCase();
}

function sessionTime(session: SessionSummary | undefined): string {
  return session?.updatedAt ?? session?.startedAt ?? '';
}

function isProjectless(key: string): boolean { return key === PROJECTLESS_PROJECT_KEY; }

function sessionStatus(session: SessionSummary, locale: Locale): string {
  if (session.availability === 'catalog-only') return t(locale, 'catalogOnlySession');
  if (session.availability === 'unindexed') return t(locale, 'unindexedSession');
  if (session.availability === 'unreadable') return t(locale, 'unreadableSession');
  if (session.partial) return t(locale, 'partialSession');
  return '';
}

function isUnknownProject(key: string): boolean {
  return key.startsWith(UNKNOWN_PROJECT_PREFIX);
}

export function projectLabel(cwd: string | undefined): string {
  if (!cwd?.trim()) return 'Unknown project';
  const name = basename(cwd.replaceAll('\\', '/'));
  return name || 'Unknown project';
}

/** Adds just enough parent path to distinguish projects with the same basename. */
function projectDisplayLabel(path: string | undefined, paths: readonly string[]): string {
  if (!path) return 'Unknown project';
  const parts = asPosixPath(path).split('/').filter(Boolean);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const candidate = parts.slice(-depth).join('/');
    const duplicates = paths.filter((value) => asPosixPath(value).split('/').filter(Boolean).slice(-depth).join('/').toLowerCase() === candidate.toLowerCase());
    if (duplicates.length === 1) return candidate;
  }
  return parts.slice(-Math.min(2, parts.length)).join('/');
}

export function sessionTitle(summary: string | undefined): string {
  const text = (summary ?? 'No task summary').replace(/\s+/g, ' ').trim();
  const stripped = text
    .replace(/^.*?["']?[A-Za-z]:[\\/][^"']+["']?[^,，:]*[,，:]\s*/u, '')
    .replace(/^[,:，]\s*/, '')
    .trim();
  return stripped || text;
}

export function groupSessionsByProject(sessions: readonly SessionSummary[], catalogProjects: readonly SessionDiscoveryProject[] = []): SessionProject[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = projectKey(session);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  for (const project of catalogProjects) if (!groups.has(project.key)) groups.set(project.key, []);
  const grouped = [...groups.entries()].map(([key, items]) => {
    const ordered = [...items].sort(compareSessionSummaries);
    const path = ordered.find((item) => item.cwd)?.cwd;
    const catalog = catalogProjects.find((item) => item.key === key);
    return { key, ...(path ? { path } : catalog?.path ? { path: catalog.path } : {}), sessions: ordered, latestAt: sessionTime(ordered[0]) || '' };
  });
  const knownPaths = grouped.flatMap((project) => project.path ? [project.path] : []);
  return grouped.map((project) => {
    if (isProjectless(project.key)) return { ...project, label: 'Projectless sessions' };
    if (isUnknownProject(project.key)) return { ...project, label: 'Unknown project' };
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

export function relativeTime(iso: string | undefined, now = Date.now(), locale: Locale = 'en'): string {
  if (!iso) return 'Unknown time';
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
    session.sessionId, session.cwd ?? '', session.summary ?? '', sessionTitle(session.summary),
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
  const start = inputs[0];
  const later = inputs.slice(1);
  const project = projectLabel(inspection.cwd);
  const tight = height !== undefined && height < 26;
  const freezePreview = wrapPreview(start?.text ?? 'unavailable', Math.max(20, width - 4), tight ? 2 : 4);
  const laterLines = later.length
    ? later.map((input, index) => ` ${index + 2}/${inputs.length}  ${compact(sessionTitle(input.text), 72, theme.glyphs.ellipsis)}`)
    : [` ${t(locale, 'noneWord')}`];
  const outcome = compact(inspection.finalMessage ?? 'unavailable', showOutcome ? 400 : 120, theme.glyphs.ellipsis);
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
    ` ${t(locale, 'privacyLabel')}    model text ${privacy.allowModelText ? t(locale, 'allowed') : t(locale, 'blocked')} ${theme.glyphs.sep} binary ${privacy.allowBinary ? t(locale, 'allowed') : t(locale, 'blocked')} ${theme.glyphs.sep} literal redactions ${privacy.redactions.length || t(locale, 'noneWord')}`,
    ` ${t(locale, 'nothingWritten')}`,
    ...(tight ? [] : [kv(theme, 'Source:', inspection.sourcePath, width - 2)]),
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
  return [['↑↓', t(locale, 'hintSelect')], ['Enter', t(locale, 'hintStartRun')], ['/', t(locale, 'hintSearch')], ['m', t(locale, 'moreSessions')], ['r', t(locale, 'refreshSessions')], ['Backspace', t(locale, 'hintProjects')], ['Esc', t(locale, 'hintBack')]];
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

function renderProjects(theme: Theme, width: number, model: SessionsModel, limit: number, showPreview = true, showSearch = true): string[] {
  const sessionCount = model.projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const locale = model.locale ?? 'en';
  const title = `${t(locale, 'projectsTitle')} ${theme.glyphs.sep} ${model.projects.length} ${theme.glyphs.sep} ${sessionCount} ${t(locale, 'sessionsWord')} ${theme.glyphs.sep} filter: ${model.filterEligible ? t(locale, 'filterEligibleLabel') : t(locale, 'filterAllLabel')}`;
  if (!model.projects.length) {
    return [...panel(theme, title, [` ${t(locale, 'noMatchingProjects')}`], width), ...(showSearch ? searchLine(theme, width, model) : [])];
  }
  const previewWidth = showPreview && showsDetailPane(theme) ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.projects.map((project, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    name: project.label,
    gap: ' ',
    count: String(project.sessions.length),
    when: relativeTime(project.latestAt, model.nowMs ?? Date.now(), locale),
  }));
  const range = visibleRange(rows, model.selected, limit);
  const listBody = paintSelectedRows(theme, fitRows(table(theme, rows.slice(range.start, range.end), [
    { key: 'marker', width: 2 },
    { key: 'name', flex: 1 },
    { key: 'gap', width: 1 },
    { key: 'count', width: 4 },
    { key: 'when', width: 12 },
  ], inner), inner), range.start, model.selected);
  listBody.push(theme.style.muted(` ${model.selected + 1}/${rows.length}`));
  const list = panel(theme, theme.style.harness(title), listBody, listWidth);
  const selected = model.projects[model.selected];
  const latest = selected?.sessions[0];
  const preview = previewWidth ? panel(theme, theme.style.harness(t(locale, 'previewTitle')), selected && latest ? [
    kv(theme, 'Project', selected.label, previewWidth - 2),
    ...kvBlock(theme, 'Path', selected.path ?? 'unavailable', previewWidth - 2),
    kv(theme, 'Sessions', String(selected.sessions.length), previewWidth - 2),
    '',
    kv(theme, 'Latest', sessionTitle(latest.summary), previewWidth - 2),
  ] : [' No project selected'], previewWidth) : [];
  const body = previewWidth ? joinColumns(list, preview, listWidth, previewWidth, 1, theme) : list;
  return [...body, ...(showSearch ? searchLine(theme, width, model) : [])];
}

function renderSessionList(theme: Theme, width: number, model: SessionsModel, limit: number, showPreview = true, showSearch = true): string[] {
  const locale = model.locale ?? 'en';
  const project = model.projects[0];
  const title = `${project?.label ?? t(locale, 'sessionsWord')} ${theme.glyphs.sep} ${model.sessions.length} ${t(locale, 'sessionsWord')} ${theme.glyphs.sep} filter: ${model.filterEligible ? t(locale, 'filterEligibleLabel') : t(locale, 'filterAllLabel')}`;
  if (!model.sessions.length) {
    return [...panel(theme, title, [model.query.trim() ? ` ${t(locale, 'noSessionsMatch')}` : ` ${t(locale, 'noEligibleSessions')}`], width), ...(showSearch ? searchLine(theme, width, model) : [])];
  }
  const previewWidth = showPreview && showsDetailPane(theme) ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.sessions.map((session, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    started: relativeTime(session.startedAt, model.nowMs ?? Date.now(), locale),
    summary: `${sessionStatus(session, locale) ? `${sessionStatus(session, locale)} ` : ''}${sessionTitle(session.summary)}`,
    gap: ' ',
    signals: `u${session.signals.userMessages} a${session.signals.assistantMessages} t${session.signals.toolCalls}`,
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
    kv(theme, 'Project', projectLabel(selected.cwd), previewWidth - 2),
    kv(theme, 'Session', selected.sessionId.slice(0, 8), previewWidth - 2),
    kv(theme, 'Started', (selected.startedAt ?? 'Unknown time').replace('T', ' ').slice(0, 16), previewWidth - 2),
    kv(theme, 'Signals', `u${selected.signals.userMessages} a${selected.signals.assistantMessages} t${selected.signals.toolCalls}`, previewWidth - 2),
    '',
    kv(theme, 'Status', sessionStatus(selected, locale) || t(locale, 'availableSession'), previewWidth - 2),
    kv(theme, 'Task', `${sessionTitle(selected.summary)}`, previewWidth - 2),
  ] : [' No session selected'], previewWidth) : [];
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

function wrapPreview(text: string, width: number, maxLines = 4): string[] {
  const lines = wrapBodyLine(text.replace(/\s+/g, ' ').trim(), Math.max(8, width));
  if (!lines.length) return ['unavailable'];
  if (lines.length <= maxLines) return lines;
  const keep = Math.max(1, maxLines - 1);
  return [...lines.slice(0, keep), compact(lines.slice(keep).join(' '), width, '...')];
}

function visibleRange<T>(items: readonly T[], selected: number, limit = 12): { start: number; end: number } {
  if (items.length <= limit) return { start: 0, end: items.length };
  const start = Math.max(0, Math.min(items.length - limit, selected - Math.floor(limit / 2)));
  return { start, end: start + limit };
}
