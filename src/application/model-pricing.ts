export const MODEL_PRICING_TABLE_VERSION = "2026-09-11-cc-switch-semantic";

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type TokenBill = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

/** USD per million tokens. Unknown models stay unpriced; do not borrow another model's row. */
const PRICING: Record<string, ModelPricing> = {
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 },
  "gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 },
  "gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175, cacheCreation: 0 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
};

const ALIASES: Record<string, string> = {
  "gpt-5-codex": "gpt-5",
  "gpt-5.1-codex": "gpt-5.1",
  "gpt-5.2-codex": "gpt-5.2",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-4-sonnet": "claude-sonnet-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-4-haiku": "claude-haiku-4-5",
  "claude-opus-4.1": "claude-opus-4-1",
};

export function lookupModelPricing(
  modelId: string | undefined,
  table: Record<string, ModelPricing> = PRICING,
): ModelPricing | undefined {
  if (!modelId?.trim()) return undefined;
  const key = modelId.trim().toLowerCase();
  const aliased = ALIASES[key] ?? key;
  return table[aliased] ?? table[key];
}

export function calculateUsageCostUsd(
  bill: TokenBill,
  pricing: ModelPricing,
  inputIncludesCache: boolean,
  multiplier = 1,
): number {
  const cacheRead = Math.max(0, bill.cacheRead);
  const cacheCreation = Math.max(0, bill.cacheCreation);
  const billedInput = inputIncludesCache
    ? Math.max(0, bill.input - cacheRead - cacheCreation)
    : Math.max(0, bill.input);
  const million = 1_000_000;
  const base =
    (billedInput * pricing.input +
      Math.max(0, bill.output) * pricing.output +
      cacheRead * pricing.cacheRead +
      cacheCreation * pricing.cacheCreation) /
    million;
  return base * multiplier;
}
