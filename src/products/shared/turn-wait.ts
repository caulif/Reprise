import { SAFE_ID } from '../../core/identity.js';
import type { MessageIdentity, TurnSettlement, UserMessage } from '../../core/runtime.js';

export class TurnWaiter {
  #queue: TurnSettlement[] = [];
  #waiter: { resolve: (settlement: TurnSettlement) => void; reject: (reason: Error) => void } | undefined;
  #failure: Error | undefined;

  async wait(busyMessage: string): Promise<TurnSettlement> {
    const next = this.#queue.shift();
    if (next) return next;
    if (this.#failure) {
      const error = this.#failure;
      this.#failure = undefined;
      throw error;
    }
    if (this.#waiter) throw new Error(busyMessage);
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  deliver(settlement: TurnSettlement): void {
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve(settlement);
      return;
    }
    this.#queue.push(settlement);
  }

  fail(error: Error): void {
    const waiter = this.#waiter;
    if (!waiter) {
      this.#failure ??= error;
      return;
    }
    this.#waiter = undefined;
    waiter.reject(error);
  }

  cancel(error: Error): void {
    this.#queue.length = 0;
    this.fail(error);
    this.#failure = undefined;
  }

  stash(error: Error): void {
    this.#failure ??= error;
  }
}

export function assertRuntimeMessageIdentity(message: UserMessage, identity: MessageIdentity, productLabel: string): void {
  if (!SAFE_ID.test(message.id) || !SAFE_ID.test(identity.clientMessageId) || !SAFE_ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !message.text.trim()) {
    throw new Error(`${productLabel} runtime message identity is invalid.`);
  }
}
