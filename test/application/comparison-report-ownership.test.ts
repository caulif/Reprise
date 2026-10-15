import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startExperiment } from "../../src/application/experiment.js";
import { comparePersistedExperiment } from "../../src/application/experiment-compare-persisted.js";
import { readLocalHistory } from "../../src/application/experiment-history-list.js";
import { readCommittedRunEvents } from "../../src/application/experiment-run-history.js";
import { readRunComparison } from "../../src/application/comparison-report-ownership.js";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";
import { activityControlReady, finishActivity, registerActivity } from "../../src/application/experiment-activity.js";
import type { ComparisonAttemptResult } from "../../src/core/schema.js";
import { eventEnvelopeChecksum, sha256 } from "../../src/core/identity.js";
import { randomUUID } from "node:crypto";
import { prepareComparisonArtifacts } from "../../src/application/comparison-publication.js";
import { sealComparisonReport } from "../../src/application/comparison-report-ownership.js";
import { input, VerifiedRuntime } from "../codex-experiment-support.js";
import { comparisonAnchorHrefs } from "../../src/application/comparison-publish-evidence.js";
import { listPersistedRunIds } from "../../src/application/experiment-layout.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reprise-owner-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const first = await startExperiment({ ...base, runId: "run-z-old" }).result;
  const request = { dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy, now: base.now, comparison: base.comparison, agentConfig: base.agentConfig };
  const read = async (runId = first.record.attempt.runId) => readRunComparison({ experimentRoot: first.experimentRoot,
    experimentId: base.experimentId, runId, events: (await readCommittedRunEvents(first.experimentRoot)).events });
  const owner = async (reportPath = first.reportPath) => {
    const event = (await readCommittedRunEvents(first.experimentRoot)).events.find((item) => item.type === "report.created" && (item.payload as { path?: string }).path === reportPath)!;
    const attemptId = (event.payload as { attemptId: string }).attemptId;
    return { event, path: join(first.experimentRoot, "comparison-attempts", attemptId, "result.json"),
      record: JSON.parse(await readFile(join(first.experimentRoot, "comparison-attempts", attemptId, "result.json"), "utf8")) as ComparisonAttemptResult };
  };
  return { root, base, first, request, read, owner };
}

test("committed creation order selects non-lexical runs and preserves every owned report", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.first.reportPath);
  const second = await startExperiment({ ...f.base, runId: "run-a-new" }).result;
  const item = (await readLocalHistory(f.base.dataDir)).experiments[0]!;
  assert.equal(item.runId, "run-a-new");
  assert.equal(item.reportPath, second.reportPath);
  assert.equal(item.reportAttemptUnconfirmed, undefined);
  assert.notEqual(second.reportPath, f.first.reportPath);
  const defaultCompared = await comparePersistedExperiment(f.request);
  assert.equal(defaultCompared.record.attempt.runId, "run-a-new");
  const oldCompared = await comparePersistedExperiment({ ...f.request, runId: "run-z-old" });
  assert.equal(oldCompared.record.attempt.runId, "run-z-old");
  assert.deepEqual(await readFile(f.first.reportPath), bytes);
  assert.equal((await readLocalHistory(f.base.dataDir)).experiments[0]?.reportPath, defaultCompared.reportPath);
  assert.equal(dirname(f.first.reportPath), f.first.experimentRoot);
  const owned = await f.owner();
  assert.equal(owned.record.report.sha256, sha256(bytes));
  for (const href of comparisonAnchorHrefs(bytes.toString())) {
    if (href.startsWith("media/") || href.startsWith("evidence/") || href.startsWith("comparison-attempts/")) {
      assert.ok((await readFile(resolve(dirname(f.first.reportPath), href))).byteLength > 0);
    }
  }
});

test("latest unfinished attempt is interrupted in History and skipped only by default comparison", async (t) => {
  const f = await fixture(t);
  const store = await ExperimentStore.open(f.first.experimentRoot, f.base.experimentId);
  await store.acquireWriter();
  await store.commitAttempt({ ...f.first.record.attempt, runId: "run-a-pending" });
  await store.close();
  const item = (await readLocalHistory(f.base.dataDir)).experiments[0]!;
  assert.equal(item.runId, "run-a-pending");
  assert.equal(item.outcome, "interrupted");
  assert.equal(item.reportPath, undefined);
  assert.equal((await comparePersistedExperiment(f.request)).record.attempt.runId, "run-z-old");
  await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-a-pending" }), /no finished run/);
  await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "../escape" }), /safe identifier/);
});

