import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanModelIdForPricing,
  lookupModelPricing,
  MODEL_PRICING_TABLE_VERSION,
  resolveModelPricing,
  loadOperatorPricingOverride,
  OPERATOR_PRICING_OVERRIDE_FILE,
} from "../../src/application/model-pricing.js";
import { loadPricingCatalog } from "../../src/application/pricing-catalog.js";
import {
  aggregateHistoricalUsage,
  usageCostUsd,
  usagePricing,
} from "../../src/application/session-usage.js";

async function withOverrideDir(body: unknown, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "reprise-pricing-"));
  try {
    await writeFile(join(dir, OPERATOR_PRICING_OVERRIDE_FILE), typeof body === "string" ? body : JSON.stringify(body));
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("cleanModelIdForPricing matches cc-switch slash colon at-sign and 1m rules", () => {
  assert.equal(cleanModelIdForPricing("deepseek/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(cleanModelIdForPricing("claude-sonnet-4-thinking:8192"), "claude-sonnet-4-thinking");
  assert.equal(cleanModelIdForPricing("claude-sonnet-4@20250514"), "claude-sonnet-4-20250514");
  assert.equal(cleanModelIdForPricing("claude-sonnet-4-5[1m]"), "claude-sonnet-4-5");
  assert.equal(cleanModelIdForPricing("MiniMax-M3"), "minimax-m3");
  assert.equal(cleanModelIdForPricing("Vendor/Claude-Sonnet-4@2025:free"), "claude-sonnet-4-2025");
  assert.equal(cleanModelIdForPricing("gpt-5.5"), "gpt-5.5");
  assert.notEqual(cleanModelIdForPricing("gpt-5.5"), "gpt-5");
});

test("snapshot catalog validates and does not map sibling SKUs", () => {
  const catalog = loadPricingCatalog();
  assert.equal(catalog.version, MODEL_PRICING_TABLE_VERSION);
  assert.equal(MODEL_PRICING_TABLE_VERSION, "2026-09-16-models-dev-snapshot");
  assert.equal(resolveModelPricing("gpt-5.5").kind, "hit");
  assert.equal(resolveModelPricing("MiniMax-M3").kind, "hit");
  assert.equal(resolveModelPricing("gpt-5.6-terra").kind, "hit");
  assert.equal(resolveModelPricing("gpt-5.6-sol").kind, "hit");
  assert.equal(resolveModelPricing("gpt-6-astra").kind, "hit");
  assert.equal(resolveModelPricing("deepseek-flash").kind, "hit");
  const terra = resolveModelPricing("gpt-5.6-terra");
  const sol = resolveModelPricing("gpt-5.6-sol");
  assert.equal(terra.kind, "hit");
  assert.equal(sol.kind, "hit");
  if (terra.kind === "hit" && sol.kind === "hit") {
    assert.notDeepEqual(terra.rates, sol.rates);
  }
  assert.equal(resolveModelPricing("gpt-5.6-luna").kind, "miss");
  const five = resolveModelPricing("gpt-5");
  const fiveFive = resolveModelPricing("gpt-5.5");
  assert.equal(five.kind, "hit");
  assert.equal(fiveFive.kind, "hit");
  if (five.kind === "hit" && fiveFive.kind === "hit") {
    assert.notDeepEqual(five.rates, fiveFive.rates);
  }
  assert.equal(resolveModelPricing("unknown-model-xyz").kind, "miss");
  assert.equal(resolveModelPricing("claude-sonnet-4-5-20250929").kind, "miss");
  assert.equal(lookupModelPricing("claude-sonnet-4.5")?.input, 3);
  assert.equal(lookupModelPricing("gpt-5.2-codex")?.input, 1.75);
});

test("gpt-6-astra hits its own snapshot row and not terra or sol", () => {
  const astra = resolveModelPricing("gpt-6-astra");
  const terra = resolveModelPricing("gpt-5.6-terra");
  const sol = resolveModelPricing("gpt-5.6-sol");
  assert.equal(astra.kind, "hit");
  assert.equal(terra.kind, "hit");
  assert.equal(sol.kind, "hit");
  if (astra.kind === "hit" && terra.kind === "hit" && sol.kind === "hit") {
    assert.equal(astra.rates.input, 10);
    assert.equal(astra.rates.output, 50);
    assert.equal(astra.rates.cacheRead, 1);
    assert.equal(astra.rates.cacheCreation, 12.5);
    assert.notDeepEqual(astra.rates, terra.rates);
    assert.notDeepEqual(astra.rates, sol.rates);
  }
  assert.equal(resolveModelPricing("gpt-6-luna").kind, "miss");
});

test("bracket 1m suffix uses the same catalog row as the cleaned id", () => {
  const flash = resolveModelPricing("deepseek-flash");
  const flash1m = resolveModelPricing("deepseek-flash[1m]");
  const prefixed = resolveModelPricing("deepseek/deepseek-flash[1m]");
  const astra = resolveModelPricing("gpt-6-astra");
  const astra1m = resolveModelPricing("gpt-6-astra[1m]");
  const terra = resolveModelPricing("gpt-5.6-terra");
  const terra1m = resolveModelPricing("gpt-5.6-terra[1m]");
  assert.equal(flash.kind, "hit");
  assert.equal(flash1m.kind, "hit");
  assert.equal(prefixed.kind, "hit");
  assert.equal(astra.kind, "hit");
  assert.equal(astra1m.kind, "hit");
  assert.equal(terra.kind, "hit");
  assert.equal(terra1m.kind, "hit");
  if (flash.kind === "hit" && flash1m.kind === "hit" && prefixed.kind === "hit") {
    assert.deepEqual(flash1m.rates, flash.rates);
    assert.deepEqual(prefixed.rates, flash.rates);
    assert.equal(flash.modelId, "deepseek-v4-flash");
  }
  if (astra.kind === "hit" && astra1m.kind === "hit") {
    assert.deepEqual(astra1m.rates, astra.rates);
  }
  if (terra.kind === "hit" && terra1m.kind === "hit") {
    assert.deepEqual(terra1m.rates, terra.rates);
  }
});

test("slash-prefixed DeepSeek id hits the flash snapshot row", () => {
  const usage = aggregateHistoricalUsage([
    { type: "result", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  ]);
  assert.equal(usageCostUsd(usage, "deepseek/deepseek-v4-flash"), 0.15);
  assert.equal(usageCostUsd(usage, "deepseek/deepseek-v4.1-flash"), undefined);
});

test("MiniMax-M3 is not priced as Claude Sonnet", () => {
  const sonnet = resolveModelPricing("claude-sonnet-4-5");
  const mini = resolveModelPricing("MiniMax-M3");
  assert.equal(sonnet.kind, "hit");
  assert.equal(mini.kind, "hit");
  if (sonnet.kind === "hit" && mini.kind === "hit") {
    assert.notEqual(mini.rates.input, sonnet.rates.input);
    assert.equal(mini.modelId, "minimax-m3");
  }
});

test("invalid injected rates stay unknown and gpt-5.5 does not use a gpt-5 fixture row", () => {
  const usage = aggregateHistoricalUsage([
    { type: "result", usage: { input_tokens: 10, output_tokens: 1 } },
  ]);
  const priced = usagePricing(usage, "custom-bad", {
    "custom-bad": { input: Number.NaN, output: 1, cacheRead: 0, cacheCreation: 0 },
  });
  assert.equal(priced.lookup, "invalid");
  assert.equal(priced.costUsd, undefined);
  assert.equal(usageCostUsd(usage, "gpt-5.5", {
    "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheCreation: 0 },
  }), undefined);
});

test("N7 token shape prices gpt-5.5 and MiniMax-M3 from the snapshot", () => {
  const baseline = aggregateHistoricalUsage([{
    type: "token_count",
    last_token_usage: { input_tokens: 842075 + 2624128, output_tokens: 47446, cached_input_tokens: 2624128 },
  }]);
  const candidate = aggregateHistoricalUsage([{
    type: "result",
    usage: { input_tokens: 32376, output_tokens: 9504, cache_read_input_tokens: 287872 },
  }]);
  const baselineCost = usageCostUsd(baseline, "gpt-5.5");
  const candidateCost = usageCostUsd(candidate, "MiniMax-M3");
  assert.ok(baselineCost !== undefined && baselineCost > 0);
  assert.ok(candidateCost !== undefined && candidateCost > 0);
  assert.notEqual(baselineCost, candidateCost);
});

test("N1 gpt-5.6-terra stays on its own snapshot row", () => {
  const usage = aggregateHistoricalUsage([{
    type: "token_count",
    last_token_usage: { input_tokens: 1000, output_tokens: 10, cached_input_tokens: 0 },
  }]);
  const terra = usageCostUsd(usage, "gpt-5.6-terra");
  const five = usageCostUsd(usage, "gpt-5");
  assert.ok(terra !== undefined);
  assert.ok(five !== undefined);
  assert.notEqual(terra, five);
});

test("operator override beats the snapshot and product-specific rows win", async () => {
  await withOverrideDir({
    version: "operator-2026-09-14",
    models: [
      {
        modelId: "gpt-5.5",
        productId: "claude-code",
        input: 9, output: 9, cacheRead: 0, cacheCreation: 0,
        currency: "USD", unit: "per_million_tokens",
      },
      {
        modelId: "gpt-5.5",
        input: 7, output: 7, cacheRead: 0, cacheCreation: 0,
        currency: "USD", unit: "per_million_tokens",
      },
    ],
  }, async (dir) => {
    const override = loadOperatorPricingOverride(dir);
    const snapshot = resolveModelPricing("gpt-5.5");
    const generic = resolveModelPricing("gpt-5.5", undefined, { override });
    const specific = resolveModelPricing("gpt-5.5", undefined, { override, productId: "claude-code" });
    assert.equal(snapshot.kind, "hit");
    assert.equal(generic.kind, "hit");
    assert.equal(specific.kind, "hit");
    if (snapshot.kind === "hit" && generic.kind === "hit" && specific.kind === "hit") {
      assert.equal(generic.rates.input, 7);
      assert.equal(specific.rates.input, 9);
      assert.notEqual(generic.rates.input, snapshot.rates.input);
      assert.equal(generic.source, "operator-config");
      assert.equal(generic.version, "operator-2026-09-14");
    }
  });
});

test("override zeros without free stay unpriced and do not use the snapshot", async () => {
  await withOverrideDir({
    version: "operator-zero",
    models: [{
      modelId: "gpt-5.5",
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      currency: "USD", unit: "per_million_tokens",
    }],
  }, async (dir) => {
    const override = loadOperatorPricingOverride(dir);
    const resolved = resolveModelPricing("gpt-5.5", undefined, { override });
    assert.equal(resolved.kind, "unavailable");
    const usage = aggregateHistoricalUsage([
      { type: "result", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    ]);
    assert.equal(usageCostUsd(usage, "gpt-5.5", undefined, { override }), undefined);
    assert.equal(usagePricing(usage, "gpt-5.5", undefined, { override }).lookup, "miss");
  });
});

test("override free true allows a configured zero bill", async () => {
  await withOverrideDir({
    version: "operator-free",
    models: [{
      modelId: "local-free",
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      currency: "USD", unit: "per_million_tokens",
      free: true,
    }],
  }, async (dir) => {
    const override = loadOperatorPricingOverride(dir);
    const usage = aggregateHistoricalUsage([
      { type: "result", usage: { input_tokens: 1_000_000, output_tokens: 10 } },
    ]);
    assert.equal(usageCostUsd(usage, "local-free", undefined, { override }), 0);
    const resolved = resolveModelPricing("local-free", undefined, { override });
    assert.equal(resolved.kind, "hit");
  });
});

test("unreadable override does not crash and marks lookup invalid", async () => {
  await withOverrideDir("{", async (dir) => {
    const override = loadOperatorPricingOverride(dir);
    assert.equal(override.status, "unreadable");
    assert.equal(resolveModelPricing("gpt-5.5", undefined, { override }).kind, "invalid");
    assert.equal(loadOperatorPricingOverride(join(dir, "missing-subdir")).status, "absent");
  });
});
