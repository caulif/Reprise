/** Shared operator-visible process rules for Recovery, Controller, and Comparison. */

export const VISIBLE_PROCESS_NARRATION = [
  "# Visible process",
  "Write short sentences so a person watching the tool calls can follow what you are doing.",
  "- Before the first tool batch, one sentence: what you are about to check.",
  "- Between tool batches, zero to three sentences: what you confirmed, what you will do next. Write nothing when there is nothing new.",
  "- Before the last tool batch, one closing sentence. If this turn ends with a JSON envelope, the final message contains only the JSON, with no added sentence.",
  "No diary, no replay of the command log, no exposed reasoning. Write only what you would show to someone watching the tools.",
].join("\n");
