export type Viewport = { readonly width: number; readonly height?: number };

const HEADER_ROWS = 2;
export const FOOTER_ROWS = 2;
/** Below this the chrome is trimmed to one row each so the body keeps a usable share of the viewport. */
const SHORT_VIEWPORT_ROWS = 16;
/** Below this no layout leaves room for content, so the workbench asks for a resize instead. */
export const MIN_VIEWPORT_ROWS = 8;

export function isShortViewport(height: number | undefined): boolean {
  return height !== undefined && height < SHORT_VIEWPORT_ROWS;
}


export function bodyHeight(viewport: Viewport, messageRows: number, headerRows = HEADER_ROWS): number | undefined {
  if (viewport.height === undefined) return undefined;
  return Math.max(1, viewport.height - headerRows - FOOTER_ROWS - messageRows);
}

export function clipLines(lines: readonly string[], height: number | undefined): string[] {
  if (height === undefined || lines.length <= height) return [...lines];
  return lines.slice(0, height);
}
