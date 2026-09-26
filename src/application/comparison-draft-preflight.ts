import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/identity.js";
import { agentContentFromDraft } from "./comparison-report-shell.js";

export type ComparisonDraftPreflight = {
  digest: string;
  error?: string;
};

export async function preflightComparisonDraft(attemptRoot: string): Promise<ComparisonDraftPreflight> {
  const html = await readFile(join(attemptRoot, "report.html"), "utf8");
  const extracted = agentContentFromDraft(html);
  return {
    digest: sha256(html),
    ...("error" in extracted ? { error: extracted.error } : {}),
  };
}
