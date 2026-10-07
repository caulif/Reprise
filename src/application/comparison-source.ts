import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../core/identity.js";
import { isFsAbsolute, pathContainedBy } from "../core/paths.js";
import type { ComparisonLinkRecord } from "../core/schema.js";
import { isMissing } from "./experiment-helpers.js";

export type ComparisonSourceMounts = Readonly<Record<string, string>>;
export type ComparisonSourceLocation = { bundleRoot: string; entryRelativePath: string; absoluteFile: string };
const SOURCE_MOUNTS = new Set(["finals", "candidate", "history", "evidence", "turns", "run"]);

export function normalizeComparisonSourcePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || isFsAbsolute(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return undefined;
  if (normalized.split("/").some(part => part === ".." || part === "." || part === "")) return undefined;
  return normalized;
}

export async function locateRegisteredComparisonSource(input: {
  attemptRoot: string; mounts: ComparisonSourceMounts;
}, inspectPath: string): Promise<ComparisonSourceLocation | undefined> {
  const normalized = normalizeComparisonSourcePath(inspectPath);
  if (!normalized) return undefined;
  const slash = normalized.indexOf("/");
  if (slash < 0) return undefined;
  const prefix = normalized.slice(0, slash);
  const root = SOURCE_MOUNTS.has(prefix) ? input.mounts[prefix]
    : prefix === "media" || prefix === "review" ? join(input.attemptRoot, prefix) : undefined;
  if (!root) return undefined;
  try {
    const bundleRoot = await realpath(root);
    const entryRelativePath = normalized.slice(slash + 1);
    const absoluteFile = await realpath(join(bundleRoot, ...entryRelativePath.split("/")));
    if (!pathContainedBy(bundleRoot, absoluteFile) || !(await stat(absoluteFile)).isFile()) return undefined;
    return { bundleRoot, entryRelativePath, absoluteFile };
  } catch (error) {
    if (isMissing(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return undefined;
    throw error;
  }
}

export type ComparisonQuoteSource = {
  bytes: Uint8Array;
  sourceHash: string;
  side: ComparisonLinkRecord["side"];
  mediaType?: string;
};
export type ComparisonQuoteSourcePort = {
  resolveTextSource(sourceRef: string): Promise<ComparisonQuoteSource | undefined>;
};

export function createComparisonQuoteSourcePort(input: {
  evidence: () => readonly ComparisonLinkRecord[];
  attemptRoot: string;
  mounts: ComparisonSourceMounts;
  allowModelText: boolean;
}): ComparisonQuoteSourcePort {
  return {
    async resolveTextSource(sourceRef) {
      if (!input.allowModelText) return undefined;
      if (!/^ev-[0-9]{2,6}$/.test(sourceRef)) return undefined;
      const link = input.evidence().find(item => item.shortRef === sourceRef);
      if (!link) return undefined;
      const located = await locateRegisteredComparisonSource(input, link.inspectPath);
      if (!located) return undefined;
      // Evidence is bounded like registered analysis; the tool never reads arbitrary large files.
      if ((await stat(located.absoluteFile)).size > 1_048_576) return undefined;
      const bytes = await readFile(located.absoluteFile);
      if (bytes.byteLength > 1_048_576) return undefined;
      const sourceHash = sha256(bytes);
      if (link.contentHash && sourceHash !== link.contentHash) return undefined;
      return { bytes, sourceHash, side: link.side, ...(link.mediaType ? { mediaType: link.mediaType } : {}) };
    },
  };
}
