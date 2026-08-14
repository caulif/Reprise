import { claudeCodeProductPack } from './claude-code/pack.js';
import { codexProductPack } from './codex/pack.js';
import type { ProductPack } from './contract.js';

export const productPacks: readonly ProductPack[] = [codexProductPack, claudeCodeProductPack];

export function findProductPack(productId: string): ProductPack {
  const pack = productPacks.find((item) => item.manifest.productId === productId);
  if (!pack) {
    const known = productPacks.map((item) => item.manifest.productId).join(', ') || '(none)';
    throw new Error(`Unknown product '${productId}'. Registered products: ${known}.`);
  }
  return pack;
}

export function defaultSessionsRoots(): Record<string, string> {
  return Object.fromEntries(productPacks.map((pack) => [pack.manifest.productId, pack.sessions.defaultRoot]));
}

export type { ProductPack } from './contract.js';
