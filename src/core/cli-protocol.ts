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

export type CliActivity = {
  readonly operationId: string;
  readonly experimentId: string;
  readonly runId: string;
};

export type CliErrorBody = {
  readonly kind: CliErrorKind;
  readonly message: string;
  readonly id?: string;
};

export type CliJsonResult = {
  readonly schemaVersion: typeof CLI_PROTOCOL_VERSION;
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly activity?: CliActivity;
  readonly error?: CliErrorBody;
};

export type CliJsonlRecord =
  | { readonly schemaVersion: typeof CLI_PROTOCOL_VERSION; readonly type: "activity"; readonly activity: CliActivity }
  | { readonly schemaVersion: typeof CLI_PROTOCOL_VERSION; readonly type: "event"; readonly sequence: number; readonly event: unknown }
  | { readonly schemaVersion: typeof CLI_PROTOCOL_VERSION; readonly type: "end"; readonly ok: boolean; readonly status?: string; readonly error?: CliErrorBody };

export function exitCodeForKind(kind: CliErrorKind): CliExitCode {
  if (kind === "usage") return CLI_EXIT.usage;
  if (kind === "not_found") return CLI_EXIT.not_found;
  if (kind === "config_missing" || kind === "capability_missing") return CLI_EXIT.config;
  if (kind === "conflict") return CLI_EXIT.conflict;
  if (kind === "cancelled") return CLI_EXIT.cancelled;
  if (kind === "timeout") return CLI_EXIT.timeout;
  return CLI_EXIT.failed;
}
