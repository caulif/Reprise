/** Shared workbench region geometry for paint and pointer hit-testing. */

export type WorkbenchRect = {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
};

export type WorkbenchGeometry = {
  readonly width: number;
  readonly height: number;
  readonly header: WorkbenchRect;
  readonly rail: WorkbenchRect;
  readonly body: WorkbenchRect;
  readonly message: WorkbenchRect;
  readonly footer: WorkbenchRect;
};

/** Stack fixed chrome top-to-bottom; body takes whatever rows remain (may be 0). */
export function composeWorkbenchGeometry(input: {
  readonly width: number;
  readonly height: number;
  readonly headerRows: number;
  readonly railRows: number;
  readonly messageRows: number;
  readonly footerRows: number;
}): WorkbenchGeometry {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const headerRows = Math.max(0, input.headerRows);
  const railRows = Math.max(0, input.railRows);
  const messageRows = Math.max(0, input.messageRows);
  const footerRows = Math.max(0, input.footerRows);
  const chrome = headerRows + railRows + messageRows + footerRows;
  const bodyRows = Math.max(0, height - chrome);
  let row = 0;
  const header = rect(row, width, headerRows);
  row += headerRows;
  const rail = rect(row, width, railRows);
  row += railRows;
  const body = rect(row, width, bodyRows);
  row += bodyRows;
  const message = rect(row, width, messageRows);
  row += messageRows;
  const footer = rect(row, width, footerRows);
  return { width, height, header, rail, body, message, footer };
}

/** Map 1-based SGR coordinates onto the body; outside the body rect is a miss (no clamp). */
export function bodyCellAt(
  geometry: WorkbenchGeometry,
  terminalRow: number,
  terminalCol: number,
): { readonly bodyRow: number; readonly col: number } | undefined {
  const y = terminalRow - 1;
  const x = terminalCol - 1;
  const { body } = geometry;
  if (y < body.row || y >= body.row + body.height) return undefined;
  if (x < body.col || x >= body.col + body.width) return undefined;
  return { bodyRow: y - body.row, col: terminalCol };
}

function rect(row: number, width: number, height: number): WorkbenchRect {
  return { row, col: 0, width, height };
}
