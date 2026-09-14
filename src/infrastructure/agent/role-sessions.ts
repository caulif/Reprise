import type { AgentSessionHost } from "./session.js";

/** In-process Session cache. Does not store role turns or business phase. */
export class RoleSessions {
  readonly #sessions = new Map<string, Promise<AgentSessionHost>>();

  async get(key: string, create: () => Promise<AgentSessionHost>): Promise<AgentSessionHost> {
    let pending = this.#sessions.get(key);
    if (!pending) {
      pending = create();
      this.#sessions.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.#sessions.get(key) === pending) this.#sessions.delete(key);
      throw error;
    }
  }

  async cancel(key: string, run: (session: AgentSessionHost) => Promise<void>): Promise<void> {
    const pending = this.#sessions.get(key);
    if (pending) {
      try {
        await run(await pending);
      } catch {
        // Session creation failed; the in-flight request already surfaces that error.
      }
    }
    this.#sessions.delete(key);
  }

  async release(key: string): Promise<void> {
    const pending = this.#sessions.get(key);
    this.#sessions.delete(key);
    if (!pending) return;
    let session: AgentSessionHost;
    try {
      session = await pending;
    } catch {
      // Session creation failed; callers already observed that error on request.
      return;
    }
    await session.close();
  }

  async releaseWhere(match: (key: string) => boolean): Promise<void> {
    const errors: unknown[] = [];
    for (const key of this.keys().filter(match)) {
      try {
        await this.release(key);
      } catch (error) {
        errors.push(error);
      }
    }
    const first = errors[0];
    if (first instanceof Error) throw first;
    if (first !== undefined) throw new Error("Role session close failed.");
  }

  /** Close a created Session, then remove it. Creation failures are ignored. */
  async discard(key: string): Promise<void> {
    await this.release(key);
  }

  keys(): readonly string[] {
    return [...this.#sessions.keys()];
  }
}
