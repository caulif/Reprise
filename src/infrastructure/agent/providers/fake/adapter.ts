import type { ProviderAdapter, ProviderSession } from "../../types.js";

export class FakeProviderAdapter implements ProviderAdapter {
  readonly #reply: (content: string) => string | Promise<string>;
  cancelled = false;

  constructor(reply: string | readonly string[] | ((content: string) => string | Promise<string>) = "ok") {
    if (typeof reply === "function") this.#reply = reply;
    else if (typeof reply === "string") this.#reply = () => reply;
    else {
      const queue = [...reply];
      this.#reply = () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("Fake provider exhausted replies.");
        return next;
      };
    }
  }

  createSession(): ProviderSession {
    return {
      append: async ({ content }) => this.#reply(content),
      cancel: () => {
        this.cancelled = true;
      },
    };
  }
}
