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
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateWorkspaceBudget,
  LocalWorkspaceProvider,
  publishDirectory,
  SNAPSHOT_LIMITS,
} from "../src/environment/local-workspace-provider.js";

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

test("LocalWorkspaceProvider owns run paths and release is idempotent", async () => {
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
    await assert.rejects(stat(environment.root), { code: "ENOENT" });

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
  await git(["add", "."]);
  await git(["commit", "-m", "original"]);
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(join(source, "input.txt"), "completed\n");
  const provider = new LocalWorkspaceProvider(root);
  const staging = await provider.beginRecovery({
    caseId: "case-recovery",
    sourceRoot: source,
  });
  const shell = (await import("../src/infrastructure/recovery-tools.js"))
    .recoveryTools(
      staging.root,
      64,
      staging.temporaryRoot ? { homeRoot: staging.temporaryRoot } : {},
    )
    .find((item) => item.name === "staging_shell");
  assert.ok(shell);
  await shell.execute(
    { command: `git checkout ${commit} -- input.txt` },
    new AbortController().signal,
  );
  await writeFile(join(staging.root, "recovery.md"), "# recovered\n");
  const preview = await provider.validateRecovery(
    staging,
    {
      status: "recovered",
      reportPath: "recovery.md",
      unresolved: [],
      evidenceRefs: ["artifact:historical-commit"],
    },
    [{ ref: "artifact:historical-commit", kind: "git_commit", commit }],
  );
  assert.match(
    await readFile(
      join(preview.baseline.root ?? staging.root, "input.txt"),
      "utf8",
    ),
    /^original\r?\n$/,
  );
  assert.deepEqual(preview.changedPaths, [".git/index", "input.txt"]);
  const accepted = await provider.acceptRecovery(preview);
  assert.equal(accepted.match, "recovered");
  assert.match(
    await readFile(join(accepted.root ?? "", "input.txt"), "utf8"),
    /^original\r?\n$/,
  );
  assert.equal(
    await readFile(join(source, "input.txt"), "utf8"),
    "completed\n",
  );
  await assert.rejects(async () => provider.acceptRecovery(preview));
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
  await writeFile(join(source, "input.txt"), "completed\n");
  const provider = new LocalWorkspaceProvider(root);
  const invalid = await provider.beginRecovery({
    caseId: "case-invalid-recovery",
    sourceRoot: source,
  });
  await writeFile(join(invalid.root, "recovery.md"), "# invalid\n");
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
  await writeFile(join(staging.root, "input.txt"), "historical\n");
  await writeFile(join(staging.root, "recovery.md"), "# recovered\n");
  const preview = await provider.validateRecovery(
    staging,
    {
      status: "partial",
      reportPath: "recovery.md",
      unresolved: ["No commit metadata."],
      evidenceRefs: ["event:historical-1"],
    },
    [{ ref: "event:historical-1", kind: "historical_event" }],
  );
  const accepted = await provider.acceptRecovery(preview);
  const run = await provider.prepareRun(accepted, "run-preserve-recovery");
  assert.equal(
    await readFile(join(run.root, "input.txt"), "utf8"),
    "historical\n",
  );
  const replay = await provider.resolveBaseline(
    { caseId: "case-preserve-recovery", sourceRoot: source },
    [],
    {},
  );
  assert.equal(replay.match, "recovered_partial");
  assert.equal(
    await readFile(join(replay.root ?? "", "input.txt"), "utf8"),
    "historical\n",
  );
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
    "# Recovery\n\nNo verified rewind was available.\n",
  );

  const preview = await provider.validateRecovery(
    staging,
    {
      status: "partial",
      reportPath: "recovery.md",
      unresolved: ["No historical preimage."],
      evidenceRefs: ["event:history-1"],
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
  await writeFile(join(staging.root, "recovery.md"), "# Recovery\n");

  await assert.rejects(
    provider.validateRecovery(
      staging,
      {
        status: "partial",
        reportPath: "recovery.md",
        unresolved: ["Source was altered."],
        evidenceRefs: ["event:history-1"],
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
  assert.equal(preview.baseline.match, "matched");
  assert.equal(
    preview.baseline.fingerprint.digest,
    staging.sourceFingerprint.digest,
  );
  await provider.discardRecovery(staging);
});
