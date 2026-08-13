export type Viewport = { readonly width: number; readonly height?: number };

export const HEADER_ROWS = 2;
export const COMPACT_HEADER_ROWS = 3;
export const FOOTER_ROWS = 2;

export function headerRowCount(compact: boolean): number {
  return compact ? COMPACT_HEADER_ROWS : HEADER_ROWS;
}

export function bodyHeight(viewport: Viewport, messageRows: number, headerRows = HEADER_ROWS): number | undefined {
  if (viewport.height === undefined) return undefined;
  return Math.max(1, viewport.height - headerRows - FOOTER_ROWS - messageRows);
}

export function clipLines(lines: readonly string[], height: number | undefined): string[] {
  if (height === undefined || lines.length <= height) return [...lines];
  return lines.slice(0, height);
}
