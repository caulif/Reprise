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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TUI did not render its expected state.");
}

export async function advanceCandidatePicker(app: IntakeTui, rendered: () => string): Promise<void> {
  await waitFor(() => /choose candidate product|选候选产品/i.test(rendered()));
  app.handleInput("\r");
  await waitFor(() => /choose candidate model|选候选模型/i.test(rendered()));
  app.handleInput("\r");
  await waitFor(() => /Start isolated .+ Candidate|启动隔离的/.test(rendered()));
}

export const fixtureCatalog = {
  async listCatalog() {
    return [{ value: "fixture", displayName: "fixture", resolvedModel: "fixture" }] as const;
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
