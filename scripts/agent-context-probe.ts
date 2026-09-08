if (process.env.REPRISE_AGENT_CONTEXT_PROBE !== "1") {
  throw new Error("Set REPRISE_AGENT_CONTEXT_PROBE=1 to compare production streamFn context digests. Default checks must not call a provider.");
}

/**
 * Opt-in probe: persist model/context digest, role, block types and sizes only.
 * Do not write API keys or model plaintext. Compare agent.model_request events
 * against the digest computed immediately before streamSimple.
 */
console.error("Agent context probe is armed. Point it at a local data-dir experiment and a redacted report path.");
process.exit(2);
