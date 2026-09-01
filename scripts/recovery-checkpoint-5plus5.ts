import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { recoverCodexExperiment } from "../src/application/experiment.js";
import { evaluateRecoveryCases } from "../src/application/recovery-evaluation.js";
import type { RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import type { TaskCase } from "../src/core/schema.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";

const git = promisify(execFile);
const now = new Date().toISOString();
const recoveryMustNotRun: RecoveryAgentPort = {
  recover: async () => { throw new Error("A trusted checkpoint must not invoke the Recovery model."); },
};
type Fixture = { id: string; git: "head" | "unborn" | "none"; mutation: "text" | "binary" | "delete" | "nested" | "multi" };
type Measurement = {
  caseId: string; productId: string; checkpointDigest: string; checkpointPathCount: number;
  recoveredPathCount: number; byteMatch: boolean; baselineForkMatch: boolean;
  sourceTripwirePassed: boolean; recoveryStatus: string; verification: string; modelCalls: number;
};

async function main(): Promise<void> {
  if (process.env.REPRISE_RUN_RECOVERY_CHECKPOINT_EVALUATION !== "1")
    throw new Error("Set REPRISE_RUN_RECOVERY_CHECKPOINT_EVALUATION=1 to run the 5+5 checkpoint evaluation.");
  const outputParent = resolve(".reprise");
  await mkdir(outputParent, { recursive: true });
  const output = await mkdtemp(join(outputParent, "recovery-checkpoint-5plus5-"));
  const rows: unknown[] = [];
  const measurements: Measurement[] = [];
  try {
    for (const productId of ["codex", "claude-code"] as const)
      for (const fixture of fixtures()) {
        const result = await runFixture(output, productId, fixture);
        rows.push(result.row);
        measurements.push(result.measurement);
      }
    const metrics = evaluateRecoveryCases(rows);
    const report = { schemaVersion: 1, generatedAt: now, kind: "trusted_checkpoint_5_plus_5", measurements, metrics };
    await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ status: "passed", output, cases: measurements.length, metrics: metrics.interruptedCheckpoint }, null, 2));
  } catch (error) {
    await writeFile(join(output, "failure.json"), JSON.stringify({ schemaVersion: 1, status: "failed", category: category(error) }, null, 2));
    throw error;
  }
}

function fixtures(): readonly Fixture[] {
  return [
    { id: "git-head-text", git: "head", mutation: "text" },
    { id: "unborn-binary", git: "unborn", mutation: "binary" },
    { id: "nongit-delete", git: "none", mutation: "delete" },
    { id: "git-head-nested", git: "head", mutation: "nested" },
    { id: "nongit-multi", git: "none", mutation: "multi" },
  ];
}

