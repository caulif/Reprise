/** Shared operator-visible process rules for Recovery, Controller, and Comparison. */

export const VISIBLE_PROCESS_NARRATION = [
  "# Visible process",
  "Before the first tool batch, and again before the final JSON envelope or decision, write at least one short sentence in the task's primary language.",
  "Between tool batches you may write 1-3 short sentences: what you will check, what you just confirmed, or what you will do next.",
  "Do not write a diary, do not recap the full command log, and do not invent progress when you have nothing new to say. Zero sentences is allowed between those required points.",
  "Do not project hidden reasoning or chain-of-thought. Only write text you would show a person watching the tools.",
].join("\n");
