import { Type } from "@sinclair/typebox";
import type { TaskCase } from "../core/schema.js";
import type { AgentToolDefinition } from "./pi-agent-host.js";
import {
  integer,
  isRelativePath,
  recoveryEvidenceCatalog,
  requiredString,
  type RecoveryEvidenceCatalogEntry,
} from "./recovery-tools.js";

export type RecoveryObservationOperation = {
  operation: "derive_task_footprint" | "search_recovery_artifacts" | "read_observation";
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
      name: "derive_task_footprint",
      description:
        "Derive bounded path, command, and test clues from frozen observations without treating inferred clues as verified facts.",
      parameters: Type.Object({}),
      execute: async () => {
        const footprint = await boundedObservation(options, "derive_task_footprint", () =>
          recoveryEvidenceCatalog(taskCase)
            .map((entry) => ({
              ref: entry.ref,
              source: entry.source,
              paths: footprintMatches(taskCaseObservation(taskCase, entry)),
              commands: footprintCommands(taskCaseObservation(taskCase, entry)),
            }))
            .filter((entry) => entry.paths.length || entry.commands.length),
        );
        if (!footprint) return unavailableObservation("derive_task_footprint");
        return {
          content: JSON.stringify(footprint.slice(0, 128)),
          details: { available: true, returned: Math.min(footprint.length, 128), inferred: true },
        };
      },
    },
    {
      name: "search_recovery_artifacts",
      description:
        "Search frozen transcript and historical observations by a bounded term; returns Host refs and hashes, not unregistered artifacts.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 256 }) }),
      execute: async (params) => {
        const query = requiredString((params as { query?: unknown }).query, "query").toLowerCase();
        const matches = await boundedObservation(options, "search_recovery_artifacts", () =>
          recoveryEvidenceCatalog(taskCase).filter((entry) =>
            JSON.stringify(taskCaseObservation(taskCase, entry)).toLowerCase().includes(query),
          ),
        );
        const redactedQuery = redactSearchQuery(query);
        if (!matches) return unavailableObservation("search_recovery_artifacts", { query: redactedQuery });
        return {
          content: JSON.stringify(matches.slice(0, 64)),
          details: { query: redactedQuery, available: true, returned: Math.min(matches.length, 64), truncated: matches.length > 64 },
        };
      },
    },
    {
      name: "read_observation",
      description: "Read a bounded page of the frozen historical transcript or historical events.",
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
          return facts.slice(start, start + maxItems).map((observation, offset) => ({
            ref: catalog[start + offset]?.ref,
            observation,
          }));
        });
        if (!page) return unavailableObservation("read_observation", { source: value.source, start });
        return {
          content: JSON.stringify(page),
          details: {
            source: value.source,
            start,
            available: true,
            refs: page.map((item) => item.ref),
            returned: page.length,
            ...(start + page.length < facts.length ? { nextCursor: start + page.length } : {}),
          },
        };
      },
    },
  ];
}
function taskCaseObservation(
  taskCase: TaskCase,
  entry: RecoveryEvidenceCatalogEntry,
): unknown {
  return entry.source === "transcript"
    ? taskCase.transcript[entry.index]
    : taskCase.historicalEvents[entry.index];
}

function footprintMatches(value: unknown): string[] {
  const text = JSON.stringify(value);
  const candidates =
    text.match(/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\.[A-Za-z0-9_-]{1,32})/g) ??
    [];
  return [
    ...new Set(
      candidates.filter(
        (item) => isRelativePath(item) && !item.startsWith("event:"),
      ),
    ),
  ].slice(0, 32);
}

function footprintCommands(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(
      ([key, item]) =>
        /command|test|script/i.test(key) && typeof item === "string",
    )
    .map(([, item]) => String(item).slice(0, 512))
    .slice(0, 16);
}

function redactSearchQuery(query: string): string {
  return query.replace(
    /(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
}
