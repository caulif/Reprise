import { sha256 } from "../../core/identity.js";
import { asPosixPath, isFsAbsolute } from "../../core/paths.js";
import type {
  HistoricalArtifact,
  HistoricalArtifactFinality,
  HistoricalArtifactIssue,
  HistoricalArtifactIssueCode,
  HistoricalArtifactManifest,
  HistoricalArtifactOrigin,
} from "../../core/schema.js";
import type { HistoricalArtifactExtractResult, HistoricalArtifactFile } from "../contract.js";

export type NormalizedWriteKind = "add" | "update" | "delete" | "move";

export type NormalizedWrite = {
  readonly kind: NormalizedWriteKind;
  readonly logicalPath: string;
  readonly destinationPath?: string;
  /** Full replacement body for add, or unique update when preimage+patch applied externally. */
  readonly bytes?: Uint8Array;
  readonly sourceRefs: readonly string[];
  readonly origin?: HistoricalArtifactOrigin;
};

export type PathRejectReason = "absolute" | "traversal" | "unc" | "drive" | "ads" | "empty" | "charset";

type FileState =
  | { readonly status: "known"; readonly bytes: Uint8Array; readonly sourceRefs: string[]; readonly origin: HistoricalArtifactOrigin }
  | { readonly status: "unknown"; readonly sourceRefs: string[]; readonly reason: HistoricalArtifactIssueCode };

export class HistoricalArtifactBuilder {
  private readonly files = new Map<string, FileState>();
  private readonly caseIndex = new Map<string, string>();
  private readonly issues: HistoricalArtifactIssue[] = [];
  private readonly sourceHash: string;
  private readonly extractorVersion: string;

  constructor(input: { sourceHash: string; extractorVersion: string }) {
    this.sourceHash = input.sourceHash;
    this.extractorVersion = input.extractorVersion;
  }

  issue(code: HistoricalArtifactIssueCode, sourceRefs: readonly string[], logicalPath?: string, message?: string): void {
    this.issues.push({
      code,
      sourceRefs: [...sourceRefs],
      ...(logicalPath ? { logicalPath } : {}),
      ...(message ? { message } : {}),
    });
  }

  applyWrite(write: NormalizedWrite): void {
    const pathCheck = validateLogicalPath(write.logicalPath);
    if (!pathCheck.ok) {
      this.issue("path_rejected", write.sourceRefs, undefined, pathCheck.reason);
      return;
    }
    const path = pathCheck.path;
    if (write.kind === "move") {
      this.applyMove(path, write);
      return;
    }
    if (write.kind === "delete") {
      this.files.delete(path);
      this.caseIndex.delete(path.toLowerCase());
      return;
    }
    if (write.bytes === undefined) {
      this.markUnknown(path, write.sourceRefs, "unsupported_write");
      return;
    }
    const conflict = this.caseConflict(path);
    if (conflict) {
      this.issue("path_conflict", write.sourceRefs, path, `Conflicts with ${conflict}`);
      this.markUnknown(path, write.sourceRefs, "path_conflict");
      this.markUnknown(conflict, write.sourceRefs, "path_conflict");
      return;
    }
    this.files.set(path, {
      status: "known",
      bytes: write.bytes,
      sourceRefs: [...write.sourceRefs],
      origin: write.origin ?? "reconstructed_from_history",
    });
    this.caseIndex.set(path.toLowerCase(), path);
  }

  markUnknown(logicalPath: string, sourceRefs: readonly string[], reason: HistoricalArtifactIssueCode): void {
    const pathCheck = validateLogicalPath(logicalPath);
    if (!pathCheck.ok) {
      this.issue("path_rejected", sourceRefs, undefined, pathCheck.reason);
      return;
    }
    const path = pathCheck.path;
    const existing = this.files.get(path);
    const merged = existing ? [...new Set([...existing.sourceRefs, ...sourceRefs])] : [...sourceRefs];
    this.files.set(path, { status: "unknown", sourceRefs: merged, reason });
    this.issue(reason, sourceRefs, path);
  }

  /** Target-unknown write: invalidate every known path rather than pretend nothing happened. */
  markAllUnknown(sourceRefs: readonly string[], reason: HistoricalArtifactIssueCode): void {
    for (const path of [...this.files.keys()]) {
      this.markUnknown(path, sourceRefs, reason);
    }
    this.issue(reason, sourceRefs, undefined, "Write target could not be determined.");
  }

