const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Node treats overflowing delays as 1ms; re-arm long deadlines instead. */
export function segmentedTimeout(callback: () => void, milliseconds: number): () => void {
  let remaining = milliseconds;
  let started = Date.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      if (cancelled) return;
      const now = Date.now();
      remaining -= now - started;
      started = now;
      if (remaining <= 0) callback();
      else arm();
    }, Math.max(1, Math.min(remaining, MAX_TIMEOUT_MS)));
  };
  arm();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
