import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { ComparisonAttemptReferenceSchema, ComparisonAttemptResultSchema, ComparisonInvocationSchema, ComparisonReportOwnerSchema, ComparisonReportModelSchema, type ComparisonAttemptResult, type ComparisonReportOwner, type EventEnvelope } from "../core/schema.js";
import { sha256, writeImmutable } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import { isRecord } from "../core/json.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import { selectComparisonArtifacts, type ComparisonArtifactSelection } from "./comparison-artifacts.js";

export async function sealComparisonReport(input: {
  experimentRoot: string; attemptRoot: string; owner: Omit<ComparisonReportOwner, "report" | "schemaVersion">;
  comparison: ComparisonAttemptResult["comparison"]; reportPath: string;
}): Promise<ComparisonAttemptResult> {
  const bytes = await readFile(input.reportPath);
  const path = `${input.comparison.status === "completed" ? "report" : "comparison-failure"}-${input.owner.attemptId}.html`;
  const record = { schemaVersion: 1 as const, ...input.owner, comparison: input.comparison, report: { path, sha256: sha256(bytes) } };
  if (!Value.Check(ComparisonAttemptResultSchema, record)) throw new Error("Comparison attempt result failed schema validation.");
  await writeImmutable(join(input.experimentRoot, path), bytes);
  if (input.comparison.status === "completed") {
    const model: unknown = JSON.parse(await readFile(join(input.experimentRoot, "report-model.json"), "utf8"));
    if (!Value.Check(ComparisonReportModelSchema, model)) throw new Error("Published report model failed schema validation.");
    await writeImmutableJson(join(input.attemptRoot, "published-report-model.json"), model);
  }
  await writeImmutableJson(join(input.attemptRoot, "result.json"), record);
  return record;
}

type RunComparison = ComparisonArtifactSelection & { comparison?: ComparisonAttemptResult["comparison"] };

export async function readRunComparison(input: {
  experimentRoot: string; experimentId: string; runId?: string; events: readonly EventEnvelope[];
}): Promise<RunComparison> {
  const events = input.events.filter((event) => event.runId === input.runId);
  const attempts = events.filter((event) => (event.type === "comparison.started" || event.type === "comparison.completed")
    && Value.Check(ComparisonAttemptReferenceSchema, event.payload));
  const latest = attempts.at(-1);
  if (!latest || !Value.Check(ComparisonAttemptReferenceSchema, latest.payload)) {
    const otherRuns = input.events.some((event) => event.runId !== input.runId
      && (event.type.startsWith("comparison.") || event.type === "report.created"));
    return otherRuns ? {} : readLegacyComparison(input.experimentRoot);
  }
  const attemptId = latest.payload.attemptId;
  const completion = [...events].reverse().find((event) => event.type === "comparison.completed" && isRecord(event.payload) && event.payload.attemptId === attemptId);
  const comparison = completion && Value.Check(ComparisonInvocationSchema, completion.payload) ? completion.payload : undefined;
  const reports = events.filter((event) => event.type === "report.created");
  let primary: string | undefined;
  let previous: string | undefined;
  for (const event of [...reports].reverse()) {
    const owned = await confirmedReport(input, event);
    if (!owned) continue;
    if (owned.attemptId === attemptId) primary = join(input.experimentRoot, owned.report.path);
    else if (!previous && owned.comparison.status === "completed") previous = join(input.experimentRoot, owned.report.path);
    if ((primary && comparison?.status === "completed") || (primary && previous)) break;
  }
  return {
    ...(comparison ? { comparison } : {}), ...(primary ? { reportPath: primary } : { reportAttemptUnconfirmed: true }),
    ...(previous && (!primary || comparison?.status !== "completed") ? { previousReportPath: previous } : {}),
  };
}

async function confirmedReport(input: Parameters<typeof readRunComparison>[0], event: EventEnvelope): Promise<ComparisonAttemptResult | undefined> {
  if (!isRecord(event.payload) || !Value.Check(ComparisonReportOwnerSchema, event.payload.reportOwner)) return undefined;
  const owner = event.payload.reportOwner;
  if (owner.experimentId !== input.experimentId || owner.runId !== input.runId || event.payload.attemptId !== owner.attemptId) return undefined;
  const expectedPath = `${owner.report.path.startsWith("report-") ? "report" : "comparison-failure"}-${owner.attemptId}.html`;
  if (owner.report.path !== expectedPath) return undefined;
  try {
    const root = await realpath(input.experimentRoot);
    const resultPath = await realpath(join(input.experimentRoot, "comparison-attempts", owner.attemptId, "result.json"));
    const reportPath = await realpath(resolve(input.experimentRoot, owner.report.path));
    if (!pathContainedBy(root, resultPath) || !pathContainedBy(root, reportPath)) return undefined;
    const record: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    if (!Value.Check(ComparisonAttemptResultSchema, record)) return undefined;
    const { comparison, ...recordOwner } = record;
    if (!isDeepStrictEqual(recordOwner, owner) || sha256(await readFile(reportPath)) !== owner.report.sha256) return undefined;
    const completed = input.events.find((item) => item.type === "comparison.completed" && item.runId === owner.runId
      && item.sequence < event.sequence && isRecord(item.payload) && item.payload.attemptId === owner.attemptId);
    if (!completed || !Value.Check(ComparisonInvocationSchema, completed.payload)) return undefined;
    const invocation: Record<string, unknown> = { ...completed.payload };
    delete invocation.attemptId;
    if (!isDeepStrictEqual(invocation, comparison)) return undefined;
    if ((comparison.status === "completed") !== owner.report.path.startsWith("report-")) return undefined;
    return record;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}

async function readLegacyComparison(root: string): Promise<RunComparison> {
  const read = async (name: string) => {
    try { return await readFile(join(root, name), "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  };
  const raw = await read("comparison.json");
  let value: unknown;
  try { value = raw ? JSON.parse(raw) : undefined; } catch { /* Broken legacy projections remain unconfirmed. */ }
  const comparison = Value.Check(ComparisonInvocationSchema, value) ? value : undefined;
  const artifacts = selectComparisonArtifacts({
    ...(comparison ? { comparisonStatus: comparison.status } : {}), comparisonReadable: Boolean(comparison),
    ...(await read("report.html") !== undefined ? { successPath: join(root, "report.html") } : {}),
    ...(await read("comparison-failure.html") !== undefined ? { diagnosticPath: join(root, "comparison-failure.html") } : {}),
  });
  return { ...artifacts, ...(artifacts.reportPath ? { reportAttemptUnconfirmed: true } : {}) };
}
