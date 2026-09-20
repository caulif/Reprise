import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  ComparisonEvidenceCatalog,
  MAX_REGISTERED_EVIDENCE_BYTES,
} from "../../src/application/comparison-evidence.js";
import {
  appendEvidenceShortRefs,
  appendMediaShortRefs,
  formatShortRef,
  withEvidenceShortRefs,
  withMediaShortRefs,
} from "../../src/application/comparison-short-refs.js";
import { assertComparisonResult } from "../../src/agents/comparison-agent.js";
import {
  ComparisonEvidenceOriginSchema,
  ComparisonEvidenceRegisteredPayloadSchema,
  ComparisonLinksSchema,
  ComparisonMediaDerivationSchema,
  ComparisonMediaRecordSchema,
  ComparisonMediaShortRefSchema,
  type ComparisonLinkRecord,
  type ComparisonMediaRecord,
} from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";

async function tempAttempt(t: { after: (fn: () => Promise<void> | void) => void }, prefix: string): Promise<string> {
  const attemptRoot = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(attemptRoot, { recursive: true, force: true });
  });
  return attemptRoot;
}

test("append-only evidence short refs preserve earlier numbers when appending", () => {
  assert.equal(Value.Check(ComparisonEvidenceOriginSchema, "derived_analysis"), true);
  assert.equal(Value.Check(ComparisonMediaDerivationSchema, { kind: "original" }), true);
  const first = withEvidenceShortRefs([
    { side: "baseline", inspectPath: "history/final.txt" },
    { side: "candidate", inspectPath: "candidate/out.html", path: "out.html" },
  ]);
  assert.deepEqual(first.map((link) => link.shortRef), ["ev-01", "ev-02"]);
  const second = appendEvidenceShortRefs(first, [
    { side: "derived", inspectPath: "evidence/derived/a", origin: "derived_analysis", label: "table" },
  ]);
  assert.equal(second[0]?.shortRef, "ev-03");
  assert.deepEqual(first.map((link) => link.shortRef), ["ev-01", "ev-02"]);
});

test("append-only media short refs support 2-6 digit capacity and do not renumber", () => {
  assert.equal(Value.Check(ComparisonMediaShortRefSchema, "media-01"), true);
  assert.equal(Value.Check(ComparisonMediaShortRefSchema, "media-999999"), true);
  assert.equal(Value.Check(ComparisonMediaShortRefSchema, "media-1"), false);
  assert.equal(Value.Check(ComparisonMediaShortRefSchema, "media-1000000"), false);

  const seeded = withMediaShortRefs([
    media({ ref: "media:a", side: "baseline", inspectPath: "a.png" }),
  ]);
  assert.equal(seeded[0]?.shortRef, "media-01");
  const added = appendMediaShortRefs(seeded, [
    media({ ref: "media:b", side: "candidate", inspectPath: "b.png" }),
  ]);
  assert.equal(added[0]?.shortRef, "media-02");
  assert.equal(seeded[0]?.shortRef, "media-01");
  assert.equal(formatShortRef("media", 1000), "media-1000");
  assert.equal(Value.Check(ComparisonMediaShortRefSchema, "media-1000"), true);
});

test("comparison links accept host and derived sides with origin labels", () => {
  const derived: ComparisonLinkRecord = {
    side: "derived",
    inspectPath: "evidence/derived/x",
    origin: "derived_analysis",
  };
  assert.equal(Value.Check(ComparisonLinksSchema, [derived]), true);
  const labeled = withEvidenceShortRefs([derived]);
  assert.equal(labeled[0]?.label, "派生分析证据");
  assert.equal(labeled[0]?.shortRef, "ev-01");
});

