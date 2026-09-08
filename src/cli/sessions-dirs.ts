import { findProductPack, productPacks, defaultSessionsRoots } from "../products/index.js";

export function parseSessionsDirs(values: readonly string[] | undefined): Record<string, string> {
  const roots = defaultSessionsRoots();
  for (const value of values ?? []) {
    const eq = value.indexOf("=");
    if (eq > 0) {
      const productId = value.slice(0, eq);
      const path = value.slice(eq + 1);
      if (!productId.trim() || !path.trim()) throw new Error(`Invalid --sessions-dir ${value}. Use <productId>=<path>.`);
      findProductPack(productId);
      roots[productId] = path;
      continue;
    }
    const fallback = productPacks[0]?.manifest.productId;
    if (!fallback) throw new Error("No product packs are registered.");
    roots[fallback] = value;
  }
  return roots;
}
