import { type CliErrorKind } from "../core/cli-protocol.js";

export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly id?: string;

  constructor(kind: CliErrorKind, message: string, id?: string) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    if (id) this.id = id;
  }
}

export function classifyCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || /timed? out/i.test(message)) return new CliError("timeout", message);
  if (name === "AbortError" || /aborted|cancelled/i.test(message)) return new CliError("cancelled", message);
  if (/already has an active writer/i.test(message)) return new CliError("conflict", message);
  if (/Harness Pi setup is required|configuration is invalid|Harness connection probe/i.test(message)) {
    return new CliError("config_missing", message);
  }
  if (/Unknown product|does not exist|Unknown experiment|Scene .* was not found|is not a sealed scene/i.test(message)) {
    return new CliError("not_found", message);
  }
  if (/not installed|unsupported_platform|capability/i.test(message)) return new CliError("capability_missing", message);
  if (/Unknown option|Unexpected argument|Usage:/i.test(message)) return new CliError("usage", message);
  return new CliError("failed", message);
}
