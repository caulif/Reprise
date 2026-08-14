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
    readonly fillInput: StyleFn;
    readonly fillProduct: StyleFn;
    readonly fillInputSelected: StyleFn;
    readonly fillProductSelected: StyleFn;
  };
}

export const UNICODE_GLYPHS: Glyphs = {
  tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', teeL: '├', teeR: '┤',
  cursor: '❯', dot: '●', ok: '✓', warn: '⚠', err: '✗', ellipsis: '…', arrow: '→', sep: '·', empty: '○',
};

export const ASCII_GLYPHS: Glyphs = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', teeL: '+', teeR: '+',
  cursor: '>', dot: '*', ok: '+', warn: '!', err: 'x', ellipsis: '...', arrow: '->', sep: '-', empty: 'o',
};

export const FORBIDDEN_COMPACT = /[┌┐└┘│─❯●✓…]/;

/** Matches docs/plan/grok-style-tui-mockups.html */
const GROK = {
  accent: { ansi: '96;1', rgb: [34, 211, 238] },
  muted: { ansi: '90', rgb: [139, 149, 168] },
  harness: { ansi: '94', rgb: [96, 165, 250] },
  controller: { ansi: '95', rgb: [232, 121, 249] },
  target: { ansi: '96', rgb: [34, 211, 238] },
  ok: { ansi: '92', rgb: [74, 222, 128] },
  warn: { ansi: '93', rgb: [250, 204, 21] },
  danger: { ansi: '91', rgb: [248, 113, 113] },
  selectedFg: { rgb: [229, 231, 235] },
  selectedBg: { rgb: [19, 36, 60] },
  canvasBg: { rgb: [13, 20, 36] },
  voiceInBg: { rgb: [26, 18, 36] },
  voiceOutBg: { rgb: [11, 28, 36] },
  voiceInSel: { rgb: [42, 26, 58] },
  voiceOutSel: { rgb: [18, 48, 64] },
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

export function colorSupported(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  return resolveColorMode(env, isTty) !== 'off';
}

export function resolveColorMode(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): ColorMode {
  if (env.NO_COLOR || env.TERM === 'dumb' || env.FORCE_COLOR === '0') return 'off';
  if (!isTty && !env.FORCE_COLOR) return 'off';
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === '2') return 'ansi';
  if (env.FORCE_COLOR === '3' || env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  const depth = typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 0;
  if (depth >= 24 || process.platform === 'win32') return 'truecolor';
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

export function createTheme(width: number, colored = colorSupported()): Theme {
  const density = resolveDensity(width);
  const mode = colored ? paintMode() : 'off';
  const key = `${density}:${mode}`;
  const cached = themes.get(key);
  if (cached) return cached;
  const theme = buildTheme(density, mode);
  themes.set(key, theme);
  return theme;
}

function paintMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.FORCE_COLOR === '1' || env.FORCE_COLOR === '2') return 'ansi';
  if (env.FORCE_COLOR === '3' || env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  const depth = typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 0;
  if (depth >= 24 || process.platform === 'win32') return 'truecolor';
  return 'ansi';
}

function buildTheme(density: Density, mode: ColorMode): Theme {
  const framed = density === 'regular' || density === 'wide';
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
      fillCanvas: fillPaint(mode, GROK.canvasBg.rgb),
      fillInput: fillPaint(mode, GROK.voiceInBg.rgb),
      fillProduct: fillPaint(mode, GROK.voiceOutBg.rgb),
      fillInputSelected: fillPaint(mode, GROK.voiceInSel.rgb),
      fillProductSelected: fillPaint(mode, GROK.voiceOutSel.rgb),
    },
  };
}

export function withBackground(text: string, bg: string): string {
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
