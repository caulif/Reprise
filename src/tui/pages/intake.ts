import { basename, dirname } from 'node:path';
import type { CodexSessionInspection, CodexSessionPrivacy, CodexSessionSummary } from '../../products/codex/sessions.js';
import { compact, truncateFit } from '../format.js';
import type { Theme } from '../theme.js';
import { joinColumns, kv, panel, table, wrapBodyLine } from '../widgets.js';

export type IntakeLevel = 'projects' | 'sessions';

export type SessionProject = {
  readonly key: string;
  readonly label: string;
  readonly path?: string;
  readonly sessions: readonly CodexSessionSummary[];
  readonly latestAt: string;
};

export type SessionsModel = {
  readonly level: IntakeLevel;
  readonly projects: readonly SessionProject[];
  readonly sessions: readonly CodexSessionSummary[];
  readonly selected: number;
  readonly filterEligible: boolean;
  readonly query: string;
  readonly searching: boolean;
};

export type InspectionModel = {
  readonly inspection: CodexSessionInspection;
  readonly privacy: CodexSessionPrivacy;
  readonly selectedTaskInput: number;
  readonly showOutcome: boolean;
};

const OTHER_PROJECT = 'other';

export function projectKey(cwd: string | undefined): string {
  const normalized = cwd?.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return normalized || OTHER_PROJECT;
}

export function projectLabel(cwd: string | undefined): string {
  if (!cwd?.trim()) return '其他';
  const name = basename(cwd.replaceAll('\\', '/'));
  return name || '其他';
}

export function sessionTitle(summary: string | undefined): string {
  const text = (summary ?? 'No task summary').replace(/\s+/g, ' ').trim();
  const stripped = text
    .replace(/^对于\s*"[^"]+"这个ppt[，,]\s*/i, '')
    .replace(/^对于\s*"[^"]+"[，,]\s*/i, '')
    .replace(/^(?:对于\s*)?["']?[A-Za-z]:[\\/][^\s"']+["']?\s*/u, '')
    .replace(/^这个ppt[，,]\s*/i, '')
    .replace(/^[,:，]\s*/, '')
    .trim();
  return stripped || text;
}

