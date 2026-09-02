import { compact, truncateFit, type TimelineFilter } from './format.js';
import { t, type Locale } from './i18n.js';
import type { Theme } from './theme.js';
import type { TimelineEntry } from './timeline.js';
import { pad, wrapBodyLine } from './widgets.js';

export type Voice = 'input' | 'product' | 'summary' | 'controller';

function voiceOf(entry: TimelineEntry): Voice | undefined {
  if (entry.hidden) return undefined;
  if (isQuietMcpStatus(entry)) return undefined;
  if (entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·')) return 'input';
  if (entry.kind === 'narrate') {
    if (entry.lane === 'comparison') return 'summary';
    if (entry.lane === 'recovery') return 'summary';
    return 'controller';
  }
  if (entry.kind === 'fold') return 'controller';
  if (entry.title.startsWith('Recovery')) return 'summary';
  if (entry.title.startsWith('Decision:') || entry.title.startsWith('Controller ·') || entry.lane === 'controller') {
    return 'controller';
  }
  if (entry.title.startsWith('Working') || entry.title.startsWith('State:')
    || entry.title.startsWith('Turn settled') || entry.title.startsWith('Isolation')
    || entry.title.startsWith('Runtime') || entry.title.startsWith('Stage')) {
    return undefined;
  }
  if (entry.source === 'HARNESS' && entry.level !== 'error' && entry.lane !== 'comparison' && entry.lane !== 'recovery') {
    return undefined;
  }
  if (entry.title.startsWith('Comparison') || entry.lane === 'comparison' || entry.title.startsWith('Candidate stopped')
    || entry.title.startsWith('Controller done') || entry.title.startsWith('Stop requested')) {
    return 'summary';
  }
  if (entry.source === 'TARGET' || entry.level === 'error') return 'product';
  if (entry.source === 'CONTROLLER') return 'controller';
  return undefined;
}

export function matchesFilter(entry: TimelineEntry, filter: TimelineFilter): boolean {
  const voice = voiceOf(entry);
  if (!voice) return false;
  if (filter === 'ALL') return true;
  if (filter === 'INPUT') return voice === 'input';
  if (filter === 'PRODUCT') return voice === 'product';
  return true;
}

export function matchesCanvasQuery(entry: TimelineEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.title, entry.detail, entry.original].some((part) => part?.toLowerCase().includes(needle));
}

export function renderScrollback(
  theme: Theme,
  width: number,
  entries: readonly TimelineEntry[],
  selected: number,
  locale: Locale,
  product: string,
  height?: number,
  tick = 0,
): string[] {
  const groups = groupVoices(entries);
  const lines: string[] = [];
  let selectedAt = 0;
  for (const group of groups) {
    if (lines.length) lines.push(fillCanvas(theme, '', width));
    const picked = group.items.some((item) => item.index === selected);
    const writing = group.voice === 'product' && group.items.some((item) => item.entry.title === 'Writing');
    const live = group.items.some((item) => item.entry.placeholder || item.entry.kind === 'live');
    const card = renderVoiceCard(theme, group, selected, width, locale, product, writing || live, tick, picked);
    if (picked) selectedAt = lines.length + card.selectedOffset;
    lines.push(...card.lines);
  }
  if (!lines.length) {
    return [fillCanvas(theme, ` ${theme.style.muted(t(locale, 'writing', { product }))}`, width)];
  }
  if (height === undefined || lines.length <= height) return lines;
  const start = Math.max(0, Math.min(selectedAt, lines.length - height));
  return lines.slice(start, start + height);
}

function groupVoices(entries: readonly TimelineEntry[]): VoiceGroup[] {
  const groups: VoiceGroup[] = [];
  for (const [index, entry] of entries.entries()) {
    const voice = voiceOf(entry);
    if (!voice) continue;
    const last = groups.at(-1);
    if (last && last.voice === voice) last.items.push({ entry, index });
    else groups.push({ voice, items: [{ entry, index }] });
  }
  return groups;
}

