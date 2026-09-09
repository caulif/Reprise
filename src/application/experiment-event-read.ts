import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventEnvelope } from "../core/schema.js";
import { CliError } from "./cli-error.js";
import { isMissing } from "./experiment-helpers.js";
import { resolvedExperimentRoot } from "./experiment-layout.js";
import { parseCommittedEventLog } from "../infrastructure/agent/model-input.js";

export type EventPage = {
  readonly experimentId: string;
  readonly events: readonly EventEnvelope[];
  readonly nextSequence?: number;
  readonly diagnosticCode?: string;
};

export async function readExperimentEvents(input: {
  readonly dataDir: string;
  readonly experimentId: string;
  readonly fromSequence?: number;
  readonly limit?: number;
}): Promise<EventPage> {
  const experimentRoot = resolvedExperimentRoot(input.dataDir, input.experimentId);
  let raw: string;
  try {
    raw = await readFile(join(experimentRoot, "events.jsonl"), "utf8");
  } catch (error) {
    if (isMissing(error)) throw new CliError("not_found", `Unknown experiment '${input.experimentId}'.`, input.experimentId);
    throw error;
  }
  const parsed = parseCommittedEventLog(raw);
  if (parsed.diagnostic && parsed.diagnostic.code !== "incomplete_tail") {
    throw new CliError(
      "failed",
      `${parsed.diagnostic.message}${parsed.diagnostic.sequence ? ` (sequence ${parsed.diagnostic.sequence})` : ""}.`,
      input.experimentId,
    );
  }
  const from = input.fromSequence ?? 1;
  const filtered = parsed.events.filter((event) => event.sequence >= from);
  const limit = input.limit && input.limit > 0 ? input.limit : filtered.length;
  const page = filtered.slice(0, limit);
  const last = page.at(-1);
  const more = filtered.length > page.length;
  return {
    experimentId: input.experimentId,
    events: page,
    ...(more && last ? { nextSequence: last.sequence + 1 } : {}),
    ...(parsed.diagnostic ? { diagnosticCode: parsed.diagnostic.code } : {}),
  };
}
