/** A deterministic Host precondition refusal before filesystem mutation or process creation. */
export class ToolPreconditionRejected extends Error {
  constructor(
    readonly reason: "read_only_mount" | "host_write_policy" | "invalid_path" | "edit_text_mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolPreconditionRejected";
  }
}
