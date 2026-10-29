import type { DiscoveryDiagnostic, ImportedSession, ProductHistoryReader, SessionDiscoveryPage, SessionInspection } from '../../contract.js';

export type AcpHistoryConfig = {
  displayName: string;
  /**
   * The product's local data root. ACP exposes no transcript catalog, so this names a real
   * directory for diagnostics rather than promising that a session index lives under it.
   */
  dataRoot: string;
};

const NO_CATALOG: readonly DiscoveryDiagnostic[] = [{ code: 'catalog-unavailable', count: 1 }];

/**
 * History import stays unimplemented for ACP packs. Returning an empty page with an explicit
 * `catalog-unavailable` diagnostic keeps discovery honest: it never claims a product has no
 * sessions, only that this pack cannot read them yet.
 */
export function acpHistoryReader(config: AcpHistoryConfig): ProductHistoryReader {
  return {
    defaultRoot: config.dataRoot,
    discover(): Promise<SessionDiscoveryPage> {
      return Promise.resolve({ items: [], scanned: 0, skipped: 0, diagnostics: NO_CATALOG });
    },
    inspect(): Promise<SessionInspection> {
      return Promise.reject(unsupported(config));
    },
    import(): Promise<ImportedSession> {
      return Promise.reject(unsupported(config));
    },
  };
}

function unsupported(config: AcpHistoryConfig): Error {
  return new Error(`${config.displayName} history import is not implemented; this pack declares the runtime capability only.`);
}
