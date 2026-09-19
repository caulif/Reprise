/**
 * Deterministic Codex apply_patch text decoder.
 * Supports static Add / Update / Delete / Move forms only; never evals patch content.
 */

export type ParsedPatchOp =
  | { readonly kind: "add"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: "update"; readonly path: string; readonly hunks: readonly PatchHunk[] }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "move"; readonly path: string; readonly destinationPath: string };

export type PatchHunk = {
  readonly lines: readonly PatchLine[];
};

export type PatchLine =
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "remove"; readonly text: string }
  | { readonly kind: "add"; readonly text: string };

export type ParsePatchResult =
  | { readonly ok: true; readonly ops: readonly ParsedPatchOp[] }
  | { readonly ok: false; readonly reason: "empty" | "malformed" | "unsupported" };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

export function parseApplyPatchText(raw: string): ParsePatchResult {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return { ok: false, reason: "empty" };
  const body = stripBeginEnd(text);
  const lines = body.split(/\r?\n/);
  const ops: ParsedPatchOp[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (next.startsWith("*** ")) break;
        if (next.startsWith("+")) contentLines.push(next.slice(1));
        else if (next === "") contentLines.push("");
        else return { ok: false, reason: "malformed" };
        index += 1;
      }
      ops.push({ kind: "add", path, bytes: Buffer.from(contentLines.join("\n"), "utf8") });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: line.slice("*** Delete File: ".length).trim() });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      index += 1;
      let destinationPath: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        destinationPath = (lines[index] ?? "").slice("*** Move to: ".length).trim();
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (next.startsWith("*** ") && !next.startsWith("*** End of File")) break;
        if (next.startsWith("@@")) {
          index += 1;
          const read = readHunkLines(lines, index, (row) =>
            row.startsWith("@@") || (row.startsWith("*** ") && !row.startsWith("*** End of File")));
          if ("error" in read) return { ok: false, reason: "malformed" };
          hunks.push({ lines: read.lines });
          index = read.nextIndex;
          continue;
        }
        if (next.startsWith("*** End of File")) {
          index += 1;
          continue;
        }
        // Bare update without @@: treat remaining + / - / context until next *** as one hunk.
        if (next.startsWith("+") || next.startsWith("-") || next.startsWith(" ")) {
          const read = readHunkLines(lines, index, (row) => row.startsWith("*** "));
          if ("error" in read) return { ok: false, reason: "malformed" };
          hunks.push({ lines: read.lines });
          index = read.nextIndex;
          continue;
        }
        return { ok: false, reason: "malformed" };
      }
      if (destinationPath) ops.push({ kind: "move", path, destinationPath });
      if (hunks.length) ops.push({ kind: "update", path: destinationPath ?? path, hunks });
      else if (!destinationPath) return { ok: false, reason: "malformed" };
      continue;
    }
    return { ok: false, reason: "unsupported" };
  }
  return ops.length ? { ok: true, ops } : { ok: false, reason: "empty" };
}

function readHunkLines(
  lines: readonly string[],
  start: number,
  shouldStop: (row: string) => boolean,
): { readonly lines: PatchLine[]; readonly nextIndex: number } | { readonly error: "malformed" } {
  const hunkLines: PatchLine[] = [];
  let index = start;
  while (index < lines.length) {
    const row = lines[index] ?? "";
    if (shouldStop(row)) break;
    if (row.startsWith(" ")) hunkLines.push({ kind: "context", text: row.slice(1) });
    else if (row.startsWith("-")) hunkLines.push({ kind: "remove", text: row.slice(1) });
    else if (row.startsWith("+")) hunkLines.push({ kind: "add", text: row.slice(1) });
    else if (row === "") hunkLines.push({ kind: "context", text: "" });
    else return { error: "malformed" };
    index += 1;
  }
  return { lines: hunkLines, nextIndex: index };
}

export function applyUpdateHunks(preimage: Uint8Array, hunks: readonly PatchHunk[]): Uint8Array | undefined {
  const original = Buffer.from(preimage).toString("utf8");
  const hadTrailingNewline = original.endsWith("\n");
  const fileLines = hadTrailingNewline ? original.slice(0, -1).split("\n") : original.split("\n");
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    if (!oldLines.length) return undefined;
    const start = findUniqueSubsequence(fileLines, oldLines);
    if (start === undefined) return undefined;
    fileLines.splice(start, oldLines.length, ...newLines);
  }
  let result = fileLines.join("\n");
  if (hadTrailingNewline) result += "\n";
  return Buffer.from(result, "utf8");
}

function findUniqueSubsequence(haystack: readonly string[], needle: readonly string[]): number | undefined {
  if (!needle.length) return undefined;
  let found: number | undefined;
  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (found !== undefined) return undefined;
    found = index;
  }
  return found;
}

function stripBeginEnd(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.includes(BEGIN)) return trimmed;
  const start = trimmed.indexOf(BEGIN);
  const after = trimmed.slice(start + BEGIN.length).replace(/^\r?\n/, "");
  const end = after.lastIndexOf(END);
  if (end < 0) return after;
  return after.slice(0, end).replace(/\r?\n$/, "");
}
