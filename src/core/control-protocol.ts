import { Type, type Static } from "@sinclair/typebox";

export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const CONTROL_MAX_BYTES = 4_096;
export const CONTROL_CLIENT_TIMEOUT_MS = 3_000;

const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });

const ControlEndpointSchema = Type.Union([
  Type.Object({ kind: Type.Literal("pipe"), name: Type.String({ minLength: 1, maxLength: 256 }) }),
  Type.Object({ kind: Type.Literal("unix"), path: Type.String({ minLength: 1, maxLength: 512 }) }),
]);
export type ControlEndpoint = Static<typeof ControlEndpointSchema>;

export const ControlRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  protocolVersion: Type.Literal(CONTROL_PROTOCOL_VERSION),
  ownerInstanceId: Id,
  pid: Type.Integer({ minimum: 1 }),
  operationId: Type.String({ minLength: 1, maxLength: 160 }),
  experimentId: Id,
  runId: Type.String({ minLength: 1, maxLength: 160 }),
  kind: Type.Union([Type.Literal("prepare"), Type.Literal("run"), Type.Literal("compare")]),
  endpoint: ControlEndpointSchema,
  startedAt: Type.String({ minLength: 1 }),
});
export type ControlRecord = Static<typeof ControlRecordSchema>;

export const ControlFinishedSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  operationId: Type.String({ minLength: 1, maxLength: 160 }),
  experimentId: Id,
  runId: Type.String({ minLength: 1, maxLength: 160 }),
  kind: Type.Union([Type.Literal("prepare"), Type.Literal("run"), Type.Literal("compare")]),
  finishedAt: Type.String({ minLength: 1 }),
});
export type ControlFinished = Static<typeof ControlFinishedSchema>;

export const ControlRequestSchema = Type.Object({
  protocolVersion: Type.Literal(CONTROL_PROTOCOL_VERSION),
  command: Type.Literal("cancel"),
  token: Type.String({ minLength: 32, maxLength: 128 }),
  ownerInstanceId: Id,
  operationId: Type.String({ minLength: 1, maxLength: 160 }),
  requestId: Type.String({ minLength: 1, maxLength: 160 }),
});
export type ControlRequest = Static<typeof ControlRequestSchema>;

export const ControlResponseSchema = Type.Object({
  protocolVersion: Type.Literal(CONTROL_PROTOCOL_VERSION),
  status: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("already_finished"),
    Type.Literal("unknown_operation"),
    Type.Literal("auth_failed"),
    Type.Literal("protocol_error"),
  ]),
  operationId: Type.String({ minLength: 1, maxLength: 160 }),
  knownState: Type.Optional(Type.Union([
    Type.Literal("running"),
    Type.Literal("cancel_requested"),
    Type.Literal("finished"),
  ])),
});
export type ControlResponse = Static<typeof ControlResponseSchema>;
