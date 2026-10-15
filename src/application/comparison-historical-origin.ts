import type { ComparisonLinkRecord } from '../core/schema.js';

export function isHistoricalFinalLink(link: ComparisonLinkRecord): boolean {
  return link.side === 'baseline' && ['historical_artifact', 'reconstructed_from_history', 'captured_file', 'git_snapshot', 'user_selected_substitute'].includes(link.origin ?? '');
}
