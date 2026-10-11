/** FIFO, abortable capacity shared by expensive operations in one owner scope. */
export class AsyncCapacity {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  constructor(readonly limit: number) {}

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => {
          const index = this.#queue.indexOf(ready);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Capacity wait cancelled.'));
        };
        this.#queue.push(ready);
        signal.addEventListener('abort', abort, { once: true });
      });
    } else this.#active++;
    try { signal.throwIfAborted(); return await action(); }
    finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