export function groupSessionsByProject(sessions: readonly CodexSessionSummary[]): SessionProject[] {
  const groups = new Map<string, CodexSessionSummary[]>();
  for (const session of sessions) {
    const key = projectKey(session.cwd);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  const grouped = [...groups.entries()].map(([key, items]) => {
    const ordered = [...items].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const path = ordered.find((item) => item.cwd)?.cwd;
    return {
      key,
      label: key === OTHER_PROJECT ? '其他' : projectLabel(path),
      ...(path ? { path } : {}),
      sessions: ordered,
      latestAt: ordered[0]?.startedAt ?? '',
    };
  }).sort((left, right) => {
    if (left.key === OTHER_PROJECT) return 1;
    if (right.key === OTHER_PROJECT) return -1;
    return right.latestAt.localeCompare(left.latestAt);
  });
  const counts = new Map<string, number>();
  for (const project of grouped) counts.set(project.label, (counts.get(project.label) ?? 0) + 1);
  return grouped.map((project) => {
    if (project.key === OTHER_PROJECT || (counts.get(project.label) ?? 0) < 2 || !project.path) return project;
    const parent = basename(dirname(project.path.replaceAll('\\', '/')));
    return parent ? { ...project, label: `${parent}/${project.label}` } : project;
  });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso.replace('T', ' ').slice(0, 16);
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return iso.slice(0, 10);
}

export function matchesIntakeQuery(session: CodexSessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    session.sessionId, session.cwd ?? '', session.summary ?? '', sessionTitle(session.summary),
    projectLabel(session.cwd), session.startedAt,
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}

export function matchesProjectQuery(project: SessionProject, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (`${project.label} ${project.path ?? ''}`.toLowerCase().includes(needle)) return true;
  return project.sessions.some((session) => matchesIntakeQuery(session, query));
}

export function renderSessions(theme: Theme, width: number, model: SessionsModel): string[] {
  if (model.level === 'projects') return renderProjects(theme, width, model);
  return renderSessionList(theme, width, model);
}

export function renderInspection(theme: Theme, width: number, model: InspectionModel, height?: number): string[] {
  const { inspection, privacy, selectedTaskInput, showOutcome } = model;
  const inputs = inspection.transcript.filter((message) => message.role === 'user');
  const selected = inputs[selectedTaskInput];
  const project = projectLabel(inspection.cwd);
  const tight = height !== undefined && height < 26;
  const taskLine = ` Task input ${selected ? `${selectedTaskInput + 1}/${inputs.length}: ${compact(sessionTitle(selected.text), 72, theme.glyphs.ellipsis)}` : 'unavailable'} ${theme.glyphs.sep} Up/Down selects`;
  const candidates = inputs.map((input, index) => (
    ` ${index === selectedTaskInput ? theme.glyphs.cursor : ' '} ${index + 1}/${inputs.length}  ${compact(sessionTitle(input.text), 72, theme.glyphs.ellipsis)}`
  ));
  const freezePreview = wrapPreview(selected?.text ?? 'unavailable', Math.max(20, width - 4), tight ? 2 : 4);
  const outcome = compact(inspection.finalMessage ?? 'unavailable', showOutcome ? 400 : 120, theme.glyphs.ellipsis);
  const meta = ` ${project} ${theme.glyphs.sep} ${relativeTime(inspection.startedAt)} ${theme.glyphs.sep} u${inspection.signals.userMessages} a${inspection.signals.assistantMessages} t${inspection.signals.toolCalls}`;
  const ruleWidth = Math.max(1, width - (theme.framed ? 2 : 3));
  const rule = theme.glyphs.h.repeat(ruleWidth);
  const body = [
    ' This highlights the user message that Enter will freeze as an immutable TaskCase. Codex does not start yet.',
    meta,
    rule,
    taskLine,
    ...candidates,
    rule,
    ' Freeze this message:',
    ...freezePreview.map((line) => ` ${line}`),
    rule,
    ` Outcome    ${outcome}`,
    ` Privacy    model text ${privacy.allowModelText ? 'allowed' : 'blocked'} ${theme.glyphs.sep} binary ${privacy.allowBinary ? 'allowed' : 'blocked'} ${theme.glyphs.sep} literal redactions ${privacy.redactions.length || 'none'}`,
    ' Nothing is written until you press Enter.',
    ...(tight ? [] : [kv(theme, 'Source:', inspection.sourcePath, width - 2)]),
  ];
  const inner = height === undefined ? body.length : Math.max(1, height - (theme.framed ? 2 : 1));
  const clipped = body.length <= inner ? body : [...body.slice(0, inner - 1), ` ${theme.glyphs.ellipsis}`];
  return panel(theme, `Choose task start ${theme.glyphs.sep} ${project}`, clipped, width);
}

export function sessionsHints(model?: SessionsModel): readonly (readonly [string, string])[] {
  if (model?.searching) return [['Esc', 'Clear search'], ['↑↓', 'Select'], ['Enter', 'Open']];
  if (model?.level === 'projects') {
    return [['↑↓', 'Select'], ['Enter', 'Open project'], ['/', 'Search'], ['f', 'Filter'], ['Esc', 'Home']];
  }
  return [['↑↓', 'Select'], ['Enter', 'Inspect'], ['/', 'Search'], ['Backspace', 'Projects'], ['Esc', 'Back']];
}

export function inspectionHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Freeze this message'], ['↑↓', 'Select task start'], ['d', 'Expand outcome'], ['t', 'Toggle model text'], ['Esc', 'Back']];
}