test("failed re-comparison retains the same run's previous confirmed report", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.first.reportPath);
  const failed = await comparePersistedExperiment({ ...f.request, comparison: {
    compare: async () => ({ status: "failed", failure: { code: "agent_failure", message: "fixture failure", attempts: 0 } }), cancel: async () => {},
  } });
  const selected = await f.read();
  assert.equal(selected.comparison?.status, "failed");
  assert.equal(selected.reportPath, failed.reportPath);
  assert.equal(selected.previousReportPath, f.first.reportPath);
  assert.equal(selected.reportAttemptUnconfirmed, undefined);
  assert.deepEqual(await readFile(f.first.reportPath), bytes);
  assert.equal((await f.owner(failed.reportPath)).record.report.sha256, sha256(await readFile(failed.reportPath)));
});

for (const variant of ["missing-manifest", "invalid-json", "wrong-run", "wrong-experiment", "wrong-attempt", "path-escape", "wrong-digest", "tampered-html", "missing-html"] as const) {
  test(`owned report rejects ${variant} without substituting the root projection`, async (t) => {
    const f = await fixture(t);
    const { path, record } = await f.owner();
    if (variant === "missing-manifest") await rm(path);
    else if (variant === "invalid-json") await writeFile(path, "{");
    else if (variant === "tampered-html") await writeFile(f.first.reportPath, "changed bytes");
    else if (variant === "missing-html") await rm(f.first.reportPath);
    else {
      if (variant === "wrong-run") record.runId = "other-run";
      if (variant === "wrong-experiment") record.experimentId = "other-experiment";
      if (variant === "wrong-attempt") record.attemptId = "other-attempt";
      if (variant === "path-escape") record.report.path = "../escape.html";
      if (variant === "wrong-digest") record.report.sha256 = "f".repeat(64);
      await writeFile(path, JSON.stringify(record));
    }
    const selected = await f.read();
    assert.equal(selected.reportPath, undefined);
    assert.equal(selected.reportAttemptUnconfirmed, true);
  });
}

test("result manifest without committed report.created cannot confirm ownership", async (t) => {
  const f = await fixture(t);
  const events = (await readCommittedRunEvents(f.first.experimentRoot)).events;
  assert.equal(events.at(-1)?.type, "report.created");
  await writeFile(join(f.first.experimentRoot, "events.jsonl"), events.slice(0, -1).map((event) => JSON.stringify(event)).join("\n") + "\n");
  assert.equal((await f.read()).reportPath, undefined);
  assert.equal((await f.read()).reportAttemptUnconfirmed, true);
});

test("a forged event owner and copied record cannot move a report to another run", async (t) => {
  const f = await fixture(t);
  const { event, record } = await f.owner();
  const { events } = await readCommittedRunEvents(f.first.experimentRoot);
  const changed = events.map((item) => {
    if (item.sequence !== event.sequence) return item;
    const { checksum: _checksum, ...body } = item;
    body.runId = "other-run";
    body.payload = { path: f.first.reportPath, attemptId: record.attemptId, reportOwner: { ...record, comparison: undefined, runId: "other-run" } };
    return { ...body, checksum: eventEnvelopeChecksum(body) };
  });
  await writeFile(join(f.first.experimentRoot, "events.jsonl"), changed.map((item) => JSON.stringify(item)).join("\n") + "\n");
  assert.equal((await f.read("other-run")).reportPath, undefined);
});

test("report symlink escape cannot confirm a copied hash", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.first.reportPath);
  const external = join(f.root, "outside-report.html");
  await writeFile(external, bytes);
  await rm(f.first.reportPath);
  try { await symlink(external, f.first.reportPath, "file"); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) { t.skip("Windows file symlink permission unavailable"); return; }
    throw error;
  }
  assert.equal((await f.read()).reportPath, undefined);
});

