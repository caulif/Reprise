import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateWorkspaceBudget,
  LocalWorkspaceProvider,
  publishDirectory,
  recoveryCandidateDirName,
  SNAPSHOT_LIMITS,
} from "../src/environment/local-workspace-provider.js";
import { sha256 } from "../src/core/identity.js";

async function directories(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "reprise-env-"));
  const source = await mkdtemp(join(tmpdir(), "reprise-source-"));
  await writeFile(join(source, "input.txt"), "original");
  return { root, source };
}

test("LocalWorkspaceProvider isolates a run and fingerprints before/after changes", async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-1", sourceRoot: source },
      [],
      {},
    );
    assert.equal(baseline.readiness.runnable, "isolated");
    const environment = await provider.prepareRun(baseline, "run-1");
    assert.equal(environment.mode, "isolated");
    assert.equal(
      await readFile(join(environment.root, "input.txt"), "utf8"),
      "original",
    );

    const before = await provider.fingerprint(environment);
    await writeFile(join(environment.root, "input.txt"), "changed");
    const after = await provider.fingerprint(environment);
    assert.notEqual(before.digest, after.digest);
    assert.equal(await readFile(join(source, "input.txt"), "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider removes a partially copied run when preparation fails", async () => {
  const { root, source } = await directories();
  try {
    const baseline = await new LocalWorkspaceProvider(root).resolveBaseline(
      { caseId: "case-partial", sourceRoot: source },
      [],
      {},
    );
    const provider = new LocalWorkspaceProvider(
      root,
      async (_source, destination) => {
        await writeFile(join(destination, "partial.txt"), "partial copy");
        throw new Error("simulated second-file copy failure");
      },
    );
    await assert.rejects(
      provider.prepareRun(baseline, "run-partial"),
      /simulated second-file copy failure/,
    );
    await assert.rejects(stat(join(root, "runs", "run-partial")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider removes an uncommitted baseline residue before recapturing", async () => {
  const { root, source } = await directories();
  try {
    const baselineRoot = join(root, "baselines", "case-residue");
    await mkdir(baselineRoot, { recursive: true });
    await writeFile(join(baselineRoot, "stale.txt"), "partial capture");

    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-residue", sourceRoot: source },
      [],
      {},
    );
    assert.equal(
      await readFile(join(baseline.root ?? "", "input.txt"), "utf8"),
      "original",
    );
    await assert.rejects(stat(join(baseline.root ?? "", "stale.txt")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider retries a failed baseline capture without leaving artifacts", async () => {
  const { root, source } = await directories();
  let attempts = 0;
  try {
    const provider = new LocalWorkspaceProvider(
      root,
      async (from, destination) => {
        attempts += 1;
        assert.match(destination, /[\\/]\.case-retry\.staging-/);
        if (attempts === 1) {
          await writeFile(join(destination, "partial.txt"), "partial capture");
          throw new Error("simulated baseline copy failure");
        }
        await cp(from, destination, { recursive: true });
      },
    );
    await assert.rejects(
      provider.resolveBaseline(
        { caseId: "case-retry", sourceRoot: source },
        [],
        {},
      ),
      /simulated baseline copy failure/,
    );
    const baselinesRoot = join(root, "baselines");
    assert.deepEqual(await readdir(baselinesRoot), []);

    const baseline = await provider.resolveBaseline(
      { caseId: "case-retry", sourceRoot: source },
      [],
      {},
    );
    assert.equal(attempts, 2);
    assert.equal(
      await readFile(join(baseline.root ?? "", "input.txt"), "utf8"),
      "original",
    );
    assert.ok((await readdir(baselinesRoot)).includes("case-retry"));
    assert.ok(
      (await readdir(baselinesRoot)).includes("case-retry.marker.json"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("release keeps the isolated run workspace and is idempotent", async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-2", sourceRoot: source },
      [],
      {},
    );
    const environment = await provider.prepareRun(baseline, "run-2");
    await assert.rejects(
      provider.prepareRun(baseline, "run-2"),
      /already exists/,
    );
    await provider.release(environment);
    await assert.rejects(provider.fingerprint(environment), /owned|workspace/);
    assert.deepEqual(await provider.release(environment), {
      status: "already_released",
      environmentId: environment.environmentId,
    });
    assert.equal(
      await readFile(join(environment.root, "input.txt"), "utf8"),
      "original",
    );

    const forged = { ...environment, root: source };
    await assert.rejects(provider.fingerprint(forged), /owned|workspace/);
    await assert.rejects(
      provider.release({ ...environment, root: join(root, "runs", "unowned") }),
      /owned|workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider refuses to reuse a baseline whose source has changed", async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const first = await provider.resolveBaseline(
      { caseId: "case-drift", sourceRoot: source },
      [],
      {},
    );
    const again = await provider.resolveBaseline(
      { caseId: "case-drift", sourceRoot: source },
      [],
      {},
    );
    assert.equal(first.fingerprint.digest, again.fingerprint.digest);

    await writeFile(
      join(source, "input.txt"),
      "edited after the baseline was captured",
    );
    await assert.rejects(
      provider.resolveBaseline(
        { caseId: "case-drift", sourceRoot: source },
        [],
        {},
      ),
      /changed since its baseline was captured/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("inspectBaseline and resolveBaseline share the source fingerprint and keep harness markers out of the copy", async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const inspected = await provider.inspectBaseline(
      { caseId: "case-marker", sourceRoot: source },
      [],
      {},
    );
    const resolved = await provider.resolveBaseline(
      { caseId: "case-marker", sourceRoot: source },
      [],
      {},
    );
    assert.equal(resolved.fingerprint.digest, inspected.fingerprint.digest);
    assert.ok(resolved.root);
    const environment = await provider.prepareRun(resolved, "run-marker");
    await assert.rejects(
      stat(join(environment.root, ".reprise-baseline.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(stat(join(resolved.root ?? "", "input.txt")), {
      code: "ENOENT",
    });
    assert.ok(
      (await readdir(join(root, "baselines"))).includes(
        "case-marker.marker.json",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider fingerprints a file larger than the inline hash limit", async () => {
  const { root, source } = await directories();
  try {
    await writeFile(
      join(source, "large.bin"),
      Buffer.alloc(9 * 1024 * 1024, 7),
    );
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-large", sourceRoot: source },
      [],
      {},
    );
    const large = baseline.fingerprint.resources.find(
      (resource) => resource.path === "large.bin",
    );
    assert.equal(large?.size, 9 * 1024 * 1024);
    assert.match(large?.contentHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("LocalWorkspaceProvider reports an unavailable source as unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-env-"));
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-3", sourceRoot: join(root, "missing") },
      [],
      {},
    );
    assert.equal(baseline.mode, "unsupported");
    assert.equal(baseline.readiness.runnable, "unsupported");
    await assert.rejects(provider.prepareRun(baseline, "run-3"), /unsupported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishDirectory retries a busy rename then publishes the staging tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-publish-"));
  const staging = join(root, "staging");
  const destination = join(root, "dest");
  await mkdir(staging);
  await writeFile(join(staging, "input.txt"), "copied");
  let attempts = 0;
  try {
    await publishDirectory(staging, destination, async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(
          new Error("EPERM: operation not permitted, rename"),
          { code: "EPERM" },
        );
      }
      await rename(from, to);
    });
    assert.equal(attempts, 3);
    assert.equal(
      await readFile(join(destination, "input.txt"), "utf8"),
      "copied",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishDirectory copies when every rename attempt stays busy", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-publish-copy-"));
  const staging = join(root, "staging");
  const destination = join(root, "dest");
  await mkdir(staging);
  await writeFile(join(staging, "input.txt"), "copied");
  const busy = Object.assign(
    new Error("EPERM: operation not permitted, rename"),
    { code: "EPERM" },
  );
  try {
    await publishDirectory(staging, destination, async () => {
      throw busy;
    });
    assert.equal(
      await readFile(join(destination, "input.txt"), "utf8"),
      "copied",
    );
    await assert.rejects(stat(staging), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareRun drops the baseline copy after the isolated run workspace exists", async () => {
  const { root, source } = await directories();
  try {
    const provider = new LocalWorkspaceProvider(root);
    const baseline = await provider.resolveBaseline(
      { caseId: "case-drop", sourceRoot: source },
      [],
      {},
    );
    const environment = await provider.prepareRun(baseline, "run-drop");
    assert.equal(
      await readFile(join(environment.root, "input.txt"), "utf8"),
      "original",
    );
    await assert.rejects(stat(join(root, "baselines", "case-drop")), {
      code: "ENOENT",
    });
    const again = await provider.resolveBaseline(
      { caseId: "case-drop", sourceRoot: source },
      [],
      {},
    );
    assert.equal(again.fingerprint.digest, baseline.fingerprint.digest);
    assert.equal(
      await readFile(join(again.root ?? "", "input.txt"), "utf8"),
      "original",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("Recovery preflight audits sensitive file categories without retaining paths or contents", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, ".env.local"), "API_KEY=never-record-this");
  await writeFile(join(source, "auth.json"), '{"token":"never-record-this"}');
  await writeFile(join(source, "deploy.pem"), "never-record-this");

  const baseline = await new LocalWorkspaceProvider(root).resolveBaseline(
    { caseId: "case-sensitive-scan", sourceRoot: source },
    [],
    {},
  );

  assert.deepEqual(baseline.budget.sensitiveFileCounts, { env: 1, credential: 1, private_key: 1 });
  assert.equal(JSON.stringify(baseline.budget).includes(".env.local"), false);
  assert.equal(JSON.stringify(baseline.budget).includes("never-record-this"), false);
});

test("workspace budget blocks each configured snapshot limit before copying", () => {
  const budget = calculateWorkspaceBudget([
    { kind: "file", size: SNAPSHOT_LIMITS.fileBytes + 1 },
    ...Array.from({ length: SNAPSHOT_LIMITS.files }, () => ({
      kind: "file" as const,
      size: 0,
    })),
    { kind: "file", size: SNAPSHOT_LIMITS.totalBytes + 1 },
  ]);
  assert.equal(budget.fileCount, SNAPSHOT_LIMITS.files + 2);
  assert.equal(budget.largestFileBytes, SNAPSHOT_LIMITS.totalBytes + 1);
  assert.equal(budget.blockedReasons.length, 3);
});

test("Recovery uses a Host-owned checkpoint instead of the mutated source", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: "case-checkpoint", sourceRoot: source });
  await writeFile(join(source, "input.txt"), "completed-after-interruption");
  // The recovery process may restart after interruption, so ownership is restored from schema-checked metadata rather than an in-memory map.
  const reopenedProvider = new LocalWorkspaceProvider(root);
  const staging = await reopenedProvider.beginRecovery({ caseId: "case-checkpoint", sourceRoot: source, checkpointRoot: checkpoint.root });
  assert.equal(await readFile(join(staging.root, "input.txt"), "utf8"), "original");
  assert.equal(await readFile(join(source, "input.txt"), "utf8"), "completed-after-interruption");
  assert.equal(staging.checkpointFingerprint?.digest, checkpoint.fingerprint.digest);
  await reopenedProvider.discardRecovery(staging);
});

test("Recovery rejects a tampered or foreign checkpoint without touching the source", async (t) => {
  const { root, source } = await directories();
  const foreign = await mkdtemp(join(tmpdir(), "reprise-foreign-checkpoint-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: "case-checkpoint-tamper", sourceRoot: source });
  await writeFile(join(checkpoint.root, "input.txt"), "tampered");
  await assert.rejects(
    provider.beginRecovery({ caseId: "case-checkpoint-tamper", sourceRoot: source, checkpointRoot: checkpoint.root }),
    /fingerprint does not match/i,
  );
  await assert.rejects(
    provider.beginRecovery({ caseId: "case-checkpoint-foreign", sourceRoot: source, checkpointRoot: foreign }),
    /provider-owned|not owned/i,
  );
  assert.equal(await readFile(join(source, "input.txt"), "utf8"), "original");
});

test("Recovery validates isolated git checkout, report, accept, and marker reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-env-"));
  const source = await mkdtemp(join(tmpdir(), "reprise-recovery-source-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "input.txt"), "original\r\n");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const git = async (args: string[]) =>
    (await exec("git", args, { cwd: source, windowsHide: true })).stdout;
  await git(["init"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "core.autocrlf", "false"]);
  await git(["add", "."]);
  await git(["commit", "-m", "original"]);
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(join(source, "input.txt"), "completed\r\n");
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({
    caseId: "case-recovery",
    sourceRoot: source,
  });
  const shell = (await import("../src/infrastructure/recovery-tools.js"))
    .recoveryTools(
      staging.root,
      staging.temporaryRoot ? { homeRoot: staging.temporaryRoot, allowShell: true } : { allowShell: true },
    )
    .find((item) => item.name === "shell_exec");
  assert.ok(shell);
  await shell.execute(
    { command: `git checkout ${commit} -- input.txt` },
    new AbortController().signal,
  );
  await writeFile(join(staging.root, "recovery.md"), "# recovered\r\n");
  await writeFile(join(staging.root, "recovery-manifest.json"), JSON.stringify({
    actions: [{
      operation: "restore",
      path: "input.txt",
      beforeHash: sha256(await readFile(join(source, "input.txt"))),
      afterHash: sha256(await readFile(join(staging.root, "input.txt"))),
      evidenceRefs: ["artifact:historical-commit"],
    }],
    unresolved: [],
  }));
  const preview = await provider.validateRecovery(
    staging,
    {
      status: "recovered",
      reportPath: "recovery.md",
      unresolved: [],
      evidenceRefs: ["artifact:historical-commit"],
      manifestPath: "recovery-manifest.json",
    },
    [{ ref: "artifact:historical-commit", kind: "git_commit", commit }],
  );
  assert.match(
    await readFile(
      join(preview.baseline.root ?? staging.root, "input.txt"),
      "utf8",
    ),
    /^original\r?\r\n$/,
  );
  assert.deepEqual(preview.changedPaths, ["input.txt"]);
  const accepted = await provider.acceptRecovery(preview);
  assert.equal(accepted.match, "recovered");
  assert.match(
    await readFile(join(accepted.root ?? "", "input.txt"), "utf8"),
    /^original\r?\r\n$/,
  );
  assert.equal(
    await readFile(join(source, "input.txt"), "utf8"),
    "completed\r\n",
  );
  await assert.rejects(async () => provider.acceptRecovery(preview));
});

test("Recovery provider rejects manifest path mismatches and unowned action evidence", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const envelope = {
    status: "partial" as const,
    reportPath: "recovery.md" as const,
    unresolved: ["No strong preimage."],
    evidenceRefs: ["event:history-1"],
    manifestPath: "recovery-manifest.json" as const,
  };
  const evidence = [{ ref: "event:history-1", kind: "historical_event" as const }];

  const extra = await provider.beginRecovery({ caseId: "case-manifest-extra", sourceRoot: source });
  await writeFile(join(extra.root, "input.txt"), "historical");
  await writeFile(join(extra.root, "other.txt"), "also changed");
  await writeFile(join(extra.root, "recovery.md"), "# partial\r\n");
  await writeFile(join(extra.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "modify", path: "input.txt", evidenceRefs: ["event:history-1"] }], unresolved: envelope.unresolved }));
  const extraPreview = await provider.validateRecovery(extra, envelope, evidence);
  assert.equal(extraPreview.baseline.match, "recovered_partial");
  assert.ok(extraPreview.changedPaths.includes("other.txt"));
  const acceptedExtra = await provider.acceptRecovery(extraPreview);
  assert.equal(acceptedExtra.match, "recovered_partial");

  const excess = await provider.beginRecovery({ caseId: "case-manifest-excess", sourceRoot: source });
  await writeFile(join(excess.root, "input.txt"), "historical");
  await writeFile(join(excess.root, "recovery.md"), "# partial\r\n");
  await writeFile(join(excess.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "modify", path: "input.txt", evidenceRefs: ["event:history-1"] }, { operation: "create", path: "other.txt", evidenceRefs: ["event:history-1"] }], unresolved: envelope.unresolved }));
  const extraPreview2 = await provider.validateRecovery(excess, envelope, evidence);
  assert.equal(extraPreview2.baseline.match, "recovered_partial");

  const recoveredExtra = await provider.beginRecovery({ caseId: "case-manifest-recovered-extra", sourceRoot: source });
  await writeFile(join(recoveredExtra.root, "input.txt"), "historical");
  await writeFile(join(recoveredExtra.root, "other.txt"), "also changed");
  await writeFile(join(recoveredExtra.root, "recovery.md"), "# recovered\r\n");
  await writeFile(join(recoveredExtra.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "modify", path: "input.txt", evidenceRefs: ["event:history-1"] }], unresolved: [] }));
  const remapped = await provider.validateRecovery(recoveredExtra, { ...envelope, status: "recovered", unresolved: [] }, evidence);
  assert.equal(remapped.baseline.match, "recovered_partial");
  assert.equal(remapped.baseline.recovery?.status, "partial");
  assert.match(remapped.baseline.recovery?.unresolved.join(" ") ?? "", /remapped recovered to partial/);
  assert.ok(remapped.changedPaths.includes("other.txt"));
  const acceptedRemapped = await provider.acceptRecovery(remapped);
  assert.equal(acceptedRemapped.match, "recovered_partial");

  const unowned = await provider.beginRecovery({ caseId: "case-manifest-unowned", sourceRoot: source });
  await writeFile(join(unowned.root, "input.txt"), "historical");
  await writeFile(join(unowned.root, "recovery.md"), "# partial\r\n");
  await writeFile(join(unowned.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "modify", path: "input.txt", evidenceRefs: ["event:other"] }], unresolved: envelope.unresolved }));
  await assert.rejects(provider.validateRecovery(unowned, { ...envelope, evidenceRefs: ["event:not-owned-ref"] }, evidence), /not owned/i);

  const unchanged = await provider.beginRecovery({ caseId: "case-manifest-unchanged", sourceRoot: source });
  await writeFile(join(unchanged.root, "recovery.md"), "# recovered\r\n");
  await writeFile(join(unchanged.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "restore", path: "input.txt", evidenceRefs: ["event:history-1"] }], unresolved: [] }));
  await assert.rejects(provider.validateRecovery(unchanged, { ...envelope, status: "recovered", unresolved: [] }, evidence), /paths/i);

  const emptyRefs = await provider.beginRecovery({ caseId: "case-manifest-empty-refs", sourceRoot: source });
  await writeFile(join(emptyRefs.root, "input.txt"), "historical");
  await writeFile(join(emptyRefs.root, "recovery.md"), "# partial\r\n");
  const emptyPreview = await provider.validateRecovery(emptyRefs, {
    status: "partial",
    reportPath: "recovery.md",
    unresolved: envelope.unresolved,
    evidenceRefs: [],
  }, evidence);
  assert.equal(emptyPreview.baseline.match, "recovered_partial");
  assert.ok(emptyPreview.changedPaths.includes("input.txt"));
});

