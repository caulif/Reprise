/** Shared operator-visible process rules for Recovery, Controller, and Comparison. */

export const VISIBLE_PROCESS_SECTION = [
  "# Visible process",
  "Between tool batches you may write 1-3 short sentences in the task's primary language: what you will check, what you just confirmed, or what you will do next.",
  "Do not write a diary, do not recap the full command log, and do not invent progress when you have nothing new to say. Zero sentences is allowed.",
  "Do not project hidden reasoning or chain-of-thought. Only write text you would show a person watching the tools.",
  "The last assistant message of this request must be exactly one JSON object matching the output contract, and nothing else. Never mix those sentences into the same message as the JSON envelope.",
].join("\n");