function renderVoiceCard(
  theme: Theme,
  group: VoiceGroup,
  selected: number,
  width: number,
  locale: Locale,
  product: string,
  writing: boolean,
  tick: number,
  picked: boolean,
): { readonly lines: readonly string[]; readonly selectedOffset: number } {
  const header = voiceHeader(theme, group, locale, product, writing, tick);
  const body: string[] = [];
  let selectedOffset = 0;
  for (const item of group.items) {
    if (item.index === selected) selectedOffset = 1 + body.length;
    body.push(...voiceBody(theme, item.entry, item.index === selected, width, locale, product));
  }
  return {
    lines: [header, ...body].map((line) => fillVoice(theme, group.voice, line, width, picked)),
    selectedOffset,
  };
}

function voiceHeader(
  theme: Theme,
  group: VoiceGroup,
  locale: Locale,
  product: string,
  writing: boolean,
  tick: number,
): string {
  if (group.voice === 'input') {
    const first = group.items[0]?.entry;
    const kind = first?.title.startsWith('Prompt ·') || first?.title.startsWith('Input to Target')
      ? t(locale, 'historicalTask')
      : t(locale, 'followUp');
    return theme.style.controller(` ${t(locale, 'toProduct', { product })} · ${kind}`);
  }
  if (group.voice === 'controller') {
    return theme.style.controller(` ${t(locale, 'controllerLegend')}`);
  }
  if (group.voice === 'summary') {
    const first = group.items[0]?.entry.title ?? '';
    const comparison = first.startsWith('Comparison') || group.items[0]?.entry.lane === 'comparison';
    return theme.style.ok(` ${t(locale, first.startsWith('Recovery') ? 'recoveryLegend' : comparison ? 'comparisonTitle' : 'recoveryLegend')}`);
  }
  const pulse = writing && Math.floor(tick / 400) % 2 === 0 ? `${theme.style.target(theme.glyphs.dot)} ` : writing ? `${theme.style.muted(theme.glyphs.empty)} ` : '';
  return `${pulse}${theme.style.target(` ${product}`)}`;
}

function voiceBody(
  theme: Theme,
  entry: TimelineEntry,
  selected: boolean,
  width: number,
  locale: Locale,
  product: string,
): string[] {
  const inner = Math.max(8, width - 4);
  const hook = theme.framed ? '⎿ ' : '| ';
  if (voiceOf(entry) === 'input') {
    return wrapBodyLine(inputText(entry), inner).map((line) => ` ${line}`);
  }
  if (entry.lane || entry.title.startsWith('Decision:') || entry.title.startsWith('Recovery ·') || entry.title.startsWith('Comparison ·')) {
    return agentLines(theme, entry, selected, inner);
  }
  if (isCommand(entry)) {
    const preview = commandPreview(entry, hook, locale);
    if (!selected) {
      const status = commandFailed(entry) ? ` ${theme.style.danger(t(locale, 'failed'))}` : '';
      return [` ${theme.style.target(compact(commandLine(entry), inner - 8, theme.glyphs.ellipsis))}${status}`];
    }
    return preview.map((line) => line.startsWith('$ ')
      ? ` ${theme.style.target(line)}`
      : ` ${theme.style.muted(line)}`);
  }
  if (isMessage(entry)) {
    const text = entry.detail?.trim() || (entry.title === 'Writing' ? t(locale, 'writing', { product }) : entry.title);
    const painted = wrapBodyLine(text, inner).map((line) => ` ${line}`);
    return entry.title === 'Writing' ? painted.map((line) => theme.style.muted(line)) : painted;
  }
  if (isFileChange(entry)) {
    const path = (entry.detail ?? entry.title).split(/\r?\n/)[0] ?? entry.title;
    return [` ${theme.style.target(`~ ${compact(path, inner - 4, theme.glyphs.ellipsis)}`)}`];
  }
  if (entry.title.startsWith('MCP ·')) {
    const line = compact(entry.detail ? `${entry.title} · ${entry.detail}` : entry.title, inner, theme.glyphs.ellipsis);
    return [` ${entry.level === 'error' || entry.level === 'warning' ? theme.style.danger(line) : theme.style.muted(line)}`];
  }
  const fallback = entry.detail?.split(/\r?\n/)[0] || entry.title;
  return [` ${selected ? theme.style.strong(truncateFit(fallback, inner, theme.glyphs.ellipsis)) : truncateFit(fallback, inner, theme.glyphs.ellipsis)}`];
}

