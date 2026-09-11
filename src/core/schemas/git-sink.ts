import { Type, type Static } from "@sinclair/typebox";

const GitSinkRefSchema = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: 512 }),
  sha: Type.String({ minLength: 1, maxLength: 64 }),
});
export type GitSinkRef = Static<typeof GitSinkRefSchema>;

const GitSinkRefChangeSchema = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: 512 }),
  kind: Type.Union([Type.Literal("added"), Type.Literal("removed"), Type.Literal("updated")]),
  before: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  after: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});
export type GitSinkRefChange = Static<typeof GitSinkRefChangeSchema>;

const GitSinkSkippedSchema = Type.Object({
  relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
});
export type GitSinkSkipped = Static<typeof GitSinkSkippedSchema>;

const GitSinkIssueCodeSchema = Type.Union([
  Type.Literal("incomplete_object_store"),
  Type.Literal("promisor_lazy_fetch_disabled"),
  Type.Literal("seed_fetch_failed"),
  Type.Literal("remote_rewrite_failed"),
  Type.Literal("gitdir_outside"),
  Type.Literal("manifest_missing"),
]);
export type GitSinkIssueCode = Static<typeof GitSinkIssueCodeSchema>;

const GitSinkIssueSchema = Type.Object({
  code: GitSinkIssueCodeSchema,
  objectId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});
export type GitSinkIssue = Static<typeof GitSinkIssueSchema>;

const GitSinkRepoRecordSchema = Type.Object({
  relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
  sinkName: Type.String({ minLength: 1, maxLength: 256 }),
  sinkPath: Type.String({ minLength: 1, maxLength: 4096 }),
  gitDirKind: Type.Union([
    Type.Literal("directory"),
    Type.Literal("file"),
    Type.Literal("worktree"),
    Type.Literal("bare"),
  ]),
  recordedUrls: Type.Array(Type.String({ maxLength: 2048 })),
  initialRefs: Type.Array(GitSinkRefSchema),
  finalRefs: Type.Optional(Type.Array(GitSinkRefSchema)),
  refChanges: Type.Optional(Type.Array(GitSinkRefChangeSchema)),
  isolation: Type.Union([Type.Literal("rewritten"), Type.Literal("skipped")]),
  objectStore: Type.Union([
    Type.Literal("seeded"),
    Type.Literal("not_seeded"),
    Type.Literal("seed_failed"),
    Type.Literal("absent"),
  ]),
  completeness: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unusable")]),
  issues: Type.Array(GitSinkIssueSchema),
});
export type GitSinkRepoRecord = Static<typeof GitSinkRepoRecordSchema>;

export const GitSinkManifestSchema = Type.Object({
  schemaVersion: Type.Literal(2),
  sinkId: Type.String({ minLength: 1, maxLength: 256 }),
  treeRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  sinkRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  status: Type.Union([Type.Literal("ready"), Type.Literal("partial"), Type.Literal("failed"), Type.Literal("missing")]),
  finalized: Type.Boolean(),
  repos: Type.Array(GitSinkRepoRecordSchema),
  skipped: Type.Array(GitSinkSkippedSchema),
  errors: Type.Array(Type.String({ minLength: 1, maxLength: 128 })),
});
export type GitSinkManifest = Static<typeof GitSinkManifestSchema>;

/** On-disk v1 catalogs from older experiments; Host migrates on read and never writes this shape. */
export const GitSinkManifestV1Schema = Type.Object({
  schemaVersion: Type.Literal(1),
  sinkId: Type.String({ minLength: 1, maxLength: 256 }),
  treeRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  sinkRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  status: Type.Union([Type.Literal("ready"), Type.Literal("partial"), Type.Literal("failed"), Type.Literal("missing")]),
  finalized: Type.Boolean(),
  repos: Type.Array(Type.Object({
    relativePath: Type.String({ minLength: 1, maxLength: 4096 }),
    sinkName: Type.String({ minLength: 1, maxLength: 256 }),
    sinkPath: Type.String({ minLength: 1, maxLength: 4096 }),
    gitDirKind: Type.Union([
      Type.Literal("directory"),
      Type.Literal("file"),
      Type.Literal("worktree"),
      Type.Literal("bare"),
    ]),
    recordedUrls: Type.Array(Type.String({ maxLength: 2048 })),
    initialRefs: Type.Array(GitSinkRefSchema),
    finalRefs: Type.Optional(Type.Array(GitSinkRefSchema)),
    refChanges: Type.Optional(Type.Array(GitSinkRefChangeSchema)),
    errors: Type.Array(Type.String({ minLength: 1, maxLength: 512 })),
  })),
  skipped: Type.Array(GitSinkSkippedSchema),
  errors: Type.Array(Type.String({ minLength: 1, maxLength: 512 })),
});
export type GitSinkManifestV1 = Static<typeof GitSinkManifestV1Schema>;