test("Recovery provider rejects unverified complete envelopes and preserves accepted recovered baselines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-provider-"));
  const source = await mkdtemp(
    join(tmpdir(), "reprise-recovery-provider-source-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "input.txt"), "completed\r\n");
  const provider = new LocalWorkspaceProvider(root);
  const invalid = await provider.beginRecovery({
    caseId: "case-invalid-recovery",
    sourceRoot: source,
  });
  await writeFile(join(invalid.root, "recovery.md"), "# invalid\r\n");
  await assert.rejects(
    provider.validateRecovery(invalid, {
      status: "recovered",
      reportPath: "recovery.md",
      unresolved: ["missing proof"],
      evidenceRefs: [],
    }),
    /invalid/i,
  );
  const staging = await provider.beginRecovery({
    caseId: "case-preserve-recovery",
    sourceRoot: source,
  });
  await writeFile(join(staging.root, "input.txt"), "historical\r\n");
  await writeFile(join(staging.root, "recovery.md"), "# recovered\r\n");
  await writeFile(join(staging.root, "recovery-manifest.json"), JSON.stringify({ actions: [{ operation: "modify", path: "input.txt", evidenceRefs: ["event:historical-1"] }], unresolved: ["No commit metadata."] }));
  const preview = await provider.validateRecovery(
    staging,
    {
      status: "partial",
      reportPath: "recovery.md",
      unresolved: ["No commit metadata."],
      evidenceRefs: ["event:historical-1"],
      manifestPath: "recovery-manifest.json",
    },
    [{ ref: "event:historical-1", kind: "historical_event" }],
  );
  const accepted = await provider.acceptRecovery(preview);
  const run = await provider.prepareRun(accepted, "run-preserve-recovery");
  assert.equal(
    await readFile(join(run.root, "input.txt"), "utf8"),
    "historical\r\n",
  );
  const replay = await provider.resolveBaseline(
    { caseId: "case-preserve-recovery", sourceRoot: source },
    [],
    {},
  );
  assert.equal(replay.match, "recovered_partial");
  assert.equal(
    await readFile(join(replay.root ?? "", "input.txt"), "utf8"),
    "historical\r\n",
  );
});

