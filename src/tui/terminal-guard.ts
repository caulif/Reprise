/** Same DEC private modes as pi-tui TuiAltScreen. */
const ENABLE_ALL_MOTION = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h';
const ENABLE_BUTTON_MOTION = '\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h';
export const DISABLE_MOUSE_REPORTING = '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l';

export type TerminalRestoreHost = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
};

export function mouseReportingSequence(enabled: boolean): string {
  if (!enabled) return DISABLE_MOUSE_REPORTING;
  const term = process.env.TERM?.toLowerCase() ?? '';
  const mux = process.env.TMUX !== undefined
    || process.env.ZELLIJ !== undefined
    || process.env.STY !== undefined
    || term.startsWith('tmux')
    || term.startsWith('screen');
  return mux ? ENABLE_BUTTON_MOTION : ENABLE_ALL_MOTION;
}

/** Restore alt-screen/raw/mouse on process exit and uncaught failures. stop() must be idempotent. */
export function installTerminalRestoreGuard(
  stop: () => void,
  host: TerminalRestoreHost = process,
): () => void {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      stop();
    } catch {
      /* terminal already torn down or never entered alt screen */
    }
  };
  const events = ['exit', 'uncaughtException', 'unhandledRejection'] as const;
  for (const event of events) host.on(event, restore);
  return () => {
    restored = true;
    for (const event of events) {
      host.off?.(event, restore);
      host.removeListener?.(event, restore);
    }
  };
}
