import { lstat } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { sha256, sha256File } from "../core/identity.js";
import {
  RecoveryControlledWriteSchema,
  type RecoveryControlledWrite,
} from "../core/schema.js";

type RecoveryFileSnapshot = NonNullable<RecoveryControlledWrite["before"]>;
export type RecoveryControlledWriteHook = (
  entry: RecoveryControlledWrite,
) => Promise<void>;

export type ReplayedRecoveryFileState =
  | NonNullable<RecoveryControlledWrite["after"]>
  | undefined;

export type RecoveryControlledWriteBinding = {
  checkpointId?: string;
  baseDigest: string;
};

/** Validates the optional provider binding shared by every journal entry. */
export function getRecoveryControlledWriteBinding(
  entries: readonly RecoveryControlledWrite[],
): RecoveryControlledWriteBinding | undefined {
  let binding: RecoveryControlledWriteBinding | undefined;
  for (const entry of entries) {
    if (!Value.Check(RecoveryControlledWriteSchema, entry))
      throw new Error("Recovery controlled write journal entry is invalid.");
    const hasCheckpoint = entry.checkpointId !== undefined;
    const hasBaseDigest = entry.baseDigest !== undefined;
    if (hasCheckpoint && !hasBaseDigest)
      throw new Error("Recovery controlled write journal binding is incomplete.");
    if (entry.baseDigest === undefined) continue;
    const next: RecoveryControlledWriteBinding = {
      baseDigest: entry.baseDigest,
      ...(entry.checkpointId ? { checkpointId: entry.checkpointId } : {}),
    };
    if (binding && (binding.baseDigest !== next.baseDigest || binding.checkpointId !== next.checkpointId))
      throw new Error("Recovery controlled write journal entries have conflicting bindings.");
    binding ??= next;
  }
  return binding;
}

/**
 * Folds an ordered direct-write journal into the last observed state per path.
 * This replays metadata only; it never invents file bytes or claims that an
 * unobserved staging_shell mutation was covered.
 */
export function replayControlledRecoveryDelta(
  entries: readonly RecoveryControlledWrite[],
): ReadonlyMap<string, ReplayedRecoveryFileState> {
  getRecoveryControlledWriteBinding(entries);
  const state = new Map<string, ReplayedRecoveryFileState>();
  const pending = new Map<string, RecoveryControlledWrite>();
  for (const entry of entries) {
    if (!Value.Check(RecoveryControlledWriteSchema, entry))
      throw new Error("Recovery controlled write journal entry is invalid.");
    const key = `${entry.tool}:${entry.path}:${entry.sourcePath ?? ""}`;
    if (entry.phase === "before") {
      if (pending.has(key)) throw new Error(`Duplicate Recovery journal before: ${key}.`);
      pending.set(key, entry);
      if (entry.tool === "rename_file" && entry.sourcePath)
        state.set(entry.sourcePath, entry.before);
      state.set(entry.path, entry.tool === "rename_file" ? undefined : entry.before);
      continue;
    }
    const before = pending.get(key);
    if (!before) throw new Error(`Recovery journal ${entry.phase} has no before: ${key}.`);
    pending.delete(key);
    if (entry.phase === "after") {
      if (entry.tool === "rename_file" && entry.sourcePath)
        state.set(entry.sourcePath, undefined);
      state.set(entry.path, entry.after);
    }
  }
  if (pending.size > 0)
    throw new Error("Recovery controlled write journal ended with an incomplete operation.");
  return state;
}

/**
 * Replays successful direct writes with their immutable postimage bytes. A metadata
 * hash without an owned artifact is deliberately insufficient for byte restoration.
 */
export async function replayControlledRecoveryDeltaBytes(
  entries: readonly RecoveryControlledWrite[],
  readArtifact: (artifactId: string) => Promise<Uint8Array>,
): Promise<ReadonlyMap<string, { metadata: NonNullable<RecoveryControlledWrite["after"]>; bytes: Uint8Array } | undefined>> {
  const metadata = replayControlledRecoveryDelta(entries);
  const state = new Map<string, { metadata: NonNullable<RecoveryControlledWrite["after"]>; bytes: Uint8Array } | undefined>();
  for (const entry of entries) {
    if (entry.phase !== "after") continue;
    if (!entry.after) {
      if (entry.tool === "rename_file" && entry.sourcePath) state.set(entry.sourcePath, undefined);
      state.set(entry.path, undefined);
      continue;
    }
    const artifactId = entry.after.artifactId;
    if (!artifactId)
      throw new Error(`Recovery journal postimage has no immutable artifact: ${entry.path}.`);
    const bytes = await readArtifact(artifactId);
    if (bytes.byteLength !== entry.after.size || sha256(bytes) !== entry.after.contentHash)
      throw new Error(`Recovery journal postimage artifact integrity failed: ${artifactId}.`);
    if (entry.tool === "rename_file" && entry.sourcePath) state.set(entry.sourcePath, undefined);
    state.set(entry.path, { metadata: entry.after, bytes: new Uint8Array(bytes) });
  }
  for (const [path, value] of metadata) {
    if (!value) state.set(path, undefined);
  }
  return state;
}