test("Recovery candidates isolate competing hypotheses and are discarded with their parent staging", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({ caseId: "case-candidates", sourceRoot: source });
  assert.match(staging.recoveryId, /^[0-9a-f]{32}$/);
  assert.equal(staging.root, join(root, "rs", staging.recoveryId));
  assert.equal(staging.temporaryRoot, join(root, "rt", staging.recoveryId));
  const first = await provider.createRecoveryCandidate(staging, {
    candidateId: "candidate-git", hypothesisId: "hypothesis-git",
  });
  assert.equal(first.root, join(root, "rc", staging.recoveryId, recoveryCandidateDirName("candidate-git")));
  assert.equal(recoveryCandidateDirName("candidate-historical-observations").length, 8);
  assert.doesNotMatch(first.root, /candidate-historical-observations|candidate-git/);
  const second = await provider.createRecoveryCandidate(staging, {
    candidateId: "candidate-patch", hypothesisId: "hypothesis-patch",
  });
  await writeFile(join(first.root, "input.txt"), "git hypothesis");
  assert.equal(await readFile(join(second.root, "input.txt"), "utf8"), "original");
  assert.equal(await readFile(join(staging.root, "input.txt"), "utf8"), "original");
  assert.notEqual((await provider.fingerprintRecoveryCandidate(first)).digest, first.beforeFingerprint.digest);
  assert.equal((await provider.fingerprintRecoveryCandidate(second)).digest, second.beforeFingerprint.digest);
  await provider.discardRecovery(staging);
  await assert.rejects(stat(first.root));
  await assert.rejects(stat(second.root));
});