function renderProjects(theme: Theme, width: number, model: SessionsModel): string[] {
  const sessionCount = model.projects.reduce((sum, project) => sum + project.sessions.length, 0);
  const title = `Projects ${theme.glyphs.sep} ${model.projects.length} ${theme.glyphs.sep} ${sessionCount} sessions ${theme.glyphs.sep} filter: ${model.filterEligible ? 'eligible' : 'all'}`;
  if (!model.projects.length) {
    return [...panel(theme, title, [' No matching projects.'], width), ...searchLine(theme, width, model)];
  }
  const previewWidth = theme.density === 'wide' ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.projects.map((project, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    name: project.label,
    gap: ' ',
    count: String(project.sessions.length),
    when: relativeTime(project.latestAt),
  }));
  const listBody = fitRows(table(theme, rows, [
    { key: 'marker', width: 2 },
    { key: 'name', flex: 1 },
    { key: 'gap', width: 1 },
    { key: 'count', width: 4 },
    { key: 'when', width: 12 },
  ], inner), inner);
  const list = panel(theme, title, listBody, listWidth);
  const selected = model.projects[model.selected];
  const latest = selected?.sessions[0];
  const preview = previewWidth ? panel(theme, 'Preview', selected && latest ? [
    kv(theme, 'Project', selected.label, previewWidth - 2),
    kv(theme, 'Path', compact(shortPath(selected.path ?? 'unavailable'), Math.max(8, previewWidth - 16), theme.glyphs.ellipsis), previewWidth - 2),
    kv(theme, 'Sessions', String(selected.sessions.length), previewWidth - 2),
    '',
    kv(theme, 'Latest', sessionTitle(latest.summary), previewWidth - 2),
  ] : [' No project selected'], previewWidth) : [];
  const body = previewWidth ? joinColumns(list, preview, listWidth, previewWidth, 1, theme) : list;
  return [...body, ...searchLine(theme, width, model)];
}

function renderSessionList(theme: Theme, width: number, model: SessionsModel): string[] {
  const project = model.projects[0];
  const title = `${project?.label ?? 'Sessions'} ${theme.glyphs.sep} ${model.sessions.length} sessions ${theme.glyphs.sep} filter: ${model.filterEligible ? 'eligible' : 'all'}`;
  if (!model.sessions.length) {
    return [...panel(theme, title, [' No eligible historical sessions.'], width), ...searchLine(theme, width, model)];
  }
  const previewWidth = theme.density === 'wide' ? Math.max(28, Math.floor(width * 0.34)) : 0;
  const listWidth = previewWidth ? width - previewWidth - 1 : width;
  const inner = Math.max(20, listWidth - (theme.framed ? 2 : 3));
  const rows = model.sessions.map((session, index) => ({
    marker: `${index === model.selected ? theme.glyphs.cursor : ' '} `,
    started: relativeTime(session.startedAt),
    summary: sessionTitle(session.summary),
    gap: ' ',
    signals: `u${session.signals.userMessages} a${session.signals.assistantMessages} t${session.signals.toolCalls}`,
  }));
  const listBody = fitRows(table(theme, rows, [
    { key: 'marker', width: 2 },
    { key: 'started', width: 12 },
    { key: 'summary', flex: 1 },
    { key: 'gap', width: 1 },
    { key: 'signals', width: 14 },
  ], inner), inner);
  const list = panel(theme, title, listBody, listWidth);
  const selected = model.sessions[model.selected];
  const preview = previewWidth ? panel(theme, 'Preview', selected ? [
    kv(theme, 'Project', projectLabel(selected.cwd), previewWidth - 2),
    kv(theme, 'Session', selected.sessionId.slice(0, 8), previewWidth - 2),
    kv(theme, 'Started', selected.startedAt.replace('T', ' ').slice(0, 16), previewWidth - 2),
    kv(theme, 'Signals', `u${selected.signals.userMessages} a${selected.signals.assistantMessages} t${selected.signals.toolCalls}`, previewWidth - 2),
    '',
    kv(theme, 'Task', sessionTitle(selected.summary), previewWidth - 2),
  ] : [' No session selected'], previewWidth) : [];
  const body = previewWidth ? joinColumns(list, preview, listWidth, previewWidth, 1, theme) : list;
  return [...body, ...searchLine(theme, width, model)];
}

function searchLine(theme: Theme, width: number, model: SessionsModel): string[] {
  const prefix = model.searching ? ' Search: ' : ' [/] Search';
  const value = model.searching ? `${model.query}▌` : '';
  return ['', truncateFit(`${prefix}${value}`, Math.max(8, width), theme.glyphs.ellipsis)];
}

function fitRows(rows: readonly string[], width: number): string[] {
  return rows.map((row) => truncateFit(row, width, '...'));
}

function shortPath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

function wrapPreview(text: string, width: number, maxLines = 4): string[] {
  const lines = wrapBodyLine(text.replace(/\s+/g, ' ').trim(), Math.max(8, width));
  if (!lines.length) return ['unavailable'];
  if (lines.length <= maxLines) return lines;
  const keep = Math.max(1, maxLines - 1);
  return [...lines.slice(0, keep), compact(lines.slice(keep).join(' '), width, '...')];
}
