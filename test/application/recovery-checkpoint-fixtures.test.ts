import test from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "../../src/core/identity.js";
import { evaluateRecoveryCases } from "../../src/application/recovery/evaluation.js";
import { LocalWorkspaceProvider } from "../../src/environment/local-workspace-provider.js";

const exec = promisify(execFile);
const checkpointFiles = {
  "tracked.txt": "tracked-before",
  "nested/notes.md": "nested-before",
  "binary.bin": new Uint8Array([0, 255, 16, 128, 1]),
  "untracked.txt": "untracked-before",
} as const;

async function gitInit(root: string, commit: boolean): Promise<void> {
  await exec("git", ["init"], { cwd: root, windowsHide: true });
  await exec("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root, windowsHide: true });
  await exec("git", ["config", "user.name", "Recovery Fixture"], { cwd: root, windowsHide: true });
  if (commit) {
    await exec("git", ["add", "tracked.txt", "nested", "binary.bin"], { cwd: root, windowsHide: true });
    await exec("git", ["commit", "-m", "checkpoint"], { cwd: root, windowsHide: true });
  }
}

async function writeCheckpointFixture(source: string, id: string): Promise<void> {
  for (const [path, content] of Object.entries(checkpointFiles)) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof content === "string" ? `${id}-${content}` : content, { flag: "w" });
  }
}

async function assertCheckpointContents(root: string, id: string): Promise<void> {
  for (const [path, content] of Object.entries(checkpointFiles)) {
    const actual = await readFile(join(root, path));
    const expected = typeof content === "string" ? Buffer.from(`${id}-${content}`) : Buffer.from(content);
    assert.deepEqual(actual, expected, `${id}: ${path} must match its pre-interruption bytes`);
  }
}

test("checkpoint fixtures restore per-path bytes across Git, unborn Git, and non-Git interrupted workspaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-checkpoint-fixtures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = [];
  for (const fixture of [
    { id: "git", git: true, commit: true },
    { id: "unborn-git", git: true, commit: false },
    { id: "non-git", git: false, commit: false },
  ]) {
    const source = await mkdtemp(join(root, `${fixture.id}-source-`));
    const provider = new LocalWorkspaceProvider(join(root, `${fixture.id}-provider`));
    await writeCheckpointFixture(source, fixture.id);
    if (fixture.git) await gitInit(source, fixture.commit);
    const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: `case-${fixture.id}`, sourceRoot: source });
    const expectedDigests = new Map(Object.entries(checkpointFiles).map(([path, content]) => [
      path,
      sha256(typeof content === "string" ? `${fixture.id}-${content}` : content),
    ]));
    for (const [path, digest] of expectedDigests) {
      assert.equal(checkpoint.fingerprint.resources.find((entry) => entry.path === path)?.contentHash, digest, `${fixture.id}: checkpoint digest must retain ${path}`);
    }
    await writeFile(join(source, "tracked.txt"), `${fixture.id}-tracked-after`);
    await writeFile(join(source, "binary.bin"), new Uint8Array([9, 9, 9]));
    await rm(join(source, "untracked.txt"));
    const staging = await provider.beginRecovery({ caseId: `case-${fixture.id}`, sourceRoot: source, checkpointRoot: checkpoint.root });
    await assertCheckpointContents(staging.root, fixture.id);
    assert.equal(staging.checkpointFingerprint?.digest, checkpoint.fingerprint.digest, `${fixture.id}: staging must retain the captured checkpoint digest after source deletion`);
    rows.push({
      schemaVersion: 1,
      caseId: `case-${fixture.id}`,
      layer: "interrupted_checkpoint",
      forensicsStarted: true,
      candidateCreated: true,
      candidateReplayPassed: true,
      verification: "verified",
      recoveredPaths: Object.keys(checkpointFiles),
      checkpointPaths: Object.keys(checkpointFiles),
      modelCalls: 0,
      durationMs: 1,
    });
    await provider.discardRecovery(staging);
  }
  const metrics = evaluateRecoveryCases(rows).interruptedCheckpoint;
  assert.equal(metrics.fixtureCount, 3);
  assert.deepEqual(metrics.verifiedPathRecall, { numerator: 12, denominator: 12, value: 1 });
});




test("checkpoint fixture preserves a large repository tree without truncating the manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-large-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const provider = new LocalWorkspaceProvider(join(root, "provider"));
  await mkdir(source, { recursive: true });
  for (let index = 0; index < 1200; index += 1) {
    const path = join(source, "packages", `pkg-${String(index).padStart(4, "0")}`, "index.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `export const value = ${index};\n`);
  }
  const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: "large-repository", sourceRoot: source });
  assert.equal(checkpoint.fingerprint.resources.filter((entry) => entry.kind === "file").length, 1200);
  const staging = await provider.beginRecovery({ caseId: "large-repository", sourceRoot: source, checkpointRoot: checkpoint.root });
  assert.equal((await provider.fingerprintRecoveryStaging(staging)).digest, checkpoint.fingerprint.digest);
  await provider.discardRecovery(staging);
});

