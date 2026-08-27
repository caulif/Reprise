import { pathContainedBy, sameFsPath } from '../../core/paths.js';
import type { SessionDiscoveryQuery, SessionSummary } from '../contract.js';

export type SessionExclusionQuery = Pick<
  SessionDiscoveryQuery,
  'excludeSessionIds' | 'excludeSourcePaths' | 'excludeRoots'
>;

/** Source-path and session-id exclusion. Session cwd is never an exclusion key. */
export function isExcludedSession(
  session: Pick<SessionSummary, 'sessionId' | 'sourcePath'>,
  query: SessionExclusionQuery,
  allowedRoots: readonly string[],
): boolean {
  if (query.excludeSessionIds?.includes(session.sessionId)) return true;
  for (const path of query.excludeSourcePaths ?? []) {
    if (!allowedRoots.some((root) => pathContainedBy(root, path))) continue;
    if (sameFsPath(path, session.sourcePath)) return true;
  }
  return (query.excludeRoots ?? []).some((root) => pathContainedBy(root, session.sourcePath));
}
