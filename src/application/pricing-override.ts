import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const OverrideRecordSchema = Type.Object({
  modelId: Type.String({ minLength: 1 }),
  productId: Type.Optional(Type.String({ minLength: 1 })),
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheCreation: Type.Number({ minimum: 0 }),
  currency: Type.Literal("USD"),
  unit: Type.Literal("per_million_tokens"),
  free: Type.Optional(Type.Literal(true)),
  source: Type.Optional(Type.Literal("operator-config")),
}, { additionalProperties: false });

const OverrideFileSchema = Type.Object({
  version: Type.String({ minLength: 1 }),
  models: Type.Array(OverrideRecordSchema),
}, { additionalProperties: false });

export type OperatorOverrideRecord = Static<typeof OverrideRecordSchema>;

export type OperatorPricingOverride =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "ready"; version: string; models: readonly OperatorOverrideRecord[] };

export const OPERATOR_PRICING_OVERRIDE_FILE = "model-pricing.override.json";

export function loadOperatorPricingOverride(dataDir: string): OperatorPricingOverride {
  const path = join(dataDir, OPERATOR_PRICING_OVERRIDE_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Missing override is the default. Other IO errors must not abort inspect/compare.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // SyntaxError: operator file is present but not JSON.
    return { status: "unreadable" };
  }
  if (!Value.Check(OverrideFileSchema, parsed)) return { status: "unreadable" };
  const seen = new Set<string>();
  for (const row of parsed.models) {
    const key = `${row.productId ?? ""}\0${row.modelId}`;
    if (seen.has(key)) return { status: "unreadable" };
    seen.add(key);
  }
  return { status: "ready", version: parsed.version, models: parsed.models };
}