  knownBytes(logicalPath: string): Uint8Array | undefined {
    const pathCheck = validateLogicalPath(logicalPath);
    if (!pathCheck.ok) return undefined;
    const state = this.files.get(pathCheck.path);
    return state?.status === "known" ? state.bytes : undefined;
  }

  finish(): HistoricalArtifactExtractResult {
    const artifacts: HistoricalArtifact[] = [];
    const files: HistoricalArtifactFile[] = [];
    for (const [logicalPath, state] of [...this.files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (state.status !== "known") continue;
      const artifactId = artifactIdForPath(logicalPath);
      const bundleId = bundleIdForPath(logicalPath);
      const contentHash = sha256(state.bytes);
      const finality: HistoricalArtifactFinality = "final";
      const mediaType = guessMediaType(logicalPath);
      artifacts.push({
        artifactId,
        logicalPath,
        bundleId,
        contentHash,
        byteLength: state.bytes.byteLength,
        origin: state.origin,
        sourceRefs: state.sourceRefs,
        finality,
        ...(mediaType ? { mediaType } : {}),
      });
      files.push({ artifactId, bytes: state.bytes });
    }
    for (const [logicalPath, state] of this.files.entries()) {
      if (state.status === "unknown") {
        const already = this.issues.some((item) => item.logicalPath === logicalPath && item.code === state.reason);
        if (!already) this.issue(state.reason, state.sourceRefs, logicalPath);
      }
    }
    const manifest: HistoricalArtifactManifest = {
      schemaVersion: 1,
      sourceHash: this.sourceHash,
      extractorVersion: this.extractorVersion,
      artifacts,
      issues: this.issues,
    };
    return { manifest, files };
  }

  private applyMove(fromPath: string, write: NormalizedWrite): void {
    if (!write.destinationPath) {
      this.markUnknown(fromPath, write.sourceRefs, "unsupported_write");
      return;
    }
    const destCheck = validateLogicalPath(write.destinationPath);
    if (!destCheck.ok) {
      this.issue("path_rejected", write.sourceRefs, undefined, destCheck.reason);
      this.markUnknown(fromPath, write.sourceRefs, "path_rejected");
      return;
    }
    const state = this.files.get(fromPath);
    this.files.delete(fromPath);
    this.caseIndex.delete(fromPath.toLowerCase());
    if (!state || state.status !== "known") {
      this.markUnknown(destCheck.path, write.sourceRefs, state ? state.reason : "missing_preimage");
      return;
    }
    this.applyWrite({
      kind: "add",
      logicalPath: destCheck.path,
      bytes: state.bytes,
      sourceRefs: [...new Set([...state.sourceRefs, ...write.sourceRefs])],
      origin: state.origin,
    });
  }

  private caseConflict(path: string): string | undefined {
    const existing = this.caseIndex.get(path.toLowerCase());
    return existing && existing !== path ? existing : undefined;
  }
}

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

export function artifactIdForPath(logicalPath: string): string {
  return `ha-${sha256(logicalPath).slice(0, 24)}`;
}

export function bundleIdForPath(logicalPath: string): string {
  const slash = logicalPath.lastIndexOf("/");
  const root = slash === -1 ? logicalPath : logicalPath.slice(0, slash);
  return `hb-${sha256(root).slice(0, 24)}`;
}

export function sourceHashForExtract(input: {
  transcript: readonly { id: string; role: string; text: string }[];
  historicalEvents: readonly unknown[];
  historicalCwd?: string;
}): string {
  return sha256(JSON.stringify({
    transcript: input.transcript.map((message) => ({ id: message.id, role: message.role, text: message.text })),
    historicalEvents: input.historicalEvents,
    ...(input.historicalCwd ? { historicalCwd: input.historicalCwd } : {}),
  }));
}

function guessMediaType(logicalPath: string): string | undefined {
  const lower = logicalPath.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  return undefined;
}

/** Apply a unique search/replace edit; returns undefined when preimage missing or match is not unique. */
export function applyUniqueReplace(preimage: Uint8Array, oldText: string, newText: string): Uint8Array | undefined {
  const text = Buffer.from(preimage).toString("utf8");
  const first = text.indexOf(oldText);
  if (first < 0) return undefined;
  const second = text.indexOf(oldText, first + oldText.length);
  if (second >= 0) return undefined;
  return Buffer.from(`${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`, "utf8");
}