test("writer contention cannot publish activity or initialize agents or retire the lease owner's activity", async (t) => {
  const f = await fixture(t);
  const store = await ExperimentStore.open(f.first.experimentRoot, f.base.experimentId);
  await store.acquireWriter();
  const active = registerActivity({ kind: "compare", experimentId: f.base.experimentId, runId: "owner-run", dataDir: f.base.dataDir, cancel: async () => {} });
  await activityControlReady(active);
  try {
    let calls = 0;
    await assert.rejects(comparePersistedExperiment({ dataDir: f.request.dataDir, experimentId: f.request.experimentId, policy: f.request.policy, now: f.request.now,
      resolveAgents: async () => { calls++; throw new Error("must not run"); }, onActivity: () => { calls++; },
    }), /active writer/);
    assert.equal(calls, 0);
    assert.equal(active.status, "running");
  } finally { await finishActivity(active); await store.close(); }
});

for (const variant of ["manifest-candidate", "manifest-policy", "manifest-createdAt", "committed-attempt"] as const) {
  test(`same identifiers cannot conceal a ${variant} fact mismatch`, async (t) => {
    const f = await fixture(t);
    const record = JSON.parse(JSON.stringify(f.first.record)) as typeof f.first.record;
    assert.ok(record.manifest);
    if (variant === "manifest-candidate") record.manifest.attempt.candidate.requestedModel = "other-model";
    if (variant === "manifest-policy") record.manifest.attempt.policy.turnTimeoutMs++;
    if (variant === "manifest-createdAt") record.manifest.attempt.createdAt = "2026-10-01T00:00:00.000Z";
    if (variant === "committed-attempt") {
      record.attempt.candidate.requestedModel = "other-model";
      record.manifest.attempt.candidate.requestedModel = "other-model";
    }
    await writeFile(join(f.first.experimentRoot, "runs", "run-z-old", "record.json"), JSON.stringify(record));
    await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-z-old" }), /no finished run/);
    assert.equal((await readLocalHistory(f.base.dataDir)).experiments[0]?.formatError, "unreadable_record");
  });
}

test("an orphan finished file cannot complete an admitted but uncommitted run", async (t) => {
  const f = await fixture(t);
  const record = JSON.parse(JSON.stringify(f.first.record)) as typeof f.first.record;
  record.attempt.runId = "run-a-orphan";
  record.trace.runId = "run-a-orphan";
  assert.ok(record.manifest);
  record.manifest.attempt.runId = "run-a-orphan";
  const store = await ExperimentStore.open(f.first.experimentRoot, f.base.experimentId);
  await store.acquireWriter();
  await store.commitAttempt(record.attempt);
  await store.close();
  await writeFile(join(f.first.experimentRoot, "runs", "run-a-orphan", "record.json"), JSON.stringify(record));
  await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-a-orphan" }), /no finished run/);
  assert.equal((await comparePersistedExperiment(f.request)).record.attempt.runId, "run-z-old");
});

test("legacy runs use validated timestamps and explicitly disclose their ordering provenance", async (t) => {
  const f = await fixture(t);
  const second = await startExperiment({ ...f.base, runId: "run-a-new", now: "2026-10-14T00:00:00.000Z" }).result;
  await rm(join(f.first.experimentRoot, "events.jsonl"));
  assert.deepEqual(await listPersistedRunIds(f.first.experimentRoot), ["run-z-old", "run-a-new"]);
  const item = (await readLocalHistory(f.base.dataDir)).experiments[0]!;
  assert.equal(item.runId, second.record.attempt.runId);
  assert.equal(item.runOrdering, "legacy_timestamp");
  assert.equal(item.reportAttemptUnconfirmed, true);
  assert.equal(item.comparisonStatus, "unknown");
});

test("legacy run identity survives repeated comparisons and later committed runs", async (t) => {
  const f = await fixture(t);
  await rm(join(f.first.experimentRoot, "events.jsonl"));
  await writeFile(join(f.first.experimentRoot, "runs", "run-z-old", "record.json"), JSON.stringify({ ...f.first.record, artifactRefs: [] }));
  assert.equal((await comparePersistedExperiment(f.request)).record.attempt.runId, "run-z-old");
  assert.equal((await comparePersistedExperiment(f.request)).record.attempt.runId, "run-z-old");
  assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-z-old" })).record.attempt.runId, "run-z-old");
  const legacy = (await readLocalHistory(f.base.dataDir)).experiments[0]!;
  assert.equal(legacy.formatError, undefined);
  assert.equal(legacy.outcome, f.first.record.outcome.termination.kind);
  assert.equal(legacy.runOrdering, "legacy_timestamp");
  await startExperiment({ ...f.base, runId: "run-new-committed" }).result;
  assert.equal((await comparePersistedExperiment(f.request)).record.attempt.runId, "run-new-committed");
  assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-z-old" })).record.attempt.runId, "run-z-old");
});