test("register_evidence seals scratch bytes, emits revision, and accepts new short refs in assert", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-catalog-");
  await mkdir(join(attemptRoot, "scratch"), { recursive: true });
  const body = "col,a,b\n1,2,3\n";
  await writeFile(join(attemptRoot, "scratch", "summary.csv"), body, "utf8");
  const events: unknown[] = [];
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-1",
    attemptRoot,
    links: [
      { side: "baseline", inspectPath: "history/final.txt", shortRef: "ev-01", label: "baseline" },
      { side: "candidate", inspectPath: "candidate/out.html", shortRef: "ev-02", path: "out.html", label: "candidate" },
    ],
    media: [
      media({ ref: "media:seed", side: "candidate", inspectPath: "media/seed.png", shortRef: "media-01", available: true }),
    ],
    emitRegistered: async (payload) => {
      assert.equal(Value.Check(ComparisonEvidenceRegisteredPayloadSchema, payload), true);
      events.push(payload);
    },
  });

  const registered = await catalog.registerEvidence({
    relativePath: "summary.csv",
    sourceRefs: ["ev-01", "ev-02"],
    label: "numeric table",
  });
  assert.equal(registered.status, "registered");
  if (registered.status !== "registered") return;
  assert.equal(registered.shortRef, "ev-03");
  assert.equal(registered.deduplicated, false);
  assert.equal(registered.contentHash, sha256(Buffer.from(body)));
  assert.equal(events.length, 1);

  const sealed = await readFile(join(attemptRoot, registered.inspectPath), "utf8");
  assert.equal(sealed, body);
  const current = (await readFile(join(attemptRoot, "facts", "evidence-catalog", "CURRENT"), "utf8")).trim();
  assert.match(current, /^rev-\d+\.json$/);
  const index = JSON.parse(await readFile(join(attemptRoot, "briefing", "facts", "evidence-index.json"), "utf8")) as { shortRef?: string }[];
  assert.ok(index.some((row) => row.shortRef === "ev-03"));

  assert.doesNotThrow(() => assertComparisonResult(
    { status: "completed", reportPath: "report.html", evidenceRefs: ["ev-01", "ev-03"] },
    { shortEvidenceRefs: ["ev-01", "ev-02"] } as never,
    () => catalog.snapshot(),
  ));
  assert.throws(() => assertComparisonResult(
    { status: "completed", reportPath: "report.html", evidenceRefs: ["ev-999999"] },
    { shortEvidenceRefs: ["ev-01"] } as never,
    () => catalog.snapshot(),
  ));
});

test("emit failure after persist is retried on dedupe and still records the event", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-emit-retry-");
  await mkdir(join(attemptRoot, "scratch"), { recursive: true });
  await writeFile(join(attemptRoot, "scratch", "note.txt"), "retry-me", "utf8");
  const events: unknown[] = [];
  let failNextEmit = true;
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-emit",
    attemptRoot,
    links: [{ side: "candidate", inspectPath: "candidate/a", shortRef: "ev-01" }],
    media: [],
    emitRegistered: async (payload) => {
      if (failNextEmit) {
        failNextEmit = false;
        throw new Error("simulated store.append failure");
      }
      assert.equal(Value.Check(ComparisonEvidenceRegisteredPayloadSchema, payload), true);
      events.push(payload);
    },
  });

  const first = await catalog.registerEvidence({
    relativePath: "note.txt",
    sourceRefs: ["ev-01"],
    label: "first",
  });
  assert.equal(first.status, "rejected");
  assert.equal(events.length, 0);
  assert.ok(catalog.snapshot().links.some((link) => link.origin === "derived_analysis"));

  const second = await catalog.registerEvidence({
    relativePath: "note.txt",
    sourceRefs: ["ev-01"],
    label: "retry",
  });
  assert.equal(second.status, "registered");
  if (second.status !== "registered") return;
  assert.equal(second.deduplicated, true);
  assert.equal(events.length, 1);
  assert.equal((events[0] as { shortRef: string }).shortRef, second.shortRef);
});

