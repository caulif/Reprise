import { loadPricingCatalog, type PricingRecord } from "./pricing-catalog.js";
import {
  type OperatorOverrideRecord,
  type OperatorPricingOverride,
} from "./pricing-override.js";

export { loadOperatorPricingOverride, OPERATOR_PRICING_OVERRIDE_FILE } from "./pricing-override.js";
export type { OperatorPricingOverride } from "./pricing-override.js";

const CATALOG = loadPricingCatalog();
export const MODEL_PRICING_TABLE_VERSION = CATALOG.version;

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

export type PricingSource = PricingRecord["source"] | "config";

export type PricingResolution =
  | { kind: "hit"; modelId: string; rates: ModelPricing; source: PricingSource; version?: string }
  | { kind: "invalid"; modelId: string; source: PricingSource }
  | { kind: "unavailable"; modelId: string; source: PricingSource }
  | { kind: "miss" };

export type PricingResolveOptions = {
  override?: OperatorPricingOverride;
  productId?: string;
};

const SNAPSHOT = new Map(CATALOG.models.map((row) => [row.modelId, row]));

const ALIASES: Record<string, string> = {
  "gpt-5-codex": "gpt-5",
  "gpt-5.1-codex": "gpt-5.1",
  "gpt-5.2-codex": "gpt-5.2",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-4-sonnet": "claude-sonnet-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-4-haiku": "claude-haiku-4-5",
  "claude-opus-4.1": "claude-opus-4-1",
  "deepseek-flash": "deepseek-v4-flash",
  "deepseek-v4.1-flash": "deepseek-v4-flash",
};

/** Same rules as cc-switch `clean_model_id_for_pricing`. Does not map a family onto a sibling SKU. */
export function cleanModelIdForPricing(modelId: string | undefined): string {
  if (!modelId?.trim()) return "";
  const afterSlash = modelId.slice(modelId.lastIndexOf("/") + 1);
  const beforeColon = afterSlash.split(":")[0] ?? "";
  let normalized = beforeColon.trim().replace(/@/g, "-").toLowerCase();
  if (normalized.endsWith("[1m]")) normalized = normalized.slice(0, -"[1m]".length).trim();
  return normalized;
}

export function resolveModelPricing(
  modelId: string | undefined,
  table?: Record<string, ModelPricing>,
  options?: PricingResolveOptions,
): PricingResolution {
  const cleaned = cleanModelIdForPricing(modelId);
  if (!cleaned) return { kind: "miss" };
  const aliased = ALIASES[cleaned] ?? cleaned;
  if (table) return fromRates(aliased, table[aliased] ?? table[cleaned], "config");
  if (options?.override?.status === "unreadable") {
    return { kind: "invalid", modelId: aliased, source: "operator-config" };
  }
  const overrideRow = findOverride(options?.override, cleaned, aliased, options?.productId);
  if (overrideRow) {
    const version = options?.override?.status === "ready" ? options.override.version : undefined;
    return fromOverride(overrideRow, version);
  }
  const row = SNAPSHOT.get(aliased) ?? SNAPSHOT.get(cleaned);
  if (!row) return { kind: "miss" };
  return fromRates(row.modelId, {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheCreation: row.cacheCreation,
  }, row.source, CATALOG.version);
}

export function lookupModelPricing(
  modelId: string | undefined,
  table?: Record<string, ModelPricing>,
  options?: PricingResolveOptions,
): ModelPricing | undefined {
  const resolved = resolveModelPricing(modelId, table, options);
  return resolved.kind === "hit" ? resolved.rates : undefined;
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

function fromOverride(row: OperatorOverrideRecord, version: string | undefined): PricingResolution {
  const modelId = cleanModelIdForPricing(row.modelId);
  const rates = { input: row.input, output: row.output, cacheRead: row.cacheRead, cacheCreation: row.cacheCreation };
  if (allZero(rates) && row.free !== true) {
    return { kind: "unavailable", modelId, source: "operator-config" };
  }
  return { kind: "hit", modelId, rates, source: "operator-config", ...(version ? { version } : {}) };
}

function findOverride(
  override: OperatorPricingOverride | undefined,
  cleaned: string,
  aliased: string,
  productId: string | undefined,
): OperatorOverrideRecord | undefined {
  if (override?.status !== "ready") return undefined;
  if (productId) {
    const specific = override.models.find((row) => row.productId === productId && matchesOverrideId(row, cleaned, aliased));
    if (specific) return specific;
  }
  return override.models.find((row) => row.productId === undefined && matchesOverrideId(row, cleaned, aliased));
}

function matchesOverrideId(row: OperatorOverrideRecord, cleaned: string, aliased: string): boolean {
  const id = cleanModelIdForPricing(row.modelId);
  return id === aliased || id === cleaned;
}

function fromRates(
  modelId: string,
  rates: ModelPricing | undefined,
  source: PricingSource,
  version?: string,
): PricingResolution {
  if (!rates) return { kind: "miss" };
  if (![rates.input, rates.output, rates.cacheRead, rates.cacheCreation].every(finiteNonNegative)) {
    return { kind: "invalid", modelId, source };
  }
  return { kind: "hit", modelId, rates, source, ...(version ? { version } : {}) };
}

function allZero(rates: ModelPricing): boolean {
  return rates.input === 0 && rates.output === 0 && rates.cacheRead === 0 && rates.cacheCreation === 0;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
