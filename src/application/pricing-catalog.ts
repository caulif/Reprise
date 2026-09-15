import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const PricingRecordSchema = Type.Object({
  modelId: Type.String({ minLength: 1 }),
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheCreation: Type.Number({ minimum: 0 }),
  currency: Type.Literal("USD"),
  unit: Type.Literal("per_million_tokens"),
  source: Type.Union([
    Type.Literal("cc-switch-seed"),
    Type.Literal("models-dev-snapshot"),
    Type.Literal("operator-config"),
  ]),
  displayName: Type.Optional(Type.String({ minLength: 1 })),
});

const PricingCatalogSchema = Type.Object({
  version: Type.String({ minLength: 1 }),
  models: Type.Array(PricingRecordSchema, { minItems: 1 }),
});

export type PricingRecord = Static<typeof PricingRecordSchema>;
type PricingCatalogFile = Static<typeof PricingCatalogSchema>;

export function loadPricingCatalog(path = join(dirname(fileURLToPath(import.meta.url)), "pricing-catalog.json")): PricingCatalogFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Value.Check(PricingCatalogSchema, parsed)) throw new Error("pricing-catalog.json failed PricingCatalogSchema.");
  const seen = new Set<string>();
  for (const row of parsed.models) {
    if (seen.has(row.modelId)) throw new Error(`pricing-catalog.json repeats modelId ${row.modelId}.`);
    seen.add(row.modelId);
  }
  return parsed;
}
