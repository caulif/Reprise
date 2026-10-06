/** A Host policy refusal raised before filesystem mutation or process creation. */
export class ToolPreconditionRejected extends Error {
  constructor(
    readonly reason: "read_only_mount" | "host_write_policy" | "invalid_path",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolPreconditionRejected";
  }
}
