import { Type, type Static } from "@sinclair/typebox";

export const CLI_PROTOCOL_VERSION = 1 as const;

export const CLI_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  not_found: 3,
  config: 4,
  conflict: 5,
  cancelled: 6,
  timeout: 7,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

export type CliErrorKind =
  | "usage"
  | "not_found"
  | "config_missing"
  | "capability_missing"
  | "conflict"
  | "cancelled"
  | "timeout"
  | "failed";

export type CliOutputMode = "json" | "jsonl";

const CliActivitySchema = Type.Object({
  operationId: Type.String({ minLength: 1 }),
  experimentId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
});
export type CliActivity = Static<typeof CliActivitySchema>;

const CliErrorKindSchema = Type.Union([
  Type.Literal("usage"),
  Type.Literal("not_found"),
  Type.Literal("config_missing"),
  Type.Literal("capability_missing"),
  Type.Literal("conflict"),
  Type.Literal("cancelled"),
  Type.Literal("timeout"),
  Type.Literal("failed"),
]);

const CliErrorBodySchema = Type.Object({
  kind: CliErrorKindSchema,
  message: Type.String({ minLength: 1 }),
  id: Type.Optional(Type.String({ minLength: 1 })),
});
export type CliErrorBody = Static<typeof CliErrorBodySchema>;

export const CliJsonResultSchema = Type.Object({
  schemaVersion: Type.Literal(CLI_PROTOCOL_VERSION),
  ok: Type.Boolean(),
  command: Type.String({ minLength: 1 }),
  data: Type.Optional(Type.Unknown()),
  activity: Type.Optional(CliActivitySchema),
  error: Type.Optional(CliErrorBodySchema),
});
export type CliJsonResult = Static<typeof CliJsonResultSchema>;

export const CliJsonlRecordSchema = Type.Union([
  Type.Object({
    schemaVersion: Type.Literal(CLI_PROTOCOL_VERSION),
    type: Type.Literal("activity"),
    activity: CliActivitySchema,
  }),
  Type.Object({
    schemaVersion: Type.Literal(CLI_PROTOCOL_VERSION),
    type: Type.Literal("event"),
    sequence: Type.Integer(),
    event: Type.Unknown(),
  }),
  Type.Object({
    schemaVersion: Type.Literal(CLI_PROTOCOL_VERSION),
    type: Type.Literal("end"),
    ok: Type.Boolean(),
    status: Type.Optional(Type.String()),
    error: Type.Optional(CliErrorBodySchema),
  }),
]);
export type CliJsonlRecord = Static<typeof CliJsonlRecordSchema>;

export function exitCodeForKind(kind: CliErrorKind): CliExitCode {
  if (kind === "usage") return CLI_EXIT.usage;
  if (kind === "not_found") return CLI_EXIT.not_found;
  if (kind === "config_missing" || kind === "capability_missing") return CLI_EXIT.config;
  if (kind === "conflict") return CLI_EXIT.conflict;
  if (kind === "cancelled") return CLI_EXIT.cancelled;
  if (kind === "timeout") return CLI_EXIT.timeout;
  return CLI_EXIT.failed;
}
