import { getCapabilities, setCapabilities, type TerminalCapabilities } from '@earendil-works/pi-tui';

export type CapabilityEnv = NodeJS.ProcessEnv;

/**
 * pi-tui enables hyperlinks when WT_SESSION is set, but Windows Terminal does not
 * always export it. Call once at TUI boot to turn hyperlinks on for hosts pi-tui
 * under-detects. Never enable under GNU screen, or tmux (leave tmux to pi-tui's
 * client_termfeatures probe).
 */
export function upgradeTerminalCapabilities(
  env: CapabilityEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TerminalCapabilities {
  const current = getCapabilities();
  if (current.hyperlinks) return current;
  if (!shouldEnableHyperlinks(env, platform)) return current;
  const next: TerminalCapabilities = { ...current, hyperlinks: true };
  setCapabilities(next);
  return next;
}

/** Pure helper for tests — does not mutate the pi-tui capability cache. */
export function shouldEnableHyperlinks(
  env: CapabilityEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  void platform;
  const term = (env.TERM ?? '').toLowerCase();
  if (term.startsWith('screen')) return false;
  if (env.TMUX || term.startsWith('tmux')) return false;

  // Positive Windows Terminal signals (WT_SESSION already covered by pi-tui).
  if (nonEmpty(env.WT_SESSION) || nonEmpty(env.WT_PROFILE_ID)) return true;
  return false;
}

function nonEmpty(value: string | undefined): boolean {
  return Boolean(value && value.length > 0);
}