test("media emit failure rolls back the persisted media batch", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-media-emit-rollback-");
  let fail = true;
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-media-emit",
    attemptRoot,
    links: [{ side: "candidate", inspectPath: "candidate/a", shortRef: "ev-01" }],
    media: [],
    emitRegisteredBatch: async () => {
      if (fail) {
        fail = false;
        throw new Error("simulated event failure");
      }
    },
  });
  const result = await catalog.registerMediaBatch([{
    record: {
      ref: "media:frame",
      side: "candidate",
      inspectPath: "media/frame.png",
      reportHref: "media/frame.png",
      mediaType: "image/png",
      available: true,
      contentHash: "a".repeat(64),
      sourceRef: "ev-01",
    },
    sourceRefs: ["ev-01"],
    origin: "candidate_delivery",
  }]);
  assert.equal(result[0]?.status, "rejected");
  assert.equal(catalog.snapshot().media.length, 0);
  assert.equal(catalog.snapshot().revision, 1);
  assert.equal(await readFile(join(attemptRoot, "facts", "evidence-catalog", "CURRENT"), "utf8"), "rev-1.json\n");
});

test("media batch emits once, so a second-frame failure cannot split the event log", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-media-batch-emit-");
  let calls = 0;
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-media-batch-emit",
    attemptRoot,
    links: [{ side: "candidate", inspectPath: "candidate/a", shortRef: "ev-01" }],
    media: [],
    emitRegisteredBatch: async () => {
      calls += 1;
      throw new Error("simulated second-frame event failure");
    },
  });
  const makeInput = (suffix: string, hash: string) => ({
    record: {
      ref: `media:${suffix}`,
      side: "candidate" as const,
      inspectPath: `media/${suffix}.png`,
      reportHref: `media/${suffix}.png`,
      mediaType: "image/png",
      available: true,
      contentHash: hash,
      sourceRef: "ev-01",
    },
    sourceRefs: ["ev-01"],
    origin: "candidate_delivery" as const,
  });
  const result = await catalog.registerMediaBatch([
    makeInput("frame-a", "a".repeat(64)),
    makeInput("frame-b", "b".repeat(64)),
  ]);
  assert.equal(calls, 1);
  assert.equal(result[0]?.status, "rejected");
  assert.equal(catalog.snapshot().media.length, 0);
  assert.equal(catalog.snapshot().revision, 1);
});

test("duplicate register_evidence with same hash and sources reuses shortRef", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-dedupe-");
  await mkdir(join(attemptRoot, "scratch"), { recursive: true });
  await writeFile(join(attemptRoot, "scratch", "note.txt"), "same", "utf8");
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-2",
    attemptRoot,
    links: [{ side: "candidate", inspectPath: "candidate/a", shortRef: "ev-01" }],
    media: [],
  });
  const first = await catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "n1" });
  const second = await catalog.registerEvidence({ relativePath: "note.txt", sourceRefs: ["ev-01"], label: "n2" });
  assert.equal(first.status, "registered");
  assert.equal(second.status, "registered");
  if (first.status !== "registered" || second.status !== "registered") return;
  assert.equal(first.shortRef, second.shortRef);
  assert.equal(second.deduplicated, true);
  assert.equal(catalog.snapshot().links.filter((link) => link.origin === "derived_analysis").length, 1);
});

test("concurrent register_evidence does not drop updates", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-race-");
  await mkdir(join(attemptRoot, "scratch"), { recursive: true });
  await writeFile(join(attemptRoot, "scratch", "a.txt"), "aaa", "utf8");
  await writeFile(join(attemptRoot, "scratch", "b.txt"), "bbb", "utf8");
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-3",
    attemptRoot,
    links: [{ side: "baseline", inspectPath: "history/x", shortRef: "ev-01" }],
    media: [],
  });
  const [left, right] = await Promise.all([
    catalog.registerEvidence({ relativePath: "a.txt", sourceRefs: ["ev-01"], label: "a" }),
    catalog.registerEvidence({ relativePath: "b.txt", sourceRefs: ["ev-01"], label: "b" }),
  ]);
  assert.equal(left.status, "registered");
  assert.equal(right.status, "registered");
  const derived = catalog.snapshot().links.filter((link) => link.origin === "derived_analysis");
  assert.equal(derived.length, 2);
  assert.notEqual(derived[0]?.shortRef, derived[1]?.shortRef);
});

