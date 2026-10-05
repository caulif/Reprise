import type { FreeformWorkRequest } from '../../types.js';

export async function observePiFailure<T>(action: () => T | Promise<T>, recordFailure?: (error: unknown) => void): Promise<T> {
  try { return await action(); }
  catch (error) { recordFailure?.(error); throw error; }
}

export function invocationYieldDeadline(agent: { abort(): void; readonly signal?: AbortSignal | undefined }, outer: AbortSignal, deadline?: FreeformWorkRequest['yieldDeadline']) {
  const local = new AbortController();
  const signal = AbortSignal.any([outer, local.signal]);
  let expired = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const knownReasons = new Set<unknown>();
  const abort = () => {
    knownReasons.add(signal.reason);
    const activeSignal = agent.signal;
    const alreadyAborted = activeSignal?.aborted;
    agent.abort();
    if (!alreadyAborted && activeSignal?.aborted) knownReasons.add(activeSignal.reason);
  };
  signal.addEventListener('abort', abort);
  const expire = () => { expired = true; local.abort(); };
  const arm = () => {
    const remaining = deadline!.at - Date.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  if (deadline) {
    arm();
  }
  return {
    signal,
    recordFailure(error: unknown) {
      if (!signal.aborted || !isKnownAbort(error, knownReasons)) failure ??= error instanceof Error ? error : new Error('Pi invocation failed.', { cause: error });
    },
    reason() {
      outer.throwIfAborted();
      if (!expired) return undefined;
      if (failure !== undefined) throw failure;
      return deadline!.reason;
    },
    dispose() { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); },
  };
}

function isKnownAbort(error: unknown, reasons: ReadonlySet<unknown>): boolean {
  if (reasons.has(error)) return true;
  return error instanceof Error && error.cause !== undefined && isKnownAbort(error.cause, reasons);
}