test("checkpoint fixture records symlink behavior without following link targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-symlink-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const provider = new LocalWorkspaceProvider(join(root, "provider"));
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "target.txt"), "target\n");
  try {
    await symlink("target.txt", join(source, "link.txt"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
      t.skip("Windows symlink creation is unavailable in this environment");
      return;
    }
    throw error;
  }
  const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: "symlink-repository", sourceRoot: source });
  assert.equal(checkpoint.fingerprint.resources.some((entry) => entry.path === "link.txt"), true);
  const staging = await provider.beginRecovery({ caseId: "symlink-repository", sourceRoot: source, checkpointRoot: checkpoint.root });
  assert.equal((await provider.fingerprintRecoveryStaging(staging)).digest, checkpoint.fingerprint.digest);
  await provider.discardRecovery(staging);
});


const RecoveryTruthDatasetSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  cases: Type.Array(Type.Object({
    caseId: Type.String({ pattern: "^truth-[0-9]{3}$" }),
    pack: Type.Union([Type.Literal("codex"), Type.Literal("claude-code")]),
    baselineFiles: Type.Record(Type.String({ minLength: 1 }), Type.String()),
    truthTree: Type.Record(Type.String({ minLength: 1 }), Type.String({ pattern: "^[a-f0-9]{64}$" })),
    allowedEquivalentPaths: Type.Array(Type.String()),
    perturbation: Type.String({ minLength: 1 }),
  }), { minItems: 100 }),
});

test("truth-bearing checkpoint dataset contains 100 isolated baseline/target fixtures", async (t) => {
  const dataset = JSON.parse(await readFile(new URL("../fixtures/recovery-truth-dataset.json", import.meta.url), "utf8")) as unknown;
  assert.equal(Value.Check(RecoveryTruthDatasetSchema, dataset), true);
  if (!Value.Check(RecoveryTruthDatasetSchema, dataset)) return;
  assert.equal(dataset.cases.length, 100);
  const root = await mkdtemp(join(tmpdir(), "reprise-truth-dataset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const fixture of dataset.cases) {
    const source = join(root, `${fixture.caseId}-source`);
    const provider = new LocalWorkspaceProvider(join(root, `${fixture.caseId}-provider`));
    for (const [path, encoded] of Object.entries(fixture.baselineFiles)) {
      const target = join(source, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, path === "binary.bin" ? Buffer.from(encoded, "base64") : encoded);
    }
    const checkpoint = await provider.captureRecoveryCheckpoint({ caseId: fixture.caseId, sourceRoot: source });
    const tracked = join(source, "tracked.txt");
    const notes = join(source, "nested", "notes.md");
    switch (fixture.perturbation) {
      case "write":
        await writeFile(tracked, `${fixture.caseId}-after\n`);
        break;
      case "rename":
        await rename(tracked, join(source, "renamed.txt"));
        break;
      case "delete":
        await rm(notes);
        break;
      case "binary":
        await writeFile(join(source, "binary.bin"), Buffer.from([255, 0, 254, 1, 2, 3]));
        break;
      case "large_repo":
        for (let index = 0; index < 600; index += 1) {
          const path = join(source, "generated", `file-${String(index).padStart(4, "0")}.txt`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${fixture.caseId}-${index}\n`);
        }
        break;
      case "symlink":
        try {
          await symlink("tracked.txt", join(source, "tracked-link.txt"), "file");
        } catch (error) {
          if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
            t.skip(`${fixture.caseId}: Windows symlink creation is unavailable in this environment`);
            continue;
          }
          throw error;
        }
        break;
      case "conflicting_evidence":
        await writeFile(tracked, "conflicting-observation\n");
        await writeFile(join(source, "conflict.marker"), "historical-observation\n");
        break;
      default:
        throw new Error(`Unsupported truth fixture perturbation: ${fixture.perturbation}`);
    }
    const staging = await provider.beginRecovery({ caseId: fixture.caseId, sourceRoot: source, checkpointRoot: checkpoint.root });
    for (const [path, expectedHash] of Object.entries(fixture.truthTree)) {
      const bytes = await readFile(join(staging.root, ...path.split("/")));
      assert.equal(sha256(bytes), expectedHash, `${fixture.caseId}: ${path} truth hash`);
    }
    if (fixture.perturbation === "rename" || fixture.perturbation === "delete")
      assert.equal(await readFile(join(staging.root, "tracked.txt"), "utf8"), fixture.baselineFiles["tracked.txt"]);
    if (fixture.perturbation === "large_repo")
      await assert.rejects(readFile(join(staging.root, "generated", "file-0000.txt")));
    assert.equal(fixture.allowedEquivalentPaths.length, 0);
    await provider.discardRecovery(staging);
  }
});

