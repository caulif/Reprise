/** A Host precondition refusal raised before filesystem mutation or process creation. */
export class ToolPreconditionRejected extends Error {
  constructor(
    readonly reason: "read_only_mount" | "host_write_policy" | "invalid_path" | "edit_match",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolPreconditionRejected";
  }
}
