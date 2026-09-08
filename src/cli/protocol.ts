import { CLI_PROTOCOL_VERSION, type CliActivity, type CliErrorBody, type CliJsonResult, type CliJsonlRecord, type CliOutputMode } from "../core/cli-protocol.js";
import { CliError } from "../application/cli-error.js";
import type { EventEnvelope } from "../core/schema.js";

export type ProtocolIo = {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
};

export function writeJsonResult(io: ProtocolIo, result: Omit<CliJsonResult, "schemaVersion">): void {
  const body: CliJsonResult = { schemaVersion: CLI_PROTOCOL_VERSION, ...result };
  io.stdout(JSON.stringify(body));
}

function writeJsonl(io: ProtocolIo, record: CliJsonlRecord): void {
  io.stdout(JSON.stringify(record));
}

export function writeActivity(io: ProtocolIo, mode: CliOutputMode, command: string, activity: CliActivity): void {
  if (mode === "jsonl") writeJsonl(io, { schemaVersion: CLI_PROTOCOL_VERSION, type: "activity", activity });
  void command;
}

export function writeEvent(io: ProtocolIo, mode: CliOutputMode, event: EventEnvelope): void {
  if (mode === "jsonl") writeJsonl(io, { schemaVersion: CLI_PROTOCOL_VERSION, type: "event", sequence: event.sequence, event });
}

export function writeEnd(io: ProtocolIo, mode: CliOutputMode, ok: boolean, status?: string, error?: CliErrorBody): void {
  if (mode === "jsonl") writeJsonl(io, { schemaVersion: CLI_PROTOCOL_VERSION, type: "end", ok, ...(status ? { status } : {}), ...(error ? { error } : {}) });
}

export function errorBody(error: CliError): CliErrorBody {
  return { kind: error.kind, message: error.message, ...(error.id ? { id: error.id } : {}) };
}

export function parseOutputMode(values: { json?: boolean; jsonl?: boolean }): CliOutputMode {
  if (values.json && values.jsonl) throw new CliError("usage", "Use either --json or --jsonl, not both.");
  if (values.jsonl) return "jsonl";
  return "json";
}
