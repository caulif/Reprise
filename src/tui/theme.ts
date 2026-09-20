export type Density = 'minimum' | 'compact' | 'regular' | 'wide';
export type ColorMode = 'off' | 'ansi' | 'truecolor';

export interface Glyphs {
  readonly tl: string;
  readonly tr: string;
  readonly bl: string;
  readonly br: string;
  readonly h: string;
  readonly v: string;
  readonly teeL: string;
  readonly teeR: string;
  readonly cursor: string;
  readonly dot: string;
  readonly ok: string;
  readonly warn: string;
  readonly err: string;
  readonly ellipsis: string;
  readonly arrow: string;
  readonly sep: string;
  readonly empty: string;
}

export type StyleFn = (text: string) => string;

export interface Theme {
  readonly density: Density;
  readonly framed: boolean;
  readonly colorMode: ColorMode;
  readonly glyphs: Glyphs;
  readonly style: {
    readonly accent: StyleFn;
    readonly muted: StyleFn;
    readonly strong: StyleFn;
    readonly harness: StyleFn;
    readonly controller: StyleFn;
    readonly target: StyleFn;
    readonly ok: StyleFn;
    readonly warn: StyleFn;
    readonly danger: StyleFn;
    readonly selected: StyleFn;
    readonly fillCanvas: StyleFn;
    readonly fillLive: StyleFn;
    readonly fillInput: StyleFn;
    readonly fillProduct: StyleFn;
    readonly fillInputSelected: StyleFn;
    readonly fillProductSelected: StyleFn;
    readonly gutterHost: StyleFn;
    readonly gutterTarget: StyleFn;
    readonly gutterFoldHost: StyleFn;
    readonly gutterFoldTarget: StyleFn;
  };
}

const UNICODE_GLYPHS: Glyphs = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', teeL: '├', teeR: '┤',
  cursor: '❯', dot: '●', ok: '✓', warn: '⚠', err: '✗', ellipsis: '…', arrow: '→', sep: '·', empty: '○',
};

const ASCII_GLYPHS: Glyphs = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', teeL: '+', teeR: '+',
  cursor: '>', dot: '*', ok: '+', warn: '!', err: 'x', ellipsis: '...', arrow: '->', sep: '-', empty: 'o',
};

export const FORBIDDEN_COMPACT = /[┌┐└┘│─❯●✓…]/;

/** Matches docs/plan/archive/reprise-tui-design.md: low-chroma body, one accent. */
const GROK = {
  accent: { ansi: '36;1', rgb: [167, 217, 190] },
  muted: { ansi: '90', rgb: [139, 153, 149] },
  harness: { ansi: '36', rgb: [167, 217, 190] },
  controller: { ansi: '36', rgb: [167, 217, 190] },
  target: { ansi: '33', rgb: [238, 176, 155] },
  ok: { ansi: '32', rgb: [167, 217, 190] },
  warn: { ansi: '33', rgb: [238, 176, 155] },
  danger: { ansi: '31', rgb: [224, 122, 122] },
  foldHost: { ansi: '90', rgb: [74, 92, 86] },
  foldTarget: { ansi: '90', rgb: [106, 83, 76] },
  selectedFg: { rgb: [220, 226, 223] },
  selectedBg: { rgb: [30, 38, 42] },
  canvasBg: { rgb: [12, 16, 18] },
  voiceInBg: { rgb: [23, 29, 32] },
  voiceOutBg: { rgb: [16, 22, 24] },
  voiceInSel: { rgb: [30, 38, 42] },
  voiceOutSel: { rgb: [24, 34, 36] },
} as const;

export function resolveDensity(width: number): Density {
  if (width < 32) return 'minimum';
  if (width < 78) return 'compact';
  if (width < 110) return 'regular';
  return 'wide';
}

export function showsDetailPane(theme: Theme): boolean {
  return theme.density === 'regular' || theme.density === 'wide';
}

/** Exported for R15 / NO_COLOR regression checks. */
export function resolveColorModeForTest(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): ColorMode {
  return resolveColorMode(env, isTty);
}

function colorSupported(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  return resolveColorMode(env, isTty) !== 'off';
}

function resolveColorMode(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): ColorMode {
  if (env.NO_COLOR || env.TERM === 'dumb' || env.FORCE_COLOR === '0') return 'off';
  if (!isTty && !env.FORCE_COLOR) return 'off';
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === '2') return 'ansi';
  if (env.FORCE_COLOR === '3' || env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  const depth = typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 0;
  if (depth >= 24) return 'truecolor';
  return 'ansi';
}