/**
 * Journals the pre/post state of a direct Host-owned Recovery write.  It deliberately
 * excludes staging_shell: an arbitrary child process is an external/unobserved writer.
 */
/** Records a paired move without pretending that source absence is file content. */
export async function journalControlledRecoveryRename(
  input: {
    relativeSourcePath: string;
    sourceAbsolutePath: string;
    relativeTargetPath: string;
    targetAbsolutePath: string;
    rename: () => Promise<void>;
  },
  onWrite: RecoveryControlledWriteHook | undefined,
): Promise<void> {
  const before = await recoveryFileSnapshot(input.sourceAbsolutePath);
  if (!before)
    throw new Error(`Recovery rename source does not exist: ${input.relativeSourcePath}.`);
  if (await recoveryFileSnapshot(input.targetAbsolutePath))
    throw new Error(`Recovery rename target already exists: ${input.relativeTargetPath}.`);
  const entry = {
    schemaVersion: 1 as const,
    tool: "rename_file" as const,
    path: input.relativeTargetPath,
    sourcePath: input.relativeSourcePath,
  };
  await emit(onWrite, { ...entry, phase: "before", before });
  try {
    await input.rename();
  } catch (error) {
    const after = await recoveryFileSnapshot(input.targetAbsolutePath);
    await emit(onWrite, {
      ...entry,
      phase: "failed",
      before,
      ...(after ? { after } : {}),
    });
    throw error;
  }
  const after = await recoveryFileSnapshot(input.targetAbsolutePath);
  if (!after)
    throw new Error(`Recovery rename did not create ${input.relativeTargetPath}.`);
  if (await recoveryFileSnapshot(input.sourceAbsolutePath))
    throw new Error(`Recovery rename did not remove ${input.relativeSourcePath}.`);
  await emit(onWrite, { ...entry, phase: "after", before, after });
}

export async function journalControlledRecoveryWrite(
  input: {
    tool: RecoveryControlledWrite["tool"];
    relativePath: string;
    absolutePath: string;
    write: () => Promise<void>;
    /** Deletions are successful only when the post-state is absent. */
    expectAfter?: boolean;
  },
  onWrite: RecoveryControlledWriteHook | undefined,
): Promise<void> {
  const before = await recoveryFileSnapshot(input.absolutePath);
  await emit(onWrite, {
    schemaVersion: 1,
    tool: input.tool,
    phase: "before",
    path: input.relativePath,
    ...(before ? { before } : {}),
  });
  try {
    await input.write();
  } catch (error) {
    const after = await recoveryFileSnapshot(input.absolutePath);
    await emit(onWrite, {
      schemaVersion: 1,
      tool: input.tool,
      phase: "failed",
      path: input.relativePath,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
    throw error;
  }
  const after = await recoveryFileSnapshot(input.absolutePath);
  const expectAfter = input.expectAfter ?? true;
  if (expectAfter && !after)
    throw new Error(
      `Recovery controlled write did not create ${input.relativePath}.`,
    );
  if (!expectAfter && after)
    throw new Error(
      `Recovery controlled delete did not remove ${input.relativePath}.`,
    );
  await emit(onWrite, {
    schemaVersion: 1,
    tool: input.tool,
    phase: "after",
    path: input.relativePath,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  });
}

async function emit(
  onWrite: RecoveryControlledWriteHook | undefined,
  entry: RecoveryControlledWrite,
): Promise<void> {
  if (!Value.Check(RecoveryControlledWriteSchema, entry))
    throw new Error(
      "Recovery controlled write does not match RecoveryControlledWriteSchema.",
    );
  await onWrite?.(entry);
}

async function recoveryFileSnapshot(
  path: string,
): Promise<RecoveryFileSnapshot | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw new Error(
        "Recovery controlled write target must be a regular file.",
      );
    return {
      kind: "file",
      size: info.size,
      contentHash: await sha256File(path),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
