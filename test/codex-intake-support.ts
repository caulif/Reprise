import type { CodexIntakeTui } from "../src/tui/intake-app.js";

export async function enterIntake(app: CodexIntakeTui): Promise<void> {
  enterCommand(app, "/intake");
  app.handleInput("\r");
  await waitFor(() => app.intakeLevel === "projects" || app.productDiscovery.get("codex")?.status === "error");
  if (app.intakeLevel === "projects") app.handleInput("\r");
}
export function enterCommand(app: CodexIntakeTui, command: string): void {
  app.handleInput(command);
  app.handleInput("\r");
}

export async function waitFor(condition: () => boolean): Promise<void> {
  // The full gate runs test files concurrently; allow a busy Windows worker to render before declaring a UI failure.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TUI did not render its expected state.");
}
