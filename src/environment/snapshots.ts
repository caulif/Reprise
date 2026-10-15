export const MAX_INLINE_HASH_BYTES = 8 * 1024 * 1024;

export type SnapshotLimits = {
  files: number;
  totalBytes: number;
  fileBytes: number;
};

export const SNAPSHOT_LIMITS: SnapshotLimits = {
  files: 50_000,
  totalBytes: 1024 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
};
