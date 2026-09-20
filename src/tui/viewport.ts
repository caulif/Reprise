/** Below this the chrome is trimmed to one row each so the body keeps a usable share of the viewport. */
const SHORT_VIEWPORT_ROWS = 16;
/** Below this no layout leaves room for content, so the workbench asks for a resize instead. */
export const MIN_VIEWPORT_ROWS = 8;

export function isShortViewport(height: number | undefined): boolean {
  return height !== undefined && height < SHORT_VIEWPORT_ROWS;
}

export function clipLines(lines: readonly string[], height: number | undefined, offset = 0): string[] {
  if (height === undefined || lines.length <= height) return [...lines];
  const start = Math.max(0, Math.min(offset, lines.length - height));
  return lines.slice(start, start + height);
}
