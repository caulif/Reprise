import type { RunOutcome } from "../core/schema.js";
import type { RuntimeStopReason, TargetRunner } from "../core/runtime.js";
import { errorFact, remainingResources } from "./candidate-run-facts.js";

export const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

export type CandidateCleanupPorts = {
  readonly runner: TargetRunner;
  readonly release?: () => Promise<{ status: "released" | "already_released" }>;
  readonly timeoutMs: number;
  appendCleanup(type: string, payload: unknown, operationId: string): Promise<string | undefined>;
  captureArtifacts(): Promise<void>;
};

export async function cleanupCandidateRun(
  reason: RuntimeStopReason,
  ports: CandidateCleanupPorts,
): Promise<RunOutcome["cleanup"]> {
  const evidenceRefs: string[] = [];
  const appendCleanup = async (type: string, payload: unknown, operationId: string): Promise<void> => {
    const eventId = await ports.appendCleanup(type, payload, operationId);
    if (eventId) evidenceRefs.push(`event:${eventId}`);
  };
  const stopped = await stopCandidateRuntime(reason, ports, appendCleanup);
  let status = stopped.status;
  await ports.captureArtifacts();
  if (ports.release) {
    try {
      await ports.release();
      await appendCleanup("environment.release_completed", {}, "environment-release");
    } catch (error) {
      if (status === "complete") status = "incomplete";
      await appendCleanup("environment.release_failed", errorFact(error), "environment-release-failed");
    }
  }
  return { status, remainingResourceIds: stopped.remainingResourceIds, evidenceRefs };
}

async function stopCandidateRuntime(
  reason: RuntimeStopReason,
  ports: Pick<CandidateCleanupPorts, "runner" | "timeoutMs">,
  appendCleanup: (type: string, payload: unknown, operationId: string) => Promise<void>,
): Promise<{ status: "complete" | "incomplete" | "unknown"; remainingResourceIds: string[] }> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = ports.runner.stop(reason);
  void stop.catch(() => undefined);
  try {
    await Promise.race([
      stop,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("cleanup_timeout"));
        }, ports.timeoutMs);
        timer.unref();
      }),
    ]);
    await appendCleanup("runtime.stop_completed", { reason }, "runtime-stop");
    await closeCandidateRuntime(ports.runner);
    return { status: "complete", remainingResourceIds: [] };
  } catch (error) {
    const remainingResourceIds = timedOut ? ["runtime"] : remainingResources(error);
    const status = timedOut ? ("unknown" as const) : ("incomplete" as const);
    await appendCleanup(
      "runtime.stop_failed",
      timedOut ? { reason: "cleanup_timeout", remainingResourceIds } : { ...errorFact(error), remainingResourceIds },
      "runtime-stop-failed",
    );
    if (!timedOut) await closeCandidateRuntime(ports.runner);
    return { status, remainingResourceIds };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeCandidateRuntime(runner: TargetRunner): Promise<void> {
  try {
    await runner.close();
  } catch {
    // stop() already recorded runtime failure; close is best-effort session teardown.
  }
}