/** Call once before the TUI starts so Windows conhost / PowerShell actually paint ANSI. */
export function enableTerminalColor(): void {
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return;
  if (!process.stdout.isTTY) return;
  if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '3';
  try {
    process.stdout.hasColors?.(24);
  } catch {
    /* ignore */
  }
}

/** Themes are immutable and depend only on density and color mode, so the variants can be shared. */
const themes = new Map<string, Theme>();

export function createTheme(width: number, colored = colorSupported(), hostBackground = hostBackgroundRequested()): Theme {
  const density = resolveDensity(width);
  const mode = colored ? paintMode() : 'off';
  const key = `${density}:${mode}:${hostBackground ? 'host' : 'canvas'}`;
  const cached = themes.get(key);
  if (cached) return cached;
  const theme = buildTheme(density, mode, hostBackground);
  themes.set(key, theme);
  return theme;
}

function hostBackgroundRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REPRISE_TUI_HOST_BG === '1' || env.REPRISE_TUI_HOST_BG === 'true';
}

function paintMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === '2') return 'ansi';
  if (env.FORCE_COLOR === '3' || env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  const depth = typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 0;
  if (depth >= 24) return 'truecolor';
  return 'ansi';
}

function buildTheme(density: Density, mode: ColorMode, hostBackground: boolean): Theme {
  const framed = density === 'regular' || density === 'wide';
  const identity = (text: string) => text;
  const fillOrPlain = (rgb: readonly [number, number, number]): StyleFn =>
    hostBackground ? identity : fillPaint(mode, rgb);
  return {
    density,
    framed,
    colorMode: mode,
    glyphs: framed ? UNICODE_GLYPHS : ASCII_GLYPHS,
    style: {
      accent: paint(mode, GROK.accent.ansi, GROK.accent.rgb),
      muted: paint(mode, GROK.muted.ansi, GROK.muted.rgb),
      strong: paint(mode, '1'),
      harness: paint(mode, GROK.harness.ansi, GROK.harness.rgb),
      controller: paint(mode, GROK.controller.ansi, GROK.controller.rgb),
      target: paint(mode, GROK.target.ansi, GROK.target.rgb),
      ok: paint(mode, GROK.ok.ansi, GROK.ok.rgb),
      warn: paint(mode, GROK.warn.ansi, GROK.warn.rgb),
      danger: paint(mode, GROK.danger.ansi, GROK.danger.rgb),
      selected: selectedPaint(mode),
      fillCanvas: fillOrPlain(GROK.canvasBg.rgb),
      fillLive: hostBackground ? selectedPaint(mode) : fillPaint(mode, GROK.selectedBg.rgb),
      fillInput: fillOrPlain(GROK.voiceInBg.rgb),
      fillProduct: fillOrPlain(GROK.voiceOutBg.rgb),
      fillInputSelected: hostBackground ? selectedPaint(mode) : fillPaint(mode, GROK.voiceInSel.rgb),
      fillProductSelected: hostBackground ? selectedPaint(mode) : fillPaint(mode, GROK.voiceOutSel.rgb),
      gutterHost: paint(mode, GROK.harness.ansi, GROK.harness.rgb),
      gutterTarget: paint(mode, GROK.target.ansi, GROK.target.rgb),
      gutterFoldHost: paint(mode, GROK.foldHost.ansi, GROK.foldHost.rgb),
      gutterFoldTarget: paint(mode, GROK.foldTarget.ansi, GROK.foldTarget.rgb),
    },
  };
}

function withBackground(text: string, bg: string): string {
  return `${bg}${text.replaceAll('\x1b[0m', `\x1b[0m${bg}`)}\x1b[0m`;
}

function paint(mode: ColorMode, ansi: string, rgb?: readonly [number, number, number]): StyleFn {
  if (mode === 'off') return (text) => text;
  if (mode === 'truecolor' && rgb) {
    return (text) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m`;
  }
  return (text) => `\x1b[${ansi}m${text}\x1b[0m`;
}

function fillPaint(mode: ColorMode, rgb: readonly [number, number, number]): StyleFn {
  if (mode === 'off') return (text) => text;
  const bg = `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return (text) => withBackground(text, bg);
}

function selectedPaint(mode: ColorMode): StyleFn {
  if (mode === 'off') return (text) => text;
  if (mode === 'truecolor') {
    const [fr, fg, fb] = GROK.selectedFg.rgb;
    const [br, bg, bb] = GROK.selectedBg.rgb;
    return (text) => `\x1b[48;2;${br};${bg};${bb}m\x1b[38;2;${fr};${fg};${fb}m${text}\x1b[0m`;
  }
  return (text) => `\x1b[7m${text}\x1b[0m`;
}
