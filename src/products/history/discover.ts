import { resolve } from "node:path";
import type { ProductHistoryReader, SessionDiscoveryPage, SessionDiscoveryQuery } from "../contract.js";
import { compareSessionSummaries } from "./normalize.js";

export type HostSessionDiscoveryQuery = SessionDiscoveryQuery & {
  readonly dataDir?: string;
};

/** Resolves the product default root and Host data-dir exclusion before Pack discovery. */
export async function discoverProductSessions(
  history: ProductHistoryReader,
  query: HostSessionDiscoveryQuery,
): Promise<SessionDiscoveryPage> {
  const root = resolve(query.root ?? history.defaultRoot);
  const excludeRoots = query.excludeRoots ?? (query.dataDir ? [resolve(query.dataDir)] : undefined);
  const page = await history.discover({
    ...query,
    root,
    ...(excludeRoots ? { excludeRoots } : {}),
  });
  return { ...page, items: [...page.items].sort(compareSessionSummaries) };
}

export function resolveHistoryRoot(
  history: ProductHistoryReader,
  sessionsRoots: Readonly<Record<string, string>> | undefined,
  productId: string,
): string {
  return resolve(sessionsRoots?.[productId] ?? history.defaultRoot);
}
