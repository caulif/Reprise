import { extname } from "node:path";

const OPENABLE_EXT = new Set([".html", ".htm", ".xhtml", ".svg"]);

export function isOpenableFinalPath(path: string): boolean {
  const ext = extname(path.replaceAll("\\", "/")).toLowerCase();
  return OPENABLE_EXT.has(ext);
}

export function finalDeliverableRank(path: string): number {
  const lower = path.toLowerCase();
  if (/\.(html|htm|xhtml)$/.test(lower)) return 0;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) return 1;
  return 2;
}
