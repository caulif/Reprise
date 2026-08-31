import type { SessionMessage } from "../contract.js";

/** Product CLIs inject skill / AGENTS.md text as an early user row; replay starts at the first real task. */
export function looksLikeInjectedInstruction(text: string): boolean {
  const head = text.slice(0, 240);
  return (
    /^#\s*AGENTS\.md/i.test(head) ||
    /^<INSTRUCTIONS>/i.test(head) ||
    (/^#{1,3}\s+\S/.test(head) && text.length > 400) ||
    /don't re-write it/i.test(head)
  );
}

export function firstReplayUserMessage(messages: readonly SessionMessage[]): SessionMessage | undefined {
  const users = messages.filter((message) => message.role === "user");
  return users.find((message) => !looksLikeInjectedInstruction(message.text)) ?? users[0];
}
