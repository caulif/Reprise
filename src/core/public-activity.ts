import { Type, type Static } from "@sinclair/typebox";

const ActivityStatusSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);

const FileChangeSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.String()),
  diff: Type.Optional(Type.String()),
});

const TargetActivitySchema = Type.Union([
  Type.Object({ kind: Type.Literal("prompt"), text: Type.String() }),
  Type.Object({
    kind: Type.Literal("thinking"),
    text: Type.Optional(Type.String()),
    streaming: Type.Optional(Type.Literal(true)),
  }),
  Type.Object({
    kind: Type.Literal("message"),
    text: Type.Optional(Type.String()),
    streaming: Type.Optional(Type.Literal(true)),
  }),
  Type.Object({
    kind: Type.Literal("command"),
    command: Type.String(),
    status: ActivityStatusSchema,
    output: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Integer()),
    durationMs: Type.Optional(Type.Integer()),
    blockedBySandbox: Type.Optional(Type.Literal(true)),
    actions: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    kind: Type.Literal("file_change"),
    changes: Type.Array(FileChangeSchema),
    completed: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    kind: Type.Literal("web_search"),
    query: Type.Optional(Type.String()),
    completed: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal("tool_call"),
    name: Type.String(),
    status: ActivityStatusSchema,
    body: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("subtask"),
    name: Type.String(),
    status: ActivityStatusSchema,
    body: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("schedule"),
    name: Type.String(),
    status: ActivityStatusSchema,
    body: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("plan"),
    steps: Type.Array(Type.Object({ status: Type.String(), step: Type.String() })),
  }),
  Type.Object({
    kind: Type.Literal("token_usage"),
    total: Type.Number(),
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    reasoning: Type.Optional(Type.Number()),
    cached: Type.Optional(Type.Number()),
  }),
  Type.Object({
    kind: Type.Literal("sandbox_notice"),
    label: Type.String(),
    identity: Type.Optional(Type.String()),
    caveat: Type.Optional(Type.String()),
  }),
  Type.Object({ kind: Type.Literal("runtime_error"), message: Type.String() }),
  Type.Object({
    kind: Type.Literal("other"),
    label: Type.String(),
    body: Type.Optional(Type.String()),
  }),
]);

export const PublicActivityPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sourceEventId: Type.String({ minLength: 1 }),
  sourceEventType: Type.String({ minLength: 1 }),
  activity: TargetActivitySchema,
  correlationId: Type.Optional(Type.String()),
  merge: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
});

export type TargetActivity = Static<typeof TargetActivitySchema>;
export type PublicActivityPayload = Static<typeof PublicActivityPayloadSchema>;
