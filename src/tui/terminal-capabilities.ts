import { getCapabilities, setCapabilities, type TerminalCapabilities } from '@earendil-works/pi-tui';

export type CapabilityEnv = NodeJS.ProcessEnv;

/**
 * pi-tui enables hyperlinks when WT_SESSION is set, but Windows Terminal does not
 * always export it. Call once at TUI boot to turn hyperlinks on for hosts pi-tui
 * under-detects. Never enable under GNU screen, or tmux (leave tmux to pi-tui's
 * client_termfeatures probe).
 *
 * Positive signals (documented WT env vars): WT_SESSION | WT_PROFILE_ID.
 * Residual gap: Default Terminal / Win+R hosts that export neither stay off —
 * there is no safe TERM-only heuristic that enables WT without also enabling
 * classic conhost. Parent-process walks are out of scope for this env-only path.
 */
export function upgradeTerminalCapabilities(
  env: CapabilityEnv = process.env,
): TerminalCapabilities {
  const current = getCapabilities();
  if (current.hyperlinks) return current;
  if (!shouldEnableHyperlinks(env)) return current;
  const next: TerminalCapabilities = { ...current, hyperlinks: true };
  setCapabilities(next);
  return next;
}

/** Pure helper for tests — does not mutate the pi-tui capability cache. */
export function shouldEnableHyperlinks(env: CapabilityEnv): boolean {
  const term = (env.TERM ?? '').toLowerCase();
  if (term.startsWith('screen')) return false;
  if (env.TMUX || term.startsWith('tmux')) return false;

  // Documented Windows Terminal signals (WT_SESSION already covered by pi-tui).
  if (nonEmpty(env.WT_SESSION) || nonEmpty(env.WT_PROFILE_ID)) return true;
  return false;
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value && value.length > 0);
}