test("register_evidence rejects path escape, unknown source, oversized files, and forged toolCallId", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-reject-");
  await mkdir(join(attemptRoot, "scratch"), { recursive: true });
  await writeFile(join(attemptRoot, "scratch", "ok.txt"), "ok", "utf8");
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-4",
    attemptRoot,
    links: [{ side: "candidate", inspectPath: "candidate/a", shortRef: "ev-01" }],
    media: [],
    lookupToolCall: async () => ({ ok: false, message: "forged" }),
  });

  const escape = await catalog.registerEvidence({
    relativePath: "../facts/context.json",
    sourceRefs: ["ev-01"],
    label: "escape",
  });
  assert.equal(escape.status, "rejected");
  if (escape.status === "rejected") assert.ok(escape.code === "path_invalid" || escape.code === "path_escape");

  const missing = await catalog.registerEvidence({
    relativePath: "ok.txt",
    sourceRefs: ["ev-99"],
    label: "missing",
  });
  assert.equal(missing.status, "rejected");
  if (missing.status === "rejected") assert.equal(missing.code, "missing_source");

  const forged = await catalog.registerEvidence({
    relativePath: "ok.txt",
    sourceRefs: ["ev-01"],
    label: "forged",
    toolCallId: "other-attempt:tool:1",
  });
  assert.equal(forged.status, "rejected");
  if (forged.status === "rejected") assert.equal(forged.code, "tool_call_invalid");

  const big = Buffer.alloc(MAX_REGISTERED_EVIDENCE_BYTES + 1, 0x61);
  await writeFile(join(attemptRoot, "scratch", "big.txt"), big);
  const oversized = await catalog.registerEvidence({
    relativePath: "big.txt",
    sourceRefs: ["ev-01"],
    label: "big",
  });
  assert.equal(oversized.status, "rejected");
  if (oversized.status === "rejected") assert.equal(oversized.code, "too_large");
});

test("registerMedia dedupes same side+hash+derivation and keeps distinct sides", async (t) => {
  const attemptRoot = await tempAttempt(t, "reprise-b3-media-");
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-b3-5",
    attemptRoot,
    links: [{ side: "baseline", inspectPath: "history/x", shortRef: "ev-01" }],
    media: [],
  });
  const hash = sha256(Buffer.from("png"));
  const derivation = { kind: "headless_screenshot" as const, viewport: { width: 1280, height: 900, scale: 1 } };
  const base = {
    ref: "media:frame-a",
    inspectPath: "media/frame-a.png",
    reportHref: "media/frame-a.png",
    mediaType: "image/png",
    available: true,
    contentHash: hash,
    derivation,
  };
  const left = await catalog.registerMedia({
    record: { ...base, side: "baseline", sourceRef: "ev-01" },
    sourceRefs: ["ev-01"],
    origin: "historical_artifact",
    derivation,
  });
  const right = await catalog.registerMedia({
    record: { ...base, ref: "media:frame-b", side: "candidate", sourceRef: "ev-01" },
    sourceRefs: ["ev-01"],
    origin: "candidate_delivery",
    derivation,
  });
  const again = await catalog.registerMedia({
    record: { ...base, side: "baseline", sourceRef: "ev-01" },
    sourceRefs: ["ev-01"],
    origin: "historical_artifact",
    derivation,
  });
  assert.equal(left.status, "registered");
  assert.equal(right.status, "registered");
  assert.equal(again.status, "registered");
  if (left.status !== "registered" || right.status !== "registered" || again.status !== "registered") return;
  assert.notEqual(left.shortRef, right.shortRef);
  assert.equal(again.shortRef, left.shortRef);
  assert.equal(again.deduplicated, true);
  assert.equal(Value.Check(ComparisonMediaRecordSchema, catalog.snapshot().media[0]), true);
});

function media(partial: Partial<ComparisonMediaRecord> & Pick<ComparisonMediaRecord, "ref" | "side" | "inspectPath">): ComparisonMediaRecord {
  return {
    reportHref: partial.reportHref ?? partial.inspectPath,
    mediaType: partial.mediaType ?? "image/png",
    available: partial.available ?? true,
    ...partial,
  };
}
