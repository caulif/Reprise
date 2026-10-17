import type { RunOutcome } from "../core/schema.js";
import type { RuntimeStopReason, TargetRunner } from "../core/runtime.js";
import { errorFact, remainingResources } from "./candidate-run-facts.js";

export const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
export const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
export type CandidateCleanupPorts = {
  readonly runner: TargetRunner;
  readonly started?: boolean;
  readonly release?: () => Promise<{ status: "released" | "already_released" }>;
  readonly timeoutMs: number;
  readonly captureTimeoutMs?: number;
  appendCleanup(type: string, payload: unknown, operationId: string): Promise<string | undefined>;
  captureArtifacts(signal: AbortSignal): Promise<void>;
};

export async function cleanupCandidateRun(reason: RuntimeStopReason, ports: CandidateCleanupPorts): Promise<RunOutcome["cleanup"]> {
  const evidenceRefs: string[] = [];
  const remaining = new Set<string>();
  let status: RunOutcome['cleanup']['status'] = 'complete';
  const append = async (type: string, payload: unknown, id: string) => {
    const eventId = await ports.appendCleanup(type, payload, id);
    if (eventId) evidenceRefs.push(`event:${eventId}`);
  };
  const stage = async (name: string, operation: (signal: AbortSignal) => Promise<unknown>, timeoutMs = ports.timeoutMs): Promise<boolean> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await append(`cleanup.${name}_started`, { reason, timeoutMs }, `cleanup-${name}-started`);
    try {
      await Promise.race([
        Promise.resolve().then(() => operation(abort.signal)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          const error = new Error('cleanup_timeout');
          abort.abort(error);
          reject(error);
        }, timeoutMs); }),
      ]);
    } catch (error) {
      status = abort.signal.aborted ? 'unknown' : status === 'unknown' ? status : 'incomplete';
      if (abort.signal.aborted) remaining.add(name);
      for (const id of remainingResources(error)) remaining.add(id);
      await append(`cleanup.${name}_failed`, { ...errorFact(error), timedOut: abort.signal.aborted }, `cleanup-${name}-failed`);
      return false;
    } finally { if (timer) clearTimeout(timer); }
    await append(`cleanup.${name}_completed`, {}, `cleanup-${name}-completed`);
    return true;
  };
  if (ports.started !== false) {
    const stopped = await stage('runtime', () => ports.runner.stop(reason));
    if (stopped) await append('runtime.stop_completed', { reason }, 'runtime-stop');
    else await append('runtime.stop_failed', { reason, remainingResourceIds: [...remaining] }, 'runtime-stop-failed');
    const closed = await stage('close', () => ports.runner.close());
    if (!stopped || !closed) return { status, remainingResourceIds: [...remaining], evidenceRefs };
  } else {
    await append('cleanup.runtime_not_started', {}, 'cleanup-runtime-not-started');
  }
  const captured = await stage('capture', signal => ports.captureArtifacts(signal), ports.captureTimeoutMs ?? ports.timeoutMs);
  // Failed captures retain ownership for a later recovery attempt.
  if (!captured) { remaining.add('capture'); return { status, remainingResourceIds: [...remaining], evidenceRefs };
  }
  if (ports.release) {
    const released = await stage('release', () => ports.release!());
    await append(released ? 'environment.release_completed' : 'environment.release_failed', {}, 'environment-release');
  }
  return { status, remainingResourceIds: [...remaining], evidenceRefs };
}