for (const variant of ["missing-created", "invalid-created", "wrong-owner", "missing-finished"] as const) {
  test(`same-run ${variant} lifecycle cannot fall back to legacy trust`, async (t) => {
    const f = await fixture(t);
    const { events } = await readCommittedRunEvents(f.first.experimentRoot);
    const changed = events.map((event) => {
      const { checksum: _checksum, ...body } = event;
      if (body.type === "run.attempt_created") {
        if (variant === "missing-created") body.type = "fixture.removed";
        if (variant === "invalid-created") body.payload = { invalid: true };
        if (variant === "wrong-owner") body.payload = { ...f.first.record.attempt, experimentId: "other-experiment" };
      }
      if (body.type === "run.finished" && variant === "missing-finished") body.type = "fixture.removed";
      return { ...body, checksum: eventEnvelopeChecksum(body) };
    });
    await writeFile(join(f.first.experimentRoot, "events.jsonl"), changed.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-z-old" }), /no finished run/);
    assert.equal((await readLocalHistory(f.base.dataDir)).experiments[0]?.formatError, "unreadable_record");
  });
}

for (const variant of ["foreign-replace", "foreign-append", "dual-owner", "uncommitted-trace"] as const) {
  test(`finished record rejects ${variant} artifact references before comparison`, async (t) => {
    const f = await fixture(t);
    const second = await startExperiment({ ...f.base, runId: "run-other" }).result;
    const original = f.first.record.artifactRefs;
    const foreign = second.record.artifactRefs.find((ref) => ref.artifactId === "host-trace.json")!;
    const own = original.find((ref) => ref.artifactId === "host-trace.json")!;
    const refs = variant === "foreign-replace" ? [foreign] : variant === "foreign-append" ? [...original, foreign]
      : variant === "dual-owner" ? [{ ...own, caseId: f.base.caseId }] : original;
    await writeFile(join(f.first.experimentRoot, "runs", "run-z-old", "record.json"), JSON.stringify({ ...f.first.record, artifactRefs: refs }));
    if (variant === "uncommitted-trace") {
      const { events } = await readCommittedRunEvents(f.first.experimentRoot);
      const changed = events.map((event) => {
        const { checksum: _checksum, ...body } = event;
        if (body.type === "artifact.created" && body.runId === "run-z-old") body.payload = { artifactId: "other.json" };
        return { ...body, checksum: eventEnvelopeChecksum(body) };
      });
      await writeFile(join(f.first.experimentRoot, "events.jsonl"), changed.map((event) => JSON.stringify(event)).join("\n") + "\n");
    }
    let compared = false;
    await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-z-old", comparison: {
      compare: async () => { compared = true; throw new Error("must not compare foreign evidence"); }, cancel: async () => {},
    } }), /no finished run/);
    assert.equal(compared, false);
    assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-other" })).record.attempt.runId, "run-other");
  });
}