function fillVoice(theme: Theme, voice: Voice, text: string, width: number, selected: boolean): string {
  const bar = theme.framed ? '▎' : '|';
  const paintedBar = voice === 'input' || voice === 'controller'
    ? theme.style.controller(bar)
    : voice === 'summary' ? theme.style.ok(bar) : theme.style.target(bar);
  const line = `${paintedBar}${pad(text, Math.max(0, width - 1), theme.glyphs.ellipsis)}`;
  if (voice === 'input' || voice === 'controller') return selected ? theme.style.fillInputSelected(line) : theme.style.fillInput(line);
  if (voice === 'summary') return selected ? theme.style.fillProductSelected(line) : theme.style.fillCanvas(line);
  return selected ? theme.style.fillProductSelected(line) : theme.style.fillProduct(line);
}

function fillCanvas(theme: Theme, text: string, width: number): string {
  return theme.style.fillCanvas(pad(text, width, theme.glyphs.ellipsis));
}

function agentLines(
  theme: Theme,
  entry: TimelineEntry,
  selected: boolean,
  inner: number,
): string[] {
  const verb = compact(entry.title.replace(/^(Recovery|Controller|Comparison) · /, ''), Math.max(8, inner - 24), theme.glyphs.ellipsis);
  const object = entry.detail?.split(/\r?\n/)[0] ?? '';
  const paint = entry.level === 'error' ? theme.style.danger : entry.lane === 'controller' || entry.title.startsWith('Decision:')
    ? theme.style.controller
    : theme.style.target;
  const line = object ? `${verb}  ${object}` : verb;
  const main = [` ${paint(compact(line, inner, theme.glyphs.ellipsis))}`];
  if (!selected) return main;
  const extra = (entry.original ?? entry.detail ?? '').split(/\r?\n/).slice(0, 6);
  if (extra.length <= 1) return main;
  return [...main, ...extra.slice(1).map((row) => ` ${theme.style.muted(compact(row, inner, theme.glyphs.ellipsis))}`)];
}

function inputText(entry: TimelineEntry): string {
  if (entry.title.startsWith('Prompt ·')) return entry.title.slice('Prompt · '.length) || entry.detail || entry.title;
  return entry.detail?.trim() || entry.title;
}

function isCommand(entry: TimelineEntry): boolean {
  return entry.title.includes('pwsh') || entry.title.startsWith('Running ·') || Boolean(entry.detail?.startsWith('$ '));
}

function isMessage(entry: TimelineEntry): boolean {
  return entry.title === 'Visible response' || entry.title === 'Writing' || entry.title.startsWith('Visible response');
}

function isFileChange(entry: TimelineEntry): boolean {
  return entry.title === 'File change' || entry.title === 'Changing files';
}

function isQuietMcpStatus(entry: TimelineEntry): boolean {
  if (entry.level === 'error' || entry.level === 'warning') return false;
  return /^MCP · \S+ (ready|ok|connected|started)$/i.test(entry.title);
}

function commandLine(entry: TimelineEntry): string {
  const fromDetail = entry.detail?.split(/\r?\n/).find((line) => line.startsWith('$ '));
  if (fromDetail) return fromDetail;
  return `$ ${entry.title.replace(/^Running · /, '')}`;
}

function commandFailed(entry: TimelineEntry): boolean {
  return entry.level === 'error' || Boolean(entry.detail && /exit [1-9]/.test(entry.detail));
}

function commandPreview(entry: TimelineEntry, hook: string, locale: Locale): string[] {
  if (!entry.detail) return [commandLine(entry)];
  const lines = entry.detail.split(/\r?\n/);
  return lines.map((line) => {
    if (line.startsWith('$ ')) return line;
    if (line.startsWith('| ')) return `${hook}${line.slice(2)}`;
    if (line.startsWith('... ')) {
      const count = /\+(\d+)/.exec(line)?.[1];
      return count ? t(locale, 'moreLines', { n: count }) : line;
    }
    return line;
  });
}

type VoiceGroup = {
  readonly voice: Voice;
  readonly items: { entry: TimelineEntry; index: number }[];
};
