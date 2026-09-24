import type { IntakeTui } from "../src/tui/intake-app.js";

export async function enterIntake(app: IntakeTui): Promise<void> {
  enterCommand(app, "/intake");
  app.handleInput("\r");
  await waitFor(() => app.intakeLevel === "projects" || app.productDiscovery.get("codex")?.status === "error");
  if (app.intakeLevel === "projects") app.handleInput("\r");
}
export function enterCommand(app: IntakeTui, command: string): void {
  app.handleInput(command);
  app.handleInput("\r");
}

export async function waitFor(condition: () => boolean): Promise<void> {
  // The full gate runs test files concurrently; allow a busy Windows worker to render before declaring a UI failure.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TUI did not render its expected state.");
}

export async function advanceCandidatePicker(app: IntakeTui, _rendered: () => string): Promise<void> {
  await waitFor(() => app.page === 'candidate-product');
  app.handleInput("\r");
  await waitFor(() => app.page === 'candidate-model');
  app.handleInput("\r");
  await waitFor(() => app.page === "confirm");
  app.handleInput("\r");
  await waitFor(() => app.page === "running" || app.page === "result");
}

export const fixtureCatalog = {
  async listCatalog() {
    return [{ value: "fixture", displayName: "fixture", resolvedModel: "fixture" }] as const;
  },
  async inspectAvailability(productId: string) {
    return [{ productId, status: "available" as const, observedAt: "2026-08-11T00:10:00.000Z" }];
  },
  async verifyCandidate(candidate: { productId: string; requestedModel: string }) {
    return {
      productId: candidate.productId,
      executable: "fixture",
      requestedModel: candidate.requestedModel,
      resolvedModel: candidate.requestedModel,
    };
  },
};