test("Recovery candidate selection promotes only the chosen isolated snapshot", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({ caseId: "case-select", sourceRoot: source });
  const selected = await provider.createRecoveryCandidate(staging, {
    candidateId: "candidate-selected", hypothesisId: "hypothesis-selected",
  });
  const sibling = await provider.createRecoveryCandidate(staging, {
    candidateId: "candidate-sibling", hypothesisId: "hypothesis-sibling",
  });
  await writeFile(join(selected.root, "input.txt"), "selected candidate");
  await provider.selectRecoveryCandidate(staging, selected);
  assert.equal(await readFile(join(staging.root, "input.txt"), "utf8"), "selected candidate");
  assert.equal(await readFile(join(sibling.root, "input.txt"), "utf8"), "original");

  const otherStaging = await provider.beginRecovery({ caseId: "case-select-other", sourceRoot: source });
  const foreign = await provider.createRecoveryCandidate(otherStaging, {
    candidateId: "candidate-foreign", hypothesisId: "hypothesis-foreign",
  });
  await assert.rejects(provider.selectRecoveryCandidate(staging, foreign), /different staging session/);
  await provider.discardRecovery(staging);
  await provider.discardRecovery(otherStaging);
});

test("Recovery provider replays artifact-backed direct deltas transactionally", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({ caseId: "case-delta-replay", sourceRoot: source });
  const bytes = Buffer.from("restored binary\0payload");
  const entries = [
    { schemaVersion: 1 as const, tool: "write_binary_file" as const, phase: "before" as const, path: "input.bin", before: { kind: "file" as const, size: 8, contentHash: sha256("original") } },
    { schemaVersion: 1 as const, tool: "write_binary_file" as const, phase: "after" as const, path: "input.bin", before: { kind: "file" as const, size: 8, contentHash: sha256("original") }, after: { kind: "file" as const, size: bytes.length, contentHash: sha256(bytes), artifactId: "postimage-input" } },
    { schemaVersion: 1 as const, tool: "rename_file" as const, phase: "before" as const, path: "renamed.txt", sourcePath: "input.txt", before: { kind: "file" as const, size: 8, contentHash: sha256("original") } },
    { schemaVersion: 1 as const, tool: "rename_file" as const, phase: "after" as const, path: "renamed.txt", sourcePath: "input.txt", before: { kind: "file" as const, size: 8, contentHash: sha256("original") }, after: { kind: "file" as const, size: 8, contentHash: sha256("original"), artifactId: "postimage-renamed" } },
  ];
  const artifacts = new Map([["postimage-input", bytes], ["postimage-renamed", Buffer.from("original")]]);
  const result = await provider.applyControlledRecoveryDelta(staging, entries, async (id) => artifacts.get(id) ?? new Uint8Array());
  assert.equal(result.digest, (await provider.fingerprintRecoveryCandidate(await provider.createRecoveryCandidate(staging, { candidateId: "digest-check", hypothesisId: "h" }))).digest);
  assert.deepEqual(await readFile(join(staging.root, "input.bin")), bytes);
  assert.equal(await readFile(join(staging.root, "renamed.txt"), "utf8"), "original");
  await assert.rejects(stat(join(staging.root, "input.txt")));
  await provider.discardRecovery(staging);
});

