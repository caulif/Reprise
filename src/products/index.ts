import { claudeCodeProductPack } from "./claude-code/pack.js";
import { codexProductPack } from "./codex/pack.js";
import type { ProductPack } from "./contract.js";
import { importPacks, packHistory } from "./pack-access.js";
import { assembleProductPacks, type PackLoadDiagnostic } from "./registry.js";

const builtinPacks: readonly ProductPack[] = [codexProductPack, claudeCodeProductPack];

export let productPacks: readonly ProductPack[] = builtinPacks;
export let packLoadDiagnostics: readonly PackLoadDiagnostic[] = [];

export function resetProductPacks(): void {
  productPacks = builtinPacks;
  packLoadDiagnostics = [];
}

export type ProductLookup = {
  readonly packs: readonly ProductPack[];
  readonly diagnostics: readonly PackLoadDiagnostic[];
  find(productId: string): ProductPack;
};

export function createProductLookup(packs: readonly ProductPack[], diagnostics: readonly PackLoadDiagnostic[] = []): ProductLookup {
  return {
    packs,
    diagnostics,
    find(productId) {
      const pack = packs.find((item) => item.manifest.productId === productId);
      if (!pack) {
        const known = packs.map((item) => item.manifest.productId).join(", ") || "(none)";
        throw new Error(`Unknown product '${productId}'. Registered products: ${known}.`);
      }
      return pack;
    },
  };
}

export async function loadAndActivateProductPacks(dataDir: string): Promise<readonly PackLoadDiagnostic[]> {
  const assembled = await assembleProductPacks(dataDir, builtinPacks);
  productPacks = assembled.packs;
  packLoadDiagnostics = assembled.diagnostics;
  return assembled.diagnostics;
}

export function findProductPack(productId: string): ProductPack {
  const pack = productPacks.find((item) => item.manifest.productId === productId);
  if (!pack) {
    const known = productPacks.map((item) => item.manifest.productId).join(", ") || "(none)";
    throw new Error(`Unknown product '${productId}'. Registered products: ${known}.`);
  }
  return pack;
}

export function defaultSessionsRoots(): Record<string, string> {
  return Object.fromEntries(importPacks(productPacks).map((pack) => [pack.manifest.productId, packHistory(pack).defaultRoot]));
}

export { PACK_API_MAJOR } from "./contract.js";
export { assembleProductPacks } from "./registry.js";
export type { PackLoadDiagnostic } from "./registry.js";
export type { ProductPack } from "./contract.js";
