import type { ImportedSession, ProductHistoryReader, SessionInspection, SessionRef, SessionSummary } from "../contract.js";
import { importVerifiedSession } from "../shared/session-recovery.js";

export async function inspectProductSession(
  history: ProductHistoryReader,
  ref: SessionRef,
): Promise<SessionInspection> {
  return history.inspect(ref);
}

export async function readImportedSession(
  history: Pick<ProductHistoryReader, "inspect" | "import">,
  session: Pick<SessionSummary, "productId" | "sessionId" | "sourcePath" | "availability" | "evidenceLevel" | "recoveryReadiness">,
  sourcePath: string,
): Promise<ImportedSession> {
  return importVerifiedSession(history, session, sourcePath);
}