test("Recovery provider rejects tampered delta without changing staging", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({ caseId: "case-delta-tamper", sourceRoot: source });
  const before = await provider.fingerprintRecoveryCandidate(await provider.createRecoveryCandidate(staging, { candidateId: "before", hypothesisId: "h" }));
  const entries = [{ schemaVersion: 1 as const, tool: "write" as const, phase: "after" as const, path: "input.txt", after: { kind: "file" as const, size: 6, contentHash: sha256("honest"), artifactId: "tampered" } }];
  await assert.rejects(provider.applyControlledRecoveryDelta(staging, entries, async () => Buffer.from("wrong")), /integrity|before/);
  assert.equal((await provider.fingerprintRecoveryCandidate(await provider.createRecoveryCandidate(staging, { candidateId: "after", hypothesisId: "h2" }))).digest, before.digest);
  await provider.discardRecovery(staging);
});
test("Recovery provider rejects conflicting delta bindings transactionally", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({ caseId: "case-delta-binding", sourceRoot: source });
  const baseline = (await provider.fingerprintRecoveryStaging(staging)).digest;
  const metadata = { kind: "file" as const, size: 3, contentHash: sha256("new") };
  const entry = (baseDigest: string, checkpointId?: string) => ({
    schemaVersion: 1 as const,
    tool: "write" as const,
    phase: "after" as const,
    path: "new.txt",
    ...(checkpointId ? { checkpointId } : {}),
    baseDigest,
    after: { ...metadata, artifactId: "new-artifact" },
  });
  await assert.rejects(
    provider.applyControlledRecoveryDelta(staging, [entry(baseline), entry("f".repeat(64))], async () => Buffer.from("new")),
    /conflicting bindings/,
  );
  await assert.rejects(
    provider.applyControlledRecoveryDelta(staging, [entry(baseline, "checkpoint-foreign")], async () => Buffer.from("new")),
    /checkpoint/,
  );
  await assert.rejects(
    provider.applyControlledRecoveryDelta(staging, [entry("f".repeat(64))], async () => Buffer.from("new")),
    /base fingerprint/,
  );
  assert.equal((await provider.fingerprintRecoveryStaging(staging)).digest, baseline);
  await provider.discardRecovery(staging);
});

