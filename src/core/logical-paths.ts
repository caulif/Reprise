import { asPosixPath, isFsAbsolute } from "./paths.js";

export type PathRejectReason = "absolute" | "traversal" | "unc" | "drive" | "ads" | "empty" | "charset";

export function validateLogicalPath(raw: string): { ok: true; path: string } | { ok: false; reason: PathRejectReason } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.includes("\\") || /[\0\r\n*?"<>|]/.test(trimmed)) return { ok: false, reason: "charset" };
  const posix = asPosixPath(trimmed);
  if (posix.startsWith("//")) return { ok: false, reason: "unc" };
  if (/^[A-Za-z]:/.test(posix)) return { ok: false, reason: "drive" };
  if (posix.includes(":")) return { ok: false, reason: "ads" };
  if (posix.startsWith("/") || isFsAbsolute(posix)) return { ok: false, reason: "absolute" };
  const parts = posix.split("/");
  if (parts.some((part) => part === "" || part === "..")) {
    return { ok: false, reason: parts.includes("..") ? "traversal" : "charset" };
  }
  const normalized = parts.filter((part) => part !== ".").join("/");
  if (!normalized) return { ok: false, reason: "empty" };
  return { ok: true, path: normalized };
}

/** Reject path escape / absolute / ADS / UNC before sealing or joining bytes (B1 validator). */
export function assertSafeLogicalPath(logicalPath: string): void {
  const result = validateLogicalPath(logicalPath);
  if (!result.ok) {
    throw new Error(`Historical artifact logicalPath is unsafe (${result.reason}): ${logicalPath}`);
  }
}
