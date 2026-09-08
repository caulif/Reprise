import { claudeCodeProductPack } from "./claude-code/pack.js";
import { codexProductPack } from "./codex/pack.js";
import type { ProductPack } from "./contract.js";
import { importPacks, packSessions } from "./pack-access.js";
import { assembleProductPacks, type PackLoadDiagnostic } from "./registry.js";

const builtinPacks: readonly ProductPack[] = [codexProductPack, claudeCodeProductPack];

export let productPacks: readonly ProductPack[] = builtinPacks;
export let packLoadDiagnostics: readonly PackLoadDiagnostic[] = [];

export function resetProductPacks(): void {
  productPacks = builtinPacks;
  packLoadDiagnostics = [];
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
  return Object.fromEntries(importPacks(productPacks).map((pack) => [pack.manifest.productId, packSessions(pack).defaultRoot]));
}

export { PACK_API_MAJOR } from "./contract.js";
export { assembleProductPacks } from "./registry.js";
export type { PackLoadDiagnostic } from "./registry.js";
export type { ProductPack } from "./contract.js";