test("Recovery records verified source tripwire and Playbook provenance", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const playbook = {
    productId: "codex",
    version: "codex-recovery/v1",
    sha256: "a".repeat(64),
  };
  const staging = await provider.beginRecovery({
    caseId: "case-recovery-provenance",
    sourceRoot: source,
    playbook,
  });
  await writeFile(
    join(staging.root, "recovery.md"),
    "# Recovery\r\n\r\nNo verified rewind was available.\r\n",
  );

  await writeFile(join(staging.root, "recovery-manifest.json"), JSON.stringify({ actions: [], unresolved: ["No historical preimage."] }));
  const preview = await provider.validateRecovery(
    staging,
    {
      status: "partial",
      reportPath: "recovery.md",
      unresolved: ["No historical preimage."],
      evidenceRefs: ["event:history-1"],
      manifestPath: "recovery-manifest.json",
    },
    [{ ref: "event:history-1", kind: "historical_event" }],
  );

  assert.equal(
    preview.baseline.recovery?.sourceTripwire?.before,
    preview.baseline.recovery?.sourceTripwire?.after,
  );
  assert.deepEqual(preview.baseline.recovery?.playbook, playbook);
  await provider.discardRecovery(staging);
});

test("Recovery discards staging and temporary HOME when the source tripwire changes", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({
    caseId: "case-recovery-tripwire",
    sourceRoot: source,
  });
  await writeFile(join(source, "input.txt"), "out-of-bounds change");
  await writeFile(join(staging.root, "recovery.md"), "# Recovery\r\n");

  await assert.rejects(
    provider.validateRecovery(
      staging,
      {
        status: "partial",
        reportPath: "recovery.md",
        unresolved: ["Source was altered."],
        evidenceRefs: ["event:history-1"],
        manifestPath: "recovery-manifest.json",
      },
      [{ ref: "event:history-1", kind: "historical_event" }],
    ),
    /user source directory/i,
  );
  await assert.rejects(stat(staging.root));
  await assert.rejects(stat(staging.temporaryRoot ?? ""));
});

