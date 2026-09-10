import { defaultSourceRoots, firstRegisteredProductId, requireRegisteredProduct } from "../application/experiment-queries.js";

export function parseSessionsDirs(values: readonly string[] | undefined): Record<string, string> {
  const roots = defaultSourceRoots();
  for (const value of values ?? []) {
    const eq = value.indexOf("=");
    if (eq > 0) {
      const productId = value.slice(0, eq);
      const path = value.slice(eq + 1);
      if (!productId.trim() || !path.trim()) throw new Error(`Invalid --sessions-dir ${value}. Use <productId>=<path>.`);
      requireRegisteredProduct(productId);
      roots[productId] = path;
      continue;
    }
    roots[firstRegisteredProductId()] = value;
  }
  return roots;
}
