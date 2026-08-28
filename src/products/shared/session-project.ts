import { canonicalRecordedRoot, longestContainingRoot } from '../../core/paths.js';
import type { SessionSummary } from '../contract.js';

export const PROJECTLESS_PROJECT_KEY = 'projectless';
const UNKNOWN_PROJECT_PREFIX = 'unknown:';

export function sessionProjectKey(productId: string, canonicalRoot: string): string {
  return `${productId}\0${canonicalRoot}`;
}

function unknownSessionProjectKey(productId: string, sessionId: string): string {
  return `${UNKNOWN_PROJECT_PREFIX}\0${productId}\0${sessionId}`;
}

export function isUnknownProjectKey(key: string): boolean {
  return key.startsWith(UNKNOWN_PROJECT_PREFIX);
}

export function catalogProjectKey(productId: string, rootPath: string | undefined, fallbackId: string): string {
  const canonical = canonicalRecordedRoot(rootPath);
  return canonical ? sessionProjectKey(productId, canonical) : unknownSessionProjectKey(productId, fallbackId);
}

export function sessionGroupingKey(
  session: Pick<SessionSummary, 'productId' | 'sessionId' | 'cwd' | 'sourceKind' | 'availability'>,
  catalogKeysByRoot: ReadonlyMap<string, string> = new Map(),
): string {
  if (session.sourceKind === 'projectless') return PROJECTLESS_PROJECT_KEY;
  if (session.sourceKind === 'unknown') return unknownSessionProjectKey(session.productId, session.sessionId);
  const canonical = canonicalRecordedRoot(session.cwd);
  const catalogKey = canonical ? catalogKeyForRoot(canonical, catalogKeysByRoot) : undefined;
  if (session.availability === 'unindexed') return catalogKey ?? PROJECTLESS_PROJECT_KEY;
  if (catalogKey) return catalogKey;
  if (canonical) return sessionProjectKey(session.productId, canonical);
  return unknownSessionProjectKey(session.productId, session.sessionId);
}

function catalogKeyForRoot(canonical: string, catalogKeysByRoot: ReadonlyMap<string, string>): string | undefined {
  const exact = catalogKeysByRoot.get(canonical);
  if (exact) return exact;
  const deepest = longestContainingRoot(canonical, catalogKeysByRoot.keys());
  return deepest ? catalogKeysByRoot.get(deepest) : undefined;
}