async function runFixture(_output: string, productId: "codex" | "claude-code", fixture: Fixture): Promise<{ row: unknown; measurement: Measurement }> {
  const caseId = `${productId}-${fixture.id}`;
  const root = await mkdtemp(join(tmpdir(), `reprise-${caseId}-`));
  const sourceRoot = join(root, "source");
  const provider = new LocalWorkspaceProvider(join(root, "provider"));
  try {
    await setupSource(sourceRoot, fixture.git);
    const checkpoint = await provider.captureRecoveryCheckpoint({ caseId, sourceRoot });
    await mutateSource(sourceRoot, fixture.mutation);
    const interrupted = await provider.inspectBaseline({ caseId, sourceRoot }, [], {});
    const checkpointFiles = new Map(checkpoint.fingerprint.resources.filter((entry) => entry.kind === "file" && !entry.path.startsWith(".git/")).map((entry) => [entry.path, entry]));
    const interruptedFiles = new Map(interrupted.fingerprint.resources.filter((entry) => entry.kind === "file" && !entry.path.startsWith(".git/")).map((entry) => [entry.path, entry]));
    const expectedPaths = [...new Set([...checkpointFiles.keys(), ...interruptedFiles.keys()])].filter((path) => JSON.stringify(checkpointFiles.get(path)) !== JSON.stringify(interruptedFiles.get(path))).sort();
    const attempt = await recoverCodexExperiment({
      dataDir: join(root, "data"), caseId, experimentId: `checkpoint-${fixture.id}`, runId: `checkpoint-${fixture.id}-run`,
      sourceRoot, checkpointRoot: checkpoint.root, taskCase: taskCase(caseId, productId), recovery: recoveryMustNotRun,
      now, environmentProvider: provider,
    });
    if (attempt.recovery.status !== "completed" || attempt.recovery.value.status !== "recovered" || attempt.baseline.match !== "recovered")
      throw new Error("checkpoint recovery did not produce a recovered baseline");
    const byteMatch = await sameVisibleFiles(checkpoint.root, attempt.staging!.root, [...checkpointFiles.keys()]);
    if (!byteMatch || await anyFileExists(attempt.staging!.root, [...interruptedFiles.keys()].filter((path) => !checkpointFiles.has(path))))
      throw new Error("checkpoint staging does not match the expected visible file state");
    const baseline = await attempt.accept?.();
    if (!baseline) throw new Error("checkpoint recovery preview was not accepted");
    const prepared = await provider.prepareRun(baseline, `replay-${fixture.id}`);
    const baselineForkMatch = await sameVisibleFiles(checkpoint.root, prepared.root, [...checkpointFiles.keys()]);
    if (!baselineForkMatch || await anyFileExists(prepared.root, [...interruptedFiles.keys()].filter((path) => !checkpointFiles.has(path))))
      throw new Error("accepted baseline fork does not match the expected visible file state");
    await provider.release(prepared);
    const recovery = attempt.baseline.recovery!;
    const sourceTripwirePassed = recovery.sourceTripwire?.before === recovery.sourceTripwire?.after;
    const visibleFiles = new Set([...checkpointFiles.keys(), ...interruptedFiles.keys()]);
    const row = { schemaVersion: 1, caseId, layer: "interrupted_checkpoint", forensicsStarted: true, candidateCreated: false,
      candidateReplayPassed: baselineForkMatch, verification: "verified", recoveredPaths: attempt.providerPreview!.changedPaths.filter((path) => visibleFiles.has(path)),
      checkpointPaths: expectedPaths, modelCalls: 0, durationMs: 0 };
    return { row, measurement: { caseId, productId, checkpointDigest: checkpoint.fingerprint.digest, checkpointPathCount: row.checkpointPaths.length,
      recoveredPathCount: row.recoveredPaths.length, byteMatch, baselineForkMatch, sourceTripwirePassed, recoveryStatus: recovery.status, verification: row.verification, modelCalls: 0 } };
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function setupSource(root: string, gitState: Fixture["git"]): Promise<void> {
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "README.md"), "task-start\n");
  await writeFile(join(root, "nested", "notes.md"), "nested-start\n");
  await writeFile(join(root, "binary.bin"), new Uint8Array([0, 255, 16, 128]));
  await writeFile(join(root, "delete-me.txt"), "delete-start\n");
  if (gitState === "none") return;
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.email", "reprise-evaluation@example.invalid"]);
  await runGit(root, ["config", "user.name", "Reprise Recovery Evaluation"]);
  if (gitState === "head") { await runGit(root, ["add", "."]); await runGit(root, ["commit", "-m", "task-start"]); }
}

async function mutateSource(root: string, mutation: Fixture["mutation"]): Promise<void> {
  if (mutation === "text") return void await writeFile(join(root, "README.md"), "interrupted-text\n");
  if (mutation === "binary") return void await writeFile(join(root, "binary.bin"), new Uint8Array([9, 9, 9]));
  if (mutation === "delete") return void await rm(join(root, "delete-me.txt"));
  if (mutation === "nested") return void await writeFile(join(root, "nested", "notes.md"), "interrupted-nested\n");
  await writeFile(join(root, "README.md"), "interrupted-multi\n");
  await rm(join(root, "delete-me.txt"));
  await writeFile(join(root, "created.txt"), "created-during-interruption\n");
}

function taskCase(caseId: string, productId: "codex" | "claude-code"): TaskCase {
  return { schemaVersion: 1, caseId, source: { productId, sessionId: "checkpoint-evaluation" },
    initialInput: { id: "message-1", role: "user", text: "Recover the interrupted workspace." }, transcript: [], historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] }, sourceRuntimeEvidence: { productId, artifactRefs: [] },
    provenance: { packVersion: "checkpoint-evaluation", importedAt: now, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64) };
}

async function sameVisibleFiles(left: string, right: string, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (!path.startsWith(".git/") && !Buffer.from(await readFile(join(left, ...path.split("/")))).equals(await readFile(join(right, ...path.split("/"))))) return false;
  return true;
}
async function anyFileExists(root: string, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try { await readFile(join(root, ...path.split("/"))); return true; }
    catch (error) {
      // Only ENOENT proves that a post-interruption-only path was correctly removed.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return false;
}
async function runGit(cwd: string, args: string[]): Promise<void> { await git("git", args, { cwd, windowsHide: true }); }
function category(error: unknown): string { return error instanceof Error ? error.message.replace(/[A-Za-z]:\\[^\s]+/g, "<redacted-path>").slice(0, 160) : "unknown"; }

main().catch((error: unknown) => { console.error(`Recovery checkpoint evaluation failed: ${category(error)}`); process.exitCode = 1; });
