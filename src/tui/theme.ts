export type Density = 'minimum' | 'compact' | 'regular' | 'wide';

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

export function resolveDensity(width: number): Density {
  if (width < 32) return 'minimum';
  if (width < 78) return 'compact';
  if (width < 110) return 'regular';
  return 'wide';
}

export function colorSupported(env: NodeJS.ProcessEnv = process.env, isTty = Boolean(process.stdout.isTTY)): boolean {
  if (env.NO_COLOR || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(isTty);
}

export function createTheme(width: number, colored = colorSupported()): Theme {
  const density = resolveDensity(width);
  const framed = density === 'regular' || density === 'wide';
  const paint = (code: string): StyleFn => colored ? (text) => `\x1b[${code}m${text}\x1b[0m` : (text) => text;
  return {
    density,
    framed,
    glyphs: framed ? UNICODE_GLYPHS : ASCII_GLYPHS,
    style: {
      accent: paint('36;1'),
      muted: paint('2'),
      strong: paint('1'),
      harness: paint('34'),
      controller: paint('35'),
      target: paint('36'),
      ok: paint('32'),
      warn: paint('33'),
      danger: paint('31'),
    },
  };
}