test("insufficient evidence keeps an unchanged staging copy matched to current state", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({
    caseId: "case-insufficient",
    sourceRoot: source,
  });
  const preview = await provider.validateRecovery(staging, {
    status: "insufficient_evidence",
    reportPath: "recovery.md",
    unresolved: ["no evidence"],
    evidenceRefs: [],
  });
  assert.equal(preview.baseline.match, "current_state_fallback");
  assert.equal(
    preview.baseline.fingerprint.digest,
    staging.sourceFingerprint.digest,
  );
  await provider.discardRecovery(staging);
});

test("workspace junctions are skipped, recorded, and do not block a partial candidate", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  const outside = await mkdtemp(join(tmpdir(), "reprise-link-target-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside");
  await mkdir(join(source, "ppt_build"));
  await writeFile(join(source, "readme.txt"), "keep");
  try {
    await symlink(outside, join(source, "ppt_build", "node_modules"), "junction");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
      t.skip("directory junction creation is unavailable in this environment");
      return;
    }
    throw error;
  }
  const provider = new LocalWorkspaceProvider(root);
  const inspected = await provider.inspectBaseline({ caseId: "case-junction", sourceRoot: source }, [], {});
  assert.equal(inspected.readiness.runnable, "isolated");
  assert.equal(inspected.budget.blockedReasons.length, 0);
  assert.ok(inspected.budget.excludedEntries?.some((item) => item.reasonCode === "workspace.symlink_skipped"));
  assert.equal(inspected.fingerprint.resources.some((item) => item.path.includes("node_modules")), false);
  const staging = await provider.beginRecovery({ caseId: "case-junction", sourceRoot: source });
  assert.equal(await readFile(join(staging.root, "readme.txt"), "utf8"), "keep");
  await assert.rejects(stat(join(staging.root, "ppt_build", "node_modules")));
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  await provider.discardRecovery(staging);
});

test("in-root file links are materialized as ordinary files without keeping a writable link", async (t) => {
  const { root, source } = await directories();
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "target.txt"), "inside");
  try {
    await symlink("target.txt", join(source, "link.txt"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
      t.skip("Windows symlink creation is unavailable in this environment");
      return;
    }
    throw error;
  }
  const provider = new LocalWorkspaceProvider(root);
  const inspected = await provider.inspectBaseline({ caseId: "case-inroot-link", sourceRoot: source }, [], {});
  assert.equal(inspected.fingerprint.resources.some((item) => item.path === "link.txt"), true);
  const staging = await provider.beginRecovery({ caseId: "case-inroot-link", sourceRoot: source });
  assert.equal(await readFile(join(staging.root, "link.txt"), "utf8"), "inside");
  const copied = await lstat(join(staging.root, "link.txt"));
  assert.equal(copied.isSymbolicLink(), false);
  await provider.discardRecovery(staging);
});



