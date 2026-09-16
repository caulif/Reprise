import { sha256 } from "../../core/identity.js";

/** Digest of the exact system prompt bytes a Session sends to the model. */
export function promptDigest(systemPrompt: string): string {
  return sha256(systemPrompt);
}
