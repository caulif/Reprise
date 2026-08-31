import { Type } from "@sinclair/typebox";
import type { TaskCase } from "../core/schema.js";
import type { AgentToolDefinition } from "./pi-agent-host.js";
import {
  integer,
  recoveryEvidenceCatalog,
  type RecoveryEvidenceCatalogEntry,
} from "./recovery-tools.js";

export type RecoveryObservationOperation = {
  operation: "read_observation";
  availability: "available" | "unavailable";
  attempts: 1 | 2;
  reason?: "frozen_evidence_error";
};
export type RecoveryObservationOptions = {
  onOperation?: (operation: RecoveryObservationOperation) => Promise<void>;
  beforeRead?: (operation: RecoveryObservationOperation["operation"]) => Promise<void>;
};

async function boundedObservation<T>(
  options: RecoveryObservationOptions,
  operation: RecoveryObservationOperation["operation"],
  read: () => T,
): Promise<T | undefined> {
  for (const attempt of [1, 2] as const) {
    try {
      await options.beforeRead?.(operation);
      const value = read();
      await options.onOperation?.({ operation, availability: "available", attempts: attempt });
      return value;
    } catch {
      if (attempt === 2)
        await options.onOperation?.({
          operation,
          availability: "unavailable",
          attempts: attempt,
          reason: "frozen_evidence_error",
        });
    }
  }
  return undefined;
}

const MAX_OBSERVATION_JSON_BYTES = 48_000;

function observationPage(facts: readonly unknown[], catalog: readonly RecoveryEvidenceCatalogEntry[], start: number, maxItems: number): {
  page: { ref: string | undefined; observation: unknown }[];
  nextCursor?: number;
  truncated: boolean;
} {
  const page: { ref: string | undefined; observation: unknown }[] = [];
  let bytes = 2;
  let truncated = false;
  const end = Math.min(facts.length, start + maxItems);
  for (let index = start; index < end; index += 1) {
    const item = { ref: catalog[index]?.ref, observation: facts[index] };
    const extra = Buffer.byteLength(JSON.stringify(item)) + (page.length ? 1 : 0);
    if (page.length && bytes + extra > MAX_OBSERVATION_JSON_BYTES) {
      truncated = true;
      break;
    }
    page.push(item);
    bytes += extra;
  }
  const consumed = page.length;
  return {
    page,
    truncated,
    ...(start + consumed < facts.length || truncated ? { nextCursor: start + consumed } : {}),
  };
}

function unavailableObservation(
  operation: RecoveryObservationOperation["operation"],
  details: Record<string, unknown> = {},
) {
  return {
    content: "[]",
    details: { operation, available: false, reason: "frozen_evidence_error", ...details },
  };
}

/** Recovery has a separate observation reader because its evidence predates any candidate run. */
export function recoveryObservationTools(
  taskCase: TaskCase,
  options: RecoveryObservationOptions = {},
): readonly AgentToolDefinition[] {
  const parameters = Type.Object({
    source: Type.Union([Type.Literal("transcript"), Type.Literal("historical_events")]),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
  });
  return [
    {
      name: "read_observation",
      description:
        "Optional fallback: read a bounded page of frozen transcript or historical events. Prefer the Host investigation packet.",
      parameters,
      execute: async (params) => {
        const value = params as { source?: unknown; start?: unknown; maxItems?: unknown };
        if (value.source !== "transcript" && value.source !== "historical_events")
          throw new Error("Observation source is invalid.");
        const start = integer(value.start, 0, "Observation cursor");
        const maxItems = value.maxItems === undefined ? 32 : integer(value.maxItems, undefined, "maxItems", 1, 128);
        const facts = value.source === "transcript" ? taskCase.transcript : taskCase.historicalEvents;
        const page = await boundedObservation(options, "read_observation", () => {
          const catalog = recoveryEvidenceCatalog(taskCase).filter((entry) => entry.source === value.source);
          return observationPage(facts, catalog, start, maxItems);
        });
        if (!page) return unavailableObservation("read_observation", { source: value.source, start });
        return {
          content: JSON.stringify(page.page),
          details: {
            source: value.source,
            start,
            available: true,
            refs: page.page.map((item) => item.ref),
            returned: page.page.length,
            truncated: page.truncated,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          },
        };
      },
    },
  ];
}