test("committed cross-run evidence remains an exact prefix beside the Host-added trace", async (t) => {
  const f = await fixture(t);
  const second = await startExperiment({ ...f.base, runId: "run-second" }).result;
  const committedRef = f.first.record.artifactRefs.find((ref) => ref.artifactId === "host-trace.json")!;
  const { events } = await readCommittedRunEvents(f.first.experimentRoot);
  const changed = events.map((event) => {
    const { checksum: _checksum, ...body } = event;
    if (body.type === "run.finished" && body.runId === "run-second") {
      const record = body.payload as typeof second.record;
      body.payload = { ...record, artifactRefs: [committedRef, ...record.artifactRefs] };
    }
    return { ...body, checksum: eventEnvelopeChecksum(body) };
  });
  await writeFile(join(f.first.experimentRoot, "events.jsonl"), changed.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const recordPath = join(f.first.experimentRoot, "runs", "run-second", "record.json");
  await writeFile(recordPath, JSON.stringify({ ...second.record, artifactRefs: [committedRef, ...second.record.artifactRefs] }));
  assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-second" })).record.attempt.runId, "run-second");
  await writeFile(recordPath, JSON.stringify(second.record));
  await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-second" }), /no finished run/);
});

for (const variant of ["foreign-run", "foreign-case", "dual-owner", "unscoped"] as const) {
  test(`legacy records cannot authorize ${variant} evidence without a committed anchor`, async (t) => {
    const f = await fixture(t);
    const second = await startExperiment({ ...f.base, runId: "run-other" }).result;
    const foreign = second.record.artifactRefs.find((ref) => ref.artifactId === "host-trace.json")!;
    const ref = variant === "foreign-run" ? foreign : variant === "foreign-case" ? { artifactId: "case.json", caseId: "other-case" }
      : variant === "dual-owner" ? { artifactId: "host-trace.json", caseId: f.base.caseId, experimentId: f.base.experimentId, runId: "run-z-old" }
        : { artifactId: "host-trace.json", experimentId: f.base.experimentId };
    await rm(join(f.first.experimentRoot, "events.jsonl"));
    await writeFile(join(f.first.experimentRoot, "runs", "run-z-old", "record.json"), JSON.stringify({ ...f.first.record, artifactRefs: [ref] }));
    await assert.rejects(comparePersistedExperiment({ ...f.request, runId: "run-z-old" }), /no finished run/);
    const { events } = await readCommittedRunEvents(f.first.experimentRoot);
    assert.equal(events.length, 0);
  });
}

test("persisted comparison retains both an initialization failure and a cleanup failure", async (t) => {
  const f = await fixture(t);
  const close = Reflect.get(ExperimentStore.prototype, "close");
  t.mock.method(ExperimentStore.prototype, "close", async function(this: ExperimentStore) {
    await close.call(this);
    throw new Error("fixture close failure");
  });
  await assert.rejects(comparePersistedExperiment({ dataDir: f.request.dataDir, experimentId: f.request.experimentId, policy: f.request.policy, now: f.request.now,
    resolveAgents: async () => { throw new Error("fixture agent failure"); },
  }), (error: unknown) => error instanceof AggregateError && error.errors.some((item: unknown) => item instanceof Error && item.message === "fixture agent failure")
    && error.errors.some((item: unknown) => item instanceof Error && item.message === "fixture close failure"));
});

test("same-depth owned reports retain media, derived evidence and sealed final dependency links", async (t) => {
  const f = await fixture(t);
  const attemptId = randomUUID();
  const attemptRoot = join(f.first.experimentRoot, "comparison-attempts", attemptId);
  await Promise.all([mkdir(join(attemptRoot, "evidence", "derived"), { recursive: true }), mkdir(join(attemptRoot, "media"), { recursive: true }), mkdir(join(attemptRoot, "finals", "assets"), { recursive: true })]);
  const derived = Buffer.from("Measured derived evidence");
  const derivedHref = `evidence/derived/${sha256(derived).slice(0, 16)}.md`;
  await writeFile(join(attemptRoot, derivedHref), derived);
  await writeFile(join(attemptRoot, "media", "shot.png"), "registered image bytes");
  await writeFile(join(attemptRoot, "finals", "index.html"), '<link rel="stylesheet" href="assets/site.css"><h1>Historical final</h1>');
  await writeFile(join(attemptRoot, "finals", "assets", "site.css"), 'h1{background:url("icon.png")}');
  await writeFile(join(attemptRoot, "finals", "assets", "icon.png"), "sealed image bytes");
  const prepared = await prepareComparisonArtifacts({ attemptRoot, experimentRoot: f.first.experimentRoot,
    html: `<a href="${derivedHref}">Analysis</a><a href="finals/index.html">Final</a><img src="media/shot.png">`,
    evidence: [{ side: "derived", inspectPath: derivedHref, reportHref: derivedHref, origin: "derived_analysis", contentHash: sha256(derived) },
      { side: "baseline", inspectPath: "finals/index.html", reportHref: "finals/index.html", origin: "historical_artifact" }],
    media: [{ ref: "media:fixture", side: "host", inspectPath: "media/shot.png", reportHref: "media/shot.png", mediaType: "image/png", available: true }],
  });
  await writeFile(join(f.first.experimentRoot, "report.html"), prepared.html);
  const comparison: ComparisonAttemptResult["comparison"] = { status: "completed", sessionId: "resource-publication", value: { status: "completed", reportPath: "report.html", evidenceRefs: [] } };
  const record = await sealComparisonReport({ experimentRoot: f.first.experimentRoot, attemptRoot, owner: { experimentId: f.base.experimentId, runId: "run-z-old", attemptId }, comparison, reportPath: join(f.first.experimentRoot, "report.html") });
  const reportPath = join(f.first.experimentRoot, record.report.path);
  const snapshot = await readFile(reportPath, "utf8");
  const hrefs = [...comparisonAnchorHrefs(snapshot), ...[...snapshot.matchAll(/src="([^"]+)"/g)].map((match) => match[1]!)];
  assert.equal(hrefs.length, 3);
  const resources = await Promise.all(hrefs.map(async (href) => ({ path: resolve(dirname(reportPath), href), bytes: await readFile(resolve(dirname(reportPath), href)) })));
  const finalPath = resources.find((item) => item.path.endsWith("index.html"))!.path;
  assert.equal(await readFile(join(dirname(finalPath), "assets", "site.css"), "utf8"), 'h1{background:url("icon.png")}');
  assert.equal(await readFile(join(dirname(finalPath), "assets", "icon.png"), "utf8"), "sealed image bytes");
  await writeFile(join(f.first.experimentRoot, "report.html"), "later convenience projection");
  assert.equal(await readFile(reportPath, "utf8"), snapshot);
  for (const resource of resources) assert.deepEqual(await readFile(resource.path), resource.bytes);
});

test("missing experiment metadata retains the admitted attempt identity without inventing a spec", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-attempt-no-metadata-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  const path = join(base.dataDir, "experiments", base.experimentId);
  const store = await ExperimentStore.open(path, base.experimentId);
  await store.acquireWriter();
  await store.commitAttempt({ schemaVersion: 1, experimentId: base.experimentId, runId: base.runId, caseId: base.caseId,
    candidate: base.candidate, policy: base.policy, createdAt: base.now });
  await store.close();
  const item = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(item.taskCaseId, base.caseId);
  assert.equal(item.runId, base.runId);
  assert.equal(item.startedAt, base.now);
  assert.equal(item.formatError, "missing_metadata");
  assert.equal(item.outcome, "interrupted");
  assert.equal(item.reportPath, undefined);
});

test("invalidated latest success exposes only the same run's earlier verified report", async (t) => {
  const f = await fixture(t);
  const latest = await comparePersistedExperiment(f.request);
  await writeFile(latest.reportPath, "tampered latest report");
  const selected = await f.read();
  assert.equal(selected.reportPath, undefined);
  assert.equal(selected.previousReportPath, f.first.reportPath);
  assert.equal(selected.reportAttemptUnconfirmed, true);
});

for (const variant of ["same-time", "unknown-time"] as const) {
  test(`default legacy comparison requires explicit run selection for ${variant} order`, async (t) => {
    const f = await fixture(t);
    await startExperiment({ ...f.base, runId: "run-a-new" }).result;
    await rm(join(f.first.experimentRoot, "events.jsonl"));
    for (const runId of ["run-z-old", "run-a-new"]) {
        const path = join(f.first.experimentRoot, "runs", runId, "record.json");
        const record = JSON.parse(await readFile(path, "utf8")) as typeof f.first.record;
        record.artifactRefs = [];
        assert.ok(record.manifest);
        if (variant === "unknown-time") {
          record.attempt.createdAt = "2026-99-99Tunknown";
          record.manifest.attempt.createdAt = "2026-99-99Tunknown";
        }
        await writeFile(path, JSON.stringify(record));
    }
    assert.equal((await readLocalHistory(f.base.dataDir)).experiments[0]?.runOrdering, "unknown");
    await assert.rejects(comparePersistedExperiment(f.request), /order is unknown.*specify runId/);
    assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-z-old" })).record.attempt.runId, "run-z-old");
    await assert.rejects(comparePersistedExperiment(f.request), /order is unknown.*specify runId/);
    assert.equal((await comparePersistedExperiment({ ...f.request, runId: "run-z-old" })).record.attempt.runId, "run-z-old");
  });
}

test("comparison retires only its own activity when another data directory has the same experiment id", async (t) => {
  const f = await fixture(t);
  const dataDir = join(f.root, "other-data");
  const otherStore = await ExperimentStore.open(join(dataDir, "experiments", f.base.experimentId), f.base.experimentId);
  await otherStore.acquireWriter();
  const other = registerActivity({ kind: "compare", experimentId: f.base.experimentId, runId: "other-run", dataDir, cancel: async () => {} });
  await activityControlReady(other);
  try {
    await comparePersistedExperiment(f.request);
    assert.equal(other.status, "running");
  } finally { await finishActivity(other); await otherStore.close(); }
});
